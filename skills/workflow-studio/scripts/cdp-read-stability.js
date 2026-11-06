// 「读取 agent 链路」稳定性验收：分析卡住要收场、能重来、不留半张卡。对着隔离实例跑：
//   CDP_PORT=9333 node skills/workflow-studio/scripts/cdp-read-stability.js --agent <agent-id> [--mode hang|timeout|kill|stall|all] [--shots DIR]
//
// 五种模式：
//   hang  不花真 agent：把流式那一步换成「一直不出声」（和真卡住一样），验
//         进度可见（还在拆 N 张 / 已等多少秒）、20 秒没动静的说明、到点自己结束、出现「重来」、预览不留半张卡
//   timeout 起一个不出声的真子进程（启动实例时带 WF_READ_FAKE=hang + WF_READ_TIMEOUT_MS=12000）：
//         验到点主进程把它杀掉、界面自己收场、重来可用、不留半张卡
//   kill  真起一次分析，跑到一半把子进程杀掉（模拟断流）：验界面说「这次没拆全」+ 重来 + 不留半张卡，
//         再点「重来」验同时只有一个子进程在跑（旧进程先被杀掉），最后关窗收干净。
//         **只跑在正常上限的实例上**（上限 < 60 秒会先到点，runId 已清空，杀掉那一步没意义）
//   all   hang + timeout（要配小上限的实例：WF_READ_FAKE=hang WF_READ_TIMEOUT_MS=12000）；不含 kill
//   stall 20 秒没有新内容时，界面明说「它在等，不是卡住」（要正常上限的实例，不花真 agent）
// 期望全部 PASS：budget / stall-words / progress / self-stop / no-half-card / retry-ready /
//               timeout / timeout-says / killed / killed-says / retry / cancel-clean / stall-live / stall-clean / errors
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt('port', process.env.CDP_PORT || 9333));
if (PORT === 9222) { console.error('9222 是用户在用的窗口：换一个端口（实现 9333 / 验收 9334）'); process.exit(1); }
const AGENT = opt('agent', '');
const MODE = opt('mode', 'all');
const MODES = ['hang', 'timeout', 'kill', 'stall', 'all'];
if (!MODES.includes(MODE)) { console.error('--mode 只能是 ' + MODES.join(' / ') + '，收到 ' + MODE); process.exit(1); }
const SHOTS = opt('shots', '');
if (!AGENT) { console.error('usage: CDP_PORT=9333 node skills/workflow-studio/scripts/cdp-read-stability.js --agent <agent-id> [--mode hang|timeout|kill|stall|all] [--shots DIR]'); process.exit(1); }

const get = u => new Promise((res, rej) => http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
const wait = ms => new Promise(r => setTimeout(r, ms));

// 本实例（只认 --remote-debugging-port=$PORT 的那个 Electron 主进程）下面还活着的分析子进程
function procs() {
  let out = '';
  try { out = execSync('ps -Ao pid=,ppid=,command=', { maxBuffer: 8 * 1024 * 1024 }).toString(); } catch (e) { return { roots: [], kids: [] }; }
  const rows = out.split('\n').map(l => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); return m ? { pid: +m[1], ppid: +m[2], cmd: m[3] } : null; }).filter(Boolean);
  const roots = rows.filter(r => r.cmd.includes('remote-debugging-port=' + PORT) && !r.cmd.includes('--type=')).map(r => r.pid);
  const kids = [];
  const seen = new Set();
  const walk = pid => rows.filter(r => r.ppid === pid).forEach(r => { if (!seen.has(r.pid)) { seen.add(r.pid); kids.push(r); walk(r.pid); } });
  roots.forEach(walk);
  return { roots, kids };
}
const hermesRuns = () => procs().kids.filter(r => /hermes.*chat.*stream-json|sleep 600/.test(r.cmd) && !r.cmd.includes('--type='));

(async () => {
  const t = (await get(`http://127.0.0.1:${PORT}/json/list`)).find(x => x.type === 'page');
  if (!t) { console.error('no page target on ' + PORT); process.exit(1); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const errors = [];
  const send = (m, q = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: q })); });
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
  });
  await new Promise(r => ws.addEventListener('open', r));
  await send('Runtime.enable');
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result.value;
  };
  const J = async expr => JSON.parse(await ev(expr));
  const click = async sel => {
    const p = await J(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'null'; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return JSON.stringify([r.left + r.width / 2, r.top + r.height / 2]); })()`);
    if (!p) throw new Error('点不到 ' + sel);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p[0], y: p[1], button: 'none', buttons: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p[0], y: p[1], button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p[0], y: p[1], button: 'left', buttons: 0, clickCount: 1 });
  };
  const esc = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  };
  const shot = async name => {
    if (!SHOTS) return;
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(SHOTS, { recursive: true });
    const f = path.join(SHOTS, name + '.png');
    fs.writeFileSync(f, Buffer.from(s.data, 'base64'));
    console.log('shot    ' + f);
  };
  let fails = 0;
  const pass = (name, ok, detail) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(14)} ${detail}`); };
  const state = () => J(`JSON.stringify({ busy: rd.busy, runId: rd.runId, plan: !!rd.plan, err: rd.error,
    tiles: document.querySelectorAll('#rPrev .rtile').length, done: document.querySelector('#rPrev') && document.querySelector('#rPrev').classList.contains('done'),
    live: document.querySelectorAll('#rLog [data-live="1"]').length,
    hint: (document.querySelector('#rHint') || {}).textContent || '',
    again: document.querySelector('#rAgain') && !document.querySelector('#rAgain').disabled,
    body: [...document.querySelectorAll('#rLog .msg .txt')].map(e => e.textContent).join(' / ').slice(0, 400) })`);
  const openAndPick = async () => {
    if (!(await ev(`document.querySelector('#readModal').classList.contains('on')`))) await click('#btnRead');
    await wait(300);
    await click(`#rPick .ritem[data-id="${AGENT}"]`);
  };
  const waitBusy = async (ms) => { for (let i = 0; i < ms / 250; i++) { await wait(250); if ((await J(`JSON.stringify({ busy: rd.busy })`)).busy) return true; } return false; };
  const waitIdle = async (ms) => { for (let i = 0; i < ms / 250; i++) { await wait(250); if (!(await J(`JSON.stringify({ busy: rd.busy })`)).busy) return true; } return false; };

  await wait(300);
  const cfg = await J(`JSON.stringify({ budget: READ_BUDGET_MS, stall: READ_STALL_MS, bridge: window.tcflow.readTimeoutMs, toolsets: READ_TOOLSETS })`);
  pass('budget', cfg.budget === cfg.bridge && cfg.budget >= 5000 && cfg.budget <= 180000 && cfg.stall === 20000,
    `一次分析上限 ${cfg.budget}ms（桥 ${cfg.bridge}ms，≤180000），20 秒没新内容就提示（${cfg.stall}ms），工具组 ${cfg.toolsets}`);

  // ---------- 20 秒没动静的说明（直接验那句话怎么说的） ----------
  const words = await J(`(() => { const bak = { b: rd.busy, s: rd.startedAt, p: rd.lastProgress };
    rd.busy = true; rd.startedAt = Date.now() - 25000; rd.lastProgress = Date.now() - 21000;
    const slow = readProgress(); rd.lastProgress = Date.now(); rd.startedAt = Date.now() - 3000; const ok2 = readProgress();
    rd.busy = bak.b; rd.startedAt = bak.s; rd.lastProgress = bak.p; return JSON.stringify({ slow, ok2 }); })()`);
  pass('stall-words', /没有新内容/.test(words.slow) && /不是卡住/.test(words.slow) && /还在拆/.test(words.ok2),
    `等太久：「${words.slow}」；正常：「${words.ok2}」`);

  if (MODE === 'hang' || MODE === 'all') {
    // ---------- 不出声：流一直不回来，界面必须自己收场 ----------
    // 模拟「刚拆出两张卡就停住」：气泡上要能看见拆到第几张，20 秒没新内容也要有话说
    await ev(`window.__realRunStream = runStream; runStream = async (o) => {
      const live = { role: 'agent', text: '', think: '', steps: [], secs: '', live: true, startedAt: Date.now() };
      o.msgs.push(live); o.rerender();
      live.text = '{"name":"测试链路","cards":[{"kind":"in","title":"拿到交来的资料","body":"x"},{"kind":"proc","title":"整理成清单","body":"y"},{"kind":"out","title":"交回';
      o.rerender();
      return new Promise(() => { });
    };`);
    await openAndPick();
    const started = await waitBusy(cfg.budget + 5000);
    await wait(2500);
    const p1 = await state();
    await wait(2000);
    const p2 = await state();
    const grew = (a, b) => { const n = s => Number((String(s).match(/已等 (\d+) 秒/) || [])[1] || 0); return n(b) > n(a); };
    pass('progress', started && /还在拆，已经理出 2 张/.test(p1.hint) && p1.live === 1 && grew(p1.hint, p2.hint),
      `分析中：气泡 ${p1.live} 条在跑，底部写「${p1.hint}」→ 2 秒后「${p2.hint}」`);
    await shot('1-analyzing');
    const stopped = await waitIdle(cfg.budget + 12000);
    const after = await state();
    pass('self-stop', stopped && !after.busy && !after.runId,
      `到点自己停了（最多等 ${cfg.budget + 12000}ms）：busy ${after.busy}，runId ${after.runId}`);
    pass('no-half-card', after.tiles === 0 && !after.done && after.live === 0,
      `预览里半成品 ${after.tiles} 格、完成态 ${after.done}、还在转的 ${after.live} 条`);
    pass('retry-ready', after.again && /到点了/.test(after.hint) && /重来/.test(after.hint) && /到点了/.test(after.body),
      `界面：「${after.hint}」；日志：「${after.body}」；重来按钮可用 ${after.again}`);
    await shot('2-self-stopped');
    await ev(`runStream = window.__realRunStream; delete window.__realRunStream;`);
    await esc(); await wait(400);           // 关窗收干净
  }

  if (MODE === 'timeout' || MODE === 'all') {
    // ---------- 不出声的真子进程：到点主进程杀掉它，界面自己收场（启动实例时带 WF_READ_FAKE=hang + 小上限） ----------
    await openAndPick();
    const t0 = Date.now();
    const startedT = await waitBusy(8000);
    const kidsDuring = hermesRuns().length;
    const stoppedT = await waitIdle(cfg.budget + 12000);
    const elapsed = Date.now() - t0;
    const to = await state();
    await wait(800);
    const kidsLeftT = hermesRuns().length;
    pass('timeout', startedT && stoppedT && elapsed <= cfg.budget + 8000 && to.tiles === 0 && to.live === 0,
      `不出声的分析：${startedT ? '起来了' : '没起来'}，${(elapsed / 1000).toFixed(1)}s 后自己收场（上限 ${(cfg.budget / 1000).toFixed(1)}s），预览残留 ${to.tiles} 格、还在转的 ${to.live} 条`);
    pass('timeout-says', to.again && /到点了/.test(to.hint) && /重来/.test(to.hint) && /到点了/.test(to.body) && kidsLeftT === 0,
      `界面：「${to.hint}」；日志：「${to.body}」；重来可用 ${to.again}；分析进程 ${kidsDuring} → ${kidsLeftT}`);
    await shot('5-timeout');
    await esc(); await wait(400);
  }

  if (MODE === 'kill' && cfg.budget < 60000) {
    // 小上限实例撑不住 kill：真起进程后要等它出点东西（最多 20s），预算先到点、runId 已清空，
    // 杀进程那一步空转 —— 那是用法不对，不是产品问题。说清楚、跳过，别报成 FAIL。
    console.log(`SKIP  kill           这个模式要跑在正常上限的实例上（当前上限 ${cfg.budget}ms）；小上限实例请用 --mode hang / timeout`);
  } else if (MODE === 'kill') {
    // ---------- 断流：跑到一半把子进程杀掉 ----------
    await openAndPick();
    await waitBusy(20000);
    let saw = null;
    for (let i = 0; i < 80; i++) {                     // 等它真出点东西（有步骤或出字），最多 20s
      await wait(250);
      saw = await J(`JSON.stringify({ busy: rd.busy, run: rd.runId, steps: rd.msgs.reduce((n, m) => n + ((m.steps || []).length), 0), text: (rd.msgs[rd.msgs.length - 1] || {}).text || '' })`);
      if (saw.run && (saw.steps || saw.text.length > 0)) break;
    }
    const kidsBefore = hermesRuns().length;
    await ev(`window.tcflow.cancelAgent(rd.runId)`);    // 子进程被杀：流自己断掉，界面得知道
    const back = await waitIdle(10000);
    const k = await state();
    await wait(1500);
    const kidsAfter = hermesRuns().length;
    pass('killed', back && !k.busy && k.tiles === 0 && k.live === 0 && kidsAfter === 0,
      `分析中途杀掉子进程：${back ? '已收场' : '还在转'}，预览残留 ${k.tiles} 格，还在转的 ${k.live} 条，分析进程 ${kidsBefore} → ${kidsAfter}`);
    pass('killed-says', /这次没拆全/.test(k.hint) && /重来/.test(k.hint) && k.again && /这次没拆全/.test(k.body),
      `界面：「${k.hint}」；日志：「${k.body}」；重来按钮可用 ${k.again}`);
    await shot('3-killed');
    // ---------- 重来：只允许一个进程在跑 ----------
    await click('#rAgain');
    await wait(2500);
    const r = await state();
    const kidsRetry = hermesRuns().length;
    pass('retry', r.busy && r.runId && kidsRetry === 1 && r.live === 1,
      `点「重来」：busy ${r.busy}，新 runId ${r.runId ? '有' : '无'}，分析进程 ${kidsRetry} 个（旧的那个已经先被杀掉）`);
    await esc();
    for (let i = 0; i < 20; i++) { await wait(250); if (!hermesRuns().length) break; }
    const c = await state();
    const kidsLeft = hermesRuns().length;
    pass('cancel-clean', !c.busy && c.tiles === 0 && c.live === 0 && kidsLeft === 0,
      `关窗取消：busy ${c.busy}，预览残留 ${c.tiles} 格，仍在跑的分析进程 ${kidsLeft} 个`);
    await shot('4-cancelled');
  }

  if (MODE === 'stall') {
    // ---------- 20 秒没有新内容：界面上要能看出「它在等，不是我卡了」 ----------
    await ev(`window.__realRunStream2 = runStream; runStream = async (o) => {
      const live = { role: 'agent', text: '', think: '', steps: [], secs: '', live: true, startedAt: Date.now() };
      o.msgs.push(live); o.rerender();
      live.text = '{"cards":[{"kind":"in","title":"拿到交来的资料","body":"x"},{"kind":"proc","title":"整理成清单","body":"y"}';
      o.rerender();
      return new Promise(() => { });
    };`);
    await openAndPick();
    await waitBusy(cfg.budget + 5000);
    let line = '', bubble = '';
    for (let i = 0; i < 110; i++) {                       // 最多等 27.5s
      await wait(250);
      const s = await state();
      line = s.hint;
      bubble = s.body;
      if (/没有新内容/.test(line)) break;
    }
    pass('stall-live', /没有新内容/.test(line) && /不是卡住/.test(line) && /没有新内容/.test(bubble),
      `停了 20 秒后界面写：「${line}」；气泡里也有同样一句 ${/没有新内容/.test(bubble)}`);
    await shot('6-stall');
    await ev(`runStream = window.__realRunStream2; delete window.__realRunStream2;`);
    await esc(); await wait(400);
    const q = await state();
    pass('stall-clean', !q.busy && q.tiles === 0 && q.live === 0, `关窗取消后：busy ${q.busy}，预览残留 ${q.tiles} 格`);
  }

  pass('errors', errors.length === 0, errors.length ? errors.slice(0, 3).join(' | ') : '页面没有抛错');
  ws.close(); process.exit(fails ? 2 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
