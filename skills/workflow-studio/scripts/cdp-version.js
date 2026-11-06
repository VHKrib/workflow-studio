// 版本与回滚自检：5 次改动 5 版 / 连续改动并成一版 / 只留 20 版 / 回滚把整条链路带回去 /
// 回滚也算新的一版（回得去、也再回得来）/ 回滚后 agent 第一句带版本 / 拖动位置不出新版本。
//
//   export CDP_PORT=9333                       # 隔离实例（见 SKILL.md「启动与验证」）
//   node skills/workflow-studio/scripts/cdp-version.js              # 不花钱：不调 agent
//   node skills/workflow-studio/scripts/cdp-version.js --chat       # 再加一次真实调用：回滚后 agent 复述版本
//   node skills/workflow-studio/scripts/cdp-version.js --fake       # 实例用 WF_CHAT_FAKE=hang 起：验「跑着的时候回滚，运行被停掉」
//
// 它只在自己新建的测试链路上动（结束时删掉、并切回原来那条），不碰现有链路的卡片正文与对话。
const http = require('http');

const argv = process.argv.slice(2);
const has = n => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt('port', process.env.CDP_PORT || 9222));
const CHAT = has('chat');        // 真调一次 agent（回滚后它要能复述版本）
const FAKE = has('fake');        // 实例是 WF_CHAT_FAKE=hang 起的：验「对话跑着的时候回滚」

const get = u => new Promise((res, rej) => http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const t = (await get(`http://127.0.0.1:${PORT}/json/list`)).find(x => x.type === 'page');
  if (!t) { console.error('no page target on ' + PORT); process.exit(1); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, q = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: q })); });
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  await new Promise(r => ws.addEventListener('open', r));

  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) throw new Error(String((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text).split('\n').slice(0, 4).join(' | '));
    return r.result ? r.result.value : undefined;
  };
  const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  let fail = 0;
  const ok = (name, cond, detail) => {
    if (!cond) fail++;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name.padEnd(26)} ${detail == null ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail))}`);
  };

  await wait(300);
  // 页面里的错误统一记账，最后断言一条都没有
  await ev(`(() => { if (!window.__verErrs) { window.__verErrs = []; addEventListener('error', e => window.__verErrs.push(String(e.message || e))); } return 1; })()`);

  const orig = await ev(`(() => ({ id: store.current, ids: store.workflows.map(w => w.id) }))()`);

  // 一条测试链路：3 张卡 + 2 条线 + 模块，位置摆开（拖卡测试用得到）
  const mk = async name => ev(`(() => {
    const w = createWorkflow(${JSON.stringify(name)});
    const a = addNode('in',   { title: '素材包', body: '主图 5 张 + 页面标题', mods: [{ id: uid(), type: 'mat', name: '主图' }], x: 0, y: 0 }, false);
    const b = addNode('proc', { title: '挑卖点', body: '按同类商品比，挑 3 条卖点', mods: [{ id: uid(), type: 'tool', name: '比对' }], x: 600, y: 0 }, false);
    const c = addNode('out',  { title: '卖点卡', body: '交一张卖点卡', mods: [{ id: uid(), type: 'res', name: '清单' }], x: 1200, y: 0 }, false);
    connect(a.id, b.id, false); connect(b.id, c.id, false);
    saveStore();
    return { id: w.id, nodes: [a.id, b.id, c.id] };
  })()`);
  const vinfo = () => ev(`(() => { const w = flow(); return { id: w.id, v: w.version || 1, n: (VER.list[w.id] || []).length, rows: (VER.list[w.id] || []).map(e => [e.v, e.what, e.by]), sig: (VER.list[w.id] || []).map(e => e.v).join(',') }; })()`);
  const drop = async wid => {
    await ev(`(() => { window.confirm = () => true; deleteWorkflow(${JSON.stringify(wid)}, { stopPropagation() { } }); return 1; })()`);
    await wait(150);
  };

  // ---------- 0 页面在
  ok('open', await ev(`typeof rollbackTo === 'function' && !!document.querySelector('#panelTab') && !!window.tcflow.versionList`), '回滚与版本接口都在');

  // ---------- 1 连改 5 次 = 5 版（不是 50 版）
  const f1 = await mk('版本测试 · 五改');
  await wait(500);
  const b1 = await vinfo();
  for (let i = 1; i <= 5; i++) {
    await ev(`(() => { const w = flow(); w.nodes[1].body = ${JSON.stringify('第 ' + i + ' 次改的加工方式')}; saveStore(); return 1; })()`);
    await wait(620);
  }
  const a1 = await vinfo();
  const file1 = await ev(`(async () => { const r = await window.tcflow.versionList(flow().id); return { n: r.list.length, path: r.path }; })()`);
  ok('ver-5-edits', a1.n === b1.n + 5 && a1.v === b1.v + 5 && file1.n === a1.n,
    { '改5次前': b1.n, '之后': a1.n, '版本号': [b1.v, a1.v], '文件里': file1.n, '最近一行': a1.rows[a1.rows.length - 1] });

  // ---------- 2 连续改动并成一版（打字 / 连着加卡+连线不刷爆版本）
  const b2 = await vinfo();
  for (let i = 1; i <= 6; i++) {
    await ev(`(() => { const w = flow(); w.nodes[2].body = ${JSON.stringify('连打 ' + i)}; saveStore(); return 1; })()`);
    await wait(45);
  }
  await wait(700);
  const a2 = await vinfo();
  ok('ver-coalesce', a2.n === b2.n + 1, { 六次快改: b2.n, 之后: a2.n, 版本号: [b2.v, a2.v] });

  // ---------- 3 拖动位置不出新版本（真鼠标拖三次加工卡：位置变、版本条数不变）
  const b3 = await vinfo();
  const dragOne = async (dx, dy) => {
    await ev(`(() => { zoom = 1; applyZoom(); drawEdges(); const n = flow().nodes[1]; const el = document.querySelector('.node[data-id="' + n.id + '"]'); wrap.scrollLeft = (n.x + ORIGIN.x + el.offsetWidth / 2) - wrap.clientWidth / 2; wrap.scrollTop = (n.y + ORIGIN.y + el.offsetHeight / 2) - wrap.clientHeight / 2; return 1; })()`);
    await wait(250);
    const d = await ev(`(() => { const n = flow().nodes[1]; const el = document.querySelector('.node[data-id="' + n.id + '"]'); const r = el.querySelector('.body').getBoundingClientRect(); return { id: n.id, x0: Math.round(n.x), y0: Math.round(n.y), sx: Math.round(r.left + 22), sy: Math.round(r.top + 12) }; })()`);
    await mouse('mousePressed', d.sx, d.sy);
    await mouse('mouseMoved', d.sx + dx / 2, d.sy + dy / 2);
    await mouse('mouseMoved', d.sx + dx, d.sy + dy);
    await mouse('mouseReleased', d.sx + dx, d.sy + dy);
    await wait(420);
    return ev(`(() => { const n = find(${JSON.stringify(d.id)}); return { dx: Math.round(n.x - ${d.x0}), dy: Math.round(n.y - ${d.y0}) }; })()`);
  };
  const m1 = await dragOne(60, 40), m2 = await dragOne(-40, 30), m3 = await dragOne(30, -50);
  await wait(700);
  const a3 = await vinfo();
  ok('ver-drag-no-version', a3.n === b3.n && (m1.dx || m1.dy) && (m2.dx || m2.dy) && (m3.dx || m3.dy),
    { 拖三次位移: [m1, m2, m3], 版本条数: [b3.n, a3.n] });
  await drop(f1.id);
  const gone = await ev(`(async () => { const r = await window.tcflow.versionList(${JSON.stringify(f1.id)}); return r.list.length; })()`);
  ok('ver-drop-with-workflow', gone === 0, { 删掉链路后剩下的版本条数: gone });

  // ---------- 4 只留 20 版：造 25 次改动，最早的 5 版被挤掉
  const f2 = await mk('版本测试 · 封顶');
  await wait(500);
  for (let i = 1; i <= 25; i++) {
    await ev(`(() => { const w = flow(); w.nodes[1].body = ${JSON.stringify('封顶测试 ' + i)}; saveStore(); return 1; })()`);
    await wait(430);
  }
  const a4 = await vinfo();
  const file4 = await ev(`(async () => { const r = await window.tcflow.versionList(flow().id); return { n: r.list.length, first: r.list[0].v, last: r.list[r.list.length - 1].v }; })()`);
  const nums4 = file4.last - file4.first + 1;
  ok('ver-cap-20', file4.n === 20 && a4.n === 20 && nums4 === 20 && file4.last === a4.v,
    { 列表条数: file4.n, 版本号区间: [file4.first, file4.last], 连续: nums4, 画布版本: a4.v });

  // 概览里的版本列表（控制台）：一条一行，最多 20 行
  const rowsDom = await ev(`(() => { panelOpen = true; panelCardId = null; render(); const rows = [...document.querySelectorAll('#verList .verrow')]; return { n: rows.length, head: document.querySelector('.verhd .vn') ? document.querySelector('.verhd .vn').textContent : '', sample: rows.slice(0, 3).map(r => r.textContent.replace(/\\s+/g, ' ').trim()) }; })()`);
  ok('ver-console-list', rowsDom.n === 20 && /^v\d+/.test(rowsDom.sample[0] || ''),
    { 行数: rowsDom.n, 表头: rowsDom.head, 前三行: rowsDom.sample });
  await drop(f2.id);

  // ---------- 5 回滚生效：卡片 / 连线 / 模块 / 正文 / 内部实现 / 执行方，一个不漏
  const f3 = await mk('版本测试 · 回滚');
  await wait(500);
  await ev(`(() => { const w = flow(); w.nodes[1].body = '基线：按同类商品比，挑 3 条卖点'; w.nodes[1].impl = 'cards/a.json'; w.agent = agents[0] ? agents[0].id : ''; saveStore(); return 1; })()`);
  await wait(650);
  const base = await ev(`(() => { const w = flow(); return { v: w.version, sig: verContent(verSnapshot(w)), snap: verSnapshot(w) }; })()`);
  // 改坏：正文、模块、加一张卡、加一条线、换执行方
  await ev(`(() => {
    const w = flow();
    w.nodes[1].body = '改坏了的加工方式';
    w.nodes[1].mods = [{ id: uid(), type: 'tool', name: '乱改' }];
    w.agent = (agents[1] && agents[1].id) || '';
    const d = addNode('proc', { title: '多出来的卡', body: '这一版多的一张', x: 600, y: 320 }, false);
    connect(w.nodes[2].id, d.id, false);
    saveStore();
    return 1;
  })()`);
  await wait(700);
  const changed = await ev(`(() => { const w = flow(); return { v: w.version, sig: verContent(verSnapshot(w)), cards: w.nodes.map(n => n.title) }; })()`);
  const rolled = await ev(`(() => { const ok = rollbackTo(${JSON.stringify(base.v)}); return { ok, v: flow().version }; })()`);
  await wait(500);
  const after = await ev(`(() => {
    const w = flow();
    return { v: w.version, sig: verContent(verSnapshot(w)), snap: verSnapshot(w),
      cards: w.nodes.map(n => n.title), edges: w.edges.length, agent: w.agent,
      mods: w.nodes.map(n => n.mods.map(m => m.name)), impl: w.nodes[1].impl,
      rollback: w.rollback || null, rows: (VER.list[w.id] || []).map(e => [e.v, e.what]) };
  })()`);
  ok('ver-rollback-restores',
    rolled.ok && after.sig === base.sig && after.snap.cards.length === base.snap.cards.length && after.edges === base.snap.edges.length
    && after.agent === base.snap.agent && JSON.stringify(after.mods) === JSON.stringify(base.snap.cards.map(c => c.mods.map(m => m.name)))
    && after.impl === 'cards/a.json',
    { 回滚到: base.v, 现在版本: after.v, 卡片: after.cards, 连线: after.edges, 执行方一致: after.agent === base.snap.agent, 模块: after.mods, 内部实现: after.impl, 内容一致: after.sig === base.sig });

  // ---------- 6 回滚也算新的一版（不删后面的版本），点它回到回滚前
  const rbRow = after.rows[after.rows.length - 1];
  ok('ver-rollback-new-version', after.v === changed.v + 1 && rbRow[0] === after.v && rbRow[1] === `回滚到 v${base.v}`,
    { 回滚前: changed.v, 回滚后: after.v, 最新一行: rbRow, 行数: after.rows.length });
  const fwd = await ev(`(() => { const ok = rollbackTo(${JSON.stringify(changed.v)}); const w = flow(); return { ok, v: w.version, sig: verContent(verSnapshot(w)), cards: w.nodes.map(n => n.title) }; })()`);
  await wait(400);
  ok('ver-roll-forward', fwd.ok && fwd.sig === changed.sig, { 回到: changed.v, 现在版本: fwd.v, 卡片: fwd.cards, 内容一致: fwd.sig === changed.sig });

  // ---------- 7 回滚后 agent 第一句带版本：先看提示词，再（可选）真问一次
  await ev(`(() => { rollbackTo(${JSON.stringify(base.v)}); return 1; })()`);
  await wait(400);
  const prompt = await ev(`(() => { const w = flow(); return { head: buildChatPrompt(w.nodes[0], '现在第几版？').split('\\n')[0], dockHead: dockPrompt('现在第几版？').split('\\n')[0], v: w.version, to: (w.rollback || {}).to }; })()`);
  ok('ver-agent-prompt', prompt.head.startsWith('【版本状态') && prompt.head.includes(`当前链路版本 v${prompt.v}`) && prompt.head.includes(`回滚到了 v${prompt.to}`) && prompt.head.includes('之后的改动已作废'),
    prompt);
  if (CHAT) {
    const ask = await ev(`(async () => {
      const w = flow();
      const before = { nodes: w.nodes.length, edges: w.edges.length, v: w.version };
      await dockSend('现在这条链路是第几版？刚才回滚到第几版？只回答这两个事实，一行一条。');
      const m = (flow().chat || []).slice(-1)[0] || {};
      return { before, answer: String(m.text || '').slice(0, 400), after: { nodes: flow().nodes.length, edges: flow().edges.length, v: flow().version } };
    })()`);
    const hitV = ask.answer.includes(String(ask.before.v)) && ask.answer.includes(`v${prompt.to}`) || ask.answer.includes(String(prompt.to));
    ok('ver-agent-knows', hitV && ask.after.nodes === ask.before.nodes,
      { 当前版本: ask.before.v, 回滚到: prompt.to, 答: ask.answer.replace(/\n/g, ' ⏎ ').slice(0, 220) });
  } else {
    console.log('SKIP  ver-agent-knows            没加 --chat（不真调 agent）；提示词那一行上面已经验过');
  }

  // ---------- 8 对话正在跑的时候回滚：这次运行要被停掉，且不在作废链路上继续写
  if (FAKE) {
    const r8 = await ev(`(async () => {
      const w = flow();
      const before = { v: w.version, nodes: w.nodes.length, chat: (w.chat || []).length };
      dockSend('这条链路下一步该怎么改？');                       // 不 await：故意让它挂着（实例是 WF_CHAT_FAKE=hang 起的）
      await new Promise(r => setTimeout(r, 900));
      const running = [...RUNS.values()].filter(x => x.flowId === w.id);
      const stillLive = !!(flow().chat.slice(-1)[0] || {}).live;
      const target = ${base.v};                                  // 回滚到基线那一版（Node 侧算好的版本号）
      rollbackTo(target);
      await new Promise(r => setTimeout(r, 600));
      const m = (flow().chat || []).slice(-1)[0] || {};
      return { before, runsAtRollback: running.length, stillLive, runsNow: [...RUNS.values()].filter(x => x.flowId === w.id).length,
        human: String(m.human || ''), cancelled: !!m.cancelled,
        after: { v: flow().version, nodes: flow().nodes.length }, rows: (VER.list[w.id] || []).map(e => [e.v, e.what]) };
    })()`);
    const lastRow = r8.rows[r8.rows.length - 1] || [];
    ok('ver-running-stopped',
      r8.runsAtRollback === 1 && r8.stillLive && r8.runsNow === 0 && r8.cancelled && /已经停掉/.test(r8.human) && /停掉 1 个/.test(String(lastRow[1])),
      { 回滚时在跑: r8.runsAtRollback, 之后还在跑: r8.runsNow, 消息: r8.human, 取消标记: r8.cancelled, 最新一行: lastRow, 版本: r8.after.v });
  } else {
    console.log('SKIP  ver-running-stopped        没加 --fake（实例要用 WF_CHAT_FAKE=hang 起，否则会真调 agent）');
  }

  // ---------- 9 收尾：删掉测试链路、切回原来那条
  await drop(f3.id);
  await ev(`(() => { store.current = ${JSON.stringify(orig.id)}; selId = null; panelCardId = null; panelOpen = false; saveStore(false); renderWorkflowList(); render(); centerView(); return 1; })()`);
  const left = await ev(`(() => ({ list: store.workflows.map(w => w.id), verFiles: Object.keys(VER.list) }))()`);
  ok('cleanup', !left.list.includes(f1.id) && !left.list.includes(f2.id) && !left.list.includes(f3.id) && left.list.length === orig.ids.length,
    { 现在的工作流: left.list.length, 原来: orig.ids.length });

  const errs = await ev('window.__verErrs || []');
  ok('errors', !errs.length, errs.length ? errs.slice(0, 3) : '无');

  ws.close();
  console.log(fail ? `失败 ${fail} 条` : '全部通过');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SCRIPT ERROR:', e && e.message || e); process.exit(1); });
