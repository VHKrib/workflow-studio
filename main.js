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
const LIVE = { win: null, timer: 0, busy: false, feed: null, conv: null, msgs: [], plan: null, doc: null, lastId: 0, lastError: '' };
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
// 实时画布的口径：**卡片和「读取 agent 链路」完全一样**——输入 / 加工 / 输出三种卡，
// 每张卡带素材·工具·成果模块与内部实现，正文说人话。不做版本卡、不做点评卡、不做分支。
const LIVE_PLAIN = [
  '卡片内容一律说人话，而且要说具体：',
  '① 用的是什么——哪几张图（什么图、几张）、哪些数据；',
  '② 做了什么加工——怎么挑、怎么比、怎么改、按什么标准算合格；',
  '③ 交出什么——什么文件/清单，里面每条写什么。',
  '不要写「处理数据」「整理一下」这种空话。命令、脚本、文件路径、字段名一律只放「内部实现」，不进卡片正文。',
].join('');
const LIVE_MODS = 'mods 把这张卡用到的东西拆成短词模块（每块 8 个字以内，说人话）：输入卡写素材（哪几张图、哪些数据），加工卡写工具（怎么挑、怎么比、怎么查），输出卡写成果（交出的文件里有哪几样）。';

const livePrompt = ({ who, topic, ask, steps, reads, writes, said }) => [
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
  '2. 输入卡：它真正调用的文件/素材；加工卡：它具体怎么干；输出卡：它交出了什么。',
  '3. 连线只按这条路走：输入 → 加工 → 输出（输出也可以再喂给下一张加工）。输入卡只往外连，什么都不连进输入卡；',
  '   每张加工卡至少有一个来源（输入卡或上一张加工/输出），至少交出一张输出卡；整条连成一片，不能断成几截。',
  LIVE_PLAIN,
  LIVE_MODS,
  '4. impl 写执行时真正用到的：技能名、目录、工具、字段名（这些不进卡片正文）。',
  '5. 只输出一个 JSON 对象，不要解释，不要代码块标记。格式：',
  '{"name":"工作流名（12 字内）","summary":"一句话说清这条链路","cards":[{"key":"c1","kind":"in","title":"短标题","body":"这一步要什么/做什么/交出什么","impl":"技能/目录/工具/字段","mods":["模块短词"]}],"edges":[["c1","c2"]]}',
].join('\n');

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
    cards.push({ id: key, kind, title, body, impl: String(c.impl || '').slice(0, 400), mods });
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
function liveMaterial(msgs) {
  const base = p => String(p || '').replace(/\/+$/, '').split('/').pop();
  const reads = new Map(), writes = new Map(), steps = [], said = [];
  let ask = '';
  for (const m of msgs) {
    if (m.role === 'user') { if (!ask) ask = String(m.text || '').replace(/\s+/g, ' ').slice(0, 900); continue; }
    for (const t of (m.tools || [])) {
      const a = t.args || {};
      const arg = a.path || a.file_path || a.command || a.name || a.query || a.url || '';
      steps.push(`${t.name}${arg ? ' ' + String(arg).slice(0, 70) : ''}`);
      const f = base(a.path || a.file_path || '');
      if (f && /^(read_file|vision_analyze|file_read)$/.test(t.name)) reads.set(f, (reads.get(f) || 0) + 1);
      if (f && /^(write_file|patch|edit_file|apply_patch)$/.test(t.name)) writes.set(f, (writes.get(f) || 0) + 1);
    }
    const txt = String(m.text || '').replace(/\s+/g, ' ').trim();
    if (txt.length > 60) said.push(txt.slice(0, 300));
  }
  const fmt = m => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join('、');
  return { ask, steps: steps.slice(-140).join('\n'), reads: fmt(reads), writes: fmt(writes), said: said.slice(-6).join('\n---\n') };
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
    LIVE.plan = plan;
    LIVE.doc = {
      conv: LIVE.conv, at: Math.round(Date.now() / 1000),
      cards: plan.cards.map(c => ({ ...c, n: 1 })), edges: plan.edges,
      name: plan.name, summary: plan.summary, stats: { messages: LIVE.msgs.length },
    };
    console.log(`[实时画布] 解析完成：${LIVE.doc.cards.length} 张卡 / ${LIVE.doc.edges.length} 条连线 · ${plan.name || ''} · 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return { ok: true, doc: LIVE.doc, name: plan.name, summary: plan.summary, secs: (Date.now() - t0) / 1000 };
  } catch (e) { return { ok: false, error: String(e && e.message || e), secs: (Date.now() - t0) / 1000 }; }
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
