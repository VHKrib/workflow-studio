// 用 CDP 抓 Electron 应用窗口截图（Node 24 自带 WebSocket）
//   CDP_PORT=9333 node tools/shot.js        # 端口从环境变量取；不写就是 9222
// 存到仓库根目录的 preview.png（不进 git）
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.CDP_PORT || 9222);
const OUT = path.join(__dirname, '..', 'preview.png');

function listTargets() {
  return new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${PORT}/json/list`, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b)));
    }).on('error', rej);
  });
}

(async () => {
  const targets = await listTargets();
  const t = targets.find(x => x.type === 'page');
  if (!t) { console.error('no page'); process.exit(1); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id; pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  await new Promise(r => ws.addEventListener('open', r));
  // 窗口尺寸
  const metrics = await send('Runtime.evaluate', { expression: 'JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio,nodes:document.querySelectorAll(".node").length,agents:document.querySelectorAll(".agent").length,btn:document.querySelector("#btnRun")?.textContent})', returnByValue: true });
  console.log('METRICS', metrics.result.value);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('saved ' + OUT + ' (port ' + PORT + ')');
  ws.close();
  process.exit(0);
})();
