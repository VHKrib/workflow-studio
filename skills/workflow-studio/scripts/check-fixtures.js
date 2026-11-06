// 拆卡规则离线回归：读固定样本 → 过现有解析（parseChainPlan）→ 过质量闸（planProblem）→ 逐条断言
// 不联网、不调模型；一条命令几十毫秒跑完。改解析或改提示词之后先跑它，退步当场就能看见。
//
//   node skills/workflow-studio/scripts/check-fixtures.js                 # 好样本 + 故意写坏的样本
//   node skills/workflow-studio/scripts/check-fixtures.js <样本目录>       # 只跑一个目录（可用来把样本改坏，验证断言真会 FAIL）
//
// 样本格式见 skills/workflow-studio/fixtures/README.md：meta（来源）+ expect（该长成什么样）+ answer（拆卡原始回答）。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '..', '..', 'renderer', 'app.js');
const GOOD = path.join(ROOT, 'fixtures');
const BAD = path.join(ROOT, 'fixtures', 'bad');

// app.js 是浏览器脚本：桩出最小环境整段执行，再把要测的函数取出来（和 check-plan.js 同一套做法）
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

// ---- 断言器 ----
let pass = 0, fail = 0;
function check(id, name, ok, detail) {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} · ${name}  ${detail}`);
}
const list = e => (e || []).map(([a, b]) => `${a}>${b}`).join(' ') || '（空）';

// 脱敏：样本里不许出现本机绝对路径、长数字（货号/订单号）、邮箱、部门/岗位字样
const DIRTY = [
  [/\/Applications|\/Users\/|~\/\.hermes|file:\/\/|[A-Za-z]:\\\\/, '本机绝对路径'],
  [/\d{9,}/, '9 位以上数字（货号/订单号）'],
  [/[\w.+-]+@[\w-]+\.[\w.]+/, '邮箱'],
  [/部门|岗位|主管|专员|项目部/, '部门/岗位字样'],
];

function runFixture(file) {
  const id = path.basename(file, '.json');
  const raw = fs.readFileSync(file, 'utf8');
  let f;
  try { f = JSON.parse(raw); } catch (e) {
    check(id, '样本能读', false, `JSON 解析失败：${e.message}`);
    return;
  }
  const e = f.expect || {};
  const answer = typeof f.answer === 'string' ? f.answer : JSON.stringify(f.answer);
  const p = parseChainPlan(answer);
  const gate = planProblem(p);

  check(id, '样本能读', !!f.meta && f.answer != null, `${f.meta ? f.meta.title : '缺 meta'}｜${f.meta ? f.meta.from : '缺来源'}`);

  for (const [re, why] of DIRTY) {
    const m = raw.match(re);
    check(id, '脱敏', !m, m ? `出现${why}：${String(m[0]).slice(0, 40)}` : `无${why}`);
  }

  if (e.cards == null) {                              // 期望解析不出计划（流被截断那种）
    check(id, '解析', p === null, p ? `不该解析出来，却拆出 ${p.cards.length} 张` : '半个 JSON 解析不出完整计划');
  } else {
    check(id, '解析', !!p, p ? `拆出 ${p.cards.length} 张卡` : '解析不出计划');
    if (p) {
      check(id, '卡片数', p.cards.length === e.cards, `${p.cards.length} 张（期望 ${e.cards}）`);
      const kinds = { in: 0, proc: 0, out: 0 };
      p.cards.forEach(c => { kinds[c.kind]++; });
      const want = e.kinds || {};
      check(id, '三类都齐', ['in', 'proc', 'out'].every(k => kinds[k] === want[k]),
        `输入 ${kinds.in} / 加工 ${kinds.proc} / 输出 ${kinds.out}（期望 ${want.in} / ${want.proc} / ${want.out}）`);
      const titles = p.cards.map(c => c.title);
      check(id, '标题', JSON.stringify(titles) === JSON.stringify(e.titles || []), titles.join('｜'));
      check(id, '连线', JSON.stringify(p.edges) === JSON.stringify(e.edges || []), `${list(p.edges)}（期望 ${list(e.edges)}）`);
      const intoIn = p.edges.filter(([, b]) => (p.cards.find(c => c.key === b) || {}).kind === 'in');
      check(id, '没有连进输入卡', intoIn.length === 0, intoIn.length ? `还有 ${list(intoIn)}` : '一条都没有');
      // 每张卡都接上了：输入要有出边，输出要有入边，加工两头都要有。坏样本可以声明「本来就该没接上」（wired:false）
      const bad = p.cards.filter(c => (c.kind === 'proc' && !(p.edges.some(([, b]) => b === c.key) && p.edges.some(([a]) => a === c.key)))
        || (c.kind === 'in' && !p.edges.some(([a]) => a === c.key))
        || (c.kind === 'out' && !p.edges.some(([, b]) => b === c.key)));
      const wantWired = e.wired !== false;
      check(id, '每张卡都接上', (bad.length === 0) === wantWired,
        bad.length ? `${wantWired ? '没接上' : '故意没接上'}：${bad.map(c => c.title).join('、')}` : `${p.cards.length} 张都接上了`);
      // 整条连成一片（不分方向数连通块）。坏样本可以声明「本来就该断成几截」（single:false）
      const seen = new Set([p.cards[0].key]), todo = [p.cards[0].key];
      while (todo.length) {
        const k = todo.pop();
        for (const [a, b] of p.edges) { const o = a === k ? b : b === k ? a : null; if (o && !seen.has(o)) { seen.add(o); todo.push(o); } }
      }
      const wantSingle = e.single !== false;
      check(id, '连成一片', (seen.size === p.cards.length) === wantSingle,
        `${seen.size} / ${p.cards.length} 张连在一起${wantSingle ? '' : '（坏样本，本来就该断）'}`);
    }
  }

  if (e.partial != null) {
    const pc = partialCards(answer);
    check(id, '流式预览', pc.length === e.partial, `先看到 ${pc.length} 张（期望 ${e.partial}）`);
  }

  check(id, '质量闸', gate === (e.gate || ''), gate ? `挡下：${gate}` : '过闸');
  if (e.autoFix != null && p) {
    const fixed = JSON.stringify(p.edges) !== JSON.stringify((f.answer && f.answer.edges) || []);
    check(id, '修还是挡', fixed === e.autoFix, e.autoFix ? `自动修好（模型给了 ${list(f.answer.edges)}）` : '原样保留，交给质量闸判');
  }
}

const dirs = process.argv[2] ? [path.resolve(process.argv[2])] : [GOOD, BAD];
const t0 = Date.now();
let files = 0;
for (const dir of dirs) {
  if (!fs.existsSync(dir)) { console.log(`FAIL  样本目录不存在：${dir}`); fail++; continue; }
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    files++;
    runFixture(path.join(dir, name));
  }
}
const ms = Date.now() - t0;
console.log(`\n${files} 份样本 · ${pass} 条通过 · ${fail} 条没过 · 用时 ${ms}ms`);
if (fail) { console.log(`有 ${fail} 条没通过：解析或质量闸退步了，先查最近一次改动。`); process.exit(1); }
console.log('全部通过：跑过的样本都跟验收时一样——该拆出来的拆出来，该挡的挡住，该修的修好。');
