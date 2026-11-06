// 拖卡接入的真鼠标验收（可顺手录一段演示）。
//
//   CDP_PORT=9333 node skills/workflow-studio/scripts/cdp-dock.js                    # 断言
//   CDP_PORT=9333 node skills/workflow-studio/scripts/cdp-dock.js --record dock.mp4  # 同时录屏（.mp4 / .gif）
//   --in 商品编号 --proc 找证据包 --loop 卖点卡     卡片名（默认是种子工作流里的这三张）
//
// 它会临时拔掉 in→proc 那根线、把 in 卡挪到空地，测完把连线、位置、缩放、滚动、对话框原样写回。
// 对着用户的窗口也能跑，但用户可能同时在点——优先用隔离实例（见 SKILL.md「启动与验证」）。
// 期望全部 PASS：
//   hover  拖到加工卡上：卡片缩成小块，「素材」插槽高亮并预览要插进去的模块，「成果」插槽变淡
//   dock   松手：连上线，卡片落到加工卡左边，模块出现在插槽里；接入动画在跑，跑完收干净
//   deny   会绕成圈的接法：插槽标红；松手后不连线，卡片回到拖起的地方
//   unplug 把插槽里的模块拖出卡外松手：线断开
//   result 临时输出卡拖到「成果」插槽：连成 加工→输出，卡片落在加工卡右边且不压别的卡（不录屏）
//   errors 全程页面没有抛错
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt('port', process.env.CDP_PORT || 9222));
const IN = opt('in', '商品编号'), PROC = opt('proc', '找证据包'), LOOP = opt('loop', '卖点卡');
const REC = opt('record', '');
const SHOTS = opt('shots', '');          // 目录：在关键时刻各截一张画布区（拖到插槽上 / 接上后 / 拒绝 / 拔出 / 成果槽）
const Q = JSON.stringify;
const get = u => new Promise((res, rej) => http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const t = (await get(`http://127.0.0.1:${PORT}/json/list`)).find(x => x.type === 'page');
  if (!t) { console.error('no page target on ' + PORT); process.exit(1); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const errors = []; const frames = [];
  const send = (m, q = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: q })); });
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push((d.exception || {}).description || d.text);
    }
    if (m.method === 'Page.screencastFrame') {
      frames.push({ data: m.params.data, ts: m.params.metadata.timestamp, w: m.params.metadata.deviceWidth });
      send('Page.screencastFrameAck', { sessionId: m.params.sessionId });
    }
  });
  await new Promise(r => ws.addEventListener('open', r));
  await send('Runtime.enable');
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result.value;
  };
  const J = async expr => JSON.parse(await ev(expr));
  const mouse = (type, x, y, buttons = 1) => send('Input.dispatchMouseEvent',
    { type, x: Math.round(x), y: Math.round(y), button: buttons ? 'left' : 'none', buttons: type === 'mouseReleased' ? 0 : buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
  // 缓入缓出地移动指针，像人手一样（down = 是否按着左键）
  const glide = async (a, b, ms = 900, steps = 30, down = true) => {
    for (let i = 1; i <= steps; i++) {
      const k = i / steps, e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      await mouse('mouseMoved', a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, down ? 1 : 0);
      await wait(ms / steps);
    }
  };
  let fails = 0;
  const pass = (name, ok, detail) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(7)} ${detail}`); };
  const node = id => `document.querySelector('.node[data-id="${id}"]')`;
  const rect = async sel => J(`(() => { const e = ${sel}; if (!e) return 'null'; const r = e.getBoundingClientRect(); return JSON.stringify([r.left, r.top, r.width, r.height]); })()`);
  const grabOf = async nid => { const r = await rect(`${node(nid)}.querySelector('.hd')`); return [r[0] + r[2] * .35, r[1] + r[3] / 2]; };
  const sockOf = async (nid, k) => { const r = await rect(`${node(nid)}.querySelector('.sock[data-sock="${k}"]')`); return [r[0] + r[2] / 2, r[1] + r[3] / 2]; };
  const ours = `(a => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition))`;   // 只数我们自己起的 WAAPI 动画

  // ---------- 布置场景 ----------
  await wait(300);
  const setup = await J(`(() => {
    const w = flow(), N = t => w.nodes.find(n => n.title === t);
    const a = N(${Q(IN)}), p = N(${Q(PROC)}), l = N(${Q(LOOP)});
    const miss = [${Q(IN)}, ${Q(PROC)}, ${Q(LOOP)}].filter(t => !N(t));
    if (miss.length) return JSON.stringify({ error: '找不到卡片：' + miss.join('、') });
    if (p.kind !== 'proc') return JSON.stringify({ error: ${Q(PROC)} + ' 不是加工卡' });
    window.__dockSave = { edges: JSON.stringify(w.edges), pos: w.nodes.map(n => [n.id, n.x, n.y]), zoom, sl: wrap.scrollLeft, st: wrap.scrollTop,
      dockOpen, sel: selId, panel: panelCardId, panelOpen };
    selId = null; panelCardId = null; panelOpen = false; dockOpen = false; zoom = 1;
    w.edges = w.edges.filter(([x, y]) => !(x === a.id && y === p.id));
    render();
    // in 卡挪到空地：加工卡左下 / 左上 / 正下 / 正上 / 更左，挑第一个不撞的
    const size = n => { const e = document.querySelector('.node[data-id="' + n.id + '"]'); return { w: e.offsetWidth, h: e.offsetHeight }; };
    const A = size(a), P = size(p);
    const others = w.nodes.filter(n => n !== a).map(n => Object.assign({ x: n.x, y: n.y }, size(n)));
    const free = (x, y) => !others.some(b => x < b.x + b.w + 30 && b.x < x + A.w + 30 && y < b.y + b.h + 30 && b.y < y + A.h + 30);
    const cands = [[p.x - A.w - 90, p.y + P.h + 50], [p.x - A.w - 90, p.y - A.h - 50], [p.x, p.y + P.h + 50], [p.x, p.y - A.h - 50], [p.x - 2 * A.w - 140, p.y]];
    const spot = cands.find(([x, y]) => free(x, y)) || cands[0];
    a.x = Math.round(spot[0]); a.y = Math.round(spot[1]);
    render();
    // 视野：把 in / proc / loop 三张卡框在视口中间（留出左边落点的位置）
    const box = [a, p, l].map(n => Object.assign({ x: n.x, y: n.y }, size(n)));
    const x0 = Math.min(p.x - A.w - 70, ...box.map(b => b.x)), y0 = Math.min(...box.map(b => b.y));
    const x1 = Math.max(...box.map(b => b.x + b.w)), y1 = Math.max(...box.map(b => b.y + b.h));
    wrap.scrollLeft = (x0 + x1) / 2 + ORIGIN.x - wrap.clientWidth / 2;
    wrap.scrollTop = (y0 + y1) / 2 + ORIGIN.y - wrap.clientHeight / 2;
    const cw = document.querySelector('.canvaswrap').getBoundingClientRect();
    return JSON.stringify({ a: a.id, p: p.id, l: l.id, spot: [a.x, a.y], fits: (x1 - x0) < wrap.clientWidth && (y1 - y0) < wrap.clientHeight,
      crop: [cw.left, cw.top, cw.width, cw.height], vw: innerWidth });
  })()`);
  if (setup.error) { console.error(setup.error); process.exit(1); }
  if (!setup.fits) console.log('note    三张卡框不进一个视口，个别断言可能落在视口外');
  // 截画布区（不含顶栏和右侧列表）
  const snap = async name => {
    if (!SHOTS) return;
    const [x, y, width, height] = setup.crop;
    const s = await send('Page.captureScreenshot', { format: 'png', clip: { x, y, width, height, scale: 1 } });
    fs.mkdirSync(SHOTS, { recursive: true });
    const f = path.join(SHOTS, name + '.png');
    fs.writeFileSync(f, Buffer.from(s.data, 'base64'));
    console.log(`shot    ${f}`);
  };
  await wait(250);

  // ---------- 录屏：页面里放一个假指针（screencast 不带系统光标） ----------
  if (REC) {
    await ev(`(() => {
      if (document.getElementById('__cur')) return 1;
      const c = document.createElement('div'); c.id = '__cur';
      Object.assign(c.style, { position: 'fixed', left: '-40px', top: '-40px', width: '16px', height: '16px', margin: '-8px 0 0 -8px', borderRadius: '50%',
        background: 'rgba(17,17,17,.55)', border: '2px solid #fff', boxShadow: '0 2px 8px rgba(0,0,0,.3)', zIndex: 99999, pointerEvents: 'none', transition: 'transform .12s' });
      document.body.appendChild(c);
      const mv = e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; };
      const dn = e => { mv(e); c.style.transform = 'scale(.7)'; }, up = e => { mv(e); c.style.transform = ''; };
      addEventListener('pointermove', mv, true); addEventListener('pointerdown', dn, true); addEventListener('pointerup', up, true);
      window.__curOff = () => { c.remove(); removeEventListener('pointermove', mv, true); removeEventListener('pointerdown', dn, true); removeEventListener('pointerup', up, true); };
      return 1;
    })()`);
    await send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1600, maxHeight: 1000, everyNthFrame: 1 });
    await wait(600);
  }

  // ---------- 1+2) 拖进「素材」插槽 ----------
  const g0 = await grabOf(setup.a), s0 = await sockOf(setup.p, 'in');
  if (process.env.DOCK_DEBUG) {
    await ev(`(() => { window.__fdLog = []; const _fd = findDock; window.__fdOrig = _fd;
      findDock = function (n, el, x, y) { const r = _fd(n, el, x, y); window.__fdLog.push([Math.round(x), Math.round(y), r ? r.sock + ':' + r.ok : '-', Math.round(wrap.scrollLeft), Math.round(wrap.scrollTop), el.className.replace('node ', '')].join(' ')); return r; }; return 1; })()`);
    console.log('debug   grab', JSON.stringify(g0.map(Math.round)), 'sock', JSON.stringify(s0.map(Math.round)),
      'hit', await ev(`(e => e ? e.className + ' @' + ((e.closest('.node') || {}).dataset || {}).id : 'null')(document.elementFromPoint(${Math.round(g0[0])}, ${Math.round(g0[1])}))`));
  }
  await mouse('mouseMoved', g0[0] - 60, g0[1] + 40, 0);
  await glide([g0[0] - 60, g0[1] + 40], g0, 350, 10, false);
  await mouse('mousePressed', g0[0], g0[1]);
  await glide(g0, s0, 1100, 36);
  await wait(500);
  const hv = await J(`(() => { const a = ${node(setup.a)}, p = ${node(setup.p)}; const ar = a.getBoundingClientRect();
    const sock = p.querySelector('.sock[data-sock="in"]').getBoundingClientRect();
    const ghostsHidden = [...p.querySelectorAll('.sock[data-sock="in"] .mod.ghost')].filter(g => { const r = g.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2; return x >= ar.left && x <= ar.right && y >= ar.top && y <= ar.bottom; }).length;
    return JSON.stringify({
    docking: a.classList.contains('docking'), target: p.classList.contains('dock-target'),
    hot: !!p.querySelector('.sock[data-sock="in"].hot'), dim: !!p.querySelector('.sock[data-sock="out"].dim'),
    ghosts: p.querySelectorAll('.sock[data-sock="in"] .mod.ghost').length, ghostsHidden, above: ar.bottom <= sock.top + sock.height / 2, w: Math.round(ar.width) }); })()`);
  pass('hover', hv.docking && hv.target && hv.hot && hv.dim && hv.ghosts > 0 && !hv.ghostsHidden && hv.above,
    `卡片缩成小块 ${hv.docking}（宽 ${hv.w}px，浮在插槽上方 ${hv.above}），加工卡亮起 ${hv.target}，素材槽高亮 ${hv.hot}，成果槽变淡 ${hv.dim}，预览模块 ${hv.ghosts} 块（被小块挡住 ${hv.ghostsHidden}）`);
  if (process.env.DOCK_DEBUG) {
    console.log('debug   findDock\n        ' + (await J(`JSON.stringify(window.__fdLog || [])`)).join('\n        '));
    await ev(`(() => { if (window.__fdOrig) { findDock = window.__fdOrig; delete window.__fdOrig; } return 1; })()`);
  }
  await snap('1-hover');
  await mouse('mouseReleased', s0[0], s0[1]);
  await wait(140);
  const dk = await J(`(() => { const w = flow(), a = find('${setup.a}'), p = find('${setup.p}'), ae = ${node(setup.a)}, pe = ${node(setup.p)};
    return JSON.stringify({ edge: w.edges.some(([x, y]) => x === a.id && y === p.id), left: a.x + ae.offsetWidth <= p.x, dy: Math.round(a.y - p.y),
      chips: pe.querySelectorAll('.sock[data-sock="in"] .mod.plug[data-src="${setup.a}"]').length, mods: (a.mods || []).length,
      anims: document.getAnimations().filter(${ours}).length }); })()`);
  await wait(2100);
  const settle = `JSON.stringify({ anims: document.getAnimations().filter(${ours}).length, flyers: document.querySelectorAll('.mod.flyer').length,
    fx: document.querySelectorAll('#fx *').length, hidden: [...document.querySelectorAll('.mod.plug')].filter(c => c.style.opacity === '0').length })`;
  const st1 = await J(settle);
  await snap('2-docked');
  pass('dock', dk.edge && dk.left && dk.chips === Math.max(1, dk.mods) && dk.anims > 0 && !st1.anims && !st1.flyers && !st1.fx && !st1.hidden,
    `连线 ${dk.edge}，落在加工卡左边 ${dk.left}（高差 ${dk.dy}），插槽里 ${dk.chips}/${dk.mods} 块；松手时动画 ${dk.anims} 个 → 2.1s 后 ${st1.anims} 个，飞行块 ${st1.flyers}，光点/涟漪 ${st1.fx}，没落地的块 ${st1.hidden}`);

  // ---------- 3) 绕成圈的接法：拒绝 ----------
  await wait(300);
  const l0 = await J(`JSON.stringify((n => [n.x, n.y])(find('${setup.l}')))`);
  const g1 = await grabOf(setup.l), s1 = await sockOf(setup.p, 'in');
  await glide(s0, g1, 450, 14, false);
  await mouse('mousePressed', g1[0], g1[1]);
  await glide(g1, s1, 1000, 32);
  await wait(500);
  const dn = await J(`JSON.stringify({ nope: !!${node(setup.p)}.querySelector('.sock[data-sock="in"].nope'), docking: ${node(setup.l)}.classList.contains('docking') })`);
  await snap('3-deny');
  await mouse('mouseReleased', s1[0], s1[1]);
  await wait(900);
  const dn2 = await J(`(() => { const w = flow(), l = find('${setup.l}'); return JSON.stringify({ edge: w.edges.some(([x, y]) => x === '${setup.l}' && y === '${setup.p}'), pos: [l.x, l.y],
    tr: ${node(setup.l)}.style.transition, anims: document.getAnimations().filter(${ours}).length }); })()`);
  pass('deny', dn.nope && dn.docking && !dn2.edge && dn2.pos[0] === l0[0] && dn2.pos[1] === l0[1] && dn2.tr === '' && !dn2.anims,
    `插槽标红 ${dn.nope}，松手后连线 ${dn2.edge}，卡片 ${Q(l0)} → ${Q(dn2.pos)}，过渡已还原 ${dn2.tr === ''}`);

  // ---------- 4) 把模块从插槽里拖出来：断开 ----------
  await wait(300);
  const c0 = await rect(`${node(setup.p)}.querySelector('.sock[data-sock="in"] .mod.plug[data-src="${setup.a}"]')`);
  if (!c0) {
    pass('unplug', false, '插槽里没有可拖的模块（上一步没接上），跳过');
  } else {
  const pr = await rect(node(setup.p));
  const cp = [c0[0] + c0[2] / 2, c0[1] + c0[3] / 2], outPt = [pr[0] + pr[2] * .3, pr[1] - 70];
  await glide(s1, cp, 400, 12, false);
  await mouse('mousePressed', cp[0], cp[1]);
  await glide(cp, outPt, 850, 28);
  await wait(350);
  const u1 = await J(`JSON.stringify({ cut: !!document.querySelector('.mod.flyer.cut'), cutting: !!document.querySelector('#edges path.cutting'), lifting: document.querySelectorAll('.mod.lifting').length })`);
  await snap('4-unplug');
  await mouse('mouseReleased', outPt[0], outPt[1]);
  await wait(900);
  const u2 = await J(`JSON.stringify({ edge: flow().edges.some(([x, y]) => x === '${setup.a}' && y === '${setup.p}'), flyers: document.querySelectorAll('.mod.flyer').length,
    plugs: ${node(setup.p)}.querySelectorAll('.mod.plug[data-src="${setup.a}"]').length })`);
  pass('unplug', u1.cut && u1.cutting && u1.lifting > 0 && !u2.edge && !u2.flyers && !u2.plugs,
    `拖出卡外：模块标红 ${u1.cut}、线变红虚线 ${u1.cutting}、原位变淡 ${u1.lifting} 块；松手后连线 ${u2.edge}，插槽里剩 ${u2.plugs} 块`);
  await glide(outPt, [outPt[0] + 80, outPt[1] - 30], 300, 8, false);
  }

  // ---------- 收尾：停录、写回 ----------
  if (REC) { await wait(700); await send('Page.stopScreencast'); await ev(`window.__curOff && window.__curOff(); 1`); }

  // ---------- 5) 输出卡插「成果」槽（不录屏：要先把视野挪过去） ----------
  await wait(300);
  const r5 = await J(`(() => {
    const w = flow(), p = find('${setup.p}');
    const pe = document.querySelector('.node[data-id="' + p.id + '"]');
    const t = addNode('out', { title: '__dock_tmp', body: '临时测试卡', x: 0, y: 0,
      mods: [{ id: uid(), type: 'res', name: '报价 3 条' }, { id: uid(), type: 'res', name: '规格对照' }] }, false);
    const size = n => { const e = document.querySelector('.node[data-id="' + n.id + '"]'); return { w: e.offsetWidth, h: e.offsetHeight }; };
    const T = size(t), P = size(p);
    const others = w.nodes.filter(n => n !== t).map(n => Object.assign({ x: n.x, y: n.y }, size(n)));
    const free = (x, y) => !others.some(b => x < b.x + b.w + 30 && b.x < x + T.w + 30 && y < b.y + b.h + 30 && b.y < y + T.h + 30);
    const cands = [];
    for (let dy = 0; dy <= 1200; dy += 60) cands.push([p.x - T.w - 90, p.y + P.h + 40 + dy], [p.x, p.y + P.h + 40 + dy], [p.x - 2 * T.w - 120, p.y + dy]);
    const spot = cands.find(([x, y]) => free(x, y)) || cands[0];
    t.x = Math.round(spot[0]); t.y = Math.round(spot[1]); render();
    const land = dockSpot(t, p, 'out');
    const x0 = Math.min(t.x, p.x, land.x), y0 = Math.min(t.y, p.y, land.y);
    const x1 = Math.max(t.x + T.w, p.x + P.w, land.x + T.w), y1 = Math.max(t.y + T.h, p.y + P.h, land.y + T.h);
    const fit = Math.min(1, wrap.clientWidth / (x1 - x0 + 120), wrap.clientHeight / (y1 - y0 + 120));
    zoom = Math.max(0.4, Math.floor(fit * 10) / 10); applyZoom();
    wrap.scrollLeft = ((x0 + x1) / 2 + ORIGIN.x) * zoom - wrap.clientWidth / 2;
    wrap.scrollTop = ((y0 + y1) / 2 + ORIGIN.y) * zoom - wrap.clientHeight / 2;
    drawEdges();
    return JSON.stringify({ t: t.id, land, zoom });
  })()`);
  await wait(250);
  const g5 = await grabOf(r5.t), s5 = await sockOf(setup.p, 'out');
  await mouse('mouseMoved', g5[0], g5[1], 0);
  await mouse('mousePressed', g5[0], g5[1]);
  await glide(g5, s5, 700, 24);
  await wait(400);
  const h5 = await J(`JSON.stringify({ hot: !!${node(setup.p)}.querySelector('.sock[data-sock="out"].hot'), dimIn: !!${node(setup.p)}.querySelector('.sock[data-sock="in"].dim'),
    ghosts: ${node(setup.p)}.querySelectorAll('.sock[data-sock="out"] .mod.ghost').length })`);
  await snap('5-result-hover');
  await mouse('mouseReleased', s5[0], s5[1]);
  await wait(2100);
  const e5 = await J(`(() => { const w = flow(), t = find('${r5.t}'), p = find('${setup.p}');
    const size = n => { const e = document.querySelector('.node[data-id="' + n.id + '"]'); return { w: e.offsetWidth, h: e.offsetHeight }; };
    const me = Object.assign({ x: t.x, y: t.y }, size(t));
    const hits = w.nodes.filter(o => o.id !== t.id).filter(o => { const b = Object.assign({ x: o.x, y: o.y }, size(o)); return me.x < b.x + b.w && b.x < me.x + me.w && me.y < b.y + b.h && b.y < me.y + me.h; }).map(o => o.title);
    return JSON.stringify({ edge: w.edges.some(([a, b]) => a === p.id && b === t.id), rev: w.edges.some(([a, b]) => a === t.id && b === p.id),
      right: t.x >= p.x + size(p).w, at: [t.x, t.y], hits,
      chips: ${node(setup.p)}.querySelectorAll('.sock[data-sock="out"] .mod.plug[data-src="${r5.t}"]').length,
      leftover: document.querySelectorAll('#fx *, .mod.flyer').length + document.getAnimations().filter(${ours}).length,
      left: [...document.querySelectorAll('#fx *, .mod.flyer')].map(e => e.tagName + '.' + e.getAttribute('class')).concat(document.getAnimations().filter(${ours}).map(a => (a.effect && a.effect.target ? a.effect.target.className.baseVal || a.effect.target.className : '?') + ':' + a.playState + ':' + Math.round(a.currentTime || 0) + '/' + Math.round((a.effect && a.effect.getComputedTiming().endTime) || 0))) }); })()`);
  if (e5.leftover) console.log('debug   还在的:', Q(e5.left));
  await snap('6-result-docked');
  pass('result', h5.hot && h5.dimIn && h5.ghosts === 2 && e5.edge && !e5.rev && e5.right && !e5.hits.length && e5.chips === 2 && !e5.leftover,
    `悬停：成果槽高亮 ${h5.hot}、素材槽变淡 ${h5.dimIn}、预览 ${h5.ghosts} 块；松手：加工→输出 ${e5.edge}（反向 ${e5.rev}），落在右边 ${e5.right} ${Q(e5.at)}，压到 ${e5.hits.join('、') || '无'}，成果槽里 ${e5.chips} 块，动画收干净 ${!e5.leftover}（${r5.zoom}x）`);

  // ---------- 写回：连线、位置、临时卡、缩放、滚动、对话框 ----------
  await ev(`(() => { const s = window.__dockSave, w = flow(); if (!s) return 0;
    w.nodes = w.nodes.filter(n => s.pos.some(p => p[0] === n.id));
    w.edges = JSON.parse(s.edges); s.pos.forEach(([id, x, y]) => { const n = find(id); if (n) { n.x = x; n.y = y; } });
    zoom = s.zoom; dockOpen = s.dockOpen; selId = s.sel; panelCardId = s.panel; panelOpen = s.panelOpen;
    saveStore(); render(); wrap.scrollLeft = s.sl; wrap.scrollTop = s.st; delete window.__dockSave; return 1; })()`);
  pass('errors', errors.length === 0, errors.length ? errors.slice(0, 3).join(' | ') : '页面没有抛错');

  if (REC && frames.length) {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'dockrec-'));
    let list = '';
    frames.forEach((f, i) => {
      const fn = path.join(dir, `f${String(i).padStart(5, '0')}.jpg`);
      fs.writeFileSync(fn, Buffer.from(f.data, 'base64'));
      const next = frames[i + 1];
      list += `file '${fn}'\nduration ${(next ? Math.max(0.001, next.ts - f.ts) : 0.6).toFixed(4)}\n`;
    });
    list += `file '${path.join(dir, `f${String(frames.length - 1).padStart(5, '0')}.jpg`)}'\n`;
    fs.writeFileSync(path.join(dir, 'list.txt'), list);
    const imgW = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', path.join(dir, 'f00000.jpg')], { encoding: 'utf8' }).trim());
    const k = imgW / (frames[0].w || setup.vw);
    const even = v => Math.floor(v * k / 2) * 2;
    const crop = `crop=${even(setup.crop[2])}:${even(setup.crop[3])}:${even(setup.crop[0])}:${even(setup.crop[1])}`;
    const out = path.resolve(REC);
    const vf = REC.endsWith('.gif')
      ? `${crop},fps=15,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`
      : `${crop},scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30`;
    const args = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-vf', vf];
    if (!REC.endsWith('.gif')) args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart');
    execFileSync('ffmpeg', args.concat([out]));
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`record  ${frames.length} 帧 → ${out}（${fs.statSync(out).size} 字节）`);
  }
  ws.close(); process.exit(fails ? 2 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
