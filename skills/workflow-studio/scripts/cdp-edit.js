// 编辑即版本自检：改正文 / 标题 / 内部实现 / 加模块 / 删模块 / 改模块名，也走同一条通道——
// 画布当场变、状态文件 1 秒内同步、一次完整改动只记一版、版本条目说得出「哪张卡改了什么」。
// 另外验：连打 30 个字只多 1 版、打字时焦点/光标不动（不重建面板）、拖动与折叠/切换选中不出新版本、
// 改完的 agent 提示词里是新内容（doc 侧断言，不调模型）。
//
//   export CDP_PORT=9333                        # 隔离实例（见 SKILL.md「启动与验证」）
//   node skills/workflow-studio/scripts/cdp-edit.js          # 不花钱：不调 agent
//   node skills/workflow-studio/scripts/cdp-edit.js --chat   # 再加一次真实调用：问 agent「这张加工卡的正文是什么」
//
// 它只在自己新建的测试链路上动（结束时删掉、并切回原来那条），不碰现有链路的卡片与对话。
const fs = require('fs');
const http = require('http');

const argv = process.argv.slice(2);
const has = n => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt('port', process.env.CDP_PORT || 9222));
const CHAT = has('chat');
const AGENT = opt('agent', 'default');       // --chat 时叫哪一个 agent（默认平台主管）

const get = u => new Promise((res, rej) => http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
const wait = ms => new Promise(r => setTimeout(r, ms));

let fail = 0;
const ok = (name, pass, info) => {
  if (!pass) fail++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(26)} ${info == null ? '' : (typeof info === 'string' ? info : JSON.stringify(info))}`);
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
  // 真键盘/输入：往当前焦点里插字，触发 beforeinput/input（合成 value 赋值不会触发，测不出光标与节流）
  const typeText = async (text, gap = 40) => {
    const chunks = [];
    for (const ch of text) chunks.push(ch);                  // 一个字一个字打，最接近人打字
    for (const c of chunks) { await send('Input.insertText', { text: c }); await wait(gap); }
  };
  const focusSel = sel => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.focus(); return { tag: el.tagName, start: el.selectionStart, len: el.value == null ? -1 : el.value.length }; })()`);
  const caret = sel => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; return { start: el.selectionStart, end: el.selectionEnd, active: document.activeElement === el, probe: el.__probe || '' }; })()`);

  await wait(300);
  await ev(`(() => { if (!window.__editErrs) { window.__editErrs = []; addEventListener('error', e => window.__editErrs.push(String(e.message || e))); } return 1; })()`);

  const orig = await ev(`(() => ({ id: store.current, ids: store.workflows.map(w => w.id) }))()`);
  const vinfo = () => ev(`(() => { const w = flow(); return { id: w.id, v: w.version || 1, n: (VER.list[w.id] || []).length, rows: (VER.list[w.id] || []).map(e => [e.v, e.what, e.by]) }; })()`);
  const linkOf = wid => ev(`(async () => { const r = await window.tcflow.linkRead(${JSON.stringify(wid)}); return { ok: r.ok, path: r.path, doc: r.doc }; })()`);
  // 状态文件内容（Node 侧读真文件；不经过页面，证明确实落盘了）
  const fileText = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } };
  // 等状态文件里出现某段内容，返回等了多久（没有就是 -1）
  const waitFile = async (needle, max = 1200) => {
    const t0 = Date.now();
    while (Date.now() - t0 < max) {
      if (fileText(path).includes(needle)) return Date.now() - t0;
      await wait(50);
    }
    return -1;
  };

  // ---------- 0 页面在
  ok('open', await ev(`typeof saveEditing === 'function' && typeof flushEditing === 'function' && !!document.querySelector('#panelTab')`), '编辑通道的入口都在');

  // ---------- 1 造一条测试链路（4 张卡 + 3 条线）
  const mk = await ev(`(() => {
    const w = createWorkflow('编辑即版本 · 样例');
    const a = addNode('in',   { title: '素材包', body: '主图 5 张 + 页面标题', mods: [{ id: uid(), type: 'mat', name: '主图' }], x: 0, y: 0 }, false);
    const b = addNode('proc', { title: '出图', body: '按主图挑 3 张能用的', mods: [{ id: uid(), type: 'tool', name: '对比' }], x: 600, y: 0 }, false);
    const c = addNode('out',  { title: '成片', body: '交三张能直接用的图', mods: [{ id: uid(), type: 'res', name: '清单' }], x: 1200, y: 0 }, false);
    const d = addNode('proc', { title: '补文案', body: '给每张图配一句卖点', mods: [{ id: uid(), type: 'tool', name: '写作' }], x: 600, y: 320 }, false);
    connect(a.id, b.id, false); connect(b.id, c.id, false); connect(c.id, d.id, false);
    saveStore();
    return { id: w.id, cards: { a: a.id, b: b.id, c: c.id, d: d.id } };
  })()`);
  await wait(600);
  const wid = mk.id, B = mk.cards.b;
  const path = (await linkOf(wid)).path;
  const v0 = await vinfo();
  ok('setup', v0.n >= 1 && !!path, { 链路: wid, 版本条数: v0.n, 状态文件: path });

  // 打开「出图」这张加工卡的左栏（编辑都在这块面板里）
  const openProc = async () => {
    await ev(`(() => { openCard(find(${JSON.stringify(B)})); return 1; })()`);
    await wait(320);
    return ev(`(() => { const el = document.querySelector('#pBody'); return !!(el && document.querySelector('#pTitle') && document.querySelector('#pImpl') && document.querySelector('#pModAdd')); })()`);
  };
  ok('panel-open', await openProc(), '左栏有 标题 / 内容 / 内部实现 / 模块 四处输入');

  // ---------- 2 连打 30 个字：只多 1 版，光标不跳、面板不重建
  const NEWBODY = '按主图的颜色和构图挑三张，再比同类的价格差，标出不能直接用的图';
  const b2 = await vinfo();
  await ev(`(() => { const el = document.querySelector('#pBody'); el.__probe = 'same-node'; return 1; })()`);
  await focusSel('#pBody');
  await ev(`(() => { const el = document.querySelector('#pBody'); el.setSelectionRange(0, el.value.length); return 1; })()`);
  await ev(`(() => { try { window.__lt = []; new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: false }); } catch (e) { window.__lt = []; } return 1; })()`);
  const typed = [];
  for (const ch of NEWBODY) {
    await send('Input.insertText', { text: ch });
    await wait(35);
    typed.push(await caret('#pBody'));
  }
  const cAfter = typed[typed.length - 1] || {};
  const starts = typed.map(x => x && x.start);
  const mono = starts.every((s, i) => i === 0 || s === starts[i - 1] + 1);
  ok('type-caret-stable', typed.every(x => x && x.active && x.probe === 'same-node') && mono && cAfter.start === NEWBODY.length,
    { 字数: NEWBODY.length, 光标: [starts[0], cAfter.start], 一路上只在同一个框里: typed.every(x => x.probe === 'same-node'), '每次前进 1 格': mono });

  // 停手还没到 1.5 秒：文件应该已经写出去（≤1s），但版本还不该多
  // 打字过程中文件就在跟着变（不是等失焦才写）：先看已经写进去的，再补一个字量「最后一下到落盘」多久
  const duringTyping = fileText(path).includes('构图');
  const mark = '★';
  const t0 = Date.now();
  await send('Input.insertText', { text: mark });
  let fileMs = -1;
  for (let i = 0; i < 40; i++) {
    if (fileText(path).includes(mark)) { fileMs = Date.now() - t0; break; }
    await wait(25);
  }
  const afterFile = fileText(path);
  const vMid = await vinfo();
  ok('file-sync-1s', fileMs >= 0 && fileMs < 1000 && duringTyping && vMid.n === b2.n,
    { 打字过程中就在写: duringTyping, 最后一个字到落盘: fileMs + 'ms', 版本条数: [b2.n, vMid.n], 文件里有了新正文: afterFile.includes('构图') });

  // 失焦 = 这次改完：立刻记一版
  await ev(`(() => { document.querySelector('#pBody').blur(); return 1; })()`);
  await wait(350);
  const vAfter = await vinfo();
  const lastRow = vAfter.rows[vAfter.rows.length - 1] || [];
  ok('body-one-version', vAfter.n === b2.n + 1 && /加工卡·出图：换了加工方式/.test(String(lastRow[1])),
    { '连打 30 字': b2.n + ' → ' + vAfter.n, 最新一行: lastRow });

  const longtasks = await ev(`window.__lt || []`);
  ok('type-no-jank', longtasks.filter(d => d > 100).length === 0,
    { 长任务: longtasks.length ? longtasks : '无（>50ms 的一个都没有）' });

  // ---------- 3 改标题：一版，条目说得出改了名字
  const b3 = await vinfo();
  await focusSel('#pTitle');
  await ev(`(() => { const el = document.querySelector('#pTitle'); el.setSelectionRange(0, el.value.length); return 1; })()`);
  await typeText('出图 · 挑图', 30);
  await ev(`(() => { document.querySelector('#pTitle').blur(); return 1; })()`);
  await wait(350);
  const v3 = await vinfo();
  const row3 = v3.rows[v3.rows.length - 1] || [];
  const titleCut = await ev(`(() => { const w = flow(); const n = w.nodes.find(x => x.id === ${JSON.stringify(B)}); const el = document.querySelector('.node[data-id="' + n.id + '"] .t'); return { title: n.title, dom: el ? el.textContent : '' }; })()`);
  ok('title-one-version', v3.n === b3.n + 1 && /改了名字/.test(String(row3[1])) && titleCut.dom === '出图 · 挑图',
    { 最新一行: row3, 卡片上的标题: titleCut.dom });

  // ---------- 4 改「内部实现」：一版，条目写「改了内部实现」
  const b4 = await vinfo();
  await ev(`(() => { const d = document.querySelector('.panel details.internal'); if (d) d.open = true; return 1; })()`);
  await focusSel('#pImpl');
  await typeText('cards/pick.json', 30);
  await ev(`(() => { document.querySelector('#pImpl').blur(); return 1; })()`);
  await wait(350);
  const v4 = await vinfo();
  const row4 = v4.rows[v4.rows.length - 1] || [];
  const implNow = await ev(`implOf(find(${JSON.stringify(B)}))`);
  const ms4 = await waitFile('cards/pick.json');
  ok('impl-one-version', v4.n === b4.n + 1 && /改了内部实现/.test(String(row4[1])) && implNow === 'cards/pick.json' && ms4 >= 0,
    { 最新一行: row4, 卡片内部实现: implNow, 状态文件里也有: ms4 >= 0, 写出去用了: ms4 + 'ms' });

  // ---------- 5 加一个模块：一版，条目写「改了模块」
  const b5 = await vinfo();
  const added = await ev(`(() => {
    const el = document.querySelector('#pModAdd');
    el.value = '调色';
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return find(${JSON.stringify(B)}).mods.map(m => m.name);
  })()`);
  await wait(400);
  const v5 = await vinfo();
  const row5 = v5.rows[v5.rows.length - 1] || [];
  const ms5 = await waitFile('调色');
  ok('mod-add-version', v5.n === b5.n + 1 && /改了模块/.test(String(row5[1])) && added.includes('调色') && ms5 >= 0,
    { 最新一行: row5, 模块: added, 状态文件里也有: ms5 >= 0, 写出去用了: ms5 + 'ms' });

  // ---------- 6 删一个模块：一版
  const b6 = await vinfo();
  const modsBefore = await ev(`find(${JSON.stringify(B)}).mods.map(m => m.name)`);
  const delRes = await ev(`(() => {
    const i = find(${JSON.stringify(B)}).mods.findIndex(m => m.name === '调色');
    const x = document.querySelectorAll('#pMods .mx')[i];
    if (!x) return null;
    const r = x.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (delRes) { await mouse('mousePressed', delRes.x, delRes.y, 1); await mouse('mouseReleased', delRes.x, delRes.y, 1); }
  await wait(400);
  const v6 = await vinfo();
  const row6 = v6.rows[v6.rows.length - 1] || [];
  const modsAfter = await ev(`find(${JSON.stringify(B)}).mods.map(m => m.name)`);
  ok('mod-del-version', !!delRes && v6.n === b6.n + 1 && /改了模块/.test(String(row6[1])) && !modsAfter.includes('调色'),
    { 最新一行: row6, 删前: modsBefore, 删后: modsAfter });

  // ---------- 7 改模块名（contenteditable）：一版
  const b7 = await vinfo();
  await ev(`(() => { const sp = document.querySelectorAll('#pMods .mn')[0]; sp.focus(); const r = document.createRange(); r.selectNodeContents(sp); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return 1; })()`);
  await typeText('比对', 40);
  await ev(`(() => { const sp = document.querySelectorAll('#pMods .mn')[0]; sp.blur(); return 1; })()`);
  await wait(400);
  const v7 = await vinfo();
  const row7 = v7.rows[v7.rows.length - 1] || [];
  const mods7 = await ev(`find(${JSON.stringify(B)}).mods.map(m => m.name)`);
  const ms7 = await waitFile('比对');
  ok('mod-rename-version', v7.n === b7.n + 1 && /改了模块/.test(String(row7[1])) && mods7[0] === '比对' && ms7 >= 0,
    { 最新一行: row7, 模块: mods7, 状态文件里也有: ms7 >= 0, 写出去用了: ms7 + 'ms' });

  // ---------- 8 回滚把编辑带回去：改模块 → 回滚到上一版 → 模块变回原样
  const base = await vinfo();
  const snapMods = mods7.slice();
  await ev(`(() => { const w = flow(); const n = w.nodes.find(x => x.id === ${JSON.stringify(B)}); n.mods = n.mods.map(m => ({ ...m, name: '乱改的' })); paintNodes(); saveEditing({ commit: true }); return 1; })()`);
  await wait(350);
  const changed = await vinfo();
  const rolled = await ev(`(() => { const r = rollbackTo(${JSON.stringify(base.v)}); const n = find(${JSON.stringify(B)}); return { ok: r, mods: n.mods.map(m => m.name), body: n.body, v: flow().version }; })()`);
  await wait(300);
  ok('rollback-restores-edit', changed.n === base.n + 1 && rolled.ok && JSON.stringify(rolled.mods) === JSON.stringify(snapMods) && rolled.body === NEWBODY + '★',
    { 改坏后: changed.rows[changed.rows.length - 1], 回滚到: base.v, 回滚后模块: rolled.mods, 回滚后正文是新写的: rolled.body === NEWBODY + '★' });

  // ---------- 9 拖卡 / 折叠 / 换选中：都不算改动、不出新版本
  const b9 = await vinfo();
  await ev(`(() => { zoom = 1; applyZoom(); drawEdges(); const n = flow().nodes.find(x => x.id === ${JSON.stringify(B)}); const el = document.querySelector('.node[data-id="' + n.id + '"]'); wrap.scrollLeft = (n.x + ORIGIN.x + el.offsetWidth / 2) - wrap.clientWidth / 2; wrap.scrollTop = (n.y + ORIGIN.y + el.offsetHeight / 2) - wrap.clientHeight / 2; return 1; })()`);
  await wait(250);
  const d = await ev(`(() => { const n = flow().nodes.find(x => x.id === ${JSON.stringify(B)}); const el = document.querySelector('.node[data-id="' + n.id + '"]'); const r = el.querySelector('.body').getBoundingClientRect(); return { x0: Math.round(n.x), y0: Math.round(n.y), sx: Math.round(r.left + 22), sy: Math.round(r.top + 12) }; })()`);
  await mouse('mousePressed', d.sx, d.sy, 1);
  await mouse('mouseMoved', d.sx + 40, d.sy + 30, 1);
  await mouse('mouseMoved', d.sx + 80, d.sy + 60, 1);
  await mouse('mouseReleased', d.sx + 80, d.sy + 60, 1);
  await wait(500);
  const moved = await ev(`(() => { const n = find(${JSON.stringify(B)}); return { dx: Math.round(n.x - ${d.x0}), dy: Math.round(n.y - ${d.y0}) }; })()`);
  // 折叠（点空白处收起）→ 再点左侧把手展开概览
  await ev(`(() => { selId = null; panelCardId = null; panelOpen = false; applyPanelState(); return 1; })()`);
  await wait(150);
  const collapsed = await ev(`document.querySelector('#layout').classList.contains('collapsed')`);
  await ev(`(() => { panelOpen = true; panelCardId = null; render(); return 1; })()`);
  await wait(200);
  // 换选中：另一张卡
  await ev(`(() => { openCard(find(${JSON.stringify(mk.cards.a)})); return 1; })()`);
  await wait(300);
  const v9 = await vinfo();
  ok('ui-no-version', v9.n === b9.n && (moved.dx || moved.dy) && collapsed,
    { 拖了: moved, 折叠生效: collapsed, 版本条数: [b9.n, v9.n] });

  // ---------- 10 agent 拿到的是新内容（提示词里逐字是新写的正文/内部实现/模块）
  const prompt = await ev(`(() => {
    const n = find(${JSON.stringify(B)});
    return { chat: buildChatPrompt(n, '现在这张加工卡的加工方式是什么？'), dock: dockPrompt('这条链路第几版？') };
  })()`);
  ok('prompt-has-new-content',
    prompt.chat.includes('构图') && prompt.chat.includes('cards/pick.json') && prompt.chat.includes('比对') && prompt.dock.includes('构图'),
    { 卡片对话提示词带新正文: prompt.chat.includes('构图'), 带新内部实现: prompt.chat.includes('cards/pick.json'), 带新模块名: prompt.chat.includes('比对'), 对话框提示词也带: prompt.dock.includes('构图') });

  if (CHAT) {
    const ask = await ev(`(async () => {
      const w = flow();
      w.agent = ${JSON.stringify(AGENT)}; saveStore();
      await new Promise(r => setTimeout(r, 450));       // 执行方这一改先单独记一版，别和后面的改名并到一起
      const n = w.nodes.find(x => x.id === ${JSON.stringify(B)});
      openCard(n);
      await chatSend('现在这张加工卡的正文（加工方式）是什么？请原样引用卡片正文，不要改写、不要给候选卡。');
      const m = (flow().nodes.find(x => x.id === ${JSON.stringify(B)}).chat || []).slice(-1)[0] || {};
      return { answer: String(m.text || '').slice(0, 600), before: { nodes: w.nodes.length, edges: w.edges.length } };
    })()`);
    const after = await ev(`(() => ({ nodes: flow().nodes.length, edges: flow().edges.length }))()`);
    ok('agent-knows-new-content', /构图/.test(ask.answer) && /价格差/.test(ask.answer) && after.nodes === ask.before.nodes && after.edges === ask.before.edges,
      { 答: ask.answer.replace(/\n/g, ' ⏎ ').slice(0, 260), 画布没被改: after });
  } else {
    console.log('SKIP  agent-knows-new-content  没加 --chat（不真调 agent）；提示词那一条上面已经验过');
  }

  // ---------- 11 停手也算改完：不失焦，等 1.7 秒自己记一版；之后再失焦不多记
  await ev(`(() => { openCard(find(${JSON.stringify(B)})); return 1; })()`);
  await wait(320);
  const bIdle = await vinfo();
  await focusSel('#pTitle');
  await ev(`(() => { const el = document.querySelector('#pTitle'); el.setSelectionRange(el.value.length, el.value.length); return 1; })()`);
  await typeText('（新）', 40);
  await wait(1900);
  const vIdle = await vinfo();
  const rowIdle = vIdle.rows[vIdle.rows.length - 1] || [];
  await ev(`(() => { document.querySelector('#pTitle').blur(); return 1; })()`);
  await wait(450);
  const vIdle2 = await vinfo();
  const foot = await ev(`document.querySelector('#footStat').textContent`);
  ok('idle-one-version', vIdle.n === bIdle.n + 1 && /改了名字/.test(String(rowIdle[1])) && vIdle2.n === vIdle.n && String(foot).includes('v' + vIdle.v),
    { 停手后: [bIdle.n, vIdle.n], 最新一行: rowIdle, 再失焦不多记: vIdle2.n === vIdle.n, 底部: foot });

  // ---------- 12 收尾：删掉测试链路、切回原来那条
  await ev(`(() => { window.confirm = () => true; deleteWorkflow(${JSON.stringify(wid)}, { stopPropagation() { } }); return 1; })()`);
  await wait(300);
  await ev(`(() => { const id = ${JSON.stringify(orig.id)}; if (store.workflows.some(w => w.id === id)) switchWorkflow(id); else render(); return 1; })()`);
  await wait(200);
  const end = await ev(`(() => ({ gone: !store.workflows.some(w => w.id === ${JSON.stringify(wid)}), cur: store.current, errs: window.__editErrs || [] }))()`);
  ok('cleanup', end.gone && end.errs.length === 0, end);

  console.log(fail ? `\n${fail} 条失败` : '\n全部通过');
  ws.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('探针炸了：' + (e && e.message || e)); process.exit(1); });
