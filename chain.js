// 只读：把一个 agent 的「工作链路」原料读出来——身份、职责、技能、最近实际干活的记录。
// 不写任何东西：state.db 用只读 URI 打开（sqlite3 -readonly + mode=ro）；不碰 .env / auth.json / 凭据。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const HOME = os.homedir();
const HERMES_HOME = path.join(HOME, '.hermes');
const PROFILES_DIR = path.join(HERMES_HOME, 'profiles');
const BUNDLED_SKILLS = path.join(HERMES_HOME, 'hermes-agent', 'skills');
const SQLITE = fs.existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3';

// 读多少条会话：默认最近 80 条。真干过活（有工具调用）的记录少于 30 次的 agent——它可能只干过两三次活
// ——干活记录容易被一堆闲聊挤出 80 条的窗口，往前多读到 300 条；记录多的照旧 80，不拖慢。
const READ_LIMIT = 80, READ_LIMIT_MORE = 300, READ_WORK_SMALL = 30;

// 工作流开发平台自己发给 agent 的提问——不算它的活，统计时剔掉
// 第一条用通配匹配「我们在工作流…里聊」，新版旧版的措辞都算自己的提问
const STUDIO_PROMPTS = ['我们在工作流%里聊%', '只做评审，不执行%', '你是这条工作流的执行方%', '你是平台主管%', '【读取链路】%'];
const sq = s => "'" + String(s).replace(/'/g, "''") + "'";
// 派活原文里万一贴过密钥，读出来先抹掉
const redact = s => String(s == null ? '' : s)
  .replace(/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, '[已隐去]')
  .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, '$1[已隐去]')
  .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)["']?[^\s"',;]{8,}/gi, '$1[已隐去]');

function chainSQL() {
  const like = STUDIO_PROMPTS.map(p => `content LIKE ${sq(p)}`).join(' OR ');
  return `
WITH ex AS (SELECT DISTINCT session_id FROM messages WHERE role = 'user' AND (${like})),
s AS (SELECT * FROM sessions WHERE id NOT IN (SELECT session_id FROM ex)),
recent AS (SELECT id FROM s ORDER BY started_at DESC LIMIT (CASE WHEN (SELECT count(*) FROM s WHERE tool_call_count > 0) < ${READ_WORK_SMALL} THEN ${READ_LIMIT_MORE} ELSE ${READ_LIMIT} END)),
calls AS (
  SELECT json_extract(j.value, '$.function.name') AS name, json_extract(j.value, '$.function.arguments') AS args
  FROM messages m, json_each(CASE WHEN json_valid(m.tool_calls) THEN m.tool_calls ELSE '[]' END) j
  WHERE m.role = 'assistant' AND m.tool_calls IS NOT NULL AND m.session_id IN (SELECT id FROM recent)
),
c2 AS (SELECT name, CASE WHEN json_valid(args) THEN args END AS a FROM calls)
SELECT json_object(
  'excluded', (SELECT count(*) FROM ex),
  'sessions', (SELECT count(*) FROM s),
  'workSessions', (SELECT count(*) FROM s WHERE tool_call_count > 0),
  'readLimit', (CASE WHEN (SELECT count(*) FROM s WHERE tool_call_count > 0) < ${READ_WORK_SMALL} THEN ${READ_LIMIT_MORE} ELSE ${READ_LIMIT} END),
  'readSessions', (SELECT count(*) FROM recent),
  'toolCalls', (SELECT coalesce(sum(tool_call_count), 0) FROM s),
  'first', (SELECT min(started_at) FROM s),
  'last', (SELECT max(started_at) FROM s),
  'bySource', (SELECT json_group_object(source, c) FROM (SELECT source, count(*) c FROM s GROUP BY source)),
  'tasks', (SELECT json_group_array(json_array(title, source, started_at, tool_call_count)) FROM
    (SELECT title, source, started_at, tool_call_count FROM s
     WHERE tool_call_count > 0 AND title IS NOT NULL AND title != '' ORDER BY started_at DESC LIMIT 40)),
  'samples', (SELECT json_group_array(json_object('title', title, 'src', source, 'calls', tool_call_count, 'ask', ask, 'done', done)) FROM
    (SELECT s.title, s.source, s.tool_call_count,
       (SELECT substr(content, 1, 420) FROM messages WHERE session_id = s.id AND role = 'user' ORDER BY id LIMIT 1) AS ask,
       (SELECT substr(content, 1, 320) FROM messages WHERE session_id = s.id AND role = 'assistant'
          AND content IS NOT NULL AND length(content) > 30 ORDER BY id DESC LIMIT 1) AS done
     FROM s WHERE tool_call_count >= 5 ORDER BY started_at DESC LIMIT 10)),
  'tools', (SELECT json_group_array(json_array(name, c)) FROM
    (SELECT name, count(*) c FROM c2 WHERE name IS NOT NULL GROUP BY name ORDER BY c DESC LIMIT 20)),
  'skills', (SELECT json_group_array(json_array(n, c)) FROM
    (SELECT json_extract(a, '$.name') n, count(*) c FROM c2 WHERE name = 'skill_view' AND a IS NOT NULL
     AND json_extract(a, '$.name') IS NOT NULL GROUP BY n ORDER BY c DESC LIMIT 24)),
  'sendsTo', (SELECT json_group_array(json_array(n, c)) FROM
    (SELECT json_extract(a, '$.target') n, count(*) c FROM c2 WHERE name = 'message_agent' AND a IS NOT NULL
     AND json_extract(a, '$.target') IS NOT NULL GROUP BY n ORDER BY c DESC LIMIT 12)),
  'paths', (SELECT json_group_array(json_array(name, p)) FROM
    (SELECT name, json_extract(a, '$.path') p FROM c2
     WHERE name IN ('read_file', 'write_file', 'patch', 'search_files') AND a IS NOT NULL AND json_extract(a, '$.path') IS NOT NULL LIMIT 5000)),
  'from', (SELECT json_group_array(h) FROM
    (SELECT substr(content, 1, 160) h FROM messages WHERE role = 'user' AND content LIKE 'Message from %'
     AND session_id IN (SELECT id FROM recent) LIMIT 600))
);`;
}

function sqliteJSON(file, sql) {
  const uri = 'file:' + encodeURI(file).replace(/\?/g, '%3F').replace(/#/g, '%23') + '?mode=ro';
  return new Promise(res => {
    execFile(SQLITE, ['-readonly', uri, sql], { timeout: 30000, maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) return res({ error: String(errOut || err.message).trim().slice(0, 300) });
      try { res(JSON.parse(out)); } catch (e) { res({ error: '读出来的不是 JSON' }); }
    });
  });
}

const readText = (p, max = 1e6) => { try { return fs.readFileSync(p, 'utf8').slice(0, max); } catch (e) { return ''; } };
const unq = s => String(s || '').trim().replace(/^['"]|['"]$/g, '');

// profile.yaml 里的显示名 / 部门 / 描述（handle → 人能看懂的名字）
const nameCache = new Map();
function profileMeta(id) {
  if (nameCache.has(id)) return nameCache.get(id);
  if (id === 'hermes' || id === 'default') {                     // 平台主管：profile.yaml 在 ~/.hermes 根上
    const y = readText(path.join(HERMES_HOME, 'profile.yaml'), 20000);
    const desc = unq((y.match(/^description:\s*(.+)$/m) || [])[1]);
    const section = unq((y.match(/^sectionName:\s*(.+)$/m) || [])[1]);   // 配置里没写就不分组，别硬编
    const m = { id, name: '平台主管', section, desc };
    nameCache.set(id, m); return m;
  }
  const y = readText(path.join(PROFILES_DIR, id, 'profile.yaml'), 20000);
  const pick = re => { const m = y.match(re); return m ? unq(m[1]) : ''; };
  const section = pick(/sectionName:\s*(.+)$/m);
  let name = pick(/^display_name:\s*(.+)$/m) || id;
  if (name === '主管' && section) name = section + '主管';             // 好几个部门都叫「主管」，带上部门才分得清
  const desc = pick(/^description:\s*(.+)$/m);
  const m = { id, name, section, desc, gone: !y, stopped: /已停用|decommissioned/i.test(desc) };
  nameCache.set(id, m);
  return m;
}

// 技能目录：找 SKILL.md（最多三层，跳过隐藏目录）；bundled=自带技能，不算它自己的
function readSkillDir(root, shared) {
  const dirs = [];
  const walk = (dir, depth) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    if (ents.some(e => e.isFile() && e.name === 'SKILL.md')) { dirs.push(dir); return; }
    if (depth >= 3) return;
    for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(dir, e.name), depth + 1);
  };
  walk(root, 0);
  const out = [];
  for (const dir of dirs) {
    const rel = path.relative(root, dir);
    if (!shared && fs.existsSync(path.join(BUNDLED_SKILLS, rel, 'SKILL.md'))) continue;
    const md = readText(path.join(dir, 'SKILL.md'), 30000);
    const fm = (md.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
    let desc = unq((fm.match(/^description:[ \t]*(.*)$/m) || [])[1]);
    if (!desc || /^[>|][-+]?$/.test(desc)) {                       // 多行 YAML：取下面缩进的几行
      const blk = fm.match(/^description:[ \t]*[>|]?[-+]?[ \t]*\r?\n((?:[ \t]+.+\r?\n?)+)/m);
      desc = blk ? blk[1].split('\n').map(s => s.trim()).filter(Boolean).join(' ') : '';
    }
    const heads = (md.replace(/^---[\s\S]*?\n---/, '').match(/^#{1,3} .+$/gm) || [])
      .map(h => h.replace(/^#+\s*/, '').trim()).filter(h => !/^(When to Use|何时用|坑|参考)/i.test(h)).slice(0, 8).map(h => h.slice(0, 40));
    // 人能看懂的技能名：取正文第一个标题，去掉里面的代码片段（`some-skill-id` 这种）
    const h1 = ((md.replace(/^---[\s\S]*?\n---/, '').match(/^#{1,2} .+$/m) || [''])[0]).replace(/^#+\s*/, '');
    const title = h1.replace(/[（(][^（()）]*`[^`]*`[^（()）]*[）)]/g, '').replace(/`[^`]*`/g, '')
      .replace(/[（(]\s*[）)]/g, '').replace(/\s*·\s*/g, ' · ').replace(/\s+/g, ' ').trim().slice(0, 24);
    out.push({ name: unq((fm.match(/^name:\s*(.+)$/m) || [])[1]) || path.basename(dir), title, rel, desc: desc.slice(0, 220), heads, shared: !!shared });
  }
  return out;
}
function externalDirs(dir) {
  const y = readText(path.join(dir, 'config.yaml'), 200000);
  const m = y.match(/^skills:[ \t]*\r?\n((?:[ \t]+.*\r?\n?)*)/m);
  if (!m) return [];
  const inline = m[1].match(/external_dirs:[ \t]*\[([^\]]*)\]/);
  let list = [];
  if (inline) list = inline[1].split(',');
  else { const e = m[1].match(/external_dirs:[ \t]*\r?\n((?:[ \t]+-[ \t]*.+\r?\n?)*)/); if (e) list = e[1].split('\n').map(l => l.replace(/^\s*-\s*/, '')); }
  return list.map(unq).filter(Boolean).map(p => p.replace(/^~(?=\/)/, HOME));
}

// 读写过的路径 → 按目录归堆（文件名不要，只留到第 4 层目录）
function bucket(p) {
  let s = String(p || '').trim().replace(/^~(?=\/)/, HOME);
  if (!s) return null;
  if (s.startsWith(HERMES_HOME)) return '（它自己的 Hermes 目录：技能 / 记忆 / 草稿）';
  const abs = s.startsWith('/');
  let seg = s.split('/').filter(Boolean);
  if (seg.length && /\.[\w]{1,6}$/.test(seg[seg.length - 1])) seg = seg.slice(0, -1);   // 去掉文件名
  if (!seg.length) return abs ? '/' : null;
  if (abs && s.startsWith(HOME + '/')) return '~/' + seg.slice(2, 4).join('/');
  return (abs ? '/' : '') + seg.slice(0, abs ? 4 : 2).join('/');
}
const topN = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

async function readChain(id) {
  id = String(id || '');
  if (!/^\w[\w.-]*$/.test(id)) return { ok: false, error: 'agent 名不对：' + id };
  const dir = id === 'default' ? HERMES_HOME : path.join(PROFILES_DIR, id);     // 平台主管的家就是 ~/.hermes 本身
  if (!fs.existsSync(dir)) return { ok: false, error: '找不到这个 agent：' + id };
  const meta = profileMeta(id);
  const soul = redact(readText(path.join(dir, 'SOUL.md'), 7000));

  const dbFile = path.join(dir, 'state.db');
  const db = fs.existsSync(dbFile) ? await sqliteJSON(dbFile, chainSQL()) : {};
  const dbError = db && db.error ? db.error : '';
  // 本次读了多宽：记录少的自动往前多读，日志里留一行，验收和排查都能对上
  const readLimit = db.readLimit || READ_LIMIT, readSessions = db.readSessions || 0, workSessions = db.workSessions || 0;
  console.log(`[读取链路] ${id}：本次读取 ${readSessions} 条 / 上限 ${readLimit}` +
    (readLimit > READ_LIMIT ? `（只有 ${workSessions} 次干活记录，往前多读一些）` : `（干活记录 ${workSessions} 次，照常只读最近 ${READ_LIMIT} 条）`));

  // 上游：谁给它发过活（Message from …(@handle)）+ 会话来源；下游：它 message_agent 过谁
  const up = new Map();
  for (const h of (db.from || [])) { const m = String(h).match(/\(@([\w.-]+)\)/); if (m && m[1] !== id) up.set(m[1], (up.get(m[1]) || 0) + 1); }
  const down = new Map();
  for (const [t, c] of (db.sendsTo || [])) if (t && t !== id) down.set(t, (down.get(t) || 0) + c);
  const who = ([h, c]) => { const m = profileMeta(h); return { id: h, name: m.name, count: c, old: !!(m.gone || m.stopped) }; };

  const reads = new Map(), writes = new Map();
  for (const [tool, p] of (db.paths || [])) {
    const b = bucket(p); if (!b) continue;
    const m = (tool === 'write_file' || tool === 'patch') ? writes : reads;
    m.set(b, (m.get(b) || 0) + 1);
  }

  // 技能：它自己的 + 部门共享目录里的；按实际调用次数排
  const used = new Map((db.skills || []).map(([n, c]) => [n, c]));
  const byName = new Map();
  for (const sk of readSkillDir(path.join(dir, 'skills'), false)) byName.set(sk.name, sk);
  for (const d of externalDirs(dir)) for (const sk of readSkillDir(d, true)) if (!byName.has(sk.name)) byName.set(sk.name, sk);
  const skills = [...byName.values()].map(s => ({ ...s, used: used.get(s.name) || 0 }))
    .sort((a, b) => b.used - a.used || (a.shared - b.shared) || a.name.localeCompare(b.name))
    .filter(s => s.used || !s.shared)                                  // 部门共享但它从没用过的，不算它的链路
    .slice(0, 20);

  const seen = new Set();
  const tasks = (db.tasks || []).filter(([t]) => { const k = String(t).slice(0, 30); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 24).map(([title, src, at, calls]) => ({ title: redact(title).slice(0, 80), src, at, calls }));
  const flat = s => redact(s).replace(/\s+/g, ' ').trim();
  const samples = (db.samples || []).map(x => ({ title: flat(x.title).slice(0, 80), src: x.src, calls: x.calls, ask: flat(x.ask).slice(0, 360), done: flat(x.done).slice(0, 260) }));

  return {
    ok: true, id, name: meta.name, section: meta.section, desc: meta.desc, soul, readAt: Date.now(), dbError,
    stats: { sessions: db.sessions || 0, toolCalls: db.toolCalls || 0, first: db.first || null, last: db.last || null, bySource: db.bySource || {}, excluded: db.excluded || 0,
      workSessions, readLimit, readSessions },
    tasks, samples,
    tools: (db.tools || []).slice(0, 14),
    skills,
    upstream: topN(up, 8).map(who),
    downstream: topN(down, 8).map(who),
    reads: topN(reads, 8), writes: topN(writes, 8),
  };
}

module.exports = { readChain, chainSQL, bucket, redact, PROFILES_DIR, READ_LIMIT, READ_LIMIT_MORE, READ_WORK_SMALL };

// 直接跑：node chain.js <agent>   （打印读到的原料，方便核对；agent 名必须显式给）
if (require.main === module) {
  const who = process.argv[2];
  if (!who) { console.error('usage: node chain.js <agent-id>'); process.exit(1); }
  readChain(who).then(r => { console.log(JSON.stringify(r, null, 1)); });
}
