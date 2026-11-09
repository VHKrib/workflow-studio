// 连线的「拖动不重算弯度」验证：在隔离窗口里灌假 doc，拖一张卡，比较拖动前后控制点偏移
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();
setTimeout(() => { console.log('TIMEOUT'); app.exit(2); }, 60000);

const ROOT = process.env.WF_ROOT || path.join(__dirname, '..');
const PAGE = 'file://' + path.join(ROOT, 'renderer', 'live.html') + '#selftest';

const parseD = d => {
  const m = /M([-\d.]+),([-\d.]+) C([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+)/.exec(d || '');
  if (!m) return null;
  const [x1, y1, c1x, c1y, c2x, c2y, x2, y2] = m.slice(1).map(Number);
  return { x1, y1, x2, y2, c1x, c1y, c2x, c2y, dx1: +(c1x - x1).toFixed(2), dx2: +(x2 - c2x).toFixed(2) };
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1600, height: 1000, show: false, backgroundColor: '#f5f3ef',
    webPreferences: {
      preload: path.join(ROOT, 'tools', 'test-stub-preload.js'),
      contextIsolation: true
    }
  });
  await win.loadURL(PAGE);
  await new Promise(r => setTimeout(r, 1200));

  const ev = async expr => {
    const r = await win.webContents.executeJavaScript(expr, true);
    return r;
  };
  const hook = await ev('!!window.__lc');
  console.log('hook', hook);
  if (!hook) { console.log('NO_HOOK'); app.exit(3); return; }

  const doc = {
    conv: { key: 'dragtest:1', who: '测试' }, name: '拖动测试',
    cards: [
      { id: 'a', kind: 'in', title: '输入', body: '一句话' },
      { id: 'b', kind: 'proc', title: '加工', body: '一句话' },
      { id: 'c', kind: 'out', title: '输出', body: '一句话' }
    ],
    edges: [['a', 'b'], ['b', 'c']]
  };
  await ev(`(function(){ __lc.renderDoc(${JSON.stringify(doc)}); return 1; })()`);
  await new Promise(r => setTimeout(r, 500));

  const before = await ev(`(function(){
    const p = document.querySelector('#edges path[data-k="a>b"]');
    const el = document.querySelector('#canvas .node[data-id="b"]');
    const r = el.getBoundingClientRect();
    return JSON.stringify({ d: p.getAttribute('d'), center: [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)] });
  })()`);
  const b0 = JSON.parse(before);
  console.log('before', JSON.stringify(parseD(b0.d)));

  // 用真实指针事件拖 180/90
  const [cx, cy] = b0.center;
  const send = (type, x, y) => win.webContents.sendInputEvent(
    type === 'mouseDown' ? { type: 'mouseDown', x, y, button: 'left', clickCount: 1 }
      : type === 'mouseMove' ? { type: 'mouseMove', x, y, button: 'left' }
        : { type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  send('mouseDown', cx, cy);
  await new Promise(r => setTimeout(r, 60));
  for (const [dx, dy] of [[40, 20], [90, 45], [140, 70], [180, 90]]) {
    send('mouseMove', cx + dx, cy + dy);
    await new Promise(r => setTimeout(r, 60));
  }
  send('mouseUp', cx + 180, cy + 90);
  await new Promise(r => setTimeout(r, 400));

  const after = await ev(`(function(){
    const p = document.querySelector('#edges path[data-k="a>b"]');
    const q = document.querySelector('#edges path[data-k="b>c"]');
    return JSON.stringify({ d: p.getAttribute('d'), d2: q.getAttribute('d') });
  })()`);
  const b1 = JSON.parse(after);
  console.log('after ', JSON.stringify(parseD(b1.d)));

  const A = parseD(b0.d), B = parseD(b1.d);
  console.log('端点位移 px', Math.round(B.x1 - A.x1), Math.round(B.y1 - A.y1));
  console.log('控制点偏移 前', A.dx1, A.dx2, '后', B.dx1, B.dx2);
  console.log(B.dx1 === A.dx1 && B.dx2 === A.dx2 ? 'PASS 弯度没变' : 'FAIL 弯度被重算了');
  // 再灌一次同一份 doc（相当于自动排版/结构变化）：弯度这时应该重算
  await ev(`(function(){ __lc.renderDoc(${JSON.stringify(doc)}); return 1; })()`);
  await new Promise(r => setTimeout(r, 500));
  const relayout = JSON.parse(await ev(`JSON.stringify({ d: document.querySelector('#edges path[data-k="a>b"]').getAttribute('d') })`));
  const C = parseD(relayout.d);
  console.log('重新排版后 端点', Math.round(C.x1), Math.round(C.y1), '→', Math.round(C.x2), Math.round(C.y2), '控制点偏移', C.dx1, C.dx2);
  console.log(C.dx1 === A.dx1 && C.dx2 === A.dx2 ? 'INFO 排版后与拖动前一致（卡片回到自动位置）' : 'OK 排版时重算了弯度');
  app.exit(0);
});
