// 公开仓库内容扫描：部门名 / 岗位名、本机绝对路径、旧项目名 —— 期望 0 命中。
//
//   node tools/scan-public.js          # 0 命中 → 打印 OK，退出码 0；有命中 → 列「文件:行:内容」，退出码 1
//
// 为什么部门名/岗位名不在这个文件里写死：写进来就等于又泄一次。这里在扫描时从本机的
// `~/.hermes/profile.yaml` 与 `~/.hermes/profiles/*/profile.yaml` 现取（目录名 = profile id，
// 也就是真岗位名；display_name = 岗位显示名；sectionName 或 description 开头的「…部 / …团队」= 部门名），
// 拿这些名字去扫仓库。换机器 / 没有 Hermes 时这一类自动跳过，路径与旧项目名照样扫。
//
// 旧项目名和绝对路径的片段拆开拼，免得这个脚本自己命中自己。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git']);
const BIN_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.mp4', '.mov', '.webp', '.ico', '.db', '.sqlite', '.zip']);

// ---------- 1) 固定的两类：本机绝对路径、旧项目名 ----------
const FIXED = [
  ['/' + 'Applications' + '/', '本机绝对路径'],
  ['/' + 'Users' + '/', '本机绝对路径'],
  ['/' + 'Volumes' + '/', '本机绝对路径'],
  ['TC' + '店铺', '旧项目名'],
  ['TC' + ' ' + '工作流' + '台', '旧项目名'],
  ['工作流' + '台', '旧项目名'],          // 旧应用名；现在的名字是「工作流开发平台」
];

// ---------- 2) 部门名 / 岗位名：从本机 profile 现取 ----------
function localNames() {
  const names = new Set();
  const home = path.join(os.homedir(), '.hermes');
  const profiles = path.join(home, 'profiles');
  const add = (s, min) => { const v = String(s == null ? '' : s).trim().replace(/^["']|["']$/g, ''); if (v.length >= min) names.add(v); };
  const line = (yaml, key) => { const m = yaml.match(new RegExp('^' + key + ':\\s*(.+)$', 'm')); return m ? m[1].trim() : ''; };
  const take = (yaml, id) => {
    add(id, 3);                                                  // 目录名 / profile id
    add(line(yaml, 'display_name'), 3);                          // 「主管」「执行」这种两个字的通用词会误伤正文，跳过
    add(line(yaml, 'sectionName'), 2);                           // 部门名
    const desc = line(yaml, 'description');
    const dept = (desc.match(/^(.{2,14}?(?:部|团队))/) || [])[1]; // description 开头那段就是部门名（「××部 · …」「××团队…」）
    if (dept) add(dept, 2);
  };
  try { const y = fs.readFileSync(path.join(home, 'profile.yaml'), 'utf8'); take(y, ''); } catch (e) { }
  let dirs = [];
  try { dirs = fs.readdirSync(profiles, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch (e) { }
  for (const id of dirs) {
    try { take(fs.readFileSync(path.join(profiles, id, 'profile.yaml'), 'utf8'), id); } catch (e) { }
  }
  return [...names];
}

const NAMES = localNames();
// ascii 的按整词匹配（\b），中文的直接包含匹配
const nameHit = text => NAMES.filter(n => /^[\x20-\x7e]+$/.test(n)
  ? new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text)
  : text.includes(n));

// ---------- 3) 走仓库 ----------
const hits = [];
function check(where, text) {
  for (const [needle, kind] of FIXED) if (text.includes(needle)) hits.push({ where, kind, what: needle });
  for (const n of nameHit(text)) hits.push({ where, kind: '部门名/岗位名', what: n });
}
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(ROOT, p);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); continue; }
    // 文件名也算公开内容：旧项目名曾经写在启动脚本的文件名上
    check(rel, rel);
    if (BIN_EXT.has(path.extname(e.name).toLowerCase())) continue;
    let text = '';
    try { text = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
    text.split('\n').forEach((line, i) => check(rel + ':' + (i + 1), line));
  }
}
walk(ROOT);

// ---------- 4) 报告 ----------
const uniq = [...new Map(hits.map(h => [h.where + '|' + h.kind + '|' + h.what, h])).values()];
console.log(`扫描 ${path.basename(ROOT)}：部门/岗位名 ${NAMES.length} 个（本机现取）、路径与旧项目名 ${FIXED.length} 条`);
if (!uniq.length) { console.log('OK 0 命中'); process.exit(0); }
for (const h of uniq.slice(0, 200)) console.log(`${h.where}  [${h.kind}] ${h.what}`);
console.log(`\n${uniq.length} 处命中`);
process.exit(1);
