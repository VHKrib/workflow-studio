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
const livegraph = require('./livegraph');
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
const LIVE = { win: null, timer: 0, busy: false, feed: null, conv: null, msgs: [], plan: null, ev: null, lastId: 0, lastError: '' };
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
function docNow() {
  const ev = livegraph.buildEvidence(LIVE.msgs, LIVE.conv);
  const doc = livegraph.buildGraph(ev, LIVE.plan);
  LIVE.ev = ev;
  return doc;
}
async function liveLoad(profile, session) {
  const conv = await findConv(profile, session);
  if (!conv) return { ok: false, error: '这条对话已经不在最近的活动里了' };
  const same = LIVE.feed && LIVE.feed.conv && LIVE.feed.conv.key === conv.key;
  if (!same) {
    LIVE.feed = { conv: { profile, session, who: conv.who, key: conv.key, title: conv.doing } };
    LIVE.conv = LIVE.feed.conv;
    LIVE.msgs = []; LIVE.plan = null; LIVE.lastId = 0; LIVE.ev = null;
  }
  const r = await livefeed.readMessages(profile, session, LIVE.lastId);
  if (r.error) return { ok: false, error: r.error };
  const msgs = r.msgs.slice();
  // 窗口从中间截的：开头那句如果不可用（不是人的要求 / 是系统注入），往前找最近一句真的是人话的要求补进来
  const usable = m => {
    if (!m || m.role !== 'user') return false;
    const c = livegraph.cleanAsk(m.text);
    return (c.images && c.images.length) || livegraph.splitAsk(c.text).body.length >= 4;
  };
  if (!LIVE.lastId && msgs.length && !usable(msgs[0])) {
    const asks = await livefeed.askCandidates(profile, session, msgs[0].id);
    const ask = asks.find(m => { const c = livegraph.cleanAsk(m.text); return c.text && c.text.length <= 600 && livegraph.splitAsk(c.text).body.length >= 4; });
    if (ask) msgs.unshift(ask);
  }
  mergeMsgs(msgs);
  LIVE.lastId = LIVE.msgs.reduce((n, m) => Math.max(n, Number(m.id) || 0), 0);
  const doc = docNow();
  console.log(`[实时画布] 只读读取「${conv.who} · ${conv.doing}」：${r.msgs.length} 条（sqlite3 -readonly file:…?mode=ro）· 底账 ${doc.stats.cards} 张卡`);
  return { ok: true, doc };
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
    sendLive(docNow());
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
// 实时画布：让平台主管把这条对话**分成几步**（每步一段消息号），并给人话的名字与修改原因。
// 关系（用了哪版材料、做出哪版产物、因为看了哪版才改）一律由 livegraph 的底账算，模型说错也进不来。
const livePrompt = ({ who, topic, ev }) => [
  '【实时画布】你是平台主管，在把一条真实工作对话，画成工作流开发平台里的链路。',
  '只做分析：不执行、不跑命令、不读写文件、不发消息、不付费。材料已经由程序只读整理成底账（证据号=消息号）。',
  '',
  `岗位：${who}`,
  `这件事：${topic || '（无题）'}`,
  '',
  livegraph.brief(ev),
  '',
  '请把这条对话分成若干「加工步骤」。规则：',
  '1. 一步 = 一段连续的消息号范围（from/to）。范围必须落在真实调用上、彼此不重叠；',
  '   同一次加工里连写几个文件算一步；看过结果再改 / 再出一版 = 另一步。',
  '2. 只读不产出、只为看一眼的动作不要单独成步（并进前后那步）；确实是在核对某个产物时，可以单独一步并标 status。',
  '3. 状态只用 done / failed / proposed / doing：记录里真有产出的才是 done；调用了但没产出、或写了又失败的标 failed；',
  '   只在回答里提了做法、没有任何调用（或范围里确实没有写操作）的标 proposed；收尾还没出结果标 doing。',
  '4. note 只写「为什么做 / 为什么改」，优先引用人在消息号 X 说的原话要点（一行以内）；没有原因就不写。',
  '5. after 可选：这一步是因为看了哪一版才改的，写 {"path":"完整路径","ver":版本号}；不确定就别写，不要猜。',
  '6. title ≤ 12 字；body ≤ 60 字说人话（用了什么素材、怎么做、交出什么）；impl 只放命令 / 路径 / 工具，不进正文。',
  '7. 不许编造记录里没有的步骤、材料、产物；历史窗口截断（见底账最后一行）就少画，缺口不要补圆。',
  '只输出一个 JSON，不要解释、不要代码块标记：',
  '{"name":"12 字内","summary":"一句话","steps":[{"key":"s1","from":7426,"to":7470,"title":"重出三张草图板","body":"……","impl":"……","note":"……","status":"done","after":[{"path":"……","ver":1}]}]}',
].join('\n');

function extractPlan(text) {
  const t = String(text || '');
  const tries = [];
  for (const m of t.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) tries.push(m[1]);
  tries.reverse();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(t.slice(a, b + 1));
  let o = null;
  for (const cand of tries) {
    try { const x = JSON.parse(cand.trim()); if (x && Array.isArray(x.steps) && x.steps.length) { o = x; break; } } catch (_) { }
  }
  if (!o) return null;
  const steps = o.steps.map((s, i) => ({
    key: String(s.key || 's' + (i + 1)),
    from: Number(s.from) || 0, to: Number(s.to) || 0,
    msg: Number(s.msg) || 0,
    title: String(s.title || '').slice(0, 24),
    body: String(s.body || '').slice(0, 120),
    impl: String(s.impl || '').slice(0, 600),
    note: String(s.note || '').slice(0, 120),
    status: ['done', 'failed', 'proposed', 'doing'].includes(s.status) ? s.status : 'done',
    branch: String(s.branch || 'main').slice(0, 12),
    after: Array.isArray(s.after) ? s.after.filter(x => x && typeof x === 'object' && x.path).slice(0, 4) : [],
  })).filter(s => (s.status === 'proposed' && s.msg) || (s.from && s.to && s.to >= s.from));
  if (!steps.length) return null;
  return { name: String(o.name || '').slice(0, 40), summary: String(o.summary || '').slice(0, 120), steps };
}

ipcMain.handle('live:analyze', async (_e, { profile, session, topic }) => {
  const t0 = Date.now();
  try {
    const r = await livefeed.readMessages(profile, session, 0, { limit: 200 });
    if (r.error) return { ok: false, error: r.error };
    if (!r.msgs.length) return { ok: false, error: '这条对话还没有内容' };
    if (!LIVE.conv || LIVE.conv.key !== profile + ':' + session) {
      LIVE.conv = { key: profile + ':' + session, profile, session, who: livefeed.whoOf(profile), title: topic };
      LIVE.msgs = []; LIVE.plan = null;
    }
    mergeMsgs(r.msgs);
    const ev = livegraph.buildEvidence(LIVE.msgs, LIVE.conv);
    const prompt = livePrompt({ who: livefeed.whoOf(profile), topic, ev });
    const res = await askAgentClean({ profile: 'default', prompt, toolsets: 'todo,no_mcp', timeoutMs: 300000 });
    if (!res.ok) return { ok: false, error: '分析没跑完（' + res.code + '）', secs: (Date.now() - t0) / 1000 };
    const plan = extractPlan(res.text);
    if (!plan) return { ok: false, error: '分析没给出可用的步骤分段', raw: String(res.text || '').slice(-600), secs: (Date.now() - t0) / 1000 };
    // 上一次的图有效就留着：新的一份不成立时，不拿半份糊上（buildGraph 里会把整份作废并说明）
    const prev = LIVE.plan;
    LIVE.plan = plan;
    const doc = docNow();
    if (doc.problems.length && doc.cards.every(c => c.kind !== 'proc')) {
      LIVE.plan = prev;
      return { ok: false, error: '这次分的步不成立：' + doc.problems.join('；'), secs: (Date.now() - t0) / 1000 };
    }
    const map = livegraph.mapping(LIVE.ev, doc);
    console.log(`[实时画布] 解析完成：${doc.cards.length} 张卡 / ${doc.edges.length} 条关系 / ${map.rows.length} 步 · 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s${doc.problems.length ? ' · ' + doc.problems.join('；') : ''}`);
    return { ok: true, doc, name: plan.name, summary: plan.summary, mapping: map, problems: doc.problems, secs: (Date.now() - t0) / 1000 };
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
