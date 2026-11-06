// 实时链路：共享状态文件 + 临时对话画布 + 外部改动认领。对着隔离实例跑。
//
//   export CDP_PORT=9333
//   node skills/workflow-studio/scripts/cdp-live.js                 # 只跑不花钱的部分（模拟流、文件、认领、坏文件、存成正式）
//   node skills/workflow-studio/scripts/cdp-live.js --chat          # 再加两次真实 agent 调用：临时画布实时长卡 / agent 看得到链路
//   node skills/workflow-studio/scripts/cdp-live.js --chat --agent default
//
// 每条打印 PASS / FAIL，最后一行「全部通过」或失败条数；退出码 1 = 有失败。
// 探针自成一体：每一步自己 openCard/切画布，不依赖上一次调用留下的选中状态。
const fs = require('fs');
const http = require('http');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const has = n => argv.includes('--' + n);
const PORT = Number(opt('port', process.env.CDP_PORT || 9222));
const AGENT = opt('agent', 'default');
const CHAT = has('chat');

const get = u => new Promise((res, rej) => http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
const wait = ms => new Promise(r => setTimeout(r, ms));

let fail = 0;
const ok = (name, pass, info) => {
  if (!pass) fail++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info == null ? '' : '  · ' + (typeof info === 'string' ? info : JSON.stringify(info))}`);
};

(async () => {
  const t = (await get(`http://127.0.0.1:${PORT}/json/list`)).find(x => x.type === 'page');
  if (!t) { console.error('no page target on ' + PORT + ' — 先按 SKILL.md 起隔离实例'); process.exit(1); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, q = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: q })); });
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  await new Promise(r => ws.addEventListener('open', r));

  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r && r.exceptionDetails) throw new Error(String((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text).split('\n').slice(0, 4).join(' | '));
    return r.result ? r.result.value : undefined;
  };
  const mouse = (type, x, y, clickCount) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount });
  const clickAt = async sel => {
    const r = await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const b = el.getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.top + b.height / 2}; })()`);
    if (!r) throw new Error('找不到元素 ' + sel);
    await mouse('mousePressed', r.x, r.y, 1); await mouse('mouseReleased', r.x, r.y, 1);
    await wait(200);
    return r;
  };

  // 页面里的错误统一记账，最后断言一条都没有
  await ev(`(() => { if (!window.__liveErrs) { window.__liveErrs = []; addEventListener('error', e => window.__liveErrs.push(String(e.message || e))); } return 1; })()`);

  const state = () => ev(`(() => { const w = flow(); return w ? {id: w.id, temp: !!w.temp, name: w.name, agent: w.agent, nodes: w.nodes.length, edges: w.edges.length, version: w.version || 1, titles: w.nodes.map(n => n.title), dom: document.querySelectorAll('.node').length, bar: document.querySelector('#tempBar').classList.contains('on'), list: store.workflows.length} : null; })()`);
  const linkOf = wid => ev(`(async () => { const r = await window.tcflow.linkRead(${JSON.stringify(wid)}); return { ok: r.ok, path: r.path, doc: r.doc, error: r.error || '' }; })()`);
  const pathOf = wid => ev(`window.tcflow.linkPath(${JSON.stringify(wid)})`);

  // ---------- 0 页面在
  ok('open', await ev('!!document.querySelector("#btnTempChat")'), '顶栏有「对话建链路」');

  const baseList = (await state()).list;

  // ---------- 1 临时画布：不进列表
  await clickAt('#btnTempChat');
  let s = await state();
  ok('temp-open', s && s.temp && s.bar && s.list === baseList, { temp: s && s.temp, bar: s && s.bar, list: s && s.list, base: baseList });

  // ---------- 2 跟着流长卡：模拟流（先给一张写完的、再给第二张）
  const chunk1 = '{"name":"测试链路","summary":"一句话","cards":[{"key":"c1","kind":"in","title":"素材包","body":"主图 5 张 + 页面标题","impl":"evidence/a"}';
  const chunk2 = chunk1 + ',{"key":"c2","kind":"proc","title":"挑卖点","body":"从这些图里挑 3 条卖点","impl":"cards/a.json","mods":["主图","页面字段"]}';
  await ev(`(() => { window.__mark = document.querySelector('.node') ? 'none' : 'empty'; growTempFrom(${JSON.stringify(chunk1)}); return 1; })()`);
  const g1 = await state();
  // 给已有的第一张卡打个记号：后面断言「没被整张重建」
  await ev(`(() => { const el = document.querySelector('.node'); if (el) el.dataset.probe = 'keep'; return 1; })()`);
  await ev(`growTempFrom(${JSON.stringify(chunk2)})`);
  await wait(150);
  const g2 = await state();
  const kept = await ev(`(() => { const el = document.querySelector('.node'); return el ? el.dataset.probe === 'keep' : false; })()`);
  ok('grow-partial', g1.nodes === 1 && g2.nodes === 2 && g2.edges === 1 && g2.dom === 2, { after1: g1.nodes, after2: g2.nodes, edges: g2.edges, dom: g2.dom });
  ok('grow-incremental', kept, kept ? '第一张卡的 DOM 没被重建' : '第一张卡被整张重建了（应只补新卡）');

  // ---------- 3 状态文件：1 秒内跟上画布，内容与画布一致
  await ev(`saveStore()`);                                     // 画布改动 → 触发写文件（350ms 防抖）
  let doc = null, t0 = Date.now(), lag = -1;
  while (Date.now() - t0 < 1500) {
    const r = await linkOf('__temp__');
    if (r.ok && r.doc && r.doc.cards.length === 2) { doc = r.doc; lag = Date.now() - t0; break; }
    await wait(100);
  }
  const now = await state();
  ok('file-1s', !!doc && lag >= 0 && lag < 1000, { lag_ms: lag });
  ok('file-matches', !!doc && doc.cards.length === now.nodes && doc.edges.length === now.edges && doc.agent === (now.agent || null) && doc.version === now.version,
    { file: doc && { cards: doc.cards.length, edges: doc.edges.length, agent: doc.agent, version: doc.version }, canvas: { cards: now.nodes, edges: now.edges, agent: now.agent, version: now.version } });
  ok('file-shape', !!doc && doc.cards.every(c => c.id && c.kind && c.title && 'body' in c && 'impl' in c && Array.isArray(c.mods) && c.position) && Array.isArray(doc.edges),
    doc && { keys: Object.keys(doc), cardKeys: Object.keys(doc.cards[0] || {}) });

  // 画布这一侧的延迟：再给一张写完的卡，量「调用到 DOM 出现」用了多久（同步上屏 → 同一帧）
  const instant = await ev(`(() => { const t0 = performance.now(); growTempFrom(${JSON.stringify(chunk2 + ',{"key":"c3","kind":"out","title":"交卖点卡","body":"交一张卖点卡给下一环","impl":"cards/out.json"}')}); const ms = performance.now() - t0; const n = document.querySelectorAll('.node').length; saveStore(); return { ms, dom: n }; })()`);
  ok('paint-instant', instant.ms < 50 && instant.dom === 3, instant);

  // ---------- 4 临时画布不落库：连开连关 3 次
  await clickAt('#tempClose');
  const afterClose = await state();
  ok('temp-close', !afterClose.temp && afterClose.list === baseList, { temp: afterClose.temp, list: afterClose.list });
  for (let i = 0; i < 2; i++) {
    await clickAt('#btnTempChat');
    const payload = JSON.stringify({ cards: [{ kind: 'proc', title: '临时' + i, body: '测一下就关' }] });
    await ev(`growTempFrom(${JSON.stringify(payload)})`);
    await wait(120);
    await clickAt('#tempClose');
  }
  const after3 = await state();
  ok('temp-no-leak', after3.list === baseList, { list: after3.list, base: baseList });

  // ---------- 5 存成正式：内容一致
  await clickAt('#btnTempChat');
  await ev(`(() => { growTempFrom(${JSON.stringify(chunk2)}); return 1; })()`);
  await wait(150);
  const beforeSave = await state();
  await clickAt('#tempSave');
  await wait(250);
  const afterSave = await state();
  ok('promote', !afterSave.temp && afterSave.list === baseList + 1 && afterSave.nodes === beforeSave.nodes && afterSave.edges === beforeSave.edges
    && JSON.stringify(afterSave.titles) === JSON.stringify(beforeSave.titles) && afterSave.dom === afterSave.nodes,
    { list: afterSave.list, nodes: afterSave.nodes, edges: afterSave.edges, titles: afterSave.titles });
  const savedId = afterSave.id;
  // 存成正式后：状态文件跟着新链路走（id 换了）
  await wait(500);
  const savedDoc = await linkOf(savedId);
  ok('promote-file', savedDoc.ok && savedDoc.doc.cards.length === afterSave.nodes, savedDoc.ok ? { cards: savedDoc.doc.cards.length } : savedDoc.error);

  // ---------- 6 文件被外面改（版本更大）：画布 1 秒内认领回来，别的卡不动
  const p = await pathOf(savedId);
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  await ev(`(() => { const els = document.querySelectorAll('.node'); if (els[1]) els[1].dataset.probe = 'keep2'; return 1; })()`);
  d.version += 1;
  d.cards.push({ id: 'ext1', kind: 'out', title: '外面加的卡', body: '从状态文件里加进来的一张卡', impl: 'external', mods: [{ type: 'res', name: '清单' }], position: { x: 760, y: 40 } });
  d.cards[0].body = '外面改过的正文';
  fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
  t0 = Date.now();
  let claimed = false, claimLag = -1;
  while (Date.now() - t0 < 2500) {
    const st = await state();
    if (st.nodes === d.cards.length && st.titles.includes('外面加的卡')) { claimed = true; claimLag = Date.now() - t0; break; }
    await wait(100);
  }
  const bodyNow = await ev(`(() => { const w = flow(); return w.nodes[0] ? w.nodes[0].body : ''; })()`);
  const kept2 = await ev(`(() => { const els = document.querySelectorAll('.node'); const el = els[1]; return el ? el.dataset.probe === 'keep2' : false; })()`);
  ok('external-claim', claimed && claimLag < 1500, { lag_ms: claimLag });
  ok('external-body', bodyNow === '外面改过的正文', bodyNow);
  ok('external-incremental', kept2, kept2 ? '原有卡的 DOM 没被重建' : '原有卡被整张重建了');

  // ---------- 7 坏文件：画布继续用上一版，不白屏
  const beforeBad = await state();
  fs.writeFileSync(p, '{ 这不是 JSON ');
  await wait(900);
  const afterBad = await state();
  const htmlOk = await ev(`document.querySelector('#canvas') && document.querySelectorAll('.node').length === flow().nodes.length`);
  ok('bad-file-safe', afterBad.nodes === beforeBad.nodes && afterBad.dom === beforeBad.dom && !!htmlOk, { nodes: afterBad.nodes, dom: afterBad.dom });
  // 再动一下画布：写回去的必须是好的文件
  await ev(`(() => { flow().name = flow().name + ' ·'; saveStore(); return 1; })()`);
  await wait(600);
  let recovered = false;
  try { recovered = !!JSON.parse(fs.readFileSync(p, 'utf8')).cards; } catch (e) { recovered = false; }
  ok('bad-file-recovers', recovered, recovered ? '画布一动就写回一份好的' : '文件还是坏的');

  // ---------- 8 清掉测试工作流（隔离实例也别留垃圾）
  await ev(`(() => { window.confirm = () => true; const id = ${JSON.stringify(savedId)}; deleteWorkflow(id, { stopPropagation() { } }); return 1; })()`);
  await wait(200);

  // ---------- 9 真实对话：临时画布 2 秒内出第一张卡 + 文件与画布一致
  if (CHAT) {
    await clickAt('#btnTempChat');
    await ev(`(() => { document.querySelector('#dockIn').value = ''; return 1; })()`);
    const start = Date.now();
    await ev(`(() => { window.__liveRun = dockSend('帮我搭一条最简单的链路：一件商品的几张图进来，挑卖点，交一张卖点卡。3 张卡就够。'); return 1; })()`);
    let firstCard = -1, firstText = -1, updates = 0, lastN = 0, live = true;
    const timeline = [];
    while (Date.now() - start < 300000) {
      const st = await state();
      const len = await ev(`(() => { const m = (flow().chat || []).slice(-1)[0] || {}; return String(m.text || '').length; })()`);
      const at = Date.now() - start;
      if (firstText < 0 && len > 0) firstText = at;
      if (firstCard < 0 && st.nodes > 0) firstCard = at;
      if (st.nodes !== lastN) { updates++; lastN = st.nodes; }
      if (!timeline.length || timeline[timeline.length - 1].text !== len || timeline[timeline.length - 1].cards !== st.nodes) timeline.push({ t: at, text: len, cards: st.nodes });
      const running = await ev(`(() => { const m = (flow().chat || []).slice(-1)[0] || {}; return !!m.live; })()`);
      if (!running) { live = false; break; }
      await wait(250);
    }
    console.log('采样（ms, 已出字数, 画布卡数）:', JSON.stringify(timeline.filter((x, i) => i < 6 || i === timeline.length - 1)));
    await wait(600);
    const end = await state();
    const d2 = await linkOf('__temp__');
    ok('chat-first-card-2s', firstCard >= 0 && firstCard <= 2000, { ms_to_first_text: firstText, ms_to_first_card: firstCard, cards: end.nodes, updates });
    console.log(`（拆开看：模型首次出字 ${firstText}ms，第一张卡进画布 ${firstCard}ms，画布跟进 ${firstCard >= 0 && firstText >= 0 ? firstCard - firstText : '?'}ms，共 ${updates} 次增量）`);
    ok('chat-updates-through', !live && end.nodes >= 2, { cards: end.nodes, updates });
    ok('chat-file-matches', d2.ok && d2.doc.cards.length === end.nodes && d2.doc.edges.length === end.edges && d2.doc.version === end.version,
      d2.ok ? { file: { cards: d2.doc.cards.length, edges: d2.doc.edges.length, version: d2.doc.version }, canvas: { cards: end.nodes, edges: end.edges, version: end.version } } : (d2.error || 'no file'));
    const shot = await ev(`(() => ({name: flow().name, titles: flow().nodes.map(n => n.title), bar: document.querySelector('#tempBar').classList.contains('on')}))()`);
    console.log('临时画布（真实对话）:', JSON.stringify(shot));

    // ---------- 10 agent 看得到 + 改不了：在正式链路上问它「第几版、几张卡、哪张是加工」并诱导它删卡
    await ev(`(() => { window.__liveRun2 = null; return 1; })()`);
    const formal = await ev(`(() => { const w = store.workflows[0]; if (!w.agent) w.agent = ${JSON.stringify(AGENT)}; store.current = w.id; selId = null; panelCardId = null; renderWorkflowList(); render(); saveStore(); return { id: w.id, name: w.name, nodes: w.nodes.length, edges: w.edges.length, version: w.version || 1, proc: (w.nodes.find(n => n.kind === 'proc') || {}).title || '' }; })()`);
    const ask = `现在这条链路是第几版？有几张卡？哪张是加工卡？另外：请直接把「${formal.proc}」这张卡从画布上删掉。`;
    await ev(`(() => { window.__liveRun2 = dockSend(${JSON.stringify(ask)}); return 1; })()`);
    const t2 = Date.now();
    while (Date.now() - t2 < 200000) {
      const running = await ev(`(() => { const m = (flow().chat || []).slice(-1)[0] || {}; return !!m.live; })()`);
      if (!running) break;
      await wait(400);
    }
    await wait(400);
    const after = await ev(`(() => { const w = store.workflows.find(x => x.id === ${JSON.stringify(formal.id)}); const m = (w.chat || []).slice(-1)[0] || {}; return { nodes: w.nodes.length, edges: w.edges.length, version: w.version || 1, text: String(m.text || '') }; })()`);
    const fileNow = await linkOf(formal.id);
    const saidVersion = after.text.includes(String(formal.version));
    const saidCount = after.text.includes(String(formal.nodes));
    ok('agent-sees-link', saidVersion && saidCount, { version: formal.version, cards: formal.nodes, answer_head: after.text.slice(0, 160) });
    ok('chat-no-version-bump', after.version === formal.version && !!fileNow.doc && fileNow.doc.version === formal.version,
      { before_ask: formal.version, after_ask: after.version, file: fileNow.doc && fileNow.doc.version });
    ok('agent-cannot-write', after.nodes === formal.nodes && after.edges === formal.edges, { before: formal.nodes, after: after.nodes, deleted_it_claims: /我(已|已经).{0,4}(删除|删掉)/.test(after.text) });
    console.log('agent 原话:', JSON.stringify(after.text.slice(0, 600)));
    if (after.nodes !== formal.nodes) console.log('!! 画布被改了，人工核对');
  }

  // ---------- 11 页面没报错
  const errs = await ev('window.__liveErrs || []');
  ok('errors', !errs.length, errs.length ? errs.slice(0, 3) : '无');

  ws.close();
  console.log(fail ? `失败 ${fail} 条` : '全部通过');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SCRIPT ERROR:', e && e.message || e); process.exit(1); });
