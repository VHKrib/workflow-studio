// 跨平台小工具：外部命令的位置、快捷键文案。
// 之所以单独成文件，是为了能脱离 Electron 直接跑测试（tools/test-platform.js）。
const os = require('os');
const fs = require('fs');
const path = require('path');

// hermes CLI：posix 是 ~/.hermes/hermes-agent/.hermes/bin/hermes；Windows 上通常是 hermes.cmd
function hermesBin({ platform = process.platform, home = os.homedir(), exists = fs.existsSync } = {}) {
  const base = path.join(home, '.hermes', 'hermes-agent', '.hermes', 'bin', 'hermes');
  const cands = platform === 'win32'
    ? [base + '.cmd', base + '.exe', base + '.bat', base]
    : [base];
  for (const c of cands) if (exists(c)) return { cmd: c, shell: platform === 'win32' };
  // 找不到就交给 PATH；Windows 上 .cmd/.bat 必须借 shell 才能 execFile
  return { cmd: platform === 'win32' ? 'hermes.cmd' : 'hermes', shell: platform === 'win32' };
}

// sqlite3：mac/linux 常用 /usr/bin/sqlite3；Windows 一般不在 PATH，先看两个常见安装位置
function sqliteBin({ platform = process.platform, exists = fs.existsSync } = {}) {
  if (platform === 'win32') {
    const cands = [
      'C:\\Program Files\\sqlite3\\sqlite3.exe',
      'C:\\sqlite3\\sqlite3.exe',
      path.join(os.homedir(), 'sqlite3.exe'),
    ];
    for (const c of cands) if (exists(c)) return c;
    return 'sqlite3.exe';
  }
  return exists('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3';
}

// 快捷键文案：mac 用 ⌘，其它平台 Ctrl+
function modKey(platform = process.platform) { return platform === 'darwin' ? '⌘' : 'Ctrl+'; }

// 把界面里写死的 Mac 快捷键文案换成当前平台的写法（只动 title 与文本里的 ⌘）
function localizeKeyLabels(doc, platform = process.platform) {
  const mac = platform === 'darwin';
  const fix = t => String(t).replace(/⇧⌘/g, mac ? '⇧⌘' : 'Shift+Ctrl+').replace(/⌘/g, mac ? '⌘' : 'Ctrl+');
  doc.querySelectorAll('[title]').forEach(el => {
    const t = el.getAttribute('title');
    if (t && t.indexOf('⌘') >= 0) el.setAttribute('title', fix(t));
  });
  return mac ? '⌘' : 'Ctrl+';
}

module.exports = { hermesBin, sqliteBin, modKey, localizeKeyLabels };
