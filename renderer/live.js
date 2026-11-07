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
function paintEmpty() {
  const empty = !doc || !doc.cards || !doc.cards.length;
  $('#lempty').classList.toggle('off', !empty);
  if (empty) $('#lempty').textContent = cur ? (following ? '正在读这条对话…' : '打开「跟随」开始直播') : '选一条对话，再打开「跟随」';
}
function paintStat() {
  if (!doc || !doc.conv) { setStat(cur ? '等第一条消息…' : ''); return; }
  const n = (doc.cards || []).length;
  const skipped = (doc.stats && doc.stats.chatter) || 0;
  const tail = skipped ? ` · 忽略闲聊 ${skipped} 条` : '';
  setStat(`${n} 张卡 · ${following ? '跟到 ' + hhmmss(doc.at) : '已暂停'}${tail}`);
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
    const r = await window.tcflow.liveAnalyze({ profile: found.profile, session: found.session });
    if (r && r.ok && r.plan && r.plan.cards.length) {
      const d = {
        conv: { key: cur, who: found.who, doing: found.doing },
        at: doc ? doc.at : Math.floor(Date.now() / 1000),
        cards: r.plan.cards.map(c => ({ id: c.id, kind: c.kind, title: c.title, body: c.body, note: c.note || '', branch: c.branch || 'main', mods: c.mods || [], impl: c.impl || '', n: 1 })),
        edges: r.plan.edges || [],
        name: r.plan.name || '',
        entities: doc && doc.entities,
        stats: doc && doc.stats,
      };
      fitted = false;
      renderDoc(d, { analyzed: true });
      analyzedKey = cur;
      setStat(`已解析：${d.cards.length} 张卡${d.name ? ' · ' + d.name : ''}`);
    } else {
      setStat('解析没成：' + ((r && r.error) || '未知原因') + '（先看粗略版）');
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

function cardEl(c) {
  const el = document.createElement('div');
  el.className = 'node k-' + c.kind + (c.branch && c.branch !== 'main' ? ' branch' : '') + (/^点评/.test(c.title || '') ? ' review' : '');
  el.dataset.id = c.id;
  const type = MOD_TYPE[c.kind] || 'tool';
  const mods = (c.mods && c.mods.length)
    ? c.mods
    : String(c.body || '').split('·').map(x => x.trim()).filter(Boolean).slice(0, 4).map(name => ({ type, name }));
  const modsHTML = mods.length
    ? `<div class="mods"><div class="mline"><span class="mlab">${MOD_LAB[c.kind] || '模块'}</span>` +
      `<span class="mchips">${mods.map(m => `<span class="mod t-${m.type || type}">${esc(m.name)}</span>`).join('')}</span></div></div>`
    : '';
  const isReview = /^点评/.test(c.title || '');
  const chips = (isReview ? '<span class="chip rev">点评</span>' : '') +
    (c.note ? `<span class="chip" title="为什么改 / 和上一版差在哪">改 · ${esc(c.note)}</span>` : '');
  el.innerHTML = `
    <div class="hd"><span class="kind">${KIND_LABEL[c.kind] || '加工'}</span><div class="t">${esc(c.title)}</div><div class="st"></div></div>
    <div class="body" data-ph="${KIND_PH[c.kind] || ''}">${esc(c.body)}</div>
    ${modsHTML}
    <div class="ft"><div class="checks">${chips}</div>${c.impl ? '<span class="gar" title="内部实现已封装：卡片上不显示，点开看">⚙</span>' : ''}</div>
    ${c.impl ? `<details class="limpl"><summary>⚙ 内部实现</summary><pre>${esc(c.impl)}</pre></details>` : ''}`;
  const d = el.querySelector('details.limpl');
  if (d) d.addEventListener('toggle', () => { layout(); drawEdges(); });
  return el;
}


const sigOf = c => JSON.stringify([c.kind, c.title, c.body, c.impl, (c.mods || []).map(m => m.type + ':' + m.name), c.n]);

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

// 排布：一条链按顺序从左往右排，一行放不下或来了新的要求就换行（换行后仍是从左往右）。
// 这样「正在长的那张卡」永远在右下角，视野跟着它走时还能看见前几步；整条链也不会拉成一根细高的柱子。
function layout() {
  // 树形排布：按「从入口走了几步」分列，同一列里上下堆；分叉自然就在同一列上下错开。
  // 这样「同一素材换不同做法」会读成树枝，而不是被拍平成一条流水账。
  const COLW = 340, ROWGAP = 26;
  pos.clear();
  const cards = doc ? doc.cards : [];
  if (!cards.length) return;
  const ids = cards.map(c => c.id);
  const out = new Map(ids.map(i => [i, []]));
  const indeg = new Map(ids.map(i => [i, 0]));
  for (const [a, b] of (doc.edges || [])) {
    if (!out.has(a) || !out.has(b)) continue;
    out.get(a).push(b);
    indeg.set(b, (indeg.get(b) || 0) + 1);
  }
  // 深度：从没有入边的节点开始 BFS；环/孤岛兜底按顺序补
  const depth = new Map();
  const queue = ids.filter(i => (indeg.get(i) || 0) === 0);
  if (!queue.length) queue.push(ids[0]);
  for (const i of queue) depth.set(i, 0);
  while (queue.length) {
    const i = queue.shift();
    for (const j of out.get(i) || []) {
      const d = (depth.get(i) || 0) + 1;
      if (!depth.has(j) || depth.get(j) < d) { depth.set(j, d); queue.push(j); }
    }
  }
  ids.forEach((i, k) => { if (!depth.has(i)) depth.set(i, 0); });

  const byDepth = new Map();
  for (const c of cards) {
    const d = depth.get(c.id) || 0;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d).push(c);
  }
  for (const [d, list] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    let y = 0;
    for (const c of list) {
      const el = canvas.querySelector(`.node[data-id="${c.id}"]`);
      if (!el) continue;
      const x = d * COLW;
      el.style.left = (x + OX) + 'px';
      el.style.top = (y + OY) + 'px';
      const h = el.offsetHeight || 150;
      pos.set(c.id, { x: x + OX, y: y + OY, w: el.offsetWidth || 244, h });
      y += h + ROWGAP;
    }
  }
}


function drawEdges() {
  if (!doc) return;
  const end = id => pos.get(id);
  let h = `<defs><marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 z" fill="rgba(17,17,17,.42)"/></marker></defs>`;
  for (const [a, b] of doc.edges || []) {
    const pa = end(a), pb = end(b);
    if (!pa || !pb) continue;
    const forward = pb.x > pa.x + pa.w - 20;
    const x1 = forward ? pa.x + pa.w : pa.x + pa.w / 2;
    const y1 = forward ? pa.y + pa.h / 2 : pa.y + pa.h;
    const x2 = forward ? pb.x : pb.x + pb.w / 2;
    const y2 = forward ? pb.y + pb.h / 2 : pb.y;
    const dx = Math.max(50, Math.abs(x2 - x1) / 2);
    h += forward
      ? `<path class="edge" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}" fill="none" stroke="rgba(17,17,17,.30)" stroke-width="1.6" marker-end="url(#ar)"/>`
      : `<path class="edge" d="M${x1},${y1} C${x1},${y1 + 70} ${x2},${y2 - 70} ${x2},${y2}" fill="none" stroke="rgba(17,17,17,.30)" stroke-width="1.6" marker-end="url(#ar)"/>`;
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
  zoom = Math.max(0.3, Math.min(1, Math.floor(need * 20) / 20));
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
