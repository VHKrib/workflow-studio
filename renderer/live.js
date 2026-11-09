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
let readOnly = false;      // 确定工作流之后：这块变成只读参考

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
  if (!doc) { setStat(cur ? '等第一条消息…' : ''); return; }
  if (!doc.conv) {                       // 老存档里没有 conv：照样按卡数报，别显示成「等第一条消息」
    const n0 = (doc.cards || []).length;
    setStat(n0 ? `已解析：${n0} 张卡${doc.name ? ' · ' + doc.name : ''}` : (cur ? '等第一条消息…' : ''));
    return;
  }
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
  window.__undoneForEdit = false;
  $id('ledTitle').textContent = (KINDS[card.kind] || KINDS.proc).label + '卡 · ' + card.title;
  $id('ledBody').innerHTML = panelHTML(card, (doc && doc.conv && doc.conv.who) || '它的执行方');      // ← 主画布那段模板原样渲染
  $id('ledit').classList.add('on');
  wireEditor(card);
  wireChat(card);
  paintExtras(card);
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

// ===== 双击面板里的三段：素材（全部）/ 模型与接口能力 / 成果预览 =====
// 用户口径（2026-11-07）：面板里要看到这张卡的全部素材、模型能力边界、成果预览；
// 位置不够就滚动（.pb 本身滚动）；没有确切数字的写「未取得」并注明要补哪份文档，不编数字。
const EXT_IMG = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;
const EXT_VID = /\.(mp4|mov|webm|mkv|avi)$/i;
const fmtBytes = n => (!n ? '' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
const baseName = p => String(p || '').split('/').pop();

function upsOf(id) { return (doc.edges || []).filter(e => e[1] === id).map(e => find(e[0])).filter(Boolean); }
function downsOf(id) { return (doc.edges || []).filter(e => e[0] === id).map(e => find(e[1])).filter(Boolean); }
function firstPathOf(c) {
  const bag = [String((c && c.impl) || '')].concat(modsOf(c).map(m => m.path || '')).join(' ');
  const m = bag.match(/\/[^\s;；,，]+\.(?:png|jpe?g|webp|gif|mp4|mov|webm|pdf|md|txt|json|csv|svg)/i);
  return m ? m[0] : '';
}
// kind: 'mat' 素材 / 'res' 成果 —— 自己的 mods + 连线带过来的那张卡，全部列出来（不截断）
function itemsOf(card, kind) {
  const out = [], seen = new Set();
  const push = (name, path, from) => {
    const k = path || name;
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ name: String(name || baseName(path) || '（未命名）'), path: path || '', from: from || '' });
  };
  for (const m of modsOf(card)) if (m.type === kind) push(m.name, m.path || firstPathOf(card), card.title);
  for (const c of (kind === 'mat' ? upsOf(card.id) : downsOf(card.id))) {
    const ms = modsOf(c).filter(m => m.type === kind);
    if (ms.length) for (const m of ms) push(m.name, m.path || firstPathOf(c), c.title);
    else push(c.title, firstPathOf(c), c.title);
  }
  return out;
}
// 模型/接口能力：有 caps 就照写；没有就明确「未取得」+ 要补哪份文档（不编数字）
const CAP_NEED = {
  img: '单次生成张数 / 参考图上限 / 文本（提示词）上限 / 输出尺寸与画幅',
  vid: '单次生成段数 / 参考图上限 / 文本上限 / 输出时长与画幅 / 并发与限速',
  txt: '上下文长度上限 / 单次输出上限 / 并发与限速',
};
function capHTML(m) {
  const name = String((m && m.name) || '模型');
  const caps = String((m && m.caps) || '').trim();
  const kind = /视频/.test(name) ? 'vid' : /文本/.test(name) ? 'txt' : 'img';
  if (caps && !/未取得/.test(caps)) return `<div class="lxcap"><b>${esc(name)}</b> · ${esc(caps)}</div>`;
  return `<div class="lxcap"><b>${esc(name)}</b> · <span class="unknown">能力未取得</span><br>` +
    `要补：该接口的文档里 ${esc(CAP_NEED[kind])}（拿到后写进这里，不猜数字）</div>`;
}

function rowHTML(it, kind) {
  const isImg = EXT_IMG.test(it.path || it.name);
  const isVid = EXT_VID.test(it.path || it.name);
  const tag = isImg ? '图' : isVid ? '视频' : (it.path ? '文件' : '—');
  return `<div class="lxrow" data-path="${esc(it.path)}">
    <div class="lxthumb" title="${isImg ? '点开放大' : '没有可预览的文件'}">${isImg ? '载入…' : tag}</div>
    <div class="lxname">${esc(baseName(it.path) || it.name)}<em>${esc(it.from ? '来自「' + it.from + '」' : '')}</em></div>
    <div class="lxmeta">${it.path ? '' : '未记录路径'}</div>
    ${it.path ? '<button class="lxopen">打开</button>' : ''}
  </div>`;
}

async function paintExtras(card) {
  const box = $id('ledBody');
  if (!box) return;
  let host = $id('lxExtra');
  if (!host) {
    host = document.createElement('div');
    host.className = 'lx';
    host.id = 'lxExtra';
    box.appendChild(host);
  }
  const mats = itemsOf(card, 'mat');
  const ress = itemsOf(card, 'res');
  const tools = modsOf(card).filter(m => m.type === 'tool');
  const hows = modsOf(card).filter(m => m.type === 'how');

  host.innerHTML = `
    <div class="lxhead"><button id="lxDelCard" class="lmini" title="删掉这张卡（⌘Z 可撤销）">删除这张卡</button></div>
    <h4>素材 <b>${mats.length}</b>${mats.length ? '' : '（这张卡没有记录素材）'}</h4>
    <div class="lxlist">${mats.length ? mats.map(it => rowHTML(it, 'mat')).join('') : '<div class="lx-empty">—</div>'}</div>
    <h4>模型与接口能力</h4>
    <div class="lxlist">${tools.length ? tools.map(capHTML).join('') : '<div class="lxcap"><span class="unknown">这张卡没有记录模型/接口</span><br>要补：这一步实际调用的模型名与接口文档（' + esc(CAP_NEED.img) + '）</div>'}</div>
    ${hows.length ? `<h4>做法</h4><div class="lxcap">${hows.map(m => esc(m.name)).join(' · ')}</div>` : ''}
    <h4>成果 <b>${ress.length}</b>${ress.length ? '' : '（这张卡没有记录成果）'}</h4>
    <div class="lxlist">${ress.length ? ress.map(it => rowHTML(it, 'res')).join('') : '<div class="lx-empty">—</div>'}</div>
  `;

  // 逐个补：文件大小 + 图片缩略图；点缩略图放大，点「打开」用系统程序打开
  const delBtn = host.querySelector('#lxDelCard');
  if (delBtn) delBtn.onclick = () => delCard(card.id);

  const rows = [...host.querySelectorAll('.lxrow')];
  const tagged = mats.map(it => ({ it, type: 'mat' })).concat(ress.map(it => ({ it, type: 'res' })));
  rows.forEach((row, i) => {
    const t = tagged[i];
    if (!t) return;
    row.dataset.card = card.id;
    row.dataset.type = t.type;
    row.dataset.name = t.it.name;
    const act = document.createElement('div');
    act.className = 'lxact';
    act.innerHTML = '<button title="改名">改</button><button title="删掉这一项">删</button>';
    act.children[0].onclick = e => { e.stopPropagation(); renameMod(card.id, t.type, t.it.name); };
    act.children[1].onclick = e => { e.stopPropagation(); delMod(card.id, t.type, t.it.name); };
    row.appendChild(act);
    row.onclick = () => {
      host.querySelectorAll('.lxrow.sel').forEach(r => r.classList.remove('sel'));
      row.classList.add('sel');
    };
  });
  for (const row of rows) {
    const p = row.dataset.path;
    if (!p) continue;
    try {
      const r = await window.tcflow.livePeek({ path: p });
      const meta = row.querySelector('.lxmeta');
      if (r && r.ok) {
        if (meta) meta.textContent = `${r.kind === 'image' ? '图片' : r.kind === 'video' ? '视频' : r.kind === 'text' ? '文本' : '文件'} · ${fmtBytes(r.bytes)}`;
        const th = row.querySelector('.lxthumb');
        if (th && r.kind === 'image') {
          th.innerHTML = `<img src="${r.url}" alt="">`;
          th.onclick = () => openViewer(r.url, r.name);
        } else if (th && r.kind === 'video') {
          th.textContent = '视频';
        } else if (th) {
          th.textContent = '文件';
        }
      } else if (meta) {
        const why = (r && r.error) || '';
        meta.textContent = /ENOENT/.test(why) ? '文件已不在原处' : '打不开：' + why;
      }
    } catch (e) { }
    const open = row.querySelector('.lxopen');
    if (open) open.onclick = () => { window.tcflow.liveOpenPath(p).catch(() => { }); };
  }
}

function openViewer(url, name) {
  const box = document.getElementById('lview'), img = document.getElementById('lviewImg'), cap = document.getElementById('lviewCap');
  if (!box || !img) return;
  img.src = url;
  if (cap) cap.textContent = name || '';
  box.classList.add('on');
  box.onclick = () => { box.classList.remove('on'); img.src = ''; };
  document.addEventListener('keydown', function esc(ev) {
    if (ev.key === 'Escape') { box.classList.remove('on'); img.src = ''; removeEventListener('keydown', esc); }
  });
}

// ===== 编辑 / 删除 / 撤销重做 / 保存（用户 2026-11-07 要的四件事） =====
const HIST_MAX = 80;                     // 至少 50 步：这里留 80
let undoStack = [], redoStack = [];

const snapOf = () => JSON.stringify({ cards: doc.cards, edges: doc.edges });
function pushUndo() {
  if (!doc) return;
  undoStack.push(snapOf());
  if (undoStack.length > HIST_MAX) undoStack.shift();
  redoStack.length = 0;
  paintHist();
}
function applySnap(s) {
  const o = JSON.parse(s);
  doc.cards = o.cards;
  doc.edges = o.edges;
  renderDoc(doc, { keepView: true });
}
function undo() { if (!undoStack.length) return; redoStack.push(snapOf()); applySnap(undoStack.pop()); persist(); paintHist(); toast('已撤销'); }
function redo() { if (!redoStack.length) return; undoStack.push(snapOf()); applySnap(redoStack.pop()); persist(); paintHist(); toast('已重做'); }
function paintHist() {
  const u = document.getElementById('lundo'), r = document.getElementById('lredo');
  if (u) u.disabled = !undoStack.length;
  if (r) r.disabled = !redoStack.length;
}
function toast(text, bad) {
  const t = document.getElementById('ltoast');
  if (!t) return;
  t.textContent = text;
  t.className = 'ltoast on' + (bad ? ' bad' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = 'ltoast' + (bad ? ' bad' : ''); }, 2600);
}
const pad2t = n => String(n).padStart(2, '0');
async function saveNow() {
  if (!doc) return;
  const d = new Date();
  const hhmmss = pad2t(d.getHours()) + ':' + pad2t(d.getMinutes()) + ':' + pad2t(d.getSeconds());
  try {
    const r = await window.tcflow.liveDocSave(doc);
    if (r && r.ok === false) throw new Error(r.error || '服务端没写进去');
    setStat(`已保存：${(doc.cards || []).length} 张卡`);
    toast('已保存 ' + hhmmss);
  } catch (e) {
    toast('保存失败：' + ((e && e.message) || e), true);
  }
}

// 删整张卡（连带它的边）
function delCard(id) {
  const c = find(id);
  if (!c) return;
  pushUndo();
  doc.cards = doc.cards.filter(x => x.id !== id);
  doc.edges = (doc.edges || []).filter(e => e[0] !== id && e[1] !== id);
  if (editingId === id) closeEditor();
  selId = null;
  renderDoc(doc, { keepView: true });
  persist();
  toast('已删除这张卡（⌘Z 可撤销）');
}

// 改/删单个元素（素材、工具、做法、成果）
function delMod(cardId, type, name) {
  const c = find(cardId);
  if (!c) return;
  pushUndo();
  c.mods = (c.mods || []).filter(m => !(m.type === type && m.name === name));
  renderDoc(doc, { keepView: true });
  if (editingId === cardId) openEditor(cardId);
  persist();
  toast('已删除元素「' + name + '」（⌘Z 可撤销）');
}
function renameMod(cardId, type, name) {
  const c = find(cardId);
  if (!c) return;
  const m = (c.mods || []).find(x => x.type === type && x.name === name);
  if (!m) return;
  const next = window.prompt('改成什么名字？（留空=不改）', name);
  if (next == null) return;
  const nn = String(next).trim();
  if (!nn || nn === name) return;
  pushUndo();
  m.name = nn;
  renderDoc(doc, { keepView: true });
  if (editingId === cardId) openEditor(cardId);
  persist();
  toast('已改名：' + nn);
}

// 素材 / 成果直接画在卡身上：缩略图 + 文件名 + 数量，放不下横向滚动
async function paintMedia() {
  if (!doc) return;
  for (const el of canvas.querySelectorAll('.node')) {
    const c = find(el.dataset.id);
    if (!c || (c.kind !== 'in' && c.kind !== 'out')) continue;
    const items = itemsOf(c, c.kind === 'in' ? 'mat' : 'res');
    const old = el.querySelector('.mstrip');
    if (!items.length) { if (old) old.remove(); continue; }
    const sig = items.map(i => i.path || i.name).join('|');
    let strip = old;
    if (!strip || strip.dataset.sig !== sig) {
      strip = document.createElement('div');
      strip.className = 'mstrip';
      strip.dataset.sig = sig;
      strip.innerHTML = items.map((it, i) => `<div class="mstile" data-i="${i}" title="${esc(it.path ? it.path.split('/').pop() : it.name)}">
          <div class="mt">${EXT_IMG.test(it.path || it.name) ? '…' : EXT_VID.test(it.path || it.name) ? '视频' : '文件'}</div>
          <div class="mn">${esc((it.path ? it.path.split('/').pop() : it.name))}</div></div>`).join('');
      const body = el.querySelector('.body');
      if (body && body.nextSibling) el.insertBefore(strip, body.nextSibling);
      else el.appendChild(strip);
      // 数量标在标题旁
      const hd = el.querySelector('.hd .t');
      const badge = el.querySelector('.mcount');
      if (badge) badge.remove();
      if (hd && items.length) hd.insertAdjacentHTML('afterend', `<span class="mcount" title="${c.kind === 'in' ? '素材' : '成果'} ${items.length} 个">${items.length}</span>`);
      [...strip.querySelectorAll('.mstile')].forEach(tile => {
        const it = items[Number(tile.dataset.i)];
        tile.onclick = () => { if (it.path) openItem(it.path); };
      });
    }
    // 补缩略图（只补还没图的）
    for (const tile of strip.querySelectorAll('.mstile')) {
      const it = items[Number(tile.dataset.i)];
      const mt = tile.querySelector('.mt');
      if (!it.path || !mt || mt.querySelector('img')) continue;
      try {
        const r = await window.tcflow.livePeek({ path: it.path });
        if (r && r.ok && r.kind === 'image') mt.innerHTML = `<img src="${r.url}" alt="">`;
        else if (r && r.ok && r.kind === 'video') mt.textContent = '视频';
        else if (!r || !r.ok) mt.textContent = '不在了';
      } catch (e) { }
    }
  }
}
function openItem(path) {
  window.tcflow.livePeek({ path }).then(r => {
    if (r && r.ok && r.kind === 'image') openViewer(r.url, r.name);
    else window.tcflow.liveOpenPath(path).catch(() => { });
  }).catch(() => { });
}

function closeEditor() {
  editingId = '';
  window.__undoneForEdit = false;
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
const flow = () => (doc ? { id: (doc.conv && doc.conv.key) || doc.name || 'live', nodes: doc.cards, edges: (doc.edges || []).map(e => [e[0], e[1]]) } : null);
const modsOf = n => (n && Array.isArray(n.mods) ? n.mods : []);
const implOf = n => String((n && n.impl) || '').trim();
const nodeSig = n => JSON.stringify([n.kind, n.title, n.body, n.impl, modsOf(n).map(m => m.type + ':' + m.name), n.checks || [], n.x, n.y]);
function findDock() { return null; }                     // 实时窗口不接插槽（连线是解析出来的，不靠拖）
function saveStore() { persist(); }              // 拖动收尾：存位置
function openCard(n) { if (readOnly) { setStat('上面是只读参考，改动请到下面那张画布'); return; } openEditor(n.id); }   // 双击 / ⚙ 都进同一个面板
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
  clampScroll();
  lastZoom = zoom;
  const z = $('#zoom'); if (z) z.textContent = Math.round(zoom * 100) + '%';
}

// 存盘
function persist() {
  if (!doc || readOnly) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { window.tcflow.liveDocSave(doc).catch(() => {}); }, 400);
}

function detailOf(c) { return implOf(c) || c.body || ''; }
// 这颗药丸指向哪个文件（悬停预览用）；找不到就返回空，不显示预览
function bestPath(c, name, used) {
  const ms = modsOf(c);
  const exact = ms.find(m => m.name === name && m.path && !used.has(m.path));
  if (exact) return exact.path;
  const any = ms.find(m => m.path && !used.has(m.path));
  if (any) return any.path;
  const imp = implOf(c);
  return imp && imp.charAt(0) === '/' && !used.has(imp) ? imp : '';
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
  const anchor = switched ? null : anchorAtCenter();     // 先记住用户正在看的那张卡（切对话不锚，直接 fit）
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
  paintMedia();
  // 卡摆好之后：优先把用户正在看的那张卡钉在原处；没法锚（首次/切对话）才整体对准
  if (doc.cards.length) {
    if (restoreAnchor(anchor)) { fitted = true; }
    else if (!fitted || !viewHitsAnyNode()) {
      fitted = true;
      requestAnimationFrame(() => requestAnimationFrame(() => { try { fit(); } catch (e) {} }));
    } else {
      clampScroll();
    }
  }
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
  clampScroll();
}

// ---------- 视野：更新不跳、也不会被甩到空白处 ----------
// 画布是 12000×8000 的固定尺寸再叠 transform 缩放，滚动区不会跟着缩放变；
// 所以任何滚动/缩放之后都要把视野夹回「有卡的范围」，否则能一路滚进空白区、看起来像工作流丢了。
function contentBox() {
  const ns = [...canvas.querySelectorAll('#canvas .node')];
  if (!ns.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const el of ns) {
    const x = parseFloat(el.style.left) || 0, y = parseFloat(el.style.top) || 0;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + el.offsetWidth); y1 = Math.max(y1, y + el.offsetHeight);
  }
  return { x0, y0, x1, y1 };
}
function clampScroll(margin = 160) {
  const cb = contentBox();
  if (!cb || !wrap.clientWidth) return;
  const cw = wrap.clientWidth, ch = wrap.clientHeight;
  const L = cb.x0 * zoom, T = cb.y0 * zoom, R = cb.x1 * zoom, B = cb.y1 * zoom;
  // 视口内允许的滚动范围：内容底边不能高于上边缘、内容顶边不能低于下边缘（留 margin）
  // 边距按视口尺寸给到 45%：拖到极限时至少还有将近半屏是卡片，不会只剩一条缝
  const axis = (cur, lo, hi, view) => {
    const m = Math.max(160, view * 0.45);
    const a = Math.max(0, lo - view + m);
    const b = Math.max(a, hi - m);
    return Math.min(b, Math.max(a, cur));
  };
  wrap.scrollLeft = axis(wrap.scrollLeft, L, R, cw);
  wrap.scrollTop = axis(wrap.scrollTop, T, B, ch);
}
function viewHitsAnyNode() {
  return [...canvas.querySelectorAll('#canvas .node')].some(el => {
    const r = el.getBoundingClientRect();
    return r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  });
}
// 更新前记下「离视野中心最近的那张卡」在屏幕上的位置；更新后把它放回原处 —— 新卡长出来时画面不跳
function anchorAtCenter() {
  let best = null, bd = Infinity;
  for (const el of canvas.querySelectorAll('#canvas .node')) {
    const r = el.getBoundingClientRect();
    if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
    const d = Math.hypot((r.left + r.right) / 2 - innerWidth / 2, (r.top + r.bottom) / 2 - innerHeight / 2);
    if (d < bd) { bd = d; best = { id: el.dataset.id, left: r.left, top: r.top }; }
  }
  return best;
}
function restoreAnchor(a) {
  if (!a) return false;
  const el = canvas.querySelector(`.node[data-id="${CSS.escape(a.id)}"]`);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  wrap.scrollLeft += r.left - a.left;
  wrap.scrollTop += r.top - a.top;
  clampScroll();
  return true;
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
    clampScroll();
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

  // 撤销 / 重做 / 保存
  const bu = document.getElementById('lundo'), br = document.getElementById('lredo'), bs = document.getElementById('lsave');
  if (bu) bu.onclick = undo;
  if (br) br.onclick = redo;
  if (bs) bs.onclick = saveNow;
  paintHist();

  // 面板里一动手就先记一版（一次编辑会话只记一次）
  const lb = document.getElementById('ledBody');
  if (lb) lb.addEventListener('focusin', () => {
    if (editingId && !window.__undoneForEdit) { pushUndo(); window.__undoneForEdit = true; }
  });

  // 鼠标改东西（拖动卡、拖边）也进撤销栈：按下时记一版，松手发现变了才入栈
  addEventListener('pointerdown', ev => {
    if (!doc) return;
    if (ev.target.closest && (ev.target.closest('#canvas .node') || ev.target.closest('#lxExtra'))) window.__pendSnap = snapOf();
  }, true);
  addEventListener('pointerup', () => {
    const before = window.__pendSnap;
    window.__pendSnap = '';
    if (!before || !doc) return;
    if (snapOf() !== before) { undoStack.push(before); if (undoStack.length > HIST_MAX) undoStack.shift(); redoStack.length = 0; paintHist(); }
  }, true);

  // 通用快捷键
  addEventListener('keydown', ev => {
    const t = ev.target || {};
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '') || t.isContentEditable;
    const meta = ev.metaKey || ev.ctrlKey;
    if (readOnly && (ev.key === 'Delete' || ev.key === 'Backspace')) return;
    if (readOnly && meta) return;
    const k = String(ev.key || '').toLowerCase();
    if (meta && k === 'z') { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); return; }
    if (meta && k === 'y') { ev.preventDefault(); redo(); return; }
    if (meta && k === 's') { ev.preventDefault(); saveNow(); return; }
    if (ev.key === 'Escape') { if (editingId) closeEditor(); else { selId = null; markSel(); } return; }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && !inField) {
      const selRow = document.querySelector('#lxExtra .lxrow.sel');
      if (selRow && selRow.dataset.type) { ev.preventDefault(); delMod(selRow.dataset.card, selRow.dataset.type, selRow.dataset.name); return; }
      if (selId) { ev.preventDefault(); delCard(selId); }
    }
  });
}

function setReadOnly(v) {
  readOnly = !!v;
  document.body.classList.toggle('ro', readOnly);
  canvas.classList.toggle('ro', readOnly);
  const btn = document.getElementById('lconfirm');
  if (btn) {
    btn.disabled = readOnly;
    btn.textContent = readOnly ? '已确定 · 上方只读' : '确定工作流';
  }
  if (readOnly) { closeEditor(); setStat('上面是只读参考，下面那张画布可以改'); }
}

function confirmFlow() {
  if (readOnly) return;
  if (!doc || !doc.cards || !doc.cards.length) { setStat('还没有解析出链路，先点「解析链路」'); return; }
  const btn = document.getElementById('lconfirm');
  if (btn) { btn.disabled = true; btn.textContent = '确定中…'; }
  const copy = JSON.parse(JSON.stringify(doc));
  window.tcflow.liveConfirm({ doc: copy, name: doc.name }).then(r => {
    if (r && r.ok) { setStat('已复制成一条可编辑的工作流：下面改，上面只读'); }
    else {
      if (btn) { btn.disabled = false; btn.textContent = '确定工作流'; }
      setStat('没确定成：' + ((r && r.error) || '未知原因'));
    }
  }).catch(() => {
    if (btn) { btn.disabled = false; btn.textContent = '确定工作流'; }
    setStat('没确定成：连不上主窗口');
  });
}

async function init() {
  bindCanvas();
  const cf = document.getElementById('lconfirm');
  if (cf) cf.onclick = confirmFlow;
  if (window.tcflow.onLiveReadonly) window.tcflow.onLiveReadonly(v => setReadOnly(v));
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
// 自测钩子：只有网址带 #selftest 时才挂（正常使用没有副作用），方便用 CDP 灌假 doc 验证视野不跳
if (location.hash === '#selftest') {
  window.__lc = {
    renderDoc, fit, clampScroll, contentBox, anchorAtCenter, restoreAnchor,
    get zoom() { return zoom; }, get doc() { return doc; },
    scroll() { return { left: wrap.scrollLeft, top: wrap.scrollTop, w: wrap.clientWidth, h: wrap.clientHeight }; }
  };
}
init();
