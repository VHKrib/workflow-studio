// 独立回归：对话 → 工作链路（素材版本 / 加工输出归属 / 结果驱动调整）。
//
// 这份用例与产品实现**分开写**：只按业务要求核对「关系对不对」，不照实现凑通过。
// 不联网、不调模型、不起 Electron、不连任何 CDP 端口；只喂合成的中性消息（示例文件 / 示例目录）。
//
//   node tools/check-livegraph-independent.js
//   LIVEGRAPH_MODULE=/别的/快照/livegraph.js node tools/check-livegraph-independent.js
//
// 退出码：0 = 全部 PASS；1 = 有 FAIL（FAIL 就是待实现方修的问题，不是本脚本的失败）；2 = 模块加载/接口不符。
//
// 断言口径（来自业务要求，不是实现细节）：
// - 同一份素材同一版本只该有一个源节点，被几次真实加工用到就是几条「用」边；轮询/重复消息/正文提及不涨计数；
// - 文件身份 = 完整路径（同名不同目录不合并）；同路径被重写 = 新版本，旧版本与旧加工不动；
// - 人看完输出换做法：两条路线各自有真实产物，「改动原因」挂在被改的那一版上，不冒充一条素材流；
// - 旧产物被下一次加工真正读入时直接复用那张产物卡，不另造一张输入；
// - 失败 / 进行中 / 只提议未执行，都不能画成「已完成」；
// - 嵌套工具调用、工具结果对应、未知引用、重复 id、循环、寒暄、历史截断都要有收场；
// - 卡片数量不做固定断言，一律按关系与来源核对；异常输入必须有限时间返回。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MOD = process.env.LIVEGRAPH_MODULE
  ? path.resolve(process.env.LIVEGRAPH_MODULE)
  : path.join(__dirname, '..', 'livegraph.js');

console.log('# 独立回归用例 · 模块：' + MOD);
let lg;
try {
  lg = require(MOD);
} catch (e) {
  console.error('加载模块失败：' + (e && e.message));
  process.exit(2);
}
const REQUIRED = ['buildEvidence', 'buildGraph', 'layoutColumns', 'brief', 'MAX_CARDS'];
const missing = REQUIRED.filter(k => !(k in lg));
if (missing.length) {
  console.error('接口不符，缺：' + missing.join(', '));
  process.exit(2);
}
try {
  const h = crypto.createHash('sha256').update(fs.readFileSync(MOD)).digest('hex');
  console.log('# 模块 sha256：' + h + '（' + fs.statSync(MOD).size + ' 字节）');
} catch (e) { /* 读不到就算，不影响断言 */ }

// ---------- 断言与取证 ----------
let nPass = 0, nFail = 0;
const failures = [];
function t(name, pass, o) {
  o = o || {};
  if (pass) { nPass++; console.log('PASS  ' + name); return; }
  nFail++;
  failures.push(name);
  console.log('FAIL  ' + name);
  console.log('      预期：' + (o.expected == null ? '（未写）' : o.expected));
  console.log('      实测：' + (o.actual == null ? '（未写）' : o.actual));
  if (o.input) console.log('      最小输入：' + o.input);
}
const clip = (s, n) => { const x = String(s == null ? '' : s); return x.length > (n || 120) ? x.slice(0, (n || 120) - 1) + '…' : x; };
const J = v => { try { return clip(JSON.stringify(v), 240); } catch (e) { return String(v); } };

// ---------- 合成消息 ----------
// 形状沿用会话库消息：{ id, role: 'user'|'assistant'|'tool', text, tools:[{name,args,callId}], toolCallId, ok, at }
let seq = 0;
const U = text => ({ id: ++seq, role: 'user', text, at: seq * 1000 });
const A = text => ({ id: ++seq, role: 'assistant', text, at: seq * 1000, tools: [] });
const T = (name, args, okv = true) => {
  const id = ++seq;
  const cid = 'call_' + id;
  return [
    { id, role: 'assistant', text: '', at: id * 1000, tools: [{ name, args, callId: cid }] },
    { id: ++seq, role: 'tool', text: '', at: seq * 1000, toolName: name, toolCallId: cid, ok: okv },
  ];
};
// 只有工具调用、还没有工具结果（= 正在做）
const TPending = (name, args) => {
  const id = ++seq;
  return { id, role: 'assistant', text: '', at: id * 1000, tools: [{ name, args, callId: 'call_' + id }] };
};
const flat = a => a.flat();
const build = (msgs, plan) => {
  const ev = lg.buildEvidence(msgs, { key: 'independent' });
  const doc = lg.buildGraph(ev, plan || null);
  return { ev, doc };
};
const cardsOf = (doc, kind) => doc.cards.filter(c => c.kind === kind);
const findByTitle = (doc, re, kind) => doc.cards.filter(c => (!kind || c.kind === kind) && re.test(String(c.title)));
const outUse = (doc, id) => doc.edges.filter(([a, b, k]) => a === id && k === 'use');
const inUse = (doc, id) => doc.edges.filter(([a, b, k]) => b === id && k === 'use');
const outMake = (doc, id) => doc.edges.filter(([a, b, k]) => a === id && k === 'make');
const inMake = (doc, id) => doc.edges.filter(([a, b, k]) => b === id && k === 'make');
const edgesBetween = (doc, a, b, k) => doc.edges.filter(([x, y, kk]) => x === a && y === b && (!k || kk === k));
const implPath = c => {
  const line = String(c && c.impl || '').split('\n').find(l => l.startsWith('文件：'));
  return line ? line.slice(3).trim() : '';
};
const dump = doc => doc.cards.map(c => `${c.kind}:${c.title}${c.ver ? '@v' + c.ver : ''}${c.status ? '(' + c.status + ')' : ''}`);
const msgsLine = msgs => (msgs || []).filter(Boolean).map(m => {
  if (m.role === 'user') return `U#${m.id}「${clip(m.text, 28)}」`;
  if (m.role === 'tool') return `R#${m.id}(${m.toolCallId}=${m.ok === false ? '失败' : 'ok'})`;
  const tl = (m.tools || []).map(x => x.name + (x.args && (x.args.path || x.args.image_url) ? ' ' + (x.args.path || x.args.image_url) : '')).join(',');
  return `A#${m.id}${tl ? '[' + tl + ']' : ''}`;
}).join(' | ');

// =====================================================================
// 1) 同一素材同一版本供多次加工：唯一源节点 + 正确使用边；不因轮询/重复/提及涨数
// =====================================================================
{
  seq = 0;
  const msgs = flat([
    U('把示例资料整理成一版说明'),
    T('read_file', { path: '/demo/资料/示例需求.md' }),
    T('write_file', { path: '/demo/交付/说明一.md' }),
    A('写好了。MEDIA:/demo/交付/说明一.md'),
    U('换一种做法，还是用同一份资料'),
    T('read_file', { path: '/demo/资料/示例需求.md' }),
    T('write_file', { path: '/demo/交付/说明二.md' }),
    A('换写法了。MEDIA:/demo/交付/说明二.md'),
    U('你刚才用的是示例需求.md 那份吧？'),          // 只是提起，不是使用
    A('是的，就是那份。'),
  ]);
  const { doc } = build(msgs, null);
  const mats = findByTitle(doc, /示例需求\.md/, 'in');
  t('reuse-single-source-node', mats.length === 1, {
    expected: '同一份素材同一版本只有 1 张输入卡',
    actual: `输入卡 ${mats.length} 张：${J(dump(doc))}`,
    input: msgsLine(msgs),
  });
  const m0 = mats[0];
  t('reuse-two-use-edges', !!m0 && outUse(doc, m0.id).length === 2 && m0.uses === 2, {
    expected: '被两次真实加工用到 = 2 条「用」边，计数 2',
    actual: m0 ? `用边 ${outUse(doc, m0.id).length} 条，计数字段 ${m0.uses}` : '没有素材卡',
    input: msgsLine(msgs),
  });
  t('reuse-two-real-outputs', findByTitle(doc, /说明一\.md/, 'out').length === 1 && findByTitle(doc, /说明二\.md/, 'out').length === 1, {
    expected: '两次加工各留一张自己有产出的产物卡',
    actual: J(dump(doc)),
    input: msgsLine(msgs),
  });
  // 正文提到文件名不涨计数、不建实体
  t('reuse-mention-no-entity', doc.cards.filter(c => c.kind === 'in').length === 1 && doc.stats.materials === 1, {
    expected: '只有真实读入的文件算素材；正文提及「示例需求.md」不建第二个实体',
    actual: `输入卡 ${doc.cards.filter(c => c.kind === 'in').length} 张，materials=${doc.stats.materials}`,
    input: '同一条对话末尾追加一句提及（U#9）',
  });
  // 轮询：同一批消息再喂一遍
  const ev1 = lg.buildEvidence(msgs, { key: 'k' });
  const ev2 = lg.buildEvidence(msgs.concat(msgs), { key: 'k' });
  const n1 = [...ev1.mats.values()].map(m => m.uses.length).join(',');
  const n2 = [...ev2.mats.values()].map(m => m.uses.length).join(',');
  t('reuse-poll-no-double-count', n1 === n2 && ev2.calls.length === ev1.calls.length && ev2.arts.size === ev1.arts.size, {
    expected: '重复轮询（同批消息再喂一遍）不涨使用数、不涨调用数、不重复建产物',
    actual: `uses ${n1} → ${n2}；calls ${ev1.calls.length} → ${ev2.calls.length}；arts ${ev1.arts.size} → ${ev2.arts.size}`,
    input: 'buildEvidence(msgs) vs buildEvidence(msgs + msgs)',
  });
  // 同一批里重复同一条消息（id 相同）
  const dupMsgs = msgs.concat([msgs[1]]);
  const evd = lg.buildEvidence(dupMsgs, { key: 'k' });
  t('reuse-duplicate-id-once', evd.calls.length === ev1.calls.length, {
    expected: '同一 id 的消息重复出现只算一次',
    actual: `calls ${ev1.calls.length} → ${evd.calls.length}`,
    input: 'msgs 里再插一份同 id 的工具消息：' + msgsLine([msgs[1]]),
  });
  // 同一单元内重复读同一文件：只算一次使用
  seq = 0;
  const twice = flat([U('看这张图'), T('vision_analyze', { image_url: '/demo/参考/图.png' }), T('vision_analyze', { image_url: '/demo/参考/图.png' })]);
  const tw = build(twice, null);
  const twMat = findByTitle(tw.doc, /图\.png/, 'in');
  t('reuse-read-twice-same-unit', twMat.length === 1 && twMat[0].uses === 1, {
    expected: '同一次加工里重复读同一份素材只算 1 次使用',
    actual: twMat.length ? `卡 ${twMat.length} 张，计数 ${twMat[0].uses}` : '没有素材卡',
    input: msgsLine(twice),
  });
  // 同名不同目录：两个实体，谁也不并到谁
  seq = 0;
  const dirs = flat([
    U('看两张同名图'),
    T('vision_analyze', { image_url: '/demo/甲/图.png' }),
    T('vision_analyze', { image_url: '/demo/乙/图.png' }),
  ]);
  const dd = build(dirs, null);
  const dupMat = findByTitle(dd.doc, /图\.png/, 'in');
  const paths = new Set(dupMat.map(implPath));
  t('identity-same-name-diff-dir', dupMat.length === 2 && paths.size === 2 && new Set(dupMat.map(c => c.id)).size === 2, {
    expected: '同名不同目录 = 两个不同素材（两张卡、id 不同、路径不同）',
    actual: `卡 ${dupMat.length} 张，路径 ${paths.size} 个：${J([...paths])}`,
    input: msgsLine(dirs),
  });
  // 人直接发来的图：算素材；如果这份图本来就是本流程的产物，则复用产物卡，不另造输入
  seq = 0;
  const attach = flat([
    U('先出一版'),
    T('read_file', { path: '/demo/参考/源.md' }),
    T('write_file', { path: '/demo/交付/稿.md' }),
    A('好了 MEDIA:/demo/交付/稿.md'),
    { id: ++seq, role: 'user', text: '这张就是刚出的那版\n[Image attached at: /demo/交付/稿.md]', at: seq * 1000 },
    T('patch', { path: '/demo/交付/稿.md' }),
    A('改好了 MEDIA:/demo/交付/稿.md'),
  ]);
  const at = build(attach, null);
  const atIn = at.doc.cards.filter(c => c.kind === 'in' && /稿\.md/.test(c.title));
  const atOut = at.doc.cards.filter(c => c.kind === 'out' && /稿\.md/.test(c.title));
  t('attached-existing-output-reused', atIn.length === 0 && atOut.length === 2 && atOut.some(c => outUse(at.doc, c.id).length === 1), {
    expected: '人发来的图如果已经是本流程的产物，复用它（产物卡 + 使用边），不另造一张输入',
    actual: `输入 ${atIn.length} 张，产物 ${atOut.length} 张：${J(dump(at.doc))}`,
    input: msgsLine(attach),
  });
}

// =====================================================================
// 2) 身份与版本：材料改版 / 同路径重写产物 / 旧加工仍对应旧版
// =====================================================================
{
  seq = 0;
  const msgs = flat([
    U('用基准出一版'),
    T('read_file', { path: '/demo/素材/基准.md' }),
    T('write_file', { path: '/demo/交付/甲.md' }),
    A('成品甲 MEDIA:/demo/交付/甲.md'),
    U('把基准改一下'),
    T('write_file', { path: '/demo/素材/基准.md' }),      // 改的是素材本身 → 素材涨版本
    A('改好 MEDIA:/demo/素材/基准.md'),
    U('按新基准再来一版'),
    T('read_file', { path: '/demo/素材/基准.md' }),
    T('write_file', { path: '/demo/交付/乙.md' }),
    A('成品乙 MEDIA:/demo/交付/乙.md'),
  ]);
  const { doc } = build(msgs, null);
  const mats = findByTitle(doc, /基准\.md/, 'in');
  const v1 = mats.find(c => c.ver === 1);
  const v2 = mats.find(c => c.ver === 2);
  t('material-rewrite-new-version', mats.length === 2 && !!v1 && !!v2 && v1.id !== v2.id, {
    expected: '参考素材被改写 = 第 2 版；两版各一张卡，旧卡不覆盖',
    actual: J(dump(doc)),
    input: msgsLine(msgs),
  });
  t('material-version-evolve-edge', !!v1 && !!v2 && edgesBetween(doc, v1.id, v2.id, 'evolve').length === 1, {
    expected: '同一文件的两版之间有一条「新版」边',
    actual: v1 && v2 ? J(doc.edges.filter(([a, b]) => (a === v1.id && b === v2.id) || (a === v2.id && b === v1.id))) : '缺版本卡',
    input: '同一条对话',
  });
  const proc = doc.cards.filter(c => c.kind === 'proc');
  const p1 = proc.find(c => outMake(doc, c.id).length && /甲\.md/.test((doc.cards.find(x => x.id === outMake(doc, c.id)[0][1]) || {}).title || ''));
  const p3 = proc.find(c => outMake(doc, c.id).length && /乙\.md/.test((doc.cards.find(x => x.id === outMake(doc, c.id)[0][1]) || {}).title || ''));
  t('old-call-points-old-version', !!p1 && !!v1 && inUse(doc, p1.id).length === 1 && inUse(doc, p1.id)[0][0] === v1.id && !!p3 && !!v2 && inUse(doc, p3.id).length === 1 && inUse(doc, p3.id)[0][0] === v2.id, {
    expected: '用旧版素材的那一步仍然连旧版；改版之后的加工连新版',
    actual: p1 && p3 ? `第一步用 ${J(inUse(doc, p1.id).map(e => e[0]))}，第三步用 ${J(inUse(doc, p3.id).map(e => e[0]))}` : `没找到对应加工卡：${J(dump(doc))}`,
    input: msgsLine(msgs),
  });
  t('material-version-uses-counted-per-version', !!v1 && !!v2 && v1.uses === 1 && v2.uses === 1
    && outUse(doc, v1.id).length === 1 && outUse(doc, v2.id).length === 1
    && outUse(doc, v1.id)[0][1] !== outUse(doc, v2.id)[0][1], {
    expected: '两版素材各算各的使用：旧版 1 条用边（老那一步）、新版 1 条用边（改版之后那一步），不沿用同一份计数',
    actual: v1 && v2 ? `v1 计数 ${v1.uses}/边 ${outUse(doc, v1.id).length}，v2 计数 ${v2.uses}/边 ${outUse(doc, v2.id).length}` : '缺版本卡',
    input: '同一条对话',
  });

  // 同路径重写产物：两张产物卡 + 各自来源步骤
  seq = 0;
  const rw = flat([
    U('出一版稿'),
    T('read_file', { path: '/demo/参考/源.md' }),
    T('write_file', { path: '/demo/交付/稿.md' }),
    A('好了 MEDIA:/demo/交付/稿.md'),
    U('再改一版稿'),
    T('read_file', { path: '/demo/交付/稿.md' }),
    T('patch', { path: '/demo/交付/稿.md' }),
    A('改好了 MEDIA:/demo/交付/稿.md'),
  ]);
  const rr = build(rw, null);
  const outs = findByTitle(rr.doc, /稿\.md/, 'out');
  const o1 = outs.find(c => c.ver === 1), o2 = outs.find(c => c.ver === 2);
  t('artifact-rewrite-two-versions', outs.length === 2 && !!o1 && !!o2 && o1.id !== o2.id && edgesBetween(rr.doc, o1.id, o2.id, 'evolve').length === 1, {
    expected: '同路径重写 = 第 2 版产物卡，旧版留着，两版之间一条「新版」边',
    actual: J(dump(rr.doc)),
    input: msgsLine(rw),
  });
  t('artifact-each-version-own-maker', !!o1 && !!o2 && inMake(rr.doc, o1.id).length === 1 && inMake(rr.doc, o2.id).length === 1 && inMake(rr.doc, o1.id)[0][0] !== inMake(rr.doc, o2.id)[0][0], {
    expected: '每版产物各自由对应那一步产出（两个不同的加工卡）',
    actual: o1 && o2 ? `v1 来源 ${J(inMake(rr.doc, o1.id).map(e => e[0]))}，v2 来源 ${J(inMake(rr.doc, o2.id).map(e => e[0]))}` : '缺版本卡',
    input: '同一条对话',
  });
  t('artifact-rewrite-does-not-overwrite', !!o1 && !!o2 && edgesBetween(rr.doc, o1.id, o2.id, 'make').length === 0, {
    expected: '新版本不能把旧版本「再产一次」（旧版只有原来源）',
    actual: o1 && o2 ? J(rr.doc.edges.filter(([a, b, k]) => a === o1.id && b === o2.id)) : '缺版本卡',
    input: '同一条对话',
  });
}

// =====================================================================
// 3) 看输出后换做法：两条路线各有真产物；调整原因不伪装成素材流
// =====================================================================
{
  seq = 0;
  const msgs = flat([
    U('按老做法出一版'),
    T('vision_analyze', { image_url: '/demo/参考/结构.png' }),
    T('write_file', { path: '/demo/交付/方案甲.png' }),
    A('方案甲好了 MEDIA:/demo/交付/方案甲.png'),
    U('/demo/交付/方案甲.png 这版不行，换一种做法'),       // 意见（还带上了产物路径）
    T('vision_analyze', { image_url: '/demo/参考/结构.png' }),
    T('write_file', { path: '/demo/交付/方案乙.png' }),
    A('方案乙好了 MEDIA:/demo/交付/方案乙.png'),
  ]);
  const plan = { name: '换做法', steps: [
    { key: 's1', from: 2, to: 5, title: '按老做法出甲', body: '用结构图出方案甲', status: 'done' },
    { key: 's2', from: 7, to: 10, title: '换做法出乙', body: '换一种做法出方案乙', status: 'done', note: '你说这版不行', after: [{ path: '/demo/交付/方案甲.png', ver: 1 }] },
  ] };
  const { doc } = build(msgs, plan);
  const pA = doc.cards.find(c => c.kind === 'proc' && /老做法/.test(c.title));
  const pB = doc.cards.find(c => c.kind === 'proc' && /换做法/.test(c.title));
  const Aout = findByTitle(doc, /方案甲\.png/, 'out')[0];
  const Bout = findByTitle(doc, /方案乙\.png/, 'out')[0];
  t('branch-both-routes-have-output', !!pA && !!Aout && !!pB && !!Bout && pA.id !== pB.id && Aout.id !== Bout.id && outMake(doc, pA.id).length === 1 && outMake(doc, pB.id).length === 1, {
    expected: '两条路线各自一步、各自一张真实产物',
    actual: J(dump(doc)),
    input: msgsLine(msgs),
  });
  t('branch-revise-link-from-seen-output', !!Aout && !!pB && edgesBetween(doc, Aout.id, pB.id, 'revise').length === 1, {
    expected: '换成乙的那一步，从「看了才改」的甲产物上有一条第 4 种边（改）',
    actual: Aout && pB ? J(doc.edges.filter(([a, b, k]) => a === Aout.id && b === pB.id)) : '缺卡片',
    input: 'plan.s2.after = 方案甲 v1',
  });
  t('branch-reason-is-not-material', pB && /不行/.test(String(pB.note || '')), {
    expected: '人的意见作为「改动原因」挂在被改的那一步（note），不单独画成素材/加工',
    actual: pB ? `note=「${pB.note}」` : '没有换做法那张卡',
    input: 'U#7「…这版不行，换一种做法」',
  });
  t('branch-opinion-no-material-node', doc.cards.every(c => !(c.kind === 'in' && /不行/.test(String(c.title) + String(c.body)))), {
    expected: '意见里提到的产物路径不能变成一张新的输入卡',
    actual: J(dump(doc)),
    input: '意见原文带 /demo/交付/方案甲.png',
  });
  t('branch-reference-material-count', (() => {
    const ref = findByTitle(doc, /结构\.png/, 'in');
    return ref.length === 1 && ref[0].uses === 2 && outUse(doc, ref[0].id).length === 2;
  })(), {
    expected: '同一个参考图被两次加工真用到：1 张素材卡、2 条用边（意见不算第三次使用）',
    actual: J(findByTitle(doc, /结构\.png/, 'in').map(c => ({ u: c.uses }))),
    input: msgsLine(msgs),
  });

  // 模型把「真有工具调用、真产出」的消息标成只提议未执行：不能凭空多一张「未执行」卡与真实步骤并存
  seq = 0;
  const claim = flat([
    U('出一版'),
    { id: ++seq, role: 'assistant', text: '我先把参考资料读了，然后写文件。', at: seq * 1000, tools: [{ name: 'read_file', args: { path: '/demo/参考/乙.png' }, callId: 'c1' }] },
    { id: ++seq, role: 'tool', text: '', at: seq * 1000, toolCallId: 'c1', ok: true },
    { id: ++seq, role: 'assistant', text: '写好了。MEDIA:/demo/交付/乙.md', at: seq * 1000, tools: [{ name: 'write_file', args: { path: '/demo/交付/乙.md' }, callId: 'c2' }] },
    { id: ++seq, role: 'tool', text: '', at: seq * 1000, toolCallId: 'c2', ok: true },
  ]);
  const claimBuild = build(claim, { steps: [
    { key: 's1', from: 2, to: 5, title: '出乙', status: 'done' },
    { key: 's2', msg: 2, status: 'proposed', title: '提议的做法', body: '只是提议' },
  ] });
  const propCards = claimBuild.doc.cards.filter(c => c.status === 'proposed');
  const realCards = claimBuild.doc.cards.filter(c => c.status === 'done');
  t('proposed-claim-not-duplicating-real-step', propCards.length === 0 || realCards.length === 0, {
    expected: '一段真有调用、真有产出的消息被模型标成「只提议」时，不能同时出现「未执行」和「已完成」两张卡（应标待确认或并入真实步骤）',
    actual: `未执行卡 ${propCards.length} 张（${J(propCards.map(c => c.title))}），已完成卡 ${realCards.length} 张：${J(dump(claimBuild.doc))}`,
    input: 'plan.steps = [{from:2,to:5,status:done}, {msg:2,status:proposed}]；消息 2 带 read_file 调用',
  });

  // 两步互指「因为看了对方的产物才改」：时间上不可能，不能静默连成环
  seq = 0;
  const mutual = flat([
    U('先出甲'),
    T('read_file', { path: '/demo/参考/源.png' }),
    T('write_file', { path: '/demo/交付/甲.png' }),
    A('甲好了 MEDIA:/demo/交付/甲.png'),
    U('再出乙'),
    T('write_file', { path: '/demo/交付/乙.png' }),
    A('乙好了 MEDIA:/demo/交付/乙.png'),
  ]);
  const mu = build(mutual, { steps: [
    { key: 's1', from: 2, to: 5, title: '出甲', status: 'done', after: [{ path: '/demo/交付/乙.png', ver: 1 }] },
    { key: 's2', from: 7, to: 9, title: '出乙', status: 'done', after: [{ path: '/demo/交付/甲.png', ver: 1 }] },
  ] });
  const reviseEdges = mu.doc.edges.filter(([, , k]) => k === 'revise');
  t('mutual-after-not-silent-cycle', mu.doc.problems.length > 0 || reviseEdges.length < 2, {
    expected: '两步互指「因为看了对方的产物才改」不可能发生：不能两条都照收，要么拒绝、要么在 problems 里说明',
    actual: `改边 ${reviseEdges.length} 条 ${J(reviseEdges)}，problems=${J(mu.doc.problems)}`,
    input: 'plan: 出甲.after=乙v1；出乙.after=甲v1',
  });
}

// =====================================================================
// 4) 旧产物被下一次加工真正读入：复用产物卡，不造第二张输入
// =====================================================================
{
  seq = 0;
  const msgs = flat([
    U('出一版稿'),
    T('read_file', { path: '/demo/参考/源.md' }),
    T('write_file', { path: '/demo/交付/稿.md' }),
    A('好了 MEDIA:/demo/交付/稿.md'),
    U('照这版稿再加工一步'),
    T('read_file', { path: '/demo/交付/稿.md' }),
    T('write_file', { path: '/demo/交付/成稿.md' }),
    A('成稿好了 MEDIA:/demo/交付/成稿.md'),
  ]);
  const { doc } = build(msgs, null);
  const inCards = doc.cards.filter(c => c.kind === 'in');
  const outV1 = doc.cards.find(c => c.kind === 'out' && c.ver === 1 && /稿\.md/.test(c.title) && !/成稿/.test(c.title));
  const p2 = doc.cards.find(c => c.kind === 'proc' && inUse(doc, c.id).length && (doc.cards.find(x => x.id === inUse(doc, c.id)[0][0]) || {}).kind === 'out');
  t('reuse-output-no-second-input', inCards.length === 1 && !!outV1, {
    expected: '稿.md 已经是本流程产物；下一步再读它时不另造输入卡（输入只剩参考源）',
    actual: `输入卡 ${inCards.length} 张：${J(inCards.map(c => c.title))}`,
    input: msgsLine(msgs),
  });
  t('reuse-output-use-edge', !!outV1 && outUse(doc, outV1.id).length === 1 && outUse(doc, outV1.id)[0][1] === (p2 && p2.id) && outV1.uses === 1, {
    expected: '旧产物 → 下一步加工之间有一条「用」边，计数 1',
    actual: outV1 ? `用边 ${outUse(doc, outV1.id).length} 条，计数 ${outV1.uses}` : '没有产出一版卡',
    input: '同一条对话',
  });

  // 同一步里先写再读自己刚做出来的东西：回读只是检查，不算「又被当素材用」
  seq = 0;
  const self = flat([
    U('出稿并检查'),
    T('write_file', { path: '/demo/交付/稿.png' }),
    T('read_file', { path: '/demo/交付/稿.png' }),
    A('完成了 MEDIA:/demo/交付/稿.png'),
  ]);
  const sf = build(self, null);
  const selfOut = sf.doc.cards.filter(c => c.kind === 'out' && /稿\.png/.test(c.title));
  t('self-reread-not-a-use', selfOut.length === 1 && outUse(sf.doc, selfOut[0].id).length === 0 && sf.doc.cards.filter(c => c.kind === 'in').length === 0, {
    expected: '同一步写出来又回读，不产生「用自己产物」的边，也不多一张输入卡',
    actual: J({ cards: dump(sf.doc), edges: sf.doc.edges }),
    input: msgsLine(self),
  });

  // 回答里贴了交付路径、但这步一次工具都没动：不算产出
  seq = 0;
  const mediaOnly = [U('给我看看'), A('给你 MEDIA:/demo/交付/旧图.png')];
  const mo = build(mediaOnly, null);
  t('media-without-action-not-output', mo.doc.cards.length === 0, {
    expected: '只在回答里贴了文件路径、没有真实动作 → 不产生产物卡（不冒充交付）',
    actual: J(dump(mo.doc)),
    input: msgsLine(mediaOnly),
  });
}

// =====================================================================
// 5) 状态：失败 / 进行中 / 只提议，不冒充完成
// =====================================================================
{
  // 写失败
  seq = 0;
  const failed = flat([U('出稿'), T('read_file', { path: '/demo/参考/来.png' }), T('write_file', { path: '/demo/交付/去.md' }, false), A('这次没写成。')]);
  const fl = build(failed, null);
  const fOut = fl.doc.cards.filter(c => c.kind === 'out');
  t('failed-write-marked-failed', fOut.length === 1 && fOut[0].status === 'failed' && !/已完成/.test(fOut[0].body), {
    expected: '写失败 → 产物卡状态失败，正文不能写「已完成」',
    actual: J(dump(fl.doc)),
    input: msgsLine(failed),
  });
  // 失败后重试成功：两版分开记
  seq = 0;
  const retry = flat([U('出一版'), T('write_file', { path: '/demo/交付/稿.md' }, false), A('没写成。'), U('再试一次'), T('write_file', { path: '/demo/交付/稿.md' }), A('这次好了 MEDIA:/demo/交付/稿.md')]);
  const rt = build(retry, null);
  const rtOut = findByTitle(rt.doc, /稿\.md/, 'out');
  t('failed-then-retry-two-versions', rtOut.length === 2 && rtOut.some(c => c.ver === 1 && c.status === 'failed') && rtOut.some(c => c.ver === 2 && c.status === 'done'), {
    expected: '失败的第 1 版与重试成功的第 2 版分开记；失败那版不能翻成完成',
    actual: J(rtOut.map(c => [c.ver, c.status])),
    input: msgsLine(retry),
  });
  // 写失败但回答里照旧贴了交付路径：仍算失败
  seq = 0;
  const lie = flat([U('出稿'), T('write_file', { path: '/demo/交付/去.md' }, false), A('写好了 MEDIA:/demo/交付/去.md')]);
  const lc = build(lie, null);
  t('failed-write-not-rescued-by-media', lc.doc.cards.every(c => !(c.kind === 'out' && c.status === 'done')), {
    expected: '写失败、回答却贴了路径：产物仍是失败，不翻成完成',
    actual: J(lc.doc.cards.filter(c => c.kind === 'out').map(c => [c.title, c.status])),
    input: msgsLine(lie),
  });
  // 只提议没执行
  seq = 0;
  const prop = flat([U('有没有更省事的做法'), A('可以改用另一套模板，先把结构简化再出图，这样能省一步。')]);
  const pr = build(prop, { steps: [{ key: 's1', msg: prop[1].id, status: 'proposed', title: '提议简化', body: '回答里提议换个做法' }] });
  const prCards = pr.doc.cards.filter(c => c.kind === 'proc');
  t('proposed-isolated-no-edges', prCards.length === 1 && prCards[0].status === 'proposed' && pr.doc.edges.length === 0 && pr.doc.cards.filter(c => c.kind === 'out').length === 0, {
    expected: '只提议没动手：一张「未执行」卡、无任何连线、无产物',
    actual: J({ cards: dump(pr.doc), edges: pr.doc.edges }),
    input: msgsLine(prop),
  });
  // 模型说未执行、记录里真有产出：以记录为准
  seq = 0;
  const real = flat([
    U('出一版'),
    T('read_file', { path: '/demo/参考/丙.png' }),
    T('write_file', { path: '/demo/交付/丙.md' }),
    A('好了 MEDIA:/demo/交付/丙.md'),
  ]);
  const rl = build(real, { steps: [{ key: 's1', from: 2, to: 6, title: '出丙', status: 'proposed' }] });
  const rlProc = rl.doc.cards.find(c => c.kind === 'proc' && /出丙/.test(c.title));
  t('evidence-overrides-proposed-claim', !!rlProc && rlProc.status === 'done', {
    expected: '范围里真有调用和产出 → 状态以记录为准（已完成），不因模型说「未执行」而改成未执行',
    actual: rlProc ? rlProc.status : J(dump(rl.doc)),
    input: 'plan.steps=[{from:2,to:6,status:proposed}]，记录里有 write_file 成功',
  });
  // 进行中：最后一次写入还没有工具结果
  seq = 0;
  const pending = flat([
    U('出稿'),
    T('read_file', { path: '/demo/参考/来.png' }),
    TPending('write_file', { path: '/demo/交付/去.png' }),
  ]);
  const pd = build(pending, null);
  const pdOut = pd.doc.cards.filter(c => c.kind === 'out');
  t('pending-write-not-done', pdOut.length === 0 || pdOut.every(c => c.status !== 'done' && !/已完成/.test(c.body)), {
    expected: '写入还没有工具结果（这一步正在做）：产物卡不能标成「已完成」/状态 done，应标正在做或待确认',
    actual: J(pdOut.map(c => [c.title, c.status, c.body])),
    input: msgsLine(pending),
  });
  // 读失败：不能画成「这份素材被用到了」
  seq = 0;
  const badRead = flat([
    U('用参考图出稿'),
    T('vision_analyze', { image_url: '/demo/参考/缺.png' }, false),
    T('write_file', { path: '/demo/交付/稿.md' }),
    A('好了 MEDIA:/demo/交付/稿.md'),
  ]);
  const br = build(badRead, null);
  const badMat = br.doc.cards.filter(c => c.kind === 'in' && /缺\.png/.test(c.title));
  t('failed-read-not-marked-used', badMat.every(c => c.uses === 0 && outUse(br.doc, c.id).length === 0), {
    expected: '读取失败的素材不能被标成「被用到」，也不该有使用边（可以留卡标明这次没读到）',
    actual: J(badMat.map(c => [c.title, c.uses, c.body])),
    input: msgsLine(badRead),
  });
}

// =====================================================================
// 6) 消息结构与异常：嵌套调用 / 结果对应 / 未知引用 / 重复 key / 寒暄 / 截断 / 异常输入
// =====================================================================
{
  // 嵌套工具调用（tool_call 外壳里包 N 个真实调用），其中 todo 不该落卡
  seq = 0;
  const nested = [
    U('出一份东西'),
    { id: ++seq, role: 'assistant', text: '', at: seq * 1000, tools: [{ name: 'tool_call', args: { calls: [
      { name: 'read_file', arguments: { path: '/demo/参考/甲.png' } },
      { name: 'write_file', arguments: { path: '/demo/交付/结果.md' } },
      { name: 'todo_write', arguments: { items: [] } },
    ] }, callId: 'nest1' }] },
    { id: ++seq, role: 'tool', text: '', at: seq * 1000, toolCallId: 'nest1:0', ok: true },
    { id: ++seq, role: 'tool', text: '', at: seq * 1000, toolCallId: 'nest1:1', ok: true },
    { id: ++seq, role: 'tool', text: '', at: seq * 1000, toolCallId: 'nest1:2', ok: true },
  ];
  const ns = build(nested, null);
  t('nested-calls-expanded', ns.doc.cards.some(c => c.kind === 'in' && /甲\.png/.test(c.title)) && ns.doc.cards.some(c => c.kind === 'out' && /结果\.md/.test(c.title)) && ns.doc.stats.tools === 3, {
    expected: '外壳里的嵌套调用按真实工具拆开：读到素材 + 写出产物，调用计 3 次',
    actual: J({ cards: dump(ns.doc), tools: ns.doc.stats.tools }),
    input: 'tool_call{calls:[read_file, write_file, todo_write]}',
  });
  t('nested-todo-not-a-card', ns.doc.cards.every(c => !/todo|用工具/.test(String(c.title) + String(c.body))), {
    expected: '待办（todo_write）不落卡、不进卡片正面',
    actual: J(dump(ns.doc)),
    input: '同一条消息',
  });
  t('nested-result-maps-to-call', (() => {
    seq = 0;
    const m = [
      U('出一份东西'),
      { id: ++seq, role: 'assistant', text: '', at: seq * 1000, tools: [{ name: 'tool_call', args: { calls: [
        { name: 'read_file', arguments: { path: '/demo/参考/甲.png' } },
        { name: 'write_file', arguments: { path: '/demo/交付/结果.md' } },
      ] }, callId: 'nest2' }] },
      { id: ++seq, role: 'tool', text: '', at: seq * 1000, toolCallId: 'nest2:0', ok: true },
      { id: ++seq, role: 'tool', text: '', at: seq * 1000, toolCallId: 'nest2:1', ok: false },
    ];
    const d = build(m, null).doc;
    const o = d.cards.filter(c => c.kind === 'out');
    return o.length === 1 && o[0].status === 'failed' && d.stats.failed === 1;
  })(), {
    expected: '嵌套调用的工具结果要按自己的 id 对上：第 2 个子调用失败 → 那张产物卡失败',
    actual: '见上一条构造（nest2:1 失败）',
    input: 'tool_call{calls:[read_file, write_file]} + 结果 nest2:1=false',
  });
  t('unknown-tool-result-tolerated', (() => {
    seq = 0;
    const m = flat([
      U('出一版'),
      T('read_file', { path: '/demo/参考/一.png' }),
      T('write_file', { path: '/demo/交付/一.md' }),
      A('好了 MEDIA:/demo/交付/一.md'),
    ]);
    m.push({ id: ++seq, role: 'tool', text: '', at: seq * 1000, toolCallId: 'no_such_call', ok: false });
    try {
      const d = build(m, null).doc;
      return d.cards.filter(c => c.kind === 'out').every(c => c.status === 'done');
    } catch (e) { return false; }
  })(), {
    expected: '对不上任何调用的工具结果行：忽略，不把已有产物改成失败，不抛错',
    actual: '构造一条 toolCallId=no_such_call 的失败结果追加到末尾',
    input: '同一条对话 + 一条孤立工具结果',
  });
  // 未知的 after 引用
  seq = 0;
  const base = flat([U('出一版'), T('read_file', { path: '/demo/参考/一.png' }), T('write_file', { path: '/demo/交付/一.md' }), A('好了 MEDIA:/demo/交付/一.md')]);
  const unk = build(base, { steps: [{ key: 's1', from: 2, to: 6, title: '出一', status: 'done', after: [{ path: '/demo/交付/不存在.md', ver: 3 }] }] });
  t('unknown-after-marked-pending', unk.doc.problems.length >= 1 && (unk.doc.cards.find(c => c.kind === 'proc' && /出一/.test(c.title)) || {}).status === 'pending', {
    expected: '引用了记录里找不到的旧产物：标待确认 + 在 problems 里说明，不硬连线',
    actual: J({ status: (unk.doc.cards.find(c => c.kind === 'proc' && /出一/.test(c.title)) || {}).status, problems: unk.doc.problems }),
    input: 'plan.after = /demo/交付/不存在.md v3',
  });
  // 重复 key / 范围重叠：整份不用，退回底账，真实产出照样在
  const dupKey = build(base, { steps: [{ key: 's1', from: 2, to: 3, title: '甲', status: 'done' }, { key: 's1', from: 4, to: 6, title: '乙', status: 'done' }] });
  t('dup-step-key-falls-back', dupKey.doc.problems.some(p => /重复/.test(p)) && dupKey.doc.cards.some(c => c.kind === 'out' && /一\.md/.test(c.title)) && dupKey.doc.cards.filter(c => c.kind === 'proc').length === 1, {
    expected: '重复步骤 key：整份不用、记 problem，退回底账后真实产物仍在（不半份糊上）',
    actual: J({ problems: dupKey.doc.problems, cards: dump(dupKey.doc) }),
    input: 'plan 两步都用 key=s1',
  });
  const overlap = build(base, { steps: [{ key: 's1', from: 2, to: 4, title: '甲', status: 'done' }, { key: 's2', from: 4, to: 6, title: '乙', status: 'done' }] });
  t('overlap-range-falls-back', overlap.doc.problems.some(p => /重叠/.test(p)) && overlap.doc.cards.some(c => c.kind === 'out' && /一\.md/.test(c.title)), {
    expected: '两步范围重叠：整份不用、记 problem，不把范围算两次',
    actual: J({ problems: overlap.doc.problems, cards: dump(overlap.doc) }),
    input: 'plan 两步范围都在 4 号消息',
  });
  const broken = build(base, { steps: [{ key: 's1', from: 2, title: '半截' }] });
  t('broken-plan-rejected-safely', broken.doc.problems.length >= 1 && broken.doc.cards.length > 0, {
    expected: '残缺 plan（缺 to）：记 problem、退回底账，不抛错、不空图',
    actual: J({ problems: broken.doc.problems, cards: broken.doc.cards.length }),
    input: 'plan.steps=[{key:s1,from:2}]',
  });
  // 寒暄
  seq = 0;
  const hello = [];
  for (let i = 0; i < 6; i++) hello.push(U('你好'));
  const hl = build(hello, null);
  t('chatter-no-cards', hl.doc.cards.length === 0 && hl.doc.stats.chatter === 6, {
    expected: '6 句寒暄：0 张卡，chatter 计数 6',
    actual: J({ cards: hl.doc.cards.length, chatter: hl.doc.stats.chatter }),
    input: '6 × U「你好」',
  });
  // 系统通知
  seq = 0;
  const notice = [{ id: ++seq, role: 'user', text: '[IMPORTANT: Background process 12 exited (exit code 0).]', at: seq * 1000 }];
  const nt = build(notice, null);
  t('system-notice-no-cards', nt.doc.cards.length === 0, {
    expected: '后台进程退出这类系统通知不是人说的话：0 张卡',
    actual: J(dump(nt.doc)),
    input: 'U「[IMPORTANT: Background process 12 exited…]」',
  });
  // 历史截断：读满 200 条要写清楚
  seq = 0;
  const many = [];
  for (let i = 0; i < 70; i++) many.push(U('第 ' + i + ' 轮'), ...T('read_file', { path: '/demo/资料/m' + (i % 3) + '.png' }));
  const cut = many.slice(0, 200);
  const cd = build(cut, null);
  const brief = lg.brief(cd.ev, {});
  t('history-truncated-flagged', cut.length === 200 && cd.doc.stats.truncated === true && cd.doc.evidence.truncated === true && /截断/.test(brief), {
    expected: '读满 200 条 = 更早的没看到：stats/evidence 标 truncated，证据摘要里写明',
    actual: J({ len: cut.length, stats: cd.doc.stats.truncated, ev: cd.doc.evidence.truncated, brief: /截断/.test(brief) }),
    input: '200 条消息（要求 + 读文件交替）',
  });
  // 窗口从半途开始（第一条不是人的要求）：不崩、不凭空造边
  seq = 0;
  const mid = flat([
    T('read_file', { path: '/demo/参考/旧.png' }),
    A('看过了，接下来要出图。'),
    U('好，出图'),
    T('write_file', { path: '/demo/交付/新.png' }),
    A('好了 MEDIA:/demo/交付/新.png'),
  ]);
  let midOk = false, midActual = '';
  try {
    const md = build(mid, null);
    const ids = new Set(md.doc.cards.map(c => c.id));
    midOk = md.doc.edges.every(([a, b]) => ids.has(a) && ids.has(b));
    midActual = J({ cards: dump(md.doc), edges: md.doc.edges });
  } catch (e) { midActual = '抛错：' + e.message; }
  t('mid-turn-window-safe', midOk, {
    expected: '窗口从半途开始（首条是工具调用）也能出图，边上不指向不存在的卡',
    actual: midActual,
    input: msgsLine(mid),
  });
  // 字段残缺
  const odd = [
    { id: NaN, role: 'user', text: '出图', at: 'oops' },
    { id: 0, role: 'assistant', text: null, tools: null, at: null },
    { role: 'assistant', tools: [{ name: 'write_file', args: null }, { args: { path: '/demo/a.md' } }], at: 1 },
    { id: 3, role: 'tool', toolCallId: 'nope', ok: false },
    { id: 4, role: 'user', text: { weird: true }, at: {} },
  ];
  let oddOk = false, oddErr = '';
  try { lg.buildGraph(lg.buildEvidence(odd, null), null); oddOk = true; } catch (e) { oddErr = String(e && e.message); }
  t('odd-fields-tolerated', oddOk, {
    expected: 'id/at/text/tools 字段残缺：不抛错',
    actual: oddErr || 'ok',
    input: '5 条字段残缺的消息',
  });
  // 数组里夹 null（脏数据）
  let nullOk = false, nullErr = '';
  try { lg.buildEvidence([null], null); nullOk = true; } catch (e) { nullErr = String(e && e.message); }
  t('null-message-tolerated', nullOk, {
    expected: '消息数组里夹了 null：跳过，不整条解析失败（健壮性，低）',
    actual: nullErr || 'ok',
    input: 'buildEvidence([null])',
  });
  // plan 里夹无效步骤项
  let planJunkOk = false, planJunkErr = '';
  try {
    const pj = build(base, { steps: [null, 3, { key: 'ok', from: 2, to: 6, title: '出一', status: 'done' }] });
    planJunkOk = pj.doc.cards.length > 0;
  } catch (e) { planJunkErr = String(e && e.message); }
  t('plan-junk-items-tolerated', planJunkOk, {
    expected: '模型给的 steps 里夹了 null / 数字：跳过无效项或整份退回底账，不能抛错（健壮性，低）',
    actual: planJunkErr || 'ok',
    input: 'plan.steps=[null, 3, {valid}]',
  });
  // 卡数上限 + 边不悬空
  seq = 0;
  const big = [];
  for (let i = 0; i < 150; i++) big.push(U('第 ' + i + ' 件'), ...T('write_file', { path: '/demo/交付/f' + i + '.md' }));
  const tt = Date.now();
  const bigDoc = lg.buildGraph(lg.buildEvidence(big, null), null);
  const bigMs = Date.now() - tt;
  const bigIds = new Set(bigDoc.cards.map(c => c.id));
  const dangling = bigDoc.edges.filter(([a, b]) => !bigIds.has(a) || !bigIds.has(b));
  t('card-cap-bounded', bigDoc.cards.length <= lg.MAX_CARDS && dangling.length === 0 && bigDoc.problems.length >= 1, {
    expected: `卡数不超过上限 ${lg.MAX_CARDS}，到顶要在 problems 里说明；边不能指向已被裁掉的卡`,
    actual: J({ cards: bigDoc.cards.length, dangling: dangling.length, problems: bigDoc.problems }),
    input: '150 轮（每轮写一个新文件）= 300 张候选卡',
  });
  t('card-cap-fast', bigMs < 3000, {
    expected: '满上限的输入 3 秒内返回',
    actual: bigMs + 'ms',
    input: '同上',
  });
  // 异常 plan：几千个步骤不能拖死
  const tj = Date.now();
  let hugeCards = -1, hugeProblems = 0, hugeErr = '';
  try {
    const h = lg.buildGraph(lg.buildEvidence(base, null), { steps: new Array(5000).fill({ key: 's', from: 1, to: 2 }) });
    hugeCards = h.cards.length; hugeProblems = h.problems.length;
  } catch (e) { hugeErr = String(e && e.message); }
  const hugeMs = Date.now() - tj;
  t('abnormal-plan-bounded', !hugeErr && hugeMs < 3000 && hugeCards >= 0 && hugeCards <= lg.MAX_CARDS, {
    expected: '5000 个畸形步骤：有限时间返回（<3s），卡数受上限约束，不抛错',
    actual: J({ err: hugeErr || null, ms: hugeMs, cards: hugeCards, problems: hugeProblems }),
    input: 'plan.steps = 5000 × {key:s,from:1,to:2}',
  });
  // 异常图跑布局：环 / 未知 id 不能卡死
  const weird = { cards: bigDoc.cards.slice(0, 10), edges: bigDoc.edges.concat([
    ['nope', bigDoc.cards[0].id, 'use'],
    [bigDoc.cards[0].id, bigDoc.cards[0].id, 'use'],
    [bigDoc.cards[0].id, bigDoc.cards[1].id, 'use'],
    [bigDoc.cards[1].id, bigDoc.cards[0].id, 'use'],
  ]) };
  const tl = Date.now();
  let cols = -1, layErr = '';
  try { cols = lg.layoutColumns(weird).columns; } catch (e) { layErr = String(e && e.message); }
  const layMs = Date.now() - tl;
  t('layout-survives-abnormal-graph', !layErr && layMs < 1000 && cols > 0 && cols <= weird.cards.length + 1, {
    expected: '带环、含未知 id 的图：布局 1 秒内返回，列数有界',
    actual: J({ err: layErr || null, ms: layMs, cols }),
    input: '10 张卡 + 未知 id 边 / 自环 / 双向边',
  });
}

// =====================================================================
// 7) 关系不变量（不钉卡数，按关系与来源核对）
// =====================================================================
{
  seq = 0;
  const mixed = flat([
    U('看两张参考'),
    T('vision_analyze', { image_url: '/demo/参考/甲.png' }),
    T('read_file', { path: '/demo/参考/乙.md' }),
    T('write_file', { path: '/demo/交付/合.md' }),
    A('合好了 MEDIA:/demo/交付/合.md'),
    U('再改一版'),
    T('read_file', { path: '/demo/交付/合.md' }),
    T('patch', { path: '/demo/交付/合.md' }),
    A('改好了 MEDIA:/demo/交付/合.md'),
    U('换个做法再出一版'),
    T('write_file', { path: '/demo/交付/合.md' }),
    A('换好了 MEDIA:/demo/交付/合.md'),
  ]);
  const { ev, doc } = build(mixed, null);
  const ids = new Map(doc.cards.map(c => [c.id, c]));
  const inv = (name, pass, expected, actual) => t('invariant-' + name, pass, { expected, actual, input: '看两张参考 → 改一版 → 换做法再出一版' });

  inv('edge-endpoints-exist', doc.edges.every(([a, b]) => ids.has(a) && ids.has(b)), '每条线的两端都是存在的卡', J(doc.edges.filter(([a, b]) => !ids.has(a) || !ids.has(b))));
  inv('no-self-edge', doc.edges.every(([a, b]) => a !== b), '没有自己连自己的线', J(doc.edges.filter(([a, b]) => a === b)));
  inv('no-duplicate-edge', new Set(doc.edges.map(([a, b, k]) => a + '>' + b + ':' + (k || 'use'))).size === doc.edges.length, '同一条线不重复', 'edges=' + doc.edges.length);
  inv('every-output-has-maker', doc.cards.filter(c => c.kind === 'out').every(c => inMake(doc, c.id).length === 1), '每张产物卡恰好由一个加工步骤产出', J(doc.cards.filter(c => c.kind === 'out' && inMake(doc, c.id).length !== 1).map(c => c.title)));
  inv('uses-count-matches-edges', doc.cards.filter(c => c.kind === 'in' || c.kind === 'out').every(c => (c.uses || 0) === outUse(doc, c.id).length), '素材/产物卡上的使用数 = 从它出发的「用」边条数', J(doc.cards.filter(c => (c.uses || 0) !== outUse(doc, c.id).length).map(c => [c.title, c.uses, outUse(doc, c.id).length])));
  inv('segments-cover-cards', doc.segments.length > 0 && doc.segments.flat().length === doc.cards.length && new Set(doc.segments.flat()).size === doc.cards.length, '每张卡恰好落在一段里（分段覆盖全部、不重复）', J(doc.segments.map(s => s.length)));
  inv('done-proc-has-output-edge', doc.cards.filter(c => c.kind === 'proc' && c.status === 'done').every(c => outMake(doc, c.id).length >= 1), '状态「已完成」的加工卡必须有它做出的产物边', J(doc.cards.filter(c => c.kind === 'proc' && c.status === 'done' && !outMake(doc, c.id).length).map(c => c.title)));
  inv('outputs-match-produced-versions', (() => {
    const produced = new Set();
    for (const u of ev.units) for (const o of u.outs) produced.add(o.key + '@v' + o.v);
    const made = new Set();
    for (const [, b, k] of doc.edges) if (k === 'make') made.add(ids.get(b) && (ids.get(b).title + '@v' + ids.get(b).ver));
    return produced.size === made.size;
  })(), '图上「做出来的版本」条数 = 底账里真实产出的版本数（多造或少造都算错）', J({ evOuts: [...ev.units].reduce((n, u) => n + u.outs.length, 0), docOuts: doc.cards.filter(c => c.kind === 'out').length }));
  inv('faces-human-details-in-impl', doc.cards.every(c => !/\/demo\/|MEDIA:|```/.test(String(c.title) + String(c.body))) && doc.cards.some(c => /\/demo\//.test(String(c.impl))), '卡片正面只说人话（路径/交付标记只在内部实现里）', J(doc.cards.filter(c => /\/demo\/|MEDIA:/.test(String(c.title) + String(c.body))).map(c => c.title)));
}

// ---------- 收尾 ----------
console.log('');
if (nFail) {
  console.log(`共 ${nPass + nFail} 条断言：PASS ${nPass} / FAIL ${nFail}`);
  console.log('待实现方修的问题：\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log(`全部通过（${nPass} 条断言）`);
process.exit(0);
