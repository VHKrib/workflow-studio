// 跨平台解析的单测：不依赖 Electron，直接断言各平台的结果
const assert = require('assert');
const { hermesBin, sqliteBin, modKey } = require('../platform');

// --- hermes：mac 上文件存在 → 用绝对路径、不开 shell
let r = hermesBin({ platform: 'darwin', home: '/home/demo', exists: p => p === '/home/demo/.hermes/hermes-agent/.hermes/bin/hermes' });
assert.strictEqual(r.cmd, '/home/demo/.hermes/hermes-agent/.hermes/bin/hermes');
assert.strictEqual(r.shell, false);

// --- hermes：Windows 上有 .cmd → 取 .cmd，并且必须借 shell
r = hermesBin({ platform: 'win32', home: 'C:\\demo', exists: p => p.endsWith('hermes.cmd') });
assert.ok(r.cmd.endsWith('hermes.cmd'), 'win32 应该优先 .cmd，实际 ' + r.cmd);
assert.strictEqual(r.shell, true);

// --- hermes：Windows 上什么都不存在 → 退回 PATH 里的 hermes.cmd，仍开 shell
r = hermesBin({ platform: 'win32', home: 'C:\\demo', exists: () => false });
assert.strictEqual(r.cmd, 'hermes.cmd');
assert.strictEqual(r.shell, true);

// --- hermes：linux 上不存在 → PATH 里的 hermes，不开 shell
r = hermesBin({ platform: 'linux', home: '/home/x', exists: () => false });
assert.strictEqual(r.cmd, 'hermes');
assert.strictEqual(r.shell, false);

// --- sqlite：mac 有 /usr/bin/sqlite3
assert.strictEqual(sqliteBin({ platform: 'darwin', exists: p => p === '/usr/bin/sqlite3' }), '/usr/bin/sqlite3');
// --- sqlite：mac 没有 → PATH
assert.strictEqual(sqliteBin({ platform: 'darwin', exists: () => false }), 'sqlite3');
// --- sqlite：Windows 装了常见路径
assert.strictEqual(
  sqliteBin({ platform: 'win32', exists: p => p === 'C:\\Program Files\\sqlite3\\sqlite3.exe' }),
  'C:\\Program Files\\sqlite3\\sqlite3.exe'
);
// --- sqlite：Windows 没装 → sqlite3.exe（走 PATH，找不到时调用方要能兜住错误）
assert.strictEqual(sqliteBin({ platform: 'win32', exists: () => false }), 'sqlite3.exe');

// --- 快捷键文案
assert.strictEqual(modKey('darwin'), '⌘');
assert.strictEqual(modKey('win32'), 'Ctrl+');
assert.strictEqual(modKey('linux'), 'Ctrl+');


console.log('platform checks: 10 passed');
