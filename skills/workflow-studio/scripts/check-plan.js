// parseChainPlan / planProblem 的离线用例（不调 agent）：连线规矩、补线、质量闸
//   node skills/workflow-studio/scripts/check-plan.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const APP = path.join(__dirname, '..', '..', '..', 'renderer', 'app.js');

// app.js 是浏览器脚本：在一个桩出来的环境里整段执行，再把要测的函数取出来
const anything = () => new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : anything()),
  apply: () => anything(), construct: () => anything(), set: () => true,
});
const ctx = {
  console, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, requestAnimationFrame: () => 0, performance: { now: () => 0 },
  document: anything(), localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ matches: false }),
  addEventListener() {}, getComputedStyle: () => ({}), window: { tcflow: { listAgents: () => new Promise(() => {}) } },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(APP, 'utf8') + '\n;globalThis.__api = { parseChainPlan, planProblem, partialCards };', ctx, { filename: 'app.js' });
const { parseChainPlan, planProblem, partialCards } = ctx.__api;

const C = (key, kind, title, body = '这一步具体做的事', mods = ['甲']) => ({ key, kind, title, body, impl: '', mods });
const J = o => JSON.stringify(o);
const show = p => p ? p.edges.map(([a, b]) => `${a}>${b}`).join(' ') : 'null';
let fails = 0;
const check = (name, ok, detail) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(14)} ${detail}`); };

// 1) 正常：按给的连线
let p = parseChainPlan(J({ name: '正常', cards: [C('a', 'in', '派活'), C('b', 'proc', '干活'), C('c', 'out', '交付')], edges: [['a', 'b'], ['b', 'c']] }));
check('normal', show(p) === 'a>b b>c' && planProblem(p) === '', show(p));

// 2) 输入连输入（bgeflow 实测踩过）：丢掉这条；没人喂的加工卡补上前面最近的输入，落单的输入接到后面最近的加工 → 整条接通、过闸
p = parseChainPlan(J({ cards: [C('a', 'in', '派活'), C('b', 'in', '原图'), C('c', 'proc', '出图'), C('d', 'proc', '出片'), C('e', 'out', '交付')],
  edges: [['a', 'b'], ['c', 'd'], ['d', 'e']] }));
check('in->in', !/a>b/.test(show(p)) && /b>c/.test(show(p)) && /a>c/.test(show(p)) && planProblem(p) === '', `${show(p)}｜${planProblem(p) || '过闸'}`);

// 3) 加工连回输入：丢掉
p = parseChainPlan(J({ cards: [C('a', 'in', '派活'), C('b', 'proc', '干活'), C('c', 'out', '交付')], edges: [['a', 'b'], ['b', 'a'], ['b', 'c']] }));
check('proc->in', show(p) === 'a>b b>c', show(p));

// 4) 成环：丢掉回头那条
p = parseChainPlan(J({ cards: [C('a', 'in', '派活'), C('b', 'proc', '一'), C('c', 'proc', '二'), C('d', 'out', '交付')], edges: [['a', 'b'], ['b', 'c'], ['c', 'b'], ['c', 'd']] }));
check('cycle', show(p) === 'a>b b>c c>d', show(p));

// 5) 没给连线：按顺序推
p = parseChainPlan(J({ cards: [C('a', 'in', '派活'), C('b', 'proc', '干活'), C('c', 'out', '交付')] }));
check('no edges', show(p) === 'a>b b>c' && planProblem(p) === '', show(p));

// 6) 用标题写连线也认
p = parseChainPlan(J({ cards: [C('a', 'in', '派活'), C('b', 'proc', '干活'), C('c', 'out', '交付')], edges: [['派活', '干活'], { from: '干活', to: '交付' }] }));
check('by title', show(p) === 'a>b b>c', show(p));

// 7) 写了一半的空卡（流被截断那次）：丢掉；不全的卡组不过闸
p = parseChainPlan(J({ cards: [C('a', 'in', '派活'), C('b', 'in', '原图'), C('c', 'in', '按用途挑卖点', ''), C('d', 'in', '', '')], edges: [] }));
check('half-written', p && p.cards.length === 2 && /不全/.test(planProblem(p)), p ? `${p.cards.length} 张｜${planProblem(p)}` : 'null');

// 7b) 真断成两截（两条互不相干的小链）：不过闸
p = parseChainPlan(J({ cards: [C('a', 'in', '甲料'), C('b', 'proc', '甲工'), C('c', 'out', '甲货'), C('d', 'in', '乙料'), C('e', 'proc', '乙工'), C('f', 'out', '乙货')],
  edges: [['a', 'b'], ['b', 'c'], ['d', 'e'], ['e', 'f']] }));
check('two islands', planProblem(p) === '链路断成了几截', `${show(p)}｜${planProblem(p) || '过闸'}`);

// 8) 加工卡没人接手：补到后面最近的输出卡
p = parseChainPlan(J({ cards: [C('a', 'in', '派活'), C('b', 'proc', '一'), C('c', 'proc', '二'), C('d', 'out', '交付')], edges: [['a', 'b'], ['a', 'c'], ['c', 'd']] }));
check('dangling proc', /b>/.test(show(p)) && planProblem(p) === '', `${show(p)}｜${planProblem(p) || '过闸'}`);

// 9) 中文 kind、占位标题、超长标题
p = parseChainPlan(J({ cards: [{ key: 'a', kind: '输入', title: '短标题', body: 'x' }, { key: 'b', kind: '输入', title: '派活单', body: '派活' }, { key: 'c', kind: '加工', title: '一'.repeat(40), body: '干' }, { key: 'd', kind: '输出', title: '交付', body: '交' }] }));
check('kinds/titles', p && p.cards.map(c => c.kind).join() === 'in,proc,out' && p.cards[1].title.length === 24, p ? p.cards.map(c => c.kind + ':' + c.title.length).join(' ') : 'null');

// 10) 回答前后有废话、有代码块标记
p = parseChainPlan('好的，下面是结果：\n```json\n' + J({ cards: [C('a', 'in', '派活'), C('b', 'proc', '干活'), C('c', 'out', '交付')], edges: [['a', 'b'], ['b', 'c']] }) + '\n```\n以上。');
check('fenced', show(p) === 'a>b b>c', show(p));

// 11) 正文里夹着命令/路径：搬进内部实现
p = parseChainPlan(J({ cards: [C('a', 'in', '派活', '看板派来商品链接。读 evidence/_INDEX-BY-OFFER.json 反查。'), C('b', 'proc', '干活'), C('c', 'out', '交付')] }));
check('tech split', p && !/json/.test(p.cards[0].body) && /json/.test(p.cards[0].impl), p ? `正文「${p.cards[0].body}」⚙「${p.cards[0].impl}」` : 'null');

// 12) 流式中的半截 JSON：已经写完整的卡先冒出来
const half = '{"name":"x","cards":[{"key":"c1","kind":"in","title":"派活","body":"a","mods":["甲","乙"]},{"key":"c2","kind":"proc","title":"干';
const pc = partialCards(half);
check('partial', pc.length === 1 && pc[0].title === '派活' && pc[0].mods.join() === '甲,乙', J(pc));

console.log(fails ? `\n${fails} 条没过` : '\n全部通过');
process.exit(fails ? 1 : 0);
