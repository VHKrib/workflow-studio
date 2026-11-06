// 用「真鼠标事件」测点击/双击（合成 dblclick 事件测不出 DOM 被重建那类问题）。
//
//   node skills/workflow-studio/scripts/cdp-click.js --card "找证据包" --mode single
//   node skills/workflow-studio/scripts/cdp-click.js --card "找证据包" --mode double
//   CDP_PORT=9333 node ...（对着隔离实例测，见 SKILL.md「启动与验证」）
//
// 打印：点在哪、命中哪个元素、点击前后的 selId / panelCardId / 右栏收起状态 / 双击事件次数。
// 断言靠人看输出；判定标准：single 只改 selId、不改 panelCardId；double 才让 panelCardId = 卡片 id。
const http = require('http');

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };
const PORT = Number(opt('port', process.env.CDP_PORT || 9222));
const CARD = opt('card', '找证据包');   // 卡片标题
const MODE = opt('mode', 'double');     // single | double

const get = u => new Promise((res, rej) => http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const t = (await get(`http://127.0.0.1:${PORT}/json/list`)).find(x => x.type === 'page');
  if (!t) { console.error('no page target on ' + PORT); process.exit(1); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, q = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: q })); });
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  await new Promise(r => ws.addEventListener('open', r));

  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result.value;
  };
  const mouse = (type, x, y, clickCount) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount });

  // 探针：双击计数 + 命中元素（只装一次）
  await ev(`(() => {
    if (!window.__dblTrap) {
      window.__dblTrap = { n: 0, last: null };
      document.addEventListener('dblclick', e => {
        window.__dblTrap.n++;
        const n = e.target.closest && e.target.closest('.node');
        window.__dblTrap.last = { tag: e.target.tagName, cls: String(e.target.className), node: n ? n.dataset.id : null };
      }, true);
    }
    window.__dblTrap.n = 0; window.__dblTrap.last = null;
    return 1;
  })()`);

  // 每次点之前重新量坐标：右栏收/展会让卡片整体位移
  const measure = async () => JSON.parse(await ev(`(() => {
    const n = flow().nodes.find(x => x.title === ${JSON.stringify(CARD)});
    if (!n) return JSON.stringify({ error: 'no card titled ' + ${JSON.stringify(CARD)} });
    const el = document.querySelector('.node[data-id="' + n.id + '"]');
    if (!el) return JSON.stringify({ error: 'card not rendered' });
    const r = el.querySelector('.body').getBoundingClientRect();
    const x = Math.round(r.left + 24), y = Math.round(r.top + 14);
    const hit = document.elementFromPoint(x, y);
    return JSON.stringify({ id: n.id, x, y, hit: hit ? hit.className : null });
  })()`));
  const state = () => ev(`JSON.stringify({ sel: selId, panelCard: panelCardId, collapsed: document.querySelector('#layout').classList.contains('collapsed'), title: document.querySelector('#panelTitle').textContent, hasChat: !!document.querySelector('#chatLog'), dbl: window.__dblTrap.n, dblTarget: window.__dblTrap.last })`);

  // 从干净态开始：右栏收起、无选中
  await ev(`confirmAdd = null; selId = null; panelCardId = null; panelOpen = false; render(); 1`);
  await wait(250);

  const p = await measure();
  if (p.error) { console.error(p.error); process.exit(1); }
  console.log('point ', JSON.stringify(p));

  if (MODE === 'single') {
    await mouse('mousePressed', p.x, p.y, 1); await mouse('mouseReleased', p.x, p.y, 1);
    await wait(150);
  } else {
    await mouse('mousePressed', p.x, p.y, 1); await mouse('mouseReleased', p.x, p.y, 1);
    await wait(60);
    const q = await measure();            // 第一下可能让布局位移，重新量
    await mouse('mousePressed', q.x, q.y, 2); await mouse('mouseReleased', q.x, q.y, 2);
    await wait(300);
  }
  console.log('state ', await state());
  ws.close(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
