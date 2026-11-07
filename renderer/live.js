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
  if (empty) $('#lempty').textContent = cur
    ? (following ? '跟着这条对话，点「解析链路」开始' : '点「解析链路」把这条对话画成卡')
    : '选一条对话';
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
      setStat(`已解析并保存：${r.doc.cards.length} 张卡${r.name ? ' · ' + r.name : ''}`);
      if (btn) btn.textContent = '重新生成';
    } else {
      setStat('解析没成：' + ((r && r.error) || '未知原因'));
    }
  } catch (e) {
    setStat('解析失败：' + (e && e.message || e));
  } finally {
    analyzing = false; lastAnalyzed = Date.now();
    const has = !!(doc && doc.cards && doc.cards.length);
    if (btn) { btn.disabled = false; btn.textContent = has ? '重新生成' : '解析链路'; }
  }
}

// 打开窗口/切对话：先把上次保存的解析结果摆上来（不用重新跑模型）；没有就等解析
window.__renderDoc = (d) => renderDoc(d, { analyzed: true });   // 调试用：把保存过的一份直接摆上来，不跑模型

async function hydrate(key) {
  const found = list.find(c => c.key === key);
  if (!found) return false;
  const r = await window.tcflow.liveSnapshot({ profile: found.profile, session: found.session });
  if (r && r.doc && r.doc.cards && r.doc.cards.length) {
    renderDoc(r.doc, { analyzed: true });
    analyzedKey = cur;
    const btn = document.querySelector('#lana');
    if (btn) btn.textContent = '重新生成';
    setStat(`已保存：${r.doc.cards.length} 张卡${r.doc.name ? ' · ' + r.doc.name : ''}`);
    return true;
  }
  if (r && r.error) setStat(r.error);
  return false;
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
  const got = await hydrate(cur);
  if (!got) {
    const r = await window.tcflow.liveSnapshot({ profile: found.profile, session: found.session });
    if (r && r.doc) renderDoc(r.doc);
  }
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
// 跟随只负责「读消息、更新状态」，**不自动解析**：解析是人点出来的，跑完自动保存；
// 不满意再点「重新生成」，新的没拆好就还是旧那份。
function maybeAnalyze() { /* 故意留空：自动重解析会让每次打开都白跑一次模型 */ }

async function stopFollow() {
  const found = list.find(c => c.key === cur);
  following = false;
  $('#lfol').checked = false;
  if (found) await window.tcflow.liveFollow({ profile: found.profile, session: found.session, on: false });
  paintStat();
}

// 悬停素材/成果：能拿到真文件就真预览——文本按文档、图片按看图、视频按播放器；
// 拿不到文件（或打不开）就退回一行说明，不空着。
(function wireTip() {
  const box = () => document.getElementById('ltip');
  let seq = 0;
  const sizeOf = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
  let lastX = 0, lastY = 0;
  const place = (el, x, y) => {
    lastX = x; lastY = y;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(x + 14, window.innerWidth - r.width - 12));
    let top = Math.max(8, Math.min(y + 16, window.innerHeight - r.height - 12));
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - r.height - 8);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  };
  // 图片/视频是后加载的：尺寸一变就重新摆，别让它顶出窗口
  const replaceOnLoad = el => {
    const media = el.querySelector('img,video');
    if (!media) return;
    const fix = () => { if (el.classList.contains('on')) place(el, lastX, lastY); };
    if (media.complete || media.readyState >= 1) fix();
    media.addEventListener('load', fix, { once: true });
    media.addEventListener('loadedmetadata', fix, { once: true });
  };
  const showText = (el, chip, x, y) => {
    const raw = chip.dataset.tip || '';
    const [name, from, ...rest] = raw.split('\n');
    el.innerHTML = `<b>${esc(name || '')}</b>${esc(from || '')}${rest.length ? '\n' + esc(rest.join('\n')) : ''}`;
    el.classList.add('on'); el.classList.remove('rich');
    place(el, x, y);
  };
  const showPreview = (el, chip, r, x, y) => {
    const head = `<b>${esc(r.name || chip.textContent)}</b>` +
      `<span class="lmeta">${r.kind === 'image' ? '图片' : r.kind === 'video' ? '视频' : r.kind === 'text' ? '文本' : '文件'} · ${sizeOf(r.bytes || 0)}</span>`;
    let body = '';
    if (r.kind === 'image') body = `<img class="limg" src="${r.url}" alt="${esc(r.name || '')}">`;
    else if (r.kind === 'video') body = `<video class="lvid" src="${r.url}" controls autoplay muted loop playsinline></video>`;
    else if (r.kind === 'text') body = `<pre class="ltxt">${esc(String(r.text || '').slice(0, 4000))}${r.cut ? '\n…（后面还有，没全读）' : ''}</pre>`;
    el.innerHTML = head + body;
    el.classList.add('on', 'rich');
    place(el, x, y);
    replaceOnLoad(el);
  };
  const show = (chip, x, y) => {
    const el = box(); if (!el) return;
    showText(el, chip, x, y);                       // 先把说明摆出来，预览到了再换
    const fp = chip.dataset.path;
    if (!fp || !window.tcflow.livePeek) return;
    const mine = ++seq;
    window.tcflow.livePeek({ path: fp }).then(r => {
      if (mine !== seq || !el.classList.contains('on')) return;   // 鼠标已经移走了
      if (r && r.ok) showPreview(el, chip, r, x, y);
    }).catch(() => {});
  };
  const hide = () => { seq++; const el = box(); if (el) { el.classList.remove('on', 'rich'); el.innerHTML = ''; } };
  document.addEventListener('mouseover', e => {
    const chip = e.target.closest && e.target.closest('.mod[data-tip]');
    if (chip) show(chip, e.clientX, e.clientY); else hide();
  });
  document.addEventListener('mousemove', e => {
    const el = box();
    if (!el || !el.classList.contains('on')) return;
    const chip = e.target.closest && e.target.closest('.mod[data-tip]');
    if (!chip) return hide();
    place(el, e.clientX, e.clientY);
  });
  document.addEventListener('mouseleave', hide);
  window.addEventListener('blur', hide);
  window.addEventListener('scroll', hide, true);
})();



// ===== 面板：主画布 renderer/app.js 的 paintPanel() 原样搬来的（去掉聊天/预演）=====
// 主画布改字段或样式时，这里跟着搬一次；不要再另写一套。
const KINDS = {
  in:   { label: '输入', cls: 'in',   ph: '这一步要先有什么（说人话，例：一个商品编号，加它现成的证据资料）' },
  proc: { label: '加工', cls: 'proc', ph: '这一步让人做什么（说人话，例：找到这个商品最新最全的那份证据）' },
  out:  { label: '输出', cls: 'out',  ph: '最后交出什么（说人话，例：一份能直接拿去用的证据目录）' },
};
const KIND_MOD = { in: 'mat', proc: 'tool', out: 'res' };
const MOD_T = { mat: '素材', tool: '工具', res: '成果' };
const modsOfCard = card => (card.mods || []).map(m => ({ ...m, type: m.type || KIND_MOD[card.kind] }));
const implOfCard = card => String(card.impl || '');
function panelHTML(card, agentName) {
  const kind = KINDS[card.kind] || KINDS.proc;
  return `
    <input id="pTitle" class="titleinp" value="${esc(card.title)}" spellcheck="false" placeholder="卡片名">
    <div class="kindrow"><span class="lab">类型</span>
      <select id="pKind">${Object.entries(KINDS).map(([kk, v]) => `<option value="${kk}" ${kk === card.kind ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
    <div class="pgroup ${kind.cls}"><span class="lab">${kind.label}内容</span>
      <textarea id="pBody" placeholder="${esc(kind.ph)}">${esc(card.body)}</textarea>
</div>
    <div class="pmods"><span class="lab">${MOD_T[KIND_MOD[card.kind]]}</span>
      <div class="pm-list" id="pMods">${modsOfCard(card).map((m, i) => `<span class="mod t-${m.type} ed"><span class="mn" contenteditable="plaintext-only" spellcheck="false" data-i="${i}">${esc(m.name)}</span><b class="mx" data-x="${i}" title="删掉这块">✕</b></span>`).join('')}<input id="pModAdd" class="pm-add" placeholder="+ ${MOD_T[KIND_MOD[card.kind]]}（回车添加）"></div>
    </div>

    <div class="chat">
      <div class="chat-hd"><b>和 ${esc(agentName)} 聊这张卡</b><span class="kbd">Enter 发送</span></div>
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
      <textarea id="pImpl" placeholder="执行时真正跑什么：命令 / 脚本 / 路径 / 字段名（例：hermes -p &lt;agent&gt; chat -q …、evidence/&lt;包&gt;/page-fields）">${esc(implOfCard(card))}</textarea>
      <input id="pChecks" value="${esc((card.checks || []).join(', '))}" placeholder="校验项，逗号分隔（例：sha256, schema）">
    </details>`;
}

// 双击卡片：右边滑出「和主画布同一张卡」的面板（结构、字段、样式都照搬 paintPanel）
let editingId = '', saveTimer = 0;
const $id = x => document.getElementById(x);

function openEditor(id) {
  const card = (doc && doc.cards || []).find(c => c.id === id);
  if (!card || !$id('ledit')) return;
  editingId = id;
  $id('ledTitle').textContent = (KINDS[card.kind] || KINDS.proc).label + '卡 · ' + card.title;
  $id('ledBody').innerHTML = panelHTML(card, (doc && doc.conv && doc.conv.who) || '它的执行方');      // ← 主画布那段模板原样渲染
  $id('ledit').classList.add('on');
  wireEditor(card);
  wireChat(card);
  const t = $id('pTitle');
  if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
}

function touch(card, rerender) {
  if (rerender) renderDoc(doc, { analyzed: true });
  setStat(`已保存：${(doc.cards || []).length} 张卡（改过）`);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { window.tcflow.liveDocSave(doc).catch(() => {}); }, 400);
}

function wireEditor(card) {
  const bind = (sel, ev, fn) => { const el = $id(sel); if (el) el[ev] = fn; };
  bind('pTitle', 'oninput', e => {
    card.title = e.target.value.slice(0, 24);
    $id('ledTitle').textContent = (KINDS[card.kind] || KINDS.proc).label + '卡 · ' + card.title;
    touch(card, true);
  });
  bind('pKind', 'onchange', e => {
    card.kind = e.target.value;
    card.mods = (card.mods || []).map(m => ({ ...m, type: KIND_MOD[card.kind] }));
    openEditor(card.id); touch(card, true);
  });
  bind('pBody', 'oninput', e => { card.body = e.target.value.slice(0, 260); touch(card, false); });
  bind('pImpl', 'oninput', e => { card.impl = e.target.value.slice(0, 600); touch(card, false); });
  bind('pChecks', 'oninput', e => { card.checks = String(e.target.value || '').split(',').map(x => x.trim()).filter(Boolean); touch(card, false); });

  $id('pMods').querySelectorAll('.mn').forEach(sp => {
    sp.oninput = () => { const m = card.mods[Number(sp.dataset.i)]; if (m) { m.name = sp.textContent.trim().slice(0, 16); touch(card, true); } };
  });
  $id('pMods').querySelectorAll('.mx').forEach(x => x.onclick = () => {
    card.mods.splice(Number(x.dataset.x), 1); openEditor(card.id); touch(card, true);
  });
  bind('pModAdd', 'onkeydown', e => {
    if (e.key !== 'Enter') return;
    const name = e.target.value.trim().slice(0, 16);
    if (!name) return;
    card.mods = card.mods || [];
    card.mods.push({ type: KIND_MOD[card.kind], name });
    openEditor(card.id); touch(card, true);
  });
}

// 和这张卡的执行方聊一句（气泡样式沿用主画布那套 .msg）
function chatPaint(card) {
  const log = document.getElementById('chatLog');
  if (!log) return;
  const list = card.chat || [];
  log.innerHTML = list.length
    ? list.map(m => m.role === 'me'
      ? `<div class="msg me">${esc(m.text)}</div>`
      : `<div class="msg agent"><div class="who">${esc((doc.conv && doc.conv.who) || '执行方')}</div>${esc(m.text)}</div>`).join('')
    : '<div class="msg empty">还没聊过。问一句它当时为什么这么做。</div>';
  log.scrollTop = log.scrollHeight;
}
async function chatSend(card, text) {
  const q = String(text || '').trim();
  if (!q) return;
  card.chat = card.chat || [];
  card.chat.push({ role: 'me', text: q });
  chatPaint(card);
  const log = document.getElementById('chatLog');
  if (log) log.insertAdjacentHTML('beforeend', '<div class="msg thinking" id="chatWait">正在问它…</div>');
  const prompt = [
    '【实时画布】下面是一条链路里的一张卡，和用户问的问题。只回答，不改画布、不跑命令。',
    `卡片（${(KINDS[card.kind] || KINDS.proc).label}）：${card.title}`,
    `内容：${card.body || '（空）'}`,
    `内部实现：${card.impl || '（空）'}`,
    `用户问：${q}`,
    '直接用中文回答，三行以内。',
  ].join('\n');
  let answer = '';
  try {
    const r = await window.tcflow.askAgent({ profile: (doc.conv && doc.conv.profile) || '', prompt });
    answer = (r && r.ok && String(r.text || '').trim()) || '（它没有回答）';
  } catch (e) { answer = '问失败：' + (e && e.message || e); }
  const wait = document.getElementById('chatWait');
  if (wait) wait.remove();
  card.chat.push({ role: 'agent', text: answer });
  chatPaint(card);
  touch(card, false);
}
function wireChat(card) {
  chatPaint(card);
  const input = document.getElementById('chatIn');
  const btn = document.getElementById('chatSend');
  if (btn) btn.onclick = () => { if (input) { chatSend(card, input.value); input.value = ''; } };
  if (input) input.onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(card, input.value); input.value = ''; }
  };
  document.querySelectorAll('#ledBody .qchip').forEach(c => c.onclick = () => {
    const q = c.dataset.q === 'review' ? '这张卡按现在的写法能做出来吗？有什么风险？'
      : c.dataset.q === 'next' ? '下一步该做什么？给出具体做法。'
      : '把这条链路从头讲一遍，指出最可能出错的一步。';
    chatSend(card, q);
  });
}

function closeEditor() {
  editingId = '';
  clearTimeout(saveTimer);
  window.tcflow.liveDocSave(doc).catch(() => {});
  const box = $id('ledit');
  if (box) box.classList.remove('on');
}

// ---------- 画布 ----------
// 卡片、连线、拖动全部用 cardsys.js（从主画布原样搬来的 nodeEl / modsHTML / drawEdges / dragCard）。
// 这个文件只负责：把 doc 变成主画布那套 flow()/{nodes,edges}、排版、以及保存。
const CANVAS = { w: 12000, h: 8000 };
let selId = null;

const find = id => ((doc && doc.cards) || []).find(c => c.id === id) || null;
const flow = () => (doc ? { id: doc.conv.key, nodes: doc.cards, edges: (doc.edges || []).map(e => [e[0], e[1]]) } : null);
const modsOf = n => (n && Array.isArray(n.mods) ? n.mods : []);
const implOf = n => String((n && n.impl) || '').trim();
const nodeSig = n => JSON.stringify([n.kind, n.title, n.body, n.impl, modsOf(n).map(m => m.type + ':' + m.name), n.checks || [], n.x, n.y]);
function findDock() { return null; }                     // 实时窗口不接插槽（连线是解析出来的，不靠拖）
function saveStore() { persist(); }              // 拖动收尾：存位置
function openCard(n) { openEditor(n.id); }       // 双击 / ⚙ 都进同一个面板
function chatAsk() { const i = document.getElementById('chatIn'); if (i) i.focus(); }

// 只读窗口里的「连线」按钮：不建新关系，只提示一句
function noLink() { setStat('实时画布的连线是解析出来的，不能手动加'); }
function startLink() { noLink(); }     // 覆盖 cardsys 里那份（它要写连线）
// cardsys 的 nodeEl 会调这两个：选中高亮 + 从插槽里拖出来断开（实时窗口不接插槽，后者是空操作）
function markSel() {
  document.querySelectorAll('#canvas .node').forEach(el => el.classList.toggle('sel', el.dataset.id === selId));
}
function unplugDrag() { setStat('实时画布的模块是从对话里解析出来的，不能在卡片上拖动断开'); }

function applyZoom() {
  const cw = wrap.clientWidth, ch = wrap.clientHeight;
  const changed = zoom !== lastZoom;
  const cx = (wrap.scrollLeft + cw / 2) / lastZoom, cy = (wrap.scrollTop + ch / 2) / lastZoom;
  canvas.style.transformOrigin = '0 0';
  canvas.style.transform = `scale(${zoom})`;
  if (changed && cw && ch) { wrap.scrollLeft = cx * zoom - cw / 2; wrap.scrollTop = cy * zoom - ch / 2; }
  lastZoom = zoom;
  const z = $('#zoom'); if (z) z.textContent = Math.round(zoom * 100) + '%';
}

// 重画节点：layoutChain（主画布那份排版）会调这个
function render() {
  if (!doc) return;
  const keep = new Set();
  for (const c of doc.cards) {
    keep.add(c.id);
    const old = canvas.querySelector(`.node[data-id="${CSS.escape(c.id)}"]`);
    if (!old) { canvas.appendChild(nodeEl(c)); continue; }
    if (old.dataset.sig !== nodeSig(c)) old.replaceWith(nodeEl(c));
    else { old.style.left = (c.x + OX) + 'px'; old.style.top = (c.y + OY) + 'px'; }
  }
  for (const el of [...canvas.querySelectorAll('.node')]) if (!keep.has(el.dataset.id)) el.remove();
}

// 卡片上每个药丸对应哪份文件（悬停预览要用）
function annotateChips() {
  const cards = (doc && doc.cards) || [];
  const byId = new Map(cards.map(c => [c.id, c]));
  const ups = id => ((doc.edges || []).filter(e => e[1] === id).map(e => byId.get(e[0])).filter(Boolean));
  const downs = id => ((doc.edges || []).filter(e => e[0] === id).map(e => byId.get(e[1])).filter(Boolean));
  for (const n of canvas.querySelectorAll('#canvas .node')) {
    const c = find(n.dataset.id);
    if (!c) continue;
    const rows = [...n.querySelectorAll('.mline')];
    rows.forEach(row => {
      const lab = (row.querySelector('.mlab') || {}).textContent || '';
      const chips = [...row.querySelectorAll('.mod')];
      const srcList = c.kind !== 'proc' ? [c] : lab === '素材' ? ups(c.id) : lab === '成果' ? downs(c.id) : [];
      const used = new Set();
      chips.forEach((chip, i) => {
        const src = srcList[i % Math.max(1, srcList.length)];
        if (!src) return;
        const path = bestPath(src, chip.textContent, used);
        if (!path) return;
        used.add(path);
        chip.dataset.path = path;
        const tipTxt = `${chip.textContent}\n来自「${src.title}」\n${detailOf(src)}`;
        chip.dataset.tip = tipTxt;
        chip.title = tipTxt;
      });
    });
  }
}

function renderDoc(d, opts) {
  if (!d || !Array.isArray(d.cards)) return;
  const switched = doc && doc.conv && d.conv && doc.conv.key !== d.conv.key;
  doc = d;
  for (const c of doc.cards) { if (!Number.isFinite(c.x)) c.x = 0; if (!Number.isFinite(c.y)) c.y = 0; c.checks = c.checks || []; if (!c.status) c.status = 'idle'; }
  if (switched) { fitted = false; canvas.querySelectorAll('.node').forEach(el => el.remove()); edgesSvg.innerHTML = ''; }
  // 人拖过的卡保持原位；其余的照主画布那样自动成列
  const manual = doc.cards.filter(c => c.manual);
  for (const c of manual) { c._mx = c.x; c._my = c.y; }   // 先记下人手摆的位置，排完再放回去
  layoutChain(flow());
  for (const c of manual) { c.x = c._mx; c.y = c._my; delete c._mx; delete c._my; }
  render();
  for (const c of manual) { const el = canvas.querySelector(`.node[data-id="${CSS.escape(c.id)}"]`); if (el) { el.style.left = (c.x + OX) + 'px'; el.style.top = (c.y + OY) + 'px'; } }
  drawEdges();
  annotateChips();
  if (!fitted && doc.cards.length) { fit(); fitted = true; }
  paintStat(); paintEmpty();
}

function bbox() {
  const ns = [...canvas.querySelectorAll('#canvas .node')];
  if (!ns.length) return null;
  const rs = ns.map(n => n.getBoundingClientRect());
  return { x0: Math.min(...rs.map(r => r.left)), y0: Math.min(...rs.map(r => r.top)), x1: Math.max(...rs.map(r => r.right)), y1: Math.max(...rs.map(r => r.bottom)) };
}
function fit() {
  const ns = (doc && doc.cards) || [];
  if (!ns.length) return;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  const xs = ns.map(c => c.x), ys = ns.map(c => c.y);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const x1 = Math.max(...xs) + 260, y1 = Math.max(...ys) + 190;
  const pad = 80;
  const z = Math.min(1, Math.max(0.25, Math.min((W - pad * 2) / Math.max(1, x1 - x0), (H - pad * 2) / Math.max(1, y1 - y0))));
  zoom = z; applyZoom();
  wrap.scrollLeft = (OX + x0 - pad) * z;      // 卡画在 ORIGIN 偏移之后的坐标上，滚动量要带上它
  wrap.scrollTop = (OY + y0 - pad) * z;
}

function bindCanvas() {
  let panning = false, sx = 0, sy = 0, ox = 0, oy = 0;
  wrap.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('.node') || e.target.closest('.zoombar')) return;
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
  $('#zoomOut').onclick = () => { zoom = Math.max(0.3, zoom - 0.1); applyZoom(); drawEdges(); };
  $('#zoomReset').onclick = () => { zoom = 1; applyZoom(); if (doc) layoutChain(flow()); fit(); drawEdges(); };
  const lana = $('#lana'); lana.onclick = () => analyzeNow(true);
  const closeBtn = document.getElementById('ledClose');
  if (closeBtn) closeBtn.onclick = closeEditor;
  const box = document.getElementById('ledit');
  if (box) box.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeEditor(); });
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
  else {
    if (st.on) $('#lfol').checked = true;
    if (cur) await hydrate(cur);                      // 跟随关着也把上次保存的解析结果摆上来
  }
}
init();
