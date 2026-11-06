// 画布几何自检（真鼠标 + 真滚动）：平移范围 / 缩放锚点 / 拖动换算 / 贴边自动滚 / 卡片重叠。
//
//   node skills/workflow-studio/scripts/cdp-canvas.js
//   node skills/workflow-studio/scripts/cdp-canvas.js --card "找证据包"
//   CDP_PORT=9333 node ...（隔离实例，见 SKILL.md「启动与验证」）
//
// 它自己会还原：拖动/贴边测试前记录 n.x/n.y 与 scroll，测完写回。
// 期望输出（五条都 PASS）：
//   pan    左/左上能拖到 ORIGIN 那么远，右下能到 scrollWidth 尽头
//   anchor 1 → 1.5 倍缩放，视口中心那个画布点坐标不变
//   drag   zoom 倍下拖动，画布坐标位移 == 鼠标位移 / zoom
//   edge   指针顶住视口边缘不动时，画布要自己滚（否则卡片会被拖丢）
//   layout 两两卡片 rect 无交集（改文案/改布局后必看）
const http = require('http');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt('port', process.env.CDP_PORT || 9222));
const CARD = opt('card', '');           // 空 = 用 chainOrder 的第一张
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
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result.value;
  };
  const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  const pass = (name, ok, detail) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(7)} ${detail}`);

  // 冷启动/刚 render 完的量测是中间态：先等布局与缩放稳下来
  await wait(300);
  const start = JSON.parse(await ev(`(() => { const w = document.querySelector('#wrap'); return JSON.stringify({ sl: w.scrollLeft, st: w.scrollTop, zoom }); })()`));

  // 1) 平移范围：左上到底时卡片应被推到 ORIGIN 附近，右下到底能到 scrollWidth 尽头
  const pan = JSON.parse(await ev(`(() => {
    const w = document.querySelector('#wrap');
    w.scrollLeft = 0; w.scrollTop = 0;
    const first = document.querySelector('.node');
    const r = first ? first.getBoundingClientRect() : null;
    const atZero = r ? [Math.round(r.left), Math.round(r.top)] : null;
    w.scrollLeft = w.scrollWidth; w.scrollTop = w.scrollHeight;
    const max = [w.scrollWidth - w.clientWidth, w.scrollHeight - w.clientHeight];
    return JSON.stringify({ atZero, max, origin: [ORIGIN.x, ORIGIN.y] });
  })()`));
  pass('pan', pan.atZero && pan.atZero[0] >= pan.origin[0] - 200 && pan.max[0] > 1000,
    `scroll 0 时首卡在屏幕 ${JSON.stringify(pan.atZero)}，ORIGIN ${JSON.stringify(pan.origin)}，右下尽头 ${JSON.stringify(pan.max)}`);

  // 2) 缩放锚点：视口中心对应的画布坐标应保持不变
  const anchor = JSON.parse(await ev(`(async () => {
    centerView();
    await new Promise(r => setTimeout(r, 120));
    const w = document.querySelector('#wrap');
    const mid = () => [(w.scrollLeft + w.clientWidth / 2) / zoom, (w.scrollTop + w.clientHeight / 2) / zoom];
    const before = mid();
    zoom = 1.5; applyZoom(); drawEdges();
    await new Promise(r => setTimeout(r, 150));
    const after = mid();
    return JSON.stringify({ before: before.map(Math.round), after: after.map(Math.round), edges: document.querySelectorAll('#edges path').length });
  })()`));
  pass('anchor', Math.abs(anchor.before[0] - anchor.after[0]) <= 2 && Math.abs(anchor.before[1] - anchor.after[1]) <= 2,
    `中心画布点 ${JSON.stringify(anchor.before)} → ${JSON.stringify(anchor.after)}，连线 ${anchor.edges} 条`);

  // 3) 拖动换算（1.5 倍下测），测完把坐标写回原处
  //    缩放锚在视口中心：1.5 倍下靠边的卡会滑出视口，先把它滚到正中再量（否则点到的是空气）
  const target = CARD ? `flow().nodes.find(x => x.title === ${JSON.stringify(CARD)})`
                       : `chainOrder(flow())[0]`;
  const d = JSON.parse(await ev(`(async () => {
    const n = ${target};
    const el = document.querySelector('.node[data-id="' + n.id + '"]');
    wrap.scrollLeft = (n.x + ORIGIN.x + el.offsetWidth / 2) * zoom - wrap.clientWidth / 2;
    wrap.scrollTop = (n.y + ORIGIN.y + el.offsetHeight / 2) * zoom - wrap.clientHeight / 2;
    await new Promise(r => setTimeout(r, 120));
    const r = el.querySelector('.body').getBoundingClientRect();
    return JSON.stringify({ id: n.id, title: n.title, x0: n.x, y0: n.y, sx: Math.round(r.left + 24), sy: Math.round(r.top + 14), zoom });
  })()`));
  await mouse('mousePressed', d.sx, d.sy);
  await mouse('mouseMoved', d.sx + 60, d.sy + 30);
  await mouse('mouseReleased', d.sx + 60, d.sy + 30);
  await wait(150);
  const moved = JSON.parse(await ev(`(() => { const n = find('${d.id}'); return JSON.stringify({ dx: Math.round(n.x - ${d.x0}), dy: Math.round(n.y - ${d.y0}) }); })()`));
  const expect = [Math.round(60 / d.zoom), Math.round(30 / d.zoom)];
  pass('drag', Math.abs(moved.dx - expect[0]) <= 2 && Math.abs(moved.dy - expect[1]) <= 2,
    `${d.zoom}x 下鼠标走 (60,30) → 画布坐标 ${JSON.stringify([moved.dx, moved.dy])}，应为 ${JSON.stringify(expect)}`);
  await ev(`(() => { const n = find('${d.id}'); n.x = ${d.x0}; n.y = ${d.y0}; saveStore(); zoom = 1; applyZoom(); render(); return 1; })()`);

  // 4) 贴边自动滚：抓着一张卡把指针顶在视口左上角不动，画布应该自己继续滚
  await ev(`centerView(); 1`);
  await wait(200);
  const e = JSON.parse(await ev(`(() => {
    const n = ${target};
    const el = document.querySelector('.node[data-id="' + n.id + '"]');
    const r = el.querySelector('.body').getBoundingClientRect();
    const w = document.querySelector('#wrap').getBoundingClientRect();
    return JSON.stringify({ id: n.id, x0: n.x, y0: n.y, sx: Math.round(r.left + 20), sy: Math.round(r.top + 12), wx: Math.round(w.left), wy: Math.round(w.top) });
  })()`));
  const before = JSON.parse(await ev(`(() => { const w = document.querySelector('#wrap'); return JSON.stringify({ sl: Math.round(w.scrollLeft), st: Math.round(w.scrollTop) }); })()`));
  await mouse('mousePressed', e.sx, e.sy);
  await mouse('mouseMoved', e.sx - 40, e.sy - 30);
  await mouse('mouseMoved', e.wx + 8, e.wy + 8);      // 顶到画布左上角
  await wait(900);                                    // 停住不动，等 rAF 自动滚
  const during = JSON.parse(await ev(`(() => { const w = document.querySelector('#wrap'); return JSON.stringify({ sl: Math.round(w.scrollLeft), st: Math.round(w.scrollTop) }); })()`));
  await mouse('mouseReleased', e.wx + 8, e.wy + 8);
  await wait(200);
  const scrolled = before.sl - during.sl + (before.st - during.st);
  pass('edge', scrolled > 50, `贴边 0.9s：scroll ${JSON.stringify([before.sl, before.st])} → ${JSON.stringify([during.sl, during.st])}（应明显变小）`);
  await ev(`(() => { const n = find('${e.id}'); n.x = ${e.x0}; n.y = ${e.y0}; saveStore(); render(); return 1; })()`);

  // 5) 重叠：文案/布局改动后最容易撞车的地方
  const lay = JSON.parse(await ev(`(() => {
    const boxes = [...document.querySelectorAll('.node')].map(e => { const r = e.getBoundingClientRect(); return [e.querySelector('.t').textContent, Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; });
    let ov = 0;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a[1] < b[1] + b[3] && b[1] < a[1] + a[3] && a[2] < b[2] + b[4] && b[2] < a[2] + a[4]) ov++;
    }
    return JSON.stringify({ n: boxes.length, overlaps: ov });
  })()`));
  pass('layout', lay.overlaps === 0, `${lay.n} 张卡，重叠 ${lay.overlaps} 处`);

  // 收尾：视野还原到打开时的位置
  await ev(`(() => { const w = document.querySelector('#wrap'); w.scrollLeft = ${start.sl}; w.scrollTop = ${start.st}; return 1; })()`);
  ws.close(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
