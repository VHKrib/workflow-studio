// 独立实时画布（只读）：选一条正在跑的 Hermes 对话，跟着它的动作长出链路卡。
//
// 这个窗口只有读：
// - 数据由主进程只读读会话库（sqlite3 -readonly + mode=ro）后推过来，这里不碰任何文件、不写任何状态；
// - 开关状态与选中的对话记在主进程（关掉窗口再开还在），这里只管显示；
// - 关掉这个窗口不影响主窗口；关主窗口时它跟着关（窗口归属在主进程里设的）。
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const canvas = $('#canvas'), edgesSvg = $('#edges'), wrap = $('#wrap');
const ORIGIN = { x: 6000, y: 4000 }, OX = ORIGIN.x, OY = ORIGIN.y;
const KIND = { in: '输入', proc: '加工', out: '输出' };
const GAP = 36;

let zoom = 1, lastZoom = 1;
let list = [];
let cur = '';              // 当前对话的 key：岗位:会话id
let following = false;
let doc = null;
let pos = new Map();       // 卡 id → {x, y, w, h}（画布坐标，含 ORIGIN）
let fitted = false;

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const pad2 = n => String(n).padStart(2, '0');
const hhmmss = t => { const d = new Date(t || Date.now()); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); };
const whenOf = t => {
  if (!t) return '更早';
  const d = new Date(t), n = new Date(), day = 86400000;
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  if (same(d, n)) return '今天 ' + hm;
  if (same(d, new Date(n.getTime() - day))) return '昨天 ' + hm;
  return (pad2(d.getMonth() + 1)) + '-' + pad2(d.getDate()) + ' ' + hm;
};

// ---------- 顶栏：选对话 + 跟随开关 ----------
function paintList() {
  const sel = $('#lconv');
  const opts = list.map(c => `<option value="${esc(c.key)}">${esc(c.who)} · ${esc(whenOf(c.at))} · ${esc(c.doing)}</option>`);
  sel.innerHTML = opts.length ? opts.join('') : '<option value="">（最近没有可读的对话）</option>';
  if (cur && list.some(c => c.key === cur)) sel.value = cur;
  else if (list.length) { cur = list[0].key; sel.value = cur; }
}
async function loadList() {
  try { const l = await window.tcflow.liveList(); list = Array.isArray(l) ? l : []; } catch (e) { list = []; }
  paintList();
  return list;
}
function setStat(text) { $('#lstat').textContent = text; }
const statusWord = s => ({
  done: '', failed: '失败', doing: '正在做', unfinished: '没找到产出', proposed: '未执行', pending: '待确认',
}[s] || '');
// 原因标签上不露证据号（「你说 7425「…」」→「你说「…」」），证据本来就在内部实现里
const humanNote = s => String(s || '')
  .replace(/(用户|你说|人说|消息|人在|第)\s*\d{3,}\s*[「:：，,]?\s*/g, '$1')
  .replace(/\b\d{3,}\b\s*/g, '')                     // 光秃秃的证据号（内部实现里有）
  .replace(/[「」]/g, '')                            // 只剩单边的引号不好看，去掉装饰引号
  .replace(/[，,：:\s]+(?=[「])/g, '')
  .replace(/^[，,：:\s]+|[，,：:\s]+$/g, '')
  .trim();
function paintEmpty() {
  const empty = !doc || !doc.cards || !doc.cards.length;
  $('#lempty').classList.toggle('off', !empty);
  if (empty) $('#lempty').textContent = cur ? (following ? '正在读这条对话…' : '打开「跟随」开始直播') : '选一条对话，再打开「跟随」';
}
function paintStat() {
  if (!doc || !doc.conv) { setStat(cur ? '等第一条消息…' : ''); return; }
  const n = (doc.cards || []).length;
  if (!n) { setStat(following ? '跟随中 · 还没解析' : '已暂停 · 还没解析'); return; }
  setStat(`已解析：${n} 张卡${doc.name ? ' · ' + doc.name : ''}`);
}

// 三栏实体：素材 / 实现路径 / 结果。同名只涨计数，不重复占位——这条链路里真正反复用的是这些。
function paintEnts(d) {
  const box = $('#lents');
  if (!box) return;
  const e = (d && d.entities) || {};
  const seg = (label, arr) => {
    if (!arr || !arr.length) return '';
    const chips = arr.slice(0, 6).map(x => `<i title="${esc(x.name)}">${esc(x.name)}<em>×${x.n}</em></i>`).join('');
    return `<span class="lseg"><b>${label}</b>${chips}</span>`;
  };
  const html = seg('素材', e.materials) + seg('实现路径', e.paths) + seg('结果', e.results);
  if (box.dataset.html === html) return;
  box.dataset.html = html;
  box.innerHTML = html;
  box.classList.toggle('off', !html);
}

// 解析链路的状态：让平台主管把这条对话解析成「用到的文件 → 加工方式 → 产出的文件」。
// 解析结果取代「按消息机械归并」的粗版；解析失败就继续显示粗版，不空白。
let analyzing = false, lastAnalyzed = 0, analyzedKey = '';
const ANALYZE_EVERY = 25000;          // 跟随中最多每 25 秒重新解析一次
const ANALYZE_MIN_MSGS = 4;           // 少于这个数不值得调模型

async function analyzeNow(manual) {
  if (analyzing || !cur) return;
  const found = list.find(c => c.key === cur);
  if (!found || !window.tcflow.liveAnalyze) return;
  analyzing = true;
  const btn = document.querySelector('#lana');
  if (btn) { btn.disabled = true; btn.textContent = '解析中…'; }
  try {
    const r = await window.tcflow.liveAnalyze({ profile: found.profile, session: found.session, topic: found.doing });
    if (r && r.ok && r.doc && r.doc.cards.length) {
      fitted = false;
      renderDoc(r.doc, { analyzed: true });
      analyzedKey = cur;
      setStat(`已解析：${r.doc.cards.length} 张卡${r.name ? ' · ' + r.name : ''}`);
    } else {
      setStat('解析没成：' + ((r && r.error) || '未知原因'));
    }
  } catch (e) {
    setStat('解析失败：' + (e && e.message || e));
  } finally {
    analyzing = false; lastAnalyzed = Date.now();
    if (btn) { btn.disabled = false; btn.textContent = '解析链路'; }
  }
}

async function pick(key) {
  if (!key || key === cur) return;
  const found = list.find(c => c.key === key);
  if (!found) return;
  cur = key;
  doc = null; fitted = false; pos.clear(); analyzedKey = ''; lastAnalyzed = 0;
  canvas.querySelectorAll('.node').forEach(el => el.remove());   // 换对话：旧内容一点不留
  edgesSvg.innerHTML = '';
  paintEmpty(); paintStat();
  if (following) { await follow(true); return; }
  await stopFollow();
  const r = await window.tcflow.liveSnapshot({ profile: found.profile, session: found.session });
  if (r && r.doc) renderDoc(r.doc);
  else if (r && r.error) setStat(r.error);
  paintEmpty();
}

async function follow(on) {
  following = !!on;
$('#lfol').checked = following;
  const found = list.find(c => c.key === cur);
  if (!cur || !found) { paintStat(); return; }
  const r = await window.tcflow.liveFollow({ profile: found.profile, session: found.session, on: following });
  if (r && r.doc) renderDoc(r.doc, { fromTick: true });
  paintStat(); paintEmpty();
  maybeAnalyze();
}
function maybeAnalyze() {
  if (analyzing || !following || !cur) return;
  const n = doc && doc.stats ? (doc.stats.messages || 0) : 0;
  if (n < ANALYZE_MIN_MSGS) return;
  if (analyzedKey === cur && Date.now() - lastAnalyzed < ANALYZE_EVERY) return;
  setTimeout(() => analyzeNow(false), 500);
}

async function stopFollow() {
  const found = list.find(c => c.key === cur);
  following = false;
  $('#lfol').checked = false;
  if (found) await window.tcflow.liveFollow({ profile: found.profile, session: found.session, on: false });
  paintStat();
}

// ---------- 画布 ----------
function applyZoom() {
  const cw = wrap.clientWidth, ch = wrap.clientHeight;
  const changed = zoom !== lastZoom;
  const cx = (wrap.scrollLeft + cw / 2) / lastZoom, cy = (wrap.scrollTop + ch / 2) / lastZoom;
  canvas.style.transformOrigin = '0 0';
  canvas.style.transform = `scale(${zoom})`;
  if (changed && cw && ch) { wrap.scrollLeft = cx * zoom - cw / 2; wrap.scrollTop = cy * zoom - ch / 2; }
  lastZoom = zoom;
  $('#zoom').textContent = Math.round(zoom * 100) + '%';
}

// 卡片长相对齐主画布（同一个 .node 结构：头部 kind+标题+状态点、正文、模块行、底部 chips）
// 区别只有一点：这个窗口只读，所以没有「问 / 下一步 / 连线」那几个按钮，也不能拖进插槽。
const KIND_LABEL = { in: '输入', proc: '加工', out: '输出' };
const KIND_PH = { in: '这一步要先有什么', proc: '这一步让人做什么', out: '最后交出什么' };
const MOD_LAB = { in: '素材', proc: '工具', out: '成果' };
const MOD_TYPE = { in: 'mat', proc: 'tool', out: 'res' };

// 卡面三块和主画布同一套含义：素材 / 工具 / 成果（由真实边反推，都在 doc.cards[].mods 里）
const MOD_LABEL = { mat: '素材', tool: '工具', res: '成果' };
function modsRow(c) {
  const ms = Array.isArray(c.mods) ? c.mods : [];
  if (!ms.length) return '';
  const order = c.kind === 'in' ? ['mat'] : c.kind === 'out' ? ['res'] : ['mat', 'tool', 'res'];
  const lines = order.map(t => {
    const list = ms.filter(m => m.type === t);
    if (!list.length) return '';
    return `<div class="mline"><span class="mlab">${MOD_LABEL[t]}</span><span class="mchips">${list.map(m => `<span class="mod t-${t}">${esc(m.name)}</span>`).join('')}</span></div>`;
  }).join('');
  return lines ? `<div class="mods">${lines}</div>` : '';
}

function cardEl(c) {
  const el = document.createElement('div');
  el.className = 'node k-' + c.kind;
  el.dataset.id = c.id;
  el.innerHTML = `
    <div class="hd"><span class="kind">${KIND_LABEL[c.kind] || '加工'}</span><div class="t">${esc(c.title)}</div><div class="st"></div></div>
    <div class="body" data-ph="${KIND_PH[c.kind] || ''}">${esc(c.body)}</div>
    ${modsRow(c)}
    <div class="ft"><div class="checks"></div>${c.impl ? '<span class="gar" title="内部实现已封装：卡片上不显示，点开看">⚙</span>' : ''}</div>
    ${c.impl ? `<details class="limpl"><summary>⚙ 内部实现</summary><pre>${esc(c.impl)}</pre></details>` : ''}`;
  const d = el.querySelector('details.limpl');
  if (d) d.addEventListener('toggle', () => { layout(); drawEdges(); });
  return el;
}

const sigOf = c => JSON.stringify([c.kind, c.title, c.body, c.impl, (c.mods || []).map(m => m.type + ':' + m.name)]);

function renderDoc(d, opts) {
  if (!d || !Array.isArray(d.cards)) return;
  // 已经解析出正式链路，就别让「按消息粗归并」的版本把它盖掉（解析结果自己带 opts.analyzed）
  if (analyzedKey && analyzedKey === cur && !(opts && opts.analyzed)) return;
  const switched = doc && doc.conv && d.conv && doc.conv.key !== d.conv.key;
  const before = (doc && doc.cards || []).length;
  doc = d;
  if (switched) { fitted = false; canvas.querySelectorAll('.node').forEach(el => el.remove()); edgesSvg.innerHTML = ''; }

  const live = new Map([...canvas.querySelectorAll('.node')].map(el => [el.dataset.id, el]));
  const keep = new Set();
  for (const c of d.cards) {
    keep.add(c.id);
    const sig = sigOf(c);
    const old = live.get(c.id);
    if (!old) { const el = cardEl(c); el.dataset.sig = sig; canvas.appendChild(el); continue; }
    if (old.dataset.sig !== sig) { const el = cardEl(c); el.dataset.sig = sig; old.replaceWith(el); }
  }
  for (const [id, el] of live) if (!keep.has(id)) el.remove();

  layout();
  if (!fitted && d.cards.length) { fit(); fitted = true; }
  else if (d.cards.length > before) keepLastInView();
  drawEdges();
  paintStat(); paintEmpty(); paintEnts(d);
}

// 排布：按「从入口走了几步」分列，同一列上下堆。分叉自然在同一列错开，读成树枝。
// 「改」和「新版」是回指/版本链，不推后一列（否则同一文件的新版本会被推到很远的右边）。
function layout() {
  const COLW = 340, ROWGAP = 26, MAXBAND = 1500, GAPY = 160;
  pos.clear();
  const cards = doc ? doc.cards : [];
  if (!cards.length) return;
  const byId = new Map(cards.map(c => [c.id, c]));
  const ids = cards.map(c => c.id);
  // 每一段（互不相干的一截）单独排，按段上下分开——不硬连成一条长蛇
  const segs = ((doc.segments && doc.segments.length) ? doc.segments : [ids])
    .map(s => s.filter(id => byId.has(id))).filter(s => s.length);
  let top = 0;
  for (const seg of segs) {
    const inSeg = new Set(seg);
    const outE = new Map(seg.map(i => [i, []]));
    const indeg = new Map(seg.map(i => [i, 0]));
    for (const e of (doc.edges || [])) {
      const [a, b, k] = e;
      if (!inSeg.has(a) || !inSeg.has(b) || a === b) continue;
      if (k === 'revise' || k === 'evolve') continue;
      outE.get(a).push(b);
      indeg.set(b, (indeg.get(b) || 0) + 1);
    }
    // 层数用**最短**路径算，不用最长：有环时最长会一直把卡片往右推（实测一张卡被推到第 296 列）
    const depth = new Map();
    const queue = seg.filter(i => (indeg.get(i) || 0) === 0);
    if (!queue.length) queue.push(seg[0]);
    for (const i of queue) depth.set(i, 0);
    while (queue.length) {
      const i = queue.shift();
      for (const j of outE.get(i) || []) if (!depth.has(j)) { depth.set(j, (depth.get(i) || 0) + 1); queue.push(j); }
    }
    for (const i of seg) if (!depth.has(i)) depth.set(i, 0);
    const maxD = Math.max(0, ...seg.map(i => depth.get(i)));
    const colY = new Map();
    let band = 0, bottom = 0;
    for (const id of seg) {
      const el = canvas.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
      if (!el) continue;
      const d = depth.get(id) || 0;
      const h = el.offsetHeight || 150;
      let key = band + ':' + d;
      let y = colY.get(key) || 0;
      if (y + h > MAXBAND) { band++; key = band + ':' + d; y = 0; }   // 一列太高：本段里另起一条带
      const x = d * COLW + band * (maxD + 1.5) * COLW;
      el.style.left = (x + OX) + 'px';
      el.style.top = (top + y + OY) + 'px';
      pos.set(id, { x: x + OX, y: top + y + OY, w: el.offsetWidth || 244, h });
      colY.set(key, y + h + ROWGAP);
      bottom = Math.max(bottom, y + h);
    }
    top += bottom + GAPY;
  }
}


// 四种关系都画成真线（不是写在文字里）：
// use 用的材料/旧产物 → 加工（实线）；make 加工 → 产物（实线）；revise 看了哪一版才改（橘色虚线 + 「改」）；
// evolve 同一个文件的新版本（紫色细线 + 「vN」）。
const EDGE_STYLE = {
  use: { stroke: 'rgba(17,17,17,.30)', width: 1.6, dash: '', label: '' },
  make: { stroke: 'rgba(17,17,17,.34)', width: 1.8, dash: '', label: '' },
  revise: { stroke: 'rgba(255,90,31,.62)', width: 1.6, dash: '5 4', label: '改' },
  evolve: { stroke: 'rgba(122,86,168,.5)', width: 1.4, dash: '2 3', label: '新版' },
};
function drawEdges() {
  if (!doc) return;
  const end = id => pos.get(id);
  let h = `<defs><marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 z" fill="rgba(17,17,17,.42)"/></marker>` +
    `<marker id="ar-or" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 z" fill="rgba(255,90,31,.75)"/></marker></defs>`;
  for (const e of (doc.edges || [])) {
    const [a, b, k] = e;
    const st = EDGE_STYLE[k] || EDGE_STYLE.use;
    const pa = end(a), pb = end(b);
    if (!pa || !pb) continue;
    const forward = pb.x > pa.x + pa.w - 20;
    const x1 = forward ? pa.x + pa.w : pa.x + pa.w / 2;
    const y1 = forward ? pa.y + pa.h / 2 : pa.y + pa.h;
    const x2 = forward ? pb.x : pb.x + pb.w / 2;
    const y2 = forward ? pb.y + pb.h / 2 : pb.y;
    const dx = Math.max(50, Math.abs(x2 - x1) / 2);
    const d = forward
      ? `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`
      : (k === 'revise' || k === 'evolve')
        // 「改」「新版」是往回指的：从上一版的底部绕到加工卡/新版卡的上方，别和材料流混在一起
        ? `M${pa.x + pa.w / 2},${pa.y} C${pa.x + pa.w / 2 - 90},${pa.y - 60} ${pb.x + pb.w / 2 + 90},${pb.y + pb.h + 60} ${pb.x + pb.w / 2},${pb.y + pb.h}`
        : `M${x1},${y1} C${x1},${y1 + 70} ${x2},${y2 - 70} ${x2},${y2}`;
    h += `<path class="edge e-${k || 'use'}" d="${d}" fill="none" stroke="${st.stroke}" stroke-width="${st.width}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''} marker-end="url(#${k === 'revise' ? 'ar-or' : 'ar'})"/>`;
    if (st.label) {
      const lx = forward ? (x1 + x2) / 2 : pa.x + pa.w / 2 - 18;
      const ly = forward ? (y1 + y2) / 2 - 6 : pa.y - 10;
      h += `<text class="elab ${k}" x="${lx}" y="${ly}" font-size="10" fill="${st.stroke}">${st.label}</text>`;
    }
  }
  edgesSvg.innerHTML = h;
}

function bbox() {
  const ps = [...pos.values()];
  if (!ps.length) return null;
  return {
    x0: Math.min(...ps.map(p => p.x)), y0: Math.min(...ps.map(p => p.y)),
    x1: Math.max(...ps.map(p => p.x + p.w)), y1: Math.max(...ps.map(p => p.y + p.h)),
  };
}
function fit() {
  const b = bbox(); if (!b) return;
  const pad = 60, W = wrap.clientWidth, H = wrap.clientHeight;
  const need = Math.min(W / (b.x1 - b.x0 + 2 * pad), H / (b.y1 - b.y0 + 2 * pad));
  zoom = Math.max(0.42, Math.min(1, Math.floor(need * 20) / 20));    // 太小的缩放字看不清：宁可超出视口让人平移
  applyZoom();
  const wide = (b.x1 - b.x0 + 2 * pad) * zoom > W, tall = (b.y1 - b.y0 + 2 * pad) * zoom > H;
  // pos 里的坐标已经含 ORIGIN 了，这里不要再加一次（加了会整体滚出 6000*zoom，画面一片空）
  wrap.scrollLeft = wide ? Math.max(0, (b.x0 - pad) * zoom) : Math.max(0, ((b.x0 + b.x1) / 2) * zoom - W / 2);
  wrap.scrollTop = tall ? Math.max(0, (b.y0 - pad) * zoom) : Math.max(0, ((b.y0 + b.y1) / 2) * zoom - H / 2);
}
// 长卡时视野跟着走：最新那张卡不在视口里就滚过去（不折缩放，不打扰人）
function keepLastInView() {
  if (!doc || !doc.cards.length) return;
  const last = pos.get(doc.cards[doc.cards.length - 1].id);
  if (!last) return;
  const wr = wrap.getBoundingClientRect();
  const sl = last.x * zoom, st = last.y * zoom, sr = (last.x + last.w) * zoom, sb = (last.y + last.h) * zoom;
  const pad = 40;
  if (sl < wrap.scrollLeft + pad) wrap.scrollLeft = Math.max(0, sl - pad);
  else if (sr > wrap.scrollLeft + wr.width - pad) wrap.scrollLeft = sr - wr.width + pad;
  if (st < wrap.scrollTop + pad) wrap.scrollTop = Math.max(0, st - pad);
  else if (sb > wrap.scrollTop + wr.height - pad) wrap.scrollTop = sb - wr.height + pad;
}

function bindCanvas() {
  let panning = false, sx = 0, sy = 0, ox = 0, oy = 0;
  wrap.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('.node')) return;
    panning = true; sx = e.clientX; sy = e.clientY; ox = wrap.scrollLeft; oy = wrap.scrollTop;
    wrap.classList.add('panning');
  });
  addEventListener('pointermove', e => {
    if (!panning) return;
    wrap.scrollLeft = ox - (e.clientX - sx);
    wrap.scrollTop = oy - (e.clientY - sy);
  });
  addEventListener('pointerup', () => { panning = false; wrap.classList.remove('panning'); });
  wrap.addEventListener('wheel', e => {
    if (!e.metaKey && !e.ctrlKey) return;
    e.preventDefault();
    zoom = Math.min(1.8, Math.max(0.3, zoom - e.deltaY * 0.0015));
    applyZoom(); drawEdges();
  }, { passive: false });
  $('#zoomIn').onclick = () => { zoom = Math.min(1.8, zoom + 0.1); applyZoom(); drawEdges(); };
  $('#lana').onclick = () => analyzeNow(true);   // 常驻在这里，别塞进 follow()（不然不拨开关就点不动）
  $('#zoomOut').onclick = () => { zoom = Math.max(0.3, zoom - 0.1); applyZoom(); drawEdges(); };
  $('#zoomReset').onclick = () => { zoom = 1; applyZoom(); fit(); drawEdges(); };
  addEventListener('resize', () => { drawEdges(); });
}

async function init() {
  bindCanvas();
  $('#lconv').addEventListener('pointerdown', () => loadList());
  $('#lconv').addEventListener('change', e => {
    const key = e.target.value;
    const found = list.find(c => c.key === key);
    if (!found) return;
    cur = '';                                        // 让 pick() 认为这次是换对话
    pick(key);
  });
  $('#lfol').addEventListener('change', e => follow(e.target.checked));
  window.tcflow.onLiveDoc(d => renderDoc(d));

  let st = {};
  try { st = await window.tcflow.liveState() || {}; } catch (e) { }
  await loadList();
  if (st.profile && st.session) {
    const key = st.profile + ':' + st.session;
    if (list.some(c => c.key === key)) { cur = key; $('#lconv').value = key; }
  }
  paintEmpty(); paintStat();
  if (st.on && cur) { await follow(true); }           // 重开窗口：选中的对话和开关都还在
  else if (st.on) { $('#lfol').checked = true; }
}
init();
