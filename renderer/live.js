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

// 双击卡片：右边滑出和主画布一样的卡片信息（名字 / 类型 / 内容 / 模块 / 内部实现）。
// 改一个字就更新这份解析结果（400ms 后写盘），不用按保存。
const KIND_OPTS = [['in', '输入'], ['proc', '加工'], ['out', '输出']];
const KIND_MOD_LAB = { in: '素材', proc: '工具', out: '成果' };
let editingId = '', saveTimer = 0;
const $id = x => document.getElementById(x);

function openEditor(id) {
  const card = (doc && doc.cards || []).find(c => c.id === id);
  if (!card || !$id('ledit')) return;
  editingId = id;
  $id('ledTitle').textContent = (KIND_LABEL[card.kind] || '加工') + '卡 · ' + card.title;
  $id('ledName').value = card.title || '';
  $id('ledKind').innerHTML = KIND_OPTS.map(([v, l]) => `<option value="${v}"${v === card.kind ? ' selected' : ''}>${l}</option>`).join('');
  $id('ledGroup').className = 'pgroup ' + card.kind;
  $id('ledLab').textContent = (KIND_LABEL[card.kind] || '加工') + '内容';
  $id('ledBody').value = card.body || '';
  $id('ledModLab').textContent = KIND_MOD_LAB[card.kind] || '模块';
  $id('ledMods').innerHTML = (card.mods || []).map((m, i) =>
    `<span class="mod t-${m.type} ed"><span class="mn" contenteditable="plaintext-only" spellcheck="false" data-i="${i}">${esc(m.name)}</span>` +
    `<b class="mx" data-x="${i}" title="删掉这块">✕</b></span>`).join('') +
    `<input id="ledModAdd" class="pm-add" placeholder="+ ${KIND_MOD_LAB[card.kind] || '模块'}（回车添加）">`;
  $id('ledPaths').innerHTML = (card.mods || []).map((m, i) =>
    `<div class="prow"><input class="pn" data-pi="${i}" data-k="name" value="${esc(m.name || '')}">` +
    `<input class="pp" data-pi="${i}" data-k="path" value="${esc(m.path || '')}" placeholder="文件路径（可留空）"></div>`).join('')
    || '<div class="lmlab">这张卡没有模块</div>';
  $id('ledImpl').value = card.impl || '';
  $id('ledit').classList.add('on');
  $id('ledName').focus();
  wireEditor(card);
}

// 改完 400ms 落盘；画布跟着立刻变
function touch(card, rerender) {
  if (rerender) renderDoc(doc, { analyzed: true });
  setStat(`已保存：${(doc.cards || []).length} 张卡（改过）`);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { window.tcflow.liveDocSave(doc).catch(() => {}); }, 400);
}
function wireEditor(card) {
  $id('ledName').oninput = e => { card.title = e.target.value.slice(0, 24); touch(card, true); $id('ledTitle').textContent = (KIND_LABEL[card.kind] || '加工') + '卡 · ' + card.title; };
  $id('ledKind').onchange = e => {
    card.kind = e.target.value;
    card.mods = (card.mods || []).map(m => ({ ...m, type: { in: 'mat', proc: 'tool', out: 'res' }[card.kind] }));
    openEditor(card.id); touch(card, true);
  };
  $id('ledBody').oninput = e => { card.body = e.target.value.slice(0, 260); touch(card, false); };
  $id('ledImpl').oninput = e => { card.impl = e.target.value.slice(0, 600); touch(card, false); };
  $id('ledMods').querySelectorAll('.mn').forEach(sp => {
    sp.oninput = () => { const m = card.mods[Number(sp.dataset.i)]; if (m) { m.name = sp.textContent.trim().slice(0, 16); touch(card, true); } };
  });
  $id('ledMods').querySelectorAll('.mx').forEach(x => x.onclick = () => {
    card.mods.splice(Number(x.dataset.x), 1); openEditor(card.id); touch(card, true);
  });
  const add = $id('ledModAdd');
  if (add) add.onkeydown = e => {
    if (e.key !== 'Enter') return;
    const name = add.value.trim().slice(0, 16);
    if (!name) return;
    card.mods = card.mods || [];
    card.mods.push({ type: { in: 'mat', proc: 'tool', out: 'res' }[card.kind], name });
    openEditor(card.id); touch(card, true);
  };
  $id('ledPaths').querySelectorAll('input').forEach(inp => {
    inp.oninput = () => {
      const m = card.mods[Number(inp.dataset.pi)];
      if (!m) return;
      if (inp.dataset.k === 'name') m.name = inp.value.slice(0, 16);
      if (inp.dataset.k === 'path') m.path = inp.value.trim();
      touch(card, true);
    };
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

// 加工卡和主画布一样是「三段」：素材（哪张上游卡喂进来的）/ 工具（自己怎么做）/ 成果（交出去的是什么）。
// 只读窗口不能拖插槽，但「用什么 → 出来什么」必须看得见。
// 悬停要能看到「具体的输入/产出」：chip 的 title 里写清 它是什么、来自哪张卡、卡里记的素材明细。
// 明细优先取那张卡自己的内部实现（里面是真路径/真参数），没有就用正文第一句。
function detailOf(card) {
  if (!card) return '';
  const lines = String(card.impl || '').split('\n').map(x => x.trim()).filter(Boolean)
    .filter(x => !/^证据[:：]/.test(x));
  const pick = lines.find(x => /[/\\.]|字节|像素|尺寸|版本|张|份/.test(x)) || lines[0] || '';
  return (pick || String(card.body || '')).slice(0, 160);
}
// 从这张卡记的内部实现/正文里认出真文件：只认**绝对路径**（/Users、/Applications、/Volumes…），
// 相对路径和「a/b/c.png」这种片段不算——否则会把 sketch-board-v1/v2/v3.png 当成 /v2/v3.png。
const ABS_RE = /\/(?:Users|Applications|Volumes|tmp|private|opt|home)\/[^\s"'`；;，,（）()<>|]*?\.(?:png|jpe?g|webp|gif|bmp|svg|mp4|mov|webm|md|markdown|txt|json|jsonl|csv|ya?ml|pdf)/gi;
const baseOf = p => String(p || '').split('/').pop();
function pathsOf(card) {                     // 这张卡上记着的真文件（绝对路径、去重、保持出现顺序）
  const s = String(card && card.impl || '') + '\n' + String(card && card.body || '');
  const out = []; let m;
  ABS_RE.lastIndex = 0;
  while ((m = ABS_RE.exec(s))) out.push(m[0]);
  ABS_RE.lastIndex = 0;
  return [...new Set(out)];
}
// 一张卡里常有好几份素材/成果：每个 chip 要对应到**它自己那一份**，不能都指到第一张。
// 认法：chip 名对上文件名/文件名词 → 得高分；卡内那句话里出现过这个名字 → 加分；
// 分数一样就按顺序各取一份（同一行里已经用过的先跳过）。
function scorePath(path, name, text) {
  const base = baseOf(path);
  const stem = base.replace(/\.[^.]+$/, '');
  let score = 0;
  if (name && (name.includes(stem) || stem.includes(name) || name.includes(base))) score += 8;
  const chars = [...stem].filter(c => /[\u4e00-\u9fa5A-Za-z0-9]/.test(c));
  score += Math.min(chars.length, chars.filter(c => name && name.includes(c)).length) * 0.6;
  if (text && base && text.includes(base)) score += 2;
  if (text && stem && text.includes(stem)) score += 1;
  // 反义词撞车要扣分：「下落前线稿」不能配到「线稿-下落后.png」
  const pairs = [['前', '后'], ['上', '下'], ['装配', '落'], ['左', '右'], ['素描', '线稿'], ['草图', '线稿']];
  for (const [x, y] of pairs) {
    if (name && name.includes(x) && stem.includes(y) && !stem.includes(x)) score -= 4;
    if (name && name.includes(y) && stem.includes(x) && !stem.includes(y)) score -= 4;
  }
  return score;
}
function bestPath(card, name, used) {
  const ps = pathsOf(card);
  if (!ps.length) return '';
  const text = String(card && card.body || '') + '\n' + String(card && card.impl || '');
  const pool = ps.filter(x => !used || !used.has(x));
  const list = pool.length ? pool : ps;
  let best = '', bestScore = -1;
  for (const p2 of list) {
    const sc = scorePath(p2, String(name || ''), text);
    if (sc > bestScore) { bestScore = sc; best = p2; }
  }
  return best;
}

function socketRows(c, d) {
  const cards = (d && d.cards) || [];
  const byId = new Map(cards.map(x => [x.id, x]));
  const ups = ((d && d.edges) || []).filter(e => e[1] === c.id).map(e => byId.get(e[0])).filter(Boolean);
  const downs = ((d && d.edges) || []).filter(e => e[0] === c.id).map(e => byId.get(e[1])).filter(Boolean);
  const chips = (list, fallback) => list.flatMap(src =>
    (src.mods && src.mods.length) ? src.mods.map(m => ({ name: m.name, t: m.type, src, mod: m })) : [{ name: src.title, t: fallback, src, mod: null }]
  ).filter(x => x.name).slice(0, 6);
  const assign = pairs => {                      // 同一行里每个 chip 各拿一份，尽量不重复
    const used = new Set();
    return pairs.map(({ name, t, src, mod }) => {
      const path = (mod && mod.path) || (src ? bestPath(src, name, used) : '');   // 人改过的文件优先
      if (mod && !mod.path && path) mod.path = path;
      if (path) used.add(path);
      return { name, t, src, path };
    });
  };
  const line = (lab, list, ph) => `<div class="mline"><span class="mlab">${lab}</span><span class="mchips"${list.length ? '' : ` data-ph="${ph}"`}>` +
    (list.length ? list.map(m => {
      const src = m.src;
      const tipTxt = src ? `${m.name}\n来自「${src.title}」\n${detailOf(src)}` : m.name;
      const fp = m.path || '';
      return `<span class="mod t-${m.t}" data-tip="${esc(tipTxt)}"${fp ? ` data-path="${esc(fp)}"` : ''} title="${esc(tipTxt)}">${esc(m.name)}</span>`;
    }).join('') : '') + '</span></div>';
  if (c.kind !== 'proc') {
    const ms = assign((c.mods || []).map(m => ({ name: m.name, t: m.type, src: c })));
    if (!ms.length) return '';
    return `<div class="mods">${line(MOD_LAB[c.kind] || '模块', ms, '')}</div>`;
  }
  return `<div class="mods">${line('素材', assign(chips(ups, 'mat')), '没接到素材')}` +
    `${line('工具', (c.mods || []).map(m => ({ name: m.name, t: m.type })), '没写怎么做')}` +
    `${line('成果', assign(chips(downs, 'res')), '没有产出')}</div>`;
}

function cardEl(c, d) {
  const el = document.createElement('div');
  el.className = 'node k-' + c.kind;
  el.dataset.id = c.id;
  el.innerHTML = `
    <div class="hd"><span class="kind">${KIND_LABEL[c.kind] || '加工'}</span><div class="t">${esc(c.title)}</div><div class="st"></div></div>
    <div class="body" data-ph="${KIND_PH[c.kind] || ''}">${esc(c.body)}</div>
    ${socketRows(c, d)}
    <div class="ft"><div class="checks"></div>${c.impl ? '<span class="gar" title="内部实现已封装：卡片上不显示，点开看">⚙</span>' : ''}</div>
    ${c.impl ? `<details class="limpl"><summary>⚙ 内部实现</summary><pre>${esc(c.impl)}</pre></details>` : ''}`;
  const det = el.querySelector('details.limpl');
  if (det) det.addEventListener('toggle', () => { layout(); drawEdges(); });
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
    if (!old) { const el = cardEl(c, d); el.dataset.sig = sig; canvas.appendChild(el); continue; }
    if (old.dataset.sig !== sig) { const el = cardEl(c, d); el.dataset.sig = sig; old.replaceWith(el); }
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
      // 人拖过就按人摆的位置，不再参与自动成列
      const card = byId.get(id);
      if (card && Number.isFinite(card.x) && Number.isFinite(card.y)) {
        el.style.left = (card.x + OX) + 'px';
        el.style.top = (card.y + OY) + 'px';
        pos.set(id, { x: card.x + OX, y: card.y + OY, w: el.offsetWidth || 244, h });
        continue;
      }
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
  $('#lana').onclick = () => analyzeNow(true);
  // 按住卡片拖动：位置写进这份解析结果；空白处拖动仍然是平移画板
  let drag = null;
  canvas.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
    if (ev.target.closest('details') || ev.target.closest('.mod')) return;
    const el = ev.target.closest('.node');
    if (!el) return;
    const id = el.dataset.id;
    const p0 = pos.get(id);
    if (!p0) return;
    const wr = wrap.getBoundingClientRect();
    drag = { el, id, moved: false, sx: ev.clientX, sy: ev.clientY,
      dx: (ev.clientX - wr.left + wrap.scrollLeft) / zoom - p0.x,
      dy: (ev.clientY - wr.top + wrap.scrollTop) / zoom - p0.y };
    // 不要在 pointerdown 上 preventDefault：那会把随后的 click/dblclick 一起吃掉（双击就打不开了）
  });
  canvas.addEventListener('pointermove', ev => {
    if (!drag) return;
    if (!drag.moved) {                       // 动过 3px 才算拖，否则让双击照常发生
      if (Math.abs(ev.clientX - drag.sx) < 3 && Math.abs(ev.clientY - drag.sy) < 3) return;
      drag.moved = true;
      drag.el.classList.add('dragging');
    }
    const wr = wrap.getBoundingClientRect();
    const x = (ev.clientX - wr.left + wrap.scrollLeft) / zoom - drag.dx;
    const y = (ev.clientY - wr.top + wrap.scrollTop) / zoom - drag.dy;
    drag.el.style.left = (x + OX) + 'px';
    drag.el.style.top = (y + OY) + 'px';
    const p1 = pos.get(drag.id);
    if (p1) { p1.x = x + OX; p1.y = y + OY; }
    drawEdges();
  });
  const drop = async () => {
    if (!drag) return;
    const wasMoved = drag.moved;
    const { el, id } = drag;
    el.classList.remove('dragging');
    if (!wasMoved) { drag = null; return; }        // 只是点了一下：不存位置
    const p1 = pos.get(id);
    const card = (doc && doc.cards || []).find(c => c.id === id);
    if (card && p1) { card.x = Math.round(p1.x - OX); card.y = Math.round(p1.y - OY); }
    drag = null;
    layout(); drawEdges();
    if (card) { try { await window.tcflow.liveDocSave(doc); } catch (e) { } }
  };
  canvas.addEventListener('pointerup', drop);
  canvas.addEventListener('pointercancel', drop);
  const box = document.getElementById('ledit');
  if (box) {
    document.getElementById('ledClose').onclick = closeEditor;
    box.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeEditor(); });
    canvas.addEventListener('dblclick', ev => {
      const n = ev.target.closest && ev.target.closest('.node');
      if (n && n.dataset.id) { ev.preventDefault(); openEditor(n.dataset.id); }
    });
  }   // 常驻在这里，别塞进 follow()（不然不拨开关就点不动）
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
  else {
    if (st.on) $('#lfol').checked = true;
    if (cur) await hydrate(cur);                      // 跟随关着也把上次保存的解析结果摆上来
  }
}
init();
