// 公开仓库内容扫描：部门名 / 岗位名、本机绝对路径、旧项目名 —— 期望 0 命中。
//
//   node tools/scan-public.js          # 0 命中 → 退出码 0；有命中 → 每条一行「文件:行  [类别] 命中内容」，退出码 1
//
// 扫的是「推上去的东西」，所以只认 git 里被跟踪的内容：
//   - 清单来自 `git ls-files -s -z`（被 gitignore 的 .archive/、node_modules、preview.png 等根本不参与，
//     不会再有旧备份造成的误报把真命中埋掉）；
// 正文取 **暂存区里的那份 blob**（`git cat-file --batch`）—— 也就是这次提交会推上去的字节；
// 如果同一个文件在工作区里还有没 add 的改动，也一并扫一遍。两份合起来才敢说「0 命中 = 推上去是干净的」：
// 只扫暂存区，会漏掉「改了还没 add」的路径；只扫工作区，又会把没打算提交的改动算成命中。
//
// 软链单独查（曾经漏过一条 node_modules 软链，120000 对象的目标就是本机绝对路径，普通 grep 读不到）：
//   对每条模式为 120000 的条目取目标字符串，**只要目标是绝对路径就一律算命中**（哪怕路径里没有敏感词：
//   公开仓库不该有指向某人机器的链接）；目标里出现部门名/岗位名/旧项目名也按同一套规则报。
//
// 为什么部门名/岗位名不在这个文件里写死：写进来就等于又泄一次。这里在扫描时从本机的
// `~/.hermes/profile.yaml` 与 `~/.hermes/profiles/*/profile.yaml` 现取（目录名 = profile id，
// 也就是真岗位名；display_name = 岗位显示名；sectionName 或 description 开头的「…部 / …团队」= 部门名），
// 拿这些名字去扫仓库。换机器 / 没有 Hermes 时这一类自动跳过，路径与旧项目名照样扫。
//
// 旧项目名和绝对路径的片段拆开拼，免得这个脚本自己命中自己。
// 不联网、不调模型、只读 git（不写索引、不改工作区）。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.mp4', '.mov', '.webp', '.ico', '.db', '.sqlite', '.zip']);
const KIND_ABS = '软链目标含绝对路径';
const KIND_NAME = '部门名/岗位名';

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

// ---------- 3) 命中收集 ----------
const hits = [];
const add = (where, kind, what) => hits.push({ where, kind, what });
function checkText(where, text) {
  for (const [needle, kind] of FIXED) if (text.includes(needle)) add(where, kind, needle);
  for (const n of nameHit(text)) add(where, KIND_NAME, n);
}
const clip = s => (s.length > 160 ? s.slice(0, 160) + '…' : s);

// ---------- 4) 取 git 里被跟踪的全部条目（模式 + blob 正文）----------
function git(args, input) {
  return execFileSync('git', args, { cwd: ROOT, input: input, maxBuffer: 1 << 28 });
}

let entries = [];                                            // [{path, mode, sha}]
try {
  const raw = git(['ls-files', '-s', '-z']).toString('utf8');
  for (const rec of raw.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, sha] = rec.slice(0, tab).split(' ');
    entries.push({ mode: mode, sha: sha, path: rec.slice(tab + 1) });
  }
} catch (e) {
  console.error('scan-public: 取不到 git 跟踪清单（要在 git 仓库里跑）：' + e.message);
  process.exit(2);
}

// 一次 cat-file --batch 取回所有 blob（同一 sha 只取一次）
const blobs = new Map();
const shas = [...new Set(entries.filter(e => e.mode !== '160000').map(e => e.sha))];
if (shas.length) {
  const out = git(['cat-file', '--batch'], shas.join('\n') + '\n');
  let pos = 0;
  for (const sha of shas) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = out.slice(pos, nl).toString('utf8');
    const parts = header.split(' ');
    if (parts.length < 3 || parts[1] === 'missing') { pos = nl + 1; continue; }   // 空对象/缺失：跳过
    const size = Number(parts[2]);
    blobs.set(sha, out.slice(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;                                                       // 正文后面的换行
  }
}

// ---------- 5) 逐条扫：文件名 / 正文 / 软链目标 ----------
function scanContent(p, buf) {
  if (BIN_EXT.has(path.extname(p).toLowerCase())) {
    // 二进制文件只查固定的路径/旧项目名（中文在二进制里不会是干净的 utf8，照样尝试但不强求）
    const raw = buf.toString('latin1');
    for (const [needle, kind] of FIXED) {
      const at = raw.indexOf(needle);
      if (at >= 0) add(p + ':' + (raw.slice(0, at).split('\n').length), kind, needle);
    }
    return;
  }
  buf.toString('utf8').split('\n').forEach((ln, i) => checkText(p + ':' + (i + 1), ln));
}

let links = 0;
for (const e of entries) {
  const p = e.path;
  checkText(p, p);                                            // 文件名也算公开内容：旧项目名曾经写在启动脚本的文件名上

  if (e.mode === '160000') continue;                          // 子模块只有一个 commit 号，没有内容可读
  const buf = blobs.get(e.sha);
  if (!buf) continue;

  if (e.mode === '120000') {
    links++;
    const target = buf.toString('utf8').replace(/\r?\n$/, '');
    if (!target) continue;
    if (target.startsWith('/')) add(p + ':1', KIND_ABS, clip(target));   // 绝对路径：一律命中
    checkText(p + ':1', target);                                       // 目标里的部门名/旧项目名照扫
    continue;
  }

  // 正文：先扫暂存区那份（= 这次会推上去的字节），工作区里还有没 add 的改动时再扫一遍
  scanContent(p, buf);
  try {
    const abs = path.join(ROOT, p);
    if (fs.lstatSync(abs).isFile()) {
      const local = fs.readFileSync(abs);
      if (!local.equals(buf)) scanContent(p, local);
    }
  } catch (e) { /* 工作区里删掉了 / 读不了：暂存区那份已经扫过 */ }
}

// ---------- 6) 报告 ----------
const uniq = [...new Map(hits.map(h => [h.where + '|' + h.kind + '|' + h.what, h])).values()]
  .sort((a, b) => (a.where < b.where ? -1 : a.where > b.where ? 1 : 0));
console.log(`扫描 workflow-studio：git 跟踪 ${entries.length} 个文件（其中软链 ${links} 个）、`
  + `部门/岗位名 ${NAMES.length} 个（本机现取）、路径与旧项目名 ${FIXED.length} 条`);
if (!uniq.length) { console.log('0 命中'); process.exit(0); }
for (const h of uniq.slice(0, 200)) console.log(`${h.where}  [${h.kind}] ${h.what}`);
if (uniq.length > 200) console.log(`… 另有 ${uniq.length - 200} 处未列出`);
console.log(`\n${uniq.length} 处命中`);
process.exit(1);
