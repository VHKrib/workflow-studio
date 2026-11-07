// 对话 → 链路卡：把一条 Hermes 对话里真实发生的事，归并成画布上的输入 / 加工 / 输出卡。
//
// 纯函数，不联网、不读库、不写任何东西——喂进来的只是一条条消息（livefeed.js 只读读出来的）。
// 形状和画布的状态文件一致（卡片 / 连线 / 内部实现 / 模块），独立窗口直接照着画。
//
// 规矩（改这块要守住，验收会逐条查）：
// - 一条消息 ≠ 一张卡：连续同类动作合并成一张（连读 10 个文件 = 1 张「读资料」，计数往上走）；
// - 同一张卡就地更新（count / impl / body 一起变），不新建；
// - 卡片正面只说人话：命令、绝对路径、JSON、字段名一律进 impl；
// - 重复同一句话（对着模型刷同一句）不刷卡片：并回同一张输入卡、同一张回答卡。
'use strict';

const MAX_CARDS = 60;        // 一条直播最多 60 张卡；再多就并进最后一张（计数继续涨），不无限长
const MAX_IMPL_LINES = 40;   // 内部实现最多记 40 条调用（再多的只加计数）
const IMPL_SHOW = 6;         // 卡片「内部实现」里露 6 条 + 「共 N 次」
const BODY_CHARS = 150;      // 卡片正文最多 150 字

// 工具 → 干什么（人话短词）。kind=out 的工具算「交付物」，落成输出卡。
const TOOLS = {
  read_file:   { cat: 'read',    word: '读文件' },
  file_read:   { cat: 'read',    word: '读文件' },
  search_files:{ cat: 'read',    word: '找文件' },
  grep:        { cat: 'read',    word: '找内容' },
  terminal:    { cat: 'cmd',     word: '终端' },
  execute_code:{ cat: 'cmd',     word: '跑代码' },
  process:     { cat: 'cmd',     word: '跑进程' },
  web_search:  { cat: 'web',     word: '搜网页' },
  web_extract: { cat: 'web',     word: '读网页' },
  web_fetch:   { cat: 'web',     word: '读网页' },
  browser:     { cat: 'web',     word: '开浏览器' },
  skill_view:  { cat: 'skill',   word: '看技能' },
  skill_list:  { cat: 'skill',   word: '看技能' },
  skill_manage:{ cat: 'skill',   word: '改技能' },
  write_file:  { cat: 'write',   word: '写文件', kind: 'out' },
  patch:       { cat: 'write',   word: '改文件', kind: 'out' },
  edit_file:   { cat: 'write',   word: '改文件', kind: 'out' },
  apply_patch: { cat: 'write',   word: '改文件', kind: 'out' },
  message_agent:{ cat: 'handoff', word: '派活',  kind: 'out' },
  delegate_task:{ cat: 'handoff', word: '派活', kind: 'out' },
  spawn_agent: { cat: 'handoff', word: '派活',  kind: 'out' },
  kanban_create:{ cat: 'handoff', word: '派活', kind: 'out' },
  session_search:{ cat: 'lookup', word: '查记录' },
  tool_describe:{ cat: 'lookup', word: '看工具说明' },
  tool_search: { cat: 'lookup', word: '找工具' },
  memory:      { cat: 'lookup',  word: '记一笔' },
  vision_analyze:{ cat: 'lookup', word: '看图' },
  clarify:     { cat: 'lookup',  word: '问一句' },
  computer_use:{ cat: 'cmd',     word: '操作屏幕' },
  cronjob:     { cat: 'cmd',     word: '排定时' },
  image_gen:   { cat: 'web',     word: '生成图',   kind: 'out' },
  video_gen:   { cat: 'web',     word: '生成视频', kind: 'out' },
  a2a:         { cat: 'handoff', word: '联络岗位', kind: 'out' },
  kanban_comment:{ cat: 'handoff', word: '回话',   kind: 'out' },
  kanban_complete:{ cat: 'handoff', word: '交活',  kind: 'out' },
  kanban_request_review:{ cat: 'handoff', word: '送审', kind: 'out' },
};
// 这些不算「做了什么」，不落卡（记账 / 计划，纯噪音）
const SKIP = new Set(['todo_list', 'todo_read', 'todo_write', 'todo_update']);

// 寒暄 / 应声 / 闲聊：跟链路无关，不上画布（「你好」不该长出一张输入卡）
const CHATTER = /^(你好|您好|hi|hello|hey|在吗|在不在|谢谢|多谢|辛苦|好的|好|收到|ok|okay|嗯|嗯嗯|对|是的|算了|不用了|先这样|继续|哈哈|早|晚安)[\s！!。.，,～~…·]*$/i;
function isChatter(text, pics) {
  if (pics && pics.length) return false;
  const t = oneLine(text);
  if (!t) return true;
  if (t.length <= 12 && CHATTER.test(t)) return true;
  // 短到没有动词、没有名词的纯语气词
  if (t.length <= 4 && !/[\u4e00-\u9fa5]{2}/.test(t.replace(CHATTER, ''))) return true;
  return false;
}

// 三类实体：这条链路真正反复用到的东西。
// 素材 = 图片 / 文件 / 货号 / 画板分镜；实现路径 = 技能 / 脚本 / 工具；结果 = 写出的文件 / 出片交付。
const E_FILE = /(?<![\w.\/-])([\w\u4e00-\u9fa5-][\w\u4e00-\u9fa5.\-]*\.(?:png|jpe?g|webp|gif|mp4|mov|json|jsonl|js|mjs|sh|py|md|csv|xlsx|ya?ml|pdf))(?!\w)/gi;
const E_OFFER = /(?<![\d.])(\d{11,20})(?!\d)/g;
const E_MATWORD = /(原图|白底图|主图|详情图|参考图|画板|分镜|货号|商品图)/g;   // 只说「素材」两个字不算实体
const E_SCRIPT = /(?<![\w.\/-])([\w\-]+\.(?:js|mjs|sh|py))(?!\w)/gi;
const E_OUTWORD = /(出片|生成|渲染|导出|交付|产出|打包|成片)/g;

const bump = (m, name, at) => {
  const k = String(name || '').trim();
  if (!k || k.length > 60) return;
  const e = m.get(k) || { name: k, n: 0, first: at, last: at };
  e.n++; e.last = at;
  m.set(k, e);
};
const topEnt = (m, n) => [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, n);

// 扫一段文字/一次调用，把三类实体记进 feed.ent（同名只涨计数，画布上显示「×N」）
// 分类规矩：图片/数据文档 → 素材；代码脚本 → 实现路径；写出的产物 → 结果
const CODE_EXT = /\.(?:js|mjs|cjs|ts|sh|py|rb|go|java|css|html?)$/i;
function scanEntities(feed, text, at) {
  const t = String(text || '');
  if (!t) return;
  for (const m of t.matchAll(E_FILE)) {
    const name = m[1];
    if (CODE_EXT.test(name)) bump(feed.ent.path, name, at);   // 代码文件算「怎么做的」，不是素材
    else bump(feed.ent.mat, name, at);
  }
  for (const m of t.matchAll(E_OFFER)) bump(feed.ent.mat, m[1], at);
  for (const m of t.matchAll(E_MATWORD)) bump(feed.ent.mat, m[1], at);
  for (const m of t.matchAll(E_SCRIPT)) bump(feed.ent.path, m[1], at);
  for (const m of t.matchAll(E_OUTWORD)) bump(feed.ent.out, m[1], at);
}

const CAT = {
  doing:   { title: '正在做', unit: '步',     verb: '正在做' },
  read:    { title: '读资料', unit: '份资料', verb: '读了' },
  cmd:     { title: '跑命令', unit: '条命令', verb: '跑了' },
  web:     { title: '查网页', unit: '次',     verb: '上网查了' },
  skill:   { title: '看技能', unit: '个技能说明', verb: '翻看了' },
  write:   { title: '写文件', unit: '个文件', verb: '写好了', kind: 'out' },
  handoff: { title: '派活',   unit: '次活',   verb: '把活交出去了' },
  lookup:  { title: '查记录', unit: '次',     verb: '翻了记录' },
  other:   { title: '用工具', unit: '次',     verb: '用工具做了' },
};

// 派活原文里万一贴过密钥：读出来先抹掉（和 chain.js 同一套口径，写法和扫描脚本错开）
const redact = s => String(s == null ? '' : s)
  .replace(/\b(s[k]-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, '[已隐去]')
  .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, '$1[已隐去]')
  .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)["']?[^\s"',;]{8,}/gi, '$1[已隐去]');

const oneLine = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// 人话化：去掉代码块 / 行内代码 / 链接 / 命令样式，只留能读的句子
function polish(text) {
  let t = String(text == null ? '' : text);
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(/`[^`\n]*`/g, ' ');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/https?:\/\/\S+/g, ' ');
  t = t.replace(/(?:^|\s)(?:~\/|\/)[\w./<>*-]{2,}/g, ' ');          // 绝对路径
  t = t.replace(/(?:^|\s)--[a-z][\w-]*/g, ' ');                      // 命令行开关
  // 相对路径 / 目录串：input/images/(sku)/main-01.03.jpg、evidence/_INDEX.json、a/b/c
  // 只剥「含 ASCII 的」，中文的「读/写」「输入/输出」不动
  t = t.replace(/[A-Za-z0-9_.~-]*(?:\/[A-Za-z0-9_.~()\-\u4e00-\u9fa5]*)+/g, m => (/[A-Za-z0-9]/.test(m) ? ' ' : m));
  t = t.replace(/\b[\w-]+\.(?:json|jsonl|js|mjs|ts|py|sh|md|csv|ya?ml|xlsx|png|jpe?g|gif|webp|zip|log|txt|sqlite|db|html|css|ipynb)\b/gi, ' ');  // 光秃秃的文件名
  t = t.replace(/\b[\x21-\x7e]+(?:[\/\\][\x21-\x7e]+)+\b/g, ' ');     // 英文标识串（a/b/c 这种像路径的东西）
  t = t.replace(/^\s*#{1,6}\s*/gm, '').replace(/(^|\s)#{1,6}\s+/g, '$1').replace(/\*\*/g, '').replace(/^\s*[-*·]\s+/gm, '');
  t = t.replace(/\s+([，。；：、！？）」》])/g, '$1').replace(/([（「《])\s+/g, '$1');
  return oneLine(t);
}
// 回答的正文：表格行（一眼就是数据表）和英文标识串不进正面
function answerBody(text) {
  const raw = String(text == null ? '' : text).split(/\r?\n/).filter(l => (l.match(/\|/g) || []).length < 2).join('\n');
  return clip(oneLine(polish(raw)), BODY_CHARS);
}
const looksTech = s => /(`|\/[\w.<>-]+\/|(?:^|\s)--[a-z]|\{["']|\b[\w-]+\.(?:json|jsonl|js|ts|py|sh|md|csv|ya?ml)\b)/.test(String(s || ''));

// 用户原话：先剥掉系统壳（[IMPORTANT: …] / [Cronjob …] / 「Message from X (@y): 」/ 带外消息包装 / 网关头），
// 剩下的才是人说的话。图片附件单独记下来（正面说「发来 N 张图」，路径进内部实现）。
function cleanAsk(text) {
  const raw = String(text == null ? '' : text);
  let t = raw;
  const images = (t.match(/\[Image attached at:[^\]]*\]/g) || []).map(s => s.replace(/^\[Image attached at:\s*|\]$/g, '').trim()).filter(Boolean);
  const shots = (t.match(/\[screenshot\]/gi) || []).length;
  t = t.replace(/\[Image attached at:[^\]]*\]/g, ' ')
    .replace(/\[screenshot\]/gi, ' ')
    .replace(/\[OUT-OF-BAND USER MESSAGE[^\]]*\]/gi, ' ')          // 带外消息：包装剥掉，里面的话留着
    .replace(/\[\/OUT-OF-BAND USER MESSAGE\]/gi, ' ')
    .replace(/^Gateway message origin[^\n]*\n?/im, ' ')            // 网关消息头（JSON，不是人话）
    .replace(/^\s*\[[A-Z][^\]]{0,140}\]\s*/g, ' ')                 // 一行一个方括号系统标记
    .replace(/^\s*\[(?:IMPORTANT|Cronjob|System)[\s\S]*?\]\s*/i, ' ')
    .replace(/^\s*Message from [^:\n]{0,120}:\s*/i, '')             // 「Message from 某岗位 (@x): 正文」
    .replace(/^#{0,6}\s*Kanban task\s+\w+:\s*/im, '')               // 看板卡标题行：留下任务标题
    .replace(/^\s*(?:Assignee|Status|Workspace|Max runtime|Terminal timeout|Depends on|Priority|Created by|Reviewer)\s*:[^\n]*\n?/gim, '')
    .replace(/^\s*New note on your kanban task[\s\S]*$/i, ' ')      // 看板备注通知：不是人说的话
    .replace(/^\s*You've reached the (?:maximum|limit)[\s\S]*$/i, ' ');
  t = t.trim();
  // 还是系统壳（整段 JSON / 网关提示 / 预加载的技能正文）就别当成人说的话
  if (/^[[{]/.test(t) || /not instructions or authorization/i.test(t)) t = '';
  if (/^---\s*\n(?:name|description)\s*:/i.test(t) || /skill preloaded/i.test(t) || /This skill has supporting files/i.test(t)) t = '';
  if (/^\[IMPORTANT: The user launched this CLI session/i.test(t)) t = '';
  // 系统通知（后台进程退出 / 孤儿恢复 / 内部通知）不是人说的话：整条丢掉，别在链路图上冒一张输入卡
  if (/^\[IMPORTANT[:\s]/i.test(raw) || /^\[Orphan recovery/i.test(raw) || /^Background process /i.test(raw)
    || /INTERNAL NOTIFICATION/i.test(raw) || /not written by a human user/i.test(raw)) t = '';
  return { text: t, images: images.concat(Array(shots).fill('[截图]')) };
}

// 一句话拆成「人话」+「技术」：技术句子进 impl，人话留在正面；拆不开就原样当人话（不硬改）
function splitAsk(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { body: '', impl: '' };
  const parts = raw.split(/(?<=[。；;！!？?\n])/).map(s => s.trim()).filter(Boolean);
  const human = [], tech = [];
  for (const p of parts) (looksTech(p) && polish(p).length < 24 ? tech : human).push(p);
  const body = clip(polish(human.join(' ')), BODY_CHARS);
  if (body.length >= 6) return { body, impl: tech.join('\n') };
  // 拆不出人话（整句都是技术）：正面给剥干净的那句，原话照样进内部实现，信息不能丢
  return { body: clip(polish(raw), BODY_CHARS), impl: (tech.length ? tech.join('\n') : (looksTech(raw) ? raw : '')) };
}

function shortTitle(body) {
  const t = oneLine(body).replace(/[。；;，,、：:！!？?].*$/, '');
  return clip(t || '这次要做的事', 16);
}

// 一次工具调用的「内部实现」一行：工具名 + 关键参数（命令 / 路径 / 查询 / 交给谁）
function implLine(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  const pick = (...keys) => { for (const k of keys) if (a[k] != null && a[k] !== '') return String(a[k]); return ''; };
  let key = '';
  if (/^(read_file|file_read|write_file|patch|edit_file|apply_patch|search_files|grep)$/.test(name)) key = pick('path', 'pattern', 'query', 'file');
  else if (name === 'terminal' || name === 'execute_code') key = pick('command', 'code');
  else if (/^web_/.test(name) || name === 'browser') key = pick('query', 'url', 'urls');
  else if (/^skill_/.test(name)) key = pick('name', 'skill');
  else if (name === 'message_agent') key = pick('target', 'to', 'name');
  else if (name === 'delegate_task' || name === 'spawn_agent') key = pick('agent', 'profile', 'name', 'task');
  else key = pick('path', 'query', 'name', 'command', 'url');
  if (key === '' && Object.keys(a).length) { try { key = JSON.stringify(a); } catch (e) { key = ''; } }
  return clip(redact(name + (key ? ' ' + oneLine(key) : '')), 300);
}
const handoffTarget = args => {
  const a = args && typeof args === 'object' ? args : {};
  return oneLine(a.target || a.to || a.agent || a.profile || a.name || a.assignee || '');
};

const modOf = (kind, name) => ({ type: kind === 'in' ? 'mat' : kind === 'out' ? 'res' : 'tool', name: clip(name, 8) });

function createFeed(conv) {
  return {
    conv: conv || null,
    cards: [],            // {id, kind, title, body, impl[], cat, target, turn, n, err, mods[], at}
    edges: [],
    byId: new Map(),
    byCall: new Map(),    // 工具调用 id → 卡（工具结果回来时给那张卡记「报错」）
    lastGroup: null,      // 上一张卡（只有它同类才并）
    turn: null,           // 当前这句要求对应的输入卡 id
    lastInput: null,
    lastAnswer: null,
    lastId: 0,
    // 这句要求下的中间动作（读/搜/跑/查）：不上链路图，攒成一句人话 + 内部实现
    work: { turn: null, counts: {}, lines: [], calls: 0 },
    ent: { mat: new Map(), path: new Map(), out: new Map() },   // 素材 / 实现路径 / 生成结果（同名涨计数）
    doing: null,          // 这句要求的「正在做」卡：回答到了就地变成「回答」卡
    stats: { messages: 0, tools: 0, merged: 0, skipped: 0 },
    at: 0,
  };
}

// 中间动作的人话总结：「读了 3 份资料 · 跑了 2 条命令」
const WORK_WORD = {
  read: ['读了', '份资料'], search: ['翻了', '处文件'], cmd: ['跑了', '条命令'],
  web: ['查了', '个网页'], skill: ['看了', '个技能'], lookup: ['核了', '条记录'], other: ['用了', '次工具'],
};
function workText(feed) {
  const w = (feed && feed.work) || {};
  const counts = w.counts || {};
  const parts = [];
  for (const cat of ['read', 'search', 'cmd', 'web', 'skill', 'lookup', 'other']) {
    const n = counts[cat];
    if (!n) continue;
    const p = WORK_WORD[cat];
    parts.push(`${p[0]} ${n} ${p[1]}`);
  }
  if (w.err) parts.push(`其中 ${w.err} 次报错`);
  return parts.join(' · ');
}

// 这句要求下第一件中间动作出现时立一张「正在做」卡（人对自己的要求看进度，不看工具流水账）
function ensureDoing(feed) {
  if (feed.doing && feed.doing.turn === feed.turn && !feed.doing.done) return feed.doing;
  const card = pushCard(feed, {
    kind: 'proc', cat: 'doing', title: '正在做', turn: feed.turn, at: feed.at, text: '',
    mods: [modOf('proc', '进度')],
  });
  if (card) feed.doing = card;
  return card;
}

function pushCard(feed, c) {
  const prev = feed.cards[feed.cards.length - 1];
  // 链路主干（人的要求、回答、进度）任何时候都落卡，不受上限约束——否则「最终回答」会被上限吃掉
  const SPINE = c.cat === 'ask' || c.cat === 'answer' || c.cat === 'doing';
  if (feed.cards.length >= MAX_CARDS && !SPINE) {
    // 到顶了：**只并同类**（同类别、同接收人才并，计数往上走）；不同类绝不串味
    for (let i = feed.cards.length - 1; i >= 0; i--) {
      const x = feed.cards[i];
      if (x.cat === c.cat && (x.target || '') === (c.target || '')) {
        x.n = (x.n || 1) + (c.n || 1);
        x.folded = (x.folded || 0) + 1;
        x.at = feed.at || x.at;
        if (Array.isArray(x.impl) && Array.isArray(c.impl)) {
          for (const l of c.impl) if (x.impl.length < MAX_IMPL_LINES) x.impl.push(l);
        }
        syncCard(x);
        return x;
      }
    }
    // 没有同类可并：腾地方——先淘汰最早的「正在做」（进度卡是过渡的），没有就淘汰最早的回答；
    // 交付物（写文件/派活）必须能上图，不能让上限把它吃掉
    const old = feed.cards.find(x => x.cat === 'doing') || feed.cards.find(x => x.cat === 'answer');
    if (old) {
      dropCard(feed, old);
    } else {
      feed.stats.overflow = (feed.stats.overflow || 0) + 1;
      return null;
    }
  }
  const card = Object.assign({ id: 'c' + (feed.count = (feed.count || 0) + 1), kind: 'proc', impl: [], n: 1, err: 0, mods: [] }, c);
  feed.cards.push(card);
  feed.byId.set(card.id, card);
  if (prev) feed.edges.push([prev.id, card.id]);
  return card;
}

// 撤掉一张卡（连线接回去）：用在中途插话的「回答」上——它后面又冒出工具调用，说明那不是最终回答
function dropCard(feed, card) {
  const i = feed.cards.indexOf(card);
  if (i < 0) return;
  feed.cards.splice(i, 1);
  feed.byId.delete(card.id);
  const prev = feed.cards[i - 1], next = feed.cards[i];
  feed.edges = feed.edges.filter(([a, b]) => a !== card.id && b !== card.id);
  if (prev && next) feed.edges.push([prev.id, next.id]);
  if (feed.lastAnswer === card) feed.lastAnswer = null;
  if (feed.lastGroup === card) feed.lastGroup = feed.cards[feed.cards.length - 1] || null;
  if (feed.lastInput === card) feed.lastInput = null;
  feed.stats.dropped = (feed.stats.dropped || 0) + 1;
}

function bodyOf(card) {
  const cat = CAT[card.cat] || CAT.other;
  if (card.cat === 'ask') return clip(card.text || '', BODY_CHARS);       // 输入卡正文 = 人的原话（人话那部分）
  if (card.cat === 'doing') return clip(card.wtext || '正在做', BODY_CHARS);
  if (card.cat === 'handoff') {
    const to = card.target ? `「${card.target}」` : '下一个岗位';
    return card.n > 1 ? `把 ${card.n} 件事交给了${to}，等它回话` : `把这件事交给了${to}，等它回话`;
  }
  if (card.cat === 'answer') return clip(polish(card.text || ''), BODY_CHARS);
  if (card.cat === 'write') return card.n > 1 ? `写好了 ${card.n} 个文件` : '写好了 1 个文件';
  const n = card.n || 1;
  let s = `${cat.verb} ${n} ${cat.unit}`;
  if (card.err) s += `（其中 ${card.err} 次报错）`;
  return s;
}
function titleOf(card) {
  if (card.cat === 'handoff') return clip('派活' + (card.target ? '给' + card.target : ''), 16);
  return card.title || (CAT[card.cat] || CAT.other).title;
}

function syncCard(card) {
  card.body = bodyOf(card);
  card.head = titleOf(card);
  card.implText = card.impl.slice(0, IMPL_SHOW).join('\n') + (card.impl.length > IMPL_SHOW ? `\n…共 ${card.n} 次` : '');
}

function toolOf(name) {
  if (!name) return { cat: 'other', word: '工具' };
  if (TOOLS[name]) return TOOLS[name];
  // 未知工具按名字前缀猜一猜，猜不到就归「用工具」
  if (/^read/.test(name)) return TOOLS.read_file;
  if (/^(search|grep|find)/.test(name)) return TOOLS.search_files;
  if (/^(web|browser|http|fetch|api|request|call)/.test(name)) return TOOLS.web_fetch;
  if (/^(write|save)/.test(name)) return TOOLS.write_file;
  if (/^(edit|patch|update)/.test(name)) return TOOLS.patch;
  if (/(agent|task|handoff|kanban)/.test(name)) return TOOLS.delegate_task;
  const ascii = /^[\x20-\x7e]+$/.test(name);
  return { cat: 'other', word: ascii && name.length > 8 ? '工具' : clip(name, 6) };
}

// 一次工具调用可能是「外壳」：tool_call 会把 N 个真实调用包在 calls 里——拆开按真实工具记
function expandCalls(name, args, callId) {
  if ((name === 'tool_call' || name === 'tool_batch' || name === 'tool_call_batch') && args && Array.isArray(args.calls)) {
    return args.calls.map((c, i) => ({
      name: String((c && c.name) || ''),
      args: c && c.arguments && typeof c.arguments === 'object' ? c.arguments : {},
      callId: callId ? callId + ':' + i : '',
    })).filter(c => c.name);
  }
  return [{ name, args, callId }];
}

function applyToolCall(feed, name, args, callId) {
  feed.stats.tools++;
  // 待办/记账这类不算「做了什么」：不落卡、不计进「正在做」的人话总结
  if (SKIP.has(name)) { feed.stats.skipped++; return; }
  const t = toolOf(name);
  const target = t.cat === 'handoff' ? handoffTarget(args) : '';
  // 实体：技能名 → 实现路径；写出/改动的文件 → 结果；读的图片文件 → 素材
  const a = args || {};
  if (/^skill_/.test(name) && a.name) bump(feed.ent.path, a.name, feed.at);
  if (/^(write_file|patch|edit_file|apply_patch)$/.test(name) && a.path) {
    const base = String(a.path).split('/').pop();
    if (base) bump(feed.ent.out, base, feed.at);
  }
  if (/^(read_file|vision_analyze)$/.test(name) && a.path) {
    const base = String(a.path).split('/').pop();
    // 读代码文件算「怎么做的」，读图片/数据才算素材
    if (base) bump(CODE_EXT.test(base) ? feed.ent.path : feed.ent.mat, base, feed.at);
  }
  if (a.command) scanEntities(feed, a.command, feed.at);
  // 只有「交出去的东西」才算链路图上的输出（写好的文件 / 派出去的活）。
  // 读、搜、跑、查这类中间动作不上图：攒成一句人话（读了 N 份资料）+ 命令进「内部实现」。
  if (t.kind !== 'out') {
    const w = feed.work;
    if (w.turn !== feed.turn) { w.turn = feed.turn; w.counts = {}; w.lines = []; w.calls = 0; w.err = 0; }
    const cat = t.cat === 'handoff' ? 'other' : t.cat;
    w.counts[cat] = (w.counts[cat] || 0) + 1;
    w.calls++;
    if (w.lines.length < MAX_IMPL_LINES) w.lines.push(implLine(name, args));
    const card = ensureDoing(feed);
    if (card) {
      if (card.impl.length < MAX_IMPL_LINES) card.impl.push(implLine(name, args));
      card.n = w.calls;
      card.wtext = workText(feed);
      card.at = feed.at;
      syncCard(card);
      feed.lastGroup = card;
      if (callId) feed.byCall.set(callId, card);
    }
    return;
  }
  const kind = 'out';
  // 连续同类合并：同一次要求下、同一类、同一接收人的动作并成一张（计数往上走）。
  // 中间夹着命令/读文件也不拆——「写了 9 个文件」比 9 张一样的卡有用。
  let card = feed.lastGroup;
  if (!(card && card.cat === t.cat && card.target === target && card.turn === feed.turn)) {
    card = null;
    for (let i = feed.cards.length - 1; i >= 0; i--) {
      const x = feed.cards[i];
      if (x.cat === t.cat && (x.target || '') === target && x.turn === feed.turn) { card = x; break; }
    }
  }
  if (card) {
    card.n++;
    feed.stats.merged++;
  } else {
    card = pushCard(feed, {
      kind, cat: t.cat, title: (CAT[t.cat] || CAT.other).title, target,
      turn: feed.turn, at: feed.at, text: '',
      mods: [modOf(kind, t.word)],
    });
    feed.lastGroup = card;
  }
  if (!card) return;
  card.at = feed.at;
  if (card.impl.length < MAX_IMPL_LINES) card.impl.push(implLine(name, args));
  if (callId) feed.byCall.set(callId, card);
  if (target && !card.mods.some(m => m.name === target)) card.mods.push(modOf(kind, target));
  syncCard(card);
}

function applyMessage(feed, m) {
  feed.stats.messages++;
  if (m.at) feed.at = Math.max(feed.at, Number(m.at) || 0);
  if (m.role === 'user') {
    const ask0 = cleanAsk(m.text);
    const cut = splitAsk(ask0.text);
    const pics = ask0.images || [];
    if ((!cut.body || cut.body.length < 2) && !pics.length) { feed.stats.skipped++; return; }
    const body = cut.body && cut.body.length >= 2 ? cut.body : `发来 ${pics.length} 张图`;
    if (isChatter(body, pics)) { feed.stats.chatter = (feed.stats.chatter || 0) + 1; return; }   // 寒暄/应声不上画布
    // 同一句话重复发（模型没被处理、人连着刷）：并回同一张输入卡，不刷卡片
    if (feed.lastInput && feed.lastInput.body === body) {
      feed.lastInput.n++; feed.lastInput.at = feed.at;
      if (cut.impl && feed.lastInput.impl.length < MAX_IMPL_LINES) feed.lastInput.impl.push(cut.impl);
      feed.turn = feed.lastInput.id;
      feed.lastGroup = feed.lastInput;
      syncCard(feed.lastInput);
      feed.stats.merged++;
      return;
    }
    scanEntities(feed, m.text, feed.at);
    const impl = [];
    if (cut.impl) impl.push(cut.impl);
    for (const p of pics.slice(0, 6)) impl.push('附件：' + p);
    if (pics.length > 6) impl.push(`…还有 ${pics.length - 6} 张`);
    const card = pushCard(feed, {
      kind: 'in', cat: 'ask', title: pics.length && !cut.body ? '发来图' : shortTitle(body), body,
      impl, turn: null, at: feed.at, text: body,
      mods: [modOf('in', pics.length ? '图片' : '原话')],
    });
    if (!card) return;
    card.turn = card.id;
    feed.turn = card.id;
    feed.lastInput = card;
    feed.lastAnswer = null;
    feed.lastGroup = card;
    // 新的一句要求：中间动作重新攒，上一句的「正在做」留在原地不动
    feed.work = { turn: null, counts: {}, lines: [], calls: 0, err: 0 };
    feed.doing = null;
    syncCard(card);
    return;
  }
  if (m.role === 'assistant') {
    const tools = Array.isArray(m.tools) ? m.tools : [];
    if (tools.length) {
      // 上一张是这次要求下的「回答」、而且紧接着（90 秒内）又冒出工具调用：那说明它是中途插话，不是最终回答，撤掉它。
      // 隔了很久才来的新动作（人又让它干活）则不撤——那是上一步的结果，留着。
      const last = feed.cards[feed.cards.length - 1];
      if (last && last.cat === 'answer' && last.turn === feed.turn && feed.at - (last.at || 0) <= 90000) {
        // 就地退回「正在做」：这条要求还在干，别把半截回答当成交出的结果
        last.cat = 'doing'; last.done = false; last.text = ''; last.title = '正在做';
        last.wtext = workText(feed);
        feed.doing = last;
        feed.lastAnswer = null;
        syncCard(last);
      }
      for (const t of tools) for (const x of expandCalls(t.name, t.args, t.callId)) applyToolCall(feed, x.name, x.args, x.callId);
      return;
    }
    // 纯文本回答：前奏 / 过度句不算「交出的结果」，否则一句「我先看看」也长一张卡
    const full = polish(m.text);
    if (full.length < 24) { feed.stats.skipped++; return; }
    scanEntities(feed, m.text, feed.at);
    const text = answerBody(m.text);
    if (/^(我先|让我|好的|收到|稍等|正在|我这就|明白|没问题)/.test(text) && text.length < 90) { feed.stats.skipped++; return; }
    if (/^(Now I|Let me|I'll |I will |Okay|OK,|Sure|Got it|Looking at|First, )/i.test(text) && text.length < 160) { feed.stats.skipped++; return; }
    if (/[：:]$/.test(text)) { feed.stats.skipped++; return; }
    if (/^(Your request was not processed|I can't|I cannot|Gateway shutting down)/i.test(text)) { feed.stats.skipped++; return; }
    // 系统/管道报错不是「交出的结果」（模型被打断、网关断了、超时），别在链路上冒充回答
    if (/^(Operation interrupted|waiting for model response|Error[:：]|Traceback|API error|Request timed out|\[.*\]\s*$)/i.test(text)) { feed.stats.skipped++; return; }
    // 这句要求「正在做」的那张卡就地变成「回答」——同一张卡随动作推进，不新建
    const doing = feed.doing;
    if (doing && doing.turn === feed.turn && !doing.done) {
      doing.done = true; doing.cat = 'answer'; doing.title = '回答'; doing.text = text; doing.at = feed.at;
      doing.mods = [modOf('out', '结论')].concat(doing.mods.filter(m => m.name !== '进度'));
      feed.lastAnswer = doing;
      feed.lastGroup = doing;
      syncCard(doing);
      return;
    }
    // 同一次要求下的回答合并成一张，正文跟着最新一段走
    if (feed.lastAnswer && feed.lastAnswer.turn === feed.turn) {
      feed.lastAnswer.text = text; feed.lastAnswer.n++; feed.lastAnswer.at = feed.at;
      syncCard(feed.lastAnswer);
      feed.lastGroup = feed.lastAnswer;
      feed.stats.merged++;
      return;
    }
    const card = pushCard(feed, {
      kind: 'out', cat: 'answer', title: '回答', body: clip(text, BODY_CHARS), text,
      turn: feed.turn, at: feed.at, impl: [], mods: [modOf('out', '结论')],
    });
    if (!card) return;
    feed.lastAnswer = card;
    feed.lastGroup = card;
    syncCard(card);
    return;
  }
  if (m.role === 'tool') {
    const card = feed.byCall.get(m.toolCallId);
    if (card && m.ok === false) {
      card.err++;
      if (card.cat === 'doing' && feed.work) { feed.work.err = (feed.work.err || 0) + 1; card.wtext = workText(feed); }
      syncCard(card);
    }
  }
}

// 喂一批消息（按 id 升序）。返回这次有没有改动。
function applyMessages(feed, msgs) {
  let changed = false;
  for (const m of msgs || []) {
    const id = Number(m.id) || 0;
    if (id && id <= feed.lastId) continue;
    applyMessage(feed, m);
    if (id && id > feed.lastId) feed.lastId = id;
    changed = true;
  }
  return changed;
}

// 给画布用的形状：卡片正面只有 title / body / 模块；命令与参数在 impl。
function feedDoc(feed) {
  const byKind = { in: 0, proc: 0, out: 0 };
  for (const c of feed.cards) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
  return {
    schema: 'workflow-studio/live@1',
    conv: feed.conv,
    at: feed.at,
    stats: feed.stats,
    entities: {
      materials: topEnt(feed.ent.mat, 8),
      paths: topEnt(feed.ent.path, 8),
      results: topEnt(feed.ent.out, 8),
    },
    summary: {
      cards: feed.cards.length, edges: feed.edges.length, by_kind: byKind,
      messages: feed.stats.messages, tools: feed.stats.tools, merged: feed.stats.merged,
    },
    cards: feed.cards.map(c => ({
      id: c.id, kind: c.kind, title: c.head || titleOf(c), body: c.body || bodyOf(c),
      impl: c.implText || '', mods: c.mods, n: c.n || 1, at: c.at || 0,
    })),
    edges: feed.edges.map(e => [e[0], e[1]]),
  };
}

module.exports = { createFeed, applyMessages, feedDoc, polish, cleanAsk, splitAsk, toolOf, implLine, isChatter, scanEntities, TOOLS, SKIP, MAX_CARDS };
