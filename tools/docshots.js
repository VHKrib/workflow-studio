// 重截 docs/read.png 与 docs/versions.png（界面改了之后跑一次，README 里的路径不变）
//
//   export CDP_PORT=9333                       # 指到自己起的隔离实例，别连 9222（用户正在用的窗口）
//   ./node_modules/.bin/electron . --remote-debugging-port=$CDP_PORT --user-data-dir=$TMPDIR/wf-$CDP_PORT &
//   node tools/docshots.js                     # 两张都重截
//   node tools/docshots.js --only read         # 只截一张
//
// 截的是 1380×880 的窗口（main.js 里默认尺寸），Retina 上存下来是 2760×1760，和之前那几张一致。
// 图里出现的都是中性示例（示例部门 / 示例岗位甲–丁 / 示例商品），不含本机路径、真实岗位名或其他项目字样；
// 版本列表是这边真做出来的改动（改正文 / 改模块 / 加卡连线），不是贴上去的假数据。
// 跑完会重载页面，注入的示例状态不会留在窗口里。
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.CDP_PORT || 9222);
const DOCS = path.join(__dirname, '..', 'docs');
const argv = process.argv.slice(2);
const ONLY = (() => { const i = argv.indexOf('--only'); return i >= 0 ? argv[i + 1] : ''; })();
const wait = ms => new Promise(r => setTimeout(r, ms));

const NEUTRAL_AGENTS = [
  { id: 'demo-1', name: '示例岗位甲', section: '示例部门', desc: '整理入库单、核对对账差异' },
  { id: 'demo-2', name: '示例岗位乙', section: '示例部门', desc: '把零散清单合并成一张总表' },
  { id: 'demo-3', name: '示例岗位丙', section: '另一部门', desc: '写操作说明、重跑失败的归档' },
  { id: 'demo-4', name: '示例岗位丁', section: '另一部门', desc: '把交付归档到资料库' },
];

// 版本图：一条四张卡的示例链路 + 五次真改动（改正文两处、改模块一处、加卡连线一处 → v1…v5）
const BUILD_VERSIONS = (neutral) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  agents = ${JSON.stringify(neutral)};
  const uid2 = () => 'd' + Math.random().toString(36).slice(2, 8);
  // 上一次截图留下的「示例链路」先清掉，重跑出来的图才一样（不叠两条同名链路）
  for (const old of store.workflows.filter(x => x.name === '示例链路')) {
    store.workflows = store.workflows.filter(x => x.id !== old.id);
    if (store.current === old.id) store.current = store.workflows[0].id;
    delete VER.list[old.id]; delete VER.sig[old.id]; delete VER.paths[old.id];
    try { window.tcflow.versionDrop(old.id); } catch (e) { }
    try { window.tcflow.linkDrop(old.id); } catch (e) { }
  }
  saveStore(false);
  const w = { id: 'w' + Date.now().toString(36), name: '示例链路', agent: '', nodes: [], edges: [], chat: [], version: 1, updated_at: Date.now() };
  const mk = (kind, title, body, mods, x, y) => {
    const n = { id: uid2(), kind, title, body, impl: '', mods: mods.map(m => ({ id: uid2(), type: m[0], name: m[1] })),
      checks: [], chat: [], status: 'idle', x, y };
    w.nodes.push(n); return n;
  };
  const a = mk('in', '素材包', '主图 5 张 + 页面标题、价格、规格', [['mat', '主图'], ['mat', '页面字段']], 0, 60);
  const b = mk('proc', '挑卖点', '按同类商品比，挑 3 条卖点，再列 3 条绝对不能写的话', [['tool', '比同类'], ['tool', '挑卖点']], 330, 60);
  const c = mk('out', '卖卡文案', '交一张卖点卡：每条卖点写了什么、用了哪张图', [['res', '清单']], 660, 60);
  w.edges.push([a.id, b.id], [b.id, c.id]);
  store.workflows.push(w); store.current = w.id; selId = null; panelCardId = null;
  saveStore(); renderWorkflowList(); render();
  await sleep(500);                                   // v1 新建链路
  b.body = '按同类商品比，挑 3 条卖点，再列 3 条绝对不能写的话；每条都要说清用的是哪张图。';
  saveEditing({ commit: true }); await sleep(150);    // v2 改「挑卖点」的正文
  c.body = '交一张卖点卡：每条卖点写了什么、用了哪张图、能不能直接用。';
  saveEditing({ commit: true }); await sleep(150);    // v3 改「卖卡文案」的正文
  a.mods.push({ id: uid2(), type: 'mat', name: '价格区间' });
  saveEditing({ commit: true }); await sleep(150);    // v4 改「素材包」的模块
  const d = mk('proc', '写文案', '拿卖点卡写三条投放文案', [['tool', '写文案']], 330, 420);
  w.edges.push([c.id, d.id]);
  saveStore(); commitVersions(); render();            // v5 加了「写文案」；加了 1 条连线
  await sleep(300);
  panelOpen = true; panelCardId = null; selId = null; zoom = 0.75; dockOpen = false;
  render(); centerView(); drawEdges(); paintVersionBox(); renderDock();
  await sleep(300);
  return { 版本: w.version, 条: (VER.list[w.id] || []).map(e => 'v' + e.v + ' ' + e.what), 卡: w.nodes.length, 线: w.edges.length };
})()`;

// 读取图：读取窗里一份中性示例（示例岗位甲）+ 拆好的六张卡预览，不真调 agent
const BUILD_READ = (neutral) => `(async () => {
  agents = ${JSON.stringify(neutral)};
  const now = Math.floor(Date.now() / 1000), day = 86400;
  rd.pick = 'demo-1'; rd.busy = false; rd.error = '';
  rd.chain = {
    ok: true, id: 'demo-1', name: '示例岗位甲', section: '示例部门', desc: '整理入库单、核对对账差异', soul: '',
    stats: { sessions: 46, first: now - day * 60, last: now, toolCalls: 210, readSessions: 80, readLimit: 80,
      bySource: { kanban: 40, oneshot: 6 } },
    skills: [{ name: 'table-merge', title: '表格整理', used: 23 }, { name: 'diff-check', title: '差异核对', used: 11 }],
    upstream: [{ name: '示例上游', count: 31 }], downstream: [{ name: '示例下游', count: 24 }],
    tasks: [{ title: '整理本周待办的入库单' }, { title: '把三份清单合成一张总表' }, { title: '核对上月的对账差异' },
      { title: '给新同事写一份操作说明' }, { title: '重跑一次失败的归档' }],
    reads: [['素材库/单据', 12], ['台账/差异', 9]], writes: [['交付/总表', 8]],
    tools: [['todo_list', 40], ['read_file', 30]],
  };
  rd.plan = parseChainPlan(JSON.stringify({
    cards: [
      { key: 'c1', kind: 'in', title: '派活单', body: '这次要整理哪些单据、交到哪天。', mods: ['派活原文'] },
      { key: 'c2', kind: 'in', title: '原始单据', body: '库里这批还没整理的单据。', mods: ['单据 12 份'] },
      { key: 'c3', kind: 'proc', title: '合并整理', body: '把三份清单合成一张总表，标出来源。', mods: ['表格整理'] },
      { key: 'c4', kind: 'proc', title: '差异核对', body: '逐条核对上月差异，写成差异条目。', mods: ['差异核对'] },
      { key: 'c5', kind: 'out', title: '总表', body: '一张总表，每行标出来源。', mods: ['总表', '来源标注'] },
      { key: 'c6', kind: 'out', title: '差异清单', body: '差异条目逐条列清。', mods: ['差异条目'] },
    ],
    edges: [['c1', 'c3'], ['c2', 'c3'], ['c3', 'c4'], ['c3', 'c5'], ['c4', 'c6']],
  }));
  openRead(); paintRead();
  await new Promise(r => setTimeout(r, 400));
  return { 预览卡: document.querySelectorAll('#rPrev .rtile').length, 计划: !!rd.plan };
})()`;

(async () => {
  const t = (await new Promise((res, rej) => http.get(`http://127.0.0.1:${PORT}/json/list`, r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b)));
  }).on('error', rej))).find(x => x.type === 'page');
  if (!t) { console.error('no page on ' + PORT + ' — 先起隔离实例（见 skills/workflow-studio/SKILL.md）'); process.exit(1); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, q = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: q })); });
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  await new Promise(r => ws.addEventListener('open', r));
  await send('Page.enable');

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (!r) return undefined;
    if (r.exceptionDetails) throw new Error(String((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text).split('\n').slice(0, 4).join(' | '));
    return r.result ? r.result.value : undefined;
  };
  const reload = async () => { await send('Page.reload', { ignoreCache: true }); await wait(4200); };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const out = path.join(DOCS, name);
    fs.writeFileSync(out, Buffer.from(s.data, 'base64'));
    const info = await ev(`JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })`);
    console.log('shot   ' + out + '  ' + fs.statSync(out).size + ' 字节  ' + info);
  };

  const size = await ev(`JSON.stringify({ w: innerWidth, h: innerHeight })`);
  if (!/"w":1380/.test(size)) console.warn('warn   窗口不是 1380 宽（' + size + '）：图会和默认观感不一致');

  if (ONLY !== 'read') {
    await reload();
    console.log('versions', JSON.stringify(await ev(BUILD_VERSIONS(NEUTRAL_AGENTS))));
    await wait(400);
    await shot('versions.png');
  }
  if (ONLY !== 'versions') {
    await reload();
    console.log('read    ', JSON.stringify(await ev(BUILD_READ(NEUTRAL_AGENTS))));
    await wait(400);
    await shot('read.png');
  }
  await reload();                                    // 把注入的示例状态清掉
  ws.close(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
