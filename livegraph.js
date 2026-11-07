// 对话 → 工作链路：**材料版本 → 加工 → 产物版本 → 调整原因**。
//
// 这个模块只做两件事，都是纯函数（不联网、不读库、不写文件）：
//   1. buildEvidence(msgs)  从只读读到的消息里，把「谁在什么时候，拿哪个版本的材料，做了什么，
//      产出了哪个版本的什么文件」整理成带证据号的底账。文件身份用完整路径，同名不同目录不合并；
//      同一路径被改写就涨版本，旧版本永远留着。**文字里提到的文件名不涨任何计数**（只有真实调用算一次）。
//   2. buildGraph(ev, plan) 把底账摆成画布：材料卡 / 加工卡 / 产物卡，连线分四种（用的材料、
//      做出的产物、同一个文件的新版本、看了哪一版才改的）。plan 只负责「哪几个消息号算一步、这一步
//      叫什么、为什么改」——关系一律由底账算出来，模型说错的关系进不来，也不会为了连通而补线。
//
// 规矩（改这块要守住）：
// - 一条消息 ≠ 一张卡；只读不产出的动作不是加工卡（它是查资料）；
// - 同一材料同一版本只有一张卡，被两次加工用到就是两条「用」边，计数来自真实调用；
// - 同路径重写 = 新版本卡，旧版本卡不动；
// - 意见不是一张「点评卡」：它是后面那一步的修改原因（note + 证据消息号），链在它改的那一版产物上；
// - 正在做 / 失败 / 只提议没执行，各有状态，不冒充已完成；
// - 历史窗口截断就写清楚（truncated），不按邻近位置补造因果。
'use strict';

const MAX_CARDS = 120;         // 一条直播最多这么多张卡（材料/产物版本多，留宽一点）
const MAX_IMPL_LINES = 40;
const IMPL_SHOW = 6;
const BODY_CHARS = 150;
const MEDIA_EXT = /\.(png|jpe?g|webp|gif|mp4|mov|avi|json|jsonl|csv|xlsx|ya?ml|pdf|md|txt|svg|zip)$/i;
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|py|sh|rb|go|java|css|html?|vue|json)$/i;   // json 当数据文件更常见，下面按目录再判
const DATA_EXT = /\.(json|jsonl|csv|xlsx|ya?ml|md|txt)$/i;

const oneLine = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const baseName = p => String(p || '').replace(/\/+$/, '').split('/').pop();
const dirName = p => { const s = String(p || '').replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i > 0 ? s.slice(0, i) : ''; };
const isImage = p => /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(String(p || ''));
const isVideo = p => /\.(mp4|mov|avi|mkv|webm)$/i.test(String(p || ''));

// 完整路径归一：引号、末尾斜杠、重复斜杠；相对路径保持原样（它和绝对路径不是同一个文件）
function normPath(p) {
  let s = String(p == null ? '' : p).trim().replace(/^['"`]+|['"`]+$/g, '');
  if (!s || s.length > 400) return '';
  if (s.startsWith('file://')) s = s.slice(7);
  s = s.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (!s.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(s)) return '';        // 只认绝对路径：相对路径没有可靠身份
  return s;
}
const pathKey = p => normPath(p).toLowerCase();                          // macOS 大小写不敏感，统一小写做键
const isCodeFile = p => CODE_EXT.test(String(p || '')) && !/\/design|设计|图\//.test('/' + String(p || '').split('/').slice(-2).join('/')) && !isImage(p);

// 派活原文里万一贴过密钥：先抹掉（和 chain.js 同一套口径，写法和扫描脚本错开）
const redact = s => String(s == null ? '' : s)
  .replace(/\b(s[k]-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, '[已隐去]')
  .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, '$1[已隐去]')
  .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)["']?[^\s"',;]{8,}/gi, '$1[已隐去]');

// 人话化：去掉代码块 / 行内代码 / 链接 / 命令样式，只留能读的句子
function polish(text) {
  let t = String(text == null ? '' : text);
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(/`[^`\n]*`/g, ' ');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/https?:\/\/\S+/g, ' ');
  t = t.replace(/(?:^|\s)(?:~\/|\/)[\w./<>*-]{2,}/g, ' ');
  t = t.replace(/(?:^|\s)--[a-z][\w-]*/g, ' ');
  t = t.replace(/[A-Za-z0-9_.~-]*(?:\/[A-Za-z0-9_.~()\-\u4e00-\u9fa5]*)+/g, m => (/[A-Za-z0-9]/.test(m) ? ' ' : m));
  t = t.replace(/\b[\w-]+\.(?:json|jsonl|js|mjs|ts|py|sh|md|csv|ya?ml|xlsx|png|jpe?g|gif|webp|zip|log|txt|sqlite|db|html|css|ipynb)\b/gi, ' ');
  t = t.replace(/\b[\x21-\x7e]+(?:[\/\\][\x21-\x7e]+)+\b/g, ' ');
  t = t.replace(/^\s*#{1,6}\s*/gm, '').replace(/(^|\s)#{1,6}\s+/g, '$1').replace(/\*\*/g, '').replace(/^\s*[-*·]\s+/gm, '');
  t = t.replace(/\s+([，。；：、！？）」》])/g, '$1').replace(/([（「《])\s+/g, '$1');
  return oneLine(t);
}
const looksTech = s => /(`|\/[\w.<>-]+\/|(?:^|\s)--[a-z]|\{["']|\b[\w-]+\.(?:json|jsonl|js|ts|py|sh|md|csv|ya?ml)\b)/.test(String(s || ''));

// 用户原话：剥掉系统壳（[IMPORTANT…] / 看板卡头 / 网关头 / 带外消息包装），剩下的才是人说的话。
function cleanAsk(text) {
  const raw = String(text == null ? '' : text);
  let t = raw;
  const images = (t.match(/\[Image attached at:[^\]]*\]/g) || []).map(s => s.replace(/^\[Image attached at:\s*|\]$/g, '').trim()).filter(Boolean);
  const shots = (t.match(/\[screenshot\]/gi) || []).length;
  t = t.replace(/\[Image attached at:[^\]]*\]/g, ' ')
    .replace(/\[screenshot\]/gi, ' ')
    .replace(/\[OUT-OF-BAND USER MESSAGE[^\]]*\]/gi, ' ')
    .replace(/\[\/OUT-OF-BAND USER MESSAGE\]/gi, ' ')
    .replace(/^Gateway message origin[^\n]*\n?/im, ' ')
    .replace(/^\s*\[[A-Z][^\]]{0,140}\]\s*/g, ' ')
    .replace(/^\s*\[(?:IMPORTANT|Cronjob|System)[\s\S]*?\]\s*/i, ' ')
    .replace(/^\s*Message from [^:\n]{0,120}:\s*/i, '')
    .replace(/^#{0,6}\s*Kanban task\s+\w+:\s*/im, '')
    .replace(/^\s*(?:Assignee|Status|Workspace|Max runtime|Terminal timeout|Depends on|Priority|Created by|Reviewer)\s*:[^\n]*\n?/gim, '')
    .replace(/^\s*New note on your kanban task[\s\S]*$/i, ' ')
    .replace(/^\s*You've reached the (?:maximum|limit)[\s\S]*$/i, ' ');
  t = t.trim();
  if (/^[[{]/.test(t) || /not instructions or authorization/i.test(t)) t = '';
  if (/^---\s*\n(?:name|description)\s*:/i.test(t) || /skill preloaded/i.test(t) || /This skill has supporting files/i.test(t)) t = '';
  if (/^\[IMPORTANT: The user launched this CLI session/i.test(t)) t = '';
  if (/^\[IMPORTANT[:\s]/i.test(raw) || /^\[Orphan recovery/i.test(raw) || /^Background process /i.test(raw)
    || /INTERNAL NOTIFICATION/i.test(raw) || /not written by a human user/i.test(raw)) t = '';
  return { text: t, images: images.concat(Array(shots).fill('[截图]')) };
}

const CHATTER = /^(你好|您好|hi|hello|hey|在吗|在不在|谢谢|多谢|辛苦|好的|好|收到|ok|okay|嗯|嗯嗯|对|是的|算了|不用了|先这样|继续|哈哈|早|晚安)[\s！!。.，,～~…·]*$/i;
function isChatter(text, pics) {
  if (pics && pics.length) return false;
  const t = oneLine(text);
  if (!t) return true;
  if (t.length <= 12 && CHATTER.test(t)) return true;
  if (t.length <= 4 && !/[\u4e00-\u9fa5]{2}/.test(t.replace(CHATTER, ''))) return true;
  return false;
}

// 一次工具调用的「内部实现」一行：工具名 + 关键参数
function implLine(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  const pick = (...keys) => { for (const k of keys) if (a[k] != null && a[k] !== '') return String(a[k]); return ''; };
  let key = '';
  if (/^(read_file|file_read|write_file|patch|edit_file|apply_patch|search_files|grep)$/.test(name)) key = pick('path', 'file_path', 'pattern', 'query', 'file');
  else if (name === 'vision_analyze') key = pick('image_url', 'url', 'path');
  else if (name === 'terminal' || name === 'execute_code') key = pick('command', 'code');
  else if (/^web_/.test(name) || name === 'browser') key = pick('query', 'url', 'urls');
  else if (/^skill_/.test(name)) key = pick('name', 'skill');
  else if (name === 'message_agent') key = pick('target', 'to', 'name');
  else if (name === 'delegate_task' || name === 'spawn_agent') key = pick('agent', 'profile', 'name', 'task');
  else key = pick('path', 'query', 'name', 'command', 'url');
  if (key === '' && Object.keys(a).length) { try { key = JSON.stringify(a); } catch (e) { key = ''; } }
  return clip(redact(name + (key ? ' ' + oneLine(key) : '')), 300);
}

// 一次工具调用可能是外壳：tool_call 把 N 个真实调用包在 calls 里——拆开按真实工具记
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

const SKIP = new Set(['todo_list', 'todo_read', 'todo_write', 'todo_update', 'todo_list']);
// 工具 → 人话短词（加工卡的做法标签）
const TOOL_WORD = {
  read_file: '读资料', file_read: '读资料', vision_analyze: '看图', search_files: '找文件', grep: '找内容',
  terminal: '跑命令', execute_code: '跑代码', process_manage: '跑进程', process: '跑进程',
  web_search: '搜网页', web_extract: '读网页', web_fetch: '读网页', browser: '开浏览器',
  skill_view: '看技能', skills_list: '看技能', skill_list: '看技能', skill_manage: '改技能',
  tool_search: '找工具', tool_describe: '看工具说明', manage_catalog: '查目录',
  write_file: '写文件', patch: '改文件', edit_file: '改文件', apply_patch: '改文件',
  message_agent: '派活', delegate_task: '派活', spawn_agent: '派活', a2a: '联络岗位', kanban_create: '派活',
  session_search: '查记录', memory: '记一笔', clarify: '问一句', cronjob: '排定时',
  image_gen: '生成图', video_gen: '生成视频',
};
const toolWord = n => TOOL_WORD[n] || (String(n || '').length > 10 ? '用工具' : clip(n || '工具', 8));
// 只有这些算「加工方式」；换目录 / 看目录 / 建删临时文件这种不是做法，不进卡片正面
const CMD_WORD = {
  cat: '看文件内容', head: '看文件内容', tail: '看文件内容', grep: '找内容',
  sed: '改文本', awk: '处理文本', find: '找文件', node: '跑脚本', python: '跑脚本', python3: '跑脚本',
  npm: '装依赖', git: '版本操作', curl: '抓网页', ffmpeg: '处理视频', sqlite3: '查记录',
  blender: '跑建模脚本',
};
const TRIVIAL_CMD = /^(ls|mkdir|rm|ps|pkill|cd|echo|stat|shasum|sleep|test|printf|pwd|true|cp|mv|open|chmod)$/;
const cmdWord = cmd => {
  const s = String(cmd || '').trim();
  const first = (s.match(/^(?:cd\s+\S+\s*&&\s*)?([A-Za-z0-9_.-]+)/) || [])[1] || '';
  if (CMD_WORD[first]) return CMD_WORD[first];
  if (TRIVIAL_CMD.test(first)) return '';
  if (/^(for|while|if|case)\b/.test(first) || /<<\s*'?[A-Z]+'?/.test(s)) return '跑脚本';
  return first ? '跑命令' : '';
};

// 从终端命令里认「真被用到」的文件：只有真正读内容的命令才算（ls/stat/shasum 只是列名字，不算用）
// 一次调用里的同一个文件只算一次；命令自己写出来的文件（ffmpeg 输出 / OUT=…）不算素材。
const READ_CMDS = /^(cat|head|tail|grep|egrep|ffmpeg|python3?|node|blender|sqlite3|curl|shasum|md5|base64)$/;
function filesInCommand(cmd) {
  const s = String(cmd || '');
  const first = (s.trim().match(/^(?:cd\s+\S+\s*&&\s*)?([A-Za-z0-9_.-]+)/) || [])[1] || '';
  if (!READ_CMDS.test(first)) return [];
  const isFfmpeg = first === 'ffmpeg';
  const found = [];
  for (const m of s.matchAll(/(?:^|[\s"'=(])(\/[^\s"'()<>;,|]+)/g)) {
    const p = normPath(m[1]);
    if (!p) continue;
    if (!/\.[A-Za-z0-9]{1,6}$/.test(p)) continue;                        // 目录不算材料
    if (isCodeFile(p)) continue;                                          // 脚本 / 代码是「怎么做的」
    const before = s.slice(Math.max(0, m.index - 40), m.index);
    if (/(OUT|output|dst|dest|>\s*)$/i.test(before)) continue;            // 命令写出的目标
    found.push(p);
  }
  // ffmpeg 的最后一个路径参数是输出，不算素材
  if (isFfmpeg && found.length > 1) found.pop();
  return [...new Set(found)];
}

// 回答里显式交付的文件：MEDIA:/path（Hermes 的交付写法）
function mediaIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/MEDIA:\s*([^\s`"')]+)/g)) {
    const p = normPath(m[1]);
    if (p) out.add(p);
  }
  return [...out];
}

// 一次要求 / 一次反馈：人话那部分 + 技术句子（进内部实现）
function splitAsk(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { body: '', impl: '' };
  const parts = raw.split(/(?<=[。；;！!？?\n])/).map(s => s.trim()).filter(Boolean);
  const human = [], tech = [];
  for (const p of parts) (looksTech(p) && polish(p).length < 24 ? tech : human).push(p);
  const body = clip(polish(human.join(' ')), BODY_CHARS);
  if (body.length >= 6) return { body, impl: tech.join('\n') };
  return { body: clip(polish(raw), BODY_CHARS), impl: (tech.length ? tech.join('\n') : (looksTech(raw) ? raw : '')) };
}

// ---------- 底账 ----------
function createEvidence(conv) {
  return {
    conv: conv || null,
    at: 0,
    messages: [],
    calls: [],
    mats: new Map(),        // pathKey → 材料（读进来的东西）
    arts: new Map(),        // pathKey → 产物（做出来的东西）
    ask: [],                // 人的要求 / 反馈（同一个数组，按时间）
    units: [],              // 加工单元（一次要求下，做到产出为一段）
    byCall: new Map(),      // callId → {unit, ok}
    truncated: false,
    stats: { messages: 0, tools: 0, chatter: 0, skipped: 0, failed: 0, media: 0 },
    lastId: 0,
  };
}

function ensureMat(ev, path, at, msgId, how) {
  const k = pathKey(path);
  let m = ev.mats.get(k);
  if (!m) {
    m = { key: k, path: normPath(path), name: baseName(path), dir: dirName(path), seen: 'read', versions: [], uses: [] };
    m.versions.push({ v: 1, at, msg: msgId, how });
    ev.mats.set(k, m);
  }
  return m;
}
function ensureArt(ev, path, at, msgId, how) {
  const k = pathKey(path);
  let a = ev.arts.get(k);
  if (!a) {
    a = { key: k, path: normPath(path), name: baseName(path), dir: dirName(path), versions: [] };
    ev.arts.set(k, a);
  }
  return a;
}
function artVersion(ev, path, { at, msg, how, ok = true, unit = null } = {}) {
  const a = ensureArt(ev, path, at, msg, how);
  const last = a.versions[a.versions.length - 1];
  // 同一次加工里同一个文件被写了两次（脚本 + 补丁）算同一版；不同加工才算新版本
  if (last && unit && last.unit === unit.id) {
    if (!ok) last.ok = false;
    if (!last.evidence.includes(msg)) last.evidence.push(msg);
    return { art: a, ver: last };
  }
  const v = { v: (last ? last.v : 0) + 1, at, msg, how, ok, unit: unit ? unit.id : '', evidence: [msg] };
  a.versions.push(v);
  return { art: a, ver: v };
}
function matVersion(ev, path, { at, msg, how } = {}) {
  const m = ensureMat(ev, path, at, msg, how);
  return { mat: m, ver: m.versions[m.versions.length - 1] };
}
// 材料被改写：涨一版（旧的使用范围留在旧版本上），并记一条「演变」关系
function bumpMatVersion(ev, path, { at, msg, how, unit } = {}) {
  const m = ensureMat(ev, path, at, msg, how);
  const last = m.versions[m.versions.length - 1];
  // 同一次加工里同一个文件被写了两次（写入 + 回答里交付）算同一版
  if (unit && last.unit === unit) { if (msg && !(last.msg === msg)) last.msg = last.msg || msg; return { mat: m, ver: last }; }
  const v = { v: last.v + 1, at, msg, how, from: last.v, unit: unit || '' };
  m.versions.push(v);
  return { mat: m, ver: v };
}

function newUnit(ev, { turn, trigger, at, userMsg }) {
  const u = {
    id: 'u' + (ev.units.length + 1), turn, at, trigger, userMsg,
    calls: [], methods: [], matUses: [], artUses: [], outs: [],
    writeTries: 0, failed: 0, answer: '', note: '', status: '', doing: false,
  };
  ev.units.push(u);
  return u;
}

function useMat(ev, unit, path, at, msg, how) {
  if (!path) return;
  // 已经作为产物出现过的路径：旧结果被再加工，直接连产物卡，不另造输入卡
  const ak = pathKey(path);
  if (ev.arts.has(ak)) {
    const a = ev.arts.get(ak);
    const v = a.versions[a.versions.length - 1];
    if (!unit.artUses.some(x => x.key === ak && x.v === v.v)) unit.artUses.push({ key: ak, v: v.v, path: a.path, name: a.name });
    return;
  }
  const { mat, ver } = matVersion(ev, path, { at, msg, how });
  if (!unit.matUses.some(x => x.key === mat.key && x.v === ver.v)) unit.matUses.push({ key: mat.key, v: ver.v, path: mat.path, name: mat.name });
  if (!mat.uses.some(x => x.unit === unit.id && x.v === ver.v)) mat.uses.push({ unit: unit.id, v: ver.v, msg });
}

function markCall(ev, unit, eid, call, at, msg) {
  ev.calls.push({ eid, msg, at, name: call.name, ok: call.ok, unit: unit ? unit.id : '', line: implLine(call.name, call.args) });
  if (unit) unit.calls.push(eid);
}

// 一次工具调用落到哪：材料 / 产物 / 做法
function applyCall(ev, unit, call, msg) {
  const { name, args } = call;
  const a = args && typeof args === 'object' ? args : {};
  if (SKIP.has(name)) { ev.stats.skipped++; return null; }
  if (!unit) return null;
  const at = msg.at, msgId = msg.id;
  const ok = call.ok === false ? false : (call.ok === null || call.ok === undefined) ? null : true;
  const word = toolWord(name);
  if (word) { if (!unit.methods.some(m => m.w === word)) unit.methods.push({ w: word }); }

  // 读：材料（或旧产物）。**这一步自己刚做出来的东西，回读只是检查，不算再当素材用；读失败了也不算用到**
  const use = p => {
    if (!p) return;
    if (ok === false) return;
    const k = pathKey(p);
    const art = ev.arts.get(k);
    const mat = ev.mats.get(k);
    const v = art ? art.versions[art.versions.length - 1] : mat ? mat.versions[mat.versions.length - 1] : null;
    if (v && v.unit === unit.id) return;
    if (v && v.msg === msgId) return;
    useMat(ev, unit, p, at, msgId, '读');
  };
  if (/^(read_file|file_read)$/.test(name)) use(a.path || a.file_path);
  if (name === 'vision_analyze') use(a.image_url || a.url || a.path);
  if (name === 'terminal' && a.command) {
    const w = cmdWord(a.command);
    if (w && !unit.methods.some(m => m.w === w)) unit.methods.push({ w });
    for (const p of filesInCommand(a.command)) use(p);
    // 命令里显式写出的文件（ffmpeg -y out.png / > out.json）也算产出线索，但只在没写文件工具时用
  }
  if (/^(write_file|patch|edit_file|apply_patch)$/.test(name)) {
    const p = normPath(a.path || a.file_path);
    if (p) {
      if (isCodeFile(p)) {
        if (!unit.methods.some(m => m.w === '改代码')) unit.methods.push({ w: '改代码' });
      } else {
        unit.writeTries++;
        // 这个文件以前是「读进来的参考」→ 材料改写：涨材料版本，不另造产物
        if (ev.mats.has(pathKey(p)) && !ev.arts.has(pathKey(p))) {
          const { mat, ver } = bumpMatVersion(ev, p, { at, msg: msgId, how: word, unit: unit.id });
          unit.outs.push({ kind: 'mat', key: mat.key, v: ver.v, path: mat.path, name: mat.name, ok });
        } else {
          const { art, ver } = artVersion(ev, p, { at, msg: msgId, how: word, ok, unit });
          unit.outs.push({ kind: 'art', key: art.key, v: ver.v, path: art.path, name: art.name, ok });
        }
      }
    }
  }
  return { word };
}

// 回答里显式交付的文件 = 这次加工的产出（MEDIA 行）；只在这条加工已经有动作时才算
function applyAnswer(ev, unit, m) {
  const t = String(m.text || '');
  if (!t) return;
  const text = clip(polish(t), BODY_CHARS);
  if (unit) {
    unit.answer = text;
    // 回答里贴图不等于产出：这一步得真动过手（有调用）才算「这次做出来的」
    if (!unit.calls.length) return;
    for (const p of mediaIn(t)) {
      ev.stats.media++;
      const k = pathKey(p);
      // 这个路径原本是「读进来的参考」→ 这是把参考素材改了，涨材料版本，不另造一个产物卡
      if (ev.mats.has(k) && !ev.arts.has(k)) {
        const { mat, ver } = bumpMatVersion(ev, p, { at: m.at, msg: m.id, how: '交付', unit: unit.id });
        if (!unit.outs.some(o => o.path === mat.path && o.v === ver.v)) unit.outs.push({ kind: 'mat', key: mat.key, v: ver.v, path: mat.path, name: mat.name, ok: true });
        continue;
      }
      const { art, ver } = artVersion(ev, p, { at: m.at, msg: m.id, how: '交付', ok: true, unit });
      if (!unit.outs.some(o => o.path === art.path && o.v === ver.v)) unit.outs.push({ kind: 'art', key: art.key, v: ver.v, path: art.path, name: art.name, ok: true });
    }
  }
}

// 读一轮消息，更新底账。按消息 id 去重（轮询重复读到同一条不涨计数、不重复建实体）。
function buildEvidence(msgs, conv) {
  const ev = createEvidence(conv);
  const sorted = (msgs || []).filter(m => m && typeof m === 'object').slice()
    .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
  const okOf = new Map();
  const msgsById = new Map();
  for (const m of sorted) {
    const mid = Number(m.id) || 0;
    if (mid) msgsById.set(mid, m);
    if (m.role === 'tool' && m.toolCallId) okOf.set(String(m.toolCallId), m.ok !== false);
    if (m.at) ev.at = Math.max(ev.at, Number(m.at) || 0);
  }
  ev.msgsById = msgsById;
  // 窗口截断：读满 200 条就当「更早的没看到」，界面与提示词都要说明
  ev.truncated = sorted.length >= 200;
  let unit = null, turn = 0, lastUser = null, lastOuts = [];
  const seen = new Set();
  for (const m of sorted) {
    const mid0 = Number(m.id) || 0;
    if (mid0 && seen.has(mid0)) continue;            // 同一批消息重复喂（轮询 / 重解析）：不重复计数
    if (mid0) seen.add(mid0);
    ev.stats.messages++;
    if (mid0 > ev.lastId) ev.lastId = mid0;
    if (m.role === 'user') {
      const c = cleanAsk(m.text);
      if (!c.text && !(c.images || []).length) continue;
      if (isChatter(c.text, c.images)) { ev.stats.chatter++; continue; }
      turn++;
      const at = m.at || ev.at;
      // 这轮要求前面刚做完的东西 = 人正在看的那一版（用于「因为看了哪一版才改」）
      const prevOuts = lastOuts.slice();
      unit = newUnit(ev, { turn, trigger: 'user', at, userMsg: m.id });
      unit.after = prevOuts;
      unit.ask = c.text;
      const human = splitAsk(c.text);
      ev.ask.push({ id: 'q' + turn, msg: m.id, at, text: c.text, body: human.body, impl: human.impl, images: c.images || [] });
      unit.askBody = human.body;
      lastOuts = [];
      for (const img of c.images || []) {
        const p = normPath(img);
        if (p) useMat(ev, unit, p, at, m.id, '人发来的图');
        else {
          // 只有「截图」两个字没有路径：不造文件实体，正面记一句
          unit.shotCount = (unit.shotCount || 0) + 1;
        }
      }
      lastUser = m.id;
      continue;
    }
    if (m.role === 'assistant') {
      const tools = Array.isArray(m.tools) ? m.tools : [];
      if (tools.length) {
        let i = 0;
        for (const t of tools) {
          for (const x of expandCalls(t.name, t.args, t.callId)) {
            if (!x.name) continue;
            const cid = x.callId || t.callId || '';
            const ok = cid && okOf.has(String(cid)) ? okOf.get(String(cid)) : (cid ? null : true);
            ev.stats.tools++;
            const eid = 'e' + m.id + (tools.length > 1 || expandCalls(t.name, t.args, t.callId).length > 1 ? '.' + (++i) : '');
            markCall(ev, unit, eid, { name: x.name, args: x.args, ok }, m.at, m.id);
            if (ok === false) { ev.stats.failed++; if (unit) unit.failed++; }
            applyCall(ev, unit, { name: x.name, args: x.args, ok }, m);
            if (unit) { unit.at = m.at || unit.at; }
            if (cid) ev.byCall.set(String(cid), { unit: unit ? unit.id : '', ok });
          }
        }
        continue;
      }
      if (!unit) continue;
      // 回答里的表格 / 命令不算实体；只有 MEDIA 交付算产出
      applyAnswer(ev, unit, m);
      // 「只提方案没做」：这一步没有任何产出，回答里出现「可以 / 建议 / 改用」这类说法 → 标未执行
      if (!unit.outs.length && /(建议|可以改用|可以考虑|改用|换成|换用|不妨)/.test(String(m.text || ''))) unit.proposed = true;
      continue;
    }
    // tool 结果行：ok 已经收进 okOf，这里不建任何东西
  }
  // 收尾：状态
  const lastMsg = sorted[sorted.length - 1];
  ev.units.forEach((u, i) => {
    if (!u.calls.length) { u.status = u.ask ? 'empty' : 'empty'; return; }
    const outs = u.outs.filter(o => o.ok === true);
    if (outs.length) u.status = 'done';
    else if (u.outs.some(o => o.ok === null)) u.status = 'doing';   // 写了但结果还没回来
    else if (u.outs.length) u.status = 'failed';                 // 写了但都失败
    else if (u.writeTries && u.failed) u.status = 'failed';
    else if (u.proposed) u.status = 'proposed';
    else u.status = 'unfinished';                                 // 只在查资料，没产出
    // 尾巴上还在动的：最近十分钟内有活动，就算「正在做」（老对话的尾巴不会被误标）
    if (i === ev.units.length - 1 && ev.at && u.at && ev.at - u.at < 10 * 60 * 1000 && !u.outs.length && u.status !== 'proposed') u.doing = true;
    u.note = ''; u.afterOuts = u.after || [];
  });
  ev.ask.forEach(q => { const u = ev.units.find(x => x.userMsg === q.msg); if (u) q.unit = u.id; });
  // 材料统计：只按真实调用计数
  ev.stats.materials = ev.mats.size;
  ev.stats.artifacts = ev.arts.size;
  return ev;
}

// ---------- 把底账摆成图 ----------
const KIND_LABEL = { in: '输入', proc: '加工', out: '输出' };
const statusWord = s => ({
  done: '', failed: '失败', doing: '正在做', unfinished: '没找到产出', proposed: '未执行', pending: '待确认',
}[s] || '');

function matCardId(m, v) { return 'm:' + hashKey(m.key) + '@v' + (v && typeof v === 'object' ? v.v : v); }
function artCardId(a, v) { return 'a:' + hashKey(a.key) + '@v' + (v && typeof v === 'object' ? v.v : v); }
function hashKey(k) { let h = 0; const s = String(k); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h).toString(36); }

// 一个加工单元 → 一张加工卡（材料/产物由它引用，不复制）
function procCard(u, extra) {
  const x = Object.assign({
    id: 'p:' + u.id, kind: 'proc', unit: u.id, at: u.at,
    title: u.title || '', body: u.body || '', impl: '', note: u.note || '',
    status: u.status, branch: u.branch || 'main', mods: [], uses: [], makes: [],
  }, extra || {});
  if (!x.title) x.title = stepTitle(u);
  if (!x.body) x.body = stepBody(u);
  if (!x.mods.length) x.mods = (u.methods || []).slice(0, 3).map(m => ({ type: 'tool', name: clip(m.w, 8) }));
  return x;
}
function stepTitle(u) {
  if (u.status === 'proposed') return '提议的做法';
  const w = (u.methods || []).map(m => m.w).filter(Boolean);
  if (u.outs.length) return clip(w.length ? '做：' + w.slice(0, 2).join(' + ') : '做了一批', 16);
  if (u.status === 'failed') return '试过但没成';
  if (u.status === 'doing') return '正在做';
  return '查资料';
}
function stepBody(u) {
  if (u.status === 'proposed') return clip('只提了做法，还没动手：' + polish(u.answer || u.ask || ''), BODY_CHARS);
  const bits = [];
  if (u.matUses.length) bits.push(`用了 ${u.matUses.length} 份参考`);
  if (u.artUses.length) bits.push(`接着改 ${u.artUses.length} 版产物`);
  if (u.methods.length) bits.push(`做法：${u.methods.slice(0, 3).map(m => m.w).join('、')}`);
  if (u.outs.length) bits.push(`交出 ${u.outs.length} 个产物`);
  if (u.status === 'failed') bits.push('这次没成');
  if (u.status === 'doing') bits.push('还在做');
  if (!bits.length) bits.push(clip(polish(u.answer || ''), 60) || '查了一下');
  return clip(bits.join(' · '), BODY_CHARS);
}

function matCard(m, v, label) {
  const nm = label || m.name;
  return {
    id: matCardId(m, v.v), kind: 'in', at: v.at, ver: v.v, versions: m.versions.length,
    title: clip(nm, 22), body: '', note: '', status: '', branch: 'main',
    mods: [{ type: 'mat', name: clip(nm, 10) }], impl: '', uses: 0,
  };
}
function artCard(a, v, label) {
  const nm = label || a.name;
  return {
    id: artCardId(a, v.v), kind: 'out', at: v.at, ver: v.v, versions: a.versions.length,
    title: clip(nm, 22), body: '', note: '', status: v.ok === false ? 'failed' : v.ok === null ? 'doing' : 'done', branch: 'main',
    mods: [{ type: 'res', name: clip(nm, 10) }], impl: '', uses: 0,
  };
}
// 同名不同目录：身份本来就分开（完整路径），显示上加一行来源，免得人误以为是同一个文件
const shortDir = p => clip(String(dirName(p)).split('/').pop().replace(/^\d+[-_]?/, ''), 10);
function nameLabels(ev) {
  const all = [...[...ev.mats.values()].map(m => m.name), ...[...ev.arts.values()].map(a => a.name)];
  const dup = new Set(all.filter((n, i) => all.indexOf(n) !== i));
  const label = new Map();
  for (const m of ev.mats.values()) label.set(m.key, dup.has(m.name) ? m.name + ' · ' + shortDir(m.path) : m.name);
  for (const a of ev.arts.values()) label.set(a.key, dup.has(a.name) ? a.name + ' · ' + shortDir(a.path) : a.name);
  return label;
}

// 底账 → 画布文档。plan 只决定「哪几个消息号算一步、叫什么、为什么改」，关系全由底账算。
function buildGraph(ev, plan) {
  const cards = new Map();                 // id → card
  const edges = [];                        // [from, to, kind]
  const has = (a, b) => edges.some(([x, y]) => x === a && y === b);
  const add = (a, b, k) => { if (!a || !b || a === b || has(a, b)) return; edges.push([a, b, k || 'use']); };
  // 「改」边不允许成环：两步互指「因为看了对方才改」不可能成立，遇到就记问题、不连
  // 判定要看整张依赖图（产物 → 加工：make / use / revise），只看改边会漏掉「甲做了 A、乙改 A、甲又改乙的产物」这种环
  const dagReach = (from, to) => {
    const seen = new Set([from]); const q = [from];
    while (q.length) {
      const k = q.pop();
      if (k === to) return true;
      for (const [a, b, kind] of edges) {
        if (kind === 'evolve') continue;
        if (a === k && !seen.has(b)) { seen.add(b); q.push(b); }
      }
    }
    return false;
  };
  const addRevise = (a, b) => {
    if (!a || !b || has(a, b)) return true;
    if (dagReach(b, a)) return false;
    edges.push([a, b, 'revise']);
    return true;
  };
  const problems = [];
  const segments = [];

  const LABEL = nameLabels(ev);
  // 哪些版本「被做出来了」（要上图，即使没再被别人用过）
  const produced = new Set();
  for (const u of ev.units) for (const o of u.outs) produced.add(o.key + '@v' + o.v);
  const matOf = (key, v) => { const m = ev.mats.get(key); return m ? m.versions.find(x => x.v === v) || m.versions[m.versions.length - 1] : null; };
  const artOf = (key, v) => { const a = ev.arts.get(key); return a ? a.versions.find(x => x.v === v) || a.versions[a.versions.length - 1] : null; };

  // 1) 版本卡：同一路径的每个版本一张。窗口里真做出来的 = 产物卡；之前就有、只被读过的 = 素材卡。
  const verCards = new Map();            // key@v → 卡 id
  const addVersionCards = ent => {
    for (const v of ent.versions) {
      const prod = produced.has(ent.key + '@v' + v.v);
      const isMat = ev.mats.has(ent.key) && !ev.arts.has(ent.key);
      const uses = isMat ? ent.uses.filter(u => u.v === v.v).length : 0;
      if (!prod && (!isMat || !uses)) continue;
      const id = isMat ? matCardId(ent, v) : artCardId(ent, v);
      const c = prod ? artCard(ent, v, LABEL.get(ent.key)) : matCard(ent, v, LABEL.get(ent.key));
      c.id = id;                                   // 卡号按「是不是素材」定，不按外观定（否则连线找不到它）
      c.kind = isMat ? 'in' : 'out';               // 参考素材改了版仍然是素材（看得见前后差别），不是交付物
      if (prod) {
        c.body = versionBodyArt(ent, v);
        c.impl = evidenceImpl(ent.path, v, { how: v.how || '写入', msg: v.msg, eids: v.evidence });
      } else {
        c.uses = uses;
        c.body = versionBodyMat(ent, v, uses);
        c.impl = evidenceImpl(ent.path, v, { how: v.how, msg: v.msg });
      }
      if (cards.has(id)) continue;
      cards.set(id, c);
      verCards.set(ent.key + '@v' + v.v, id);
    }
  };
  for (const m of ev.mats.values()) addVersionCards(m);
  for (const a of ev.arts.values()) addVersionCards(a);
  // 3) 加工卡：plan 给的分段优先；底账里没被任何分段覆盖的加工单元再自动补上
  const usedUnits = new Set();
  const unitRanges = [];
  if (plan && Array.isArray(plan.steps)) {
    const keys = new Set();
    let bad = '';
    for (const st of plan.steps) {
      if (!st || typeof st !== 'object') { bad = '步骤格式不对（不是对象）'; break; }
      if (!st.key) { bad = '有一步没给 key'; break; }
      if (keys.has(String(st.key))) { bad = '重复的步骤 key：' + st.key; break; }
      keys.add(String(st.key));
      if (st.status === 'proposed' && st.msg) continue;             // 只提方案没执行：没有调用，按消息号单独立一张卡
      const from = Number(st.from) || 0, to = Number(st.to) || 0;
      if (!from || !to || to < from) { bad = `「${st.title || st.key}」没给有效的消息号范围`; break; }
      const unit = unitForRange(ev, from, to);
      if (!unit) { bad = `「${st.title || st.key}」的消息范围里没有任何真实调用`; break; }
      if (unitRanges.some(r => !(to < r.from || from > r.to))) { bad = `「${st.title || st.key}」的消息范围和别的步骤重叠`; break; }
      unitRanges.push({ from, to, unit, st });
    }
    if (bad) { problems.push(bad); unitRanges.length = 0; }         // 整份不用，退回底账自动分段（不半份糊上）
  }
  const addProc = (u, st) => {
    if (usedUnits.has(u.id)) return null;
    if (!u.calls.length) return null;
    usedUnits.add(u.id);
    const extra = {};
    if (st) {
      extra.title = clip(String(st.title || ''), 24);
      extra.body = clip(String(st.body || ''), BODY_CHARS);
      extra.note = clip(String(st.note || ''), 120);
      extra.branch = clip(String(st.branch || 'main'), 12);
      extra.implExtra = String(st.impl || '');
      // 状态以底账为准：模型说「未执行」，但记录里真有产出 → 就是已完成；反之亦然
      if (u.outs.length) extra.status = u.outs.some(o => o.ok === true) ? 'done' : u.outs.some(o => o.ok === null) ? 'doing' : 'failed';
      else if (st.status === 'proposed' || u.proposed) extra.status = 'proposed';
      else extra.status = u.status;
    }
    const c = procCard(u, extra);
    // 模型只提了方案、记录里没动作：照样标未执行，不连线到产物
    c.impl = procImpl(u, st);
    cards.set(c.id, c);
    // 4) 关系：材料/旧产物 → proc（真用过）、proc → 版本卡（真做出）
    for (const x of u.matUses.concat(u.artUses)) {
      const id = verCards.get(x.key + '@v' + x.v);
      if (!id) continue;
      add(id, c.id, 'use');
      if (!c.uses.includes(id)) c.uses.push(id);
      const vc = cards.get(id);
      if (vc && vc.kind === 'out') vc.uses++;        // 素材卡的次数按真实调用一次算好，产物卡按被读次数累计
    }
    for (const o of u.outs) {
      const id = verCards.get(o.key + '@v' + o.v);
      if (!id) continue;
      add(c.id, id, 'make');
      if (!c.makes.includes(id)) c.makes.push(id);
    }
    // 5) 调整：同一文件的新版本，从上一版连一条「改」边；版本之间连「新版」边（都不是读入）
    for (const o of u.outs) {
      if (o.v <= 1) continue;
      const prevId = verCards.get(o.key + '@v' + (o.v - 1));
      const curId = verCards.get(o.key + '@v' + o.v);
      if (!prevId) continue;
      if (!has(prevId, c.id)) {
        if (addRevise(prevId, c.id)) c.revises = (c.revises || []).concat(prevId);
        else { problems.push(`「${c.title}」和上一版的「改」关系会绕成环，没有连`); c.status = 'pending'; }
      }
      if (curId && !has(prevId, curId)) add(prevId, curId, 'evolve');
    }
    // 6) 人话的修改原因：这一步前面那条用户消息（真说过话才算），加上看了哪一版
    if (u.ask && c.status !== 'proposed') {
      const reason = polish(u.ask);
      if (reason && (c.revises || []).length) c.note = c.note || clip(reason, 60);
      u.reason = reason;
    }
    // 7) 模型声明的 after（未知引用 → 标待确认，不硬连）
    if (st && Array.isArray(st.after) && st.after.length) {
      for (const ref of st.after) {
        const hit = resolveRef(cards, ref);
        if (!hit) { c.status = 'pending'; c.note = clip((c.note ? c.note + ' · ' : '') + '引用的上一版产物在记录里找不到', 120); problems.push(`「${c.title}」说的「因为看了${typeof ref === 'string' ? ref : ''}」找不到对应产物`); continue; }
        if (!addRevise(hit.id, c.id)) { c.status = 'pending'; problems.push(`「${c.title}」说的「因为看了这一版才改」会绕成环，没有连`); continue; }
        c.revises = (c.revises || []).concat(hit.id);
      }
    }
    return c;
  };
  // plan 的分段
  for (const r of unitRanges) addProc(r.unit, r.st);
  // 只提了做法、没动手的（记录里确实没有调用）：单独一张「未执行」卡，不连线到任何产物
  if (plan && Array.isArray(plan.steps)) {
    for (const st of plan.steps) {
      if (!st || typeof st !== 'object') continue;
      if (!(st.status === 'proposed' && st.msg)) continue;
      const m = ev.msgsById && ev.msgsById.get(Number(st.msg));
      if (!m || String(m.text || '').trim().length < 8) { problems.push(`「${st.title || st.key}」说的方案在记录里找不到对应的回答`); continue; }
      // 这条消息本身带着真实调用：说明它是干活的，不是「只提方案」——标成未执行会和已完成重复
      if ((m.tools || []).length || ev.calls.some(c => c.msg === Number(st.msg))) { problems.push(`「${st.title || st.key}」说没执行，但消息 ${st.msg} 里有真实调用，已按记录处理`); continue; }
      const c = {
        id: 'p:proposed' + st.msg, kind: 'proc', unit: '', at: m.at || 0,
        title: clip(String(st.title || '提议的做法'), 24), body: clip(String(st.body || ''), BODY_CHARS),
        impl: [`证据：消息 ${st.msg}（回答里提的做法，没有任何调用）`, clip(String(st.impl || ''), 300), `原话：${clip(polish(m.text), 300)}`].filter(Boolean).join('\n'),
        note: clip(String(st.note || ''), 120), status: 'proposed', branch: clip(String(st.branch || 'main'), 12),
        mods: [], uses: [], makes: [],
      };
      if (!c.body) c.body = clip(polish(m.text), BODY_CHARS);
      cards.set(c.id, c);
    }
  }
  // 没被分段覆盖的单元：有产出的、失败过的、只提方案的、尾巴上正在做的
  for (const u of ev.units) {
    if (usedUnits.has(u.id)) continue;
    if (!u.calls.length) continue;
    if (!u.outs.length && u.status !== 'failed' && u.status !== 'proposed' && !u.doing) continue;
    addProc(u, null);
  }

  // 8) 分段：按无向连通块，标出哪几段互不相干（不硬连凑成一个整体）
  {
    const ids = [...cards.keys()];
    const adj = new Map(ids.map(i => [i, []]));
    for (const [a, b] of edges) { if (adj.has(a) && adj.has(b) && a !== b) { adj.get(a).push(b); adj.get(b).push(a); } }
    const seen = new Set();
    for (const i of ids) {
      if (seen.has(i)) continue;
      const q = [i]; seen.add(i); const seg = [];
      while (q.length) { const k = q.pop(); seg.push(k); for (const j of adj.get(k) || []) if (!seen.has(j)) { seen.add(j); q.push(j); } }
      segments.push(seg);
    }
  }
  let list = [...cards.values()];
  // 没有任何关系、也没被做出来的卡（只为看一眼而读到的资料）不单独占位
  {
    const linked = new Set();
    for (const [a, b] of edges) { linked.add(a); linked.add(b); }
    list = list.filter(c => linked.has(c.id) || c.status === 'proposed');
  }
  if (list.length > MAX_CARDS) {
    // 到顶：先丢「没找到产出 / 未执行」的尾巴，材料/产物/已完成步骤不动
    const drop = list.filter(c => c.kind === 'proc' && (c.status === 'unfinished' || c.status === 'proposed'));
    const keep = new Set(list.slice(0, MAX_CARDS).map(c => c.id));
    for (const c of drop) keep.delete(c.id);
    problems.push(`卡太多（${list.length}），只画前 ${MAX_CARDS} 张`);
    list = list.filter(c => keep.has(c.id));
  }
  const keep = new Set(list.map(c => c.id));
  const cleanEdges = edges.filter(([a, b]) => keep.has(a) && keep.has(b));
  // 使用次数一律按最终连线重算（同一版本被几次真实加工用到 = 几条「用」边）
  {
    const useCount = new Map();
    for (const [a, , k] of cleanEdges) if (k === 'use') useCount.set(a, (useCount.get(a) || 0) + 1);
    list = list.map(c => {
      if (c.kind === 'proc') return c;
      const n = useCount.get(c.id) || 0;
      const body = n > 1 ? String(c.body).replace(/被用到|被 \d+ 次加工用到/, `被 ${n} 次加工用到`)
        : String(c.body).replace(/被 \d+ 次加工用到/, '被用到');
      return Object.assign({}, c, { uses: n, body });
    });
  }
  // 9) 实体统计（只按真实调用；文字提及不算）
  const entities = {
    materials: [...ev.mats.values()].filter(m => m.uses.length).sort((a, b) => b.uses.length - a.uses.length).slice(0, 8)
      .map(m => ({ name: m.name, n: m.uses.length })),
    paths: [],
    results: [...ev.arts.values()].filter(a => a.versions.length).sort((a, b) => b.versions.length - a.versions.length).slice(0, 8)
      .map(a => ({ name: a.name, n: a.versions.length })),
  };
  const byKind = { in: 0, proc: 0, out: 0 };
  for (const c of list) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
  return {
    schema: 'workflow-studio/live@2',
    conv: ev.conv,
    name: plan && plan.name ? String(plan.name).slice(0, 40) : '',
    summary: plan && plan.summary ? String(plan.summary).slice(0, 120) : '',
    at: ev.at,
    stats: {
      messages: ev.stats.messages, tools: ev.stats.tools, chatter: ev.stats.chatter,
      failed: ev.stats.failed, media: ev.stats.media,
      materials: ev.mats.size, artifacts: ev.arts.size, cards: list.length,
      segments: segments.length, truncated: ev.truncated,
    },
    entities,
    cards: list.map(c => ({
      id: c.id, kind: c.kind, title: c.title, body: c.body, impl: c.impl || '',
      mods: c.mods || [], note: c.note || '', branch: c.branch || 'main',
      status: c.status || '', ver: c.ver || 0, versions: c.versions || 0,
      uses: Array.isArray(c.uses) ? c.uses.length : (c.uses || 0),
      unit: c.unit || '', at: c.at || 0,
    })),
    edges: cleanEdges,
    segments,
    problems,
    evidence: { window: { from: ev.messagesFrom || 0, to: ev.lastId || 0, count: ev.stats.messages }, truncated: ev.truncated },
  };
}

function versionBodyMat(m, v, uses) {
  const bits = [isVideo(m.path) ? '参考视频' : isImage(m.path) ? '参考图' : '参考资料'];
  if (m.versions.length > 1) bits.push(`第 ${v.v} 版`);
  bits.push(uses > 1 ? `被 ${uses} 次加工用到` : '被用到');
  return bits.join(' · ');
}
function versionBodyArt(a, v) {
  const bits = [isVideo(a.path) ? '视频' : isImage(a.path) ? '图' : '文件'];
  if (a.versions.length > 1) bits.push(`第 ${v.v} 版`);
  if (v.ok === false) bits.push('这次没成功');
  else if (v.ok === null) bits.push('还在写，没回结果');
  else bits.push('已完成');
  if (v.unit) bits.push('由这一步产出');
  return bits.join(' · ');
}
function evidenceImpl(path, v, info) {
  const lines = [`证据：消息 ${(info.msg || '')}${v.v ? ' · 第 ' + v.v + ' 版' : ''}${info.how ? ' · ' + info.how : ''}`, `文件：${path}`];
  for (const e of (info.eids || [])) if (e && e !== info.msg) lines.push('相关消息：' + e);
  return lines.join('\n');
}
function procImpl(u, st) {
  const lines = [];
  if (st && st.impl) lines.push(clip(String(st.impl), 600));
  if (u.ask) lines.push(`人说的话（消息 ${u.userMsg}）：${clip(oneLine(u.ask), 300)}`);
  const show = u.calls.slice(0, IMPL_SHOW);
  for (const eid of show) lines.push(eid);
  if (u.calls.length > show.length) lines.push(`…共 ${u.calls.length} 次调用`);
  if (u.status === 'failed') lines.push('这次有调用失败，没有产出');
  if (u.status === 'proposed') lines.push('只在回答里提了做法，没有任何调用');
  return lines.join('\n');
}
function resolveRef(cards, ref) {
  if (!ref) return null;
  if (typeof ref === 'string') {
    const id = ref.trim();
    if (cards.has(id)) return cards.get(id);
    // 允许用「文件名@v2」这种写法
    const m = id.match(/^(.+?)@v(\d+)$/);
    if (m) {
      for (const c of cards.values()) if (c.ver === Number(m[2]) && (c.title === m[1] || c.id.includes(m[1]))) return c;
      return null;
    }
    return null;
  }
  if (typeof ref === 'object') {
    const p = ref.path || ref.file || '';
    const k = pathKey(p);
    const v = Number(ref.ver || ref.version || 1);
    for (const c of cards.values()) if (c.ver === v && c.id.endsWith('@v' + v) && k && (c.impl || '').includes(p)) return c;
    // 用 key@v 也行
    if (ref.key) { const id = ref.key + '@v' + v; if (cards.has(id)) return cards.get(id); }
  }
  return null;
}

// 把消息号范围对上具体单元：范围里所有调用都属于同一单元就用它；跨单元就取范围覆盖到的单元集合
function unitForRange(ev, from, to) {
  const hit = ev.units.filter(u => u.calls.length && u.userMsg >= 0 && u.calls.some(eid => {
    const m = ev.calls.find(c => c.eid === eid);
    return m && m.msg >= from && m.msg <= to;
  }));
  if (!hit.length) return null;
  if (hit.length === 1) return hit[0];
  // 跨多个单元：合并成一个（plan 认为这是一步），调用/材料/产物并起来
  const u = { id: 'p' + from + '_' + to, turn: hit[0].turn, at: hit[0].at, trigger: 'plan', userMsg: hit[0].userMsg,
    calls: [], methods: [], matUses: [], artUses: [], outs: [], writeTries: 0, failed: 0, answer: '', note: '', status: '', doing: false, mergedFrom: hit.map(x => x.id) };
  for (const x of hit) {
    u.calls.push(...x.calls); u.writeTries += x.writeTries; u.failed += x.failed;
    for (const m of x.methods) if (!u.methods.some(y => y.w === m.w)) u.methods.push(m);
    for (const m of x.matUses) if (!u.matUses.some(y => y.key === m.key && y.v === m.v)) u.matUses.push(m);
    for (const m of x.artUses) if (!u.artUses.some(y => y.key === m.key && y.v === m.v)) u.artUses.push(m);
    for (const o of x.outs) if (!u.outs.some(y => y.key === o.key && y.v === o.v)) u.outs.push(o);
    u.answer = u.answer || x.answer; u.ask = u.ask || x.ask;
  }
  if (hit.some(x => x.proposed)) u.proposed = true;
  u.status = u.outs.some(o => o.ok !== false) ? 'done' : u.outs.length ? 'failed' : u.proposed ? 'proposed' : 'unfinished';
  return u;
}

// ---------- 给模型看的证据摘要 ----------
function brief(ev, opts) {
  const maxCalls = (opts && opts.calls) || 130;
  const lines = [];
  lines.push(`【这条对话】${ev.stats.messages} 条消息 · 真实工具调用 ${ev.stats.tools} 次 · 失败 ${ev.stats.failed} 次${ev.truncated ? ' · 只看了最近一段，更早的没看到' : ''}`);
  lines.push('');
  lines.push('人说的话（消息号 · 原话节选）：');
  for (const q of ev.ask.slice(-30)) lines.push(` ${q.msg}｜${clip(q.body || q.text, 100)}`);
  lines.push('');
  lines.push('真实调用（消息号 → 调用；★ = 这次调用的产出在回答里交付了）：');
  const calls = ev.calls.slice(-maxCalls);
  const outByMsg = new Map();
  for (const a of ev.arts.values()) for (const v of a.versions) {
    for (const e of (v.evidence || [])) outByMsg.set(e, (outByMsg.get(e) || []).concat(a.name + ' v' + v.v));
  }
  for (const c of calls) {
    const outs = outByMsg.get(c.msg) || [];
    lines.push(` ${c.msg}｜${c.line}${outs.length ? ' ★产出 ' + outs.join('、') : ''}${c.ok === false ? '（失败）' : ''}`);
  }
  if (ev.calls.length > calls.length) lines.push(` …更早的 ${ev.calls.length - calls.length} 次调用没列出来`);
  lines.push('');
  lines.push('材料与版本（完整路径 · 版本 · 被哪几次加工用到）：');
  for (const m of [...ev.mats.values()].filter(x => x.uses.length)) {
    lines.push(` ${m.path}｜${m.versions.map(v => 'v' + v.v).join('、')}｜${m.uses.length} 次使用`);
  }
  lines.push('');
  lines.push('产物与版本（完整路径 · 版本 · 产出消息）：');
  for (const a of ev.arts.values()) {
    const vs = a.versions.map(v => `v${v.v}@${v.msg}${v.ok === false ? '(失败)' : ''}`).join('、');
    lines.push(` ${a.path}｜${vs}`);
  }
  if (ev.truncated) lines.push('\n注意：历史窗口被截断，更早的材料版本和分支可能没看到——不要补造，缺口在解释里说明。');
  return lines.join('\n');
}

// 对照证据表：源消息/调用 → 材料版本 → 加工 → 产物 → 调整。给验收和 tools/live-evidence.js 用。
function mapping(ev, doc) {
  const rows = [];
  const byId = new Map((doc.cards || []).map(c => [c.id, c]));
  for (const u of ev.units) {
    const pc = (doc.cards || []).find(c => c.kind === 'proc' && (c.unit === u.id || (u.mergedFrom || []).includes(c.unit)));
    if (!pc) continue;
    rows.push({
      step: pc.title,
      证据消息: u.userMsg || '',
      调用: u.calls.slice(0, 6).join(' ') + (u.calls.length > 6 ? ` …共 ${u.calls.length} 次` : ''),
      材料: u.matUses.map(x => `${x.name} v${x.v}`).join('、') || '—',
      产物: u.outs.map(o => `${o.name} v${o.v}${o.ok === false ? '(失败)' : ''}`).join('、') || '—',
      调整原因: pc.note || (u.ask ? clip(u.ask, 60) : '—'),
      状态: statusWord(pc.status) || '完成',
    });
  }
  return { conv: ev.conv, at: ev.at, truncated: ev.truncated, stats: ev.stats, rows };
}

// 布局用：每个节点在第几列（从入口算最长路径；环和孤岛都有兜底，异常图不会卡住）
function layoutColumns(doc) {
  const cards = (doc && doc.cards) || [];
  const ids = cards.map(c => c.id);
  const out = new Map(ids.map(i => [i, []]));
  const indeg = new Map(ids.map(i => [i, 0]));
  for (const [a, b, k] of (doc && doc.edges) || []) {
    if (!out.has(a) || !out.has(b) || a === b) continue;
    if (k === 'evolve' || k === 'revise') continue;     // 版本链和「改」都是回指，不参与列深
    out.get(a).push(b);
    indeg.set(b, (indeg.get(b) || 0) + 1);
  }
  const depth = new Map();
  const q = ids.filter(i => (indeg.get(i) || 0) === 0);
  if (!q.length && ids.length) q.push(ids[0]);
  for (const i of q) depth.set(i, 0);
  let guard = 0;
  while (q.length && guard++ < ids.length * 8 + 2000) {
    const i = q.shift();
    for (const j of out.get(i) || []) {
      const d = (depth.get(i) || 0) + 1;
      if (!depth.has(j) || depth.get(j) < d) { depth.set(j, d); q.push(j); }
    }
  }
  ids.forEach(i => { if (!depth.has(i)) depth.set(i, 0); });
  const max = Math.max(0, ...[...depth.values()]);
  return { depth: Object.fromEntries(depth), columns: max + 1 };
}

module.exports = {
  buildEvidence, buildGraph, brief, mapping, layoutColumns,
  cleanAsk, polish, splitAsk, isChatter, implLine, expandCalls, toolWord, filesInCommand, mediaIn, normPath, pathKey,
  statusWord, MAX_CARDS, MAX_IMPL_LINES,
};
