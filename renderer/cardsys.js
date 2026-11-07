// 实时画布与主画布共用的卡片系统：**这份代码是从 renderer/app.js 原样搬过来的**。
// 主画布改了 nodeEl / modsHTML / drawEdges / dragCard，这里要跟着搬（或者干脆两边都拆进这个文件）。
// 依赖这些全局（由 live.js 提供）：canvas / edgesSvg / wrap / zoom / OX / OY / ORIGIN / CANVAS /
// esc / KINDS / KIND_MOD / MOD_T / modsOf / implOf / nodeSig / flow() / find() / saveStore() /
// openCard() / chatAsk() / findDock()（实时窗口里恒为 null）
'use strict';
function nodeEl(n) {
  const k = KINDS[n.kind] || KINDS.proc;
  const el = document.createElement('div');
  el.className = `node k-${n.kind}` + (selId === n.id ? ' sel' : '');
  el.style.left = (n.x + OX) + 'px'; el.style.top = (n.y + OY) + 'px';
  el.dataset.id = n.id;
  el.dataset.sig = nodeSig(n);
  if (n.draft) el.classList.add('draft');
  el.title = '双击打开右栏：改名字、和 agent 聊这张卡';
  el.innerHTML = `
    <div class="hd">
      <span class="kind">${k.label}${n.seed ? ' · 起草中' : ''}</span>
      <div class="t">${esc(n.title)}</div>
      <div class="st ${n.status}">${statusDot(n)}</div>
    </div>
    <div class="body" data-ph="${esc(k.ph)}">${esc(n.body)}</div>
    ${modsHTML(n)}
    <div class="ft">
      <div class="checks">${(n.checks || []).map(c => `<span class="chip">${esc(c)}</span>`).join('')}${n.preview ? `<span class="chip pvchip" title="这张卡有只读预演的结论（左栏 / 测试里看）">预演 ✓</span>` : ''}</div>
      ${implOf(n) ? '<span class="gar" data-act="impl" title="内部实现已封装：卡片上不显示，点开看">⚙</span>' : ''}
      <span class="mini" data-act="ask" title="在右栏问 agent 这张卡">? 问</span>
      <span class="mini" data-act="opt" title="让 agent 给下一步候选，选一个加进流程">✦ 下一步</span>
      <span class="mini" data-act="link" title="拖到另一张卡建立连线">↗ 连线</span>
    </div>`;

  el.querySelector('[data-act="link"]').addEventListener('click', ev => { ev.stopPropagation(); startLink(n, el); });
  el.querySelector('[data-act="ask"]').addEventListener('click', ev => { ev.stopPropagation(); openCard(n); chatAsk('review'); });
  el.querySelector('[data-act="opt"]').addEventListener('click', ev => { ev.stopPropagation(); openCard(n); chatAsk('next'); });
  const gar = el.querySelector('[data-act="impl"]');
  if (gar) gar.addEventListener('click', ev => {
    ev.stopPropagation(); openCard(n);
    const d = document.querySelector('.panel details.internal');
    if (d) { d.open = true; d.scrollIntoView({ block: 'center' }); }
  });
  el.addEventListener('dblclick', e => {
    if (e.target.closest('.mini') || e.target.closest('.gar')) return;
    openCard(n); const i = $('#chatIn'); if (i) i.focus();
  });
  // 插在加工卡里的模块：悬停 = 亮出它是从哪张卡接进来的；按住拖出这张卡 = 断开
  el.querySelectorAll('.mod.plug').forEach(c => {
    const key = plugKey(n.id, c);
    c.addEventListener('mouseenter', () => peer(c.dataset.src, key, true));
    c.addEventListener('mouseleave', () => peer(c.dataset.src, key, false));
  });
  el.addEventListener('pointerdown', e => {
    if (e.target.closest('.mini') || e.target.closest('.gar')) return;   // 卡片正文不可编辑：整张卡都能拖
    if (e.button !== 0) return;
    selId = n.id; markSel();                                             // 单击/拖动只选中，双击才开卡片信息
    const plug = e.target.closest('.mod.plug');
    if (plug) unplugDrag(e, n, el, plug); else dragCard(e, n, el);
  });
  return el;
}

function modsHTML(n) {
  const line = (lab, inner, cls = '') => `<div class="mline${cls}"><span class="mlab">${lab}</span><span class="mchips">${inner}</span></div>`;
  if (n.kind !== 'proc') {
    const ms = modsOf(n);
    return ms.length ? `<div class="mods">${line(MOD_T[KIND_MOD[n.kind]], ms.map(chipHTML).join(''))}</div>` : '';
  }
  const w = flow();
  const ups = w.edges.filter(([, b]) => b === n.id).map(([a]) => find(a)).filter(Boolean);
  const downs = w.edges.filter(([a]) => a === n.id).map(([, b]) => find(b)).filter(Boolean);
  const sock = (key, list, ph) => `<div class="sock ${list.length ? 'on' : 'empty'}" data-sock="${key}">` +
    `<div class="mline"><span class="mlab">${key === 'in' ? '素材' : '成果'}</span><span class="mchips" data-ph="${ph}">${list.map(s => plugChips(s, key)).join('')}</span></div></div>`;
  const tools = modsOf(n).filter(m => m.type === 'tool');      // 工具 = 模型 / 接口（带能力说明）
  const hows = modsOf(n).filter(m => m.type === 'how');        // 做法 = 排版、重画、逐张核对这类
  return `<div class="mods">${sock('in', ups, '拖输入卡进来')}${tools.length ? line('工具', tools.map(chipHTML).join(''), ' tools') : ''}${
    hows.length ? line('做法', hows.map(chipHTML).join(''), ' hows') : ''}${sock('out', downs, '拖输出卡进来')}</div>`;
}

function chipHTML(m) {
  // 模型/接口这类带能力说明的，后面挂一个小 ⓘ，悬停看「输入→输出 + 上下限」
  const tip = m.caps ? esc(m.name + '\n' + m.caps) : esc(m.name);
  return `<span class="mod t-${m.type}" title="${tip}" data-caps="${m.caps ? esc(m.caps) : ''}">${esc(m.name)}${m.caps ? '<i class="cap">ⓘ</i>' : ''}</span>`;
}
// 接进插槽的卡：它带的模块就是插在槽里的东西（没有模块就用卡名）
function plugChips(src, dir) {
  const ms = src.kind === 'proc' ? [] : modsOf(src);
  // 加工卡直接接加工卡：上一步交过来的是它的成果；没有模块就用卡名
  const list = ms.length ? ms : [{ type: src.kind === 'proc' ? 'res' : (KIND_MOD[src.kind] || 'mat'), name: src.title }];
  return list.map(m => `<span class="mod t-${m.type} plug" data-src="${src.id}" data-dir="${dir}" title="来自「${esc(src.title)}」：${esc(m.name)}">${esc(m.name)}</span>`).join('');
}

function plugChips(src, dir) {
  const ms = src.kind === 'proc' ? [] : modsOf(src);
  // 加工卡直接接加工卡：上一步交过来的是它的成果；没有模块就用卡名
  const list = ms.length ? ms : [{ type: src.kind === 'proc' ? 'res' : (KIND_MOD[src.kind] || 'mat'), name: src.title }];
  return list.map(m => `<span class="mod t-${m.type} plug" data-src="${src.id}" data-dir="${dir}" title="来自「${esc(src.title)}」：${esc(m.name)}">${esc(m.name)}</span>`).join('');
}

function plugKey(procId, chip) { return chip.dataset.dir === 'in' ? `${chip.dataset.src}>${procId}` : `${procId}>${chip.dataset.src}`; }
function peer(srcId, key, on) {
  const s = canvas.querySelector(`.node[data-id="${srcId}"]`); if (s) s.classList.toggle('peer', on);
  const p = edgesSvg.querySelector(`path[data-k="${key}"]`); if (p) p.classList.toggle('hl', on);
}

function peer(srcId, key, on) {
  const s = canvas.querySelector(`.node[data-id="${srcId}"]`); if (s) s.classList.toggle('peer', on);
  const p = edgesSvg.querySelector(`path[data-k="${key}"]`); if (p) p.classList.toggle('hl', on);
}

function statusDot(n) { return ({ running: '●', ok: '✓', warn: '!', fail: '✕', ready: '▶' })[n.status] || ''; }

function drawEdges() {
  const w = flow(); if (!w) return;
  const cr = canvas.getBoundingClientRect();
  const P = (x, y) => [(x - cr.left) / zoom, (y - cr.top) / zoom];
  // 端点：加工卡接在插槽上（素材在左、成果在右）；输入/输出卡接在自己的模块行上
  const end = (el, n, side) => {
    const r = el.getBoundingClientRect();
    const ref = n && n.kind === 'proc' ? el.querySelector(`.sock[data-sock="${side}"]`) : el.querySelector('.mods');
    const rr = ref ? ref.getBoundingClientRect() : r;
    return P(side === 'out' ? r.right : r.left, rr.top + rr.height / 2);
  };
  let h = `<defs><marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 z" fill="rgba(17,17,17,.42)"/></marker></defs>`;
  for (const [a, b] of w.edges) {
    const ea = canvas.querySelector(`.node[data-id="${a}"]`), eb = canvas.querySelector(`.node[data-id="${b}"]`);
    if (!ea || !eb) continue;
    const [x1, y1] = end(ea, find(a), 'out'), [x2, y2] = end(eb, find(b), 'in');
    const mx = (x1 + x2) / 2;
    h += `<path class="edge" data-k="${a}>${b}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="rgba(17,17,17,.30)" stroke-width="1.6" marker-end="url(#ar)"/>`;
  }
  edgesSvg.innerHTML = h;
}

function drawEdges() {
  const w = flow(); if (!w) return;
  const cr = canvas.getBoundingClientRect();
  const P = (x, y) => [(x - cr.left) / zoom, (y - cr.top) / zoom];
  // 端点：加工卡接在插槽上（素材在左、成果在右）；输入/输出卡接在自己的模块行上
  const end = (el, n, side) => {
    const r = el.getBoundingClientRect();
    const ref = n && n.kind === 'proc' ? el.querySelector(`.sock[data-sock="${side}"]`) : el.querySelector('.mods');
    const rr = ref ? ref.getBoundingClientRect() : r;
    return P(side === 'out' ? r.right : r.left, rr.top + rr.height / 2);
  };
  let h = `<defs><marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 z" fill="rgba(17,17,17,.42)"/></marker></defs>`;
  for (const [a, b] of w.edges) {
    const ea = canvas.querySelector(`.node[data-id="${a}"]`), eb = canvas.querySelector(`.node[data-id="${b}"]`);
    if (!ea || !eb) continue;
    const [x1, y1] = end(ea, find(a), 'out'), [x2, y2] = end(eb, find(b), 'in');
    const mx = (x1 + x2) / 2;
    h += `<path class="edge" data-k="${a}>${b}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="rgba(17,17,17,.30)" stroke-width="1.6" marker-end="url(#ar)"/>`;
  }
  edgesSvg.innerHTML = h;
}

function dragCard(e, n, el) {
  const wr = wrap.getBoundingClientRect();
  // 指针 → 画布坐标（含滚动与缩放），拖动时滚动自动滚也跟手
  const toCanvas = p => ({ x: (p.clientX - wr.left + wrap.scrollLeft) / zoom, y: (p.clientY - wr.top + wrap.scrollTop) / zoom });
  const clampX = v => Math.max(-ORIGIN.x + 8, Math.min(CANVAS.w - ORIGIN.x - el.offsetWidth - 8, v));
  const clampY = v => Math.max(-ORIGIN.y + 8, Math.min(CANVAS.h - ORIGIN.y - el.offsetHeight - 8, v));
  const start = toCanvas(e);
  const from = { x: n.x, y: n.y };
  const grab = { x: n.x - (start.x - ORIGIN.x), y: n.y - (start.y - ORIGIN.y) };
  el.style.transformOrigin = `${-grab.x}px ${-grab.y}px`;   // 靠近插槽时以指针为中心缩成一个小块
  // 小块浮在指针正上方（水平居中、底边离指针 14px），不挡住插槽里预览的模块
  const S = 0.46;
  el.style.setProperty('--dx', ((-grab.x - el.offsetWidth / 2) * S) + 'px');
  el.style.setProperty('--dy', (-((el.offsetHeight + grab.y) * S + 14)) + 'px');
  let last = { clientX: e.clientX, clientY: e.clientY };
  let raf = 0, moved = false, dock = null;
  // 插槽反馈：加工卡亮起，目标插槽高亮并预览要插进去的模块，另一个插槽变淡
  const clearDock = () => {
    if (!dock) return;
    el.classList.remove('docking');
    dock.pe.classList.remove('dock-target');
    dock.pe.querySelectorAll('.sock').forEach(s => s.classList.remove('hot', 'dim', 'nope'));
    dock.pe.querySelectorAll('.mod.ghost').forEach(g => g.remove());
    dock = null;
  };
  const setDock = d => {
    if (d && dock && d.pn.id === dock.pn.id && d.sock === dock.sock && d.ok === dock.ok) return;
    clearDock();
    if (!d) return;
    dock = d;
    el.classList.add('docking');
    d.pe.classList.add('dock-target');
    d.pe.querySelectorAll('.sock').forEach(s => {
      if (s.dataset.sock !== d.sock) { s.classList.add('dim'); return; }
      s.classList.add(d.ok ? 'hot' : 'nope');
      if (d.ok) s.querySelector('.mchips').insertAdjacentHTML('beforeend', ghostChips(n));
    });
  };
  const place = ev => {
    last = { clientX: ev.clientX, clientY: ev.clientY };
    const c = toCanvas(last);
    n.x = clampX(c.x - ORIGIN.x + grab.x);
    n.y = clampY(c.y - ORIGIN.y + grab.y);
    el.style.left = (n.x + OX) + 'px'; el.style.top = (n.y + OY) + 'px';
    if (!moved && Math.hypot(last.clientX - e.clientX, last.clientY - e.clientY) > 3) { moved = true; el.classList.add('dragging'); }
    if (moved) setDock(findDock(n, el, last.clientX, last.clientY));
    drawEdges();
  };
  // 贴住视口边框时自动滚，卡片就不会被「看不见的框」挡住
  const EDGE = 80, SPEED = 22;
  const tick = () => {
    raf = 0;
    const r = wrap.getBoundingClientRect();
    const dx = last.clientX - r.left, dy = last.clientY - r.top;
    let vx = 0, vy = 0;
    if (dx < EDGE) vx = -((EDGE - dx) / EDGE) * SPEED;
    else if (dx > r.width - EDGE) vx = ((dx - (r.width - EDGE)) / EDGE) * SPEED;
    if (dy < EDGE) vy = -((EDGE - dy) / EDGE) * SPEED;
    else if (dy > r.height - EDGE) vy = ((dy - (r.height - EDGE)) / EDGE) * SPEED;
    if (vx || vy) {
      wrap.scrollLeft += vx; wrap.scrollTop += vy;
      place(last);
      raf = requestAnimationFrame(tick);
    }
  };
  const wake = () => { if (!raf) raf = requestAnimationFrame(tick); };
  const move = ev => { place(ev); wake(); };
  // 松手后如果卡片被拖到视口外，把画布滚一点让它回到眼前，免得"拖丢了"
  const keepInView = () => {
    const r = el.getBoundingClientRect(), w = wrap.getBoundingClientRect(), pad = 28;
    if (r.left < w.left + pad) wrap.scrollLeft -= (w.left + pad - r.left);
    else if (r.right > w.right - pad) wrap.scrollLeft += (r.right - (w.right - pad));
    if (r.top < w.top + pad) wrap.scrollTop -= (w.top + pad - r.top);
    else if (r.bottom > w.bottom - pad) wrap.scrollTop += (r.bottom - (w.bottom - pad));
  };
  const up = () => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up);
    if (raf) cancelAnimationFrame(raf);
    el.classList.remove('dragging');
    if (dock) {                                  // 松手在插槽上：接进去；接不了就回到拖起的地方
      const d = dock, token = el.getBoundingClientRect();
      el.style.transition = 'none';              // CSS 过渡会压过 WAAPI，先关掉
      clearDock();
      if (d.ok) dockInto(n, d, token); else denyDock(n, el, d, from, token);
      return;
    }
    n.manual = true;                       // 人拖过：之后自动排版不再覆盖它的位置
    keepInView();
    saveStore(false);                       // 只是挪了位置：不产生版本（位置本来就不算内容改动）
  };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
  wake();
}

function startLink(from, fromEl) {
  fromEl.classList.add('linking');
  const ghost = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  ghost.setAttribute('stroke', '#ff5a1f'); ghost.setAttribute('stroke-width', '2');
  ghost.setAttribute('fill', 'none'); ghost.setAttribute('stroke-dasharray', '5 4');
  edgesSvg.appendChild(ghost);
  const cr = canvas.getBoundingClientRect();
  const ra = fromEl.getBoundingClientRect();
  const x1 = (ra.right - cr.left) / zoom, y1 = (ra.top - cr.top + ra.height / 2) / zoom;
  const move = ev => {
    const x2 = (ev.clientX - cr.left) / zoom, y2 = (ev.clientY - cr.top) / zoom;
    ghost.setAttribute('d', `M${x1},${y1} L${x2},${y2}`);
    document.querySelectorAll('.node').forEach(el => el.classList.toggle('target', el !== fromEl && hit(el, ev.clientX, ev.clientY)));
  };
  const up = ev => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up);
    ghost.remove(); fromEl.classList.remove('linking');
    const tgt = [...document.querySelectorAll('.node')].find(el => el !== fromEl && hit(el, ev.clientX, ev.clientY));
    document.querySelectorAll('.node').forEach(el => el.classList.remove('target'));
    if (tgt) connect(from.id, tgt.dataset.id);
  };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
}

function hit(el, x, y) { const r = el.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }

// ---------- 拖卡接入：把卡片拖进加工卡的插槽 = 连线 ----------
// 输入卡只插「素材」；输出卡看离哪个插槽近：插「素材」= 它交出的东西给这一步当素材，插「成果」= 这一步交出它
function findDock(n, el, x, y) {
  if (n.kind !== 'in' && n.kind !== 'out') return null;
  const w = flow();
  for (const pe of canvas.querySelectorAll('.node.k-proc')) {
    if (pe === el) continue;
    const r = pe.getBoundingClientRect(), m = 14 * zoom;
    if (x < r.left - m || x > r.right + m || y < r.top - m || y > r.bottom + m) continue;
    const pn = find(pe.dataset.id); if (!pn) continue;
    let sock = 'in';
    if (n.kind === 'out') {
      const dist = k => { const s = pe.querySelector(`.sock[data-sock="${k}"]`); if (!s) return Infinity; const b = s.getBoundingClientRect(); return Math.abs(y - (b.top + b.height / 2)); };
      sock = dist('in') <= dist('out') ? 'in' : 'out';
    }
    const [a, b] = sock === 'in' ? [n.id, pn.id] : [pn.id, n.id];
    if (w.edges.some(([p, q]) => p === a && q === b)) return null;      // 已经接着：当普通拖动
    return { pn, pe, sock, a, b, ok: !reaches(b, a) };                  // b 能走回 a，再接就绕成圈了
  }
  return null;
}

// 排版也是主画布那份（列按深度、竖向居中、列宽 330、间距 40）
function layoutChain(w) {
  const depth = new Map(w.nodes.map(n => [n.id, 0]));
  for (let it = 0; it < w.nodes.length; it++) {
    let ch = false;
    for (const [a, b] of w.edges) { const d = depth.get(a) + 1; if (d > depth.get(b)) { depth.set(b, d); ch = true; } }
    if (!ch) break;
  }
  for (const n of w.nodes) {
    if (n.kind !== 'in') continue;
    const outs = w.edges.filter(([a]) => a === n.id).map(([, b]) => depth.get(b));
    if (outs.length) depth.set(n.id, Math.max(0, Math.min(...outs) - 1));
  }
  const cols = [];
  w.nodes.forEach((n, i) => { const d = depth.get(n.id); (cols[d] = cols[d] || []).push(n); n._i = i; });
  const pos = new Map();
  cols.forEach((col, d) => {
    if (!col) return;
    const bary = n => { const ps = w.edges.filter(([, b]) => b === n.id).map(([a]) => pos.get(a)).filter(v => v != null); return ps.length ? ps.reduce((s, v) => s + v, 0) / ps.length : 1e3 + n._i; };
    if (d > 0) col.sort((a, b) => bary(a) - bary(b) || a._i - b._i);
    col.forEach((n, i) => pos.set(n.id, i));
  });
  const COLW = 330, GAP = 40;
  w.nodes.forEach(n => { n.x = depth.get(n.id) * COLW; n.y = 0; delete n._i; });
  render();
  const h = n => { const e = canvas.querySelector(`.node[data-id="${n.id}"]`); return e ? e.offsetHeight : 200; };
  const heights = cols.map(col => col ? col.reduce((s, n) => s + h(n), 0) + GAP * (col.length - 1) : 0);
  const tall = Math.max(0, ...heights);
  cols.forEach((col, d) => {
    if (!col) return;
    let y = Math.round((tall - heights[d]) / 2);
    col.forEach(n => {
      n.y = y; y += h(n) + GAP;
      const e = canvas.querySelector(`.node[data-id="${n.id}"]`); if (e) e.style.top = (n.y + OY) + 'px';
    });
  });
  drawEdges();
}
