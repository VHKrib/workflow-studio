// 在跑着的工作流开发平台实例里求值一段表达式，**支持 await**（tools/eval.js 只能同步求值）。
//
//   node skills/workflow-studio/scripts/cdp-await.js probe.js      # 探针写成文件，免得被 shell 引号咬
//   node skills/workflow-studio/scripts/cdp-await.js "await chatSend('这张卡缺什么')"
//
// 页面里抛错会把错误打出来（exit 2），不会再看到莫名其妙的 `{}`。
// 探针请自成一体：自己 openCard(flow().nodes[i]) 再断言，别依赖上一次调用留下的 selId。
const fs = require('fs');
const http = require('http');

const PORT = process.env.CDP_PORT || 9222;
const arg = process.argv[2];
if (!arg) { console.error('usage: node cdp-await.js <probe.js | "expression">'); process.exit(1); }
const expr = fs.existsSync(arg) ? fs.readFileSync(arg, 'utf8') : arg;

const get = url => new Promise((res, rej) => {
  http.get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});

(async () => {
  const targets = await get(`http://127.0.0.1:${PORT}/json/list`);
  const t = targets.find(x => x.type === 'page');
  if (!t) { console.error('no page target — 先启动 electron --remote-debugging-port=' + PORT); process.exit(1); }

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (method, params = {}) => new Promise(r => {
    const mid = ++id; pending.set(mid, r);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  await new Promise(r => ws.addEventListener('open', r));

  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  ws.close();

  if (res && res.exceptionDetails) {
    const ex = res.exceptionDetails.exception || {};
    console.error('PAGE ERROR:', String(ex.description || res.exceptionDetails.text || '').split('\n').slice(0, 5).join('\n'));
    process.exit(2);
  }
  const v = res && res.result ? res.result.value : undefined;
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
