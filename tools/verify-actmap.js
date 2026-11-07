// 真实对话的结构体检（只读）：把一条真会话读成底账 → 画成链路，查「材料版本 / 逐次产物 / 关系不伪造」。
// 不联网、不调模型；只读 state.db（livefeed 用 sqlite3 -readonly + mode=ro）。
//
//   node tools/verify-actmap.js                 # 自动挑工具调用最多的一条真实对话
//   node tools/verify-actmap.js --list          # 看有哪些对话可选
//   node tools/verify-actmap.js --conv 岗位:会话id --n 200
//
// 期望最后一行「全部通过」。规则级的离线样本在 tools/check-livegraph.js（不依赖真实库）。
'use strict';
const { listConversations, readMessages, whoOf } = require('../livefeed');
const { buildEvidence, buildGraph, mapping } = require('../livegraph');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const has = n => argv.includes('--' + n);
const N = Math.max(10, Number(opt('n', 200)) || 200);
const CONV = opt('conv', '');

let fail = 0;
const ok = (name, pass, info) => {
  if (!pass) fail++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info == null ? '' : '  · ' + (typeof info === 'string' ? info : JSON.stringify(info))}`);
};
const FACE_BAD = /(\/Applications|\/Users\/|~\/|(?:^|\s)--[a-z]|\{["']|MEDIA:)/;

(async () => {
  const all = await listConversations();
  if (!all.length) { console.error('没有可读的对话（会话库为空或都太旧）'); process.exit(1); }
  if (has('list')) {
    for (const c of all.slice(0, 25)) console.log(`${c.key}\n   ${c.who} · ${c.doing} · ${c.messages} 条 · 工具 ${c.tools} 次`);
    return;
  }
  const pick = CONV
    ? all.find(c => c.key === CONV) || { key: CONV, profile: CONV.split(':')[0], session: CONV.split(':').slice(1).join(':'), who: whoOf(CONV.split(':')[0]), doing: '（手工指定）', messages: 0, tools: 0 }
    : all.filter(c => c.tools > 0).sort((a, b) => b.tools - a.tools)[0] || all[0];
  console.log(`对话：${pick.who} · ${pick.doing}`);
  console.log(`       ${pick.key} · ${pick.messages} 条 · 工具 ${pick.tools} 次\n`);

  const r = await readMessages(pick.profile, pick.session, 0, { limit: N });
  if (r.error) { console.error('读不了：' + r.error); process.exit(1); }
  const ev = buildEvidence(r.msgs, { key: pick.key });
  const doc = buildGraph(ev);

  // 1) 只有 输入 / 加工 / 输出 三种卡；没有「点评」这种流水账卡
  ok('kinds-in-proc-out', doc.cards.every(c => ['in', 'proc', 'out'].includes(c.kind)),
    { kinds: [...new Set(doc.cards.map(c => c.kind))], cards: doc.cards.length });
  ok('no-review-card', doc.cards.every(c => !/^点评/.test(c.title || '')));
  // 2) 同一个路径的同一个版本只有一张卡（材料复用不能变成多张总卡/重复卡）
  const keyOf = c => {
    const f = (c.impl || '').split('\n').find(l => l.startsWith('文件：'));
    return f ? f + '@' + (c.ver || 0) : '';
  };
  const dup = doc.cards.map(keyOf).filter((k, i, a) => k && a.indexOf(k) !== i);
  ok('no-duplicate-version-card', dup.length === 0, { dup: dup.slice(0, 3) });
  // 3) 连线两端都存在、没有自连 / 没有为了连通硬补的线（buildGraph 不补线）
  const ids = new Set(doc.cards.map(c => c.id));
  const bad = doc.edges.filter(([a, b]) => !ids.has(a) || !ids.has(b) || a === b);
  ok('edges-resolve', bad.length === 0, { edges: doc.edges.length, bad: bad.slice(0, 3) });
  // 4) 失败的工具不冒充交付：状态 failed 的产物卡不能同时是 done
  ok('failed-not-done', doc.cards.every(c => !(c.status === 'failed' && c.kind === 'out' && /已完成/.test(c.body || ''))));
  // 5) 正面说人话：路径 / 命令 / MEDIA 只在内部实现
  const dirty = doc.cards.filter(c => FACE_BAD.test(String(c.title) + String(c.body)));
  ok('face-human', dirty.length === 0, { dirty: dirty.slice(0, 2).map(c => c.title) });
  // 6) 每个加工卡都能追到证据（消息号）
  const noEv = doc.cards.filter(c => c.kind === 'proc' && !/消息 \d+/.test(String(c.impl)));
  ok('proc-has-evidence', noEv.length === 0, { missing: noEv.slice(0, 2).map(c => c.title) });
  // 7) 版本链：同一文件多版本时，旧版本卡还在（不被新版本覆盖）
  const multi = doc.cards.filter(c => c.versions > 1);
  ok('versions-kept', multi.length === 0 || multi.every(c => c.ver >= 1), { multi: multi.slice(0, 4).map(c => c.title + ' v' + c.ver) });

  console.log(`\n—— ${doc.stats.cards} 张卡 / ${doc.edges.length} 条关系 / ${doc.stats.materials} 份材料 / ${doc.stats.artifacts} 个产物${ev.truncated ? ' · 只看了最近一段' : ''} ——`);
  for (const c of doc.cards.slice(0, 40)) console.log(` ${({ in: '输入', proc: '加工', out: '输出' })[c.kind]}｜${c.title}：${c.body}${c.note ? '（改：' + c.note + '）' : ''}`);
  console.log(`\n对照证据（前 5 步）：`);
  for (const row of mapping(ev, doc).rows.slice(0, 5)) console.log(' ' + JSON.stringify(row));

  console.log(fail ? `\n${fail} 条没过` : '\n全部通过');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
