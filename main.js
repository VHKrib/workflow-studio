const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROFILES_DIR = path.join(os.homedir(), '.hermes', 'profiles');
const { readChain } = require('./chain');
const { createLinkStore } = require('./linkstore');
const { createVersionStore } = require('./versions');
const livefeed = require('./livefeed');
const actmap = require('./actmap');
const HERMES = path.join(os.homedir(), '.hermes', 'hermes-agent', '.hermes', 'bin', 'hermes');

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
    if (!fs.existsSync(HERMES)) return resolve({ ok: false, error: 'hermes 入口不存在: ' + HERMES });
    const args = ['-p', profile, 'chat'];
    if (toolsets) args.push('-t', String(toolsets));
    args.push('-q', prompt);
    const child = execFile(HERMES, args,
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
    if (!fs.existsSync(HERMES)) return resolve({ ok: false, error: 'hermes 入口不存在' });
    const args = ['-p', profile, 'chat', '--format', 'stream-json'];
    if (toolsets) args.push('-t', String(toolsets));
    args.push('-q', prompt);
    execFile(HERMES, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env } }, (err, stdout) => {
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
  if (!fs.existsSync(HERMES)) return resolve({ ok: false, error: 'hermes 入口不存在: ' + HERMES });
  if (preview) toolsets = PREVIEW_TOOLSETS;
  const args = ['-p', profile, 'chat', '--format', 'stream-json'];
  if (toolsets) args.push('-t', String(toolsets));     // 只给指定工具组（分析链路时 todo,no_mcp：不能跑命令、不能写文件、不碰 MCP 接口）
  args.push('-q', prompt);
  const fake = (READ_FAKE === 'hang' && toolsets === 'todo,no_mcp') || (CHAT_FAKE === 'hang' && !toolsets);
  const child = fake ? spawn('/bin/sleep', ['600'], { env: { ...process.env } }) : spawn(HERMES, args, { env: { ...process.env } });
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
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
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
const LIVE = { win: null, timer: 0, busy: false, feed: null, lastId: 0, lastError: '' };
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
  return !!(LIVE.win && !LIVE.win.isDestroyed() && e && e.sender && e.sender.id === LIVE.win.webContents.id);
}
function sendLive(doc) {
  if (!LIVE.win || LIVE.win.isDestroyed()) return;
  try { LIVE.win.webContents.send('live:doc', doc); } catch (e) { }
}
function stopLiveTimer() { if (LIVE.timer) clearInterval(LIVE.timer); LIVE.timer = 0; }
function startLiveTimer() { stopLiveTimer(); LIVE.timer = setInterval(liveTick, LIVE_POLL_MS); }

// 只认列表里真的存在的那条对话：外部传来的岗位 / 会话标识先对一遍，不拿它拼路径
async function findConv(profile, session) {
  const all = await livefeed.listConversations();
  return all.find(c => c.profile === profile && c.session === session) || null;
}
async function liveLoad(profile, session) {
  const conv = await findConv(profile, session);
  if (!conv) return { ok: false, error: '这条对话已经不在最近的活动里了' };
  const same = LIVE.feed && LIVE.feed.conv && LIVE.feed.conv.key === conv.key;
  if (!same) { LIVE.feed = actmap.createFeed({ profile, session, who: conv.who, key: conv.key, title: conv.doing }); LIVE.lastId = 0; }
  const r = await livefeed.readMessages(profile, session, LIVE.lastId);
  if (r.error) return { ok: false, error: r.error };
  const msgs = r.msgs.slice();
  // 窗口从中间截的：开头那句如果不可用（不是人的要求 / 是系统注入），往前找最近一句真的是人话的要求补进来
  const usable = m => {
    if (!m || m.role !== 'user') return false;
    const c = actmap.cleanAsk(m.text);
    return (c.images && c.images.length) || actmap.splitAsk(c.text).body.length >= 4;
  };
  if (!LIVE.lastId && msgs.length && !usable(msgs[0])) {
    const asks = await livefeed.askCandidates(profile, session, msgs[0].id);
    const ask = asks.find(m => { const c = actmap.cleanAsk(m.text); return c.text && c.text.length <= 600 && actmap.splitAsk(c.text).body.length >= 4; });
    if (ask) msgs.unshift(ask);
  }
  actmap.applyMessages(LIVE.feed, msgs);
  LIVE.lastId = LIVE.feed.lastId;
  console.log(`[实时画布] 只读读取「${conv.who} · ${conv.doing}」：${r.msgs.length} 条（sqlite3 -readonly file:…?mode=ro）`);
  return { ok: true, doc: actmap.feedDoc(LIVE.feed) };
}
async function liveTick() {
  if (LIVE.busy || !LIVE_STATE.on || !LIVE_STATE.profile || !LIVE_STATE.session) return;
  LIVE.busy = true;
  try {
    const r = await livefeed.readMessages(LIVE_STATE.profile, LIVE_STATE.session, LIVE.lastId);
    if (r.error) { if (r.error !== LIVE.lastError) console.log('[实时画布] 读不了：' + r.error); LIVE.lastError = r.error; return; }
    LIVE.lastError = '';
    if (!r.msgs.length) return;                                   // 没新消息：不推、不重画
    actmap.applyMessages(LIVE.feed, r.msgs);
    LIVE.lastId = LIVE.feed.lastId;
    console.log(`[实时画布] 增量 ${r.msgs.length} 条（只读）`);
    sendLive(actmap.feedDoc(LIVE.feed));
  } finally { LIVE.busy = false; }
}
function openLiveWindow() {
  if (LIVE.win && !LIVE.win.isDestroyed()) { LIVE.win.show(); LIVE.win.focus(); return { ok: true, existing: true }; }
  LIVE.win = new BrowserWindow({
    width: 1080, height: 760, minWidth: 720, minHeight: 520,
    title: '实时画布',
    parent: MAIN_WIN || undefined,                 // 关主窗口时跟着关
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f5f3ef',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  LIVE.win.loadFile(path.join(__dirname, 'renderer', 'live.html'));
  LIVE.win.webContents.on('render-process-gone', (_e, d) => console.log('[实时画布] 渲染进程退出：' + JSON.stringify(d || {})));
  LIVE.win.on('closed', () => {
    LIVE.win = null;
    stopLiveTimer();                               // 窗口没了就不再读；开关状态留着，重开窗口会接着跟
    console.log('[实时画布] 窗口关了：停止读取（选中的对话与开关状态已记住）');
  });
  return { ok: true };
}

app.whenReady().then(() => {
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
// 实时画布：让平台主管把一条对话解析成链路——**用到的文件 → 加工方式 → 产出的文件**。
// 对话本身不成为卡片（用户口径）；卡片正面只写人话，命令/路径进实现。
const livePrompt = (who, lines) => [
  `下面是一条真实工作对话（岗位：${who}）。请把它解析成一条**工作流链路**，并标出人在哪些环节做了「精修」。`,
  '',
  '先认出这条链路本来的样子（主干）：',
  '- 输入 = 这条工作流真正调用的文件/素材（图片、数据文件、货号、画板、视频…）',
  '- 加工 = 加工过程中实际采用的做法（哪个技能、哪个脚本、哪几步），名字要短、要人话（例：找证据包、出卖点卡、出五区画板）',
  '- 输出 = 按要求产出的文件（写出的文件、渲染的图、导出的视频、成片）',
  '',
  '再认出「精修」——这是重点：',
  '- 同一个素材被**换了一种做法重做**（换参考图、换技能、改参数、换个风格），就是一条**分支**。',
  '- 每条分支记下：从哪个节点分出来、这次的加工是什么、产出了什么、和上一版差在哪（用一句人话，例：参考换成蓝色视频 / 齿部这次分开了）。',
  '- 人在对话里否掉上一版的那些话（「不对」「换那个」「不要用 GPT」）就是分支的理由，写进 note。',
  '',
  '输出要求：',
  '- 卡片标题 3～10 个字，说清「这一步干什么」，不要写文件名当标题；',
  '- 卡片正文一句话 + 关键文件（文件名可以写，命令和绝对路径不许写）；',
  '- 分支用同一条边表表示：父节点 → 多个子节点就是分叉；',
  '- 总卡数控制在 6～14 张：主干一条 + 每条精修一两个节点，别把琐碎步骤都画出来。',
  '',
  '只输出一个 JSON，别的什么都不要：',
  '{"name":"链路名","cards":[{"key":"c1","kind":"in|proc|out","title":"找证据包","body":"一句话","note":"（可选）为什么改 / 和上一版差在哪","branch":"main 或 try1"}],"edges":[["c1","c2"]]}',
  '',
  '对话：',
  lines.slice(0, 14000),
].join('\n');

function extractPlan(text) {
  const t = String(text || '');
  const tries = [];
  for (const m of t.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) tries.push(m[1]);   // 围栏里的（从后往前试）
  tries.reverse();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(t.slice(a, b + 1));
  let o = null;
  for (const cand of tries) {
    try { const x = JSON.parse(cand.trim()); if (x && Array.isArray(x.cards) && x.cards.length) { o = x; break; } } catch (_) { }
  }
  if (!o) return null;
  const cards = (Array.isArray(o.cards) ? o.cards : []).map((c, i) => ({
    id: String(c.key || c.id || 'c' + (i + 1)),
    key: String(c.key || c.id || 'c' + (i + 1)),
    kind: c.kind === 'in' || c.kind === 'proc' || c.kind === 'out' ? c.kind : 'proc',
    title: String(c.title || '').slice(0, 24) || '一步',
    body: String(c.body || '').slice(0, 220),
    note: String(c.note || '').slice(0, 120),
    branch: String(c.branch || 'main').slice(0, 12),
    mods: [], impl: '',
  })).filter(c => c.title && c.title !== '一步');
  if (!cards.length) return null;
  const byKey = new Map(cards.map(c => [c.key, c.id]));
  const edges = (Array.isArray(o.edges) ? o.edges : [])
    .map(e => [byKey.get(String(e && e[0])), byKey.get(String(e && e[1]))])
    .filter(([x, y]) => x && y && x !== y);
  return { name: String(o.name || '').slice(0, 40), cards, edges };
}

ipcMain.handle('live:analyze', async (_e, { profile, session }) => {
  try {
    const r = await livefeed.readMessages(profile, session, 0, { limit: 120 });
    if (r.error) return { ok: false, error: r.error };
    if (!r.msgs || !r.msgs.length) return { ok: false, error: '这条对话还没有内容' };
    const lines = r.msgs.map(m => {
      const who = m.role === 'user' ? '人' : m.role === 'tool' ? '结果' : 'agent';
      const tools = (m.tools || []).map(t => t.name + '(' + JSON.stringify(t.args || {}).slice(0, 80) + ')').join(' ');
      return `[${who}] ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 200)}${tools ? ' ⚙' + tools.slice(0, 160) : ''}`;
    }).join('\n');
    const res = await askAgentClean({ profile: 'default', prompt: livePrompt(livefeed.whoOf(profile), lines), toolsets: 'todo,no_mcp', timeoutMs: 240000 });
    if (!res.ok) return { ok: false, error: '分析没跑完（' + res.code + '）' };
    const plan = extractPlan(res.text);
    if (!plan) return { ok: false, error: '分析没给出可用的链路', raw: String(res.text || '').slice(-600) };
    return { ok: true, plan };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

ipcMain.handle('live:open', () => openLiveWindow());
ipcMain.handle('live:list', () => livefeed.listConversations().catch(err => ({ error: String(err && err.message || err) })));
ipcMain.handle('live:state', () => ({ profile: LIVE_STATE.profile, session: LIVE_STATE.session, on: LIVE_STATE.on, following: !!LIVE.timer, dir: livefeed.ROOT }));
ipcMain.handle('live:snapshot', async (_e, { profile, session }) => liveLoad(profile, session));
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
