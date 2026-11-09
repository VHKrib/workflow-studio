const { app, BrowserWindow, ipcMain, dialog, Menu, webContents, shell } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROFILES_DIR = path.join(os.homedir(), '.hermes', 'profiles');
const { readChain } = require('./chain');
const { createLinkStore } = require('./linkstore');
const { createVersionStore } = require('./versions');
const livefeed = require('./livefeed');
const { pathToFileURL } = require('url');
const { hermesBin } = require('./platform');
const HERMES = hermesBin();          // mac/linux: ~/.hermes/.../bin/hermes；Windows: hermes.cmd（自动开 shell）
// 绝对路径要真的存在；只写命令名（交给 PATH）就不检查文件
function hermesMissing() { return /[\\/]/.test(HERMES.cmd) && !fs.existsSync(HERMES.cmd); }

// 共享链路状态文件：人和 agent 共用一份底稿（画布写、agent 读；外面改了画布认领回来）
let LINKS = null;
function links() {
  if (!LINKS) {
    LINKS = createLinkStore(path.join(app.getPath('userData'), 'links'));
    LINKS.drop('__temp__');          // 临时画布不跨进程存在：上次没收干净的那份，启动时抹掉
  }
  return LINKS;
}

// 版本记录：每条链路最近 20 版的底稿（回滚就靠它；和状态文件分开放，读状态文件的人不会读到 20 份历史）
let VERS = null;
function versions() {
  if (!VERS) VERS = createVersionStore(path.join(app.getPath('userData'), 'versions'));
  return VERS;
}

/** 读本机 profile 列表：id + 显示名 + 所属部门 + 描述 */
let WHITELIST = null;
function loadWhitelist() {
  if (WHITELIST) return WHITELIST;
  WHITELIST = new Set();
  try {
    const cfg = fs.readFileSync(path.join(os.homedir(), '.hermes', 'config.yaml'), 'utf8');
    const m = cfg.match(/dispatch_profiles:\s*\[([\s\S]*?)\]/);
    if (m) m[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean).forEach(x => WHITELIST.add(x));
  } catch (e) {}
  return WHITELIST;
}

function listAgents() {
  const out = [];
  const wl = loadWhitelist();
  let dirs = [];
  try { dirs = fs.readdirSync(PROFILES_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch (e) { return out; }
  for (const id of dirs.sort()) {
    const p = path.join(PROFILES_DIR, id, 'profile.yaml');
    let yaml = '';
    try { yaml = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
    const pick = (re) => { const m = yaml.match(re); return m ? m[1].trim() : ''; };
    const desc = (pick(/^description:\s*(.+)$/m) || '').replace(/^['"]|['"]$/g, '');
    out.push({
      id,
      name: pick(/^display_name:\s*(.+)$/m) || id,
      section: pick(/sectionName:\s*(.+)$/m) || '',
      desc: desc.slice(0, 160),
      stopped: (wl.size > 0 && !wl.has(id)) || /已停用|decommissioned/i.test(desc),
      hasSoul: fs.existsSync(path.join(PROFILES_DIR, id, 'SOUL.md')),
    });
  }
  return out;
}

/** 只读：跑一次 agent，问它对某个环节的意见（不触发任何付费动作） */
// toolsets：只给分析用的那几样（如 'todo,no_mcp'），agent 就碰不到终端、文件、发消息、MCP 接口——真正的只读
function askAgent({ profile, prompt, timeoutMs = 120000, toolsets }) {
  return new Promise((resolve) => {
    if (hermesMissing()) return resolve({ ok: false, error: 'hermes 入口不存在: ' + HERMES.cmd });
    const args = ['-p', profile, 'chat'];
    if (toolsets) args.push('-t', String(toolsets));
    args.push('-q', prompt);
    const child = execFile(HERMES.cmd, args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env } },
      (err, stdout, stderr) => {
        resolve({ ok: !err, code: err ? (err.code || 'err') : 0, text: (stdout || stderr || '').slice(-20000) });
      });
    child.on('error', e => resolve({ ok: false, error: String(e) }));
  });
}

// 只要干净答案：走 stream-json，取 result 事件里的正文（不带回显、不带思考过程）
function askAgentClean({ profile, prompt, toolsets, timeoutMs = 240000 }) {
  return new Promise((resolve) => {
    if (hermesMissing()) return resolve({ ok: false, error: 'hermes 入口不存在: ' + HERMES.cmd });
    const args = ['-p', profile, 'chat', '--format', 'stream-json'];   // 不加 --source：网关只认固定几种，写了会直接失败
    if (toolsets) args.push('-t', String(toolsets));
    args.push('-q', prompt);
    execFile(HERMES.cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env }, shell: HERMES.shell }, (err, stdout) => {
      const lines = String(stdout || '').split('\n');
      let text = '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        let o; try { o = JSON.parse(t); } catch (_) { continue; }
        if (o.type === 'result' && o.text) text = o.text;
        else if (o.type === 'assistant' && o.text) text = o.text;
      }
      resolve({ ok: !!text, text, code: err ? (err.code || 'err') : 0 });
    });
  });
}

/** 流式：边跑边把事件推给渲染层（Hermes 的对话框效果靠它） */
const runs = new Map();
// 验收用：WF_READ_FAKE=hang 时，分析这条链路起一个不出声的子进程，用来验「没有输出时到点自己收场」。
// 平时不设这个环境变量就一点也不影响（只有读取链路的分析会被替换，别的对话照常）。
const READ_FAKE = process.env.WF_READ_FAKE || '';
// 验收用：WF_CHAT_FAKE=hang 时，普通对话（卡片聊天 / 右下角对话框）也起一个不出声的子进程，
// 用来验「对话正在跑的时候回滚，运行要被真的停掉」。平时不设就照常调 agent。
const CHAT_FAKE = process.env.WF_CHAT_FAKE || '';
// 只读预演固定用零工具工具组：主进程这边再盖一次——渲染层就算传错，也拿不到终端/文件/消息/MCP
const PREVIEW_TOOLSETS = 'context_engine,no_mcp';
ipcMain.handle('agent:stream', (e, { profile, prompt, runId, timeoutMs = 180000, toolsets, preview }) => new Promise((resolve) => {
  if (hermesMissing()) return resolve({ ok: false, error: 'hermes 入口不存在: ' + HERMES.cmd });
  if (preview) toolsets = PREVIEW_TOOLSETS;
  const args = ['-p', profile, 'chat', '--format', 'stream-json'];
  if (toolsets) args.push('-t', String(toolsets));     // 只给指定工具组（分析链路时 todo,no_mcp：不能跑命令、不能写文件、不碰 MCP 接口）
  args.push('-q', prompt);
  const fake = (READ_FAKE === 'hang' && toolsets === 'todo,no_mcp') || (CHAT_FAKE === 'hang' && !toolsets);
  const child = fake ? spawn(process.execPath, ['-e', 'setTimeout(()=>{},600000)'], { env: { ...process.env } }) : spawn(HERMES.cmd, args, { env: { ...process.env }, shell: HERMES.shell });
  runs.set(runId, child);
  if (preview) console.log(`[预演] 起进程：hermes -p ${profile} chat --format stream-json -t ${toolsets}（零工具 · 只出结论）`);
  let buf = '', finalText = '', tokens = null, err = '', killedByTimeout = false, toolCalls = 0;
  const send = ev => { try { if (!e.sender.isDestroyed()) e.sender.send('agent:event', { runId, ev }); } catch (_) { } };
  const timer = setTimeout(() => { killedByTimeout = true; try { child.kill('SIGTERM'); } catch (_) { } }, timeoutMs);
  child.stdout.on('data', d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch (_) { continue; }
      if (o.type === 'result') { finalText = o.text || ''; tokens = o.tokens || null; }
      if (o.type === 'tool_use') toolCalls++;
      send(o);
    }
  });
  child.stderr.on('data', d => { err += d.toString('utf8'); });
  child.on('error', e2 => { clearTimeout(timer); runs.delete(runId); resolve({ ok: false, error: String(e2) }); });
  child.on('close', code => {
    clearTimeout(timer); runs.delete(runId);
    // 预演的证据落在主进程日志里：工具调用 0 次 = 这次确实没跑命令、没读写文件、没发消息
    if (preview) console.log(`[预演] 结束：工具调用 ${toolCalls} 次 · 退出码 ${code}${killedByTimeout ? ' · 到点被杀' : ''}`);
    resolve({ ok: code === 0 && !killedByTimeout, code, text: finalText, tokens, error: err.slice(-2000), timedOut: killedByTimeout, toolCalls });
  });
}));
ipcMain.handle('agent:cancel', (_e, runId) => {
  const c = runs.get(runId);
  if (!c) return false;
  try { c.kill('SIGTERM'); } catch (_) { }
  console.log(`[取消] 停掉正在跑的运行 ${runId}`);     // 回滚时也走这条路：日志里能查到「这次运行被停掉」
  return true;
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1320, height: 880, minWidth: 1000, minHeight: 640,
    title: '工作流开发平台',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f5f3ef',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true },
  });
  win.setBounds({ x: 20, y: 44, width: 1380, height: 880 });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  MAIN_WIN = win;
  win.webContents.on('render-process-gone', (_e, d) => console.log('[窗口] 主窗口渲染进程退出：' + JSON.stringify(d || {})));
  win.on('closed', () => { if (MAIN_WIN === win) MAIN_WIN = null; });
  return win;
}

// ---------- 独立实时画布：只读跟一条别人的对话 ----------
// 主窗口是唯一的写者；这个窗口只显示主进程读出来的东西（不写会话库、不写链路状态）。
let MAIN_WIN = null;
const LIVE = { wc: null, timer: 0, busy: false, feed: null, conv: null, msgs: [], plan: null, doc: null, lastId: 0, lastError: '' };
const LIVE_STATE = { profile: '', session: '', on: false };
const LIVE_POLL_MS = 800;          // 每 ≤1 秒读一次增量

function liveStateFile() { return path.join(app.getPath('userData'), 'live.json'); }
function loadLiveState() {
  try {
    const s = JSON.parse(fs.readFileSync(liveStateFile(), 'utf8'));
    if (s && typeof s === 'object') {
      LIVE_STATE.profile = String(s.profile || '');
      LIVE_STATE.session = String(s.session || '');
      LIVE_STATE.on = !!s.on;
    }
  } catch (e) { }
  return LIVE_STATE;
}
function saveLiveState() {
  try { fs.writeFileSync(liveStateFile(), JSON.stringify(LIVE_STATE, null, 2) + '\n', 'utf8'); } catch (e) { }
}
function liveSender(e) {
  return !!(LIVE.wc && !LIVE.wc.isDestroyed() && e && e.sender && e.sender.id === LIVE.wc.id);
}
function sendLive(doc) {
  if (!LIVE.wc || LIVE.wc.isDestroyed()) return;
  try { LIVE.wc.send('live:doc', doc); } catch (e) { }
}
// 实时画布现在嵌在主窗口里（<webview>）：主进程认它的 webContents，读写都往那儿发
function attachLiveView(id) {
  try {
    const wc = webContents.fromId(Number(id));
    if (!wc || wc.isDestroyed()) return { ok: false, error: '视图已经不在了' };
    if (LIVE.wc && LIVE.wc !== wc && !LIVE.wc.isDestroyed()) { try { LIVE.wc.removeAllListeners('destroyed'); } catch (e) { } }
    LIVE.wc = wc;
    wc.on('destroyed', () => { if (LIVE.wc === wc) { LIVE.wc = null; stopLiveTimer(); } });
    if (LIVE_STATE.on && LIVE_STATE.profile && LIVE_STATE.session) startLiveTimer();
    console.log('[实时画布] 内嵌视图已接上（webContents ' + wc.id + '）');
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}
function stopLiveTimer() { if (LIVE.timer) clearInterval(LIVE.timer); LIVE.timer = 0; }
function startLiveTimer() { stopLiveTimer(); LIVE.timer = setInterval(liveTick, LIVE_POLL_MS); }

// 只认列表里真的存在的那条对话：外部传来的岗位 / 会话标识先对一遍，不拿它拼路径
async function findConv(profile, session) {
  const all = await livefeed.listConversations();
  return all.find(c => c.profile === profile && c.session === session) || null;
}
// 这条对话已经读到的消息（按 id 累积；换对话才清）。重解析 / 轮询都往这份里并，重复的 id 不会重复计。
function mergeMsgs(list) {
  const by = new Map(LIVE.msgs.map(m => [Number(m.id) || 0, m]));
  for (const m of list || []) { const id = Number(m.id) || 0; if (id) by.set(id, m); }
  LIVE.msgs = [...by.values()].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
  return LIVE.msgs;
}
async function liveLoad(profile, session) {
  const conv = await findConv(profile, session);
  if (!conv) return { ok: false, error: '这条对话已经不在最近的活动里了' };
  const same = LIVE.conv && LIVE.conv.key === conv.key;
  if (!same) {
    LIVE.conv = { key: conv.key, profile, session, who: conv.who, title: conv.doing };
    LIVE.msgs = []; LIVE.plan = null; LIVE.doc = null; LIVE.lastId = 0;
  }
  const r = await livefeed.readMessages(profile, session, LIVE.lastId);
  if (r.error) return { ok: false, error: r.error };
  mergeMsgs(r.msgs);
  LIVE.lastId = LIVE.msgs.reduce((n, m) => Math.max(n, Number(m.id) || 0), 0);
  console.log(`[实时画布] 只读读取「${conv.who} · ${conv.doing}」：${r.msgs.length} 条（sqlite3 -readonly file:…?mode=ro）`);
  // 卡只有一个来源：解析。跟随只在有新消息时把「已经解析好的那份」再推一遍，形状不会变成另一套。
  if (!LIVE.doc) LIVE.doc = loadLiveDoc(profile, session);
  return { ok: true, doc: LIVE.doc || emptyDoc() };
}
function emptyDoc() {
  return { conv: LIVE.conv, at: Math.round(Date.now() / 1000), cards: [], edges: [], name: '', stats: { messages: LIVE.msgs.length } };
}
async function liveTick() {
  if (LIVE.busy || !LIVE_STATE.on || !LIVE_STATE.profile || !LIVE_STATE.session) return;
  LIVE.busy = true;
  try {
    const r = await livefeed.readMessages(LIVE_STATE.profile, LIVE_STATE.session, LIVE.lastId);
    if (r.error) { if (r.error !== LIVE.lastError) console.log('[实时画布] 读不了：' + r.error); LIVE.lastError = r.error; return; }
    LIVE.lastError = '';
    if (!r.msgs.length) return;                                   // 没新消息：不推、不重画
    mergeMsgs(r.msgs);
    LIVE.lastId = LIVE.msgs.reduce((n, m) => Math.max(n, Number(m.id) || 0), 0);
    console.log(`[实时画布] 增量 ${r.msgs.length} 条（只读）`);
    if (LIVE.doc) sendLive(LIVE.doc);
  } finally { LIVE.busy = false; }
}
function openLiveWindow() {
  focusMain();
  if (MAIN_WIN && !MAIN_WIN.isDestroyed()) MAIN_WIN.webContents.send('live:show');
  return { ok: true };
}
// 解析结果落盘：跑完一次就存下来，重开窗口/切回来直接显示；不满意再点「重新生成」，
// 新的没拆成功之前，旧的那份一直留着（不拿半份覆盖好的）。
const LIVE_DOC_DIR = () => path.join(app.getPath('userData'), 'live');
function liveDocFile(profile, session) {
  const safe = x => String(x || '').replace(/[^\w.-]/g, '_').slice(0, 120);
  return path.join(LIVE_DOC_DIR(), safe(profile) + '__' + safe(session) + '.json');
}
function saveLiveDoc(doc) {
  try {
    if (!doc || !doc.conv) return false;
    fs.mkdirSync(LIVE_DOC_DIR(), { recursive: true });
    const f = liveDocFile(doc.conv.profile, doc.conv.session);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc), 'utf8');
    fs.renameSync(tmp, f);
    console.log('[实时画布] 已保存解析结果：' + doc.cards.length + ' 张卡 → ' + f);
    return true;
  } catch (e) { console.log('[实时画布] 保存失败：' + (e && e.message || e)); return false; }
}
function loadLiveDoc(profile, session) {
  try {
    const f = liveDocFile(profile, session);
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (d && Array.isArray(d.cards) && d.cards.length && d.conv) {
      for (const c of d.cards) { try { normMods(c, c.kind); } catch (e) { } }   // 老存档也按新口径归位
      return d;
    }
  } catch (e) { }
  return null;
}

// ---------- 从外面唤起：Hermes desktop 里点 workflow-studio://open 就能打开/前置这个窗口 ----------
// 只允许一个实例：第二次唤起是「前置已有窗口」，不会再开一个进程（否则调试端口和数据目录会撞）。
const PROTO = 'workflow-studio';
function focusMain() {
  if (!MAIN_WIN || MAIN_WIN.isDestroyed()) { createWindow(); return; }
  if (MAIN_WIN.isMinimized()) MAIN_WIN.restore();
  MAIN_WIN.show(); MAIN_WIN.focus();
}
function handleOpenUrl(url) {
  const s = String(url || '');
  if (!s.startsWith(PROTO + '://')) return;
  console.log('[唤起] ' + s);
  focusMain();
  if (/^workflow-studio:\/\/(live|实时)/i.test(s)) openLiveWindow();
}
function registerProtocol() {
  if (process.platform === 'linux' && !app.isPackaged) {   // Linux 开发态没有 .desktop，登记不了，别刷失败日志
    console.log('[唤起] Linux 开发态跳过协议登记（打包后才生效）');
    return;
  }
  try {
    // 开发态（electron .）要把脚本路径一起登记，打包后直接登记即可
    if (process.defaultApp && process.argv.length >= 2) app.setAsDefaultProtocolClient(PROTO, process.execPath, [path.resolve(process.argv[1])]);
    else app.setAsDefaultProtocolClient(PROTO);
    const ok = app.isDefaultProtocolClient(PROTO, process.execPath, process.defaultApp ? [path.resolve(process.argv[1])] : []);
    console.log('[唤起] 协议 ' + PROTO + ':// ' + (ok ? '已登记' : '登记未生效') + '（卸载：加 --unregister-protocol 启动一次）');
  } catch (e) { console.log('[唤起] 登记失败：' + (e && e.message || e)); }
}
if (!app.requestSingleInstanceLock()) {
  app.quit();                                      // 已经有实例在跑：交给它前置
} else {
  app.on('second-instance', (_e, argv) => {
    const u = (argv || []).find(a => String(a).startsWith(PROTO + '://'));
    focusMain();
    if (u) handleOpenUrl(u);
  });
  app.on('open-url', (e, url) => { e.preventDefault(); handleOpenUrl(url); });   // macOS 点链接走这里
}

app.whenReady().then(() => {
  if (process.argv.includes('--unregister-protocol')) {
    try { app.removeAsDefaultProtocolClient(PROTO); console.log('[唤起] 已解除 ' + PROTO + ':// 登记'); } catch (e) {}
    app.quit(); return;
  }
  registerProtocol();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  loadLiveState();                                  // 上次选中的对话与开关状态（重开窗口接着用）
  createWindow();
  // 状态文件被外部改（人改、别的工具改）：推给画布；坏文件不推，画布继续用上一版
  links().startWatching(payload => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { if (!w.isDestroyed()) w.webContents.send('link:external', payload); } catch (_) { }
    }
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { stopLiveTimer(); });

ipcMain.handle('agents:list', () => listAgents());
ipcMain.handle('agent:ask', (_e, payload) => askAgent(payload));
// 共享链路状态文件：路径 / 写 / 读 / 删（临时画布关掉就删）
ipcMain.handle('link:dir', () => links().dir);
ipcMain.handle('link:path', (_e, id) => links().fileOf(id));
ipcMain.handle('link:write', (e, { id, doc }) => {
  if (liveSender(e)) return { ok: false, error: '实时画布是只读窗口：链路状态只由主窗口写' };
  try { return links().write(id, doc); } catch (e2) { return { ok: false, error: String(e2 && e2.message || e2) }; }
});
ipcMain.handle('link:read', (_e, id) => links().read(id));
ipcMain.handle('link:drop', (e, id) => {
  if (liveSender(e)) return { ok: false, error: '实时画布是只读窗口' };
  links().drop(id); return true;
});
// 版本记录：列 / 推一条（主进程统一裁到最近 20 版）/ 删（链路删掉时一起清）
ipcMain.handle('version:list', (_e, id) => versions().list(id));
ipcMain.handle('version:push', (e, { id, entry }) => {
  if (liveSender(e)) return { ok: false, error: '实时画布是只读窗口' };
  try {
    const r = versions().push(id, entry);
    if (entry && entry.rollback) console.log(`[版本] ${id}：记下新版本 v${entry.v}（回滚到 v${(entry.rollback && entry.rollback.to) || '?'}）`);
    return r;
  } catch (e2) { return { ok: false, error: String(e2 && e2.message || e2) }; }
});
ipcMain.handle('version:drop', (e, id) => { if (liveSender(e)) return { ok: false, error: '实时画布是只读窗口' }; return versions().drop(id); });
// 独立实时画布：开窗 / 列最近有活动的对话 / 上次的选中与开关 / 跟随（只读） / 单次取一份
// 实时画布的口径：**卡片和「读取 agent 链路」完全一样**——输入 / 加工 / 输出三种卡，
// 每张卡带素材·工具·成果模块与内部实现，正文说人话。不做版本卡、不做点评卡、不做分支。
const LIVE_PLAIN = [
  '卡片内容一律说人话，而且要说具体：',
  '① 用的是什么——哪几张图（什么图、几张）、哪些数据；',
  '② 做了什么加工——怎么挑、怎么比、怎么改、按什么标准算合格；',
  '③ 交出什么——什么文件/清单，里面每条写什么。',
  '不要写「处理数据」「整理一下」这种空话。命令、脚本、文件路径、字段名一律只放「内部实现」，不进卡片正文。',
].join('');
const LIVE_MODS = [
  'mods 的写法（按用户 2026-11-07 的口径）：',
  '· 输入卡：只写真正被读进来的素材（哪几张图、哪份清单、哪个视频）。「抽帧」「重出」「改尺寸」这类动作不算素材，别写进输入卡。',
  '· 加工卡：只写「用什么加工」——模型/接口优先（例如 生图模型、视频模型、文本模型），不要写「怎么挑、怎么比、怎么查」这类做法（做法写进正文）。',
  '· 输出卡：只写真正交出来的文件（图片 / 视频 / 文档）。「带签名与标注」「字节哈希」「清单条目」这类是加工时做的事，不算成果，别写进输出卡。',
].join('');

const livePrompt = ({ who, topic, ask, steps, reads, writes, said, paths }) => [
  '【实时画布】你是平台主管，在把一条真实工作对话，画成工作流开发平台里的卡片。',
  '只做分析：不执行、不跑命令、不读写文件、不发消息、不付费。下面是只读出来的材料。',
  '',
  `岗位：${who}`,
  `这件事：${topic || '（无题）'}`,
  '',
  '派活原文（节选）：', String(ask || '（没有）').slice(0, 900),
  '',
  '真正做过的步骤（按顺序，工具名 + 参数要点）：', String(steps || '（没有）').slice(0, 3200),
  '',
  `读过的文件：${String(reads || '').slice(0, 700) || '（没有）'}`,
  `写出的文件：${String(writes || '').slice(0, 700) || '（没有）'}`,
  '',
  '它的交付（节选）：', String(said || '（没有）').slice(0, 1600),
  '',
  '请这样画（和「读取 agent 链路」同一套规矩）：',
  '1. 只画这条对话里反复在做的主线，4–9 张卡；寒暄、测试、系统通知不画。',
  '2. 输入卡写清它真正调用的文件/素材；**加工卡正文必须写清「用哪份素材 → 怎么做 → 交出什么」**（三样都要有，别只写做了什么）；输出卡写清交出的文件。',
  '   mods 也照着分：加工卡的 mods 只写「怎么做」的工具（技能名/画法/脚本），素材和成果不要重复塞进 mods——它们由连线带上来。',
  '3. 连线只按这条路走：输入 → 加工 → 输出（输出也可以再喂给下一张加工）。输入卡只往外连，什么都不连进输入卡；',
  '   每张加工卡至少有一个来源（输入卡或上一张加工/输出），至少交出一张输出卡；整条连成一片，不能断成几截。',
  LIVE_PLAIN,
  LIVE_MODS,
  '4. impl 写执行时真正用到的：技能名、工具、字段名。**并且原样抄上这一步用到/产出的文件完整路径**（下面「这次碰过的文件」里有的，一个字都不要改），',
  '   路径只放 impl，不进卡片正文——鼠标停在素材/成果上要靠它做预览。',
  '',
  '这次碰过的文件（原样可用）：',
  (paths && paths.length ? paths.join('\n') : '（没有识别到绝对路径）'),
  '5. 只输出一个 JSON 对象，不要解释，不要代码块标记。格式：',
  '{"name":"工作流名（12 字内）","summary":"一句话说清这条链路","cards":[{"key":"c1","kind":"in","title":"短标题","body":"这一步要什么/做什么/交出什么","impl":"技能/目录/工具/字段","mods":["模块短词"]}],"edges":[["c1","c2"]]}',
].join('\n');

// 正文里夹着的路径 / 文件名 / 命令句搬进内部实现（和主画布的 splitTech 同一口径：句级、保守，
// 拆不干净就原样留着，绝不硬改写中文）
const TECH_IN_BODY = /[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|\/[A-Za-z0-9_.-]{2,}|`[^`]*`|(?:^|\s)--[a-z][\w-]*|\b[\w-]+\.(png|jpe?g|json|jsonl|js|mjs|py|sh|md|csv|ya?ml|webp|gif|mp4|mov)\b/;
// 截断也要截在句号上：卡片正文被硬切一半（「…原样保留在」）比短一点更难看
function clipSentence(text, max) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const i = Math.max(head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('，'));
  return (i >= max * 0.6 ? head.slice(0, i + 1) : head.slice(0, max - 1) + '…');
}
function splitTechBody(body, impl) {
  const raw = String(body || '');
  const parts = raw.split(/(?<=[。；;！!？?])/).map(x => x.trim()).filter(Boolean);
  const human = [], tech = [];
  for (const p of parts) (TECH_IN_BODY.test(p) ? tech : human).push(p);
  const kept = human.join('');
  if (kept.length >= 12) return { body: clipSentence(kept, 220), impl: [String(impl || '').trim(), tech.join('')].filter(Boolean).join('\n').slice(0, 400) };
  return { body: clipSentence(raw, 220), impl: String(impl || '').slice(0, 400) };
}

// 解析：只认「cards 是非空数组」的那个候选（提示词里的示例也长得合法，取最后一个真答案）
function extractCards(text) {
  const t = String(text || '');
  const tries = [];
  for (const m of t.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) tries.push(m[1]);
  tries.reverse();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(t.slice(a, b + 1));
  let o = null;
  for (const cand of tries) {
    try { const x = JSON.parse(cand.trim()); if (x && Array.isArray(x.cards) && x.cards.length) { o = x; break; } } catch (_) { }
  }
  if (!o) return null;
  const KIND_MOD = { in: 'mat', proc: 'tool', out: 'res' };
  const cards = [];
  (Array.isArray(o.cards) ? o.cards : []).forEach((c, i) => {
    if (!c || cards.length >= 14) return;
    const kind = ['in', 'proc', 'out'].includes(c.kind) ? c.kind : '';
    const title = String(c.title || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    const body = String(c.body || '').replace(/\s+/g, ' ').trim().slice(0, 220);
    if (!kind || !title || !body || /^(短标题|标题|卡名|示例)$/.test(title)) return;
    const mods = (Array.isArray(c.mods) ? c.mods : []).map(m => String(typeof m === 'string' ? m : (m && m.name) || ''))
      .map(x => x.replace(/\s+/g, ' ').trim()).filter(x => x && !/^(模块短词|短词)$/.test(x))
      .slice(0, 6).map(name => ({ type: KIND_MOD[kind], name: name.slice(0, 16) }));
    const key = String(c.key || 'c' + (i + 1));
    const clean = splitTechBody(body, c.impl);
    cards.push({ id: key, kind, title, body: clean.body, impl: clean.impl, mods });
  });
  if (!cards.length) return null;
  const byKey = new Map(cards.map(c => [c.id, c]));
  const byTitle = new Map(cards.map(c => [c.title, c]));
  const edges = [];
  const reach = (from, to) => { const seen = new Set([from]), todo = [from]; while (todo.length) { const k = todo.pop(); if (k === to) return true; for (const [x, y] of edges) if (x === k && !seen.has(y)) { seen.add(y); todo.push(y); } } return false; };
  const add = (a2, b2) => {
    if (!a2 || !b2 || a2 === b2 || b2.kind === 'in') return;
    if (edges.some(([x, y]) => x === a2.id && y === b2.id) || reach(b2.id, a2.id)) return;
    edges.push([a2.id, b2.id]);
  };
  const ref = v => byKey.get(String(v)) || byTitle.get(String(v == null ? '' : v).trim());
  for (const e of (Array.isArray(o.edges) ? o.edges : [])) add(ref(Array.isArray(e) ? e[0] : e && e.from), ref(Array.isArray(e) ? e[1] : e && e.to));
  // 闸门里的补线：没来源的加工接前面最近的输入/加工；没产出的加工接后面最近的输出；落单的输入/输出各接一次
  const has = (a2, b2) => edges.some(([x, y]) => x === a2 && y === b2);
  cards.forEach((c, i) => {
    if (c.kind === 'proc') {
      if (!edges.some(([, y]) => y === c.id)) {
        const prev = cards.slice(0, i).reverse();
        const src = prev.find(x => x.kind === 'in') || prev.find(x => x.kind === 'proc') || cards.find(x => x.kind === 'in');
        if (src) add(src, c);
      }
      if (!edges.some(([x]) => x === c.id)) {
        const next = cards.slice(i + 1);
        const dst = next.find(x => x.kind === 'out') || next.find(x => x.kind === 'proc') || null;
        if (dst) add(c, dst);
      }
    }
    if (c.kind === 'in' && !edges.some(([x]) => x === c.id)) {
      const p = cards.slice(i + 1).find(x => x.kind === 'proc') || cards.find(x => x.kind === 'proc');
      if (p) add(c, p);
    }
    if (c.kind === 'out' && !edges.some(([, y]) => y === c.id)) {
      const p = cards.slice(0, i).reverse().find(x => x.kind === 'proc' || x.kind === 'in');
      if (p) add(p, c);
    }
  });
  // 模型给了指向「被滤掉的卡」的连线：一律丢掉，别留悬空的线
  const alive = new Set(cards.map(c => c.id));
  const clean = edges.filter(([x, y]) => alive.has(x) && alive.has(y));
  return { name: String(o.name || '').slice(0, 20), summary: String(o.summary || '').slice(0, 120), cards, edges: clean };
}

// 质量闸：和读取链路一个口径——三类齐全、每张加工都有来源和产出、整条连成一片
function cardProblem(p) {
  if (!p || !p.cards.length) return '没拆出卡片';
  const has = k => p.cards.some(c => c.kind === k);
  if (p.cards.length < 3 || !has('in') || !has('proc') || !has('out')) return '拆出来的卡不全（输入、加工、输出都得有）';
  const bad = p.cards.filter(c => (c.kind === 'proc' && (!p.edges.some(([, y]) => y === c.id) || !p.edges.some(([x]) => x === c.id)))
    || (c.kind === 'in' && !p.edges.some(([x]) => x === c.id))
    || (c.kind === 'out' && !p.edges.some(([, y]) => y === c.id)));
  if (bad.length) return '有卡没接上：' + bad.map(c => c.title).join('、');
  const seen = new Set([p.cards[0].id]), todo = [p.cards[0].id];
  while (todo.length) {
    const k = todo.pop();
    for (const [a2, b2] of p.edges) { const o2 = a2 === k ? b2 : b2 === k ? a2 : null; if (o2 && !seen.has(o2)) { seen.add(o2); todo.push(o2); } }
  }
  if (seen.size < p.cards.length) return '链路断成了几截';
  return '';
}

// 把这条对话整理成和读取链路同一形状的结构化原料
const ABS_ANY = /\/(?:Users|Applications|Volumes|tmp|private|opt|home)\/[^\s"'`；;，,（）()<>|]*?\.(?:png|jpe?g|webp|gif|bmp|svg|mp4|mov|webm|md|markdown|txt|json|jsonl|csv|ya?ml|pdf)/gi;
function liveMaterial(msgs) {
  const base = p => String(p || '').replace(/\/+$/, '').split('/').pop();
  const reads = new Map(), writes = new Map(), steps = [], said = [], paths = new Set();
  let cur = '';                                   // 最近的 cd 目录：命令里的裸文件名按它拼绝对路径
  let ask = '';
  for (const m of msgs) {
    if (m.role === 'user') { if (!ask) ask = String(m.text || '').replace(/\s+/g, ' ').slice(0, 900); continue; }
    for (const t of (m.tools || [])) {
      const a = t.args || {};
      const arg = a.path || a.file_path || a.command || a.name || a.query || a.url || '';
      steps.push(`${t.name}${arg ? ' ' + String(arg).slice(0, 70) : ''}`);
      // 这次真的碰到的文件：绝对路径直接收；命令行里「cd 到某目录 + 裸文件名」按当前目录拼成绝对路径
      const blob = String(JSON.stringify(a));
      for (const m of blob.matchAll(ABS_ANY)) paths.add(m[0]);
      if (a.command) {
        const cd = /\bcd\s+["']?([^"'&;|]{2,300})/.exec(String(a.command));
        if (cd) cur = cd[1].trim().replace(/\/+$/, '');
        for (const m of String(a.command).matchAll(/([\w\u4e00-\u9fa5][\w\u4e00-\u9fa5.\-]*?\.(?:png|jpe?g|webp|gif|bmp|svg|mp4|mov|webm|md|txt|json|csv|ya?ml))\b/g)) {
          const f = m[1];
          if (cur && !f.startsWith('/')) paths.add(cur + '/' + f);
        }
      }
      if (a.path && String(a.path).startsWith('/')) paths.add(String(a.path));
      const f = base(a.path || a.file_path || '');
      if (f && /^(read_file|vision_analyze|file_read)$/.test(t.name)) reads.set(f, (reads.get(f) || 0) + 1);
      if (f && /^(write_file|patch|edit_file|apply_patch)$/.test(t.name)) writes.set(f, (writes.get(f) || 0) + 1);
    }
    const txt = String(m.text || '').replace(/\s+/g, ' ').trim();
    if (txt.length > 60) said.push(txt.slice(0, 300));
  }
  const fmt = m => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join('、');
  return { ask, steps: steps.slice(-140).join('\n'), reads: fmt(reads), writes: fmt(writes), said: said.slice(-6).join('\n---\n'),
    paths: [...paths].slice(0, 60) };
}

// 卡面归属（用户 2026-11-07 定）：素材/工具/成果各归各位。
// 输入卡只留真被读进来的素材；加工卡把「模型/接口」标成工具（带能力说明），做法另记；输出卡只留真文件。
const MF_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|svg|mp4|mov|webm|mkv|mp3|wav|pdf|md|txt|json|csv|xlsx|docx|pptx|zip)$/i;
const MF_ACTION = /(抽帧|抽两?帧|截图|重出|重画|生成|合成|拼接|压缩|转码|导出|裁剪|改尺寸|加签名|签名|标注|水印|哈希|核对|清单条目|尺寸|数量)/;
const MF_MODELS = [
  { re: /(seedance|doubao[-_ ]?seedance|即梦|jimeng|视频模型|生成视频|video_gen|跑视频)/i, name: '视频模型', caps: '图/文 → 视频 · 单次文本 ≤7000 字（其余按接口）' },
  { re: /(gpt-?image|dall-?e|nano-?banana|imagen|flux|midjourney|sdxl|qwen-?image|wanx|seedream|生图|出图|画图|生成图|image_gen)/i, name: '生图模型', caps: '图/文 → 图 · 单次 1 张（参考图/文本上限按接口）' },
  { re: /(sora|veo|kling|hailuo|runway|pika)/i, name: '视频模型', caps: '图/文 → 视频（按接口）' },
];
function normMods(card, kind) {
  const raw = Array.isArray(card.mods) ? card.mods : [];
  const list = raw.map(m => (typeof m === 'string' ? { type: kind === 'proc' ? 'how' : (kind === 'in' ? 'mat' : 'res'), name: String(m) } : { ...m }));
  const implTxt = String(card.impl || '') + ' ' + String(card.body || '') + ' ' + list.map(m => m.name).join(' ');
  const out = [];
  const seen = new Set();
  const add = m => { const k = m.type + ':' + m.name; if (!m.name || seen.has(k)) return; seen.add(k); out.push(m); };
  if (kind === 'proc') {
    for (const mo of MF_MODELS) if (mo.re.test(implTxt) && !out.some(x => x.name === mo.name)) add({ type: 'tool', name: mo.name, caps: mo.caps });
  }
  for (const m of list) {
    const nm = String(m.name || '').trim();
    if (!nm) continue;
    const fileish = MF_EXT.test(nm) || /(图|视频|文档|清单|表|报告|录屏)/.test(nm) || /\b(PNG|JPG|JPEG|WEBP|MP4|MOV|PDF|MD|JSON|CSV|SVG)\b/i.test(nm);
    if (kind === 'in') { if (!MF_ACTION.test(nm) && fileish) add({ type: 'mat', name: nm }); continue; }
    if (kind === 'out') { if (fileish && !MF_ACTION.test(nm)) add({ type: 'res', name: nm }); continue; }
    // 加工卡：模型/软件算工具（带能力说明），其余算做法
    const TOOL_LEX = /(ffmpeg|blender|freestyle|python|node|comfy|photoshop|shasum|exiftool|image|vision|seedance|ark|视频模型|生图模型|文本模型|脚本)/i;
    const hitModel = MF_MODELS.find(mo => mo.re.test(nm));
    if (hitModel) { add({ type: 'tool', name: hitModel.name, caps: hitModel.caps }); continue; }
    if (TOOL_LEX.test(nm)) { add({ type: 'tool', name: nm }); continue; }
    if (m.type === 'tool' && out.some(x => x.name === nm)) continue;
    add({ type: 'how', name: nm });
  }
  // 兜底：素材卡/成果卡滤空了，就用卡名当那一样（总比空着强）
  if ((kind === 'in' || kind === 'out') && !out.length) {
    const ownName = String(card.title || '').split(' · ')[0].trim();
    if (ownName) add({ type: kind === 'in' ? 'mat' : 'res', name: ownName });
  }
  // 路径：卡里能抄到绝对路径的，挂到第一个成果/素材上做预览
  const p = (String(card.impl || '').match(/\/[^\s;；,，]+\.(?:png|jpe?g|webp|gif|mp4|mov|webm|pdf|md|txt|json|csv|svg)/i) || [])[0];
  if (p) {
    const first = out.find(x => x.type === (kind === 'in' ? 'mat' : 'res'));
    if (first) first.path = p;
  }
  card.mods = out;
}
function normalizePlan(plan) {
  for (const c of plan.cards || []) {
    try { normMods(c, c.kind); } catch (e) { }
  }
  return plan;
}

ipcMain.handle('live:analyze', async (_e, { profile, session, topic }) => {
  const t0 = Date.now();
  try {
    const r = await livefeed.readMessages(profile, session, 0, { limit: 200 });
    if (r.error) return { ok: false, error: r.error };
    if (!r.msgs.length) return { ok: false, error: '这条对话还没有内容' };
    LIVE.conv = { key: profile + ':' + session, profile, session, who: livefeed.whoOf(profile), title: topic };
    mergeMsgs(r.msgs);
    const mat = liveMaterial(LIVE.msgs);
    const prompt = livePrompt({ who: livefeed.whoOf(profile), topic, ...mat });
    let plan = null, lastText = '', why = '';
    // 模型偶尔少画一类卡/漏连线：和读取链路一样自动再拆一次（最多两次），不合格就不上画布
    for (let attempt = 0; attempt < 2 && !plan; attempt++) {
      const p = attempt === 0 ? prompt
        : prompt + '\n\n上一次拆得不对（' + why + '）。这次**只输出 JSON 本身**，并且输入、加工、输出三类卡都要有，每张加工卡都要有来源和产出，整条连成一片。';
      const res = await askAgentClean({ profile: 'default', prompt: p, toolsets: 'todo,no_mcp', timeoutMs: 300000 });
      if (!res.ok) { why = '分析没跑完（' + res.code + '）'; continue; }
      lastText = String(res.text || '');
      const cand = extractCards(lastText);
      if (!cand) { why = '分析没给出可用的链路'; continue; }
      why = cardProblem(cand);
      if (!why) plan = cand;
    }
    if (!plan) { LIVE.plan = null; return { ok: false, error: (why ? '链路没拆好：' + why : '分析没给出可用的链路'), retried: true, raw: lastText.slice(-400), secs: (Date.now() - t0) / 1000 }; }
    // 模型没把路径抄进 impl 时兜一次：卡名/正文里提到的文件名，对到这次真的碰过的绝对路径上
    const allPaths = mat.paths || [];
    const baseName = x => String(x || '').split('/').pop();
    for (const c of plan.cards) {
      const has = (String(c.impl || '').match(ABS_ANY) || []).length > 0;
      if (has || !allPaths.length) continue;
      const hay = c.title + ' ' + c.body;
      const hit = allPaths.find(x => {
        const b = baseName(x);
        return b && (hay.includes(b) || hay.includes(b.replace(/\.[^.]+$/, '')));
      });
      if (hit) c.impl = [String(c.impl || '').trim(), hit].filter(Boolean).join('\n').slice(0, 400);
    }
    normalizePlan(plan);                             // 素材 / 模型（带能力）/ 成果各归各位，见 normMods
    LIVE.plan = plan;
    LIVE.doc = {
      conv: LIVE.conv, at: Math.round(Date.now() / 1000),
      cards: plan.cards.map(c => ({ ...c, n: 1 })), edges: plan.edges,
      name: plan.name, summary: plan.summary, stats: { messages: LIVE.msgs.length },
    };
    saveLiveDoc(LIVE.doc);
    console.log(`[实时画布] 解析完成：${LIVE.doc.cards.length} 张卡 / ${LIVE.doc.edges.length} 条连线 · ${plan.name || ''} · 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return { ok: true, doc: LIVE.doc, name: plan.name, summary: plan.summary, secs: (Date.now() - t0) / 1000 };
  } catch (e) { return { ok: false, error: String(e && e.message || e), secs: (Date.now() - t0) / 1000 }; }
});

// 悬停素材/成果时的只读预览：只读文件本身，不写、不执行、不联网
const PEEK_IMG = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;
const PEEK_VID = /\.(mp4|mov|webm|m4v)$/i;
const PEEK_TXT = /\.(md|markdown|txt|json|jsonl|csv|ya?ml|log|js|mjs|cjs|ts|py|sh|html?|css|ini|conf)$/i;
ipcMain.handle('live:peek', (_e, { path: p } = {}) => {
  try {
    const f = String(p || '');
    if (!f.startsWith('/')) return { ok: false, error: '不是绝对路径' };
    const st = fs.statSync(f);
    if (!st.isFile()) return { ok: false, error: '不是一个文件' };
    const base = path.basename(f);
    if (PEEK_IMG.test(f)) return { ok: true, kind: 'image', url: pathToFileURL(f).href, bytes: st.size, name: base };
    if (PEEK_VID.test(f)) return { ok: true, kind: 'video', url: pathToFileURL(f).href, bytes: st.size, name: base };
    if (PEEK_TXT.test(f)) {
      const n = Math.min(st.size, 8000);
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, 0);
      fs.closeSync(fd);
      return { ok: true, kind: 'text', text: buf.toString('utf8'), bytes: st.size, name: base, cut: st.size > n };
    }
    return { ok: true, kind: 'file', name: base, bytes: st.size };
  } catch (e) { return { ok: false, error: String((e && e.code) || (e && e.message) || e) }; }
});

// 人在实时画布上改过的卡片：存回同一份文件（下次打开就是改后的样子）
// 「确定工作流」：实时画布把解析结果递上来，转给主窗口去建一条可编辑的工作流
ipcMain.handle('live:confirm', (_e, payload) => {
  const doc = payload && payload.doc ? payload.doc : payload;
  if (!doc || !Array.isArray(doc.cards) || !doc.cards.length) return { ok: false, error: '还没有可确定的链路' };
  if (!MAIN_WIN || MAIN_WIN.isDestroyed()) return { ok: false, error: '主窗口不在了' };
  MAIN_WIN.webContents.send('live:confirm-to-app', doc);
  return { ok: true, cards: doc.cards.length, edges: (doc.edges || []).length };
});

ipcMain.handle('live:doc:save', (_e, doc) => {
  if (!doc || !doc.conv || !Array.isArray(doc.cards)) return { ok: false, error: '内容不完整' };
  const okSave = saveLiveDoc(doc);
  if (okSave) {
    LIVE.doc = doc;
    LIVE.conv = doc.conv;
    sendLive(doc);
  }
  return { ok: okSave };
});

// 「取回本次文件」：从执行方最近的对话里，把这次跑出来的文件捞出来（只读会话库）
const RUN_FILE_RE = /(?:~|\.{1,2}\/)?[^\s"'`，。；、）)】\\]*?\/[^\s"'`，。；、）)】\\]*?\.(?:png|jpe?g|webp|gif|bmp|svg|mp4|mov|webm|md|txt|json|csv|ya?ml)/g;   // 文件路径：绝对或相对都认，反斜杠/引号一类直接切开
ipcMain.handle('run:pull', async (_e, { profile, limit } = {}) => {
  try {
    // 你说的是「跟某个 agent 的对话」，但那段对话可能落在 default 里、也可能是它自己的 profile，
    // 还可能是派活时开的那条：所以按「最近动过的库」一起扫，取最新的文件。
    const home = os.homedir();
    const profDirs = path.join(home, '.hermes', 'profiles');
    const cands = [];
    try {
      const dbs = [{ id: 'default', file: path.join(home, '.hermes', 'state.db') }];
      for (const id of fs.readdirSync(profDirs)) {
        if (!/^[\w.-]{1,64}$/.test(id)) continue;
        dbs.push({ id, file: path.join(profDirs, id, 'state.db') });
      }
      const now = Date.now();
      for (const db of dbs) {
        let st; try { st = fs.statSync(db.file); } catch (e) { continue; }
        const fresh = now - st.mtimeMs < 6 * 3600 * 1000;                     // 六小时内动过的库才扫
        if (!fresh && db.id !== profile && db.id !== 'default') continue;
        cands.push({ id: db.id, mtime: st.mtimeMs });
      }
    } catch (e) { /* 读不到目录时退回只扫执行方 */ }
    if (!cands.length) cands.push({ id: profile, mtime: Date.now() });
    cands.sort((a, b) => (b.id === profile) - (a.id === profile) || b.mtime - a.mtime);

    const seen = new Map();
    let scanned = 0;
    const sources = [];
    for (const c of cands.slice(0, 6)) {
      const r2 = await livefeed.recentMessages(c.id, 1200);
      if (!r2 || !r2.msgs) continue;
      scanned += r2.msgs.length;
      let hitHere = 0;
      for (const msg of r2.msgs) {
        const text = [msg.text, msg.result, JSON.stringify(msg.tools || [])].filter(Boolean).join('\n');
        for (const p of text.match(RUN_FILE_RE) || []) {
          const name = p.split('/').pop();
          const at = Number(msg.at) || 0;
          const prev = seen.get(p);
          if (prev) { prev.at = Math.max(prev.at, at); prev.hits++; continue; }
          seen.set(p, { path: p, name, at, msgId: msg.id || 0, profile: c.id, hits: 1 });
          hitHere++;
        }
      }
      if (hitHere) sources.push(c.id);
    }
    const files = [...seen.values()]
      .filter(f => !/\.(tmp|lock|log|db|db-wal|db-shm)$/i.test(f.path))
      .filter(f => !/(^|\/)(node_modules|\.git|\.hermes|__pycache__)\//.test(f.path))
      .filter(f => !/\/(package-lock\.json|package\.json|config\.yaml|SKILL\.md)$/i.test(f.path))
      .filter(f => !/^\/(tmp|private\/tmp|var\/folders)\//.test(f.path))
      .sort((a, b) => b.at - a.at).slice(0, 40);
    return { ok: true, conv: { profile, sources }, files, scanned };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});
ipcMain.handle('live:open', () => openLiveWindow());
ipcMain.handle('live:open-path', (_e, p) => {
  try {
    const f = String(p || '');
    if (!f.startsWith('/')) return { ok: false, error: '不是绝对路径' };
    const st = fs.statSync(f);
    if (!st.isFile()) return { ok: false, error: '不是一个文件' };
    shell.openPath(f);
    return { ok: true, bytes: st.size };
  } catch (e) { return { ok: false, error: String((e && e.code) || (e && e.message) || e) }; }
});
ipcMain.handle('live:attach', (_e, id) => attachLiveView(id));
ipcMain.handle('app:dir', () => __dirname);
ipcMain.handle('live:list', () => livefeed.listConversations().catch(err => ({ error: String(err && err.message || err) })));
ipcMain.handle('live:state', () => ({ profile: LIVE_STATE.profile, session: LIVE_STATE.session, on: LIVE_STATE.on, following: !!LIVE.timer, dir: livefeed.ROOT }));
ipcMain.handle('live:snapshot', async (_e, { profile, session }) => {
  const r = await liveLoad(profile, session);
  if (r && r.ok && (!r.doc || !r.doc.cards || !r.doc.cards.length)) {
    const saved = loadLiveDoc(profile, session);
    if (saved) return { ok: true, doc: saved, saved: true };
  }
  return r;
});
ipcMain.handle('live:follow', async (_e, { profile, session, on }) => {
  if (!on) {
    LIVE_STATE.on = false; saveLiveState(); stopLiveTimer();
    console.log('[实时画布] 停止读取（画面留在原地）');
    return { ok: true };
  }
  const r = await liveLoad(profile, session);
  if (!r.ok) return r;
  LIVE_STATE.profile = profile; LIVE_STATE.session = session; LIVE_STATE.on = true; saveLiveState();
  startLiveTimer();
  sendLive(r.doc);
  return r;
});
// 只读：读一个 agent 的工作链路原料（身份 / 技能 / 最近干的活 / 上下游 / 读写的目录）
ipcMain.handle('agent:chain', (_e, id) => readChain(id).catch(err => ({ ok: false, error: String(err && err.message || err) })));
ipcMain.handle('flow:save', async (e, flow) => {
  if (liveSender(e)) return { ok: false, error: '实时画布是只读窗口' };
  const r = await dialog.showSaveDialog({ title: '保存工作流', defaultPath: path.join(os.homedir(), '工作流-' + (flow.name || 'untitled') + '.json'), filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return { ok: false };
  fs.writeFileSync(r.filePath, JSON.stringify(flow, null, 2), 'utf8');
  return { ok: true, path: r.filePath };
});
ipcMain.handle('flow:open', async () => {
  const r = await dialog.showOpenDialog({ title: '打开工作流', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return { ok: false };
  try { return { ok: true, path: r.filePaths[0], flow: JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')) }; }
  catch (e) { return { ok: false, error: String(e) }; }
});
