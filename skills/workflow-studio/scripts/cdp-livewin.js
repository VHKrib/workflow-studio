// 独立实时画布：选一条对话 → 开开关 → 画布跟着长 → 关开关 → 换对话 → 记住状态 → 关主窗口它跟着关。
//
// 这个脚本需要一份「样本会话库」：库里只有示例内容，绝不用真人私聊当样本。
//
//   node skills/workflow-studio/scripts/cdp-livewin.js --setup      # 造样本库，打印启动命令
//   export CDP_PORT=9333
//   WF_LIVE_DIR="$TMPDIR/wf-live-fixture" ./node_modules/.bin/electron . \
//     --remote-debugging-port=9333 --user-data-dir="$TMPDIR/wf-9333" &
//   node skills/workflow-studio/scripts/cdp-livewin.js               # 跑断言
//   node skills/workflow-studio/scripts/cdp-livewin.js --shot docs/live.png   # 顺手截一张文档图
//
// 样本库里新消息由这个脚本直接写进去（它是我们自己的临时库），应用那侧始终只读。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const has = n => argv.includes('--' + n);
const PORT = Number(opt('port', process.env.CDP_PORT || 9222));
const FIX = opt('dir', process.env.WF_LIVE_DIR || path.join(process.env.TMPDIR || os.tmpdir(), 'wf-live-fixture'));
const USERDATA = opt('userdata', path.join(process.env.TMPDIR || os.tmpdir(), 'wf-9333'));
const SHOT = opt('shot', '');
const SQLITE = fs.existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3';

const get = u => new Promise((res, rej) => http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
const wait = ms => new Promise(r => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

let fail = 0;
const ok = (name, pass, info) => {
  if (!pass) fail++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info == null ? '' : '  · ' + (typeof info === 'string' ? info : JSON.stringify(info))}`);
};

// ---------- 样本会话库 ----------
const q = s => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";
function sqlite(file, sql) {
  return execFileSync(SQLITE, [file], { input: sql, encoding: 'utf8', maxBuffer: 1 << 26 });
}
function setup() {
  fs.rmSync(FIX, { recursive: true, force: true });
  // 连应用数据目录一起清：选中的对话 / 开关状态要处于「第一次打开」的样子，第一条卡的计时才有意义
  fs.rmSync(USERDATA, { recursive: true, force: true });
  fs.mkdirSync(path.join(FIX, 'profiles', 'demo-a'), { recursive: true });
  fs.writeFileSync(path.join(FIX, 'profile.yaml'), 'display_name: 平台主管\n', 'utf8');
  fs.writeFileSync(path.join(FIX, 'profiles', 'demo-a', 'profile.yaml'), 'display_name: 示例岗位甲\nsectionName: 示例部门\n', 'utf8');

  const schema = `
CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT, source TEXT, profile_name TEXT,
  last_activity_at REAL, last_activity_description TEXT, message_count INTEGER, tool_call_count INTEGER,
  started_at REAL, ended_at REAL);
CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
  tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL);
`;
  const t0 = now();
  let sql = schema;
  const ins = (session, role, content, at, toolName, callId, calls) => {
    sql += `INSERT INTO messages(session_id,role,content,tool_call_id,tool_calls,tool_name,timestamp) VALUES(` +
      `${q(session)},${q(role)},${q(content)},${q(callId || '')},${q(calls ? JSON.stringify(calls) : '')},${q(toolName || '')},${at});\n`;
  };
  const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

  // 对话甲：10 个连续读文件（要并成 1 张卡）+ 一次「批量外壳」+ 两轮问答
  sql += `INSERT INTO sessions(id,title,source,profile_name,last_activity_at,message_count,tool_call_count,started_at)
    VALUES('sess-alpha','整理示例商品的图与卖点','local','default',${t0 - 30},30,14,${t0 - 600});\n`;
  let at = t0 - 600;
  ins('sess-alpha', 'user', '把这批示例商品的图挑一下，最后交一份清单。', at);
  for (let i = 0; i < 10; i++) {
    at += 2;
    ins('sess-alpha', 'assistant', '', at, '', 'call_r' + i, [call('call_r' + i, 'read_file', { path: `/srv/demo/示例资料-${i}.md` })]);
    ins('sess-alpha', 'tool', '{"success": true, "output": "示例正文"}', at + 1, 'read_file', 'call_r' + i);
  }
  at += 3;
  ins('sess-alpha', 'assistant', '', at, '', 'call_wrap', [call('call_wrap', 'tool_call', { calls: [
    { name: 'web_search', arguments: { query: '示例商品 卖点' } },
    { name: 'skill_view', arguments: { name: 'demo-skill' } },
  ] })]);
  ins('sess-alpha', 'tool', '{"success": true, "output": "示例搜索结果"}', at + 1, 'tool_call', 'call_wrap');
  at += 5;
  ins('sess-alpha', 'assistant', '这批图我挑完了：示例商品甲的主图拍清了正面，详情长图里有两张是重复的，建议保留三张、其余作废。清单我放在示例目录里了。', at);
  at += 60;
  ins('sess-alpha', 'user', '顺便把价格也对照一下。', at);
  at += 3;
  ins('sess-alpha', 'assistant', '', at, '', 'call_p', [call('call_p', 'terminal', { command: 'cat /srv/demo/示例价格.csv | head' })]);
  ins('sess-alpha', 'tool', '{"success": true, "output": "示例价格"}', at + 1, 'terminal', 'call_p');
  at += 5;
  ins('sess-alpha', 'assistant', '价格也对照好了：示例商品甲和示例商品乙同档，示例商品丙贵一档，原因是多一件赠品。', at);

  // 对话乙：另一条最近活动（换对话要用）
  sql += `INSERT INTO sessions(id,title,source,profile_name,last_activity_at,message_count,tool_call_count,started_at)
    VALUES('sess-beta','核对示例价格表','local','default',${t0 - 3600},4,1,${t0 - 3800});\n`;
  ins('sess-beta', 'user', '帮我把示例价格表核一遍。', t0 - 3800);
  ins('sess-beta', 'assistant', '', t0 - 3797, '', 'call_b', [call('call_b', 'read_file', { path: '/srv/demo/示例价格.csv' })]);
  ins('sess-beta', 'tool', '{"success": true, "output": "示例价格"}', t0 - 3796, 'read_file', 'call_b');
  ins('sess-beta', 'assistant', '核完了：四行价格里有一行和另一张表对不上，差了两块钱，应该是四舍五入。', t0 - 3790);

  // 岗位甲的对话丙：跨岗位也能列出来（只在那个岗位的库里，别重复出现在主管库）
  sqlite(path.join(FIX, 'state.db'), sql);
  sqlite(path.join(FIX, 'profiles', 'demo-a', 'state.db'), schema +
    `INSERT INTO sessions(id,title,source,profile_name,last_activity_at,message_count,tool_call_count,started_at)
      VALUES('sess-gamma','写示例周报','local','demo-a',${t0 - 7200},2,0,${t0 - 7300});\n` +
    `INSERT INTO messages(session_id,role,content,timestamp) VALUES('sess-gamma','user','把这一周的示例活儿写成周报。',${t0 - 7300});\n` +
    `INSERT INTO messages(session_id,role,content,timestamp) VALUES('sess-gamma','assistant','示例周报写好了：本周做了三件事，两件完成、一件在等资料。',${t0 - 7250});\n`);
  console.log('样本库：' + FIX);
  console.log('启动隔离实例：\n  export CDP_PORT=9333\n  WF_LIVE_DIR="' + FIX + '" ./node_modules/.bin/electron . --remote-debugging-port=9333 --user-data-dir="$TMPDIR/wf-9333" &');
}
// 直播过程中往样本库里写新消息（应用侧只读，写的是我们自己这份临时库）
function addRows(session, n) {
  let sql = '';
  let at = now();
  for (let i = 0; i < n; i++) {
    at += 1;
    const id = 'call_live' + Date.now().toString(36) + i;
    const calls = [{ id, type: 'function', function: { name: 'terminal', arguments: JSON.stringify({ command: `echo 示例第${i + 1}步` }) } }];
    sql += `INSERT INTO messages(session_id,role,content,tool_call_id,tool_calls,tool_name,timestamp) VALUES(${q(session)},'assistant','',${q('')},${q(JSON.stringify(calls))},${q('')},${at});\n`;
    sql += `INSERT INTO messages(session_id,role,content,tool_call_id,tool_calls,tool_name,timestamp) VALUES(${q(session)},'tool',${q('{"success": true, "output": "示例输出"}')},${q(id)},${q('')},${q('terminal')},${at + 1});\n`;
  }
  sql += `UPDATE sessions SET last_activity_at=${at} WHERE id=${q(session)};\n`;
  const file = session === 'sess-gamma' ? path.join(FIX, 'profiles', 'demo-a', 'state.db') : path.join(FIX, 'state.db');
  sqlite(file, sql);
  return at * 1000;
}

if (has('setup')) { setup(); process.exit(0); }

// ---------- CDP ----------
async function connect(target, tries = 3) {
  let lastErr = null;
  for (let t = 0; t < tries; t++) {
    try { return await connectOnce(target); } catch (e) { lastErr = e; await wait(300); }
  }
  throw lastErr || new Error('CDP 连不上');
}
async function connectOnce(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); let closed = false;
  const send = (m, p = {}) => new Promise(r => {
    if (closed) return r({ exceptionDetails: { exception: { description: 'CDP 已断开' } } });
    const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  ws.addEventListener('error', () => { });
  ws.addEventListener('close', () => {
    closed = true;
    for (const [k, r] of pending) r({ exceptionDetails: { exception: { description: 'CDP 连接已经关掉（页面可能没了）' } } });
    pending.clear();
  });
  const opened = await Promise.race([
    new Promise(r => ws.addEventListener('open', () => r(true))),
    new Promise(r => setTimeout(() => r(false), 5000)),
  ]);
  if (!opened) { try { ws.close(); } catch (e) { } throw new Error('CDP 连接超时：' + target.url); }
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r && r.exceptionDetails) throw new Error(String((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text).split('\n').slice(0, 4).join(' | '));
    return r && r.result ? r.result.value : undefined;
  };
  const mouse = (type, x, y, clickCount) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount });
  const clickAt = async sel => {
    const r = await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const b = el.getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.top + b.height / 2}; })()`);
    if (!r) throw new Error('找不到元素 ' + sel);
    await mouse('mousePressed', r.x, r.y, 1); await mouse('mouseReleased', r.x, r.y, 1);
    await wait(120);
    return r;
  };
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (!r || !r.data) throw new Error('截图失败');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  };
  return { ws, ev, clickAt, shot, close: () => ws.close() };
}
async function targets() { return get(`http://127.0.0.1:${PORT}/json/list`); }
async function liveTarget() {
  for (let i = 0; i < 40; i++) {
    const t = (await targets()).find(x => x.type === 'page' && /live\.html/.test(x.url));
    if (t) return t;
    await wait(150);
  }
  return null;
}
const cardsState = `(() => {
  const ns = [...document.querySelectorAll('#canvas .node')];
  const rects = ns.map(el => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; });
  return {
    n: ns.length,
    rects,
    visible: rects.filter(r => r.x + r.w > 0 && r.y + r.h > 0 && r.x < innerWidth && r.y < innerHeight).length,
    cards: ns.map(el => ({ id: el.dataset.id, title: (el.querySelector('.t')||{}).textContent || '', body: (el.querySelector('.body')||{}).textContent || '', impl: (el.querySelector('details.limpl pre')||{}).textContent || '' })),
    stat: (document.querySelector('#lstat')||{}).textContent || '',
    checked: !!(document.querySelector('#lfol')||{}).checked,
    sel: (document.querySelector('#lconv')||{}).value || '',
    edges: document.querySelectorAll('#edges path.edge').length,
  };
})()`;
const overlapsOf = rects => {
  let n = 0;
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], b = rects[j];
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (w > 2 && h > 2) n++;
  }
  return n;
};

(async () => {
  const main = (await targets()).find(x => x.type === 'page' && !/live\.html/.test(x.url));
  if (!main) { console.error('no main page target on ' + PORT + ' — 先按脚本头部的命令起隔离实例'); process.exit(1); }
  const M = await connect(main);
  await M.ev(`(() => { if (!window.__liveErrs) { window.__liveErrs = []; addEventListener('error', e => window.__liveErrs.push(String(e.message || e))); } return 1; })()`);

  // ---------- 开窗 ----------
  // 真的点主窗口的「⋯ → 实时画布」，不是直接调函数
  await M.clickAt('#btnMore');
  await wait(150);
  await M.clickAt('#btnLive');
  const lt = await liveTarget();
  ok('live-open', !!lt, lt ? '独立窗口已打开' : '没等到 live.html');
  if (!lt) { process.exit(1); }
  const L = await connect(lt);
  await L.ev(`(() => { if (!window.__liveErrs) { window.__liveErrs = []; addEventListener('error', e => window.__liveErrs.push(String(e.message || e))); } return 1; })()`);
  await wait(600);

  const chrome = await L.ev(`(() => ({
    sidebar: !!document.querySelector('.side'), topbar: !!document.querySelector('.topbar'),
    panel: !!document.querySelector('.panel'), buttons: document.querySelectorAll('button').length,
    pick: !!document.querySelector('#lconv'), fol: !!document.querySelector('#lfol'), zoom: !!document.querySelector('.zoombar'),
    title: document.title,
  }))()`);
  ok('live-no-chrome', !chrome.sidebar && !chrome.topbar && !chrome.panel && chrome.buttons === 0 && chrome.pick && chrome.fol && chrome.zoom, chrome);

  // ---------- 选对话列表：谁 / 什么时候 / 在做什么 ----------
  const list = await L.ev(`(async () => { const opts = [...document.querySelectorAll('#lconv option')].map(o => ({v: o.value, t: o.textContent})); return opts; })()`);
  const three = list.filter(o => (o.t || '').split(' · ').length >= 3);
  const longOpt = list.filter(o => (o.t || '').length > 70 || /\n/.test(o.t || ''));
  ok('live-list', list.length >= 3 && three.length === list.length && longOpt.length === 0, { options: list.length, sample: list.map(o => o.t) });

  // ---------- 跟随：2 秒内出卡 ----------
  // 先确认是「第一次打开」：状态里空着，画布上 0 张卡（跑之前 --setup 会清掉应用数据目录）
  const st0 = await M.ev('window.tcflow.liveState()');
  const before0 = await L.ev(cardsState);
  ok('live-fresh-state', !st0.on && !st0.profile && before0.n === 0, { state: st0, cards: before0.n });
  const t0 = Date.now();
  await L.ev(`(() => { const s = document.querySelector('#lconv'); s.value = ${q('default:sess-alpha')}; s.dispatchEvent(new Event('change')); return 1; })()`);
  let c1 = before0, msCards = -1;
  for (let i = 0; i < 40; i++) { c1 = await L.ev(cardsState); if (c1.n > 0) { msCards = Date.now() - t0; break; } await wait(50); }
  await L.clickAt('.ltrack');                       // 开开关：从这里开始每秒读增量
  const st1 = await M.ev('window.tcflow.liveState()');
  ok('live-select-first-card-2s', msCards >= 0 && msCards <= 2000, { ms: msCards, cards: c1.n, stat: c1.stat });
  ok('live-follow-on', st1.following === true && st1.on === true && st1.session === 'sess-alpha', st1);
  await wait(400);
  c1 = await L.ev(cardsState);
  ok('live-follow-rendered', c1.n >= 3 && c1.edges >= 2 && c1.checked, { cards: c1.n, edges: c1.edges, titles: c1.cards.map(c => c.title) });
  // 排布：卡片不重叠，首屏能同时看见大部分卡（不是缩在一角、也不是滚到空白处）
  const ov = overlapsOf(c1.rects);
  ok('live-layout', ov === 0 && c1.visible >= Math.min(4, c1.n), { overlap: ov, visible: c1.visible, total: c1.n, rects: c1.rects.slice(0, 3) });

  // ---------- 连续读文件不刷卡：只有一句「读了 N 份资料」，细节收进内部实现（共 N 次）----------
  const merged = c1.cards.filter(c => /共 \d+ 次/.test(String(c.impl || '')));
  ok('live-merge-10-reads', merged.length >= 1 && c1.cards.every(c => c.title !== '读资料'), { count: merged.length, impl_tail: String(merged[0] && merged[0].impl).slice(-16) });
  // 卡片正面说人话；命令 / 路径 / JSON 在内部实现里
  const TECH = /(\/[\w.<>-]+\/|\{["']|`|(?:^|\s)--[a-z]|\b[\w-]+\.(?:json|js|md|py|ts|csv)\b)/;
  const dirty = c1.cards.filter(c => TECH.test(c.title) || TECH.test(c.body));
  const withImpl = c1.cards.filter(c => c.impl && /\/[\w.<>-]+\//.test(c.impl));
  ok('live-front-human', dirty.length === 0 && withImpl.length >= 2, { dirty: dirty.slice(0, 2), impl_cards: withImpl.length });

  // ---------- 直播继续长：往库里写新动作，2 秒内画布跟上 ----------
  addRows('sess-alpha', 3);
  const tGrow = Date.now();
  let msGrow = -1, cGrow = c1;
  for (let i = 0; i < 25; i++) {
    cGrow = await L.ev(cardsState);
    const changed = cGrow.n !== c1.n || JSON.stringify(cGrow.cards.map(c => c.body)) !== JSON.stringify(c1.cards.map(c => c.body));
    if (changed) { msGrow = Date.now() - tGrow; break; }
    await wait(100);
  }
  ok('live-grows-2s', msGrow >= 0 && msGrow <= 2000, { ms: msGrow, before: c1.n, after: cGrow.n, stat: cGrow.stat });
  if (SHOT) { try { fs.mkdirSync(path.dirname(path.resolve(SHOT)), { recursive: true }); await L.shot(path.resolve(SHOT)); console.log('截图：' + path.resolve(SHOT)); } catch (e) { console.log('截图失败：' + e.message); } }

  // ---------- 关开关：立刻停读，画面两次采样完全一致 ----------
  await L.clickAt('.ltrack');
  await wait(400);
  const a = await L.ev(cardsState);
  addRows('sess-alpha', 3);
  await wait(2500);
  const b = await L.ev(cardsState);
  const st = await M.ev('window.tcflow.liveState()');
  ok('live-off-frozen', !a.checked && a.n === b.n && JSON.stringify(a.cards) === JSON.stringify(b.cards) && st.following === false, { before: a.n, after: b.n, following: st.following, stat: b.stat });

  // ---------- 换对话：旧内容 0 残留 ----------
  await L.ev(`(() => { const s = document.querySelector('#lconv'); s.value = ${q('default:sess-beta')}; s.dispatchEvent(new Event('change')); return 1; })()`);
  await wait(900);
  const sw = await L.ev(cardsState);
  const oldBodies = a.cards.map(c => c.body);
  const residue = sw.cards.filter(c => oldBodies.includes(c.body));
  ok('live-switch-clean', sw.n >= 2 && sw.n < a.n && residue.length === 0 && !sw.cards.some(c => /清单/.test(c.body) && /图/.test(c.body)), { cards: sw.n, titles: sw.cards.map(c => c.title), residue: residue.length });

  // ---------- 记住状态：关掉独立窗口再开，选中的对话与开关还在 ----------
  await L.ev(`(() => { const s = document.querySelector('#lconv'); const f = document.querySelector('#lfol'); if (!f.checked) f.click(); return 1; })()`);
  await wait(600);
  const beforeClose = await L.ev(cardsState);
  const errs = [];
  errs.push(...(await L.ev('window.__liveErrs || []')).map(e => 'live: ' + e));
  await L.ev('window.close()');
  await wait(900);
  const afterList = await targets();
  const gone = !afterList.some(x => /live\.html/.test(x.url));
  const mainAlive = afterList.some(x => x.type === 'page' && !/live\.html/.test(x.url));
  ok('live-close-alone', gone && mainAlive, { live_gone: gone, main_alive: mainAlive });
  await M.ev('window.tcflow.openLive()');
  const lt2 = await liveTarget();
  ok('live-reopen', !!lt2, lt2 ? '重新打开' : '没等到');
  if (lt2) {
    const L2 = await connect(lt2);
    await wait(1200);
    const re = await L2.ev(cardsState);
    ok('live-remembered', re.checked && re.sel === 'default:sess-beta' && re.n >= 2, { checked: re.checked, sel: re.sel, cards: re.n });
    ok('live-reopen-same-content', re.n === beforeClose.n, { before: beforeClose.n, after: re.n });
    errs.push(...(await L2.ev('window.__liveErrs || []')).map(e => 'live2: ' + e));
    // 只读：这个窗口想写链路状态会被主进程挡住
    const w = await L2.ev(`(async () => { const r = await window.tcflow.linkWrite({ id: 'x', doc: { cards: [] } }); return { ok: !!r.ok, error: (r && r.error) || '' }; })()`);
    ok('live-window-cannot-write', w.ok === false, w);
    const v = await L2.ev(`(async () => { const r = await window.tcflow.versionPush({ id: 'x', entry: { v: 9 } }); return { ok: !!r.ok }; })()`);
    ok('live-window-cannot-version', v.ok === false, v);
    L2.close();
  }

  // ---------- 关主窗口：独立窗口跟着关 ----------
  errs.push(...(await M.ev('window.__liveErrs || []')).map(e => 'main: ' + e));
  await M.ev('window.close()');
  await wait(1200);
  const after = (await targets().catch(() => [])).filter(x => /live\.html/.test(x.url));
  ok('live-dies-with-main', after.length === 0, { live_targets: after.length });

  M.close(); L.close();
  ok('no-page-errors', errs.length === 0, errs);

  console.log(fail ? `\n${fail} 条没过` : '\n全部通过');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
