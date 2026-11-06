'use strict';
const $ = (s, r = document) => r.querySelector(s);
const canvas = $('#canvas'), edgesSvg = $('#edges'), wrap = $('#wrap');
const LS_KEY = 'tcflow.v3';

const KINDS = {
  in:   { label: '输入', cls: 'in',   ph: '要什么字段 / 从哪来（例：offer_id、evidence 目录）' },
  proc: { label: '加工', cls: 'proc', ph: '这一步做什么（例：按 offer_id 查证据目录，核 page-fields）' },
  out:  { label: '输出', cls: 'out',  ph: '产物 / 路径 / 字段（例：evidence dir + sha256）' },
};

let agents = [];
let store = { workflows: [], current: null };
let selId = null;
let seq = 1;
let zoom = 1;
const uid = () => 'n' + (seq++) + '_' + Math.random().toString(36).slice(2, 6);
const flow = () => store.workflows.find(w => w.id === store.current);
const find = id => (flow() ? flow().nodes.find(n => n.id === id) : null);

(async () => {
  agents = await window.tcflow.listAgents();
  loadStore();
  if (!store.workflows.length) createWorkflow('隔板 UGC 链路', true);
  bindUI();
  renderWorkflowList();
  render();
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
  $('#mGo').onclick = startRun;
  $('#wrap').addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('keydown', onKey);
  $('#flowName').addEventListener('change', e => { flow().name = e.target.value.trim() || '未命名'; renderWorkflowList(); });
  $('#flowAgent').addEventListener('change', e => { flow().agent = e.target.value; renderWorkflowList(); render(); });
  $('#zoomIn').onclick = () => { zoom = Math.min(1.8, zoom + 0.1); applyZoom(); };
  $('#zoomOut').onclick = () => { zoom = Math.max(0.4, zoom - 0.1); applyZoom(); };
  $('#zoomReset').onclick = () => { zoom = 1; applyZoom(); };
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
    selId = null; markSel();
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
    applyZoom();
  }, { passive: false });
}
function applyZoom() {
  canvas.style.transformOrigin = '0 0';
  canvas.style.transform = `scale(${zoom})`;
  const el = $('#zoom'); if (el) el.textContent = Math.round(zoom * 100) + '%';
}

// ---------- 存储 ----------
function loadStore() {
  try { const raw = localStorage.getItem(LS_KEY); if (raw) { const s = JSON.parse(raw); if (s && Array.isArray(s.workflows) && s.workflows.length) store = s; } } catch (e) { }
  if (!store.workflows.length) store = { workflows: [], current: null };
}
function saveStore() { try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch (e) { } }

// ---------- 工作流 ----------
function createWorkflow(name, seed = false) {
  const w = { id: 'w' + Date.now().toString(36), name, agent: '', nodes: [], edges: [] };
  if (seed) {
    const a = { id: uid(), kind: 'in',   title: '商品 offer_id', body: '1688 offer：4729546689005（隔板）', checks: [], x: 24,  y: 70, status: 'idle' };
    const b = { id: uid(), kind: 'proc', title: '查证据包',     body: '按 offer_id 在 evidence/_INDEX-BY-OFFER.json 反查，取最新最全的包', checks: ['sha256'], x: 286, y: 70, status: 'idle' };
    const c = { id: uid(), kind: 'out',  title: '证据目录',     body: 'evidence/<包>/ + images 清单 + page-fields', checks: ['sha256'], x: 548, y: 70, status: 'idle' };
    const d = { id: uid(), kind: 'proc', title: '出卖点卡',     body: '出 selling_points / differentiation / must_not_claim', checks: ['schema', 'policy'], x: 286, y: 320, status: 'idle' };
    const e = { id: uid(), kind: 'out',  title: '卖点卡',       body: 'cards/<capture>.sellpoint.json（含 usable_in_ad）', checks: ['schema'], x: 548, y: 320, status: 'idle' };
    w.nodes.push(a, b, c, d, e);
    w.edges.push([a.id, b.id], [b.id, c.id], [c.id, d.id], [d.id, e.id]);
  }
  store.workflows.push(w); store.current = w.id; selId = null;
  saveStore(); renderWorkflowList(); render();
  return w;
}
function switchWorkflow(id) { store.current = id; selId = null; saveStore(); renderWorkflowList(); render(); }
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
  const base = { id: uid(), kind, title: KINDS[kind].label + '卡', body: '', checks: [], status: 'idle' };
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
  drawEdges();
  renderPanel();
  $('#footStat').textContent = `${w.nodes.length} 卡 / ${w.edges.length} 连线`;
  applyZoom();
}

function nodeEl(n) {
  const k = KINDS[n.kind] || KINDS.proc;
  const el = document.createElement('div');
  el.className = `node k-${n.kind}` + (selId === n.id ? ' sel' : '');
  el.style.left = n.x + 'px'; el.style.top = n.y + 'px';
  el.dataset.id = n.id;
  el.innerHTML = `
    <div class="hd">
      <span class="kind">${k.label}</span>
      <div class="t" contenteditable="true" spellcheck="false">${esc(n.title)}</div>
      <div class="st ${n.status}">${statusDot(n)}</div>
    </div>
    <div class="body" contenteditable="true" data-k="body" data-ph="${esc(k.ph)}">${esc(n.body)}</div>
    <div class="ft">
      <div class="checks">${(n.checks || []).map(c => `<span class="chip">${esc(c)}</span>`).join('')}</div>
      <span class="mini" data-act="ask" title="问 agent 这张卡">? 问</span>
      <span class="mini" data-act="opt" title="让 agent 给下一步选项，选一个直接加进流程">✦ 下一步</span>
      <span class="mini" data-act="link" title="拖到另一张卡建立连线">↗ 连线</span>
    </div>`;

  el.querySelector('.t').addEventListener('blur', e => { n.title = e.target.textContent.trim() || k.label + '卡'; saveStore(); });
  el.querySelector('[data-k="body"]').addEventListener('blur', e => {
    n.body = e.target.textContent.replace(/\u00a0/g, ' ').trim(); saveStore(); drawEdges();
  });
  el.querySelector('[data-act="link"]').addEventListener('click', ev => { ev.stopPropagation(); startLink(n, el); });
  el.querySelector('[data-act="ask"]').addEventListener('click', ev => { ev.stopPropagation(); selId = n.id; markSel(); askOne(n); });
  el.querySelector('[data-act="opt"]').addEventListener('click', ev => { ev.stopPropagation(); selId = n.id; markSel(); askOptions(n); });
  el.addEventListener('pointerdown', e => {
    if (e.target.isContentEditable || e.target.closest('.mini')) return;
    if (e.button === 0) { selId = n.id; markSel(); dragCard(e, n, el); }
  });
  return el;
}

function markSel() {
  document.querySelectorAll('.node').forEach(el => el.classList.toggle('sel', el.dataset.id === selId));
  renderPanel();
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
  const sx = e.clientX, sy = e.clientY, ox = n.x, oy = n.y;
  const move = ev => {
    n.x = Math.max(0, ox + (ev.clientX - sx) / zoom);
    n.y = Math.max(0, oy + (ev.clientY - sy) / zoom);
    el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; drawEdges();
  };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); saveStore(); render(); };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
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
  const w = flow(), n = find(selId);
  const t = $('#panelTitle'), b = $('#panelBody');
  if (!n) {
    t.textContent = '工作流概览';
    const order = chainOrder(w);
    const rows = order.map((x, i) => `<div class="ovrow">
        <span class="oi">${i + 1}</span>
        <span class="kind k-${x.kind}">${KINDS[x.kind].label}</span>
        <span class="ot">${esc(x.title)}</span>
        <span class="ob ${x.body ? '' : 'miss'}">${x.body ? '已填' : '空'}</span>
      </div>`).join('') || '<p class="hint">还没有卡片。顶栏「+ 输入 / + 加工 / + 输出」开始。</p>';
    b.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <span class="chip">${w.nodes.length} 卡</span>
        <span class="chip ${w.agent ? 'ok' : 'bad'}">${w.agent ? '执行方：' + esc(agentName(w.agent)) : '未指派 agent'}</span>
      </div>
      <label>执行 agent（整条工作流）</label>
      <select id="pFlowAgent">${agentOptionsHTML(w.agent)}</select>
      <p class="hint">一个工作流只指派一个 agent：验证、评审、执行都由它负责。</p>
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
    <label>卡片名</label><input id="pTitle" value="${esc(n.title)}">
    <label>类型</label>
    <select id="pKind">${Object.entries(KINDS).map(([kk, v]) => `<option value="${kk}" ${kk === n.kind ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
    <div class="pgroup ${k.cls}"><span class="lab">${k.label}内容</span>
      <textarea id="pBody" placeholder="${esc(k.ph)}">${esc(n.body)}</textarea></div>
    <label>校验项（逗号分隔）</label><input id="pChecks" value="${esc((n.checks || []).join(', '))}">
    <div style="display:flex;gap:8px;margin-top:14px">
      <button id="pAsk" class="primary" style="flex:1">让 agent 看这张卡</button>
      <button id="pDel">删除</button>
    </div>
    <div id="agentOut">（agent 会指出内容够不够、缺什么校验）</div>`;
  $('#pTitle').onchange = e => { n.title = e.target.value; saveStore(); render(); };
  $('#pKind').onchange = e => { n.kind = e.target.value; saveStore(); render(); };
  $('#pBody').onchange = e => { n.body = e.target.value; saveStore(); };
  $('#pChecks').onchange = e => { n.checks = e.target.value.split(',').map(s => s.trim()).filter(Boolean); saveStore(); render(); };
  $('#pDel').onclick = () => delNode(n.id);
  $('#pAsk').onclick = () => askOne(n);
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
async function askFlow() {
  const w = flow(), out = $('#agentOut');
  if (!w.agent) { out.textContent = '先给整条工作流指派一个 agent。'; return; }
  const desc = chainOrder(w).map((n, i) => `${i + 1}. [${KINDS[n.kind].label}] ${n.title}：${n.body || '(空)'}`).join('\n');
  const prompt = ['你是这条工作流的执行方。只做评审：不执行、不发请求、不改文件、不付费。',
    `工作流：${w.name}`, desc, '',
    '6 行以内：1) 哪处断链（上一张卡的输出对不上下一个输入）；2) 哪张卡缺必须的校验；3) 最该先改的一处。'].join('\n');
  out.textContent = `正在问 ${agentName(w.agent)} …（只读）`;
  const r = await window.tcflow.askAgent({ profile: w.agent, prompt });
  out.textContent = r.ok ? r.text : ('失败：' + (r.error || r.text || r.code));
}
async function askOne(n) {
  const w = flow(), out = $('#agentOut');
  if (!w.agent) { out.textContent = '先给整条工作流指派一个 agent。'; return; }
  const prompt = ['只做评审，不执行、不发请求、不改文件。',
    `卡片类型：${KINDS[n.kind].label}｜名称：${n.title}｜内容：${n.body || '(空)'}｜校验：${(n.checks || []).join(',') || '无'}`,
    '5 行以内：1) 这张卡内容够不够明确；2) 该怎么校验；3) 最容易错的一件事和防它的做法。'].join('\n');
  out.textContent = `正在问 ${agentName(w.agent)} …（只读）`;
  const r = await window.tcflow.askAgent({ profile: w.agent, prompt });
  out.textContent = r.ok ? r.text : ('失败：' + (r.error || r.text || r.code));
}
// 让 agent 给「下一步」选项，选一个直接加进流程
let pendingOpts = { fromId: null, list: [] };
async function askOptions(n) {
  const w = flow(), out = $('#agentOut');
  if (!w.agent) { out.textContent = '先给整条工作流指派一个 agent。'; return; }
  if (isStopped(w.agent)) { out.textContent = `「${agentName(w.agent)}」已停用、不在派工白名单，换个 agent 再问。`; return; }
  const chain = chainOrder(w).map((x, i) => `${i + 1}. [${KINDS[x.kind].label}] ${x.title}：${x.body || '(空)'}`).join('\n');
  const prompt = [
    '你在帮我编排一条工作流。只做建议，不执行、不发请求、不改文件。',
    `当前流程：\n${chain}`,
    `我现在停在卡片「[${KINDS[n.kind].label}] ${n.title}：${n.body || '(空)'}」上。`,
    '请给出 2–4 个"下一步"候选，每个候选是一张卡（输入卡/加工卡/输出卡三选一）。',
    '只输出 JSON 数组，不要解释、不要代码块标记。格式：',
    '[{"kind":"proc","title":"短标题","body":"这张卡具体要什么/做什么/产出什么"}]',
    '要求：kind 只能取 in / proc / out；title ≤ 14 字；body ≤ 60 字，写清字段或产物路径。',
  ].join('\n');
  out.textContent = `正在让 ${agentName(w.agent)} 给下一步选项 …（只读）`;
  const r = await window.tcflow.askAgent({ profile: w.agent, prompt });
  if (!r.ok) { out.textContent = '失败：' + (r.error || r.text || r.code); return; }
  const list = parseOptions(r.text);
  if (!list.length) { out.innerHTML = `<div class="rawout">${esc(r.text).slice(0, 1200)}</div><p class="hint">没能解析出选项，上面是 agent 原文。</p>`; return; }
  pendingOpts = { fromId: n.id, list };
  out.innerHTML = `<div class="optlabel">选一个直接加进流程（自动连线到「${esc(n.title)}」）</div>` +
    list.map((o, i) => `<button class="opt k-${o.kind}" data-i="${i}">
      <span class="ok">${KINDS[o.kind].label}</span>
      <b>${esc(o.title)}</b>
      <span class="ob">${esc(o.body)}</span></button>`).join('');
  out.querySelectorAll('.opt').forEach(btn => btn.onclick = () => applyOption(+btn.dataset.i));
}
function parseOptions(text) {
  const t = String(text || '');
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a >= 0 && b > a) {
    try {
      const arr = JSON.parse(t.slice(a, b + 1));
      const ok = arr.filter(x => x && ['in', 'proc', 'out'].includes(x.kind) && x.title)
        .map(x => ({ kind: x.kind, title: String(x.title).slice(0, 24), body: String(x.body || '').slice(0, 160) }));
      if (ok.length) return ok.slice(0, 4);
    } catch (e) { }
  }
  // 兜底：按行解析「[加工] 标题：内容」或「1. 加工 标题 - 内容」
  const out = [];
  for (const line of t.split('\n')) {
    const m = line.match(/^\s*(?:[-*]|\d+[.、])?\s*\[?\s*(输入|加工|输出)\s*\]?\s*[：:\-]?\s*(.+?)\s*(?:[：:\-]\s*(.+))?$/);
    if (m) {
      const kind = m[1] === '输入' ? 'in' : m[1] === '输出' ? 'out' : 'proc';
      out.push({ kind, title: m[2].slice(0, 24), body: (m[3] || '').slice(0, 160) });
    }
  }
  return out.slice(0, 4);
}
function applyOption(i) {
  const { fromId, list } = pendingOpts;
  const o = list[i], from = find(fromId);
  if (!o || !from) return;
  const n = addNode(o.kind, { title: o.title, body: o.body, x: from.x + 40, y: from.y + 200 }, false);
  connect(from.id, n.id);
  selId = n.id; render();
  const out = $('#agentOut'); if (out) out.textContent = `已加入：${KINDS[o.kind].label}卡「${o.title}」`;
}

async function validateAll() {
  const w = flow();
  if (!w.agent) return alert('先给整条工作流指派一个 agent');
  const lines = [];
  for (const n of chainOrder(w)) {
    n.status = 'running'; render();
    const prompt = ['只做评审，不执行、不发请求、不改文件。',
      `[${KINDS[n.kind].label}] ${n.title}：${n.body || '(空)'}｜校验：${(n.checks || []).join(',') || '无'}`,
      '2 行：可执行 / 需补；需补就写缺哪个字段或校验。'].join('\n');
    const r = await window.tcflow.askAgent({ profile: w.agent, prompt });
    const ok = r.ok && !/需补|不可/.test(r.text || '');
    n.status = ok ? 'ok' : 'fail';
    lines.push(`【${KINDS[n.kind].label}｜${n.title}】${ok ? '可执行' : '需补'}\n${(r.text || r.error || '').trim().slice(0, 260)}`);
    render();
  }
  selId = null; render();
  $('#panelTitle').textContent = '逐卡验证结果';
  $('#panelBody').innerHTML = `<div id="agentOut">${lines.join('\n\n')}</div>`;
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
      <div><b>${esc(n.title)}</b><div style="font-size:11.5px;color:var(--ink-2)">${esc((n.body || '—').slice(0, 90))}</div></div>
    </div>`).join('')}`;
  $('#mHint').textContent = '整条工作流只需指派一个 agent；未指派不放行。';
  $('#modal').classList.add('on');
  $('#mAgent').onchange = e => { w.agent = e.target.value; e.target.classList.toggle('need', !e.target.value); renderWorkflowList(); render(); };
}
function closeRunModal() { $('#modal').classList.remove('on'); }
function startRun() {
  const w = flow();
  if (!w.agent) { $('#mHint').textContent = '还没给这条工作流指派 agent。'; return; }
  w.startedAt = new Date().toISOString();
  w.nodes.forEach(n => n.status = 'ready');
  saveStore(); closeRunModal(); render();
  $('#panelTitle').textContent = '已就绪（演练）';
  $('#panelBody').innerHTML = `<div id="agentOut">工作流「${esc(w.name)}」已就绪。\n执行 agent：${esc(agentName(w.agent))}\n\n执行顺序：\n` +
    chainOrder(w).map((n, i) => `${i + 1}. [${KINDS[n.kind].label}] ${n.title}`).join('\n') +
    `\n\n（v0.3 只到"就绪"；真实执行要接现有闸门与账本）</div>`;
}

// ---------- 导入导出 ----------
async function exportFlow() { const r = await window.tcflow.saveFlow(flow()); $('#savePath').textContent = r.ok ? '已导出' : ''; }
async function importFlow() {
  const r = await window.tcflow.openFlow();
  if (r.ok && r.flow) {
    const w = r.flow; w.id = 'w' + Date.now().toString(36);
    w.nodes = (w.nodes || []).map(n => ({ ...n, kind: n.kind || 'proc' }));
    store.workflows.push(w); store.current = w.id; saveStore(); renderWorkflowList(); render();
  }
}

function onKey(e) {
  if (e.key === 'Delete' && selId && !e.target.isContentEditable && !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) delNode(selId);
  if (e.key === 'Escape') { selId = null; render(); }
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
  if (id === 'ask') { if (n) askOne(n); else askFlow(); }
  if (id === 'del' && n) delNode(n.id);
  if (id === 'dup' && n) { const c = { ...n, id: uid(), x: n.x + 40, y: n.y + 40, title: n.title + ' 副本' }; flow().nodes.push(c); selId = c.id; saveStore(); render(); }
  if (id === 'auto') validateAll();
  if (id === 'run') openRunModal();
}
