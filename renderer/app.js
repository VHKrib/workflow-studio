'use strict';
const $ = (s, r = document) => r.querySelector(s);
const canvas = $('#canvas'), edgesSvg = $('#edges'), wrap = $('#wrap');
const LS_KEY = 'tcflow.v4';
const LEGACY_KEYS = ['tcflow.v3'];

// 卡片正文只说人话：要什么 / 做什么 / 交什么。
// 命令、路径、脚本、字段名收进 node.impl（内部实现），卡片面上不显示。
const KINDS = {
  in:   { label: '输入', cls: 'in',   ph: '这一步要先有什么（说人话，例：一个商品编号，加它现成的证据资料）' },
  proc: { label: '加工', cls: 'proc', ph: '这一步让人做什么（说人话，例：找到这个商品最新最全的那份证据）' },
  out:  { label: '输出', cls: 'out',  ph: '最后交出什么（说人话，例：一份能直接拿去用的证据目录）' },
};

let agents = [];
const USE_STREAM = true;   // true：真流式（Hermes 的边跑边出，但 CLI 流里没有思考正文）
                           // false：一次性文本模式（能拿到「思考」正文，但没有逐字效果）
const DOCK_AGENT = 'default';        // 右下角对话框固定对接「平台主管」（default profile）
let store = { workflows: [], current: null };
let selId = null;          // 只是选中（转盘/删除键用），不打开任何面板
let panelCardId = null;     // 右栏正在看哪张卡：只有双击卡片（或卡上的按钮）才会打开
let panelOpen = false;      // 没打开卡片时，右栏默认收起；点右侧「概览」才展开
const thinking = new Set(); // 正在等 agent 回答的卡片
let confirmAdd = null;      // 待用户确认的候选卡 {mi, oi}：agent 不能自己往画布上加东西
let dockOpen = true;        // 右下角对话框
let dockConfirm = null;     // 右下角对话框里的候选卡确认态
let dockThinking = false;
let seq = 1;
let zoom = 1;
// 无限画布：逻辑坐标 (0,0) 落在一块大画板的正中，左右上下各能拖 ORIGIN 那么远
const ORIGIN = { x: 6000, y: 4000 };
const CANVAS = { w: 12000, h: 8000 };   // 与 style.css 的 #canvas 一致
const OX = ORIGIN.x, OY = ORIGIN.y;
const uid = () => 'n' + (seq++) + '_' + Math.random().toString(36).slice(2, 6);
const flow = () => store.workflows.find(w => w.id === store.current);
const find = id => (flow() ? flow().nodes.find(n => n.id === id) : null);

// ---------- 说人话 / 内部实现 ----------
// 命中这些就当「代码调用」，不该出现在卡片正文里
const TECH_RE = /(`[^`]+`|\bhermes\s+-p|(?:^|\s)--[a-z][\w-]*|~\/|\/[\w.<>-]+(?:\/[\w.<>*_-]+)+|\b[\w-]+\.(?:json|jsonl|js|ts|py|sh|md|csv|ya?ml|xlsx|png)\b|\w+\(\)|\$\s|\b[A-Z][A-Z0-9_]{2,}\b)/;
function implOf(n) { return String((n && n.impl) || '').trim(); }
// 把一段文字拆成「人话正文」+「内部实现」；拆不动就原样留着，不硬切
function splitTech(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { body: '', impl: '' };
  const parts = raw.split(/(?<=[。；;！!？?\n])/).map(s => s.trim()).filter(Boolean);
  const human = [], tech = [];
  for (const p of parts) (TECH_RE.test(p) ? tech : human).push(p);
  const body = human.join('').trim();
  if (body.length < 6) return { body: raw, impl: '' };       // 全是指令：不猜，交给人看
  return { body, impl: tech.join(' ').trim() };
}
// 卡片 → 给 agent 的上下文：人话在前，内部实现在后并标明「不进卡片」
function cardLine(n, i) {
  return `${i + 1}. [${KINDS[n.kind].label}] ${n.title}：${n.body || '(空)'}` +
    (implOf(n) ? `\n   ↳ 内部实现（不进卡片，只给你看）：${implOf(n)}` : '');
}

(async () => {
  agents = await window.tcflow.listAgents();
  loadStore();
  if (!store.workflows.length) createWorkflow('隔板 UGC 链路', true);
  bindUI();
  renderWorkflowList();
  render();
  centerView();
})();

function bindUI() {
  $('#btnNew').onclick = () => createWorkflow('新工作流 ' + (store.workflows.length + 1));
  $('#btnAddCard').onclick = e => { e.stopPropagation(); $('#addMenu').classList.toggle('on'); };
  document.addEventListener('click', () => $('#addMenu').classList.remove('on'));
  document.querySelectorAll('#addMenu div').forEach(d => d.onclick = () => { addNode(d.dataset.kind); $('#addMenu').classList.remove('on'); });
  $('#btnSave').onclick = exportFlow;
  $('#btnOpen').onclick = importFlow;
  $('#btnValidate').onclick = () => validateAll();
  $('#btnRun').onclick = openRunModal;
  $('#mClose').onclick = $('#mCancel').onclick = closeRunModal;
  $('#panelTab').onclick = togglePanel;
  $('#flowAgent').addEventListener('change', e => { flow().agent = e.target.value; renderWorkflowList(); render(); });
  $('#dockMin').onclick = () => { dockOpen = false; renderDock(); };
  $('#dockFab').onclick = () => { dockOpen = true; renderDock(); const i = $('#dockIn'); if (i) i.focus(); };
  $('#dockSend').onclick = () => dockSend($('#dockIn').value);
  $('#dockIn').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); dockSend(e.target.value); } });
  $('#panelDel').onclick = () => { if (panelCardId && confirm('删除这张卡？和它相连的线会一起删掉。')) delNode(panelCardId); };
  $('#mGo').onclick = startRun;
  $('#wrap').addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('keydown', onKey);
  $('#flowName').addEventListener('change', e => { flow().name = e.target.value.trim() || '未命名'; renderWorkflowList(); });

  $('#zoomIn').onclick = () => { zoom = Math.min(1.8, zoom + 0.1); applyZoom(); drawEdges(); };
  $('#zoomOut').onclick = () => { zoom = Math.max(0.4, zoom - 0.1); applyZoom(); drawEdges(); };
  $('#zoomReset').onclick = () => { zoom = 1; applyZoom(); drawEdges(); };
  bindPanZoom();
}

// ---------- 画板拖动 / 缩放 ----------
function bindPanZoom() {
  let panning = false, sx = 0, sy = 0, ox = 0, oy = 0;
  wrap.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('.node') || e.target.closest('.zoombar')) return;
    panning = true;
    sx = e.clientX; sy = e.clientY; ox = wrap.scrollLeft; oy = wrap.scrollTop;
    wrap.classList.add('panning');
    selId = null; panelCardId = null; panelOpen = false; markSel();
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
    zoom = Math.min(1.8, Math.max(0.4, zoom - e.deltaY * 0.0015));
    applyZoom(); drawEdges();
  }, { passive: false });
}
let lastZoom = 1;
function applyZoom() {
  const cw = wrap.clientWidth, ch = wrap.clientHeight;
  const changed = zoom !== lastZoom;
  // 缩放前视口中心对应的「画布坐标」
  const cx = (wrap.scrollLeft + cw / 2) / lastZoom;
  const cy = (wrap.scrollTop + ch / 2) / lastZoom;
  canvas.style.transformOrigin = '0 0';
  canvas.style.transform = `scale(${zoom})`;
  if (changed && cw && ch) {          // 缩放后把同一个点放回视口中心，画面不跳
    wrap.scrollLeft = cx * zoom - cw / 2;
    wrap.scrollTop = cy * zoom - ch / 2;
  }
  lastZoom = zoom;
  const el = $('#zoom'); if (el) el.textContent = Math.round(zoom * 100) + '%';
}
// 把视口挪到逻辑原点附近（首屏 / 切换工作流时）
function centerView() {
  wrap.scrollLeft = ORIGIN.x - 120;
  wrap.scrollTop = ORIGIN.y - 90;
}

// ---------- 存储 ----------
// 老示例卡的文案 → 人话。原技术串一字不丢，挪进 impl（内部实现）。
// 按 body 精确匹配，命中就改；新数据不会再命中。
const LEGACY_PLAIN = [
  ['1688 offer：4729546689005（隔板）', '商品编号', '隔板这款商品的编号，加上它现成的证据资料', 'offer_id = 4729546689005（1688 隔板）'],
  ['按 offer_id 在 evidence/_INDEX-BY-OFFER.json 反查，取最新最全的包', '找证据包', '按编号找到这个商品最新、最全的那一份证据', 'evidence/_INDEX-BY-OFFER.json 反查 offer_id，取最新最全目录'],
  ['evidence/<包>/ + images 清单 + page-fields', '证据目录', '一份可以直接拿去用的证据目录：图片清单＋页面字段', 'evidence/<包>/ + images 清单 + page-fields，校验 sha256'],
  ['出 selling_points / differentiation / must_not_claim', '出卖点卡', '从证据里挑出卖点、差异点和不能说的话', '出 selling_points / differentiation / must_not_claim'],
  ['cards/<capture>.sellpoint.json（含 usable_in_ad）', '卖点卡', '一张能直接交给做广告的人用的卖点卡', 'cards/<capture>.sellpoint.json（含 usable_in_ad），校验 schema'],
];
// 卡片要具体：把原来写得空泛的种子正文换成具体的（用哪些图/数据、怎么加工、交出什么）
const PLAIN_SPECIFIC = [
  ['隔板这款商品的编号，加上它现成的证据资料', '隔板这款商品（1688 货号 4729546689005），加上它上次采集的那批图（主图 5 张、详情长图 3 张）和页面上的标题、价格、规格。'],
  ['按编号找到这个商品最新、最全的那一份证据', '翻这件商品的采集记录，拿最近一次那份：图是不是齐的、页面字段有没有缺，缺就标出来。'],
  ['一份可以直接拿去用的证据目录：图片清单＋页面字段', '一份资料清单：一共几张图、每张是主图还是详情图、页面上的标题/价格/规格各是什么值。'],
  ['从证据里挑出卖点、差异点和不能说的话', '对着这些图和页面文字，挑出 3–5 条能打广告的卖点、和同类隔板的不同点，再列 3 条绝对不能写的话。'],
  ['一张能直接交给做广告的人用的卖点卡', '一张卖点卡：每条卖点写了什么、用的是哪张图、能不能直接拿去用。'],
];
function plainifySpecific(w) {
  let hit = 0;
  for (const n of (w.nodes || [])) {
    const row = PLAIN_SPECIFIC.find(r => String(n.body || '').trim() === r[0]);
    if (!row) continue;
    n.body = row[1]; hit++;
  }
  return hit;
}
function plainifyLegacy(w) {
  let hit = 0;
  for (const n of (w.nodes || [])) {
    const row = LEGACY_PLAIN.find(r => String(n.body || '').trim() === r[0]);
    if (!row) continue;
    n.title = row[1]; n.body = row[2]; n.impl = row[3]; hit++;
  }
  return hit;
}

function loadStore() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) { const s = JSON.parse(raw); if (s && Array.isArray(s.workflows) && s.workflows.length) store = s; }
  } catch (e) { }
  if (!store.workflows.length) {                       // v3 → v4：老卡片补 impl 字段，正文原样保留
    for (const k of LEGACY_KEYS) {
      try {
        const old = JSON.parse(localStorage.getItem(k) || 'null');
        if (old && Array.isArray(old.workflows) && old.workflows.length) {
          old.workflows.forEach(w => (w.nodes || []).forEach(n => {
            n.checks = n.checks || []; n.chat = n.chat || [];
            if (n.impl == null) { const cut = splitTech(n.body); n.body = cut.body; n.impl = cut.impl; }  // 老卡里的命令/路径挪进内部实现，一字不丢
          }));
          store = old; break;
        }
      } catch (e) { }
    }
  }
  if (!store.workflows.length) store = { workflows: [], current: null };
  else {                                              // 老文案就地改成人话（技术串进 impl）
    let hit = 0;
    store.workflows.forEach(w => { hit += plainifyLegacy(w); hit += plainifySpecific(w); });
    if (hit) saveStore();
  }
}
function saveStore() { try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch (e) { } }

// ---------- 工作流 ----------
function createWorkflow(name, seed = false) {
  const w = { id: 'w' + Date.now().toString(36), name, agent: '', nodes: [], edges: [], chat: [] };
  if (seed) {
    const a = { id: uid(), kind: 'in',   title: '商品编号', body: '隔板这款商品（1688 货号 4729546689005），加上它上次采集的那批图（主图 5 张、详情长图 3 张）和页面上的标题、价格、规格。', checks: [],
                impl: 'offer_id = 4729546689005（1688 隔板）；evidence/<包>/images + page-fields', x: 24,  y: 70, status: 'idle' };
    const b = { id: uid(), kind: 'proc', title: '找证据包', body: '翻这件商品的采集记录，拿最近一次那份：图是不是齐的、页面字段有没有缺，缺就标出来。', checks: [],
                impl: 'evidence/_INDEX-BY-OFFER.json 反查 offer_id，取最新最全目录', x: 286, y: 70, status: 'idle' };
    const c = { id: uid(), kind: 'out',  title: '证据目录', body: '一份资料清单：一共几张图、每张是主图还是详情图、页面上的标题/价格/规格各是什么值。', checks: ['sha256'],
                impl: 'evidence/<包>/ + images 清单 + page-fields，校验 sha256', x: 548, y: 70, status: 'idle' };
    const d = { id: uid(), kind: 'proc', title: '出卖点卡', body: '对着这些图和页面文字，挑出 3–5 条能打广告的卖点、和同类隔板的不同点，再列 3 条绝对不能写的话。', checks: ['schema', 'policy'],
                impl: '出 selling_points / differentiation / must_not_claim 三段', x: 286, y: 320, status: 'idle' };
    const e = { id: uid(), kind: 'out',  title: '卖点卡', body: '一张卖点卡：每条卖点写了什么、用的是哪张图、能不能直接拿去用。', checks: ['schema'],
                impl: 'cards/<capture>.sellpoint.json（含 usable_in_ad），校验 schema', x: 548, y: 320, status: 'idle' };
    w.nodes.push(a, b, c, d, e);
    w.edges.push([a.id, b.id], [b.id, c.id], [c.id, d.id], [d.id, e.id]);
  }
  store.workflows.push(w); store.current = w.id; selId = null; panelCardId = null;
  saveStore(); renderWorkflowList(); render();
  return w;
}
function switchWorkflow(id) { store.current = id; selId = null; panelCardId = null; panelOpen = false; saveStore(); renderWorkflowList(); render(); centerView(); }
function deleteWorkflow(id, ev) {
  ev.stopPropagation();
  if (store.workflows.length <= 1) return alert('至少保留一个工作流');
  if (!confirm('删除这个工作流？画布内容会一起删掉。')) return;
  store.workflows = store.workflows.filter(w => w.id !== id);
  if (store.current === id) store.current = store.workflows[0].id;
  saveStore(); renderWorkflowList(); render();
}
function renderWorkflowList() {
  const box = $('#wfList'); box.innerHTML = '';
  for (const w of store.workflows) {
    const el = document.createElement('div');
    el.className = 'wf' + (w.id === store.current ? ' on' : '');
    el.onclick = () => switchWorkflow(w.id);
    el.innerHTML = `<div class="wn">${esc(w.name)}</div>
      <div class="ws">${w.nodes.length} 卡 · ${w.agent ? esc(agentName(w.agent)) : '<span style="color:#c2410c">未指派</span>'}</div>
      <div class="x" title="删除">✕</div>`;
    el.querySelector('.x').onclick = (ev) => deleteWorkflow(w.id, ev);
    box.appendChild(el);
  }
}
function agentName(id) { const a = agents.find(x => x.id === id); return a ? a.name : id; }
function dockAgentName() { return '平台主管'; }
function isStopped(id) { const a = agents.find(x => x.id === id); return !a || a.stopped; }

// 只列在用岗；已停用的折叠进 disabled 分组，避免误派
function agentOptionsHTML(sel) {
  const cur = agents.find(a => a.id === sel);
  const act = agents.filter(a => !a.stopped || a.id === sel);
  const stop = agents.filter(a => a.stopped && a.id !== sel);
  let h = `<option value="">— 未指派 —</option>`;
  h += `<optgroup label="在用（派工白名单）">` +
    act.map(a => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)}（${a.id}）</option>`).join('') +
    `</optgroup>`;
  if (stop.length) h += `<optgroup label="已停用（不在派工白名单）">` +
    stop.map(a => `<option value="${a.id}" disabled>${esc(a.name)}（${a.id}）</option>`).join('') + `</optgroup>`;
  return h;
}

// ---------- 卡片 ----------
function addNode(kind, props = {}, select = true) {
  const base = { id: uid(), kind, title: KINDS[kind].label + '卡', body: '', impl: '', checks: [], chat: [], status: 'idle' };
  const offset = flow().nodes.filter(n => n.kind === kind).length * 28;
  const n = Object.assign(base, { x: 60 + offset, y: 520 + offset }, props);
  flow().nodes.push(n);
  if (select) selId = n.id;
  saveStore(); render();
  return n;
}
function delNode(id) {
  flow().nodes = flow().nodes.filter(n => n.id !== id);
  flow().edges = flow().edges.filter(([a, b]) => a !== id && b !== id);
  if (selId === id) selId = null;
  if (panelCardId === id) { panelCardId = null; panelOpen = false; }
  saveStore(); render();
}
function connect(aId, bId) {
  if (aId === bId) return;
  const w = flow();
  if (w.edges.some(([a, b]) => a === aId && b === bId)) return;
  w.edges.push([aId, bId]); saveStore(); render();
}

// ---------- 渲染 ----------
function render() {
  const w = flow(); if (!w) return;
  $('#flowName').value = w.name;
  $('#flowAgent').innerHTML = agentOptionsHTML(w.agent);

  for (const el of [...canvas.querySelectorAll('.node')]) el.remove();
  for (const n of w.nodes) canvas.appendChild(nodeEl(n));

  // 概览自动隐藏：没选卡片就把右栏收起来，画布变大
  applyPanelState();

  applyZoom();
  drawEdges();
  renderPanel();
  renderDock();
  $('#footStat').textContent = `${w.nodes.length} 卡 / ${w.edges.length} 连线`;
}
function applyPanelState() {
  const n = find(panelCardId);
  const collapsed = !n && !panelOpen;
  $('#layout').classList.toggle('collapsed', collapsed);
  $('#panelTab').classList.toggle('on', collapsed);
  $('#panelDel').style.display = n ? '' : 'none';
}
// 选中一张卡：右栏展开到这张卡的对话
function openCard(n) { if (!n) return; selId = n.id; panelCardId = n.id; panelOpen = false; render(); }
// 概览展开/收起
function togglePanel() { panelOpen = !panelOpen; if (panelOpen) panelCardId = null; render(); }
// 改名字/正文时不重建整个画布，只同步这张卡
function syncCard(n) {
  const el = document.querySelector(`.node[data-id="${n.id}"]`);
  if (!el) return;
  el.querySelector('.t').textContent = n.title;
  el.querySelector('.body').textContent = n.body;
  drawEdges();
}

function nodeEl(n) {
  const k = KINDS[n.kind] || KINDS.proc;
  const el = document.createElement('div');
  el.className = `node k-${n.kind}` + (selId === n.id ? ' sel' : '');
  el.style.left = (n.x + OX) + 'px'; el.style.top = (n.y + OY) + 'px';
  el.dataset.id = n.id;
  el.title = '双击打开右栏：改名字、和 agent 聊这张卡';
  el.innerHTML = `
    <div class="hd">
      <span class="kind">${k.label}</span>
      <div class="t">${esc(n.title)}</div>
      <div class="st ${n.status}">${statusDot(n)}</div>
    </div>
    <div class="body" data-ph="${esc(k.ph)}">${esc(n.body)}</div>
    <div class="ft">
      <div class="checks">${(n.checks || []).map(c => `<span class="chip">${esc(c)}</span>`).join('')}</div>
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
  el.addEventListener('pointerdown', e => {
    if (e.target.closest('.mini') || e.target.closest('.gar')) return;   // 卡片正文不可编辑：整张卡都能拖
    if (e.button === 0) { selId = n.id; markSel(); dragCard(e, n, el); }   // 单击/拖动只选中，双击才开卡片信息
  });
  return el;
}

function markSel() {
  document.querySelectorAll('.node').forEach(el => el.classList.toggle('sel', el.dataset.id === selId));
  applyPanelState();
}
function statusDot(n) { return ({ running: '●', ok: '✓', warn: '!', fail: '✕', ready: '▶' })[n.status] || ''; }

function drawEdges() {
  const w = flow(); if (!w) return;
  const cr = canvas.getBoundingClientRect();
  edgesSvg.innerHTML = `<defs><marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 z" fill="rgba(17,17,17,.42)"/></marker></defs>`;
  for (const [a, b] of w.edges) {
    const ea = document.querySelector(`.node[data-id="${a}"]`), eb = document.querySelector(`.node[data-id="${b}"]`);
    if (!ea || !eb) continue;
    const ra = ea.getBoundingClientRect(), rb = eb.getBoundingClientRect();
    const x1 = (ra.right - cr.left) / zoom, y1 = (ra.top - cr.top + ra.height / 2) / zoom;
    const x2 = (rb.left - cr.left) / zoom, y2 = (rb.top - cr.top + rb.height / 2) / zoom;
    const mx = (x1 + x2) / 2;
    edgesSvg.insertAdjacentHTML('beforeend',
      `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="rgba(17,17,17,.30)" stroke-width="1.6" marker-end="url(#ar)"/>`);
  }
}

function dragCard(e, n, el) {
  const wr = wrap.getBoundingClientRect();
  // 指针 → 画布坐标（含滚动与缩放），拖动时滚动自动滚也跟手
  const toCanvas = p => ({ x: (p.clientX - wr.left + wrap.scrollLeft) / zoom, y: (p.clientY - wr.top + wrap.scrollTop) / zoom });
  const clampX = v => Math.max(-ORIGIN.x + 8, Math.min(CANVAS.w - ORIGIN.x - el.offsetWidth - 8, v));
  const clampY = v => Math.max(-ORIGIN.y + 8, Math.min(CANVAS.h - ORIGIN.y - el.offsetHeight - 8, v));
  const start = toCanvas(e);
  const grab = { x: n.x - (start.x - ORIGIN.x), y: n.y - (start.y - ORIGIN.y) };
  let last = { clientX: e.clientX, clientY: e.clientY };
  let raf = 0;
  const place = ev => {
    last = { clientX: ev.clientX, clientY: ev.clientY };
    const c = toCanvas(last);
    n.x = clampX(c.x - ORIGIN.x + grab.x);
    n.y = clampY(c.y - ORIGIN.y + grab.y);
    el.style.left = (n.x + OX) + 'px'; el.style.top = (n.y + OY) + 'px';
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
    keepInView();
    saveStore();
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

// ---------- 右栏 ----------
function renderPanel() {
  const w = flow(), n = find(panelCardId);
  const t = $('#panelTitle'), b = $('#panelBody');
  if (!n) {
    t.textContent = '工作流概览';
    const order = chainOrder(w);
    const rows = order.map((x, i) => `<div class="ovrow">
        <span class="oi">${i + 1}</span>
        <span class="kind k-${x.kind}">${KINDS[x.kind].label}</span>
        <span class="ot">${esc(x.title)}</span>
        <span class="ob ${x.body ? '' : 'miss'}">${(x.body ? '已填' : '空') + (implOf(x) ? ' ⚙' : '')}</span>
      </div>`).join('') || '<p class="hint">还没有卡片。顶栏「+ 输入 / + 加工 / + 输出」开始。</p>';
    b.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <span class="chip">${w.nodes.length} 卡</span>
        <span class="chip ${w.agent ? 'ok' : 'bad'}">${w.agent ? '执行方：' + esc(agentName(w.agent)) : '未指派 agent'}</span>
      </div>
      <label>这条流程的执行 agent</label>
      <select id="pFlowAgent">${agentOptionsHTML(w.agent)}</select>
      <div style="margin-top:10px">${rows}</div>
      <button id="pAskFlow" class="primary" style="width:100%;margin-top:12px">让 agent 看整条流程</button>
      <div id="agentOut">（agent 会读全部卡片，指出断链、缺校验的地方）</div>`;
    $('#pFlowAgent').onchange = e => { w.agent = e.target.value; renderWorkflowList(); render(); };
    $('#pAskFlow').onclick = askFlow;
    return;
  }
  const k = KINDS[n.kind];
  t.textContent = `${k.label}卡 · ${n.title}`;
  b.innerHTML = `
    <input id="pTitle" class="titleinp" value="${esc(n.title)}" spellcheck="false" placeholder="卡片名">
    <div class="kindrow"><span class="lab">类型</span>
      <select id="pKind">${Object.entries(KINDS).map(([kk, v]) => `<option value="${kk}" ${kk === n.kind ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
    <div class="pgroup ${k.cls}"><span class="lab">${k.label}内容</span>
      <textarea id="pBody" placeholder="${esc(k.ph)}">${esc(n.body)}</textarea>
</div>

    <div class="chat">
      <div class="chat-hd"><b>和 ${esc(w.agent ? agentName(w.agent) : 'agent')} 聊这张卡</b><span class="kbd">Enter 发送</span></div>
      <div class="chat-log" id="chatLog"></div>
      <div class="chat-chips">
        <span class="qchip" data-q="review">评审这张卡</span>
        <span class="qchip" data-q="next">✦ 下一步候选</span>
        <span class="qchip" data-q="flow">看整条流程</span>
      </div>
      <div class="chat-in">
        <textarea id="chatIn" rows="2" placeholder="问点什么…（Enter 发送 · Shift+Enter 换行）"></textarea>
        <button id="chatSend" class="primary">发送</button>
      </div>
    </div>

    <details class="internal">
      <summary>⚙ 内部实现 · 校验 · 卡片上不显示</summary>
      <textarea id="pImpl" placeholder="执行时真正跑什么：命令 / 脚本 / 路径 / 字段名（例：hermes -p productweb chat -q …、evidence/&lt;包&gt;/page-fields）">${esc(implOf(n))}</textarea>
      <input id="pChecks" value="${esc((n.checks || []).join(', '))}" placeholder="校验项，逗号分隔（例：sha256, schema）">
    </details>`;

  $('#pTitle').oninput = e => { n.title = e.target.value.trim() || k.label + '卡'; syncCard(n); };
  $('#pTitle').onchange = () => { saveStore(); t.textContent = `${KINDS[n.kind].label}卡 · ${n.title}`; renderWorkflowList(); };
  $('#pKind').onchange = e => { n.kind = e.target.value; saveStore(); render(); };
  $('#pBody').oninput = e => { n.body = e.target.value.replace(/\u00a0/g, ' '); syncCard(n); };
  $('#pBody').onchange = () => saveStore();
  $('#pChecks').onchange = e => { n.checks = e.target.value.split(',').map(s => s.trim()).filter(Boolean); saveStore(); render(); };
  $('#pImpl').onchange = e => { n.impl = e.target.value.replace(/\u00a0/g, ' ').trim(); saveStore(); render(); };

  b.querySelectorAll('.qchip').forEach(c => c.onclick = () => chatAsk(c.dataset.q));
  $('#chatSend').onclick = () => chatSend($('#chatIn').value);
  $('#chatIn').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(e.target.value); }
  });
  renderChat(n);
}

function chainOrder(w) {
  const incoming = new Map(w.nodes.map(n => [n.id, 0]));
  w.edges.forEach(([, b]) => incoming.set(b, (incoming.get(b) || 0) + 1));
  const starts = w.nodes.filter(n => !incoming.get(n.id));
  const seen = new Set(), out = [];
  const walk = (id) => {
    if (seen.has(id)) return; seen.add(id);
    const n = w.nodes.find(x => x.id === id); if (!n) return;
    out.push(n);
    w.edges.filter(([a]) => a === id).forEach(([, b]) => walk(b));
  };
  (starts.length ? starts : w.nodes).forEach(n => walk(n.id));
  w.nodes.forEach(n => { if (!seen.has(n.id)) out.push(n); });
  return out;
}

// ---------- agent ----------
// 三条提示词共用的一条口径：卡片只写人话，命令/路径/脚本属于「内部实现」，不进卡片
const PLAIN_RULE = [
  '卡片内容一律说人话，而且要说具体：',
  '① 用的是什么——哪几张图（主图/详情长图/白底图、几张）、哪些数据（哪个页面上的哪个字段、谁给的）；',
  '② 做了什么加工——怎么挑、怎么比、怎么改、按什么标准算合格；',
  '③ 交出什么——什么文件/清单，里面每条写什么。',
  '不要写「处理数据」「整理一下」这种空话。命令、脚本、文件路径、字段名一律只放「内部实现」，不进卡片正文。',
].join('');
async function askFlow() {
  const w = flow();
  if (!w.agent) { alert('先给整条工作流指派一个 agent'); return; }
  if (!$('#agentOut')) { panelOpen = true; panelCardId = null; render(); }
  const out = $('#agentOut');
  const desc = chainOrder(w).map(cardLine).join('\n');
  const prompt = ['你是这条工作流的执行方。只做评审：不执行、不发请求、不改文件、不付费。',
    PLAIN_RULE,
    `工作流：${w.name}`, desc, '',
    '6 行以内：1) 哪处断链（上一张卡的产出对不上下一个要的东西）；2) 哪张卡缺必须的校验；3) 最该先改的一处。',
    '建议改卡片时也用大白话；需要补的命令或路径另起一段，标「内部实现：」。'].join('\n');
  out.textContent = `正在问 ${agentName(w.agent)} …（只读）`;
  const r = await window.tcflow.askAgent({ profile: w.agent, prompt });
  out.textContent = r.ok ? agentAnswer(r.text) : ('失败：' + agentAnswer(r.error || r.text || r.code));
}
// ---------- 卡片聊天框 ----------
// 一条工作流只指派一个 agent；聊天就是和它聊当前这张卡。
const CHAT_Q = {
  review: '评审这张卡：内容够不够明白、该怎么校验、最容易错的一件事是什么。',
  next: '给我 2–4 个「下一步」候选卡，直接输出 JSON 数组。',
  flow: '看整条流程：哪处断链、哪张卡缺校验、最该先改哪一处。',
};
// 聊天气泡（卡片对话和右下角对话框共用）
function stepHTML(t, i) {
  return `<details class="step ${t.state || 'done'}" data-step="${i}">
     <summary><span class="dot"></span><em>${esc(t.label)}</em><i>${esc(t.time || '')}</i></summary>
     ${(t.input || t.output) ? `<div class="step-body">${t.input ? `<div class="step-k">参数</div><pre>${esc(JSON.stringify(t.input, null, 1))}</pre>` : ''}${t.output ? `<div class="step-k">结果</div><pre>${esc(String(t.output).slice(0, 4000))}</pre>` : ''}</div>` : ''}
   </details>`;
}
// 流式中的那条消息只做增量更新：不重建 DOM，点开的折叠块和滚动位置都保得住
function patchLive(el, m, whoLabel) {
  const meta = [m.secs ? m.secs + 's' : '', (m.steps && m.steps.length) ? m.steps.length + ' 步' : ''].filter(Boolean).join(' · ');
  const head = el.querySelector('.who');
  if (head) head.innerHTML = `${esc(whoLabel || '')}${meta ? `<span class="meta">${esc(meta)}</span>` : ''}${m.live ? '<span class="meta live-dot">进行中</span>' : ''}`;
  const steps = m.steps || [];
  if (steps.length) {
    let box = el.querySelector('details.process');
    if (!box) {
      box = document.createElement('details');
      box.className = 'think process'; box.dataset.k = 'process'; box.open = true;
      box.innerHTML = `<summary>思考过程 · 0 步</summary><div class="steps"></div>`;
      el.insertBefore(box, el.querySelector('.txt'));
    }
    const list = box.querySelector('.steps');
    while (list.children.length < steps.length) list.insertAdjacentHTML('beforeend', stepHTML(steps[list.children.length], list.children.length));
    [...list.children].forEach((d, i) => { if (i < steps.length) d.className = 'step ' + (steps[i].state || 'done'); if (i < steps.length) { const t = d.querySelector('summary i'); if (t) t.textContent = steps[i].time || ''; } });
    const sum = box.querySelector('summary');
    if (sum) sum.textContent = `思考过程 · ${steps.length} 步`;
  }
  let txt = el.querySelector('.txt');
  if (!txt) { txt = document.createElement('div'); txt.className = 'txt'; el.appendChild(txt); }
  txt.innerHTML = mdToHTML(m.text || '');
}
function bubblesHTML(msgs, conf, emptyText, waiting, whoLabel) {
  const who = esc(whoLabel || agentName(flow().agent) || 'agent');
  const stepsHTML = (steps) => (steps && steps.length)
    ? `<details class="think process" data-k="process" open><summary>思考过程 · ${steps.length} 步</summary><div class="steps">${steps.map(stepHTML).join('')}</div></details>` : '';
  const thinkHTML = (m) => m.think
    ? `<details class="think reason" data-k="reason"${m.thinkOpen === false ? '' : ' open'}><summary>思考${m.secs ? ' ' + esc(m.secs) + 's' : ''}${m.think.length > 40 ? ' · ' + m.think.length + ' 字' : ''}</summary><pre>${esc(m.think)}</pre></details>`
    : '';

  let h = msgs.length ? msgs.map((m, i) => {
    if (m.role === 'me') return `<div class="msg me">${mdToHTML(m.text)}</div>`;
    const meta = [m.secs ? m.secs + 's' : '', (m.steps && m.steps.length) ? m.steps.length + ' 步' : ''].filter(Boolean).join(' · ');
    const body = m.text ? (m.text.length > 900 && !m.live
      ? `<div class="txt">${mdToHTML(m.text.slice(0, 600))}</div><details class="more"><summary>展开全文（${m.text.length} 字）</summary><div class="txt">${mdToHTML(m.text)}</div></details>`
      : `<div class="txt">${mdToHTML(m.text)}</div>`) : '';
    let box = `<div class="msg agent${m.live ? ' live' : ''}"${m.live ? ' data-live="1"' : ''}>
        <div class="who">${who}${meta ? `<span class="meta">${esc(meta)}</span>` : ''}${m.live ? '<span class="meta live-dot">进行中</span>' : ''}</div>
        ${stepsHTML(m.steps)}${thinkHTML(m)}${body}`;
    if (m.opts && m.opts.length) {
      box += `<div class="optlist">${m.opts.map((o, j) => {
        const on = conf && conf.mi === i && conf.oi === j;
        const btn = `<button class="opt k-${o.kind}${on ? ' confirming' : ''}" data-m="${i}" data-o="${j}">
           <span class="ok">${KINDS[o.kind].label}</span>
           <b>${esc(o.title)}</b>
           <span class="ob">${esc(o.body)}</span></button>`;
        if (!on) return btn;
        return btn + `<div class="optconfirm">
          <div class="cf-row"><span class="lab">内容</span><span>${esc(o.body)}</span></div>
          <div class="cf-row"><span class="lab">⚙ 内部实现</span><span>${esc(o.impl || '（无）')}</span></div>
          <div class="cf-ask">确认要加进流程吗？</div>
          <div class="cf-btns"><button class="primary" data-yes="1">确认添加</button><button data-no="1">取消</button></div>
        </div>`;
      }).join('')}</div>`;
    }
    return box + '</div>';
  }).join('') : `<div class="msg empty">${esc(emptyText)}</div>`;
  if (waiting) h += `<div class="msg agent live" data-since="${Date.now()}"><div class="who">${who}<span class="meta live-dot">进行中</span></div><div class="txt md-p">正在想… 0s</div></div>`;
  return h;
}
function wireBubbles(log, conf, pick, yes, no) {
  log.querySelectorAll('.opt').forEach(btn => btn.onclick = () => pick(+btn.dataset.m, +btn.dataset.o));
  const y = log.querySelector('[data-yes]'), n = log.querySelector('[data-no]');
  if (y) y.onclick = yes;
  if (n) n.onclick = no;
  log.scrollTop = log.scrollHeight;
}
// 重渲染前记住每块 details 的展开状态，渲染后还原：流式期间点开的思考/工具行不会被冲掉
function keepDetails(log, paint) {
  const key = el => {
    const step = el.closest('details.step');
    const msg = el.closest('.msg');
    const idx = msg && msg.parentElement ? [...msg.parentElement.children].indexOf(msg) : -1;
    if (step) return 'step:' + idx + ':' + (step.dataset.step || '');
    if (el.classList.contains('think')) return 'think:' + idx + ':' + (el.dataset.k || 'reason');
    if (el.classList.contains('more')) return 'more:' + idx;
    return null;
  };
  const state = new Map();
  log.querySelectorAll('details').forEach(d => { const k = key(d); if (k) state.set(k, d.open); });
  const scroll = { top: log.scrollTop, h: log.scrollHeight, ch: log.clientHeight };
  const pinned = scroll.h - scroll.top - scroll.ch < 40;
  paint();
  log.querySelectorAll('details').forEach(d => { const k = key(d); if (k && state.has(k)) d.open = state.get(k); });
  log.scrollTop = pinned ? log.scrollHeight : Math.min(scroll.top, log.scrollHeight);
}
function renderChat(n) {
  const log = $('#chatLog'); if (!log) return;
  const last = (n.chat || [])[(n.chat || []).length - 1];
  const liveEl = log.querySelector('[data-live="1"]');
  if (last && last.live && liveEl) { patchLive(liveEl, last, agentName(flow().agent)); return; }
  keepDetails(log, () => {
    log.innerHTML = bubblesHTML(n.chat || [], confirmAdd, '还没聊过。点上面「评审这张卡」，或直接在下面问。', false, agentName(flow().agent));
  });
  wireBubbles(log, confirmAdd,
    (mi, oi) => { confirmAdd = { mi, oi }; renderChat(n); },
    () => { const c = confirmAdd; confirmAdd = null; if (c) addFromOption(n, c.mi, c.oi); },
    () => { confirmAdd = null; renderChat(n); });
}
function chatAsk(kind) { return chatSend(CHAT_Q[kind] || kind); }

function buildChatPrompt(n, text) {
  const w = flow();
  const hist = (n.chat || []).slice(-7, -1)
    .map(m => (m.role === 'me' ? '我：' : '你：') + m.text).join('\n');
  return [
    '我们在工作流台里聊一条工作流，你作为执行方只做建议：不执行、不发请求、不改文件、不付费。',
    PLAIN_RULE,
    `工作流：${w.name}`,
    `整条流程：\n${chainOrder(w).map(cardLine).join('\n')}`,
    `现在这张卡：[${KINDS[n.kind].label}] ${n.title}`,
    `内容（人话）：${n.body || '(空)'}｜内部实现：${implOf(n) || '(未填)'}｜校验：${(n.checks || []).join(',') || '无'}`,
    hist ? `上文对话：\n${hist}` : '',
    `我说：${text}`,
    '回答用大白话、短一点。如果我要的是「下一步」候选卡，只输出 JSON 数组，不要解释：',
    '[{"kind":"proc","title":"短标题","body":"这一步要什么/做什么/交出什么","impl":"命令/脚本/路径/字段"}]',
  ].filter(Boolean).join('\n');
}


// ---------- 流式：Hermes 的对话效果（边跑边出） ----------
const STEP_ICON = {
  terminal: '▮', read_file: '📄', write_file: '✎', patch: '✎', search_files: '🔎',
  web_search: '🌐', web_extract: '🌐', skill_view: '📚', memory: '🧠', todo_list: '☑',
  delegate_task: '🤝', message_agent: '✉', process_manage: '⚙',
};
function stepLabel(name) { return (STEP_ICON[name] || '⚙') + ' ' + name; }

async function runStream({ msgs, rerender, profile, prompt }) {
  const runId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const live = { role: 'agent', text: '', think: '', steps: [], secs: '', live: true, startedAt: Date.now() };
  msgs.push(live);
  rerender();
  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; rerender(); }); };
  const off = window.tcflow.onAgentEvent(({ runId: id, ev }) => {
    if (id !== runId || !ev) return;
    if (ev.type === 'tool_use') {
      live.steps.push({ label: stepLabel(ev.name), name: ev.name, input: ev.input, time: '', state: 'running' });
    } else if (ev.type === 'tool_result') {
      const st = [...live.steps].reverse().find(x => x.state === 'running' && (!ev.name || x.name === ev.name));
      if (st) {
        st.state = ev.is_error ? 'error' : 'done';
        st.time = ev.duration_ms != null ? (ev.duration_ms / 1000).toFixed(1) + 's' : '';
        st.output = ev.output;
      }
    } else if (ev.type === 'text' && typeof ev.text === 'string') {
      live.text += ev.text;
    } else if (ev.type === 'reasoning' || ev.type === 'thinking') {
      live.think += (ev.text || ev.delta || '');
    }
    schedule();
  });
  let r;
  if (USE_STREAM) {
    try { r = await window.tcflow.askAgentStream({ profile, prompt, runId }); }
    catch (e) { r = { ok: false, error: String(e) }; }
  } else {
    const t0 = Date.now();
    r = await window.tcflow.askAgent({ profile, prompt });
    const p = r.ok ? parseAgentOutput(r.text) : { answer: '失败：' + agentAnswer(r.error || r.text || r.code), think: '', steps: [], secs: '' };
    live.text = p.answer || ''; live.think = p.think || ''; live.steps = p.steps || []; live.secs = p.secs || String(Math.round((Date.now() - t0) / 1000));
  }
  off();
  live.live = false;
  live.secs = String(Math.max(1, Math.round((Date.now() - live.startedAt) / 1000)));
  live.steps.forEach(st => { if (st.state === 'running') { st.state = 'error'; st.time = ''; } });
  if (!live.text && r.text) live.text = r.text;
  if (!r.ok && !live.text) live.text = '失败：' + (r.error || r.code || '未知错误');
  const opts = parseCardArray(r.text || live.text || '');
  if (opts.length) { live.opts = opts; live.text = `给你 ${opts.length} 个候选卡：点一下看细节，按「确认添加」才会进流程。`; }
  rerender();
  return live;
}

async function chatSend(text) {
  const w = flow(), n = find(panelCardId);
  const msg = String(text == null ? '' : text).trim();
  if (!n || !msg) return;
  if (!w.agent) { alert('先给整条工作流指派一个 agent（顶栏或「概览」）'); return; }
  n.chat = (n.chat || []).concat([{ role: 'me', text: msg, at: Date.now() }]).slice(-30);
  saveStore(); renderChat(n);
  const inEl = $('#chatIn'); if (inEl) inEl.value = '';
  const live = await runStream({ msgs: n.chat, rerender: () => renderChat(n), profile: w.agent, prompt: buildChatPrompt(n, msg) });
  n.chat = n.chat.slice(-30);
  saveStore(); renderChat(n);
  return live;
}

// ---------- 右下角：和 agent 的对话框（整条流程级） ----------
function renderDock() {
  const box = $('#dock'), fab = $('#dockFab');
  if (!box || !fab) return;
  box.classList.toggle('on', dockOpen);
  fab.classList.toggle('on', !dockOpen);
  if (!dockOpen) return;
  const log = $('#dockLog'); const w = flow();
  const last = (w.chat || [])[(w.chat || []).length - 1];
  const liveEl = log.querySelector('[data-live="1"]');
  if (last && last.live && liveEl) { patchLive(liveEl, last, dockAgentName()); return; }
  keepDetails(log, () => {
    log.innerHTML = bubblesHTML(w.chat || [], dockConfirm, '问点什么，比如「这条链路还缺哪一步？」', false, dockAgentName());
  });
  wireBubbles(log, dockConfirm,
    (mi, oi) => { dockConfirm = { mi, oi }; renderDock(); },
    () => { const c = dockConfirm; dockConfirm = null; if (c) addFromDock(c.mi, c.oi); },
    () => { dockConfirm = null; renderDock(); });
}
function dockPrompt(text) {
  const w = flow();
  const hist = (w.chat || []).slice(-7, -1).map(m => (m.role === 'me' ? '我：' : '你：') + m.text).join('\n');
  return [
    '你是平台主管（阶段B的那个主管）：负责规划与派工、跨部门一次复核，不代做部门专业交付。',
    '这里只做建议：不执行、不发请求、不改文件、不付费。',
    PLAIN_RULE,
    `平台里的这条工作流：${w.name}`,
    `它的执行 agent：${w.agent ? agentName(w.agent) : '（还没指派）'}`,
    `整条流程：\n${chainOrder(w).map(cardLine).join('\n')}`,
    hist ? `上文对话：\n${hist}` : '',
    `我说：${text}`,
    '从平台主管的角度回答：这条链路该谁干、缺哪一步、要不要加人/换人；说人话、短一点。',
    '如果我要的是「下一步」候选卡，只输出 JSON 数组，不要解释：',
    '[{"kind":"proc","title":"短标题","body":"这一步要什么/做什么/交出什么","impl":"命令/脚本/路径/字段"}]',
  ].filter(Boolean).join('\n');
}
async function dockSend(text) {
  const w = flow(), msg = String(text == null ? '' : text).trim();
  if (!msg) return;
  w.chat = (w.chat || []).concat([{ role: 'me', text: msg, at: Date.now() }]).slice(-30);
  saveStore(); renderDock();
  const inEl = $('#dockIn'); if (inEl) inEl.value = '';
  const live = await runStream({ msgs: w.chat, rerender: () => renderDock(), profile: DOCK_AGENT, prompt: dockPrompt(msg) });
  w.chat = w.chat.slice(-30);
  saveStore(); renderDock();
  return live;
}
// 右下角对话框里确认加入：没有"上一张卡"，放在流程右下方、不自动连线
function addFromDock(mi, oi) {
  dockConfirm = null;
  const w = flow();
  const opt = ((w.chat || [])[mi] || {}).opts || [];
  const o = opt[oi]; if (!o) return;
  if (w.nodes.some(x => (x.title || '').trim() === o.title.trim())) { alert('已经有一张同名卡片了'); return; }
  const ref = chainOrder(w).slice(-1)[0];
  const n = addNode(o.kind, {
    title: o.title, body: o.body, impl: o.impl || '',
    x: ref ? ref.x + 40 : 300, y: ref ? ref.y + 260 : 340,
  }, false);
  selId = n.id; panelCardId = n.id; panelOpen = false; saveStore(); render();
}

// 把聊天里的候选卡点进流程
function addFromOption(fromNode, mi, oi) {
  confirmAdd = null;
  if (!fromNode) return;
  const opt = ((fromNode.chat || [])[mi] || {}).opts || [];
  const o = opt[oi]; if (!o) return;
  if (flow().nodes.some(x => (x.title || '').trim() === o.title.trim())) { alert('已经有一张同名卡片了'); return; }
  const n = addNode(o.kind, { title: o.title, body: o.body, impl: o.impl || '', x: fromNode.x + 40, y: fromNode.y + 200 }, false);
  connect(fromNode.id, n.id);
  selId = n.id; panelCardId = n.id; panelOpen = false; saveStore(); render();
  const inEl = $('#chatIn'); if (inEl) inEl.focus();
}
function parseCardArray(text) {
  for (const arr of jsonArrays(text)) {
    const ok = arr.filter(validOpt)
      .map(x => cleanCard({ kind: x.kind, title: String(x.title).slice(0, 24), body: String(x.body || ''), impl: String(x.impl || x.internal || '') }));
    if (ok.length) return ok.slice(0, 4);
  }
  return [];
}
function parseOptions(text) {
  // CLI 会先回显提问、再给答案，末尾还有会话尾巴；答案里也可能带 [] 字面量。
  // 所以：从后往前找「能解析成 卡片数组 的 JSON」，取最靠后的那一个。
  const cards = parseCardArray(text);
  if (cards.length) return cards;
  // 兜底：按行解析「[加工] 标题：内容」或「1. 加工 标题 - 内容」
  const out = [];
  for (const line of agentAnswer(text).split('\n')) {
    const m = line.match(/^\s*(?:[-*]|\d+[.、])?\s*\[?\s*(输入|加工|输出)\s*\]?\s*[：:\-]?\s*(.+?)\s*(?:[：:\-]\s*(.+))?$/);
    if (m) {
      const kind = m[1] === '输入' ? 'in' : m[1] === '输出' ? 'out' : 'proc';
      out.push(cleanCard({ kind, title: m[2].slice(0, 24), body: m[3] || '', impl: '' }));
    }
  }
  return out.slice(0, 4);
}
// 提示词里的示例卡，别当成真候选
function validOpt(x) {
  return x && ['in', 'proc', 'out'].includes(x.kind) && x.title && !/^(短标题|标题|卡名|示例)$/.test(String(x.title).trim());
}
// agent 文本里所有能解析成数组的 JSON，靠后的优先
function jsonArrays(text) {
  const t = String(text || ''), found = [];
  for (let i = t.length - 1; i >= 0 && found.length < 6; i--) {
    if (t[i] !== '[') continue;
    for (let j = t.length - 1; j > i && found.length < 6; j--) {
      if (t[j] !== ']') continue;
      let arr;
      try { arr = JSON.parse(t.slice(i, j + 1)); } catch (e) { continue; }
      if (Array.isArray(arr) && arr.length) { found.push(arr); break; }
    }
  }
  return found;
}
// CLI 输出 = 回显提问 + 思考段（含工具调用）+ ☤ Hermes + 正式回答 + 会话尾巴。
// 按 Hermes 的聊天逻辑拆成：思考 / 步骤 / 回答。
function parseAgentOutput(raw) {
  const t = String(raw || '');
  let s = t;
  const qi = s.indexOf('Query:');
  if (qi >= 0) { const d = s.indexOf('\n─', qi); if (d > 0) s = s.slice(d + 1); }
  const rs = s.indexOf('Resume this session with:');
  if (rs >= 0) s = s.slice(0, rs);
  const hi = s.lastIndexOf('☤ Hermes');
  const head = hi >= 0 ? s.slice(0, hi) : '';
  let body = hi >= 0 ? s.slice(hi + '☤ Hermes'.length) : s;
  const secs = (t.match(/Duration:\s*([\d.]+)s/) || [])[1] || '';

  const steps = [];
  const keep = [];
  for (const line of head.split('\n')) {
    if (/^[\s─]*$/.test(line)) continue;
    const m = line.match(/^\s*([^\w\s\u4e00-\u9fff][^\n]{0,70}?)\s{2,}([\d.]+s)\s*$/u);  // 形如「📚 Skill x  0.2s」
    if (m) { steps.push({ label: m[1].trim(), time: m[2] }); continue; }
    keep.push(line);
  }
  const think = keep.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const sum = think.match(/∴\s*Thought for[^·\n]*·\s*(.+)/);
  body = body.replace(/\n\s*─{5,}[\s\S]*$/, '').replace(/^\s*[─\n]+/, '').trim();
  return { answer: body, think, thought: sum ? sum[1].trim() : '', steps, secs };
}
// 只要「正式回答」的场景（验证结果、概览评审）用这个
function agentAnswer(text) { return parseAgentOutput(text).answer; }
// agent 万一在人话里夹了命令，这里再兜一次：能拆就搬进内部实现
function cleanCard(o) {
  const cut = splitTech(o.body);
  return {
    kind: o.kind,
    title: o.title,
    body: cut.body.slice(0, 160),
    impl: [String(o.impl || '').trim(), cut.impl].filter(Boolean).join(' ').slice(0, 220),
  };
}
async function validateAll() {
  const w = flow();
  if (!w.agent) return alert('先给整条工作流指派一个 agent');
  let firstFail = null;
  for (const n of chainOrder(w)) {
    selId = n.id; panelCardId = n.id; panelOpen = false; n.status = 'running'; render();
    const prompt = ['只做评审，不执行、不发请求、不改文件。',
      `[${KINDS[n.kind].label}] ${n.title}｜内容（人话）：${n.body || '(空)'}｜内部实现：${implOf(n) || '(未写)'}｜校验：${(n.checks || []).join(',') || '无'}`,
      '2 行：可执行 / 需补；需补就写缺哪个字段或校验（补的字段和命令算内部实现，别塞进卡片人话里）。'].join('\n');
    const r = await window.tcflow.askAgent({ profile: w.agent, prompt });
    const ok = r.ok && !/需补|不可/.test(agentAnswer(r.text || ''));
    n.status = ok ? 'ok' : 'fail';
    if (!ok && !firstFail) firstFail = n;
    n.chat = (n.chat || []).concat([{
      role: 'agent',
      text: `【逐卡验证】${ok ? '可执行' : '需补'}\n${agentAnswer(r.text || r.error || '').slice(0, 400)}`,
      at: Date.now(),
    }]).slice(-30);
    saveStore(); render();
  }
  openCard(firstFail || w.nodes[0]);
}

// ---------- 运行 ----------
function openRunModal() {
  const w = flow(), body = $('#mBody');
  const order = chainOrder(w);
  body.innerHTML = `
    <div class="mrow" style="grid-template-columns:1fr 260px">
      <div><b>${esc(w.name)}</b><div style="color:var(--ink-3);font-size:11.5px">${w.nodes.length} 张卡 · 执行 agent 统一指派</div></div>
      <select id="mAgent" class="${w.agent ? '' : 'need'}">${agentOptionsHTML(w.agent)}</select>
    </div>
    ${order.map((n, i) => `<div class="mrow" style="grid-template-columns:28px 76px 1fr">
      <div class="i">${i + 1}</div>
      <div><span class="kind k-${n.kind}">${KINDS[n.kind].label}</span></div>
      <div><b>${esc(n.title)}</b><div style="font-size:11.5px;color:var(--ink-2)">${esc((n.body || '—').slice(0, 90))}${implOf(n) ? ' <span class="gar" title="已封装内部实现（不在这里显示）">⚙</span>' : ''}</div></div>
    </div>`).join('')}`;
  $('#mHint').textContent = '整条工作流一个 agent；未指派不放行。卡片上只有人话，命令与路径在它的内部实现里。';
  $('#mAgent').onchange = e => { w.agent = e.target.value; e.target.classList.toggle('need', !e.target.value); renderWorkflowList(); render(); };
  $('#modal').classList.add('on');
}
function closeRunModal() { $('#modal').classList.remove('on'); }
function startRun() {
  const w = flow();
  if (!w.agent) { $('#mHint').textContent = '还没给这条工作流指派 agent。'; return; }
  w.startedAt = new Date().toISOString();
  w.nodes.forEach(n => n.status = 'ready');
  saveStore(); closeRunModal(); render();
  panelOpen = true; panelCardId = null; render();
  const out = $('#agentOut');
  if (out) out.textContent = `工作流「${esc(w.name)}」已就绪。\n执行 agent：${esc(agentName(w.agent))}\n\n执行顺序：\n` +
    chainOrder(w).map((n, i) => `${i + 1}. [${KINDS[n.kind].label}] ${n.title}`).join('\n') +
    `\n\n（v0.3 只到"就绪"；真实执行要接现有闸门与账本）`;
}

// ---------- 导入导出 ----------
async function exportFlow() { const r = await window.tcflow.saveFlow(flow()); $('#savePath').textContent = r.ok ? '已导出' : ''; }
async function importFlow() {
  const r = await window.tcflow.openFlow();
  if (r.ok && r.flow) {
    const w = r.flow; w.id = 'w' + Date.now().toString(36); w.chat = w.chat || [];
    w.nodes = (w.nodes || []).map(n => ({ ...n, kind: n.kind || 'proc', impl: n.impl || '', checks: n.checks || [] }));
    store.workflows.push(w); store.current = w.id; saveStore(); renderWorkflowList(); render();
  }
}

function onKey(e) {
  if (e.key === 'Delete' && selId && !e.target.isContentEditable && !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) delNode(selId);
  if (e.key === 'Escape') { selId = null; panelCardId = null; panelOpen = false; render(); }
}
// 等回答时每秒刷新"正在想… Ns"
setInterval(() => {
  document.querySelectorAll('[data-since]').forEach(el => {
    const n = Math.floor((Date.now() - Number(el.dataset.since)) / 1000);
    const t = el.querySelector('.txt'); if (t) t.textContent = `正在想… ${n}s`;
  });
}, 1000);
// 极简 markdown：转义后只支持 **粗体** / `code` / 标题 / 列表 / 代码块
function mdInline(x) {
  return x.replace(/`([^`]+)`/g, '<code class="md-inline">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s（(])\*([^*\n]+)\*/g, '$1<i>$2</i>');
}
function mdToHTML(src) {
  const lines = esc(String(src || '')).split('\n');
  let out = '', inCode = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { out += inCode ? '</code></pre>' : '<pre class="md-code"><code>'; inCode = !inCode; continue; }
    if (inCode) { out += line + '\n'; continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { out += `<div class="md-h md-h${h[1].length}">${mdInline(h[2])}</div>`; continue; }
    const li = line.match(/^\s*[-*·]\s+(.*)$/);
    if (li) { out += `<div class="md-li">${mdInline(li[1])}</div>`; continue; }
    if (/^\s*\d+[.、]\s+/.test(line)) { out += `<div class="md-li">${mdInline(line.trim())}</div>`; continue; }
    if (!line.trim()) { out += '<div class="md-gap"></div>'; continue; }
    out += `<div class="md-p">${mdInline(line)}</div>`;
  }
  if (inCode) out += '</code></pre>';
  return out;
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

// ---------- 转盘 ----------
const ACTIONS = [
  { id: 'in', label: '加输入卡' },
  { id: 'proc', label: '加加工卡' },
  { id: 'out', label: '加输出卡' },
  { id: 'ask', label: '问 agent' },
  { id: 'dup', label: '复制卡片' },
  { id: 'del', label: '删除卡片' },
  { id: 'auto', label: '逐卡验证' },
  { id: 'run', label: '开始运行' },
];
const radial = $('#radial');
const R_IN = 34, R_OUT = 104;
let rOpen = false, rTimer = null, rC = { x: 0, y: 0 }, rHot = -1;
(function buildRadial() {
  const N = ACTIONS.length, step = 2 * Math.PI / N;
  let s = `<svg width="${R_OUT * 2 + 20}" height="${R_OUT * 2 + 20}" viewBox="${-R_OUT - 10} ${-R_OUT - 10} ${R_OUT * 2 + 20} ${R_OUT * 2 + 20}">`;
  ACTIONS.forEach((a, i) => {
    const a0 = i * step - step / 2 - 0.06, a1 = (i + 1) * step - step / 2 + 0.06;
    const p = (r, ang) => [(r * Math.cos(ang)).toFixed(2), (r * Math.sin(ang)).toFixed(2)];
    const [x0, y0] = p(R_IN, a0), [x1, y1] = p(R_OUT, a0), [x2, y2] = p(R_OUT, a1), [x3, y3] = p(R_IN, a1);
    s += `<path class="sec" data-i="${i}" d="M${x0},${y0} L${x1},${y1} A${R_OUT},${R_OUT} 0 0 1 ${x2},${y2} L${x3},${y3} A${R_IN},${R_IN} 0 0 0 ${x0},${y0} Z"/>`;
    const [tx, ty] = p((R_IN + R_OUT) / 2, (a0 + a1) / 2);
    s += `<text x="${tx}" y="${ty}">${a.label}</text>`;
  });
  s += `<circle class="hub" r="${R_IN - 4}"/></svg>`;
  radial.innerHTML = s;
})();
wrap.addEventListener('pointerdown', e => {
  if (e.button !== 2) return;
  e.preventDefault();
  const x = e.clientX, y = e.clientY;
  rTimer = setTimeout(() => showRadial(x, y), 180);
});
addEventListener('pointermove', e => { if (!rOpen) return; const i = pick(e.clientX, e.clientY); if (i !== rHot) { rHot = i; paintRadial(); } });
addEventListener('pointerup', () => { clearTimeout(rTimer); if (!rOpen) return; const i = rHot; hideRadial(); if (i >= 0) doAction(ACTIONS[i].id); });
addEventListener('keydown', e => { if (e.code === 'Space' && !rOpen && !e.target.isContentEditable) { e.preventDefault(); showRadial(innerWidth / 2, innerHeight / 2); } });
function showRadial(x, y) { rOpen = true; rHot = -1; rC = { x, y }; radial.style.left = (x - R_OUT - 10) + 'px'; radial.style.top = (y - R_OUT - 10) + 'px'; radial.classList.add('on'); paintRadial(); }
function hideRadial() { rOpen = false; radial.classList.remove('on'); }
function paintRadial() {
  radial.querySelectorAll('.sec').forEach((el, i) => el.classList.toggle('hot', i === rHot));
  radial.querySelectorAll('text').forEach((el, i) => el.classList.toggle('hot', i === rHot));
}
function pick(x, y) {
  const dx = x - rC.x, dy = y - rC.y, r = Math.hypot(dx, dy);
  if (r < R_IN || r > R_OUT + 26) return -1;
  const N = ACTIONS.length, step = 2 * Math.PI / N;
  let ang = Math.atan2(dy, dx) + step / 2; if (ang < 0) ang += 2 * Math.PI;
  return Math.floor(ang / step) % N;
}
function doAction(id) {
  const n = find(selId);
  if (id === 'in') addNode('in');
  if (id === 'proc') addNode('proc');
  if (id === 'out') addNode('out');
  if (id === 'ask') { if (n) { openCard(n); chatAsk('review'); } else { panelOpen = true; panelCardId = null; render(); askFlow(); } }
  if (id === 'del' && n) delNode(n.id);
  if (id === 'dup' && n) { const c = { ...n, id: uid(), x: n.x + 40, y: n.y + 40, title: n.title + ' 副本' }; flow().nodes.push(c); selId = c.id; saveStore(); render(); }
  if (id === 'auto') validateAll();
  if (id === 'run') openRunModal();
}
