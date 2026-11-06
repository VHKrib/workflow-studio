// 复制链路 + 选中测试｜静态体检 + 只读预演 自检
//
//   export CDP_PORT=9333                                  # 隔离实例（见 SKILL.md「启动与验证」）
//   node skills/workflow-studio/scripts/cdp-copy.js           # 不花钱：复制 / 独立 / 选中 / 体检
//   node skills/workflow-studio/scripts/cdp-copy.js --preview # 再做一次只读预演（真调执行方，一张卡一次）
//
// 只动自己新建的链路；结束时删干净、切回原来那条。不碰现有链路的卡片与对话。
const fs = require('fs');
const http = require('http');

const argv = process.argv.slice(2);
const has = n => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt('port', process.env.CDP_PORT || 9222));
const PREVIEW = has('preview');
const AGENT = opt('agent', 'default');        // 预演用哪个执行方（默认平台主管）

const get = u => new Promise((res, rej) => http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
const wait = ms => new Promise(r => setTimeout(r, ms));

let fail = 0;
const ok = (name, pass, info) => {
  if (!pass) fail++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(24)} ${info == null ? '' : (typeof info === 'string' ? info : JSON.stringify(info))}`);
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
  // 真鼠标点：走 CDP 的命中测试，按钮/列表项被别的元素挡住时会点空
  const clickAt = async (sel) => {
    const p = await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    if (!p) return false;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    return true;
  };
  const snapOf = wid => ev(`(() => {
    const w = store.workflows.find(x => x.id === ${JSON.stringify(wid)});
    if (!w) return null;
    return { id: w.id, name: w.name, agent: w.agent, cards: w.nodes.length, edges: w.edges.length,
      mods: w.nodes.reduce((s, n) => s + (n.mods || []).length, 0),
      bodies: w.nodes.map(n => n.title + '|' + n.body), ids: w.nodes.map(n => n.id), version: w.version || 1 };
  })()`);
  const linkDocOf = wid => ev(`(async () => { const r = await window.tcflow.linkRead(${JSON.stringify(wid)}); return (r && r.doc) || null; })()`);

  await wait(300);
  await ev(`(() => { if (!window.__copyErrs) { window.__copyErrs = []; addEventListener('error', e => window.__copyErrs.push(String(e.message || e))); } return 1; })()`);
  const orig = await ev(`(() => ({ id: store.current }))()`);
  ok('open', await ev(`['duplicateWorkflow','checkFlow','checkText','startPreview','clearPreviews','openTest'].every(k => typeof window[k] === 'function')`), '复制 / 体检 / 预演 / 清空的入口都在');

  // ---------- 1 造一条有内容的链路（3 卡 + 2 线 + 模块 + 执行方） ----------
  const src = await ev(`(() => {
    const w = createWorkflow('复制链路 · 原件');
    const mk = (kind, title, body, mods, x, y) => { const n = { id: uid(), kind, title, body, impl: '', mods: mods.map(m => ({ id: uid(), type: m[0], name: m[1] })), checks: [], chat: [], status: 'idle', x, y }; w.nodes.push(n); return n; };
    const a = mk('in', '素材包', '主图 5 张、详情长图 3 张，还有页面上的标题和价格。', [['mat', '主图 5 张'], ['mat', '标题·价格']], 0, 60);
    const b = mk('proc', '挑主图', '从 5 张主图里挑三张颜色和构图最接近的，按清晰度排序。', [['tool', '按颜色挑'], ['tool', '比清晰度']], 330, 60);
    const c = mk('out', '挑图清单', '一张清单：选中的三张是哪些、为什么、还缺什么。', [['res', '挑图清单']], 660, 60);
    a.impl = 'images/main/*';
    w.edges.push([a.id, b.id], [b.id, c.id]);
    w.agent = ${JSON.stringify(AGENT)};
    saveStore(); renderWorkflowList(); render();
    return { id: w.id, cards: { a: a.id, b: b.id, c: c.id } };
  })()`);
  await wait(700);
  const srcId = src.id;
  const before = await snapOf(srcId);
  ok('setup', before && before.cards === 3 && before.edges === 2 && !!before.agent,
    { 链路: srcId, 卡: before.cards, 线: before.edges, 模块: before.mods, 执行方: before.agent });

  // ---------- 2 一键复制（真鼠标点顶栏「复制链路」） ----------
  const clicked = await clickAt('#btnCopy');
  await wait(900);
  const afterBtn = await ev(`(() => ({ cur: store.current, n: store.workflows.length }))()`);
  const copyId = afterBtn.cur;
  const copy = copyId && copyId !== srcId ? await snapOf(copyId) : null;
  ok('copy-counts', !!clicked && !!copy && copy.cards === before.cards && copy.edges === before.edges && copy.mods === before.mods &&
    copy.agent === before.agent && JSON.stringify(copy.bodies) === JSON.stringify(before.bodies) && copy.ids.every(x => !before.ids.includes(x)),
    { 按钮: '#btnCopy', 卡: [before.cards, copy && copy.cards], 线: [before.edges, copy && copy.edges], 模块: [before.mods, copy && copy.mods],
      执行方: [before.agent, copy && copy.agent], 正文逐条一致: !!copy && JSON.stringify(copy.bodies) === JSON.stringify(before.bodies), 卡片id全新: !!copy && copy.ids.every(x => !before.ids.includes(x)) });
  ok('copy-name', !!copy && copy.name !== before.name && /（副本）/.test(copy.name),
    { 原件: before.name, 副本: copy && copy.name });

  // 列表里两条不重名
  const names = await ev(`store.workflows.map(w => w.name)`);
  ok('copy-name-unique', names.length === new Set(names).size, { 列表: names });

  // ---------- 3 真独立：改副本原件不变；改原件副本不变（含状态文件） ----------
  const editBody = (wid, nid, text) => ev(`(() => {
    switchWorkflow(${JSON.stringify(wid)});
    const n = find(${JSON.stringify(nid)}) || store.workflows.find(w => w.id === ${JSON.stringify(wid)}).nodes.find(x => x.title === '挑主图');
    openCard(n);
    return 1;
  })()`).then(() => ev(`(() => { const n = flow().nodes.find(x => x.title === '挑主图'); n.body = ${JSON.stringify(text)}; saveEditing({ commit: true }); return n.id; })()`));
  const copyCardId = await editBody(copyId, src.cards.b, '副本改过的加工方式：只看主图前三张的颜色。');
  await wait(600);
  const afterCopyEdit = { copy: await snapOf(copyId), src: await snapOf(srcId) };
  const copyLink = await linkDocOf(copyId), srcLink = await linkDocOf(srcId);
  const copyBodyOk = afterCopyEdit.copy.bodies[1].includes('副本改过');
  const srcUntouched = afterCopyEdit.src.bodies[1] === before.bodies[1];
  const linkCopyOk = !!copyLink && copyLink.cards.some(c => c.body.includes('副本改过'));
  const linkSrcOk = !!srcLink && !srcLink.cards.some(c => c.body.includes('副本改过'));

  await editBody(srcId, src.cards.b, '原件改过的加工方式：只看白底图。');
  await wait(600);
  const afterSrcEdit = { copy: await snapOf(copyId), src: await snapOf(srcId) };
  const copyStillOk = afterSrcEdit.copy.bodies[1].includes('副本改过');
  const srcChanged = afterSrcEdit.src.bodies[1].includes('原件改过');
  ok('copy-independent', copyBodyOk && srcUntouched && linkCopyOk && linkSrcOk && copyStillOk && srcChanged,
    { 副本改了: copyBodyOk, 原件没变: srcUntouched, 副本状态文件: linkCopyOk, 原件状态文件没变: linkSrcOk, 再改原件后副本没变: copyStillOk, 原件改了: srcChanged });

  // 版本：副本从「复制自」起记，改副本只涨副本
  const copyVer = await ev(`(() => { const w = store.workflows.find(x => x.id === ${JSON.stringify(copyId)}); return { v: w.version, rows: (VER.list[w.id] || []).map(e => [e.v, e.what]) }; })()`);
  const srcVer = await ev(`(() => { const w = store.workflows.find(x => x.id === ${JSON.stringify(srcId)}); return { v: w.version, rows: (VER.list[w.id] || []).map(e => [e.v, e.what]) }; })()`);
  ok('copy-version', copyVer.rows.length > 0 && /复制自/.test(String(copyVer.rows[0][1])) && copyVer.v !== before.version,
    { 副本版本: copyVer, 原件版本: { v: srcVer.v, 条目: srcVer.rows.length } });

  // ---------- 4 选中可见：有且只有一个「选中」，别的安静 ----------
  const sel = await ev(`(() => {
    switchWorkflow(${JSON.stringify(copyId)});
    const rows = [...document.querySelectorAll('#wfList .wf')];
    return { cur: store.current, on: rows.filter(e => e.classList.contains('on')).map(e => e.dataset.id),
      badges: rows.filter(e => e.querySelector('.wsel')).map(e => e.dataset.id),
      total: rows.length };
  })()`);
  ok('select-visible', sel.cur === copyId && sel.on.length === 1 && sel.on[0] === copyId && sel.badges.length === 1 && sel.badges[0] === copyId && sel.total >= 2,
    { 列表行: sel.total, 标on的: sel.on, 带选中徽标: sel.badges });

  // ---------- 5 选中记得住：重载页面（等于关掉窗口重开），选中还是那一条 ----------
  await ev(`location.reload(); 1`);
  let booted = false;
  for (let i = 0; i < 40; i++) {
    await wait(250);
    try { if (await ev(`!!(typeof store !== 'undefined' && store.workflows && store.workflows.length && document.querySelectorAll('#wfList .wf').length)`)) { booted = true; break; } } catch (e) { }
  }
  const persisted = booted ? await ev(`(() => { const rows = [...document.querySelectorAll('#wfList .wf')]; const on = rows.filter(e => e.classList.contains('on')); return { cur: store.current, on: on.map(e => e.dataset.id), badge: on.length === 1 ? on[0].querySelector('.wsel') ? 1 : 0 : 0 }; })()`) : null;
  ok('select-persist', !!persisted && persisted.cur === copyId && persisted.on.length === 1 && persisted.on[0] === copyId && persisted.badge === 1,
    persisted ? { 重开后选中: persisted.cur, 标on的: persisted.on } : '页面没有重新起来');
  // 页面重载会清掉错误收集器：重新挂上，后面的断言才有页面报错可查
  await ev(`(() => { window.__copyErrs = []; addEventListener('error', e => window.__copyErrs.push(String(e.message || e))); return 1; })()`);

  // ---------- 6 体检抓得住：两截 + 空卡 + 断头 ----------
  const mkSample = (name) => ev(`(() => {
    const w = createWorkflow(${JSON.stringify(name)});
    const mk = (kind, title, body, x, y) => { const n = { id: uid(), kind, title, body, impl: '', mods: [], checks: [], chat: [], status: 'idle', x, y }; w.nodes.push(n); return n; };
    return { id: w.id, push: (kind, title, body, x, y) => { const n = mk(kind, title, body, x, y); saveStore(false); return n.id; }, edge: (a, b) => { w.edges.push([a, b]); saveStore(false); return 1; } };
  })()`);
  // 两截：主链 a→b→c；另一截 d→e（e 没产出）和它断开
  const s1 = await mkSample('体检 · 两截');
  await ev(`(() => {
    const w = store.workflows.find(x => x.id === ${JSON.stringify(s1.id)});
    const mk = (kind, title, body, x) => { const n = { id: uid(), kind, title, body, impl: '', mods: [], checks: [], chat: [], status: 'idle', x, y: 40 }; w.nodes.push(n); return n.id; };
    const a = mk('in', '主素材', '一张主图。', 0), b = mk('proc', '主加工', '把主图裁成方图。', 330), c = mk('out', '主成果', '一张方图。', 660);
    const d = mk('in', '断开的素材', '一段页面文字。', 0), e = mk('proc', '断开的加工', '把文字压成三条。', 330);
    w.edges.push([a, b], [b, c], [d, e]);
    w.agent = 'default'; saveStore(); render();
    return 1;
  })()`);
  const rep1 = await ev(`(() => { const w = store.workflows.find(x => x.id === ${JSON.stringify(s1.id)}); return { text: checkText(w), n: checkFlow(w).length }; })()`);
  ok('check-split', /整条被拆成 2 截/.test(rep1.text) && rep1.text.includes('「断开的素材」「断开的加工」') && /加工卡缺产出/.test(rep1.text),
    { 报告: rep1.text.replace(/\n/g, ' ⏎ ') });

  // 空卡 + 断头：空加工卡（缺输入缺产出）、没人接的输入、没人做的输出
  const s2 = await mkSample('体检 · 空卡断头');
  await ev(`(() => {
    const w = store.workflows.find(x => x.id === ${JSON.stringify(s2.id)});
    const mk = (kind, title, body, x) => { const n = { id: uid(), kind, title, body, impl: '', mods: [], checks: [], chat: [], status: 'idle', x, y: 40 }; w.nodes.push(n); return n.id; };
    mk('in', '没人用的素材', '一张图。', 0);
    mk('proc', '空加工卡', '', 330);
    mk('out', '没人做的成果', '一份清单。', 660);
    w.agent = 'default'; saveStore(); render();
    return 1;
  })()`);
  const rep2 = await ev(`(() => { const w = store.workflows.find(x => x.id === ${JSON.stringify(s2.id)}); return { text: checkText(w), kinds: checkFlow(w).map(x => x.kind) }; })()`);
  ok('check-broken-cards',
    /「空加工卡」｜只有标题，没有正文/.test(rep2.text) &&
    /「空加工卡」｜加工卡缺输入/.test(rep2.text) &&
    /「空加工卡」｜加工卡缺产出/.test(rep2.text) &&
    /「没人用的素材」｜输入卡没人接/.test(rep2.text) &&
    /「没人做的成果」｜输出卡没人做/.test(rep2.text),
    { 报告: rep2.text.replace(/\n/g, ' ⏎ ') });

  // 体检入口在界面上看得见：打开弹层，清单逐条渲染
  const ui = await ev(`(() => {
    switchWorkflow(${JSON.stringify(s2.id)});
    openTest();
    return { on: document.querySelector('#testModal').classList.contains('on'), rows: document.querySelectorAll('#tReport .trow').length,
      stat: document.querySelector('#tStat').textContent, title: document.querySelector('#tTitle').textContent };
  })()`);
  ok('check-ui', ui.on && ui.rows >= 5 && ui.title.includes('体检 · 空卡断头'), ui);
  await ev(`(() => { closeTest(); return 1; })()`);

  // ---------- 7 只读预演（--preview 才真调执行方：一张卡一次） ----------
  if (PREVIEW) {
    const pv = await ev(`(() => {
      const w = createWorkflow('预演 · 样例');
      const mk = (kind, title, body, x) => { const n = { id: uid(), kind, title, body, impl: '', mods: [], checks: [], chat: [], status: 'idle', x, y: 40 }; w.nodes.push(n); return n; };
      const a = mk('in', '商品资料', '商品编号 A-1001，加上主图 5 张和页面上的标题、价格。', 0);
      const b = mk('proc', '挑主图', '从 5 张主图里挑三张颜色最接近的，按清晰度排序。', 330);
      w.edges.push([a.id, b.id]);
      w.agent = ${JSON.stringify(AGENT)};
      saveStore(); renderWorkflowList(); render(); openTest();
      return { id: w.id, a: a.id, b: b.id, nodes: w.nodes.length, edges: w.edges.length, v: w.version };
    })()`);
    const t0 = Date.now();
    await ev(`(async () => { await startPreview(); return 1; })()`);
    await wait(400);
    const pvAfter = await ev(`(() => {
      const w = store.workflows.find(x => x.id === ${JSON.stringify(pv.id)});
      return { busy: PV.busy, err: PV.error, stat: document.querySelector('#tStat').textContent,
        cards: w.nodes.map(n => ({ title: n.title, has: !!n.preview, ok: !!(n.preview && n.preview.ok), text: (n.preview && n.preview.text) || '', steps: (n.preview && n.preview.steps) || 0 })),
        chips: document.querySelectorAll('.node .pvchip').length, nodes: w.nodes.length, edges: w.edges.length, v: w.version,
        rows: document.querySelectorAll('#tPrev .trow').length };
    })()`);
    const all = pvAfter.cards.every(c => c.has && c.ok && c.text.length > 20);
    ok('preview-cards', all && pvAfter.cards.every(c => c.steps === 0) && /工具调用 0 次/.test(pvAfter.stat) && pvAfter.rows === pv.nodes,
      { 用时: ((Date.now() - t0) / 1000).toFixed(1) + 's', 每张都有结论: all, 工具调用: pvAfter.cards.map(c => c.steps), 顶部: pvAfter.stat,
        第一张: pvAfter.cards[0].text.replace(/\n/g, ' ⏎ ').slice(0, 160) });
    ok('preview-readonly', pvAfter.nodes === pv.nodes && pvAfter.edges === pv.edges && pvAfter.v === pv.v && pvAfter.chips === pv.nodes,
      { 画布没变: pvAfter.nodes === pv.nodes && pvAfter.edges === pv.edges, 版本没涨: [pv.v, pvAfter.v], 卡上预演标: pvAfter.chips });
    // 左栏卡片里能看见预演结论
    const panel = await ev(`(() => { const w = flow(); openCard(w.nodes[1]); const b = document.querySelector('.pvbox'); return b ? b.textContent.replace(/\\s+/g, ' ').slice(0, 120) : null; })()`);
    ok('preview-panel', !!panel && panel.includes('预演结果'), { 左栏: panel });
    // 一键清空：卡上、左栏、弹层都不留残渣
    const cleared = await ev(`(() => {
      clearPreviews();
      const w = flow();
      return { previews: w.nodes.filter(n => n.preview).length, chips: document.querySelectorAll('.pvchip').length,
        panel: !!document.querySelector('.pvbox'), rows: [...document.querySelectorAll('#tPrev .tptext')].map(e => e.textContent) };
    })()`);
    ok('preview-clear', cleared.previews === 0 && cleared.chips === 0 && !cleared.panel && cleared.rows.every(t => t === '还没预演'), cleared);
    await ev(`(() => { closeTest(); return 1; })()`);
  } else {
    console.log('SKIP  preview           没加 --preview（不真调执行方）');
  }

  // ---------- 8 收尾：删掉测试链路，切回原来那条 ----------
  await ev(`(() => {
    window.confirm = () => true;
    const ids = [${JSON.stringify(srcId)}, ${JSON.stringify(copyId)}, ${JSON.stringify(s1.id)}, ${JSON.stringify(s2.id)}];
    for (const id of ids) if (store.workflows.some(w => w.id === id) && store.workflows.length > 1) deleteWorkflow(id, { stopPropagation() { } });
    return store.workflows.map(w => w.name);
  })()`);
  await wait(250);
  // 预演样例也是一条，按名字删（演示脚本里没有存它的 id 到 window）
  await ev(`(() => {
    window.confirm = () => true;
    const pv = store.workflows.find(w => w.name === '预演 · 样例');
    if (pv && store.workflows.length > 1) deleteWorkflow(pv.id, { stopPropagation() { } });
    return 1;
  })()`);
  await wait(200);
  await ev(`(() => { const id = ${JSON.stringify(orig.id)}; if (store.workflows.some(w => w.id === id)) switchWorkflow(id); else render(); return 1; })()`);
  await wait(200);
  const end = await ev(`(() => ({ left: store.workflows.map(w => w.name), cur: store.current, errs: window.__copyErrs || [] }))()`);
  ok('cleanup', end.left.every(n => !/复制链路 · 原件|复制链路 · 原件（副本）|体检 ·|预演 · 样例/.test(n)) && end.errs.length === 0,
    { 剩下的链路: end.left, 页面报错: end.errs });

  console.log(fail ? `\n${fail} 条失败` : '\n全部通过');
  ws.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('探针炸了：' + (e && e.message || e)); process.exit(1); });
