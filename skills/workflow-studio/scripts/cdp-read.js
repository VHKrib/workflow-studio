// 「读取 agent 链路」端到端验收（真鼠标点、真 agent 分析）。对着隔离实例跑：
//   CDP_PORT=9333 node skills/workflow-studio/scripts/cdp-read.js [--agent sellpoint] [--switch creatoroutreach] [--shots DIR]
// 期望全部 PASS：
//   open    顶栏按钮打开读取窗；左边按部门列出 agent
//   read    点一个 agent：读到干的活 / 技能 / 谁派活 / 交给谁
//   stream  分析是流式的：卡片在预览里一张张冒出来；平台主管只拿到待办清单（-t todo,no_mcp），一次别的工具都没调
//   plan    拆出的卡输入、加工、输出都有，每张都有正文；预览格子数 = 卡数
//   place   点「放进画布」：新建一条工作流，卡和连线数对得上，执行方 = 被读的 agent，卡片不重叠、整条都在视口里
//   arrive  落地动画跑完收干净（没有残留的飞行卡、光点）
//   switch  （给了 --switch）分析中途换 agent：旧的那次作废，结果只属于新选的
//   esc     Esc 关窗并取消
//   errors  全程页面没有抛错
const http = require('http');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt('port', process.env.CDP_PORT || 9222));
const AGENT = opt('agent', 'sellpoint');
const SWITCH = opt('switch', '');
const SHOTS = opt('shots', '');
const get = u => new Promise((res, rej) => http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const t = (await get(`http://127.0.0.1:${PORT}/json/list`)).find(x => x.type === 'page');
  if (!t) { console.error('no page target on ' + PORT); process.exit(1); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const errors = [];
  const send = (m, q = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: q })); });
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
  });
  await new Promise(r => ws.addEventListener('open', r));
  await send('Runtime.enable');
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result.value;
  };
  const J = async expr => JSON.parse(await ev(expr));
  const click = async sel => {
    const p = await J(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'null'; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return JSON.stringify([r.left + r.width / 2, r.top + r.height / 2]); })()`);
    if (!p) throw new Error('点不到 ' + sel);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p[0], y: p[1], button: 'none', buttons: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p[0], y: p[1], button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p[0], y: p[1], button: 'left', buttons: 0, clickCount: 1 });
  };
  const shot = async name => {
    if (!SHOTS) return;
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(SHOTS, { recursive: true });
    const f = path.join(SHOTS, name + '.png');
    fs.writeFileSync(f, Buffer.from(s.data, 'base64'));
    console.log('shot    ' + f);
  };
  let fails = 0;
  const pass = (name, ok, detail) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(7)} ${detail}`); };
  const ours = `(a => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition))`;

  await wait(300);
  const before = await J(`JSON.stringify({ flows: store.workflows.length, cur: store.current })`);

  // ---------- open ----------
  await click('#btnRead');
  await wait(300);
  const o = await J(`JSON.stringify({ on: document.querySelector('#readModal').classList.contains('on'), groups: [...document.querySelectorAll('#rPick .rgl')].map(e => e.textContent), items: document.querySelectorAll('#rPick .ritem').length,
    has: !!document.querySelector('#rPick .ritem[data-id="${AGENT}"]') })`);
  pass('open', o.on && o.items > 3 && o.has, `读取窗 ${o.on}，${o.items} 个 agent，分组：${o.groups.join(' / ')}`);
  // 版面：窗口不出屏、左右两栏各自滚、正文不横向溢出
  const lay = await J(`(() => { const b = document.querySelector('#readModal .rbox').getBoundingClientRect(), m = document.querySelector('#rMain'), pk = document.querySelector('#rPick');
    return JSON.stringify({ inWin: b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight, size: [Math.round(b.width), Math.round(b.height)],
      pickScroll: getComputedStyle(pk).overflowY, mainX: m.scrollWidth - m.clientWidth }); })()`);
  pass('layout', lay.inWin && lay.pickScroll === 'auto' && lay.mainX <= 1, `读取窗 ${lay.size.join('×')}，在窗口里 ${lay.inWin}，左栏可滚 ${lay.pickScroll}，正文横向溢出 ${lay.mainX}px`);

  // ---------- switch（可选）：先选 SWITCH 的对立面，分析开始后立刻换成 AGENT ----------
  let first = AGENT;
  if (SWITCH) {
    first = SWITCH;
    await click(`#rPick .ritem[data-id="${SWITCH}"]`);
    for (let i = 0; i < 40; i++) { await wait(250); if (await ev(`rd.busy`)) break; }
    await wait(1500);
  }
  // ---------- read ----------
  await click(`#rPick .ritem[data-id="${AGENT}"]`);
  let rs = null;
  for (let i = 0; i < 40; i++) { await wait(250); rs = await J(`JSON.stringify({ chain: rd.chain && rd.chain.id, busy: rd.busy })`); if (rs.chain === AGENT) break; }
  const sum = await J(`JSON.stringify({ name: (document.querySelector('.rhead b') || {}).textContent, rows: [...document.querySelectorAll('.rrow')].map(r => [r.querySelector('.rk').textContent, r.querySelectorAll('.rtask, .rp').length]),
    tasks: rd.chain.tasks.length, skills: rd.chain.skills.filter(s => s.used).length, up: rd.chain.upstream.map(x => x.name), down: rd.chain.downstream.map(x => x.name) })`);
  pass('read', rs.chain === AGENT && sum.rows.length === 4 && sum.tasks > 0,
    `「${sum.name}」：${sum.rows.map(([k, n]) => k + ' ' + n).join('，')}；派活：${sum.up.join('、') || '—'}；交给：${sum.down.join('、') || '—'}`);

  // ---------- stream：每 0.5s 看一次预览里冒出来的卡 ----------
  const counts = []; let maxWait = 300, shotWait = false, shotStream = false;   // 最多 150s（两次分析）
  while (maxWait--) {
    await wait(500);
    const s = await J(`JSON.stringify({ busy: rd.busy, tiles: document.querySelectorAll('#rPrev .rtile').length, plan: !!rd.plan, err: rd.error, since: !!document.querySelector('#rLog [data-since]') })`);
    if (counts[counts.length - 1] !== s.tiles) counts.push(s.tiles);
    if (s.since && !shotWait) { shotWait = true; await shot('1-waiting'); }
    if (s.tiles >= 3 && !shotStream) { shotStream = true; await shot('2-streaming'); }
    if (!s.busy) break;
  }
  const st = await J(`JSON.stringify({ steps: rd.msgs.reduce((n, m) => n + ((m.steps || []).length), 0), tools: rd.msgs.flatMap(m => (m.steps || []).map(x => x.name)), msgs: rd.msgs.map(m => (m.text || '').slice(0, 60)),
    toolsets: READ_TOOLSETS })`);
  const grew = counts.filter(n => n > 0);
  // 分析用的平台主管只拿得到待办清单：工具组必须是 todo + 关掉 MCP，而且这次真的一个别的工具都没调
  pass('stream', grew.length >= 2 && !st.tools.filter(n => n !== 'todo_list').length && st.toolsets === 'todo,no_mcp',
    `预览里的卡 ${counts.join(' → ')}；工具组 ${st.toolsets}；平台主管调用工具 ${st.tools.length ? st.tools.join(',') : '0 次'}；消息：${st.msgs.map(x => '「' + x.replace(/\n/g, ' ') + '」').join(' ')}`);

  // ---------- plan ----------
  const pl = await J(`JSON.stringify(rd.plan ? { n: rd.plan.cards.length, e: rd.plan.edges.length, kinds: rd.plan.cards.map(c => c.kind).join(''), empty: rd.plan.cards.filter(c => !c.body).length,
    tiles: document.querySelectorAll('#rPrev .rtile').length, name: rd.plan.name, cards: rd.plan.cards.map(c => '[' + c.kind + ']' + c.title + '{' + c.mods.map(m => m.name).join('/') + '}') } : { err: rd.error })`);
  if (pl.err !== undefined) { pass('plan', false, '没拆出来：' + pl.err); }
  else  pass('plan', /in/.test(pl.kinds) && /proc/.test(pl.kinds) && /out/.test(pl.kinds) && !pl.empty && pl.tiles === pl.n,
    `「${pl.name}」${pl.n} 张卡 / ${pl.e} 条线，预览 ${pl.tiles} 格：${pl.cards.join(' ')}`);
  if (pl.err === undefined) {
    const px = await J(`(() => { const m = document.querySelector('#rMain'); return JSON.stringify({ mainX: m.scrollWidth - m.clientWidth,
      cols: [...document.querySelectorAll('#rPrev .rcol')].map(c => Math.round(c.getBoundingClientRect().width)) }); })()`);
    if (px.mainX > 1) pass('layout', false, `预览出来后正文横向溢出 ${px.mainX}px（三栏宽 ${px.cols.join('/')}）`);
  }
  if (SWITCH) {
    const sw = await J(`JSON.stringify({ chain: rd.chain.id, pick: rd.pick, msgs: rd.msgs.length, other: rd.msgs.some(m => (m.text || '').includes(${JSON.stringify(SWITCH)})) })`);
    pass('switch', sw.chain === AGENT && sw.pick === AGENT && !sw.other, `先选 ${first} 开始分析、中途换成 ${AGENT}：结果属于 ${sw.chain}，日志 ${sw.msgs} 条`);
  }
  await shot('3-preview');

  // ---------- place ----------
  if (pl.err === undefined) {
    await click('#rPlace');
    await wait(120);
    const fly = await J(`JSON.stringify({ flyers: document.querySelectorAll('.node.arriving').length, anims: document.getAnimations().filter(${ours}).length })`);
    await wait(500);
    await shot('4-arriving');
    await wait(2600);
    const pc = await J(`(() => { const w = flow();
      const boxes = w.nodes.map(n => { const e = document.querySelector('.node[data-id="' + n.id + '"]').getBoundingClientRect(); return [e.left, e.top, e.right, e.bottom]; });
      let ov = 0; for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i], b = boxes[j]; if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) ov++; }
      const vw = wrap.getBoundingClientRect();
      const out = boxes.filter(b => b[0] < vw.left - 1 || b[2] > vw.right + 1 || b[1] < vw.top - 1 || b[3] > vw.bottom + 1).length;
      const dk = document.querySelector('#dock'), dr = dockOpen && dk ? dk.getBoundingClientRect() : null;
      const under = dr ? boxes.filter(b => b[0] < dr.right && dr.left < b[2] && b[1] < dr.bottom && dr.top < b[3]).length : 0;
      return JSON.stringify({ flows: store.workflows.length, name: w.name, agent: w.agent, src: w.source && w.source.agent, nodes: w.nodes.length, edges: w.edges.length,
        drawn: document.querySelectorAll('#edges path.edge').length, ov, out, under, zoom, dock: dockOpen, modal: document.querySelector('#readModal').classList.contains('on'),
        chat: (w.chat || []).length, mods: w.nodes.reduce((s, n) => s + (n.mods || []).length, 0) }); })()`);
    // 卡片绝不压在对话框底下（放不下就把对话框收成药丸）；只有缩到下限 0.4 还放不下时，才允许有卡在视口外
    pass('place', pc.flows === before.flows + 1 && pc.nodes === pl.n && pc.edges === pl.e && pc.drawn === pl.e && pc.agent === AGENT && pc.src === AGENT && !pc.ov && !pc.under && (!pc.out || pc.zoom <= 0.4) && !pc.modal,
      `新工作流「${pc.name}」：${pc.nodes} 卡 / ${pc.edges} 线（画出 ${pc.drawn}），${pc.mods} 个模块，执行方 ${pc.agent}，重叠 ${pc.ov}，视口外 ${pc.out}，压在对话框下 ${pc.under}，缩放 ${pc.zoom}，对话框 ${pc.dock ? '开着' : '收成药丸'}`);
    const ar = await J(`JSON.stringify({ flyers: document.querySelectorAll('.node.arriving').length, fx: document.querySelectorAll('#fx *').length, anims: document.getAnimations().filter(${ours}).length,
      hidden: [...document.querySelectorAll('.node')].filter(e => e.style.opacity === '0').length, dash: [...document.querySelectorAll('#edges path.edge')].filter(p => p.style.strokeDasharray).length })`);
    pass('arrive', fly.flyers > 0 && fly.anims > 0 && !ar.flyers && !ar.fx && !ar.anims && !ar.hidden && !ar.dash,
      `落地时飞行卡 ${fly.flyers} 张、动画 ${fly.anims} 个 → 3s 后残留：飞行卡 ${ar.flyers}、光点 ${ar.fx}、动画 ${ar.anims}、隐身卡 ${ar.hidden}、没画完的线 ${ar.dash}`);
    await shot('5-placed');
  }

  // ---------- esc ----------
  await click('#btnRead');
  await wait(250);
  await click(`#rPick .ritem[data-id="${AGENT}"]`);
  await wait(1200);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait(400);
  const es = await J(`JSON.stringify({ on: document.querySelector('#readModal').classList.contains('on'), busy: rd.busy, runId: rd.runId, sel: selId })`);
  pass('esc', !es.on && !es.busy && !es.runId, `Esc 后读取窗 ${es.on ? '还开着' : '关了'}，分析 ${es.busy ? '还在跑' : '已取消'}`);

  pass('errors', errors.length === 0, errors.length ? errors.slice(0, 3).join(' | ') : '页面没有抛错');
  ws.close(); process.exit(fails ? 2 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
