'use strict';
const $ = (s, r = document) => r.querySelector(s);
const canvas = $('#canvas'), edgesSvg = $('#edges'), fxSvg = $('#fx'), wrap = $('#wrap');
const LS_KEY = 'tcflow.v4';
const LEGACY_KEYS = ['tcflow.v3'];

// 卡片正文只说人话：要什么 / 做什么 / 交什么。
// 命令、路径、脚本、字段名收进 node.impl（内部实现），卡片面上不显示。
const KINDS = {
  in:   { label: '输入', cls: 'in',   ph: '这一步要先有什么（说人话，例：一个商品编号，加它现成的证据资料）' },
  proc: { label: '加工', cls: 'proc', ph: '这一步让人做什么（说人话，例：找到这个商品最新最全的那份证据）' },
  out:  { label: '输出', cls: 'out',  ph: '最后交出什么（说人话，例：一份能直接拿去用的证据目录）' },
};
// 模块：卡片里用到的东西拆成一块一块——输入卡带「素材」，加工卡带「工具」，输出卡带「成果」。
// 加工卡有两个插槽：「素材」接输入（或上一步的成果），「成果」接输出。把卡片拖进插槽就连上了。
const MOD_T = { mat: '素材', tool: '工具', res: '成果' };
const KIND_MOD = { in: 'mat', proc: 'tool', out: 'res' };
const modsOf = n => (n && Array.isArray(n.mods) ? n.mods : []);
const SVGNS = 'http://www.w3.org/2000/svg';
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let agents = [];
const USE_STREAM = true;   // true：真流式（Hermes 的边跑边出，但 CLI 流里没有思考正文）
                           // false：一次性文本模式（能拿到「思考」正文，但没有逐字效果）
const DOCK_AGENT = 'default';        // 右下角对话框固定对接「平台主管」（default profile）
const TEMP_ID = '__temp__';          // 临时对话画布：跟着这次对话存在，不进工作流列表
let tempFlow = null;                 // 临时画布的数据（不写 localStorage，关掉就没了）
const LINK = { paths: {}, timer: 0, pendingId: '', applying: false, delay: 350 };  // 共享链路状态文件（人和 agent 共用一份底稿）
// 版本：每条链路最近 20 版的底稿（人改一次 / agent 提议应用一次 = 一版；拖动位置不算）
const VER = { max: 20, delay: 300, list: {}, sig: {}, paths: {}, timer: 0, pending: {}, busy: false };
let changeBy = 'me';        // 这一批改动是谁做的：'me' 人 / 'agent' agent 提议后应用
const RUNS = new Map();     // 正在跑的对话 runId → { flowId, cancelled }：回滚时按链路把它们停掉
// 只读预演：一条链路按卡片顺序问执行方「这一步你会怎么做、缺什么材料」，只出结论。
// 工具组固定为零工具（context_engine 解析不到任何工具 + no_mcp 关掉 MCP 连接）：跑不了命令、
// 读写不了文件、发不了消息、碰不到任何对外接口。主进程还会把渲染层传来的工具组盖成这一份。
const PREVIEW_TOOLSETS = 'context_engine,no_mcp';
const PV = { busy: false, runId: null, done: 0, total: 0, cur: '', liveSteps: 0, cancel: false, error: '' };
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
const isTemp = () => store.current === TEMP_ID && !!tempFlow;
const flow = () => (store.current === TEMP_ID ? tempFlow : (store.workflows.find(w => w.id === store.current) || null));
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
  const ms = modsOf(n);
  return `${i + 1}. [${KINDS[n.kind].label}] ${n.title}：${n.body || '(空)'}` +
    (ms.length ? `\n   ${MOD_T[KIND_MOD[n.kind]] || '模块'}：${ms.map(m => m.name).join('、')}` : '') +
    (implOf(n) ? `\n   ↳ 内部实现（不进卡片，只给你看）：${implOf(n)}` : '');
}

(async () => {
  agents = await window.tcflow.listAgents();
  loadStore();
  if (!store.workflows.length) createWorkflow('商品卖点链路', true);
  bindUI();
  renderWorkflowList();
  render();
  centerView();
  // 共享链路状态文件：先把每条链路的文件路径记下来（prompt 里要写给 agent），再听外部改动
  try {
    for (const w of store.workflows) LINK.paths[w.id] = await window.tcflow.linkPath(w.id);
    if (window.tcflow.onLinkExternal) {
      window.tcflow.onLinkExternal(({ id, doc }) => { if (id !== TEMP_ID) applyLinkDoc(doc); });
    }
  } catch (e) { }
  await initVersions();                 // 版本：老链路先记一版基线，之后每次改动才有回滚点
})();

// 实时工作流：和一条工作流一样占画布区，从右边列表切进来（不再另开窗口）
let liveMode = false;
let editMode = false;      // 编辑工作流的分屏里：卡片正文收起来，改成下面一块「参考」文本，保留时再挪到上方
let liveBooted = false;
async function bootLiveView() {
  const wv = $('#liveWV');
  if (!wv || liveBooted) { return wv; }
  liveBooted = true;
  let dir = '';
  try { dir = await window.tcflow.appDir(); } catch (e) { }
  wv.setAttribute('preload', (dir || '.') + '/preload.js');   // preload 必须是绝对路径
  wv.addEventListener('dom-ready', () => {
    try { window.tcflow.liveAttach(wv.getWebContentsId()).catch(() => {}); } catch (e) { }
  });
  wv.setAttribute('src', 'live.html');
  return wv;
}
async function enterLive() {
  liveMode = true;
  const cw = document.querySelector('.canvaswrap');
  if (cw) { cw.classList.remove('split'); cw.classList.add('live'); }
  const wv0 = $('#liveWV'); if (wv0) { try { wv0.send('live:readonly', false); } catch (e) { } }
  const name = $('#flowName');
  if (name) { name.value = '实时工作流'; name.readOnly = true; }
  const fa = document.querySelector('.flowagent'); if (fa) fa.style.display = 'none';
  renderWorkflowList();
  await bootLiveView();
  const wv = $('#liveWV');
  if (wv) { try { window.tcflow.liveAttach(wv.getWebContentsId()).catch(() => {}); } catch (e) { } }
}
// 「确定工作流」：把左边解析出来的这份复制成一条正式工作流，右边立刻可以改；左边只读留着对照。
function adoptLiveFlow(doc) {
  if (!doc || !Array.isArray(doc.cards) || !doc.cards.length) return null;
  const base = String(doc.name || '实时工作流').trim() || '实时工作流';
  const w = {
    id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name: base + ' · 已确定',
    agent: (doc.conv && doc.conv.profile) || '',
    nodes: doc.cards.map(c => Object.assign({}, c, { manual: true, checks: c.checks || [], status: c.status || 'idle' })),
    edges: (doc.edges || []).map(e => [e[0], e[1]]),
    chat: [],
    version: 1,
    updated_at: Date.now(),
    fromLive: { profile: (doc.conv && doc.conv.profile) || '', session: (doc.conv && doc.conv.session) || '' }
  };
  store.workflows.unshift(w);
  store.current = w.id;
  selId = null; panelCardId = null;
  saveStore();
  renderWorkflowList();
  render();
  enterSplit();
  // 分屏是刚加的，等一帧拿到下半边的真实尺寸再对准，否则会按 0 宽算缩放（画布看着是空的）
  requestAnimationFrame(() => requestAnimationFrame(() => { try { fitView(true, 0.2); } catch (e) { } }));
  const fs = $('#footStat'); if (fs) fs.textContent = '已确定：下面这条可以改，上面是只读参考';
  return w;
}

function enterSplit() {
  const cw = document.querySelector('.canvaswrap');
  if (!cw) return;
  liveMode = true;
  editMode = true;
  cw.classList.add('live', 'split');
  canvas.classList.add('editing');
  const kb = $('#splitKeep'); if (kb) kb.textContent = '保留工作流';
  const w0 = flow();
  if (w0) { layoutChain(w0); render(); }
  const name = $('#flowName'); if (name) name.readOnly = false;
  const fa = document.querySelector('.flowagent'); if (fa) fa.style.display = '';
  const wv = $('#liveWV');
  if (wv) { try { wv.send('live:readonly', true); } catch (e) { } }
  renderWorkflowList();
}

// ---------- 分屏下半区：保留 / AI 通用化 ----------
function splitStat(msg) { const el = $('#splitStat'); if (el) el.textContent = msg || ''; }

function keepFlow() {
  const w = flow(); if (!w) return;
  const btn = $('#splitKeep');
  if (!editMode) {                       // 已经保留过：这颗按钮变成「继续编辑」
    editMode = true;
    canvas.classList.add('editing');
    layoutChain(w); render();
    try { fitView(true, 0.2); } catch (e) { }
    if (btn) btn.textContent = '保留工作流';
    splitStat('继续编辑：改完再点「保留工作流」');
    return;
  }
  let moved = 0;
  for (const n of w.nodes) {
    const t = String(n.note || '').trim();
    if (t) { n.body = t; n.note = ''; moved++; }     // 参考文本 → 卡片正文（和读取链路得到的卡一样，描述在上方）
  }
  editMode = false;
  canvas.classList.remove('editing');
  layoutChain(w); render();
  try { fitView(true, 0.2); } catch (e) { }
  saveStore();
  const t2 = new Date();
  const p2 = n => String(n).padStart(2, '0');
  if (btn) btn.textContent = '继续编辑';
  splitStat(`已保留 ${p2(t2.getHours())}:${p2(t2.getMinutes())}:${p2(t2.getSeconds())}` + (moved ? ` · ${moved} 张卡的内容已转到上方` : ''));
}

const GEN_TYPES = new Set(['tool', 'file', 'model', 'check', 'cmd']);
function normalizeMods(list, kind) {
  const out = [];
  for (const m of (Array.isArray(list) ? list : [])) {
    const name = String(typeof m === 'string' ? m : (m && m.name) || '').trim();
    if (!name) continue;
    const type = String((m && m.type) || KIND_MOD[kind] || 'tool');
    out.push({ id: uid(), type: GEN_TYPES.has(type) ? type : (KIND_MOD[kind] || 'tool'), name });
  }
  return out;
}
function parseGenJSON(text) {
  let s2 = String(text || '').trim();
  s2 = s2.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = s2.indexOf('{'), j = s2.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try {
    const d = JSON.parse(s2.slice(i, j + 1));
    return d && Array.isArray(d.cards) ? d : null;
  } catch (e) { return null; }
}
function fallbackChain(nodes) {
  const rank = { in: 0, proc: 1, out: 2 };
  const sorted = [...nodes].sort((a, b) => (rank[a.kind] - rank[b.kind]));
  const edges = [];
  for (let k = 1; k < sorted.length; k++) edges.push([sorted[k - 1].id, sorted[k].id]);
  return edges;
}
function applyGenerated(w, data) {
  const ok = new Set(['in', 'proc', 'out']);
  const cards = (data.cards || []).filter(c => c && ok.has(c.kind) && String(c.title || '').trim());
  if (!cards.length) throw new Error('返回里没有可用卡片');
  const oldById = new Map(w.nodes.map(n => [n.id, n]));
  const next = [];
  for (const c of cards) {
    const old = c.id && oldById.get(c.id);
    const mods = normalizeMods(c.mods, c.kind);
    const body = String(c.body || '').trim();
    if (old) next.push(Object.assign(old, { kind: c.kind, title: String(c.title).trim(), body: editMode ? old.body : body, note: editMode ? body : old.note, mods: mods.length ? mods : (old.mods || []) }));
    else next.push({ id: uid(), kind: c.kind, title: String(c.title).trim(), body: editMode ? '' : body, note: editMode ? body : '', impl: '', mods, checks: [], chat: [], status: 'idle' });
  }
  w.nodes = next;
  const ids = new Set(next.map(n => n.id));
  let edges = (data.edges || []).filter(e => Array.isArray(e) && e.length === 2 && ids.has(e[0]) && ids.has(e[1]));
  if (!edges.length) edges = fallbackChain(next);
  w.edges = edges;
  if (data.name && String(data.name).trim()) w.name = String(data.name).trim();
  selId = null; panelCardId = null; panelOpen = false;
  w.version = (w.version || 1) + 1; w.updated_at = Date.now();
  layoutChain(w);
  render(); renderWorkflowList();
  try { fitView(true, 0.2); } catch (e) { }
}

async function generalizeFlow() {
  const w = flow();
  if (!w || !w.nodes.length) { splitStat('下面这张还是空的'); return; }
  const gen = $('#splitGen'), keep = $('#splitKeep');
  if (gen && gen.disabled) return;
  if (gen) gen.disabled = true; if (keep) keep.disabled = true;
  splitStat('AI 正在按 输入 / 加工 / 输出 整理…');
  try {
    const profile = w.agent || 'default';
    const brief = chainOrder(w).map(n => `- [${KINDS[n.kind].label}] ${n.title}｜${n.body || '(空)'}｜工具：${(n.mods || []).map(m => m.name).join('、') || '无'}`).join('\n');
    const prompt = [
      '你是工作流编辑。下面是一条从某次真实任务里解析出来的链路，分三类卡：输入（素材进来）、加工（怎么处理）、输出（产出什么）。',
      '请把它改写成「通用工作流」：描述这一类活儿怎么做，而不是这一次具体做了什么。',
      '规则：',
      '1) 保留三类卡的先后关系（输入 → 加工 → 输出）；可以增删卡，但三类都要有；',
      '2) 标题用动作或产物的通称（例：「商品图」「按参考重出线稿」），不要出现具体商品名、货号、店铺名、人名、本机路径、一次性参数；',
      '3) 正文写做法与合格标准，不写这次的文件名/编号；',
      '4) 加工卡的工具写通用能力（例：「图像生成模型」「线稿重绘」），不写具体调用编号；输出卡只写产出与验收要点；',
      '5) 能对上的卡片沿用原 id，位置好保留。',
      '',
      '当前链路：',
      brief,
      '',
      '只输出一个 JSON 对象，不要解释、不要代码围栏：',
      '{"name":"通用工作流名","cards":[{"id":"原卡 id 或空","kind":"in|proc|out","title":"...","body":"...","mods":[{"type":"tool|file|model|check","name":"..."}]}],"edges":[["a","b"]]}',
    ].join('\n');
    const r = await window.tcflow.askAgent({ profile, prompt, timeoutMs: window.tcflow.readTimeoutMs });
    if (!r || !r.ok) { splitStat('AI 没返回：' + String(agentAnswer((r && (r.error || r.text)) || '未知错误')).slice(0, 60)); return; }
    const clean = agentAnswer(r.text || '');          // hermes 的 stdout 前面有 Query 回显、后面有会话块，先剥掉
    const data = parseGenJSON(clean);
    if (!data) { splitStat('AI 返回的不是合法 JSON，这条没动｜' + String(clean).replace(/\s+/g, ' ').slice(0, 90)); return; }
    applyGenerated(w, data);
    saveStore();
    splitStat(`已通用化：${w.nodes.length} 卡 / ${w.edges.length} 连线`);
  } catch (e) {
    splitStat('通用化失败：' + String((e && e.message) || e).slice(0, 60));
  } finally {
    if (gen) gen.disabled = false; if (keep) keep.disabled = false;
  }
}

function exitLive() {
  if (!liveMode) return;
  liveMode = false;
  const cw = document.querySelector('.canvaswrap');
  if (cw) cw.classList.remove('live', 'split');
  const wv = $('#liveWV'); if (wv) { try { wv.send('live:readonly', false); } catch (e) { } }
  editMode = false; canvas.classList.remove('editing');
  splitStat('');
  const name = $('#flowName');
  if (name) name.readOnly = false;
  const fa = document.querySelector('.flowagent'); if (fa) fa.style.display = '';
  renderWorkflowList();
  if (name) { const w = flow(); name.value = (w && w.name) || '未命名工作流'; }
}

function bindUI() {
  $('#btnNew').onclick = () => createWorkflow('新工作流 ' + (store.workflows.length + 1));
  $('#btnCopy').onclick = () => { const w = flow(); if (w && !w.temp) duplicateWorkflow(w.id); };
  $('#btnTest').onclick = openTest;
  $('#tClose').onclick = closeTest;
  $('#tCheck').onclick = () => paintTest();
  $('#tRun').onclick = startPreview;
  $('#tClear').onclick = clearPreviews;
  $('#btnTempChat').onclick = startTempCanvas;
  $('#tempSave').onclick = promoteTemp;
  const sk = $('#splitKeep'), sg = $('#splitGen');
  if (sk) sk.onclick = keepFlow;
  if (sg) sg.onclick = generalizeFlow;
  $('#tempClose').onclick = closeTempCanvas;
  $('#btnAddCard').onclick = e => { e.stopPropagation(); $('#moreMenu').classList.remove('on'); $('#addMenu').classList.toggle('on'); };
  $('#btnMore').onclick = e => { e.stopPropagation(); $('#addMenu').classList.remove('on'); $('#moreMenu').classList.toggle('on'); };
  document.addEventListener('click', () => { $('#addMenu').classList.remove('on'); $('#moreMenu').classList.remove('on'); });
  document.querySelectorAll('#addMenu div').forEach(d => d.onclick = () => { addNode(d.dataset.kind); $('#addMenu').classList.remove('on'); });
  $('#btnSave').onclick = exportFlow;
  $('#btnOpen').onclick = importFlow;
  $('#btnLive').onclick = () => enterLive();
  // 实时画布：开在主窗口里（同一个窗口铺满一层），不再另开窗口
  window.tcflow.onLiveShow(() => enterLive());
  if (window.tcflow.onLiveConfirm) window.tcflow.onLiveConfirm(doc => adoptLiveFlow(doc));

  $('#btnValidate').onclick = () => validateAll();
  $('#btnRun').onclick = openRunModal;
  $('#btnRead').onclick = openRead;
  $('#emptyRead').onclick = openRead;
  $('#rClose').onclick = closeRead;
  $('#rAgain').onclick = () => analyzeChain();
  $('#rPlace').onclick = placeChain;
  $('#mClose').onclick = $('#mCancel').onclick = closeRunModal;
  $('#panelTab').onclick = togglePanel;
  $('#flowAgent').addEventListener('change', e => { flow().agent = e.target.value; saveStore(); renderWorkflowList(); render(); });
  $('#dockMin').onclick = () => { dockOpen = false; renderDock(); };
  $('#dockFab').onclick = () => { dockOpen = true; renderDock(); const i = $('#dockIn'); if (i) i.focus(); };
  $('#dockSend').onclick = () => dockSend($('#dockIn').value);
  $('#dockIn').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); dockSend(e.target.value); } });
  $('#panelDel').onclick = () => { if (panelCardId && confirm('删除这张卡？和它相连的线会一起删掉。')) delNode(panelCardId); };
  $('#mGo').onclick = startRun;
  $('#wrap').addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('keydown', onKey);
  $('#flowName').addEventListener('change', e => { flow().name = e.target.value.trim() || '未命名'; saveStore(); renderWorkflowList(); });

  $('#zoomIn').onclick = () => { zoom = Math.min(1.8, zoom + 0.1); applyZoom(); drawEdges(); };
  $('#zoomOut').onclick = () => { zoom = Math.max(0.3, zoom - 0.1); applyZoom(); drawEdges(); };
  $('#zoomReset').onclick = () => { zoom = 1; applyZoom(); drawEdges(); };
  bindPanZoom();
  initTopbarFold();
}

// ---------- 顶栏收纳：窗口窄到一排放不下时，把次要按钮搬进 ⋯ 菜单 ----------
// 应用允许的最小宽度是 1000（main.js 的 minWidth）。默认 1380 下一件都不收，观感和以前完全一样；
// 窗口拉窄就先收最不常用的，保证「开始运行」永远在窗内可点。
// 只搬 DOM 节点、不移交事件：onclick 跟着元素走，顶栏和菜单里用的是同一套处理函数。
const TOP_FOLD = ['btnTest', 'btnCopy', 'btnValidate', 'btnTempChat', 'btnRead'];   // 从最不常用的开始收
let topFold = null;
function initTopbarFold() {
  const bar = document.querySelector('.topbar');
  if (!bar || topFold) return;
  topFold = TOP_FOLD.map(id => document.getElementById(id)).filter(Boolean).map(el => {
    const slot = document.createComment('顶栏原位 ' + el.id);    // 搬走后原位记着，窗口变宽按原位插回
    el.parentNode.insertBefore(slot, el);
    return { el, slot };
  });
  addEventListener('resize', fitTopbar);
  fitTopbar();
  setTimeout(fitTopbar, 120);          // 首帧字体/布局稳定后再量一次，免得量到中间态
}
function fitTopbar() {
  const bar = document.querySelector('.topbar'), menu = $('#moreMenu');
  if (!bar || !menu || !topFold) return;
  for (const { el, slot } of topFold) if (el.parentNode !== slot.parentNode) slot.parentNode.insertBefore(el, slot);
  const msep = menu.querySelector('.msep');
  // 放不下的判定要看两处：内容宽超了（scrollWidth），或者最后一个控件顶进了右内边距
  // （scrollWidth 只看 padding box，顶进 padding 的那几个像素它看不见，只量 scrollWidth 会漏）。
  const tooWide = () => {
    if (bar.scrollWidth > bar.clientWidth + 1) return true;
    const box = bar.getBoundingClientRect();
    const limit = box.right - parseFloat(getComputedStyle(bar).paddingRight || 0);
    let right = 0;
    for (const el of bar.children) { const r = el.getBoundingClientRect(); if (r.width > 0) right = Math.max(right, r.right); }
    return right > limit + 0.5;
  };
  let n = 0;
  while (tooWide() && n < topFold.length) {
    const { el } = topFold[n++];
    if (msep) menu.insertBefore(el, msep); else menu.appendChild(el);   // 收进菜单：排在 导入/导出 上面
  }
  if (n !== (bar.__foldN || 0)) { bar.__foldN = n; menu.classList.remove('on'); }
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
    zoom = Math.min(1.8, Math.max(0.3, zoom - e.deltaY * 0.0015));
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
// 首屏 / 切换工作流：视口对准这条流程的卡片（放得下就居中，放不下就从左上角开始），没有卡片才回原点
function centerView() {
  const w = flow(), ns = (w && w.nodes) || [];
  if (!ns.length) { wrap.scrollLeft = (ORIGIN.x - 120) * zoom; wrap.scrollTop = (ORIGIN.y - 90) * zoom; return; }
  const size = n => { const e = canvas.querySelector(`.node[data-id="${n.id}"]`); return [e ? e.offsetWidth : 244, e ? e.offsetHeight : 160]; };
  const x0 = Math.min(...ns.map(n => n.x)), y0 = Math.min(...ns.map(n => n.y));
  const x1 = Math.max(...ns.map(n => n.x + size(n)[0])), y1 = Math.max(...ns.map(n => n.y + size(n)[1]));
  const cw = wrap.clientWidth / zoom, ch = wrap.clientHeight / zoom, pad = 60;
  const vx = x1 - x0 + 2 * pad <= cw ? (x0 + x1 - cw) / 2 : x0 - pad;
  const vy = y1 - y0 + 2 * pad <= ch ? (y0 + y1 - ch) / 2 : y0 - pad;
  wrap.scrollLeft = (vx + ORIGIN.x) * zoom;
  wrap.scrollTop = (vy + ORIGIN.y) * zoom;
}

// ---------- 存储 ----------
// 老示例卡的文案 → 人话（内部实现换成中性说法，跟着卡片正面一起交出去）。
// 按 body 精确匹配，命中就改；新数据不会再命中。左边一列是 0.3.0 老卡片的正文指纹（只用来认人，
// 从不显示在界面上），右边两列才是界面上看到的正文与内部实现。
const LEGACY_PLAIN = [
  ['按 offer_id 在 evidence/_INDEX-BY-OFFER.json 反查，取最新最全的包', '找证据包', '按编号找到这件商品最新、最全的那一份证据', '按编号查素材索引，取最近一次、图最全的那份目录'],
  ['evidence/<包>/ + images 清单 + page-fields', '证据目录', '一份可以直接拿去用的证据目录：图片清单＋页面字段', '输出：图片清单（逐张）＋ 页面字段取值，逐项核对是否齐全'],
  ['出 selling_points / differentiation / must_not_claim', '出卖点卡', '从证据里挑出卖点、差异点和不能说的话', '分三段产出：可用卖点 / 与他人不同的地方 / 不能说的话'],
  ['cards/<capture>.selling-points.json（含 usable_in_ad）', '卖点卡', '一张能直接交给做广告的人用的卖点卡', '输出卖点卡文件：每条含配图与能否直接用，按约定格式校验'],
];
// 卡片要具体：把原来写得空泛的种子正文换成具体的（用哪些图/数据、怎么加工、交出什么）
const PLAIN_SPECIFIC = [
  ['按编号找到这件商品最新、最全的那一份证据', '翻这件商品的采集记录，拿最近一次那份：图是不是齐的、页面字段有没有缺，缺就标出来。'],
  ['一份可以直接拿去用的证据目录：图片清单＋页面字段', '一份资料清单：一共几张图、每张是主图还是详情图、页面上的标题/价格/规格各是什么值。'],
  ['从证据里挑出卖点、差异点和不能说的话', '对着这些图和页面文字，挑出 3–5 条能打广告的卖点、和同类商品的不同点，再列 3 条绝对不能写的话。'],
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

// 老卡拆模块：按 body 逐字匹配，只补还没有 mods 的卡（可重复执行）；新卡在左栏里自己加。
// 要给一批现有卡补模块，往这张表里加一行，不要手改 localStorage。
const MODS_SEED = [
  ['一件示例商品（编号 A-1001），加上它上次采集的那批图（主图 5 张、详情长图 3 张）和页面上的标题、价格、规格。',
    ['示例商品 A-1001', '主图 5 张', '详情长图 3 张', '标题·价格·规格']],
  ['翻这件商品的采集记录，拿最近一次那份：图是不是齐的、页面字段有没有缺，缺就标出来。',
    ['按编号翻采集记录', '图片清点', '字段缺项检查']],
  ['一份资料清单：一共几张图、每张是主图还是详情图、页面上的标题/价格/规格各是什么值。',
    ['图片清单 8 张', '标题·价格·规格取值']],
  ['对着这些图和页面文字，挑出 3–5 条能打广告的卖点、和同类商品的不同点，再列 3 条绝对不能写的话。',
    ['卖点筛选', '同类商品对比', '禁写话核对']],
  ['一张卖点卡：每条卖点写了什么、用的是哪张图、能不能直接拿去用。',
    ['卖点 3–5 条·配图', '同类差异点', '禁写 3 条', '能否直接用']],
];
function modsFor(kind, body) {
  const row = MODS_SEED.find(r => String(body || '').trim() === r[0]);
  return row ? row[1].map(name => ({ id: uid(), type: KIND_MOD[kind] || 'tool', name })) : [];
}
function seedMods(w) {
  let hit = 0;
  for (const n of (w.nodes || [])) {
    if (Array.isArray(n.mods)) continue;
    n.mods = modsFor(n.kind, n.body); hit++;
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
    store.workflows.forEach(w => { hit += plainifyLegacy(w); hit += plainifySpecific(w); hit += seedMods(w); });
    if (hit) saveStore();
  }
  // 选中的那条要记得住：上次选谁就是谁；链路被删掉了才退回第一条
  if (!store.workflows.some(w => w.id === store.current)) store.current = store.workflows[0] ? store.workflows[0].id : null;
  store.workflows.forEach(w => { w.version = w.version || 1; w.updated_at = w.updated_at || Date.now(); });
}
// 画布改动 → 本地存储 + 共享状态文件（临时画布不写本地存储：关掉就没了）
// bump=false：只是聊天/状态点这种不影响链路结构的改动，不算新版本、也不写文件（文件里只有链路）
// bump=true 也不一定出「一版」：连续改动按一次算（见 scheduleVersion），位置变化不算内容改动
function saveStore(bump = true) {
  const w = flow();
  const touch = bump && !LINK.applying;
  if (w && touch) w.updated_at = Date.now();
  saveLocal();
  if (w && touch) { scheduleVersion(w); queueLinkWrite(w); }
}
// 只落本地存储（不动版本、不推状态文件）：打字过程中的节流落盘用它
function saveLocal() {
  const current = store.current === TEMP_ID ? (store.workflows[0] ? store.workflows[0].id : null) : store.current;
  try { localStorage.setItem(LS_KEY, JSON.stringify({ workflows: store.workflows, current })); } catch (e) { }
}

// ---------- 共享链路状态文件（人和 agent 共用的一份底稿） ----------
// 一条链路的完整状态：卡片 / 连线 / 每张卡的模块 / 正文 / 内部实现 / 执行方 / 版本号。
// 画布是唯一写入方；agent 只读。外面改了文件（版本更大）画布认领回来。
function linkDoc(w) {
  const order = chainOrder(w);
  const byKind = { in: 0, proc: 0, out: 0 };
  w.nodes.forEach(n => { byKind[n.kind] = (byKind[n.kind] || 0) + 1; });
  return {
    schema: 'workflow-studio/link@1',
    id: w.id,
    kind: w.temp ? 'temp' : 'workflow',
    name: w.name || '未命名',
    agent: w.agent || null,
    agent_name: w.agent ? execName(w.agent) : null,
    version: w.version || 1,
    updated_at: new Date(w.updated_at || Date.now()).toISOString(),
    // 版本记录（最近 20 版）在另一个文件里；agent 想知道「刚才有没有回滚」看这两行就够
    versions_path: VER.paths[w.id] || null,
    rollback: w.rollback ? { at: new Date(w.rollback.at).toISOString(), from: w.rollback.from, to: w.rollback.to } : null,
    summary: {
      cards: w.nodes.length,
      edges: w.edges.length,
      by_kind: byKind,
      executor: w.agent ? execName(w.agent) : '未指派',
      chain: order.map(n => `${KINDS[n.kind].label}｜${n.title}`),
    },
    cards: w.nodes.map(n => ({
      id: n.id, kind: n.kind, title: n.title, body: n.body || '', impl: implOf(n),
      mods: modsOf(n).map(m => ({ type: m.type, name: m.name })),
      position: { x: Math.round(n.x), y: Math.round(n.y) },
      draft: !!n.draft, seed: !!n.seed,
    })),
    edges: w.edges.map(e => [e[0], e[1]]),
  };
}
function flushLinkWrite(id) {
  if (!id || !window.tcflow || !window.tcflow.linkWrite) return;
  const cur = id === TEMP_ID ? tempFlow : store.workflows.find(x => x.id === id);
  if (!cur) return;
  window.tcflow.linkWrite({ id, doc: linkDoc(cur) }).then(r => { if (r && r.path) LINK.paths[id] = r.path; }).catch(() => { });
}
function queueLinkWrite(w) {
  if (!window.tcflow || !window.tcflow.linkWrite || !w) return;
  const id = w.id;
  // 已经排了一次写、而且是同一条链路：让它按原时间写（写的时候读的是最新内容，版本号也已经是新的）。
  // 别把每次改动都往后推——推来推去，坏文件要等更久才被好文件盖掉。
  if (LINK.timer && LINK.pendingId === id) return;
  if (LINK.timer) { const prev = LINK.pendingId; clearTimeout(LINK.timer); LINK.timer = 0; LINK.pendingId = ''; flushLinkWrite(prev); }  // 换了一条链路：先把上一条写掉
  LINK.pendingId = id;
  LINK.timer = setTimeout(() => {
    const cur = id; LINK.timer = 0; LINK.pendingId = '';
    flushLinkWrite(cur);
  }, LINK.delay);
}
// 状态文件被外面改了（人改、别的工具改）：版本更大就认领回来，只重画变了的那几张卡
function applyLinkDoc(doc) {
  if (!doc || !Array.isArray(doc.cards)) return false;
  const w = doc.id === TEMP_ID ? tempFlow : store.workflows.find(x => x.id === doc.id);
  if (!w) return false;
  if ((doc.version || 0) < (w.version || 0)) return false;
  if (document.querySelector('.node.dragging')) { setTimeout(() => applyLinkDoc(doc), 400); return false; }   // 正在拖卡：拖完再认领
  LINK.applying = true;
  if (doc.name) w.name = String(doc.name);
  if (doc.agent !== undefined) w.agent = doc.agent || '';
  // 状态文件是「人和 agent 共用的底稿」，它只带结构（卡片/模块/正文/实现/坐标）。
  // 卡片自己的对话、校验点、运行状态只活在这台机器上：按 id 认领回来，别因为外面改了一次就清空。
  const old = new Map(w.nodes.map(n => [n.id, n]));
  w.nodes = doc.cards.map(c => {
    const prev = old.get(c.id) || {};
    return {
      id: c.id || uid(),
      kind: ['in', 'proc', 'out'].includes(c.kind) ? c.kind : 'proc',
      title: String(c.title || ''), body: String(c.body || ''), impl: String(c.impl || ''),
      mods: (c.mods || []).map(m => ({ id: uid(), type: m.type || KIND_MOD[c.kind] || 'tool', name: String(m.name || '') })),
      checks: (prev.checks || []).slice(), chat: (prev.chat || []).slice(), status: prev.status || 'idle',
      preview: prev.preview || null, draft: !!c.draft, seed: !!c.seed,
      x: c.position ? Number(c.position.x) || 0 : 0, y: c.position ? Number(c.position.y) || 0 : 0,
    };
  });
  const ids = new Set(w.nodes.map(n => n.id));
  w.edges = (doc.edges || []).filter(e => Array.isArray(e) && ids.has(e[0]) && ids.has(e[1]));
  w.version = Math.max(w.version || 1, doc.version || 1);
  w.updated_at = doc.updated_at ? (Date.parse(doc.updated_at) || Date.now()) : Date.now();
  saveStore();                                                    // 落 localStorage；LINK.applying 挡掉回写，不会自己推自己
  LINK.applying = false;
  if (store.current === w.id) {
    $('#flowName').value = w.name;
    $('#flowAgent').innerHTML = agentOptionsHTML(w.agent);
    patchNodesDiff();
    $('#footStat').textContent = `${w.nodes.length} 卡 / ${w.edges.length} 连线 · v${w.version || 1}`;
  }
  renderWorkflowList();
  return true;
}
// 只补变了的那部分：新卡追加、改过的卡换掉自己那块、删掉的移走；连线重画
const nodeSig = n => JSON.stringify([n.kind, n.title, n.body, n.impl, modsOf(n).map(m => m.type + ':' + m.name), n.checks || [], n.x, n.y, n.seed ? 1 : 0, n.preview ? 1 : 0]);
function patchNodesDiff() {
  const w = flow(); if (!w) return;
  const live = new Map([...canvas.querySelectorAll('.node')].map(el => [el.dataset.id, el]));
  const keep = new Set();
  for (const n of w.nodes) {
    keep.add(n.id);
    const sig = nodeSig(n);
    const old = live.get(n.id);
    if (!old) { const el = nodeEl(n); el.dataset.sig = sig; canvas.appendChild(el); continue; }
    if (old.dataset.sig !== sig) { const el = nodeEl(n); el.dataset.sig = sig; old.replaceWith(el); }
  }
  for (const [id, el] of live) if (!keep.has(id)) el.remove();
  drawEdges();
  syncEmptyRead();
}
// 画布上的卡换了一张：只换这一块，不整张画布重建（拖拽不受影响）
function paintOne(n) {
  const sig = nodeSig(n);
  const old = canvas.querySelector(`.node[data-id="${n.id}"]`);
  if (old) {
    if (old.dataset.sig === sig) return false;
    const el = nodeEl(n); el.dataset.sig = sig; old.replaceWith(el);
  } else {
    const el = nodeEl(n); el.dataset.sig = sig; canvas.appendChild(el);
  }
  drawEdges();
  syncEmptyRead();                                  // 临时画布长卡不走 render()：这里把空画布按钮收掉，别挡在卡片前面
  return true;
}


// ---------- 版本：最近 20 版 + 控制台回滚 ----------
// 一条链路只留最近 20 版（用户明确说不要全量历史）。每一版是一份「能把整条链路带回去」的底稿：
// 卡片 / 连线 / 每张卡的模块 / 正文 / 内部实现 / 校验 / 坐标 / 执行方 / 链路名。
// 出「一版」的时机：一次完整改动（连续打字、连着加卡+连线按一次算；拖动位置不算内容改动）。
const hhmm = t => { const d = new Date(t || Date.now()); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

function verSnapshot(w) {
  return {
    name: w.name || '',
    agent: w.agent || '',
    cards: (w.nodes || []).map(n => ({
      id: n.id, kind: n.kind, title: n.title, body: n.body || '', impl: implOf(n),
      mods: modsOf(n).map(m => ({ type: m.type, name: m.name })),
      checks: (n.checks || []).slice(),
      x: Math.round(n.x || 0), y: Math.round(n.y || 0),
    })),
    edges: (w.edges || []).map(e => [e[0], e[1]]),
  };
}
// 内容指纹：不含坐标——挪卡片不算内容改动，不产生版本
function verContent(s) {
  if (!s) return '';
  return JSON.stringify([s.name || '', s.agent || '',
    (s.cards || []).map(c => [c.id, c.kind, c.title, c.body, c.impl, (c.mods || []).map(m => m.type + ':' + m.name), c.checks || []]),
    (s.edges || []).map(e => e.join('>')).sort()]);
}
// 这一版改了什么：说人话，是哪张卡的哪个环节（例：加工卡·出图：换了加工方式）
const BODY_WORD = { in: '换了输入元素', proc: '换了加工方式', out: '换了交付内容' };
function verWhat(prev, next) {
  if (!prev) return '新建链路';
  const parts = [];
  const pm = new Map((prev.cards || []).map(c => [c.id, c])), nm = new Map((next.cards || []).map(c => [c.id, c]));
  for (const c of next.cards || []) if (!pm.has(c.id)) parts.push(`加了卡「${c.title}」`);
  for (const c of prev.cards || []) if (!nm.has(c.id)) parts.push(`删了卡「${c.title}」`);
  for (const c of next.cards || []) {
    const o = pm.get(c.id); if (!o) continue;
    const f = [];
    if (o.kind !== c.kind) f.push('换了类型');
    if (o.title !== c.title) f.push('改了名字');
    if (o.body !== c.body) f.push(BODY_WORD[c.kind] || '换了内容');
    if (o.impl !== c.impl) f.push('改了内部实现');
    if (JSON.stringify(o.mods || []) !== JSON.stringify(c.mods || [])) f.push('改了模块');
    if (JSON.stringify(o.checks || []) !== JSON.stringify(c.checks || [])) f.push('改了校验');
    if (f.length) parts.push(`${(KINDS[c.kind] || KINDS.proc).label}卡·${c.title}：${f.join('、')}`);
  }
  const pe = new Set((prev.edges || []).map(e => e.join('>'))), ne = new Set((next.edges || []).map(e => e.join('>')));
  const addE = [...ne].filter(k => !pe.has(k)).length, delE = [...pe].filter(k => !ne.has(k)).length;
  if (addE) parts.push(`加了 ${addE} 条连线`);
  if (delE) parts.push(`删了 ${delE} 条连线`);
  if ((prev.agent || '') !== (next.agent || '')) parts.push(`执行方改成「${execName(next.agent)}」`);
  if ((prev.name || '') !== (next.name || '')) parts.push(`链路名改成「${next.name}」`);
  if (!parts.length) return '更新';
  return parts.slice(0, 5).join('；') + (parts.length > 5 ? ` 等 ${parts.length} 处` : '');
}
// 一次完整改动 = 一版：连续改动在 300ms 里并成一次，别把版本刷爆
// 待记的改动按链路 id 分开存（两条链路在同一瞬间各自改一下，谁也不丢）
function scheduleVersion(w, by) {
  if (!w || w.temp || w.id === TEMP_ID) return;
  if (LINK.applying) return;                          // 外部认领不是人改的：不记版本
  const sig = verContent(verSnapshot(w));
  if (sig === (VER.sig[w.id] || '')) return;           // 只有位置变了 → 不产生版本
  VER.pending[w.id] = by || changeBy || 'me';
  clearTimeout(VER.timer);
  VER.timer = setTimeout(commitVersions, VER.delay);
}
function commitVersions() {
  VER.timer = 0;
  const todo = VER.pending; VER.pending = {};
  for (const id of Object.keys(todo)) {
    const w = store.workflows.find(x => x.id === id);
    if (w) commitVersion(w, todo[id]);
  }
}
function commitVersion(w, by) {
  const snap = verSnapshot(w);
  const sig = verContent(snap);
  if (sig === (VER.sig[w.id] || '')) return;
  const list = VER.list[w.id] || [];
  const prev = list.length ? list[list.length - 1] : null;
  const v = prev ? Math.max(prev.v, w.version || 0) + 1 : Math.max(1, w.version || 1);
  w.version = v;
  if (w.rollback && !w.rollback.settled) w.rollback.settled = true;   // 回滚之后又改了内容：提示改成「曾经回滚」
  const entry = { v, at: Date.now(), by: by || 'me', what: verWhat(prev && prev.snapshot, snap), snapshot: snap };
  pushVersion(w.id, entry);
  syncFoot(w);                                        // 底部的「vN」跟着变：别让人以为版本没记上
  queueLinkWrite(w);                                   // 版本号变了，状态文件跟着写新版本号
}
function pushVersion(id, entry) {
  VER.sig[id] = verContent(entry.snapshot);
  VER.list[id] = (VER.list[id] || []).filter(x => x.v !== entry.v).concat([entry]).sort((a, b) => a.v - b.v).slice(-VER.max);
  try {
    const r = window.tcflow.versionPush({ id, entry });
    if (r && r.then) r.then(res => {
      if (res && Array.isArray(res.list)) VER.list[id] = res.list;
      if (res && res.path) VER.paths[id] = res.path;
      paintVersionBox();
    }).catch(() => { });
  } catch (e) { }
}

// agent 提议、人点了确认才落地的那几处：这一批改动记成「agent 提议后应用」
function saveAs(by) { const prev = changeBy; changeBy = by; saveStore(); changeBy = prev; }

// ---------- 编辑即版本：改正文 / 标题 / 内部实现 / 模块，也走同一条通道 ----------
// 用户口径（2026-11）：改一张卡里面的东西，也得立刻反映到画布和共享状态、记一版、agent 下次知道。
// 三条规矩：
//   1 画布当场变（syncCard / paintNodes），但绝不重建左栏——重建会抢焦点，光标会跳；
//   2 内容边打边同步：本地存储 300ms、共享状态文件 350ms 节流，都在 1 秒内，关窗口不丢字；
//   3 版本等「这次改完」才记：停手 1.5 秒或失焦。连打 30 个字也只出一版。
const EDIT_IDLE_MS = 1500;
const EDIT = { local: 0, ver: 0, paint: 0, id: '', by: 'me' };

// 面板里改了一处：立刻改内存 + 画布，落盘和记版本按节流排队
function saveEditing(opts = {}) {
  const w = flow(); if (!w) return;
  w.updated_at = Date.now();
  EDIT.id = w.id; EDIT.by = changeBy || 'me';
  clearTimeout(EDIT.local);
  EDIT.local = setTimeout(() => { EDIT.local = 0; saveLocal(); }, 300);
  queueLinkWrite(w);                                  // 状态文件按 350ms 节流：边打字边同步（1 秒内）
  clearTimeout(EDIT.ver);
  if (opts.commit) { EDIT.ver = 0; commitEditVersion(); return; }   // 失焦 = 这次改完
  EDIT.ver = setTimeout(() => { EDIT.ver = 0; commitEditVersion(); }, EDIT_IDLE_MS);  // 停手也算改完
}
// 把「这次改完」的内容落盘并记一版；内容没真变（只是点了面板/挪了位置）时 commitVersion 自己会跳过
function commitEditVersion() {
  saveLocal();
  const w = store.workflows.find(x => x.id === EDIT.id);
  if (!w || w.temp || w.id === TEMP_ID) return;       // 临时画布不记版本（和 B 卡一致）
  if (LINK.applying) return;                          // 外部认领不是人改的
  VER.pending[w.id] = EDIT.by || 'me';
  clearTimeout(VER.timer); VER.timer = 0;
  commitVersions();
  paintVersionBox();
}
// 还没到停手时间就把面板关了（Esc / 切卡 / 关窗口）：这次的改动当场记一版，别丢
function flushEditing() {
  if (!EDIT.ver) return;
  clearTimeout(EDIT.ver); EDIT.ver = 0;
  commitEditVersion();
}
addEventListener('beforeunload', () => { clearTimeout(EDIT.local); saveLocal(); });

// 载入/补一版基线：新链路第一次打开时先记下「现在长什么样」，之后每次改动才有回滚点
async function initVersions() {
  for (const w of store.workflows) {
    try {
      const r = await window.tcflow.versionList(w.id);
      const list = (r && r.list) || [];
      if (r && r.path) VER.paths[w.id] = r.path;
      if (!list.length) {
        w.version = w.version || 1;
        const snap = verSnapshot(w);
        const entry = { v: w.version, at: Date.now(), by: 'me', what: '开始记版本（当前状态）', snapshot: snap };
        VER.list[w.id] = [entry]; VER.sig[w.id] = verContent(snap);
        const res = await window.tcflow.versionPush({ id: w.id, entry });
        if (res && Array.isArray(res.list)) VER.list[w.id] = res.list;
        if (res && res.path) VER.paths[w.id] = res.path;
      } else {
        VER.list[w.id] = list;
        const top = list[list.length - 1];
        w.version = Math.max(w.version || 1, top.v || 1);
        VER.sig[w.id] = verContent(top.snapshot);
        if (top.rollback) w.rollback = { at: top.at, from: top.from, to: top.rollback.to, v: top.v, settled: false };
      }
    } catch (e) { }
  }
  paintVersionBox();
}

// 把一份快照搬回链路：卡片、连线、模块、正文、内部实现、校验、执行方、链路名一个不漏。
// 位置不搬到旧版：卡片没被回滚掉的继续待在原处（拖位置本来就是「不算改动」的东西）。
function applyVerSnapshot(w, snap, keepPos) {
  const old = new Map((w.nodes || []).map(n => [n.id, n]));
  if (snap.name) w.name = snap.name;
  w.agent = snap.agent || '';
  w.nodes = (snap.cards || []).map(c => {
    const prev = old.get(c.id) || {};
    const now = keepPos && keepPos.get(c.id);
    return {
      id: c.id || uid(),
      kind: ['in', 'proc', 'out'].includes(c.kind) ? c.kind : 'proc',
      title: String(c.title || ''), body: String(c.body || ''), impl: String(c.impl || ''),
      mods: (c.mods || []).map(m => ({ id: uid(), type: m.type || KIND_MOD[c.kind] || 'tool', name: String(m.name || '') })),
      checks: (c.checks || []).slice(), chat: (prev.chat || []).slice(), status: prev.status || 'idle',
      preview: prev.preview || null,
      x: now ? now.x : (Number(c.x) || 0), y: now ? now.y : (Number(c.y) || 0),
    };
  });
  const ids = new Set(w.nodes.map(n => n.id));
  w.edges = (snap.edges || []).filter(e => Array.isArray(e) && ids.has(e[0]) && ids.has(e[1]));
}

// 回滚：把整条链路带回第 v 版；回滚本身也记一版（不删后面的版本，所以回得去、也再回得来）
function rollbackTo(v) {
  const w = flow();
  if (!w || w.temp || w.id === TEMP_ID) return false;
  const list = VER.list[w.id] || [];
  const entry = list.find(x => x.v === Number(v));
  if (!entry || !entry.snapshot) return false;
  // 正在跑的对话先停掉：它跑在作废的链路上，不能让它继续做
  const stopped = cancelRunsFor(w.id);
  const from = w.version || 0;
  const keepPos = new Map(verSnapshot(w).cards.map(c => [c.id, c]));
  applyVerSnapshot(w, entry.snapshot, keepPos);
  const newV = Math.max(from, ...list.map(x => x.v || 0)) + 1;
  w.version = newV; w.updated_at = Date.now();
  w.rollback = { at: Date.now(), from, to: Number(v), v: newV, settled: false };
  const snap = verSnapshot(w);
  VER.sig[w.id] = verContent(snap);
  pushVersion(w.id, { v: newV, at: Date.now(), by: 'me', what: `回滚到 v${v}` + (stopped ? `（停掉 ${stopped} 个正在跑的对话）` : ''), snapshot: snap, rollback: { to: Number(v) } });
  if (!find(selId)) selId = null;
  if (!find(panelCardId)) { panelCardId = null; panelOpen = true; }
  saveStore(false);                                    // 落本地存储（不算新改动：版本已经在上面记了）
  queueLinkWrite(w);                                   // 状态文件立刻跟上
  renderWorkflowList();                                // 右栏的卡数/执行方跟着变
  render();
  centerView();                                        // 只挪视口，不动缩放：回滚不该把画面缩掉
  console.log(`[版本] 回滚 ${w.id}：v${from} → v${v}（记为新版本 v${newV}，停掉 ${stopped} 个运行）`);
  return true;
}

// 回滚（和关链路）时把这条链路上正在跑的对话停掉：真发取消到主进程，子进程会被 SIGTERM 杀掉
function cancelRunsFor(id) {
  let n = 0;
  for (const [runId, r] of RUNS) {
    if (r.flowId !== id) continue;
    r.cancelled = true; n++;
    try { window.tcflow.cancelAgent(runId); } catch (e) { }
    console.log(`[版本] 停掉正在跑的对话 ${runId}（链路 ${id} 已回滚，运行作废）`);
  }
  return n;
}

// 概览里的版本列表：最近 20 版，一条一行（第几版 / 什么时候 / 改了什么 / 谁改的），点一行回到那一版
function verRowsHTML(w) {
  const list = (VER.list[w.id] || []).slice().reverse();
  return list.map(e => `<div class="verrow${e.v === (w.version || 1) ? ' on' : ''}" data-v="${e.v}" title="v${e.v} · ${hhmm(e.at)} · ${esc(e.what || '')}（点一下回到这一版；回滚也算新的一版，随时再回来）">
      <b>v${e.v}</b><span class="vt">${hhmm(e.at)}</span>
      <span class="vw">${esc(e.what || '')}</span>
      <span class="vby${e.by === 'agent' ? ' agent' : ''}">${e.by === 'agent' ? 'agent' : '人'}</span>
    </div>`).join('');
}
function paintVersionBox() {
  const box = document.querySelector('#verList');
  const w = flow();
  syncFoot(w);
  if (!box) return;
  if (!w || w.temp || w.id === TEMP_ID) { box.innerHTML = ''; return; }
  box.innerHTML = verRowsHTML(w);
  box.querySelectorAll('.verrow').forEach(el => el.onclick = () => rollbackTo(el.dataset.v));
}
// 左下角那行「N 卡 / N 连线 · vN」：版本一涨就跟着刷，别停在旧号上
function syncFoot(w) {
  const el = document.querySelector('#footStat');
  if (!el || !w) return;
  el.textContent = `${w.nodes.length} 卡 / ${w.edges.length} 连线 · v${w.version || 1}`;
}


// ---------- 工作流 ----------
function createWorkflow(name, seed = false) {
  if (isTemp()) dropTemp();
  stopPreview();
  const w = { id: 'w' + Date.now().toString(36), name, agent: '', nodes: [], edges: [], chat: [], version: 1, updated_at: Date.now() };
  if (seed) {
    const a = { id: uid(), kind: 'in',   title: '商品编号', body: '一件示例商品（编号 A-1001），加上它上次采集的那批图（主图 5 张、详情长图 3 张）和页面上的标题、价格、规格。', checks: [],
                impl: '输入：商品编号（示例 A-1001）＋ 图片素材（主图 5 张、详情长图 3 张）＋ 页面字段', x: 0,   y: 70, status: 'idle' };
    const b = { id: uid(), kind: 'proc', title: '找证据包', body: '翻这件商品的采集记录，拿最近一次那份：图是不是齐的、页面字段有没有缺，缺就标出来。', checks: [],
                impl: '按编号查素材索引，取最近一次、图最全的那份目录', x: 330, y: 70, status: 'idle' };
    const c = { id: uid(), kind: 'out',  title: '证据目录', body: '一份资料清单：一共几张图、每张是主图还是详情图、页面上的标题/价格/规格各是什么值。', checks: ['sha256'],
                impl: '输出：图片清单（逐张）＋ 页面字段取值，逐项核对是否齐全', x: 660, y: 70, status: 'idle' };
    const d = { id: uid(), kind: 'proc', title: '出卖点卡', body: '对着这些图和页面文字，挑出 3–5 条能打广告的卖点、和同类商品的不同点，再列 3 条绝对不能写的话。', checks: ['schema', 'policy'],
                impl: '分三段产出：可用卖点 / 与他人不同的地方 / 不能说的话', x: 330, y: 420, status: 'idle' };
    const e = { id: uid(), kind: 'out',  title: '卖点卡', body: '一张卖点卡：每条卖点写了什么、用的是哪张图、能不能直接拿去用。', checks: ['schema'],
                impl: '输出卖点卡文件：每条含配图与能否直接用，按约定格式校验', x: 660, y: 420, status: 'idle' };
    w.nodes.push(a, b, c, d, e);
    w.nodes.forEach(n => { n.mods = modsFor(n.kind, n.body); });
    w.edges.push([a.id, b.id], [b.id, c.id], [c.id, d.id], [d.id, e.id]);
  }
  store.workflows.push(w); store.current = w.id; selId = null; panelCardId = null;
  saveStore(); renderWorkflowList(); render();
  return w;
}

// ---------- 复制链路：一键复制成一条独立副本 ----------
// 带过去：卡片（类型/名字/正文/内部实现/模块/校验/位置）、连线、执行方；不带的：对话、预演结果（那是原件这台机器上的记录）。
// 副本的每张卡、每块模块、每条连线都换新 id —— 改副本不影响原件，改原件也不影响副本。
function copyName(base) {
  const b = String(base || '').trim() || '未命名';
  let name = b + '（副本）', i = 2;
  while (store.workflows.some(w => w.name === name)) name = b + `（副本 ${i++}）`;
  return name;
}
function duplicateWorkflow(id) {
  const src = store.workflows.find(w => w.id === id);
  if (!src) return null;
  if (isTemp()) dropTemp();
  const idOf = new Map((src.nodes || []).map(n => [n.id, uid()]));
  const w = {
    id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: copyName(src.name),
    agent: src.agent || '',
    nodes: (src.nodes || []).map(n => ({
      id: idOf.get(n.id), kind: n.kind, title: n.title, body: n.body || '', impl: implOf(n),
      mods: modsOf(n).map(m => ({ id: uid(), type: m.type, name: m.name })),
      checks: (n.checks || []).slice(), chat: [], status: 'idle',
      x: Number(n.x) || 0, y: Number(n.y) || 0,
    })),
    edges: (src.edges || []).map(([a, b]) => [idOf.get(a), idOf.get(b)]).filter(([a, b]) => a && b),
    chat: [], version: 1, updated_at: Date.now(),
    copiedFrom: { id: src.id, name: src.name, at: Date.now() },
  };
  const at = store.workflows.indexOf(src);
  store.workflows.splice(at + 1, 0, w);
  store.current = w.id; selId = null; panelCardId = null; panelOpen = false;
  // 副本从第 1 版起记：先写一份基线，后面改动才有回滚点（和启动时 initVersions 同一套）
  const snap = verSnapshot(w);
  VER.sig[w.id] = verContent(snap);
  pushVersion(w.id, { v: 1, at: Date.now(), by: 'me', what: `复制自「${src.name}」`, snapshot: snap });
  try { window.tcflow.linkPath(w.id).then(p => { if (p) LINK.paths[w.id] = p; }).catch(() => { }); } catch (e) { }
  saveStore();                                   // 落本地存储 + 写副本自己的状态文件（内容没变，不会再记一版）
  renderWorkflowList(); render(); centerView();
  return w;
}
function switchWorkflow(id) { exitLive(); if (isTemp()) dropTemp(); stopPreview(); store.current = id; selId = null; panelCardId = null; panelOpen = false; saveStore(false); renderWorkflowList(); render(); centerView(); }
function deleteWorkflow(id, ev) {
  ev.stopPropagation();
  if (store.workflows.length <= 1) return alert('至少保留一个工作流');
  if (!confirm('删除这个工作流？画布内容会一起删掉。')) return;
  stopPreview();
  store.workflows = store.workflows.filter(w => w.id !== id);
  if (store.current === id) store.current = store.workflows[0].id;
  delete VER.list[id]; delete VER.sig[id]; delete VER.paths[id];
  try { window.tcflow.versionDrop(id); } catch (e) { }   // 链路删了，它的版本底稿也一起清掉
  try { window.tcflow.linkDrop(id); delete LINK.paths[id]; } catch (e) { }   // 共享状态文件也不留（副本删掉后不残留文件）
  saveStore(false); renderWorkflowList(); render();
}
function renderWorkflowList() {
  const box = $('#wfList'); box.innerHTML = '';
  const live = document.createElement('div');
  live.className = 'wf live' + (liveMode ? ' on' : '');
  live.dataset.live = '1';
  live.title = '跟着一条 Hermes 对话，看它现在怎么做（只读）';
  live.innerHTML = `<div class="wn">实时工作流${liveMode ? '<span class="wsel">当前</span>' : ''}</div>
    <div class="ws">跟一条对话，看它现在怎么做</div>`;
  live.onclick = () => enterLive();
  box.appendChild(live);
  for (const w of store.workflows) {
    const el = document.createElement('div');
    const on = w.id === store.current && !liveMode;
    el.className = 'wf' + (on ? ' on' : '');
    el.dataset.id = w.id;
    el.onclick = () => switchWorkflow(w.id);
    el.innerHTML = `<div class="wn">${esc(w.name)}${on ? '<span class="wsel">选中</span>' : ''}</div>
      <div class="ws">${w.nodes.length} 卡 · ${w.agent ? esc(execName(w.agent)) : '<span style="color:#c2410c">未指派</span>'}</div>
      <div class="dup" title="复制这条链路">⧉</div>
      <div class="x" title="删除">✕</div>`;
    el.querySelector('.dup').onclick = (ev) => { ev.stopPropagation(); duplicateWorkflow(w.id); };
    el.querySelector('.x').onclick = (ev) => deleteWorkflow(w.id, ev);
    box.appendChild(el);
  }
}
function agentName(id) { const a = agents.find(x => x.id === id); return a ? a.name : id; }
function dockAgentName() { return '平台主管'; }
// 执行方的显示名：右下角对话框那条固定是平台主管（profile 名 default 不在岗位列表里）
const execName = id => (!id ? '未指派' : (id === DOCK_AGENT ? '平台主管' : agentName(id)));
function isStopped(id) { const a = agents.find(x => x.id === id); return !a || a.stopped; }

// 只列在用岗；已停用的折叠进 disabled 分组，避免误派
function agentOptionsHTML(sel) {
  const cur = agents.find(a => a.id === sel);
  const act = agents.filter(a => !a.stopped || a.id === sel);
  const stop = agents.filter(a => a.stopped && a.id !== sel);
  let h = `<option value="">— 未指派 —</option>`;
  // 右下角对话框固定对接平台主管（default profile），它不在 profiles/ 目录下，但得能选中、显示成「平台主管」
  const supOpt = agents.some(a => a.id === DOCK_AGENT) ? ''
    : `<option value="${DOCK_AGENT}" ${sel === DOCK_AGENT ? 'selected' : ''}>${esc(execName(DOCK_AGENT))}（${DOCK_AGENT}）</option>`;
  h += `<optgroup label="在用（派工白名单）">` + supOpt +
    act.map(a => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)}（${a.id}）</option>`).join('') +
    `</optgroup>`;
  if (stop.length) h += `<optgroup label="已停用（不在派工白名单）">` +
    stop.map(a => `<option value="${a.id}" disabled>${esc(a.name)}（${a.id}）</option>`).join('') + `</optgroup>`;
  return h;
}

// ---------- 卡片 ----------
function addNode(kind, props = {}, select = true) {
  const base = { id: uid(), kind, title: KINDS[kind].label + '卡', body: '', impl: '', mods: [], checks: [], chat: [], status: 'idle' };
  const offset = flow().nodes.filter(n => n.kind === kind).length * 28;
  const n = Object.assign(base, { x: 60 + offset, y: 520 + offset }, props);
  flow().nodes.push(n);
  if (select) selId = n.id;
  saveStore(); renderWorkflowList(); render();   // 右栏的「N 卡」跟着变
  return n;
}
function delNode(id) {
  flow().nodes = flow().nodes.filter(n => n.id !== id);
  flow().edges = flow().edges.filter(([a, b]) => a !== id && b !== id);
  if (selId === id) selId = null;
  if (panelCardId === id) { panelCardId = null; panelOpen = false; }
  saveStore(); renderWorkflowList(); render();
}
function connect(aId, bId, animate = true) {
  if (aId === bId) return;
  const w = flow();
  if (w.edges.some(([a, b]) => a === aId && b === bId)) return;
  w.edges.push([aId, bId]); saveStore(); render();
  if (animate) drawIn(`${aId}>${bId}`);          // 新连线都「画」出来
}

// ---------- 渲染 ----------
function render() {
  const w = flow(); if (!w) return;
  flushEditing();                                   // 面板要重建了：手上没落的那次编辑先记一版
  $('#flowName').value = w.name;
  $('#flowAgent').innerHTML = agentOptionsHTML(w.agent);

  rebuildNodes();

  // 概览自动隐藏：没选卡片就把右栏收起来，画布变大
  applyPanelState();

  applyZoom();
  drawEdges();
  renderPanel();
  renderDock();
  renderTempBar();
  $('#footStat').textContent = `${w.nodes.length} 卡 / ${w.edges.length} 连线 · v${w.version || 1}`;
  syncEmptyRead();
}
// 空画布上的「读取 agent 链路」按钮：跟着卡片数走。
// 不能只在 render() 里切——临时画布的卡是 paintOne 长出来的，不走 render，会残留一层挡在画布中央。
function syncEmptyRead() {
  const el = $('#emptyRead'); if (!el) return;
  const w = flow(); el.classList.toggle('on', !(w && w.nodes.length));
}
function rebuildNodes() {
  for (const el of [...canvas.querySelectorAll('.node')]) el.remove();
  for (const n of flow().nodes) canvas.appendChild(nodeEl(n));
}
// 只重画画布上的卡（左栏里正在编辑时用：不重建面板、不抢焦点）
function paintNodes() { rebuildNodes(); drawEdges(); syncEmptyRead(); }
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
  el.dataset.sig = nodeSig(n);
  if (n.draft) el.classList.add('draft');
  if (editMode) el.classList.add('editing');
  el.title = '双击打开右栏：改名字、和 agent 聊这张卡';
  el.innerHTML = `
    <div class="hd">
      <span class="kind">${k.label}${n.seed ? ' · 起草中' : ''}</span>
      <div class="t">${esc(n.title)}</div>
      <div class="st ${n.status}">${statusDot(n)}</div>
    </div>
    <div class="body" data-ph="${esc(k.ph)}">${esc(n.body)}</div>
    ${modsHTML(n)}
    <textarea class="note" placeholder="这张卡要写清什么？写参考，保留时挪到上方做描述">${esc(n.note || '')}</textarea>
    <div class="ft">
      <div class="checks">${(n.checks || []).map(c => `<span class="chip">${esc(c)}</span>`).join('')}${n.preview ? `<span class="chip pvchip" title="这张卡有只读预演的结论（左栏 / 测试里看）">预演 ✓</span>` : ''}</div>
      ${implOf(n) ? '<span class="gar" data-act="impl" title="内部实现已封装：卡片上不显示，点开看">⚙</span>' : ''}
      <span class="mini" data-act="ask" title="在右栏问 agent 这张卡">? 问</span>
      <span class="mini" data-act="opt" title="让 agent 给下一步候选，选一个加进流程">✦ 下一步</span>
      <span class="mini" data-act="link" title="拖到另一张卡建立连线">↗ 连线</span>
    </div>`;

  const noteEl = el.querySelector('.note');
  if (noteEl) {
    noteEl.addEventListener('pointerdown', ev => ev.stopPropagation());
    noteEl.addEventListener('dblclick', ev => ev.stopPropagation());
    noteEl.addEventListener('input', () => { n.note = noteEl.value; saveLocal(); });
  }
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

// 卡片上的模块区。输入/输出卡：自己的素材/成果；加工卡：素材插槽 + 自带的工具 + 成果插槽
function chipHTML(m) { return `<span class="mod t-${m.type}" title="${esc(m.name)}">${esc(m.name)}</span>`; }
// 接进插槽的卡：它带的模块就是插在槽里的东西（没有模块就用卡名）
function plugChips(src, dir) {
  const ms = src.kind === 'proc' ? [] : modsOf(src);
  // 加工卡直接接加工卡：上一步交过来的是它的成果；没有模块就用卡名
  const list = ms.length ? ms : [{ type: src.kind === 'proc' ? 'res' : (KIND_MOD[src.kind] || 'mat'), name: src.title }];
  return list.map(m => `<span class="mod t-${m.type} plug" data-src="${src.id}" data-dir="${dir}" title="来自「${esc(src.title)}」：${esc(m.name)}">${esc(m.name)}</span>`).join('');
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
  const tools = modsOf(n);
  return `<div class="mods">${sock('in', ups, '拖输入卡进来')}${tools.length ? line('工具', tools.map(chipHTML).join(''), ' tools') : ''}${sock('out', downs, '拖输出卡进来')}</div>`;
}
function plugKey(procId, chip) { return chip.dataset.dir === 'in' ? `${chip.dataset.src}>${procId}` : `${procId}>${chip.dataset.src}`; }
function peer(srcId, key, on) {
  const s = canvas.querySelector(`.node[data-id="${srcId}"]`); if (s) s.classList.toggle('peer', on);
  const p = edgesSvg.querySelector(`path[data-k="${key}"]`); if (p) p.classList.toggle('hl', on);
}

function markSel() {
  document.querySelectorAll('.node').forEach(el => el.classList.toggle('sel', el.dataset.id === selId));
  applyPanelState();
}
function statusDot(n) { return ({ running: '●', ok: '✓', warn: '!', fail: '✕', ready: '▶' })[n.status] || ''; }

// 连线的弯曲程度只在结构变化（自动排版 / 新建连线 / 导入）时重算一次；
// 拖动卡片只平移、拉长端点，用的还是当初那个控制点偏移——拖的时候线不会自己换弯法。
const EDGE_DX = new Map();          // "a>b" → 控制点水平偏移（一半的水平间距）
function drawEdges(opts) {
  const recalc = !!(opts && opts.recalc);
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
  const liveKeys = new Set();
  let h = `<defs><marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 z" fill="rgba(17,17,17,.42)"/></marker></defs>`;
  for (const [a, b] of w.edges) {
    const ea = canvas.querySelector(`.node[data-id="${a}"]`), eb = canvas.querySelector(`.node[data-id="${b}"]`);
    if (!ea || !eb) continue;
    const [x1, y1] = end(ea, find(a), 'out'), [x2, y2] = end(eb, find(b), 'in');
    const k = a + '>' + b;
    liveKeys.add(k);
    let dx = EDGE_DX.get(k);
    if (recalc || dx === undefined || !Number.isFinite(dx)) { dx = (x2 - x1) / 2; EDGE_DX.set(k, dx); }
    const c1 = x1 + dx, c2 = x2 - dx;
    h += `<path class="edge" data-k="${a}>${b}" d="M${x1},${y1} C${c1},${y1} ${c2},${y2} ${x2},${y2}" fill="none" stroke="rgba(17,17,17,.30)" stroke-width="1.6" marker-end="url(#ar)"/>`;
  }
  for (const k of [...EDGE_DX.keys()]) if (!liveKeys.has(k)) EDGE_DX.delete(k);
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
// 顺着连线从 from 走，能不能走到 to
function reaches(from, to) {
  const edges = flow().edges, seen = new Set([from]), todo = [from];
  while (todo.length) {
    const cur = todo.pop();
    if (cur === to) return true;
    for (const [p, q] of edges) if (p === cur && !seen.has(q)) { seen.add(q); todo.push(q); }
  }
  return false;
}
function ghostChips(n) {
  const ms = modsOf(n);
  const list = ms.length ? ms : [{ type: KIND_MOD[n.kind] || 'mat', name: n.title }];
  return list.map(m => `<span class="mod t-${m.type} ghost">${esc(m.name)}</span>`).join('');
}
// 接上以后卡片放哪：素材在加工卡左边、成果在右边；和别的卡撞了就往下挪
function dockSpot(n, pn, sock) {
  const size = id => { const e = id && canvas.querySelector(`.node[data-id="${id}"]`); return { w: e ? e.offsetWidth : 244, h: e ? e.offsetHeight : 160 }; };
  const me = size(n.id), pz = size(pn.id), GAP = 64, PAD = 14;
  const x = sock === 'in' ? pn.x - me.w - GAP : pn.x + pz.w + GAP;
  const others = flow().nodes.filter(o => o.id !== n.id).map(o => Object.assign({ x: o.x, y: o.y }, size(o.id)));
  const clash = y => others.some(b => x < b.x + b.w + PAD && b.x < x + me.w + PAD && y < b.y + b.h + PAD && b.y < y + me.h + PAD);
  let y = pn.y, i = 0;
  while (clash(y) && i++ < 60) y += 36;
  return { x: Math.round(x), y: Math.round(y) };
}
function dockInto(n, d, token) {
  const w = flow();
  const spot = dockSpot(n, d.pn, d.sock);
  n.x = spot.x; n.y = spot.y;
  if (!w.edges.some(([a, b]) => a === d.a && b === d.b)) w.edges.push([d.a, d.b]);
  saveStore(); render();
  playDock(n, d, token);
}
// 接入动画：① 小块弹回原大、落到加工卡旁边 ② 模块一块块飞进插槽、落地弹一下
//           ③ 连线从起点画到插槽，光点沿线跑一遍，插槽一圈涟漪
function playDock(n, d, token) {
  if (reducedMotion()) return;
  const el = canvas.querySelector(`.node[data-id="${n.id}"]`);
  const pe = canvas.querySelector(`.node[data-id="${d.pn.id}"]`);
  if (!el || !pe) return;
  const r = el.getBoundingClientRect();
  el.style.transformOrigin = '0 0';
  el.animate([
    { transform: `translate(${(token.left - r.left) / zoom}px, ${(token.top - r.top) / zoom}px) scale(${token.width / r.width})`, opacity: .85 },
    { transform: 'none', opacity: 1 },
  ], { duration: 480, easing: 'cubic-bezier(.2,1.25,.35,1)' }).onfinish = () => { el.style.transformOrigin = ''; };
  const sock = pe.querySelector(`.sock[data-sock="${d.sock}"]`);
  const cx = token.left + token.width / 2, cy = token.top + token.height / 2;
  const chips = sock ? [...sock.querySelectorAll(`.mod.plug[data-src="${n.id}"]`)] : [];
  chips.forEach((c, i) => {
    const cr = c.getBoundingClientRect();
    const f = makeFlyer(c);
    c.style.opacity = '0';
    const sx = cx - cr.left - cr.width * .2, sy = cy - cr.top - cr.height * .2;
    const a = f.animate([
      { transform: `translate(${sx}px, ${sy}px) scale(${zoom * .4})`, opacity: 0 },
      { transform: `translate(${sx * .4}px, ${sy * .4 - 22 * zoom}px) scale(${zoom * 1.1})`, opacity: 1, offset: .55 },
      { transform: `translate(0px, 0px) scale(${zoom})`, opacity: 1 },
    ], { duration: 480, delay: 60 + i * 60, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'backwards' });
    let landed = false;
    const land = () => {
      if (landed) return; landed = true;
      f.remove(); c.style.opacity = '';
      c.animate([{ transform: 'scale(1.22)' }, { transform: 'scale(1)' }], { duration: 220, easing: 'cubic-bezier(.2,1.5,.4,1)' });
    };
    a.onfinish = land; setTimeout(land, 900 + i * 60);
  });
  pe.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.02)' }, { transform: 'scale(1)' }], { duration: 340, delay: 360, easing: 'ease-out' });
  drawIn(`${d.a}>${d.b}`, () => { if (sock && sock.isConnected) flashSock(sock); }, 200);
}
// 接不了（会绕成圈）：插槽摇一下头，卡片弹回拖起的地方
function denyDock(n, el, d, from, token) {
  const sock = d.pe.querySelector(`.sock[data-sock="${d.sock}"]`);
  n.x = from.x; n.y = from.y;
  el.style.left = (n.x + OX) + 'px'; el.style.top = (n.y + OY) + 'px';
  drawEdges(); saveStore(false);            // 弹回原处只是挪位置：不产生版本
  if (reducedMotion()) { el.style.transition = ''; return; }
  if (sock) sock.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(5px)' },
    { transform: 'translateX(-3px)' }, { transform: 'translateX(0)' }], { duration: 340, easing: 'ease-in-out' });
  const r = el.getBoundingClientRect();
  el.style.transformOrigin = '0 0';
  const a = el.animate([
    { transform: `translate(${(token.left - r.left) / zoom}px, ${(token.top - r.top) / zoom}px) scale(${token.width / r.width})`, opacity: .85 },
    { transform: 'none', opacity: 1 },
  ], { duration: 480, easing: 'cubic-bezier(.2,1.1,.35,1)' });
  const done = () => { el.style.transition = ''; el.style.transformOrigin = ''; };
  a.onfinish = done; a.oncancel = done;
}
// 模块的替身：挂在 body 上飞（画布在缩放层里，替身要乘回 zoom 才和原块一样大）
function makeFlyer(chip) {
  const r = chip.getBoundingClientRect();
  const f = chip.cloneNode(true);
  f.classList.remove('ghost', 'lifting');
  f.classList.add('flyer');
  Object.assign(f.style, {
    position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: (r.width / zoom) + 'px', margin: '0', opacity: '',
    transformOrigin: '0 0', transform: `scale(${zoom})`, zIndex: '300', pointerEvents: 'none',
  });
  document.body.appendChild(f);
  return f;
}
// 新连线自己画出来：从起点描到终点，然后光点沿线跑到头，终点一圈涟漪
function drawIn(key, done, delay = 0) {
  const fin = () => { if (done) done(); };
  if (reducedMotion()) return fin();
  const p = edgesSvg.querySelector(`path[data-k="${key}"]`);
  if (!p) return fin();
  const len = p.getTotalLength();
  const mk = p.getAttribute('marker-end');
  p.removeAttribute('marker-end');
  p.classList.add('drawing');
  p.style.strokeDasharray = `${len} ${len}`;
  const a = p.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
    { duration: 480, delay, easing: 'cubic-bezier(.3,.6,.2,1)', fill: 'backwards' });
  let fired = false;
  const end = () => {
    if (fired) return; fired = true;
    p.style.strokeDasharray = ''; p.classList.remove('drawing');
    if (mk) p.setAttribute('marker-end', mk);
    pulseAlong(key, pt => { if (pt) ripple(pt.x, pt.y); fin(); });
  };
  a.onfinish = end; setTimeout(end, delay + 800);
}
// 断开：连线往拔出的那一头缩回去（sign 1 = 缩向起点，-1 = 缩向终点）
function retractEdge(key, sign, done) {
  const p = edgesSvg.querySelector(`path[data-k="${key}"]`);
  if (!p || reducedMotion()) return done();
  const len = p.getTotalLength();
  p.removeAttribute('marker-end');
  p.style.strokeDasharray = `${len} ${len}`;
  const a = p.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: sign * len }], { duration: 300, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' });
  let fired = false;
  const fin = () => { if (fired) return; fired = true; done(); };
  a.onfinish = fin; setTimeout(fin, 520);
}
// 光点沿线跑一遍。每帧按 key 重新取线：中途画布重绘了也跟着新线走，线没了就收
function pulseAlong(key, done) {
  const cur = () => edgesSvg.querySelector(`path[data-k="${key}"]`);
  const p = cur();
  if (!p) return done && done(null);
  const p0 = p.getPointAtLength(0);
  const dot = document.createElementNS(SVGNS, 'circle');
  dot.setAttribute('r', '4.5'); dot.setAttribute('class', 'pulse');
  dot.setAttribute('cx', p0.x); dot.setAttribute('cy', p0.y);
  fxSvg.appendChild(dot);
  const t0 = performance.now(), dur = Math.max(280, Math.min(560, p.getTotalLength() * 1.3));   // 短线跑得快，长线不拖沓
  const step = now => {
    const q = cur();
    if (!q) { dot.remove(); return done && done(null); }
    const t = Math.min(1, (now - t0) / dur), k = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const pt = q.getPointAtLength(q.getTotalLength() * k);
    dot.setAttribute('cx', pt.x); dot.setAttribute('cy', pt.y);
    if (t < 1) requestAnimationFrame(step); else { dot.remove(); if (done) done(pt); }
  };
  requestAnimationFrame(step);
}
function ripple(x, y) {
  const c = document.createElementNS(SVGNS, 'circle');
  c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', '18'); c.setAttribute('class', 'ripple');
  fxSvg.appendChild(c);
  const a = c.animate([{ transform: 'scale(.15)', opacity: .9 }, { transform: 'scale(1)', opacity: 0 }],
    { duration: 560, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' });
  a.onfinish = () => c.remove(); setTimeout(() => c.remove(), 900);
}
function flashSock(sock) {
  sock.animate([
    { boxShadow: '0 0 0 0 rgba(255,90,31,.5)', backgroundColor: 'rgba(255,90,31,.16)' },
    { boxShadow: '0 0 0 10px rgba(255,90,31,0)', backgroundColor: 'rgba(255,90,31,0)' },
  ], { duration: 520, easing: 'ease-out' });
}
// 从加工卡的插槽里把模块拖出去：出了这张卡松手 = 断开；没出去就飞回原位
function unplugDrag(e, pn, pe, chip) {
  const src = chip.dataset.src, dir = chip.dataset.dir, key = plugKey(pn.id, chip);
  const sx = e.clientX, sy = e.clientY;
  const same = [...pe.querySelectorAll(`.mod.plug[data-src="${src}"][data-dir="${dir}"]`)];
  const path = () => edgesSvg.querySelector(`path[data-k="${key}"]`);
  let ghost = null, out = false;
  const move = ev => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      ghost = makeFlyer(chip);
      same.forEach(c => c.classList.add('lifting'));
      document.body.classList.add('grabbing');
    }
    ghost.style.transform = `translate(${ev.clientX - sx}px, ${ev.clientY - sy}px) scale(${zoom})`;
    const r = pe.getBoundingClientRect();
    out = ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom;
    ghost.classList.toggle('cut', out);
    const p = path(); if (p) p.classList.toggle('cutting', out);
  };
  const up = () => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up);
    document.body.classList.remove('grabbing');
    if (!ghost) return;                                  // 只是点了一下：什么都不做（双击照常打开卡片）
    const g = ghost, at = g.style.transform;
    if (!out) {                                          // 没拖出这张卡：飞回原位
      const back = () => { g.remove(); same.forEach(c => c.classList.remove('lifting')); const p = path(); if (p) p.classList.remove('cutting'); };
      if (reducedMotion()) return back();
      g.animate([{ transform: at }, { transform: `translate(0px, 0px) scale(${zoom})` }], { duration: 200, easing: 'cubic-bezier(.3,.7,.2,1)' }).onfinish = back;
      return;
    }
    if (!reducedMotion()) {
      g.animate([{ transform: at, opacity: 1 }, { transform: `${at} scale(.5)`, opacity: 0 }], { duration: 240, easing: 'ease-in', fill: 'forwards' });
      same.forEach(c => c.animate([{ opacity: .28 }, { opacity: 0, transform: 'scale(.6)' }], { duration: 220, fill: 'forwards' }));
    }
    retractEdge(key, dir === 'in' ? 1 : -1, () => {
      g.remove();
      const [a, b] = key.split('>');
      const w = flow();
      w.edges = w.edges.filter(([x, y]) => !(x === a && y === b));
      saveStore(); render();
    });
  };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
}

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
      <div class="verbox">
        <div class="verhd">版本<span class="sp"></span><span class="vn">v${w.version || 1} · ${(VER.list[w.id] || []).length} 条</span></div>
        <div class="verlist" id="verList"></div>
      </div>
      <button id="pAskFlow" class="primary" style="width:100%;margin-top:12px">让 agent 看整条流程</button>
      <div id="agentOut">（agent 会读全部卡片，指出断链、缺校验的地方）</div>`;
    $('#pFlowAgent').onchange = e => { w.agent = e.target.value; saveStore(); renderWorkflowList(); render(); };
    $('#pAskFlow').onclick = askFlow;
    paintVersionBox();                                  // 版本列表：点一行就回到那一版
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
    <div class="pmods"><span class="lab">${MOD_T[KIND_MOD[n.kind]]}</span>
      <div class="pm-list" id="pMods">${modsOf(n).map((m, i) => `<span class="mod t-${m.type} ed"><span class="mn" contenteditable="plaintext-only" spellcheck="false" data-i="${i}">${esc(m.name)}</span><b class="mx" data-x="${i}" title="删掉这块">✕</b></span>`).join('')}<input id="pModAdd" class="pm-add" placeholder="+ ${MOD_T[KIND_MOD[n.kind]]}（回车添加）"></div>
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

    ${n.preview ? `<div class="pvbox"><div class="pvhd"><b>预演结果</b><span>${hhmm(n.preview.at)} · 只读 · 工具调用 ${n.preview.steps || 0} 次</span></div><div class="pvtext">${esc(n.preview.text)}</div></div>` : ''}

    <details class="internal">
      <summary>⚙ 内部实现 · 校验 · 卡片上不显示</summary>
      <textarea id="pImpl" placeholder="执行时真正跑什么：命令 / 脚本 / 路径 / 字段名（例：hermes -p &lt;agent&gt; chat -q …、evidence/&lt;包&gt;/page-fields）">${esc(implOf(n))}</textarea>
      <input id="pChecks" value="${esc((n.checks || []).join(', '))}" placeholder="校验项，逗号分隔（例：sha256, schema）">
    </details>`;

  $('#pTitle').oninput = e => { n.title = e.target.value; syncCard(n); saveEditing(); };
  $('#pTitle').onchange = () => {
    if (!n.title.trim()) n.title = k.label + '卡';           // 清空了就回到默认名，别留一张没名字的卡
    t.textContent = `${KINDS[n.kind].label}卡 · ${n.title}`;
    renderWorkflowList(); syncCard(n);
    saveEditing({ commit: true });                            // 失焦 = 这次改完，立刻记一版
  };
  $('#pKind').onchange = e => { n.kind = e.target.value; n.mods = modsOf(n).map(m => ({ ...m, type: KIND_MOD[n.kind] })); saveEditing({ commit: true }); render(); };
  $('#pBody').oninput = e => { n.body = e.target.value.replace(/\u00a0/g, ' '); syncCard(n); saveEditing(); };
  $('#pBody').onchange = () => saveEditing({ commit: true });
  $('#pChecks').onchange = e => { n.checks = e.target.value.split(',').map(s => s.trim()).filter(Boolean); paintNodes(); saveEditing({ commit: true }); };
  $('#pImpl').oninput = e => { n.impl = e.target.value.replace(/\u00a0/g, ' '); saveEditing(); };
  $('#pImpl').onchange = e => { n.impl = e.target.value.replace(/\u00a0/g, ' ').trim(); paintNodes(); saveEditing({ commit: true }); };
  // 模块：直接改名、清空即删，✕ 删，回车加一块；只重画画布，不重建面板（不抢焦点）
  b.querySelectorAll('#pMods .mn').forEach(sp => {
    sp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); sp.blur(); } });
    sp.addEventListener('input', () => {                    // 改模块名边打边同步：画布 250ms 后跟手重画
      const i = +sp.dataset.i; if (!n.mods || !n.mods[i]) return;
      n.mods[i].name = sp.textContent.replace(/\s+/g, ' ').trim().slice(0, 24);
      clearTimeout(EDIT.paint);
      EDIT.paint = setTimeout(() => { EDIT.paint = 0; paintNodes(); }, 250);
      saveEditing();
    });
    sp.addEventListener('blur', () => {
      const i = +sp.dataset.i, v = sp.textContent.replace(/\s+/g, ' ').trim().slice(0, 24);
      if (!n.mods || !n.mods[i]) return;
      if (!v) { n.mods.splice(i, 1); paintNodes(); saveEditing({ commit: true }); renderPanel(); return; }
      n.mods[i].name = v; paintNodes();
      saveEditing({ commit: true });                        // 失焦 = 这次改完（内容没变就不会多一版）
    });
  });
  b.querySelectorAll('#pMods .mx').forEach(x => x.addEventListener('click', () => {
    if (!n.mods) return;
    n.mods.splice(+x.dataset.x, 1); paintNodes(); saveEditing({ commit: true }); renderPanel();
  }));
  $('#pModAdd').addEventListener('keydown', ev => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    const v = ev.target.value.replace(/\s+/g, ' ').trim().slice(0, 24); if (!v) return;
    n.mods = modsOf(n).concat([{ id: uid(), type: KIND_MOD[n.kind] || 'tool', name: v }]);
    paintNodes(); saveEditing({ commit: true }); renderPanel();
    const i = $('#pModAdd'); if (i) i.focus();
  });

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
// 候选卡的模块：和卡片上的素材/工具/成果同一套口径
const MODS_RULE = 'mods 把这张卡用到的东西拆成短词模块（每块 8 个字以内，说人话）：输入卡写素材（哪几张图、哪些数据），加工卡写工具（怎么挑、怎么比、怎么查），输出卡写成果（交出的文件里有哪几样）。';
// 共享链路状态：agent 每次都拿得到「现在是第几版、这条链路长什么样、状态文件在哪」，但只能读
const LINK_RULE = '画布你只能读：不能加卡、改字、删卡、连线。你想改，就在回答里写一条提议（「提议：把「卡名」的加工方式改成 …」），人点了才会生效；不要说「我已经改好了」。状态文件也是只读的：不要用写文件、跑命令之类的工具去改它。';
function linkBrief(w) {
  const p = LINK.paths[w.id] || (w.temp ? '（临时画布：应用数据目录 links/__temp__.json）' : '（应用数据目录 links/ 下，按链路 id 命名）');
  const vp = VER.paths[w.id];
  return [
    `【这条链路的状态 · 只读】第 ${w.version || 1} 版｜执行方：${execName(w.agent)}｜${w.nodes.length} 张卡 / ${w.edges.length} 条连线`,
    `状态文件（可以直接打开读；卡片、模块、内部实现、连线都在里面）：${p}`,
    vp ? `版本记录（最近 ${VER.max} 版，含每次改动与回滚）：${vp}` : '',
    LINK_RULE,
  ].filter(Boolean).join('\n');
}
// 「现在是第几版、刚才回滚到哪一版」——只走「叫 agent 的那一下把上下文写进提示词」，不改任何岗位配置、不动 SOUL.md
function verHead(w) {
  const v = w.version || 1, rb = w.rollback;
  if (!rb) return [`【当前链路版本 v${v}】`];
  if (!rb.settled) return [`【版本状态 · 必须出现在你回答的第一句话里】当前链路版本 v${v}；用户在 ${hhmm(rb.at)} 把它回滚到了 v${rb.to}，v${rb.to} 之后的改动已作废。`];
  return [`【版本状态】当前链路版本 v${v}；用户曾在 ${hhmm(rb.at)} 把它回滚到 v${rb.to}，之后又改过（已记为新版本）。`];
}
async function askFlow() {
  const w = flow();
  if (!w.agent) { alert('先给整条工作流指派一个 agent'); return; }
  if (!$('#agentOut')) { panelOpen = true; panelCardId = null; render(); }
  const out = $('#agentOut');
  const desc = chainOrder(w).map(cardLine).join('\n');
  const prompt = [...verHead(w),
    '你是这条工作流的执行方。只做评审：不执行、不发请求、不改文件、不付费。',
    PLAIN_RULE,
    `工作流：${w.name}`, desc, '',
    linkBrief(w), '',
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
  txt.innerHTML = mdToHTML(m.human || m.text || '');
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
    const shown = m.human || m.text;                     // 有「人话摘要」就显示摘要（原始 JSON 收进折叠块）
    const rawBox = (m.human && m.text && m.text !== m.human)
      ? `<details class="more raw"><summary>看原话</summary><div class="txt"><pre>${esc(m.text)}</pre></div></details>` : '';
    const body = (shown ? (shown.length > 900 && !m.live
      ? `<div class="txt">${mdToHTML(shown.slice(0, 600))}</div><details class="more"><summary>展开全文（${shown.length} 字）</summary><div class="txt">${mdToHTML(shown)}</div></details>`
      : `<div class="txt">${mdToHTML(shown)}</div>`) : '') + rawBox;
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
          <div class="cf-row"><span class="lab">${esc(MOD_T[KIND_MOD[o.kind]] || '模块')}</span><span>${(o.mods || []).map(m => esc(m.name)).join('、') || '（无）'}</span></div>
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
    ...verHead(w),
    '我们在工作流开发平台里聊一条工作流，你作为执行方只做建议：不执行、不发请求、不改文件、不付费。',
    PLAIN_RULE,
    `工作流：${w.name}`,
    `整条流程：\n${chainOrder(w).map(cardLine).join('\n')}`,
    linkBrief(w),
    `现在这张卡：[${KINDS[n.kind].label}] ${n.title}`,
    `内容（人话）：${n.body || '(空)'}｜内部实现：${implOf(n) || '(未填)'}｜校验：${(n.checks || []).join(',') || '无'}`,
    hist ? `上文对话：\n${hist}` : '',
    `我说：${text}`,
    '回答用大白话、短一点。如果我要的是「下一步」候选卡，只输出 JSON 数组，不要解释：',
    MODS_RULE,
    '[{"kind":"proc","title":"短标题","body":"这一步要什么/做什么/交出什么","impl":"命令/脚本/路径/字段","mods":["模块短词"]}]',
  ].filter(Boolean).join('\n');
}


// ---------- 流式：Hermes 的对话效果（边跑边出） ----------
const STEP_ICON = {
  terminal: '▮', read_file: '📄', write_file: '✎', patch: '✎', search_files: '🔎',
  web_search: '🌐', web_extract: '🌐', skill_view: '📚', memory: '🧠', todo_list: '☑',
  delegate_task: '🤝', message_agent: '✉', process_manage: '⚙',
};
function stepLabel(name) { return (STEP_ICON[name] || '⚙') + ' ' + name; }

async function runStream({ msgs, rerender, profile, prompt, toolsets, cards = true, runId, timeoutMs, preview = false }) {
  runId = runId || ('r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  const flowId = (flow() || {}).id || '';
  const me = { flowId, cancelled: false };
  RUNS.set(runId, me);                                  // 回滚时按链路把正在跑的这次停掉
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
    try { r = await window.tcflow.askAgentStream({ profile, prompt, runId, toolsets, timeoutMs, preview }); }
    catch (e) { r = { ok: false, error: String(e) }; }
  } else {
    const t0 = Date.now();
    r = await window.tcflow.askAgent({ profile, prompt, toolsets, timeoutMs });
    const p = r.ok ? parseAgentOutput(r.text) : { answer: '失败：' + agentAnswer(r.error || r.text || r.code), think: '', steps: [], secs: '' };
    live.text = p.answer || ''; live.think = p.think || ''; live.steps = p.steps || []; live.secs = p.secs || String(Math.round((Date.now() - t0) / 1000));
  }
  off();
  RUNS.delete(runId);
  live.live = false;
  live.cancelled = !!me.cancelled;
  live.secs = String(Math.max(1, Math.round((Date.now() - live.startedAt) / 1000)));
  live.ok = !!(r && r.ok);
  live.error = (r && r.error) || '';
  live.timedOut = !!(r && r.timedOut);          // 主进程到点杀的：界面按「到点了」收场，不说成「中途断了」
  live.steps.forEach(st => { if (st.state === 'running') { st.state = 'error'; st.time = ''; } });
  if (!live.text && r && r.text) live.text = r.text;
  // 这次运行跑到一半链路被回滚了：停掉的运行不能在作废的链路上继续产出（候选卡一张都不收）
  if (live.cancelled) {
    live.steps.forEach(st => { if (st.state !== 'error') { st.state = 'error'; } });
    live.human = '这条链路被回滚了，这次运行已经停掉；下次带新版本重开。';
    live.error = live.error || 'cancelled';
    rerender();
    return live;
  }
  if (!live.ok && !live.timedOut && !live.text) live.text = '失败：' + ((r && (r.error || r.code)) || '未知错误');
  const opts = cards ? parseCardArray((r && r.text) || live.text || '') : [];
  // 候选卡只加一句提示，**不覆盖原回答**：原回答留在 live.text（气泡里「看原话」能看到），
  // 否则「问它这条链路第几版、几张卡」这种纯事实问答会被换掉，人看不到它答了什么。
  if (opts.length) live.human = `给你 ${opts.length} 个候选卡：点一下看细节，按「确认添加」才会进流程。`;
  rerender();
  return live;
}

async function chatSend(text) {
  const w = flow(), n = find(panelCardId);
  const msg = String(text == null ? '' : text).trim();
  if (!n || !msg) return;
  if (!w.agent) { alert('先给整条工作流指派一个 agent（顶栏或「概览」）'); return; }
  n.chat = (n.chat || []).concat([{ role: 'me', text: msg, at: Date.now() }]).slice(-30);
  saveStore(false); renderChat(n);
  const inEl = $('#chatIn'); if (inEl) inEl.value = '';
  const live = await runStream({ msgs: n.chat, rerender: () => renderChat(n), profile: w.agent, prompt: buildChatPrompt(n, msg) });
  n.chat = n.chat.slice(-30);
  saveStore(false); renderChat(n);
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
    ...verHead(w),
    '你是平台主管（阶段B的那个主管）：负责规划与派工、跨部门一次复核，不代做部门专业交付。',
    '这里只做建议：不执行、不发请求、不改文件、不付费。',
    PLAIN_RULE,
    `平台里的这条工作流：${w.name}`,
    `它的执行 agent：${w.agent ? agentName(w.agent) : '（还没指派）'}`,
    `整条流程：\n${chainOrder(w).map(cardLine).join('\n')}`,
    hist ? `上文对话：\n${hist}` : '',
    `我说：${text}`,
    '从平台主管的角度回答：这条链路该谁干、缺哪一步、要不要加人/换人；说人话、短一点。',
    '我问的是事实（第几版、几张卡、哪张是什么）就直接照状态文件回答，不要给候选卡。',
    linkBrief(w),
    '如果我要的是「下一步」候选卡，只输出 JSON 数组，不要解释：',
    MODS_RULE,
    '[{"kind":"proc","title":"短标题","body":"这一步要什么/做什么/交出什么","impl":"命令/脚本/路径/字段","mods":["模块短词"]}]',
  ].filter(Boolean).join('\n');
}
async function dockSend(text) {
  const w = flow(), msg = String(text == null ? '' : text).trim();
  if (!msg) return;
  const temp = !!w.temp;
  w.chat = (w.chat || []).concat([{ role: 'me', text: msg, at: Date.now() }]).slice(-30);
  if (temp) seedDraft(msg);                       // 第一张卡 0 秒上屏：你这句话就是这条链路的输入，模型的第一张真卡回来再接管它
  saveStore(false); renderDock();
  const inEl = $('#dockIn'); if (inEl) inEl.value = '';
  const live = await runStream({
    msgs: w.chat,
    // 临时画布：agent 每吐出一张完整的卡，画布就跟着长一张（只补新的，不整张重画）
    rerender: () => {
      renderDock();
      if (!temp) return;
      const last = w.chat[w.chat.length - 1];
      if (last && last.live) { last.human = tempHuman(last.text, true); growTempFrom(last.text); }
      else growTempFrom('');
    },
    profile: temp ? (w.agent || DOCK_AGENT) : DOCK_AGENT,
    prompt: temp ? tempPrompt(msg) : dockPrompt(msg),
    cards: !temp,                                   // 临时画布：留着原话对齐卡片，不走「候选卡」确认层
    timeoutMs: temp ? 240000 : 180000,
  });
  w.chat = w.chat.slice(-30);
  if (temp) {
    const last = w.chat[w.chat.length - 1];
    if (last && last.role === 'agent') last.human = tempHuman(last.text, false);
  }
  saveStore(false); renderDock();
  if (temp) finishTemp(live.text || '');
  return live;
}
// 临时画布的口径：边写边出，卡片跟着长；不落地，人点「存成正式」才进列表
function tempPrompt(text) {
  const w = flow();
  const drawn = w.nodes.length ? chainOrder(w).map(cardLine).join('\n') : '（画布还空着）';
  return [
    '只输出一个 JSON 对象，边写边出：先写 name/summary 和第一张卡，写完一张立刻接着写下一条，不要等全部想好；不要解释、不要代码块标记，不要先调用工具。',
    '{"name":"工作流名（12 字内）","summary":"一句话说清这条链路","cards":[{"key":"c1","kind":"in","title":"短标题","body":"这一步要什么/做什么/交出什么","impl":"技能/目录/工具/字段","mods":["模块短词"]}],"edges":[["c1","c2"]]}',
    '你在工作流开发平台里，和用户一起现搭一条工作流。你负责拆卡，人负责定。',
    '只做建议：不执行、不发请求、不改文件、不付费。',
    PLAIN_RULE,
    MODS_RULE,
    `画布上现在有：\n${drawn}`,
    linkBrief(w),
    `我说：${text}`,
    '第一张卡尽量短：标题 6 个字以内、正文一句话，把整条链路的最前面先立起来。',
    '临时画布上的卡是提议：人点了「存成正式工作流」才进列表。已经在用的正式链路你只能读、不能改，要改就给一条提议。',
  ].filter(Boolean).join('\n');
}
// 右下角对话框里确认加入：没有"上一张卡"，放在流程右下方、不自动连线
function addFromDock(mi, oi) {
  dockConfirm = null;
  const w = flow();
  const opt = ((w.chat || [])[mi] || {}).opts || [];
  const o = opt[oi]; if (!o) return;
  if (w.nodes.some(x => (x.title || '').trim() === o.title.trim())) { alert('已经有一张同名卡片了'); return; }
  const ref = chainOrder(w).slice(-1)[0];
  const spot = ref ? dockSpot({ id: '' }, ref, 'out') : { x: 300, y: 340 };   // 放在流程最后一张卡右边，避开别的卡
  const n = addNode(o.kind, {
    title: o.title, body: o.body, impl: o.impl || '', mods: normMods(o.mods, o.kind),
    x: spot.x, y: spot.y,
  }, false);
  selId = n.id; panelCardId = n.id; panelOpen = false; saveAs('agent'); render();   // agent 给的候选卡，人按了「确认添加」
}

// 把聊天里的候选卡点进流程
function addFromOption(fromNode, mi, oi) {
  confirmAdd = null;
  if (!fromNode) return;
  const opt = ((fromNode.chat || [])[mi] || {}).opts || [];
  const o = opt[oi]; if (!o) return;
  if (flow().nodes.some(x => (x.title || '').trim() === o.title.trim())) { alert('已经有一张同名卡片了'); return; }
  const spot = dockSpot({ id: '' }, fromNode, 'out');   // 放在它右边，避开别的卡
  const n = addNode(o.kind, { title: o.title, body: o.body, impl: o.impl || '', mods: normMods(o.mods, o.kind), x: spot.x, y: spot.y }, false);
  connect(fromNode.id, n.id, false);
  selId = n.id; panelCardId = n.id; panelOpen = false; saveAs('agent'); render();   // agent 候选卡 + 人确认
  drawIn(`${fromNode.id}>${n.id}`);
  const inEl = $('#chatIn'); if (inEl) inEl.focus();
}
function parseCardArray(text) {
  for (const arr of jsonArrays(text)) {
    const ok = arr.filter(validOpt)
      .map(x => cleanCard({ kind: x.kind, title: String(x.title).slice(0, 24), body: String(x.body || ''), impl: String(x.impl || x.internal || ''), mods: x.mods }));
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
function cleanCard(o, max = 160) {
  const cut = splitTech(o.body);
  return {
    kind: o.kind,
    title: o.title,
    body: cut.body.slice(0, max),
    impl: [String(o.impl || '').trim(), cut.impl].filter(Boolean).join(' ').slice(0, max + 100),
    mods: normMods(o.mods, o.kind),
  };
}
// 候选卡带来的模块：字符串或 {name} 都收；滤掉提示词里的占位
function normMods(list, kind) {
  if (!Array.isArray(list)) return [];
  return list.map(m => (typeof m === 'string' ? m : (m && (m.name || m.title)) || ''))
    .map(x => String(x).replace(/\s+/g, ' ').trim()).filter(x => x && !/^(模块短词|短词)$/.test(x))
    .slice(0, 6).map(x => ({ id: uid(), type: KIND_MOD[kind] || 'tool', name: x.slice(0, 16) }));
}
async function validateAll() {
  const w = flow();
  if (!w.agent) return alert('先给整条工作流指派一个 agent');
  let firstFail = null;
  for (const n of chainOrder(w)) {
    selId = n.id; panelCardId = n.id; panelOpen = false; n.status = 'running'; render();
    const prompt = [...verHead(w),
      '只做评审，不执行、不发请求、不改文件。',
      linkBrief(w),
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
    saveStore(false); render();
  }
  openCard(firstFail || w.nodes[0]);
}

// ---------- 测试这条链路：静态体检 + 只读预演 ----------
// 一次只测画布上选中的那条（flow()）。体检是纯本机计算，不调模型；预演只出结论、不写画布、不落文件。
const CHECK_WORD = { link: '接不上', empty: '空卡', split: '断开', cycle: '成圈', agent: '执行方' };
// 静态体检：断链 / 加工卡缺输入缺产出 / 空卡 / 连成两截 / 成圈 / 没执行方
function checkFlow(w) {
  const issues = [];
  if (!w) return issues;
  const nodes = w.nodes || [], edges = w.edges || [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const add = (n, what, fix, kind) => issues.push({ id: n ? n.id : '', title: n ? n.title : '', what, fix, kind: kind || 'link' });
  if (!w.agent) add(null, '这条链路还没指派执行方', '在顶栏最上面的执行方里挑一个', 'agent');
  if (!nodes.length) add(null, '这条链路还没有卡片', '从顶栏「+ 加卡片」开始，输入 → 加工 → 输出各来一张', 'empty');
  // 连线指向不存在的卡（删卡后残留的线）
  for (const e of edges) {
    const a = Array.isArray(e) ? e[0] : '', b = Array.isArray(e) ? e[1] : '';
    if (!byId.has(a) || !byId.has(b)) add(null, `有一条连线指向不存在的卡（${a || '?'} → ${b || '?'}）`, '删掉这条线，或者把两端的卡补回来');
  }
  const ok = edges.filter(e => Array.isArray(e) && byId.has(e[0]) && byId.has(e[1]) && e[0] !== e[1]);
  const inn = id => ok.filter(([, b]) => b === id).length;
  const out = id => ok.filter(([a]) => a === id).length;
  for (const n of nodes) {
    if (!String(n.body || '').trim()) add(n, '只有标题，没有正文（不知道这一步要什么、做什么、交出什么）', `在左栏把「${(KINDS[n.kind] || KINDS.proc).label}内容」补上一句具体的话`, 'empty');
    const i = inn(n.id), o = out(n.id);
    if (n.kind === 'in') {
      if (!o) add(n, '输入卡没人接（没有卡用到它）', '把它拖进后面那张加工卡的素材槽');
      if (i) add(n, '有东西连进输入卡（输入卡应该是源头）', '把连进来的那条线撤掉，改接到后面的加工卡上');
    } else if (n.kind === 'proc') {
      if (!i) add(n, '加工卡缺输入（没有东西喂给它）', '把前面的输入卡或上一步的成果拖进它的素材槽');
      if (!o) add(n, '加工卡缺产出（做完没人接）', '接一张输出卡，或者把它拖进下一步的素材槽');
    } else if (!i) {
      add(n, '输出卡没人做（没有卡交给它）', '把它拖进前面那张加工卡的成果槽');
    }
  }
  // 绕成圈：顺着线走回自己（自连的线单独点名）
  for (const e of edges) {
    const a = Array.isArray(e) ? e[0] : null;
    if (a && a === e[1] && byId.has(a)) add(byId.get(a), '这张卡连到了自己（绕成圈）', '删掉这条自连的线', 'cycle');
  }
  const color = new Map(nodes.map(n => [n.id, 0])), stack = [], seenCycle = new Set();
  const visit = id => {
    if (color.get(id) === 1) {
      const ring = stack.slice(stack.indexOf(id));
      const key = ring.slice().sort().join('>');
      if (seenCycle.has(key)) return;
      seenCycle.add(key);
      const list = ring.map(x => byId.get(x)).filter(Boolean);
      if (list.length > 1) add(null, `链路绕成了圈：${list.map(x => '「' + x.title + '」').join(' → ')} → 回到「${list[0].title}」`, '断掉圈里任意一条线', 'cycle');
      return;
    }
    if (color.get(id) === 2) return;
    color.set(id, 1); stack.push(id);
    ok.filter(([a]) => a === id).forEach(([, b]) => visit(b));
    stack.pop(); color.set(id, 2);
  };
  nodes.forEach(n => { if (color.get(n.id) === 0) visit(n.id); });
  // 断成几截：不分方向把卡连成一片，不止一片就是断了
  if (nodes.length > 1) {
    const adj = new Map(nodes.map(n => [n.id, []]));
    ok.forEach(([a, b]) => { adj.get(a).push(b); adj.get(b).push(a); });
    const comps = [], seen = new Set();
    for (const n of nodes) {
      if (seen.has(n.id)) continue;
      const group = [], q = [n.id]; seen.add(n.id);
      while (q.length) { const id = q.pop(); group.push(byId.get(id)); for (const nb of adj.get(id) || []) if (!seen.has(nb)) { seen.add(nb); q.push(nb); } }
      comps.push(group);
    }
    if (comps.length > 1) {
      const main = comps.reduce((a, b) => (b.length > a.length ? b : a));
      comps.filter(c => c !== main).forEach(c => add(null,
        `「${c.map(n => n.title).join('」「')}」这一截没接上主链路（整条被拆成 ${comps.length} 截）`,
        '把这一截接到主链路上（输入 → 加工 → 输出），多余的卡删掉', 'split'));
    }
  }
  return issues;
}
// 体检报告原文（一行一条：哪张卡、什么问题、怎么补）
function checkText(w) {
  const list = checkFlow(w);
  if (!list.length) return '没有发现问题';
  return list.map((x, i) => `${i + 1}. ${x.title ? '「' + x.title + '」' : '整条链路'}｜${x.what}｜怎么补：${x.fix}`).join('\n');
}
function openTest() { $('#testModal').classList.add('on'); paintTest(); }
function closeTest() { stopPreview(); $('#testModal').classList.remove('on'); }
// 预演只读提示词：只问「你会怎么做、缺什么材料」，不给任何工具
function previewPrompt(w, n) {
  return [
    ...verHead(w),
    '这是只读预演：你没有任何工具，不能跑命令、读写文件、发消息、发布、付费；只出结论，不许动手。',
    PLAIN_RULE,
    `工作流：${w.name}`,
    `整条流程：\n${chainOrder(w).map(cardLine).join('\n')}`,
    linkBrief(w),
    `现在只看这张卡：[${(KINDS[n.kind] || KINDS.proc).label}] ${n.title}｜内容：${n.body || '(空)'}｜内部实现：${implOf(n) || '(未填)'}`,
    '按现在的写法，这一步你会怎么做、缺什么材料？3 行以内、说人话：先写你会怎么干，再写缺什么（缺就写「缺：…」，不缺写「材料齐」）。',
  ].filter(Boolean).join('\n');
}
function stopPreview() {
  if (!PV.busy) return;
  PV.cancel = true;
  const id = PV.runId;
  PV.runId = null;
  if (id) { try { window.tcflow.cancelAgent(id); } catch (e) { } }
}
async function startPreview() {
  const w = flow();
  if (!w || PV.busy) return;
  const order = chainOrder(w);
  if (!order.length) { PV.error = '这条链路还没有卡片，先把卡片放上来'; paintTest(); return; }
  if (!w.agent) { PV.error = '先给这条链路指派执行方'; paintTest(); return; }
  Object.assign(PV, { busy: true, cancel: false, done: 0, total: order.length, cur: '', liveSteps: 0, error: '' });
  paintTest();
  for (const n of order) {
    if (PV.cancel) break;
    PV.cur = n.title; PV.liveSteps = 0; paintTestStat();
    const runId = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    PV.runId = runId;
    const msgs = [];
    const live = await runStream({
      msgs,
      rerender: () => { PV.liveSteps = ((msgs[msgs.length - 1] || {}).steps || []).length; paintTestStat(); },
      profile: w.agent, prompt: previewPrompt(w, n), toolsets: PREVIEW_TOOLSETS,
      cards: false, runId, timeoutMs: 120000, preview: true,
    });
    PV.runId = null;
    if (PV.cancel) break;
    const text = String((live && live.text) || '').trim();
    const steps = (live && live.steps) || [];
    n.preview = {
      at: Date.now(), ok: !!(live && live.ok && text), secs: (live && live.secs) || '',
      steps: steps.length,
      text: text || ((live && live.timedOut) ? '到点了，这一步没问出结论' : `这次没问出结论（${(live && live.error) || '中断'}）`),
    };
    PV.done++;
    saveStore(false);                                   // 预演结果是这台机器上的记录：不涨版本、不写状态文件
    paintOne(n);                                        // 卡片正面挂上「预演 ✓」（只重画这一张）
    paintTest();
    if (panelCardId === n.id) renderPanel();            // 左栏正开着这张卡：结论跟着回填
  }
  PV.busy = false; PV.runId = null;
  if (PV.cancel) PV.error = '停掉了，已经问完的结论留着';
  paintTest();
}
// 一键清空：卡片上的预演结论、卡片正面的「预演」标、左栏里的那段一起清掉
function clearPreviews() {
  const w = flow();
  if (!w) return;
  let n = 0;
  (w.nodes || []).forEach(x => { if (x.preview) { delete x.preview; n++; } });
  if (n) { saveStore(false); paintNodes(); if (panelCardId) renderPanel(); }
  PV.error = n ? '' : '还没有预演结果';
  paintTest();
}
function paintTest() {
  const box = $('#testModal');
  if (!box || !box.classList.contains('on')) return;
  const w = flow(); if (!w) return;
  $('#tTitle').textContent = `测试 · ${w.name}`;
  const issues = checkFlow(w);
  $('#tReport').innerHTML = `<div class="tsh">静态体检<span class="tcount">${issues.length ? issues.length + ' 处' : '没问题'}</span></div>` +
    (issues.length ? issues.map(x => `<div class="trow">
        <span class="tkw">${CHECK_WORD[x.kind] || '问题'}</span>
        <div class="tc"><b>${esc(x.title || '整条链路')}</b><div class="tw">${esc(x.what)}</div><div class="tfix">怎么补：${esc(x.fix)}</div></div>
      </div>`).join('') : '<div class="tnone">没有发现问题</div>');
  const order = chainOrder(w);
  const done = order.filter(n => n.preview).length;
  $('#tPrev').innerHTML = `<div class="tsh">只读预演<span class="tcount">${done} / ${order.length} 张卡</span></div>` +
    (order.length ? order.map((n, i) => `<div class="trow pv${n.preview ? (n.preview.ok ? ' ok' : ' bad') : ''}">
        <span class="tnum">${i + 1}</span>
        <div class="tc"><b>${esc(n.title)}</b><span class="tkind k-${n.kind}">${(KINDS[n.kind] || KINDS.proc).label}</span>
          <div class="tptext">${n.preview ? esc(n.preview.text) : '还没预演'}</div>
          ${n.preview ? `<div class="tpmeta">${hhmm(n.preview.at)} · ${n.preview.secs ? n.preview.secs + 's · ' : ''}工具调用 ${n.preview.steps || 0} 次</div>` : ''}
        </div></div>`).join('') : '<div class="tnone">这条链路还没有卡片</div>');
  paintTestStat();
}
function paintTestStat() {
  const el = $('#tStat'); if (!el) return;
  const w = flow(), order = w ? chainOrder(w) : [];
  const done = order.filter(n => n.preview).length;
  const tools = order.reduce((s, n) => s + ((n.preview && n.preview.steps) || 0), 0);
  let text;
  if (PV.busy) text = `正在预演 ${Math.min(PV.done + 1, PV.total)}/${PV.total}${PV.cur ? ' ·「' + PV.cur + '」' : ''} · 工具调用 ${PV.liveSteps} 次`;
  else if (PV.error) text = PV.error;
  else if (done && done === order.length) text = `预演完成：${done} 张卡都有结论 · 工具调用 ${tools} 次`;
  else if (done) text = `已经预演 ${done} / ${order.length} 张卡`;
  else text = w && w.agent ? `执行方：${execName(w.agent)}` : '先指派执行方';
  el.textContent = text;
  const run = $('#tRun'), clr = $('#tClear');
  if (run) run.disabled = PV.busy || !order.length;
  if (clr) clr.disabled = PV.busy || !done;
}
// 切链路 / 关窗口 / 回滚时，把正在跑的预演停掉（已经问完的结论留着）
addEventListener('beforeunload', () => stopPreview());

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

// ---------- 读取 agent 的工作链路 → 分析成卡片 → 放进画布 ----------
// 读：主进程只读它的配置、技能和干活记录（chain.js，state.db 只读打开）。
// 分析：交给平台主管，只给 todo 工具组、并关掉它挂的 MCP 连接（-t todo,no_mcp）——
//       跑不了命令、读写不了文件、发不了消息，也碰不到店铺后台的数据接口。
// 落盘：先在窗里预览，按「放进画布」才建卡（agent 不能自己往画布上加东西）。
const READ_TOOLSETS = 'todo,no_mcp';
// 一次分析的总预算（含自动重来一次）：默认 150 秒。三条真实链路（最长那次还自动重来了一次）都在这个上限里拆完；
// 给到 2 分半是留一档慢模型的余量，又不至于让人对着「正在拆卡」干等 4 分钟。WF_READ_TIMEOUT_MS 只给验收调小。
const READ_BUDGET_MS = Math.max(5000, Number((window.tcflow && window.tcflow.readTimeoutMs) || 0) || 150000);
const READ_STALL_MS = 20000;          // 20 秒没有新内容：界面明说「它在等，不是我卡了」
const SRC_LABEL = { kanban: '看板派单', oneshot: '单次指令', subagent: '别的 agent 调用', local: '直接对话', cron: '定时任务', cli: '命令行', desktop: '桌面对话' };
const KIND_ALIAS = { in: 'in', input: 'in', '输入': 'in', proc: 'proc', process: 'proc', '加工': 'proc', out: 'out', output: 'out', '输出': 'out' };
const rd = { pick: null, chain: null, msgs: [], plan: null, busy: false, runId: null, token: 0, error: '', startedAt: 0, lastProgress: 0 };

function openRead() { $('#readModal').classList.add('on'); paintRead(); }
function closeRead() { cancelRead(); $('#readModal').classList.remove('on'); }
// 杀掉正在跑的分析进程（重来/换人/关窗都要走这里：一次只留一个进程往预览里写）
function killReadRun() {
  const id = rd.runId;
  rd.runId = null;
  if (id) { try { window.tcflow.cancelAgent(id); } catch (e) { } }
}
function clearReadPreview() {
  const b = $('#rPrev'); if (b) { b.innerHTML = ''; b.classList.remove('done'); }
}
function cancelRead() {
  const busy = rd.busy;
  rd.token++;
  killReadRun();
  rd.busy = false;
  if (!busy) return;
  // 只收正在跑的那次：半截的卡、半截的话都不留在预览里（已经拆好、人看过的那份不动）
  rd.msgs = [];
  rd.plan = null;
  rd.error = '上次分析已取消，没留半成品。点「重来」重新分析';
  clearReadPreview();
  if ($('#readModal').classList.contains('on')) { paintReadLog(); paintReadFoot(); }
}
// 平台主管不在 profiles 目录里，单独放进来；它的分组名只在 agent 列表里真有这条时才用，取不到就不分组
function readAgents() {
  const sup = agents.find(a => a.id === DOCK_AGENT) || {};
  return [Object.assign({ id: DOCK_AGENT, name: '平台主管', section: sup.section || '', desc: sup.desc || '' }, { stopped: false })]
    .concat(agents.map(a => Object.assign({}, a, { name: a.name === '主管' && a.section ? a.section + '主管' : a.name })));
}
function readPickHTML() {
  const groups = new Map(), old = [];
  for (const a of readAgents()) {
    if (a.stopped) { old.push(a); continue; }
    const k = a.section || '';                                        // 取不到分组名就放在最上面，不硬编一个
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const item = a => `<div class="ritem${rd.pick === a.id ? ' on' : ''}" data-id="${esc(a.id)}" title="${esc(a.desc || '')}">${esc(a.name)}</div>`;
  let h = [...groups].map(([k, list]) => `<div class="rgroup">${k ? `<div class="rgl">${esc(k)}</div>` : ''}${list.map(item).join('')}</div>`).join('');
  if (old.length) h += `<details class="rgroup old"${old.some(a => a.id === rd.pick) ? ' open' : ''}><summary class="rgl">已停用 · ${old.length}</summary>${old.map(item).join('')}</details>`;
  return h;
}
function readSummaryHTML(c) {
  const d = t => t ? new Date(t * 1000).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '—';
  const pill = (name, n, old) => `<span class="rp${old ? ' old' : ''}">${esc(name)}<i>${n}</i></span>`;
  const people = list => list.length ? list.map(x => pill(x.name, x.count, x.old)).join('') : '<span class="rnone">—</span>';
  const skills = c.skills.filter(s => s.used).slice(0, 8);
  const row = (k, v) => `<div class="rrow"><span class="rk">${k}</span><div class="rv">${v}</div></div>`;
  const src = Object.entries(c.stats.bySource || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${SRC_LABEL[k] || k} ${v}`).join('、');
  const dirs = list => list.map(([p, n]) => `${esc(p)}（${n}）`).join('<br>') || '—';
  return `<div class="rhead"><b>${esc(c.name)}</b><span>${esc(c.section || '')}</span><span class="rstat">${c.stats.sessions} 次活 · ${d(c.stats.first)} → ${d(c.stats.last)}</span></div>` +
    row('干的活', c.tasks.slice(0, 5).map(t => `<div class="rtask">${esc(t.title)}</div>`).join('') || '<span class="rnone">还没有干活记录</span>') +
    row('用的技能', skills.map(s => pill(s.title || s.name, s.used)).join('') || '<span class="rnone">—</span>') +
    row('谁派活', people(c.upstream)) +
    row('交给谁', people(c.downstream)) +
    `<details class="internal rraw"><summary>⚙ 读到的线索</summary>
      <div class="rraw-g"><b>读了多少</b>这次读了 ${c.stats.readSessions || 0} 条会话 / 上限 ${c.stats.readLimit || 80}${c.stats.readLimit > 80 ? '（它干活记录少，往前多读一些）' : ''}</div>
      <div class="rraw-g"><b>活从哪来</b>${esc(src || '—')}</div>
      <div class="rraw-g"><b>常读</b>${dirs(c.reads)}</div>
      <div class="rraw-g"><b>常写</b>${dirs(c.writes)}</div>
      <div class="rraw-g"><b>常用工具</b>${c.tools.slice(0, 10).map(([n, k]) => `${esc(n)} ${k}`).join('、') || '—'}</div>
      <div class="rraw-g"><b>技能</b>${c.skills.map(s => esc(s.name) + (s.used ? ' ' + s.used : '')).join('、') || '—'}</div>
    </details>`;
}
function paintRead() {
  const pk = $('#rPick');
  pk.innerHTML = readPickHTML();
  pk.querySelectorAll('.ritem').forEach(el => el.onclick = () => pickRead(el.dataset.id));
  const m = $('#rMain');
  if (!rd.pick) m.innerHTML = '<div class="rempty">选一个 agent</div>';
  else if (!rd.chain) m.innerHTML = `<div class="rempty${rd.error ? ' bad' : ''}">${esc(rd.error || '正在读…')}</div>`;
  else {
    m.innerHTML = readSummaryHTML(rd.chain) + '<div class="rlog" id="rLog"></div><div class="rprev" id="rPrev"></div>';
    paintReadLog();
    if (rd.plan) paintPlan(rd.plan);
  }
  paintReadFoot();
}
function paintReadFoot() {
  $('#rAgain').disabled = !rd.chain || rd.busy;
  $('#rPlace').disabled = !rd.plan || rd.busy;
  $('#rHint').textContent = rd.busy ? readProgress() : (rd.chain && !rd.plan && rd.error ? rd.error : '');
}
// 说人话的进度：拆到第几张、等了多久；20 秒没新内容就明说「它在等，不是我卡了」
function readProgress() {
  const last = rd.msgs[rd.msgs.length - 1];
  const n = partialCards(last && last.text).length;
  const now = Date.now();
  const waited = Math.max(0, Math.round((now - (rd.startedAt || now)) / 1000));
  const idle = Math.max(0, Math.round((now - (rd.lastProgress || now)) / 1000));
  if (idle * 1000 >= READ_STALL_MS) return `这一步有点慢：${idle} 秒没有新内容，它还在想，不是卡住了（已等 ${waited} 秒）`;
  return (n ? `还在拆，已经理出 ${n} 张` : '还在拆，先等等') + `（已等 ${waited} 秒）`;
}
// 流式时不把一串 JSON 打在气泡里：换成「还在拆，已经理出 N 张」
function liveView(m) {
  if (!m.live) return m;
  return Object.assign({}, m, { text: readProgress() });
}
function paintReadLog() {
  const log = $('#rLog'); if (!log) return;
  const view = rd.msgs.map(liveView);
  const last = view[view.length - 1];
  const liveEl = log.querySelector('[data-live="1"]');
  if (last && last.live && liveEl) { patchLive(liveEl, last, '平台主管'); }
  else keepDetails(log, () => { log.innerHTML = view.length ? bubblesHTML(view, null, '', false, '平台主管') : ''; });
  // 进度由 tickRead 每秒刷新（正在拆几张 / 等了多久 / 是不是在等），不用「正在想… Ns」那套
  const el = log.querySelector('[data-live="1"]');
  if (el) delete el.dataset.since;
  log.scrollTop = log.scrollHeight;
}
function paintReadLive() {
  paintReadLog();
  const last = rd.msgs[rd.msgs.length - 1];
  paintPartial(partialCards(last && last.text));
}
// 还没写完的 JSON 里，已经写完整的卡（kind + title 都有了）
function partialCards(text) {
  const t = String(text || ''), i = t.indexOf('"cards"');
  if (i < 0) return [];
  const out = [];
  for (const chunk of t.slice(i).split('{').slice(1)) {
    const k = (chunk.match(/"kind"\s*:\s*"([^"]+)"/) || [])[1] || '';
    const title = (chunk.match(/"title"\s*:\s*"([^"]+)"/) || [])[1];
    const kind = KIND_ALIAS[k.trim().toLowerCase()] || KIND_ALIAS[k.trim()];
    if (!kind || !title) continue;
    const mm = chunk.match(/"mods"\s*:\s*\[([^\]]*)\]/);
    const mods = mm ? (mm[1].match(/"([^"]+)"/g) || []).map(s => s.slice(1, -1)) : null;
    out.push({ kind, title: title.slice(0, 24), mods });
  }
  return out;
}
function prevSkeleton(box) {
  box.innerHTML = ['in', 'proc', 'out'].map(k => `<div class="rcol k-${k}"><div class="rch">${KINDS[k].label}</div><div class="rtiles" data-k="${k}"></div></div>`).join('');
}
function tileHTML(c, i, key) {
  const mods = (c.mods || []).map(m => typeof m === 'string' ? { type: KIND_MOD[c.kind], name: m } : m);
  return `<div class="rtile k-${c.kind}" data-i="${i}"${key ? ` data-key="${esc(key)}"` : ''}><b>${esc(c.title)}</b>` +
    `<div class="rmods">${mods.map(m => `<span class="mod t-${m.type}">${esc(m.name)}</span>`).join('')}</div></div>`;
}
// 流式中：只追加新冒出来的卡，已有的不重建（不然动画每帧重放）
function paintPartial(cards) {
  const box = $('#rPrev'); if (!box) return;
  if (!box.querySelector('.rcol')) prevSkeleton(box);
  box.classList.remove('done');
  const have = box.querySelectorAll('.rtile').length;
  cards.forEach((c, i) => {
    if (i < have) {
      const t = box.querySelector(`.rtile[data-i="${i}"]`);
      if (t && c.mods && !t.dataset.m) { t.dataset.m = '1'; t.querySelector('.rmods').innerHTML = c.mods.map(n => `<span class="mod t-${KIND_MOD[c.kind]}">${esc(n)}</span>`).join(''); }
      return;
    }
    box.querySelector(`.rtiles[data-k="${c.kind}"]`).insertAdjacentHTML('beforeend', tileHTML(c, i));
    if (c.mods) box.querySelector(`.rtile[data-i="${i}"]`).dataset.m = '1';
  });
}
function paintPlan(plan) {
  const box = $('#rPrev'); if (!box) return;
  prevSkeleton(box);
  box.classList.add('done');
  plan.cards.forEach((c, i) => box.querySelector(`.rtiles[data-k="${c.kind}"]`).insertAdjacentHTML('beforeend', tileHTML(c, i, c.key)));
}
async function pickRead(id) {
  cancelRead();
  const token = rd.token;
  Object.assign(rd, { pick: id, chain: null, plan: null, msgs: [], error: '' });
  paintRead();
  let r;
  try { r = await window.tcflow.readAgentChain(id); } catch (e) { r = { ok: false, error: String(e) }; }
  if (token !== rd.token) return;                                 // 读的时候又换了一个
  if (!r || !r.ok) { rd.error = (r && r.error) || '读不到'; paintRead(); return; }
  rd.chain = r;
  paintRead();
  if (!r.stats.sessions && !r.skills.length && !r.soul) { rd.error = '它还没有能读的东西'; paintReadFoot(); return; }
  analyzeChain();
}
function chainPrompt(c) {
  const d = t => t ? new Date(t * 1000).toISOString().slice(0, 10) : '?';
  const ppl = list => list.map(x => `${x.name}${x.old ? '（已停用）' : ''} ${x.count} 次`).join('、') || '（没有记录）';
  const skills = c.skills.slice(0, 10).map(s => `- ${s.title || s.name}（${s.name}）${s.used ? `用了 ${s.used} 次` : '装着、最近没用'}：${String(s.desc || '').slice(0, 110)}` +
    (s.heads.length ? '；要点：' + s.heads.slice(0, 4).join(' / ') : '')).join('\n') || '（没有自己的技能）';
  const tasks = c.tasks.slice(0, 14).map(t => `- ${t.title}（${SRC_LABEL[t.src] || t.src}，${t.calls} 次工具调用）`).join('\n') || '（没有记录）';
  const samples = c.samples.slice(0, 5).map((s, i) => `${i + 1}. 派活：${s.ask.slice(0, 260)}\n   它的交付：${s.done.slice(0, 200) || '（没写）'}`).join('\n') || '（没有）';
  const dirs = list => list.slice(0, 6).map(([p, n]) => `${p}（${n} 次）`).join('、') || '（没有）';
  return [
    '【读取链路】你是平台主管，在帮用户把一个 agent 平时真正在干的活，画成工作流开发平台里的卡片。',
    '只做分析：不执行、不跑命令、不读写文件、不发消息、不付费。下面的材料是从它的配置和干活记录里只读出来的。',
    '',
    `agent：${c.name}（${c.id}）｜部门：${c.section || '—'}`,
    `职责：${c.desc || '—'}`,
    `干活记录：${c.stats.sessions} 次（${d(c.stats.first)} → ${d(c.stats.last)}），工具调用 ${c.stats.toolCalls} 次`,
    '',
    '岗位说明（节选）：', String(c.soul || '（没有）').slice(0, 2400),
    '',
    '技能（按实际用的次数）：', skills,
    '',
    '最近干的活（新→旧）：', tasks,
    '',
    '典型的派活原文和它的交付（节选）：', samples,
    '',
    `谁派活给它：${ppl(c.upstream)}`,
    `它交给谁：${ppl(c.downstream)}`,
    `常读的地方：${dirs(c.reads)}`,
    `常写的地方：${dirs(c.writes)}`,
    `常用工具：${c.tools.slice(0, 10).map(([n, k]) => `${n} ${k}`).join('、') || '（没有）'}`,
    '',
    '请这样画：',
    '1. 只画它反复在做的主线，4–9 张卡；一次性的杂活、测试、自我介绍类对话不画。',
    '2. 输入卡：它从谁那里拿到什么（派活的人、上游交来的资料）；加工卡：它具体怎么干；输出卡：它交出什么、交给谁。',
    '3. 连线只按这条路走：输入 → 加工 → 输出（输出也可以再喂给下一张加工）。输入卡只往外连，什么都不连进输入卡；',
    '   每张加工卡至少有一个来源（输入卡、上一张加工或输出卡），至少交出一张输出卡；整条连成一片，不能断成几截。',
    PLAIN_RULE,
    MODS_RULE,
    '4. impl 写执行时真正用到的：技能名、目录、工具、字段名（这些不进卡片正文）。',
    '5. 只输出一个 JSON 对象，不要解释，不要代码块标记。格式：',
    '{"name":"工作流名（12 字内）","summary":"一句话说清这条链路","cards":[{"key":"c1","kind":"in","title":"短标题","body":"这一步要什么/做什么/交出什么","impl":"技能/目录/工具/字段","mods":["模块短词"]}],"edges":[["c1","c2"]]}',
  ].join('\n');
}
async function analyzeChain() {
  const c = rd.chain;
  if (!c || rd.busy) return;
  const token = ++rd.token;
  const budget = READ_BUDGET_MS;
  const deadline = Date.now() + budget;
  killReadRun();                                       // 重来之前先把上一个进程杀掉：不许两个进程往同一份预览里写
  Object.assign(rd, { busy: true, plan: null, msgs: [], error: '', startedAt: Date.now(), lastProgress: Date.now() });
  clearReadPreview();
  paintReadLog(); paintReadFoot();
  let plan = null, why = '', live = null, stopped = '';
  for (let attempt = 0; attempt < 2 && !plan; attempt++) {         // 拆坏了自动重来一次，不用人去点
    const left = deadline - Date.now();
    if (left < 8000) { stopped = 'timeout'; break; }               // 剩下的时间不够再拆一次，别再开进程
    const runId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    rd.runId = runId;
    rd.startedAt = rd.lastProgress = Date.now();
    let active = true, lastSig = '', timer = 0, timedOut = false;
    const msgs = rd.msgs;
    const rerender = () => {
      if (!active || token !== rd.token) return;                   // 这一轮已结束/已被换人：晚到的事件不往预览里写
      const m = msgs[msgs.length - 1] || {};
      const sig = String(m.text || '').length + ':' + ((m.steps || []).length) + ':' + String(m.think || '').length;
      if (sig !== lastSig) { lastSig = sig; rd.lastProgress = Date.now(); }
      paintReadLive();
    };
    const stream = runStream({
      msgs, rerender, profile: DOCK_AGENT, prompt: chainPrompt(c), toolsets: READ_TOOLSETS, cards: false, runId, timeoutMs: left,
    });
    // 子进程到点由主进程 SIGTERM；这里再兜一层：万一 IPC 没回来，界面也不能一直转圈
    const guard = new Promise(res => { timer = setTimeout(() => { timedOut = true; res({ ok: false, error: 'timeout' }); }, left + 3000); });
    live = await Promise.race([stream, guard]);
    clearTimeout(timer);
    active = false;
    const msg = msgs[msgs.length - 1] || { role: 'agent', text: '' };
    msg.live = false;
    const hardTimeout = timedOut || !!(live && live.timedOut);      // 主进程到点杀的 / 这里兜底的，都算「到点」
    if (timedOut) {
      try { window.tcflow.cancelAgent(runId); } catch (e) { }        // 兜底触发：把还在跑的子进程杀掉
      msg.aborted = true;
    }
    if (rd.runId === runId) rd.runId = null;
    if (token !== rd.token) return;                                 // 中途换了 agent 或关了窗：这次的结果不要了
    const ok = !hardTimeout && !!(live && live.ok) && !msg.aborted;
    const p = ok ? parseChainPlan(msg.text) : null;
    why = hardTimeout ? `到点了，这次没拆完（最多等 ${Math.round(budget / 1000)} 秒）`
      : ok ? planProblem(p) : '这次没拆全（分析中途断了）';
    if (!why) { plan = p; break; }
    if (!ok) { stopped = hardTimeout ? 'timeout' : 'aborted'; break; }   // 断了/到点：别自动重来，免得又白等一轮
    if (deadline - Date.now() < 8000) { stopped = 'timeout'; break; }
    if (attempt === 0) msg.human = `第一次没拆好（${why}），重新分析一次。`;   // 第一次的原话留在「看原话」里
  }
  rd.busy = false; rd.runId = null;
  const last = rd.msgs[rd.msgs.length - 1];
  if (plan) {
    rd.plan = plan;
    const line = `${plan.summary ? plan.summary + '。' : ''}拆成 ${plan.cards.length} 张卡、${plan.edges.length} 条连线。`;
    if (last) last.human = line; else rd.msgs.push({ role: 'agent', text: line, at: Date.now() });
  } else {
    const head = stopped === 'timeout' ? `到点了，这次没拆完（最多等 ${Math.round(budget / 1000)} 秒），已经把它停下`
      : stopped === 'aborted' ? '这次没拆全（分析中途断了），已经停下'
      : `还是没拆好（${why || '没拆出卡片'}）`;
    rd.error = head + '。点「重来」再来一次';
    if (last) { last.human = rd.error; if (!String(last.text || '').trim()) last.text = '（这次它没写出内容）'; }
    else rd.msgs.push({ role: 'agent', text: rd.error, at: Date.now() });
  }
  paintReadLog();
  if (plan) paintPlan(plan); else clearReadPreview();               // 失败/超时/取消：预览里不留半张卡
  paintReadFoot();
}
// 文本里所有完整的 JSON 对象（跳过字符串里的花括号）
function jsonObjects(text) {
  const t = String(text || ''), out = [];
  let depth = 0, start = -1, inStr = false, bs = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (bs) bs = false; else if (ch === '\\') bs = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { if (depth > 0) inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}' && depth > 0 && --depth === 0) { try { out.push(JSON.parse(t.slice(start, i + 1))); } catch (e) { } start = -1; }
  }
  return out;
}
function reachIn(edges, from, to) {
  const seen = new Set([from]), todo = [from];
  while (todo.length) { const cur = todo.pop(); if (cur === to) return true; for (const [a, b] of edges) if (a === cur && !seen.has(b)) { seen.add(b); todo.push(b); } }
  return false;
}
// 没给连线时按顺序推：输入 → 后面最近的加工 → 加工后面的输出
function inferEdges(cards) {
  const edges = [];
  let ins = [], outs = [], proc = null;
  for (const c of cards) {
    if (c.kind === 'in') ins.push(c.key);
    else if (c.kind === 'proc') {
      const from = ins.length ? ins : (outs.length ? outs : (proc ? [proc] : []));
      from.forEach(k => edges.push([k, c.key]));
      proc = c.key; ins = []; outs = [];
    } else { if (proc) edges.push([proc, c.key]); else ins.forEach(k => edges.push([k, c.key])); outs.push(c.key); }
  }
  return edges;
}
function parseChainPlan(text) {
  const o = jsonObjects(text).filter(x => x && Array.isArray(x.cards)).pop();
  if (!o) return null;
  const cards = [], byKey = new Map(), byTitle = new Map();
  o.cards.forEach((x, i) => {
    if (!x || cards.length >= 12) return;
    const k = String(x.kind || '').trim();
    const kind = KIND_ALIAS[k.toLowerCase()] || KIND_ALIAS[k];
    const title = String(x.title || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!kind || !title || /^(短标题|标题|卡名|示例)$/.test(title)) return;
    if (!String(x.body || '').trim()) return;                        // 写了一半的空卡不要
    const c = cleanCard({ kind, title, body: String(x.body || ''), impl: String(x.impl || ''), mods: x.mods }, 260);
    let key = String(x.key || 'c' + (i + 1));
    if (byKey.has(key)) key += '_' + i;
    c.key = key;
    cards.push(c); byKey.set(key, c); if (!byTitle.has(title)) byTitle.set(title, c);
  });
  if (!cards.length) return null;
  const ref = v => byKey.get(String(v)) || byTitle.get(String(v == null ? '' : v).trim());
  const edges = [];
  const add = (a, b) => {
    if (!a || !b || a === b || b.kind === 'in') return;                // 什么都不能连进输入卡：它是源头
    if (a.kind === 'in' && b.kind === 'in') return;
    if (edges.some(([x, y]) => x === a.key && y === b.key) || reachIn(edges, b.key, a.key)) return;
    edges.push([a.key, b.key]);
  };
  for (const e of (Array.isArray(o.edges) ? o.edges : [])) {
    add(ref(Array.isArray(e) ? e[0] : e && (e.from || e.source)), ref(Array.isArray(e) ? e[1] : e && (e.to || e.target)));
  }
  if (!edges.length) inferEdges(cards).forEach(([a, b]) => add(byKey.get(a), byKey.get(b)));
  // 加工卡没人喂：接上前面最近的输入卡（或上一张加工卡）；没人接手：交给后面最近的输出卡（或下一张加工卡）
  cards.forEach((c, i) => {
    if (c.kind !== 'proc') return;
    if (!edges.some(([, b]) => b === c.key)) {
      const prev = cards.slice(0, i).reverse();
      add(prev.find(x => x.kind === 'in') || prev.find(x => x.kind === 'proc') || cards.find(x => x.kind === 'in'), c);
    }
    if (!edges.some(([a]) => a === c.key)) {
      const next = cards.slice(i + 1);
      add(c, next.find(x => x.kind === 'out') || next.find(x => x.kind === 'proc') || cards.filter(x => x.kind === 'out').pop());
    }
  });
  // 落单的卡：输入挂到后面最近的加工卡，输出挂到前面最近的加工卡
  cards.forEach((c, i) => {
    if (edges.some(([a, b]) => a === c.key || b === c.key)) return;
    const procs = cards.filter(x => x.kind === 'proc' && x !== c);
    if (!procs.length) return;
    if (c.kind === 'in') { const p = cards.slice(i + 1).find(x => x.kind === 'proc') || procs[0]; if (!reachIn(edges, p.key, c.key)) edges.push([c.key, p.key]); }
    else if (c.kind === 'out') { const p = cards.slice(0, i).reverse().find(x => x.kind === 'proc') || procs[procs.length - 1]; if (!reachIn(edges, c.key, p.key)) edges.push([p.key, c.key]); }
  });
  return { name: String(o.name || '').trim().slice(0, 20), summary: String(o.summary || '').trim().slice(0, 160), cards, edges };
}
// 拆得像样才算数：输入、加工、输出都有，至少 3 张，每张加工卡都接上了
function planProblem(p) {
  if (!p) return '没拆出卡片';
  const has = k => p.cards.some(c => c.kind === k);
  if (p.cards.length < 3 || !has('in') || !has('proc') || !has('out')) return '拆出来的卡不全（输入、加工、输出得都有）';
  const inn = k => p.edges.some(([, b]) => b === k), outt = k => p.edges.some(([a]) => a === k);
  const bad = p.cards.filter(c => (c.kind === 'proc' && (!inn(c.key) || !outt(c.key))) || (c.kind === 'in' && !outt(c.key)) || (c.kind === 'out' && !inn(c.key)));
  if (bad.length) return '有卡没接上：' + bad.map(c => c.title).join('、');
  // 整条得连成一片（不分方向数连通块）
  const seen = new Set([p.cards[0].key]), todo = [p.cards[0].key];
  while (todo.length) { const k = todo.pop(); for (const [a, b] of p.edges) { const o = a === k ? b : b === k ? a : null; if (o && !seen.has(o)) { seen.add(o); todo.push(o); } } }
  if (seen.size < p.cards.length) return '链路断成了几截';
  return '';
}
function uniqueFlowName(base, selfId) {
  let name = base, i = 2;
  while (store.workflows.some(w => w.id !== selfId && w.name === name)) name = base + ' ' + (i++);
  return name;
}
// 缩放到整条流程都看得见（0.4–1），摆在右下角对话框的左边；
// fold=true 时，挨着对话框放不下（要缩到 0.5 以下）就把对话框收成药丸，别让卡片压在它底下
function fitView(fold = false, minZoom = 0.3) {
  const ns = (flow() || {}).nodes || [];
  if (!ns.length) return centerView();
  const size = n => { const e = canvas.querySelector(`.node[data-id="${n.id}"]`); return [e ? e.offsetWidth : 244, e ? e.offsetHeight : 160]; };
  const x0 = Math.min(...ns.map(n => n.x)), y0 = Math.min(...ns.map(n => n.y));
  const x1 = Math.max(...ns.map(n => n.x + size(n)[0])), y1 = Math.max(...ns.map(n => n.y + size(n)[1]));
  const pad = 48, need = (w, h) => Math.min(w / (x1 - x0 + 2 * pad), h / (y1 - y0 + 2 * pad));
  let dock = dockOpen ? ($('#dock').offsetWidth || 392) + 28 : 0;
  if (fold && dock && need(wrap.clientWidth - dock, wrap.clientHeight) < 0.5) { dockOpen = false; renderDock(); dock = 0; }
  const W = Math.max(320, wrap.clientWidth - dock), H = wrap.clientHeight;
  const fit = need(W, H);
  zoom = Math.max(minZoom, Math.min(1, Math.floor(fit * 20) / 20));     // 0.3 是缩放条的下限：对话框开着时宁可字小一点，也别让卡压在它底下
  applyZoom();
  // 放得下就居中；还是放不下就从左上角开始（先看见输入卡），往右拖着看
  const wide = (x1 - x0 + 2 * pad) * zoom > W, tall = (y1 - y0 + 2 * pad) * zoom > H;
  wrap.scrollLeft = wide ? (x0 - pad + ORIGIN.x) * zoom : ((x0 + x1) / 2 + ORIGIN.x) * zoom - W / 2;
  wrap.scrollTop = tall ? (y0 - pad + ORIGIN.y) * zoom : ((y0 + y1) / 2 + ORIGIN.y) * zoom - H / 2;
  drawEdges();
}
// 按层排：最长路径定列（输入卡贴着它喂的那一列），列内按上游位置排（少交叉），量了真实高度再码
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
  drawEdges({ recalc: true });                 // 自动排版改了位置：这里重算一次弯度
}
function placeChain() {
  const p = rd.plan, c = rd.chain;
  if (!p || !c || rd.busy) return;
  stopPreview();
  if (isTemp()) dropTemp();                      // 正在临时画布上也照常落卡：先把这张草稿画布收干净，别把它的卡带进正式工作流
  const tiles = new Map([...document.querySelectorAll('#rPrev .rtile[data-key]')].map(t => [t.dataset.key, t.getBoundingClientRect()]));
  $('#readModal').classList.remove('on');
  let w = flow();
  if (!w || w.nodes.length) { w = { id: 'w' + Date.now().toString(36), name: '', agent: '', nodes: [], edges: [], chat: [] }; store.workflows.push(w); }
  if (!w.name || /^(新工作流( \d+)?|未命名.*)$/.test(w.name)) w.name = uniqueFlowName(p.name || (c.name + ' · 工作链路'), w.id);   // 人起过名的空画布不改名
  if (agents.some(a => a.id === c.id && !a.stopped)) w.agent = c.id;      // 链路是谁的，就由谁来执行
  w.source = { kind: 'agent', agent: c.id, name: c.name, readAt: c.readAt, sessions: c.stats.sessions };
  const idOf = new Map();
  w.nodes = p.cards.map(x => {
    const n = { id: uid(), kind: x.kind, title: x.title, body: x.body, impl: x.impl, mods: (x.mods || []).map(m => Object.assign({}, m, { id: uid() })),
      checks: [], chat: [], status: 'idle', x: 0, y: 0 };
    idOf.set(x.key, n.id);
    return n;
  });
  w.edges = p.edges.map(([a, b]) => [idOf.get(a), idOf.get(b)]).filter(([a, b]) => a && b);
  const d = t => t ? new Date(t * 1000).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '';
  w.chat = (w.chat || []).concat([{ role: 'agent', at: Date.now(),
    text: `${p.summary ? p.summary + '\n\n' : ''}读的是「${c.name}」${d(c.stats.first)}–${d(c.stats.last)} 的 ${c.stats.sessions} 次干活记录，拆成 ${w.nodes.length} 张卡、${w.edges.length} 条连线。` }]).slice(-30);
  store.current = w.id; selId = null; panelCardId = null; panelOpen = false;
  layoutChain(w);
  saveAs('agent'); renderWorkflowList(); fitView(true);     // 卡是 agent 拆出来的、人按了「放进画布」
  const keyOf = new Map([...idOf].map(([k, id]) => [id, k]));
  playArrival(w, n => tiles.get(keyOf.get(n.id)));
  Object.assign(rd, { plan: null, msgs: [], error: '' });
}
// 放进画布的动画：预览里的卡「飞」到画布上的位置，落地后连线一条条画出来
function playArrival(w, tileOf) {
  if (reducedMotion()) return;
  const FLY = 560, STEP = 70, landAt = new Map();
  [...w.nodes].sort((a, b) => a.x - b.x || a.y - b.y).forEach((n, i) => {
    const el = canvas.querySelector(`.node[data-id="${n.id}"]`); if (!el) return;
    const delay = i * STEP, from = tileOf(n), r = el.getBoundingClientRect();
    landAt.set(n.id, delay + FLY);
    el.style.transition = 'none';
    if (from && from.width) {
      const f = el.cloneNode(true);
      f.removeAttribute('data-id'); f.classList.add('arriving');
      Object.assign(f.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', margin: '0', width: el.offsetWidth + 'px',
        transformOrigin: '0 0', transition: 'none', zIndex: '300', pointerEvents: 'none' });
      document.body.appendChild(f);
      el.style.opacity = '0';
      const a = f.animate([
        { transform: `translate(${from.left - r.left}px, ${from.top - r.top}px) scale(${from.width / el.offsetWidth})`, opacity: .75 },
        { transform: `scale(${zoom})`, opacity: 1 },
      ], { duration: FLY, delay, easing: 'cubic-bezier(.25,.9,.3,1.04)', fill: 'both' });
      let done = false;
      const land = () => { if (done) return; done = true; f.remove(); el.style.opacity = ''; el.style.transition = ''; };
      a.onfinish = land; setTimeout(land, delay + FLY + 500);
    } else {
      const a = el.animate([{ opacity: 0, transform: 'translateY(14px) scale(.94)' }, { opacity: 1, transform: 'none' }],
        { duration: 380, delay, easing: 'cubic-bezier(.2,.9,.3,1.15)', fill: 'backwards' });
      const fin = () => { el.style.transition = ''; };
      a.onfinish = fin; setTimeout(fin, delay + 900);
    }
  });
  const when = ([a, b]) => Math.max(landAt.get(a) || 0, landAt.get(b) || 0);
  [...w.edges].sort((x, y) => when(x) - when(y)).forEach((e, k) => drawIn(`${e[0]}>${e[1]}`, null, when(e) + 60 + k * 50));
}

// ---------- 临时对话画布（跟着一次对话长出来，不进工作流列表） ----------
// 规矩：临时画布不写 localStorage、不进工作流列表；关掉/切走就没了；人按「存成正式」才进列表。
// 长卡只动变了的那一块（append / 换掉单张卡），不整张画布重建，所以拖拽不受影响。
async function startTempCanvas() {
  if (!tempFlow) tempFlow = { id: TEMP_ID, temp: true, name: '临时画布', agent: DOCK_AGENT, nodes: [], edges: [], chat: [], version: 1, updated_at: Date.now() };
  // 先把状态文件的真实路径取到：这次对话的 prompt 里要写给 agent（它可以直接打开读）
  try { LINK.paths[TEMP_ID] = await window.tcflow.linkPath(TEMP_ID); } catch (e) { }
  store.current = TEMP_ID; selId = null; panelCardId = null; panelOpen = false;
  dockOpen = true; dockConfirm = null;
  renderTempBar(); renderWorkflowList(); render(); centerView();
  queueLinkWrite(tempFlow);
  const i = $('#dockIn'); if (i) i.focus();
}
function dropTemp() {
  stopPreview();
  const t = tempFlow;
  tempFlow = null;
  if (t) { delete LINK.paths[t.id]; try { window.tcflow.linkDrop(t.id); } catch (e) { } }   // 关掉就清干净：文件删掉，列表里什么都没多
  if (store.current === TEMP_ID) store.current = store.workflows[0] ? store.workflows[0].id : null;
  selId = null; panelCardId = null; panelOpen = false;
  renderTempBar();
}
function closeTempCanvas() { dropTemp(); renderWorkflowList(); render(); centerView(); }
// 存成正式工作流：内容与临时画布一致（卡片、连线、模块、正文、内部实现、执行方、对话）
function promoteTemp() {
  const t = tempFlow;
  if (!t || !t.nodes.length) return;
  const base = (t.name && t.name !== '临时画布') ? t.name : '对话链路';
  const w = {
    id: 'w' + Date.now().toString(36),
    name: uniqueFlowName(base),
    agent: t.agent || '',
    chat: (t.chat || []).slice(-30),
    nodes: t.nodes.map(n => Object.assign({}, n, {
      draft: false, seed: false,
      mods: modsOf(n).map(m => ({ ...m, id: uid() })),
      checks: (n.checks || []).slice(), chat: [],
    })),
    edges: t.edges.map(e => e.slice()),
    version: 1, updated_at: Date.now(),
  };
  store.workflows.push(w); store.current = w.id;
  tempFlow = null; delete LINK.paths[TEMP_ID];
  try { window.tcflow.linkDrop(TEMP_ID); } catch (e) { }
  selId = null; panelCardId = null; panelOpen = false;
  renderTempBar(); saveAs('agent'); renderWorkflowList(); render(); fitView(true);   // 草稿是对话里长出来的，人按了「存成正式」
}
function renderTempBar() {
  const bar = $('#tempBar');
  if (!bar) return;
  const on = isTemp();
  bar.classList.toggle('on', on);
  if (on) bar.querySelector('.tb-name').textContent = `临时画布 · 第 ${(tempFlow.version || 1)} 版`;
}
// 临时画布上的落点：输入/加工/输出各一列，同类往下排（不压别的卡）
const TEMP_COL = { in: 0, proc: 1, out: 2 };
function tempCardNode(c) {
  const w = tempFlow;
  const col = TEMP_COL[c.kind] == null ? 1 : TEMP_COL[c.kind];
  const row = w.nodes.filter(n => n.kind === c.kind).length;
  return {
    id: uid(), kind: c.kind, title: c.title, body: c.body || '', impl: c.impl || '',
    mods: (c.mods || []).map(m => ({ id: uid(), type: KIND_MOD[c.kind] || 'tool', name: String(typeof m === 'string' ? m : (m && m.name) || '') })).filter(m => m.name),
    checks: [], chat: [], status: 'idle', draft: true,
    x: 40 + col * 350, y: 40 + row * 210,
  };
}
// 第一张卡 0 秒上屏：模型首次出字要 8 秒上下，画布不能干等着。
// 先把「你这句话」立成这条链路的输入（内容是人的原话，不是编的），agent 的第一张真卡回来接管它（id、位置不变）。
function seedDraft(msg) {
  const w = tempFlow;
  if (!w || w.nodes.length) return null;
  const body = String(msg || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const n = {
    id: uid(), kind: 'in', title: '本次要求', body, impl: '',
    mods: [], checks: [], chat: [], status: 'idle', draft: true, seed: true, x: 40, y: 40,
  };
  w.nodes.push(n); paintOne(n); drawEdges();
  w.version = (w.version || 1) + 1; w.updated_at = Date.now();
  $('#footStat').textContent = `${w.nodes.length} 卡 / ${w.edges.length} 连线 · v${w.version || 1}`;
  renderTempBar(); queueLinkWrite(w);
  return n;
}
// 起草卡被 agent 的第一张真卡接管：内容换成它的，位置按它该在的那一列重摆（临时画布的卡都是自动摆的）
function adoptDraft(draft, c) {
  const nn = tempCardNode(c);
  Object.assign(draft, { kind: nn.kind, title: nn.title, body: nn.body, impl: nn.impl, mods: nn.mods, seed: false, x: nn.x, y: nn.y });
  paintOne(draft);
  return draft;
}
// 卡片是不是完整落在看得见的画布区里（不能被右下角对话框盖住）
function cardInView(el) {
  if (!el) return true;
  const r = el.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
  const dock = (dockOpen && $('#dock')) ? $('#dock').getBoundingClientRect() : null;
  const right = dock && dock.width ? Math.min(wr.right, dock.left) : wr.right;
  return r.left >= wr.left - 2 && r.top >= wr.top - 2 && r.right <= right + 2 && r.bottom <= wr.bottom + 2;
}
function anyCardOutOfView() {
  for (const el of canvas.querySelectorAll('.node')) if (!cardInView(el)) return true;
  return false;
}
// 临时画布的气泡说人话：流里的原始 JSON 换成「在搭哪几张卡」，原话收进折叠块，不糊给用户
function tempHuman(text, liveNow) {
  const raw = String(text || '');
  const cards = partialCardObjects(raw);
  const prose = raw.split('{')[0].replace(/\s+/g, ' ').trim();
  const L = { in: '输入', proc: '加工', out: '成果' };
  const lines = cards.slice(0, 8).map(c => {
    const kk = KIND_ALIAS[String(c.kind || '').toLowerCase()] || KIND_ALIAS[c.kind];
    const body = String(c.body || '').replace(/\s+/g, ' ').trim();
    return `- ${L[kk] || '加工'}｜${String(c.title).slice(0, 30)}${body ? '：' + body.slice(0, 46) : ''}`;
  });
  if (!lines.length) return prose ? prose.slice(0, 320) : (liveNow ? '正在想…' : '');
  const head = liveNow ? `正在搭这条链路（已经 ${cards.length} 张卡）：` : `搭好了：${cards.length} 张卡。`;
  return head + '\n' + lines.join('\n');
}
// 流里已经写完整的卡片对象（还没写完的那张先不长出来）
function partialCardObjects(text) {
  const t = String(text || ''), i = t.indexOf('"cards"');
  if (i < 0) return [];
  const s = t.slice(i), out = [];
  let depth = 0, start = -1, inStr = false, bs = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (inStr) { if (bs) bs = false; else if (ch === '\\') bs = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = k; depth++; }
    else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try { const o = JSON.parse(s.slice(start, k + 1)); if (o && o.title) out.push(o); } catch (e) { }
        start = -1;
      }
    }
  }
  return out;
}
// 画布跟着长：只补新卡、只换改过的卡；新卡按顺序和上一张连一条线
function growTempFrom(text) {
  const w = tempFlow;
  if (!w || document.querySelector('.node.dragging')) return 0;   // 正在拖卡：拖完再长，别抢手
  let added = 0, touched = false;
  let draft = w.nodes.find(n => n.seed) || null;
  for (const x of partialCardObjects(text)) {
    if (w.nodes.length >= 12) break;
    const raw = String(x.kind || '').trim();
    const kind = KIND_ALIAS[raw.toLowerCase()] || KIND_ALIAS[raw];
    const title = String(x.title || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!kind || !title || /^(短标题|标题|卡名|示例)$/.test(title)) continue;
    let n = w.nodes.find(v => v.title === title && !v.seed);
    if (!n) {
      if (!String(x.body || '').trim()) continue;                  // 正文还没写出来：等下一帧
      const card = { kind, title, body: String(x.body), impl: String(x.impl || x.internal || ''), mods: x.mods };
      if (draft) { n = adoptDraft(draft, card); draft = null; }    // 第一张真卡接管起草卡
      else { n = tempCardNode(card); w.nodes.push(n); paintOne(n); }
      added++;
    } else {
      const body = String(x.body || ''), impl = String(x.impl || x.internal || '');
      if (body && (n.body !== body || (n.impl || '') !== impl)) { n.body = body; n.impl = impl; paintOne(n); touched = true; }
    }
    const prev = w.nodes[w.nodes.length - 2];
    if (prev && prev !== n && n.kind !== 'in' && !w.edges.some(([a, b]) => a === prev.id && b === n.id)) {
      w.edges.push([prev.id, n.id]); touched = true;
    }
  }
  if (added || touched) {
    drawEdges();
    w.version = (w.version || 1) + 1; w.updated_at = Date.now();
    $('#footStat').textContent = `${w.nodes.length} 卡 / ${w.edges.length} 连线 · v${w.version || 1}`;
    renderTempBar(); queueLinkWrite(w);
  }
  if (added && anyCardOutOfView()) fitView(false);                 // 长出来的卡看不见（或被对话框盖住）就把视野调过去
  return added;
}
// 一次回答结束：用完整计划对齐一次（补齐漏的卡、按计划的连线接上），然后停下等人决定
function finishTemp(text) {
  const w = tempFlow;
  if (!w) return;
  const plan = parseChainPlan(text || '');
  if (plan) {
    const byTitle = new Map(w.nodes.filter(n => !n.seed).map(n => [n.title, n]));
    const idOf = new Map();
    let draft = w.nodes.find(n => n.seed) || null;
    const planIn = plan.cards.find(c => c.kind === 'in') || plan.cards[0];   // 计划里顶头那张（输入卡）：起草卡并进去，别留两张输入
    for (const c of plan.cards) {
      let n = byTitle.get(c.title);
      if (!n && draft && c === planIn) { n = adoptDraft(draft, c); draft = null; byTitle.set(c.title, n); }
      if (!n) { n = tempCardNode(c); w.nodes.push(n); paintOne(n); byTitle.set(c.title, n); }
      idOf.set(c.key, n.id);
    }
    const es = plan.edges.map(([a, b]) => [idOf.get(a), idOf.get(b)]).filter(([a, b]) => a && b);
    if (es.length) w.edges = es;
    if (plan.name && w.name === '临时画布') w.name = plan.name;
  }
  w.version = (w.version || 1) + 1; w.updated_at = Date.now();
  drawEdges({ recalc: true });
  $('#flowName').value = w.name;
  $('#footStat').textContent = `${w.nodes.length} 卡 / ${w.edges.length} 连线 · v${w.version || 1}`;
  renderTempBar(); queueLinkWrite(w);
  if (w.nodes.length && anyCardOutOfView()) fitView(false);     // 不折对话框：人正在对话框里跟它聊；但卡不能被它盖住
}

// ---------- 导入导出 ----------
async function exportFlow() { const r = await window.tcflow.saveFlow(flow()); $('#savePath').textContent = r.ok ? '已导出' : ''; }
async function importFlow() {
  const r = await window.tcflow.openFlow();
  if (r.ok && r.flow) {
    const w = r.flow; w.id = 'w' + Date.now().toString(36); w.chat = w.chat || [];
    w.nodes = (w.nodes || []).map(n => ({ ...n, kind: n.kind || 'proc', impl: n.impl || '', checks: n.checks || [], mods: Array.isArray(n.mods) ? n.mods : [] }));
    store.workflows.push(w); store.current = w.id; saveStore(); renderWorkflowList(); render();
  }
}

function onKey(e) {
  if (document.querySelector('.modal.on')) {
    if (e.key === 'Escape') {
      if ($('#readModal').classList.contains('on')) closeRead();
      if ($('#testModal').classList.contains('on')) closeTest();
    }
    return;
  }
  if (e.key === 'Delete' && selId && !e.target.isContentEditable && !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) delNode(selId);
  if (e.key === 'Escape') { selId = null; panelCardId = null; panelOpen = false; render(); }
}
// 等回答时每秒刷新「正在想… Ns」；读链路另有自己的进度（拆到第几张 / 等了多久 / 是不是在等）
function tickRead() {
  if (!rd.busy) return;
  const line = readProgress();
  const el = document.querySelector('#rLog [data-live="1"] .txt');
  if (el) el.innerHTML = mdToHTML(line);
  const hint = $('#rHint'); if (hint) hint.textContent = line;
}
setInterval(() => {
  document.querySelectorAll('[data-since]').forEach(el => {
    const n = Math.floor((Date.now() - Number(el.dataset.since)) / 1000);
    const t = el.querySelector('.txt'); if (t) t.textContent = `正在想… ${n}s`;
  });
  tickRead();
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
addEventListener('keydown', e => { if (e.code === 'Space' && !rOpen && !document.querySelector('.modal.on') && !e.target.isContentEditable && !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) { e.preventDefault(); showRadial(innerWidth / 2, innerHeight / 2); } });
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
  if (id === 'dup' && n) { const c = { ...n, id: uid(), x: n.x + 40, y: n.y + 40, title: n.title + ' 副本', mods: modsOf(n).map(m => ({ ...m, id: uid() })) }; flow().nodes.push(c); selId = c.id; saveStore(); render(); }
  if (id === 'auto') validateAll();
  if (id === 'run') openRunModal();
}
