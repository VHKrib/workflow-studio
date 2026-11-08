/**
 * 在已开的 Electron 窗口里执行一段表达式（探针用）。
 * 目的是把带反引号、${}、中文和引号的表达式从 shell 转义里拿出来：
 * 表达式写成文件，这里只负责连 CDP 和打印结果。
 *
 * 用法：
 *   node cdp-eval.js --port 9335 --page live.html --expr-file /tmp/expr.js
 *   node cdp-eval.js --port 9222 --page index.html --expr "JSON.stringify({n:document.querySelectorAll('.node').length})"
 * 参数：
 *   --port       调试端口（用户的窗口是 9222，自己的隔离实例用 9333/9334/9335）
 *   --page       页面 URL 里的片段，如 live.html / index.html
 *   --expr-file  表达式文件（与 --expr 二选一）
 *   --expr       直接给表达式（简单的一行才用，长的写文件）
 *   --wait       连上后先等多少毫秒再执行（默认 0）
 */
'use strict';
const fs = require('fs');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const port = arg('port', '9222');
const page = arg('page', '');
const wait = Number(arg('wait', '0')) || 0;
const expr = arg('expr-file') ? fs.readFileSync(arg('expr-file'), 'utf8') : arg('expr', '');
if (!expr) { console.error('缺少表达式：--expr-file 或 --expr'); process.exit(2); }

const get = url => new Promise((res, rej) =>
  require('http').get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));

(async () => {
  const targets = await get(`http://127.0.0.1:${port}/json`);
  const t = targets.find(x => x.type === 'page' && String(x.url).includes(page));
  if (!t) {
    console.error(`(端口 ${port} 上没有包含「${page}」的页面；现有：${targets.filter(x => x.type === 'page').map(x => String(x.url).split('/').pop()).join(', ') || '无'})`);
    process.exit(1);
  }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  await new Promise(r => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  if (wait) await new Promise(r => setTimeout(r, wait));
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    console.error('ERR ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    process.exit(1);
  }
  const v = r.result.value;
  console.log(typeof v === 'string' ? v : JSON.stringify(v));
  process.exit(0);
})().catch(e => { console.error('ERR ' + (e && e.message || e)); process.exit(1); });
