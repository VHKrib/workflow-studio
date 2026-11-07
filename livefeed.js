// 只读读别人的会话库：列「最近有活动的对话」、按 id 读增量消息。
//
// 硬边界（验收会专门查）：
// - 会话库只用 `sqlite3 -readonly` + `file:…?mode=ro` 打开，任何情况下不写；
// - 只跑 SELECT（`assertSelect()` 拦死写语句），只读最近 N 条，不把整库拉进内存；
// - 列表只给「谁 / 什么时候 / 在做什么」三样，不吐私聊正文。
//
// 数据在哪：`<root>/state.db`（平台主管 default）+ `<root>/profiles/<岗位>/state.db`，两张表 sessions / messages。
// `<root>` 默认是本机的 Hermes 目录；`WF_LIVE_DIR` 只给验收指到临时样本库（界面没有开关）。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SQLITE = fs.existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3';
const ROOT = process.env.WF_LIVE_DIR ? path.resolve(process.env.WF_LIVE_DIR) : path.join(os.homedir(), '.hermes');
const PROFILES = path.join(ROOT, 'profiles');

const LIST_LIMIT = 40;        // 列表最多 40 条「最近有活动的对话」
const LIST_PER_PROFILE = 6;   // 每个岗位最近的几条一定留着：别的岗位再热闹，也不把自己的最近对话挤出去
const LIST_DAYS = 14;         // 只看最近 14 天动过的
const LIST_PER_DB = 12;       // 每个岗位最多取 12 条，再跨岗位合并排序
const MSG_LIMIT = 200;        // 初次读最近 200 条；之后每次增量最多 200 条
const EV_TEXT = 4000;         // 一条消息正文最多读 4000 字（实测有 926 字的结果，600 字会把尾巴切掉）
const EV_CALLS = 30000;       // 一条消息里的工具参数最多读 30000 字（实测单个 write_file 参数 8836 字；
                              // 截断会把 JSON 解析失败、整条调用丢掉，产物就没了）

const sq = s => "'" + String(s).replace(/'/g, "''") + "'";
const WRITE_WORD = /\b(insert|update|delete|drop|alter|create|attach|detach|replace|pragma|vacuum|reindex|begin|commit)\b/i;

// 只允许 SELECT / WITH；我们自己拼的 SQL，出一点偏差就当场拒掉，不让它碰到库
function assertSelect(sql) {
  const s = String(sql || '').trim();
  if (!/^(select|with)\b/i.test(s)) throw new Error('只读：只允许 SELECT');
  if (s.replace(/;\s*$/, '').includes(';')) throw new Error('只读：只允许一条语句');
  if (WRITE_WORD.test(s)) throw new Error('只读：SQL 里出现写操作');
  return s;
}

function roURI(file) {
  const enc = encodeURI(file).replace(/\?/g, '%3F').replace(/#/g, '%23');
  return 'file:' + enc + '?mode=ro';
}

function query(file, sql, timeout = 6000) {
  const q = assertSelect(sql);
  return new Promise(resolve => {
    execFile(SQLITE, ['-readonly', roURI(file), q], { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) return resolve({ error: String(errOut || err.message).trim().slice(0, 240) });
      const text = String(out || '').trim() || '[]';
      try { resolve({ rows: JSON.parse(text) }); }
      catch (e) { resolve({ error: '读出来的不是 JSON' }); }
    });
  });
}

const safeName = s => /^[A-Za-z0-9._-]{1,200}$/.test(String(s || ''));
const dbOf = profile => (profile === 'default' ? path.join(ROOT, 'state.db') : path.join(PROFILES, String(profile || ''), 'state.db'));

// 岗位显示名：谁（default 是平台主管；别的读 profile.yaml 的 display_name，读不到就用目录名）
const nameCache = new Map();
function whoOf(profile) {
  if (nameCache.has(profile)) return nameCache.get(profile);
  let name = profile;
  try {
    const y = fs.readFileSync(profile === 'default' ? path.join(ROOT, 'profile.yaml') : path.join(PROFILES, profile, 'profile.yaml'), 'utf8');
    const m = y.match(/^display_name:\s*(.+)$/m);
    name = (m ? m[1] : profile).trim().replace(/^["']|["']$/g, '') || profile;
  } catch (e) { }
  if (profile === 'default' && (name === 'default' || !name)) name = '平台主管';
  nameCache.set(profile, name);
  return name;
}

// 列表三栏里的「在做什么」：会话标题就是它自己生成的那句人话；没有就用最近活动描述
function doingOf(s) {
  const t = String(s.title || '').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
  const d = String(s.last_activity_description || '').replace(/\s+/g, ' ').trim();
  const v = t || d || '直接对话';
  return v.length > 34 ? v.slice(0, 33) + '…' : v;
}

// 跨岗位的「最近有活动的对话」——谁 / 什么时候 / 在做什么，就这三样
async function listConversations() {
  const now = Date.now() / 1000;
  const cutoff = now - LIST_DAYS * 86400;
  const dbs = [{ profile: 'default', file: path.join(ROOT, 'state.db') }];
  let dirs = [];
  try { dirs = fs.readdirSync(PROFILES, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort(); } catch (e) { }
  for (const id of dirs) if (safeName(id)) dbs.push({ profile: id, file: path.join(PROFILES, id, 'state.db') });

  const rows = [];
  await Promise.all(dbs.map(async db => {
    let st;
    try { st = fs.statSync(db.file); } catch (e) { return; }
    if (st.mtimeMs / 1000 < cutoff) return;                       // 这半个月没动过的库，连开都不开
    const sql = `SELECT json_group_array(json_object(
        'id', id, 'title', title, 'source', source, 'profile_name', profile_name,
        'at', last_activity_at, 'doing', last_activity_description,
        'msgs', message_count, 'tools', tool_call_count))
      FROM (SELECT * FROM sessions
            WHERE coalesce(last_activity_at, ended_at, started_at) > ${Math.floor(cutoff)}
              AND coalesce(message_count, 0) >= 3          -- 一问一答的临时会话（多半是我们自己分析时开的）不列出来
              AND coalesce(source, '') <> 'workflow-studio'
            ORDER BY coalesce(last_activity_at, ended_at, started_at) DESC LIMIT ${LIST_PER_DB})`;
    const r = await query(db.file, sql);
    if (r.error || !Array.isArray(r.rows)) return;
    for (const s of r.rows) {
      if (!s || !s.id) continue;
      rows.push({
        key: db.profile + ':' + s.id,
        profile: db.profile,
        session: String(s.id),
        who: whoOf(db.profile),
        at: Math.round((Number(s.at) || 0) * 1000),
        doing: doingOf(s),
        messages: Number(s.msgs) || 0,
        tools: Number(s.tools) || 0,
        live: now - (Number(s.at) || 0) < 120,                     // 两分钟内还在动 = 正在跑
      });
    }
  }));
  rows.sort((a, b) => b.at - a.at);
  // 跨岗位合并后按时间取前 N 条会把某些岗位最近的对话挤出去（实测：某岗位最新一条排在 41 位）。
  // 先保证每个岗位最近的几条都在，再按时间把剩下的填满，最后整体按时间排。
  const picked = [], rest = [], seenN = new Map();
  for (const r of rows) {
    const n = seenN.get(r.profile) || 0;
    if (n < LIST_PER_PROFILE) { picked.push(r); seenN.set(r.profile, n + 1); }
    else rest.push(r);
  }
  const out = picked.concat(rest).slice(0, LIST_LIMIT);
  out.sort((a, b) => b.at - a.at);
  return out;
}

function parseCalls(raw) {
  if (!raw) return [];
  let arr;
  try { arr = JSON.parse(raw); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const c of arr) {
    const fn = (c && c.function) || {};
    let args = fn.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e) { args = { raw: String(args).slice(0, 400) }; } }
    if (!fn.name) continue;
    out.push({ callId: String(c.id || c.call_id || ''), name: String(fn.name), args: args && typeof args === 'object' ? args : {} });
  }
  return out;
}

// 工具结果是不是报错（只看开头那 600 字，够判断了）
function toolFailed(content) {
  const s = String(content || '');
  return /"success"\s*:\s*false/.test(s) || /^\s*\{\s*"error"/.test(s) || /"is_error"\s*:\s*true/.test(s)
    || /^Error[:：]/.test(s.trim()) || /"exit_code"\s*:\s*[1-9]/.test(s) || /\bTraceback \(most recent call last\)/.test(s);
}

function normRow(m) {
  const tools = m.role === 'assistant' ? parseCalls(m.tool_calls) : [];
  const rawCalls = String(m.tool_calls || '').trim();
  return {
    id: Number(m.id) || 0,
    role: String(m.role || ''),
    at: Math.round((Number(m.at) || 0) * 1000),
    text: m.role === 'assistant' || m.role === 'user' ? String(m.content || '') : '',
    tools,
    toolName: m.tool_name || '',
    toolCallId: m.tool_call_id || '',
    ok: m.role === 'tool' ? !toolFailed(m.content) : undefined,
    result: m.role === 'tool' ? String(m.content || '') : '',
    // 超出读取上限 / JSON 读不出来：这一条里的产出可能没算到，要如实标出来，不能当「没有产出」
    cut: Number(m.tc_len) > EV_CALLS || Number(m.ct_len) > EV_TEXT,
    broken: m.role === 'assistant' && !!rawCalls && rawCalls !== '[]' && !tools.length,
  };
}

// 窗口是从中间截的：把这条时间线开头那句要求补回来，免得画布第一张是「跑命令」而不是「人要什么」。
// 往前找最近几条 user 消息，由调用方挑第一条真的是人话的（技能正文、系统注入那种不算）。
async function askCandidates(profile, session, beforeId, limit = 8) {
  if (!safeName(profile) || !safeName(session) || !beforeId) return [];
  const file = dbOf(profile);
  const cols = `id, role, tool_name, tool_call_id, substr(coalesce(content,''),1,${EV_TEXT}) AS content, substr(coalesce(tool_calls,''),1,${EV_CALLS}) AS tool_calls, length(coalesce(content,'')) AS ct_len, length(coalesce(tool_calls,'')) AS tc_len, timestamp`;
  const sql = `SELECT json_group_array(json_object('id',id,'role',role,'tool_name',tool_name,'tool_call_id',tool_call_id,'content',content,'tool_calls',tool_calls,'ct_len',ct_len,'tc_len',tc_len,'at',timestamp))
    FROM (SELECT ${cols} FROM messages WHERE session_id = ${sq(session)} AND id < ${Math.floor(beforeId)} AND role = 'user' ORDER BY id DESC LIMIT ${Math.floor(limit) || 8})`;
  const r = await query(file, sql);
  if (r.error || !Array.isArray(r.rows)) return [];
  return r.rows.map(normRow).sort((a, b) => b.id - a.id);
}

// 读一个会话的消息：初次读最近 N 条（升序返回），之后按 id 增量；
// oldest=true 时从最早的一条开始读（离线样本验证用，界面上不用）。
async function readMessages(profile, session, afterId = 0, opts = {}) {
  if (!safeName(profile) || !safeName(session)) return { error: '会话标识不合法' };
  const file = dbOf(profile);
  try { fs.accessSync(file, fs.constants.R_OK); } catch (e) { return { error: '会话库不可读：' + profile }; }
  const cols = `id, role, tool_name, tool_call_id, substr(coalesce(content,''),1,${EV_TEXT}) AS content, substr(coalesce(tool_calls,''),1,${EV_CALLS}) AS tool_calls, length(coalesce(content,'')) AS ct_len, length(coalesce(tool_calls,'')) AS tc_len, timestamp`;
  const pick = `SELECT json_group_array(json_object('id',id,'role',role,'tool_name',tool_name,'tool_call_id',tool_call_id,'content',content,'tool_calls',tool_calls,'ct_len',ct_len,'tc_len',tc_len,'at',timestamp)) FROM (`;
  const sql = afterId
    ? pick + `SELECT ${cols} FROM messages WHERE session_id = ${sq(session)} AND id > ${Math.floor(afterId)} ORDER BY id LIMIT ${MSG_LIMIT})`
    : opts.oldest
      ? pick + `SELECT ${cols} FROM messages WHERE session_id = ${sq(session)} ORDER BY id ASC LIMIT ${Math.floor(opts.limit) || MSG_LIMIT})`
      : pick + `SELECT ${cols} FROM messages WHERE session_id = ${sq(session)} ORDER BY id DESC LIMIT ${MSG_LIMIT})`;
  const r = await query(file, sql);
  if (r.error) return { error: r.error };
  let rows = Array.isArray(r.rows) ? r.rows : [];
  rows.sort((a, b) => (a.id || 0) - (b.id || 0));
  const msgs = rows.map(normRow);
  return { msgs, file, initial: !afterId, limit: MSG_LIMIT };
}

module.exports = { ROOT, LIST_LIMIT, MSG_LIMIT, listConversations, readMessages, askCandidates, whoOf, dbOf, roURI, assertSelect, EV_TEXT, EV_CALLS, normRow };
