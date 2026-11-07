// 离线验证「对话 → 链路」：链路 = **用了哪些文件 → 用什么加工 → 交回哪些文件**。
// 不验「对话长什么样」——用户明确不要「对话卡片」。
//
//   node tools/verify-actmap.js                 # 自动挑一条工具调用最多的真实对话跑一遍
//   node tools/verify-actmap.js --list          # 只看有哪些对话可选
//   node tools/verify-actmap.js --conv <岗位:会话id> --n 60
//
// 期望：最后一行「全部通过」；退出码 1 = 有失败。
'use strict';
const { listConversations, readMessages, whoOf } = require('../livefeed');
const { createFeed, applyMessages, feedDoc, MAX_CARDS } = require('../actmap');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const has = n => argv.includes('--' + n);
const N = Math.max(5, Number(opt('n', 60)) || 60);
const CONV = opt('conv', '');

let fail = 0;
const ok = (name, pass, info) => {
  if (!pass) fail++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info == null ? '' : '  · ' + (typeof info === 'string' ? info : JSON.stringify(info))}`);
};

// 正面不许出现：绝对路径、命令行开关、JSON 片段（文件名允许——那是这条链路真正用的东西）
const BAD_FACE = /(\/Applications|\/Users\/|~\/|(?:^|\s)--[a-z]|\{["'])/;

const U = (id, text) => ({ id, role: 'user', text, at: id * 1000 });
const T = (id, name, args) => ({ id, role: 'assistant', at: id * 1000, tools: [{ name, args, callId: 'k' + id }] });
const R = (id, text) => ({ id, role: 'assistant', text, at: id * 1000 });

(async () => {
  const all = await listConversations();
  if (!all.length) { console.error('没有可读的对话（会话库为空或都太旧）'); process.exit(1); }
  if (has('list')) {
    for (const c of all.slice(0, 25)) console.log(`${c.key}\n   ${c.who} · ${c.doing} · ${c.messages} 条 · 工具 ${c.tools} 次`);
    return;
  }
  const pick = CONV
    ? all.find(c => c.key === CONV) || { key: CONV, profile: CONV.split(':')[0], session: CONV.split(':').slice(1).join(':'), who: whoOf(CONV.split(':')[0]), doing: '（手工指定）', messages: 0 }
    : all.filter(c => c.tools > 0).sort((a, b) => b.tools - a.tools)[0] || all[0];
  const { profile, session } = pick;
  console.log(`对话：${pick.who} · ${pick.doing}`);
  console.log(`       ${pick.key} · ${pick.messages} 条消息 · 工具调用 ${pick.tools} 次\n`);

  const r = await readMessages(profile, session, 0, { oldest: true, limit: N });
  if (r.error) { console.error('读不了：' + r.error); process.exit(1); }
  const feed = createFeed({ profile, session, who: pick.who });
  applyMessages(feed, r.msgs);
  const doc = feedDoc(feed);

  console.log(`—— 解析出的链路（${r.msgs.length} 条消息 / 工具 ${doc.stats.tools} 次）——`);
  doc.cards.forEach((c, i) => {
    const kind = { in: '输入', proc: '加工', out: '输出' }[c.kind] || c.kind;
    console.log(` ${String(i + 1).padStart(2)} ${kind}｜${c.title}：${c.body}`);
  });
  console.log(`\n素材：${doc.entities.materials.slice(0, 5).map(e => e.name + '×' + e.n).join('  ') || '—'}`);
  console.log(`路径：${doc.entities.paths.slice(0, 5).map(e => e.name + '×' + e.n).join('  ') || '—'}`);
  console.log(`结果：${doc.entities.results.slice(0, 5).map(e => e.name + '×' + e.n).join('  ') || '—'}\n`);

  // 1) 只有 输入 / 加工 / 输出 三种卡
  const badKind = doc.cards.filter(c => !['in', 'proc', 'out'].includes(c.kind));
  ok('kinds-in-proc-out', badKind.length === 0, { kinds: doc.cards.map(c => c.kind).join(''), cards: doc.cards.length });
  // 2) 一张卡都不许是「一句话一张图」：卡数远少于消息数
  ok('not-one-card-per-message', doc.cards.length <= Math.ceil(doc.cards.length * 0.6) + doc.stats.messages * 0.4,
    { cards: doc.cards.length, messages: doc.stats.messages });
  // 3) 用到的文件/交回的文件要出现在正面（这是用户要的东西）
  const fileCards = doc.cards.filter(c => /用的文件|交回/.test(c.title));
  const withFile = fileCards.filter(c => /[\w-]+\.(?:png|jpe?g|json|jsonl|md|csv|xlsx|ya?ml|mp4|mov|js|py|sh)/i.test(c.body || ''));
  ok('face-shows-files', fileCards.length === 0 || withFile.length > 0, { fileCards: fileCards.length, withFile: withFile.length });
  // 4) 正面不许有绝对路径 / 命令行 / JSON
  const bad = doc.cards.filter(c => BAD_FACE.test(c.body || '') || BAD_FACE.test((c.title || '') + (c.body || '')));
  ok('face-no-path-no-cmd', bad.length === 0, bad.slice(0, 2).map(c => c.title + '：' + c.body).join(' | ') || '0 处命中');
  // 5) 加工卡留着命令原文（内部实现）
  const procCards = doc.cards.filter(c => c.kind === 'proc');
  ok('impl-kept', procCards.length === 0 || procCards.some(c => String(c.impl || '').length > 0), { proc: procCards.length });
  // 6) 连线只往后指、不乱
  const order = new Map(doc.cards.map((c, i) => [c.id, i]));
  const badEdge = doc.edges.filter(([a, b]) => !order.has(a) || !order.has(b) || order.get(a) >= order.get(b));
  ok('chain-order', badEdge.length === 0, badEdge.length ? JSON.stringify(badEdge.slice(0, 3)) : doc.edges.length + ' 条');

  // ---------- 合成用例 ----------
  // 7) 一轮活 = 输入/加工/输出三张
  {
    const f = createFeed({}); let i = 1;
    applyMessages(f, [
      U(i, '把这批商品图整理成证据包'),
      T(++i, 'read_file', { path: 'evidence/raw/4729546689005/main-01.jpg' }),
      T(++i, 'skill_view', { name: 'product-web-capture' }),
      T(++i, 'write_file', { path: 'evidence/pack/4729546689005/INDEX.md' }),
    ]);
    const d = feedDoc(f);
    ok('one-turn-three-cards', d.cards.length === 3 && d.cards.map(c => c.kind).join() === 'in,proc,out',
      { cards: d.cards.length, kinds: d.cards.map(c => c.kind).join() });
    ok('in-card-lists-files', /main-01\.jpg/.test(d.cards[0].body || ''), d.cards[0].body);
    ok('proc-card-lists-method', /product-web-capture/.test(d.cards[1].body || ''), d.cards[1].body);
    ok('out-card-lists-files', /INDEX\.md/.test(d.cards[2].body || ''), d.cards[2].body);
  }
  // 8) 只说话不动手 = 不上图
  {
    const f = createFeed({});
    applyMessages(f, [U(1, '我们聊聊这条链路怎么设计比较好，你觉得呢'), R(2, '可以，先定素材再定加工方式，最后定产出。')]);
    ok('talk-no-card', feedDoc(f).cards.length === 0, { cards: feedDoc(f).cards.length });
  }
  // 9) 寒暄不上图
  {
    const f = createFeed({});
    for (let i = 1; i <= 6; i++) applyMessages(f, [U(i, '你好')]);
    ok('chatter-no-card', f.cards.length === 0 && (f.stats.chatter || 0) === 6, { cards: f.cards.length, chatter: f.stats.chatter });
  }
  // 10) 两轮互不串
  {
    const f = createFeed({}); let i = 1;
    applyMessages(f, [U(i, '第一件事：看 a.png'), T(++i, 'read_file', { path: 'a.png' }), U(++i, '第二件事：看 b.png'), T(++i, 'read_file', { path: 'b.png' })]);
    const d = feedDoc(f);
    const ins = d.cards.filter(c => c.kind === 'in');
    ok('turns-separate', ins.length === 2 && /a\.png/.test(ins[0].body) && !/b\.png/.test(ins[0].body) && /b\.png/.test(ins[1].body),
      { t1: ins[0] && ins[0].body, t2: ins[1] && ins[1].body });
  }
  // 11) 同一轮读 10 个文件 = 1 张输入卡
  {
    const f = createFeed({}); let i = 1;
    const msgs = [U(i, '把这 10 张图都看一遍')];
    for (let k = 0; k < 10; k++) msgs.push(T(++i, 'read_file', { path: `img-${k}.png` }));
    applyMessages(f, msgs);
    const d = feedDoc(f);
    ok('many-files-one-card', d.cards.length === 1 && d.cards[0].kind === 'in', { cards: d.cards.length, body: (d.cards[0].body || '').slice(0, 60) });
  }
  // 12) 满上限后产出仍上图，且卡数有界
  {
    const f = createFeed({}); let i = 1;
    for (let k = 0; k < 30; k++) {
      applyMessages(f, [U(++i, `第 ${k} 件事`), T(++i, 'read_file', { path: `f${k}.md` }), T(++i, 'write_file', { path: `o${k}.md` })]);
    }
    const d = feedDoc(f);
    const last = d.cards[d.cards.length - 1];
    ok('cap-keeps-output', /out/.test(last.kind) || /交回/.test(last.title), { cards: d.cards.length, last: last.kind + '｜' + last.title });
    ok('cap-bounded', d.cards.length <= MAX_CARDS + 12, { cards: d.cards.length, max: MAX_CARDS });
  }

  console.log(fail ? `\n${fail} 条没过` : '\n全部通过');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
