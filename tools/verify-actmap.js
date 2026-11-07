// 离线验证「对话 → 链路卡」：拿一条真实的历史对话跑一遍映射，不联网、不调模型、不写库。
//
//   node tools/verify-actmap.js                 # 自动挑一条消息最多的真实对话，跑「最早 30 条 → 卡片」
//   node tools/verify-actmap.js --list          # 只看有哪些对话可选
//   node tools/verify-actmap.js --conv <岗位:会话id> --n 30
//   node tools/verify-actmap.js --conv <岗位:会话id> --oldest 400   # 从最早读到 400 条（看开头怎么起链）
//
// 期望：最后一行「全部通过」；退出码 1 = 有失败。
'use strict';
const { listConversations, readMessages, whoOf } = require('../livefeed');
const { createFeed, applyMessages, feedDoc } = require('../actmap');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const has = n => argv.includes('--' + n);
const N = Math.max(5, Number(opt('n', 30)) || 30);
const OLDEST = Math.max(N, Number(opt('oldest', 0)) || 0);
const CONV = opt('conv', '');

let fail = 0;
const ok = (name, pass, info) => {
  if (!pass) fail++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info == null ? '' : '  · ' + (typeof info === 'string' ? info : JSON.stringify(info))}`);
};

const TECH_FRONT = /(\/[\w.<>-]+\/|\{["']|`|(?:^|\s)--[a-z]|\b[\w-]+\.(?:json|jsonl|js|ts|py|sh|md|csv|ya?ml|xlsx)\b)/;

function lineOf(m) {
  const what = m.role === 'user' ? String(m.text || '').replace(/\s+/g, ' ').slice(0, 46)
    : m.tools && m.tools.length ? '[' + m.tools.map(t => t.name).join(' + ') + ']'
      : m.role === 'tool' ? '（工具结果 ' + (m.toolName || '') + '）'
        : String(m.text || '').replace(/\s+/g, ' ').slice(0, 46);
  return `${String(m.id).padStart(6)}  ${m.role.padEnd(9)}  ${what}`;
}

(async () => {
  const all = await listConversations();
  if (!all.length) { console.error('没有可读的对话（会话库为空或都太旧）'); process.exit(1); }
  if (has('list')) {
    for (const c of all.slice(0, 25)) console.log(`${c.key}\n   ${c.who} · ${c.doing} · ${c.messages} 条 · 工具 ${c.tools} 次`);
    return;
  }
  const pick = CONV
    ? all.find(c => c.key === CONV) || { key: CONV, profile: CONV.split(':')[0], session: CONV.split(':').slice(1).join(':'), who: whoOf(CONV.split(':')[0]), doing: '（手工指定）', messages: 0 }
    : all.filter(c => c.tools > 0).sort((a, b) => b.messages - a.messages)[0] || all[0];
  const { profile, session } = pick;
  console.log(`对话：${pick.who} · ${pick.doing}`);
  console.log(`       ${pick.key} · ${pick.messages} 条消息 · 工具调用 ${pick.tools} 次\n`);

  const head = await readMessages(profile, session, 0, { oldest: true, limit: OLDEST || N });
  if (head.error) { console.error('读不了：' + head.error); process.exit(1); }
  console.log(`—— 对话${OLDEST ? '最早 ' + OLDEST + ' 条' : '前 ' + N + ' 条'}里前 ${N} 条 ——`);
  head.msgs.slice(0, N).forEach(m => console.log(' ' + lineOf(m)));
  console.log('    …');
  console.log('');
  console.log(`—— 这 ${head.msgs.length} 条消息生成了哪几张卡 ——`);
  const feed = createFeed({ profile, session, who: pick.who });
  applyMessages(feed, head.msgs);
  const doc = feedDoc(feed);
  doc.cards.forEach((c, i) => {
    const kind = { in: '输入', proc: '加工', out: '输出' }[c.kind] || c.kind;
    console.log(` ${String(i + 1).padStart(2)} ${kind}｜${c.title}：${c.body}`);
    if (c.mods && c.mods.length) console.log(`      模块：${c.mods.map(m => m.name).join(' · ')}`);
    if (c.impl) String(c.impl).split('\n').forEach(l => console.log('      ↳ ' + l.slice(0, 110)));
  });
  console.log(`\n合计 ${doc.cards.length} 张卡、${doc.edges.length} 条连线；消息 ${doc.stats.messages} 条、工具调用 ${doc.stats.tools} 次、合并掉 ${doc.stats.merged} 次、略过 ${doc.stats.skipped} 条（前奏 / 系统话）\n`);

  // 1) 一条消息 ≠ 一张卡：工具调用次数远多于卡片数
  ok('not-one-card-per-message', doc.cards.length < Math.max(4, doc.stats.messages), { cards: doc.cards.length, messages: doc.stats.messages, tools: doc.stats.tools });
  // 2) 卡片正面只有人话：没有命令 / 绝对路径 / JSON / 字段名
  const dirty = doc.cards.filter(c => TECH_FRONT.test(c.title || '') || TECH_FRONT.test(c.body || '')).map(c => c.title + '：' + c.body);
  ok('front-is-human', dirty.length === 0, dirty.slice(0, 3).join(' | ') || '0 处命中');
  // 3) 链路只有 输入 / 加工 / 输出 三种卡：加工卡=「正在做」那一步，读/搜/跑/查都折进它的正文
  const badKind = doc.cards.filter(c => !['in', 'proc', 'out'].includes(c.kind));
  const kinds = doc.cards.map(c => c.kind);
  ok('kinds-in-proc-out', badKind.length === 0 && kinds.includes('in') && kinds.includes('out'),
    { kinds: kinds.join(''), cards: doc.cards.length });
  // 4) 中间动作没丢：折进这张卡的人话总结 + 内部实现
  const folded = doc.cards.filter(c => /读了|跑了|查了|翻了|看了|核了/.test(c.body || ''));
  ok('work-folded', doc.stats.tools === 0 || folded.length > 0, { folded: folded.length, tools: doc.stats.tools });
  ok('impl-kept', doc.cards.every(c => c.kind === 'in' || String(c.impl || '').length > 0 || c.kind === 'out'), { out_cards: doc.cards.filter(c => c.kind !== 'in').length });
  // 5) 整条链连成一片（每条边都指向后一张卡，顺序不乱）
  const order = new Map(doc.cards.map((c, i) => [c.id, i]));
  const badEdge = doc.edges.filter(([a, b]) => !order.has(a) || !order.has(b) || order.get(a) >= order.get(b));
  ok('chain-order', badEdge.length === 0, badEdge.length ? JSON.stringify(badEdge.slice(0, 3)) : doc.edges.length + ' 条');

  // ---------- 合成用例：连续读 10 个文件 → 1 张「正在做」卡（读了多少写在正文里）----------
  const f2 = createFeed({ profile: 'x', session: 'y', who: '样本' });
  const msgs = [{ id: 1, role: 'user', at: Date.now(), text: '把这几个文件找出来对一遍' }];
  for (let i = 0; i < 10; i++) {
    msgs.push({ id: 2 + i * 2, role: 'assistant', at: Date.now(), text: '', tools: [{ callId: 'k' + i, name: 'read_file', args: { path: '/tmp/demo-' + i + '.md' } }] });
    msgs.push({ id: 3 + i * 2, role: 'tool', at: Date.now(), toolCallId: 'k' + i, toolName: 'read_file', ok: true });
  }
  applyMessages(f2, msgs);
  const d2 = feedDoc(f2);
  ok('merge-10-reads-1-card', d2.cards.length === 2 && /读了 10 份资料/.test(d2.cards[1].body), { cards: d2.cards.length, second: d2.cards[1] && d2.cards[1].title + '：' + d2.cards[1].body, impl_lines: String(d2.cards[1] && d2.cards[1].impl).split('\n').length });

  // 6) 同一张卡就地更新：读到第 10 个时还是同一张（id 不变）
  const ids = new Set();
  const f3 = createFeed({});
  for (let i = 0; i < 10; i++) {
    applyMessages(f3, [{ id: i + 1, role: 'assistant', at: Date.now(), tools: [{ callId: 'z' + i, name: 'read_file', args: { path: '/tmp/x' + i } }] }]);
    ids.add(f3.cards.map(c => c.id).join(','));
  }
  ok('update-in-place', ids.size === 1, { ids: [...ids] });

  // 7) 换了动作类也还是这一张（读 → 跑命令 → 读）：图上只有一句「做了什么」
  const f4 = createFeed({});
  applyMessages(f4, [{ id: 1, role: 'user', at: Date.now(), text: '顺手对一下' }]);
  applyMessages(f4, [{ id: 2, role: 'assistant', at: Date.now(), tools: [{ callId: 'a', name: 'read_file', args: {} }] }]);
  applyMessages(f4, [{ id: 3, role: 'assistant', at: Date.now(), tools: [{ callId: 'b', name: 'terminal', args: { command: 'ls' } }] }]);
  applyMessages(f4, [{ id: 4, role: 'assistant', at: Date.now(), tools: [{ callId: 'c', name: 'read_file', args: {} }] }]);
  const d4 = feedDoc(f4);
  ok('one-doing-card-per-ask', d4.cards.length === 2 && /读了 2 份资料/.test(d4.cards[1].body) && /跑了 1 条命令/.test(d4.cards[1].body), { cards: d4.cards.map(c => c.kind + '｜' + c.title + '：' + c.body) });

  // 8) 回答到了，「正在做」就地变成「回答」（同一张卡，不新建）
  const f4b = createFeed({});
  applyMessages(f4b, [{ id: 1, role: 'user', at: Date.now(), text: '看一下这几个文件' }]);
  applyMessages(f4b, [{ id: 2, role: 'assistant', at: Date.now(), tools: [{ callId: 'a', name: 'read_file', args: { path: '/tmp/a.md' } }] }]);
  const before = feedDoc(f4b).cards.map(c => c.title);
  applyMessages(f4b, [{ id: 3, role: 'assistant', at: Date.now(), text: '三份资料都对齐了：数字一致，只有一处口径不同，已经按最新的改了。' }]);
  const d4b = feedDoc(f4b);
  ok('doing-updates-to-answer', d4b.cards.length === 2 && d4b.cards[1].title === '回答' && before.join() !== '回答', { before, after: d4b.cards.map(c => c.title + '：' + c.body.slice(0, 24)) });

  // 9) 写文件 / 派活是交出去的东西 → 输出卡，派活标出交给谁
  const f5 = createFeed({});
  applyMessages(f5, [
    { id: 1, role: 'assistant', at: Date.now(), tools: [{ callId: 'w', name: 'write_file', args: { path: '/tmp/a.md' } }] },
    { id: 2, role: 'assistant', at: Date.now(), tools: [{ callId: 'm', name: 'message_agent', args: { target: '示例岗位乙', message: '帮我核一下' } }] },
  ]);
  const d5 = feedDoc(f5);
  ok('output-and-handoff', d5.cards[0].kind === 'out' && d5.cards[0].title === '写文件' && /示例岗位乙/.test(d5.cards[1].title), { cards: d5.cards.map(c => c.kind + '｜' + c.title) });

  // 10) 寒暄不上画布；重复同一句真活只留一张卡
  const f6 = createFeed({});
  for (let i = 0; i < 6; i++) applyMessages(f6, [{ id: i + 1, role: 'user', at: Date.now(), text: '你好' }]);
  ok('chatter-no-card', f6.cards.length === 0, { cards: f6.cards.length, chatter: f6.stats.chatter || 0 });
  const f7 = createFeed({});
  for (let i = 0; i < 6; i++) applyMessages(f7, [{ id: i + 1, role: 'user', at: Date.now(), text: '把这三个文件对一下口径' }]);
  ok('repeat-ask-one-card', f7.cards.length === 1, { cards: f7.cards.length });

  console.log(fail ? `\n${fail} 条没过` : '\n全部通过');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
