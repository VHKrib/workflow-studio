// 离线样本：对话 → 工作链路（材料版本 / 逐次产物 / 调整原因 / 分支）。
// 不联网、不调模型、不读真实会话库——只喂合成的中性消息（示例部门 / 示例岗位 / 示例文件）。
//
//   node tools/check-livegraph.js          # 期望最后一行「全部通过」，退出码 0
//
// 断言的是**规则**，不是某次跑出来的数字：
// - 同一材料同一版本只有一张卡，被两次加工用到 = 两条「用」边；文字提及 / 重复轮询不涨计数；
// - 改参考素材、同名不同目录、同路径重写产物：身份与版本分得开，旧加工仍指旧版本；
// - 加工 A→产物 A，人看完换做法 B：A/B 各自留路线与产物，意见挂在被改的那一版上；
// - 新增核查环节 = 真实的新依赖；只提方案没执行 = 未执行卡，不连线到产物；
// - 失败工具不冒充交付；断句 / 未知引用 / 重复 key / 重叠分段 / 循环 / 异常图都有检查；
// - 寒暄、系统通知不生成节点；不相干的两段不硬连。
'use strict';
const lg = require('../livegraph');

let fail = 0;
const ok = (name, pass, info) => {
  if (!pass) fail++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info == null ? '' : '  · ' + (typeof info === 'string' ? info : JSON.stringify(info))}`);
};

// 合成消息：id 手工给，方便 plan 用消息号分段
let seq = 0;
const U = text => ({ id: ++seq, role: 'user', text, at: seq * 1000 });
const A = (text, at) => ({ id: ++seq, role: 'assistant', text, at: at || seq * 1000, tools: [] });
const T = (name, args, okv = true) => {
  const id = ++seq;
  const cid = 'call_' + id;
  return [
    { id, role: 'assistant', text: '', at: id * 1000, tools: [{ name, args, callId: cid }] },
    { id: ++seq, role: 'tool', text: '', at: seq * 1000, toolName: name, toolCallId: cid, ok: okv },
  ];
};
const flat = arr => arr.flat();
const build = (msgs, plan) => lg.buildGraph(lg.buildEvidence(msgs, { key: 'fixture' }), plan);
const cards = doc => doc.cards;
const byTitle = (doc, t) => doc.cards.filter(c => String(c.title).includes(t));
const edgesOf = (doc, a, b, k) => doc.edges.filter(([x, y, kk]) => (!a || x === a) && (!b || y === b) && (!k || kk === k));

// ---------- 1) 同一材料版本供两次加工用：来源节点唯一 + 两条使用边；文字提及 / 重复轮询不涨 ----------
{
  seq = 0;
  const msgs = flat([
    U('把示例材料整理成一版说明'),
    T('read_file', { path: '/demo/资料/示例需求.md' }),
    T('vision_analyze', { image_url: '/demo/参考/示例主图.png' }),
    T('write_file', { path: '/demo/交付/说明-v1.md' }),
    A('写好了。MEDIA:/demo/交付/说明-v1.md'),
    U('换一种做法，还是用同一份示例资料'),
    T('read_file', { path: '/demo/资料/示例需求.md' }),
    T('write_file', { path: '/demo/交付/说明-v2.md' }),
    A('这版改用另一种写法。MEDIA:/demo/交付/说明-v2.md'),
    U('你刚才是不是用了示例需求.md 那份？'),                          // 只是提了一嘴，不是使用
    A('是的，就是那份示例需求。'),
  ]);
  const plan = { name: '复用示例资料', steps: [
    { key: 's1', from: 2, to: 5, title: '写第一版说明', body: '用需求和主图写说明', status: 'done' },
    { key: 's2', from: 7, to: 9, title: '换写法再写一版', body: '同一份资料换一种写法', status: 'done', note: '人要求换做法' },
  ] };
  const doc = build(msgs, plan);
  const mat = byTitle(doc, '示例需求.md');
  ok('reuse-single-source', mat.length === 1, { cards: mat.map(c => c.id) });
  const useEdges = mat[0] ? edgesOf(doc, mat[0].id, null, 'use') : [];
  ok('reuse-two-use-edges', useEdges.length === 2, { edges: useEdges });
  ok('reuse-count-from-calls', mat[0] && mat[0].uses === 2, mat[0] && { uses: mat[0].uses });
  // 重复轮询（同一批消息再喂一遍）不改任何计数
  const ev1 = lg.buildEvidence(msgs, { key: 'fixture' });
  const ev2 = lg.buildEvidence(msgs.concat(msgs), { key: 'fixture' });
  const n1 = [...ev1.mats.values()].map(m => m.uses.length).join(',');
  const n2 = [...ev2.mats.values()].map(m => m.uses.length).join(',');
  ok('reuse-poll-no-double', n1 === n2 && ev2.calls.length === ev1.calls.length, { before: n1, after: n2 });
  // 两个产物都在、各自由对应加工产出
  ok('reuse-two-outputs', byTitle(doc, '说明-v1.md').length === 1 && byTitle(doc, '说明-v2.md').length === 1,
    { outs: doc.cards.filter(c => c.kind === 'out').map(c => c.title) });
}

// ---------- 2) 改参考素材 / 同名不同目录 / 同路径重写产物 ----------
{
  seq = 0;
  const msgs = flat([
    U('先看一下参考图'),
    T('vision_analyze', { image_url: '/demo/参考甲/底图.png' }),
    U('把参考图调亮一点'),
    T('write_file', { path: '/demo/参考甲/底图.png' }),               // 改的是同一份参考 → 材料涨版本
    A('调亮了。MEDIA:/demo/参考甲/底图.png'),
    U('再用别的目录那张同名图'),
    T('vision_analyze', { image_url: '/demo/参考乙/底图.png' }),       // 同名不同目录 → 另一个实体
    T('write_file', { path: '/demo/交付/图.png' }),
    A('出好了。MEDIA:/demo/交付/图.png'),
    U('这张再重出一版'),
    T('read_file', { path: '/demo/交付/图.png' }),
    T('write_file', { path: '/demo/交付/图.png' }),                   // 同路径重写 → 产物新版本
    A('重出了。MEDIA:/demo/交付/图.png'),
  ]);
  const plan = { name: '版本', steps: [
    { key: 's1', from: 2, to: 3, title: '看参考', body: '先读参考底图', status: 'done' },
    { key: 's2', from: 5, to: 6, title: '调亮参考', body: '把参考底图调亮', status: 'done' },
    { key: 's3', from: 9, to: 12, title: '用另一张同名图出图', body: '另一目录的同名底图', status: 'done' },
    { key: 's4', from: 15, to: 18, title: '重出同一张图', body: '同路径再出一版', status: 'done', note: '人要求重出' },
  ] };
  const doc = build(msgs, plan);
  const mats = doc.cards.filter(c => c.kind === 'in' && /底图\.png/.test(c.title));
  const paths = new Set(mats.map(m => (m.impl.split('\n').find(l => l.startsWith('文件：')) || '').trim()));
  ok('identity-same-name-diff-dir', mats.length === 3 && paths.size === 2, { mats: mats.map(m => m.title), paths: paths.size });
  const v1 = mats.find(c => c.ver === 1);
  const v2 = mats.find(c => c.ver === 2);
  ok('material-version-kept', !!v1 && !!v2 && edgesOf(doc, v1.id, v2.id, 'evolve').length === 1, { v1: v1 && v1.id, v2: v2 && v2.id });
  const p1 = doc.cards.find(c => c.title === '看参考');
  const p2 = doc.cards.find(c => c.title === '调亮参考');
  ok('old-processing-points-old-material', !!p1 && !!v1 && edgesOf(doc, v1.id, p1.id, 'use').length === 1
    && !!p2 && edgesOf(doc, p2.id, v2.id, 'make').length === 1,
    { p1: p1 && p1.id, p2: p2 && p2.id });
  const outCards = doc.cards.filter(c => c.kind === 'out' && /图\.png/.test(c.title));
  ok('artifact-rewrite-new-version', outCards.length === 2 && outCards.map(c => c.ver).sort().join(',') === '1,2',
    { outs: outCards.map(c => [c.title, c.ver]) });
  ok('artifact-not-overwritten', outCards[0].id !== outCards[1].id && edgesOf(doc, outCards[0].id, outCards[1].id, 'evolve').length === 1);
}

// ---------- 3) A → 产物 A；人看完换做法 B；新增核查；只提方案没执行 ----------
{
  seq = 0;
  const msgs = flat([
    U('按老做法出一版'),
    T('vision_analyze', { image_url: '/demo/参考/结构.png' }),
    T('write_file', { path: '/demo/交付/方案A.png' }),
    A('方案 A 好了。MEDIA:/demo/交付/方案A.png'),
    U('这版不行，换一种做法'),                                          // 点评：看着 A 说的
    T('vision_analyze', { image_url: '/demo/参考/结构.png' }),
    T('write_file', { path: '/demo/交付/方案B.png' }),
    A('方案 B 好了。MEDIA:/demo/交付/方案B.png'),
    U('再加一步核对尺寸'),
    T('read_file', { path: '/demo/交付/方案B.png' }),
    T('write_file', { path: '/demo/交付/核对.md' }),
    A('核对完了。MEDIA:/demo/交付/核对.md'),
    U('有没有更省事的办法'),
    A('可以改用另一套模板，先把结构简化后再出图，这样能省一步。'),        // 只提方案，没有调用
  ]);
  const proposalMsg = msgs.filter(m => m.role === 'assistant' && /可以改用/.test(m.text || '')).pop();
  const plan = { name: '换做法', steps: [
    { key: 's1', from: 2, to: 5, title: '按老做法出 A', body: '用结构图出方案 A', status: 'done' },
    { key: 's2', from: 8, to: 11, title: '换做法出 B', body: '换一种做法出方案 B', status: 'done',
      note: '你说「这版不行，换一种做法」', after: [{ path: '/demo/交付/方案A.png', ver: 1 }] },
    { key: 's3', from: 14, to: 17, title: '核对尺寸', body: '按方案 B 核对尺寸并出核对单', status: 'done' },
    { key: 's4', msg: proposalMsg.id, status: 'proposed', title: '提议简化结构', body: '回答里提议改用另一套模板，还没动手', note: '只提了方案' },
  ] };
  const doc = build(msgs, plan);
  const pA = doc.cards.find(c => c.title.includes('老做法'));
  const Aout = doc.cards.find(c => c.kind === 'out' && /方案A/.test(c.title));
  const pB = doc.cards.find(c => c.title.includes('换做法'));
  const Bout = doc.cards.find(c => c.kind === 'out' && /方案B/.test(c.title));
  const pC = doc.cards.find(c => c.kind === 'proc' && c.title.includes('核对'));
  const check = doc.cards.find(c => c.kind === 'out' && /核对/.test(c.title));
  const prop = doc.cards.find(c => c.status === 'proposed');
  ok('branch-keeps-old-route', !!pA && !!Aout && !!pB && !!Bout && edgesOf(doc, pA.id, Aout.id, 'make').length === 1,
    { cards: doc.cards.map(c => c.title) });
  ok('branch-shared-upstream', !!Aout && !!pB && edgesOf(doc, Aout.id, pB.id, 'revise').length === 1,
    { revise: edgesOf(doc, Aout.id, pB.id, 'revise') });
  ok('branch-opinion-on-adjusted-step', !!pB && /不行/.test(pB.note || ''), { note: pB && pB.note });
  ok('branch-two-outputs', !!Bout && Aout.id !== Bout.id);
  ok('check-step-real-dependency', !!pC && !!Bout && edgesOf(doc, Bout.id, pC.id, 'use').length === 1
    && edgesOf(doc, pC.id, check.id, 'make').length === 1, { pC: pC && pC.id });
  ok('proposed-not-executed', !!prop && prop.status === 'proposed' && edgesOf(doc, null, prop.id, 'make').length === 0,
    prop && { title: prop.title, status: prop.status });
  ok('proposed-has-no-output-edge', !!prop && doc.edges.every(([a, b]) => a !== prop.id && b !== prop.id));
  ok('evidence-kept', !!Aout && /消息 \d+/.test(Aout.impl) && !!pB && /消息 \d+/.test(pB.impl));
}

// ---------- 4) 失败工具 / 聊 / 系统通知 / 断句 / 未知引用 / 重复 key / 重叠分段 ----------
{
  seq = 0;
  const msgs = flat([
    U('你好'),
    U('出个示例文件'),
    T('write_file', { path: '/demo/交付/半成品.md' }, false),          // 写失败：不能当交付
    A('这次没写成：目录只读。'),
    U('把示例文件再出一次'),
    T('write_file', { path: '/demo/交付/成品.md' }, true),
    A('这次好了。MEDIA:/demo/交付/成品.md'),
    { id: 99, role: 'user', text: '[IMPORTANT: Background process 12 exited (exit code 0).]', at: 99000 },
  ]);
  const doc = build(msgs, null);
  const halfCards = doc.cards.filter(c => c.kind === 'out' && /半成品/.test(c.title));
  ok('failed-marked-not-done', halfCards.length === 1 && halfCards[0].status === 'failed'
    && doc.cards.filter(c => c.kind === 'out' && c.status === 'done' && /半成品/.test(c.title)).length === 0,
    { outs: doc.cards.filter(c => c.kind === 'out').map(c => [c.title, c.status]) });
  ok('chatter-no-node', doc.cards.every(c => !/你好/.test(c.title + c.body)), { cards: doc.cards.length });
  ok('system-notice-no-node', doc.cards.every(c => !/Background process|exit code/.test(c.title + c.body)));
  ok('success-still-delivered', doc.cards.some(c => c.kind === 'out' && /成品/.test(c.title)));

  // 未知的 after 引用：标待确认 + 说明，不硬连
  seq = 0;
  const m2 = flat([U('出一版'), T('read_file', { path: '/demo/参考/a.png' }), T('write_file', { path: '/demo/交付/一.png' }), A('好了 MEDIA:/demo/交付/一.png')]);
  const bad = build(m2, { steps: [{ key: 's1', from: 2, to: 3, title: '出一版', status: 'done', after: [{ path: '/不存在/别的.png', ver: 3 }] }] });
  const pc = bad.cards.find(c => c.kind === 'proc');
  ok('unknown-ref-marked', !!pc && pc.status === 'pending' && bad.problems.length >= 1, { status: pc && pc.status, problems: bad.problems });

  // 重复 key / 范围重叠：整份不用，退回底账，不半份糊上
  const dup = build(m2, { steps: [{ key: 's1', from: 2, to: 3, title: 'A', status: 'done' }, { key: 's1', from: 2, to: 3, title: 'B', status: 'done' }] });
  ok('dup-key-rejected', dup.problems.some(p => /重复/.test(p)) && dup.cards.some(c => c.kind === 'proc'), { problems: dup.problems });
  const ov = build(m2, { steps: [{ key: 's1', from: 2, to: 4, title: 'A', status: 'done' }, { key: 's2', from: 4, to: 5, title: 'B', status: 'done' }] });
  ok('overlap-rejected', ov.problems.some(p => /重叠/.test(p)), { problems: ov.problems });

  // 断句（模型给了半截 JSON）由 main 的解析器挡住；这里验 buildGraph 收到残缺 plan 不炸
  const broken = build(m2, { steps: [{ key: 's1', from: 2, title: '半截' }] });
  ok('broken-plan-safe', broken.cards.length > 0 && broken.problems.length > 0, { problems: broken.problems });
}

// ---------- 5) 不相干的两段：不硬连（宁可分段，也不为连通补线） ----------
{
  seq = 0;
  const msgs = flat([
    U('第一件事：整理示例资料'),
    T('read_file', { path: '/demo/资料/甲.md' }),
    T('write_file', { path: '/demo/交付/甲.md' }),
    A('甲好了 MEDIA:/demo/交付/甲.md'),
    U('另外问一句，顺手把示例清单列一下'),
    T('write_file', { path: '/demo/交付/清单.md' }),
    A('清单好了 MEDIA:/demo/交付/清单.md'),
  ]);
  const doc = build(msgs, null);
  ok('unrelated-not-hardwired', doc.segments.filter(s => s.length > 1).length === 2, { segments: doc.segments.map(s => s.length) });
  // 异常图（未知 id / 环）不卡住布局
  const weird = { cards: doc.cards, edges: doc.edges.concat([['nope', doc.cards[0].id, 'use'], [doc.cards[0].id, doc.cards[0].id, 'use']]) };
  let cols = 0, threw = '';
  try { cols = lg.layoutColumns(weird).columns; } catch (e) { threw = String(e.message || e); }
  ok('layout-survives-abnormal-graph', !threw && cols > 0 && cols <= doc.cards.length + 1, { threw, cols });
}

// ---------- 6) 正面说人话：路径 / 命令 / JSON 只在内部实现里 ----------
{
  seq = 0;
  const msgs = flat([
    U('用 /demo/参考/x.png 出一版，命令是 ffmpeg -i x.png out.png'),
    T('terminal', { command: 'cd /demo && ffmpeg -i /demo/参考/x.png /demo/交付/x-out.png' }),
    A('好了 MEDIA:/demo/交付/x-out.png'),
  ]);
  const doc = build(msgs, null);
  const dirty = doc.cards.filter(c => /\/demo\/|ffmpeg|MEDIA:/.test(String(c.title) + String(c.body)));
  const impl = doc.cards.filter(c => /\/demo\//.test(String(c.impl)));
  ok('face-human-impl-tech', dirty.length === 0 && impl.length >= 1, { dirty: dirty.map(c => c.title), impl: impl.length });
}

// ---------- 7) 取料上限：长参数不能被截断（截断 = JSON 读不出来 = 产物丢了） ----------
{
  const feed = require('../livefeed');
  // 实测隔板对话里有 8836 字的 write_file 参数，产出路径写在脚本尾部；上限必须容得下
  ok('feed-caps-cover-real-args', feed.EV_CALLS >= 12000 && feed.EV_TEXT >= 2000, { calls: feed.EV_CALLS, text: feed.EV_TEXT });
  const body = 'x'.repeat(8800);
  const args = JSON.stringify({ content: body, path: '/demo/交付/长脚本.py' });
  const tc = JSON.stringify([{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: args } }]);
  const row = feed.normRow({ id: 1, role: 'assistant', content: '', tool_calls: tc, timestamp: 1, tc_len: tc.length, ct_len: 0 });
  ok('feed-long-args-parsed', row.tools.length === 1 && row.tools[0].args.path === '/demo/交付/长脚本.py' && row.broken === false, { tools: row.tools.length, path: row.tools[0] && row.tools[0].args.path });
  const cutRow = feed.normRow({ id: 2, role: 'assistant', content: '', tool_calls: tc, timestamp: 1, tc_len: feed.EV_CALLS + 1, ct_len: 0 });
  ok('feed-cut-flagged', cutRow.cut === true);
  const badRow = feed.normRow({ id: 3, role: 'assistant', content: '', tool_calls: '[{"id":"c1","function":{"name":"write_file","arguments":"{\\"pa', timestamp: 1, tc_len: 60, ct_len: 0 });
  ok('feed-broken-flagged', badRow.broken === true && badRow.tools.length === 0);
}

// ---------- 8) 脚本产出 / 同路径重写 / 脚本里复用旧结果 / 卡面三块 ----------
{
  const RES = (name, args, content) => {
    const id = ++seq, cid = 'call_' + id;
    return [
      { id, role: 'assistant', text: '', at: id * 1000, tools: [{ name, args, callId: cid }] },
      { id: ++seq, role: 'tool', text: '', result: content, at: seq * 1000, toolName: name, toolCallId: cid, ok: true },
    ];
  };
  seq = 0;
  const msgs = flat([
    U('先把参考图描成线稿'),
    T('read_file', { path: '/demo/参考/素描.png' }),
    RES('terminal', { command: 'cd /demo && python3 line.py' }, '{"output": "OK\\n-> /demo/交/线稿-下落.png 2211747 160f570e948d\\n", "exit_code": 0}'),
    A('线稿好了 MEDIA:/demo/交/线稿-下落.png'),
    U('齿部连在一起了，分开重出'),
    RES('terminal', { command: 'cd /demo && python3 line2.py' }, '{"output": "线稿-下落.png 2058826 ee7bdd6f2bee\\n", "cwd": "/demo/交", "exit_code": 0}'),
    A('改好了 MEDIA:/demo/交/线稿-下落.png'),
  ]);
  const doc = build(msgs, null);
  const outs = doc.cards.filter(c => c.kind === 'out' && /线稿-下落/.test(c.title));
  ok('result-output-attributed', outs.length === 2, { outs: outs.map(c => c.ver) });
  ok('rewrite-keeps-old-version', outs.length === 2 && outs[0].ver === 1 && outs[1].ver === 2
    && /160f570e948d/.test(outs[0].impl) && /ee7bdd6f2bee/.test(outs[1].impl), { impl: outs.map(c => (c.impl || '').split('\n').slice(-2)) });
  ok('result-output-size-on-face', outs.some(c => /KB|MB/.test(c.body)));
  // 卡面三块：素材 / 工具 / 成果（和主画布同一套含义）
  const proc = doc.cards.filter(c => c.kind === 'proc');
  const kinds = new Set(proc.flatMap(c => (c.mods || []).map(m => m.type)));
  // 加工卡的方法模块有两种叫法：真实工具是 'tool'（带 caps），做法摘要是 'how'；两种都算加工侧
  ok('face-mods-three-kinds', kinds.has('mat') && (kinds.has('tool') || kinds.has('how')) && kinds.has('res'), { kinds: [...kinds] });
  ok('face-mods-in-out', doc.cards.filter(c => c.kind === 'in').every(c => (c.mods || []).every(m => m.type === 'mat'))
    && doc.cards.filter(c => c.kind === 'out').every(c => (c.mods || []).every(m => m.type === 'res')));
}
{
  // 脚本里点名了已有素材（旧结果被再加工）：算一次真实使用，而且只有一条使用边
  const RES = (name, args, content) => {
    const id = ++seq, cid = 'call_' + id;
    return [
      { id, role: 'assistant', text: '', at: id * 1000, tools: [{ name, args, callId: cid }] },
      { id: ++seq, role: 'tool', text: '', result: content, at: seq * 1000, toolName: name, toolCallId: cid, ok: true },
    ];
  };
  seq = 0;
  const msgs = flat([
    U('先出一张素描'),
    T('read_file', { path: '/demo/参考/实物.png' }),
    RES('terminal', { command: 'cd /demo && python3 sketch.py' }, '{"output": "-> /demo/交/素描-装配.png 2423715 15a17c8b9c\\n", "exit_code": 0}'),
    U('照这张素描的画风，把线稿重出一版'),
    RES('write_file', { path: '/demo/scratch/line.py', content: 'STYLE = os.path.join(OUT, "素描-装配.png")\nopen(STYLE, "rb")\n' }, '{"output": "ok", "exit_code": 0}'),
    RES('terminal', { command: 'cd /demo/scratch && python3 line.py' }, '{"output": "-> /demo/交/线稿-装配.png 1234567 aabbccdd11\\n", "exit_code": 0}'),
  ]);
  const doc = build(msgs, null);
  const sketch = doc.cards.filter(c => /素描-装配/.test(c.title));
  const useEdges = doc.edges.filter(([a, b, k]) => k === 'use' && sketch.some(c => c.id === a));
  const procs = doc.cards.filter(c => c.kind === 'proc');
  ok('script-mention-reuse', useEdges.length === 1 && useEdges[0][1] === procs[procs.length - 1].id, { useEdges, procs: procs.map(c => c.title) });
  ok('script-mention-not-double', (doc.cards.find(c => /素描-装配/.test(c.title)) || {}).uses === 1, { cards: doc.cards.filter(c => /素描-装配/.test(c.title)).map(c => [c.kind, c.uses]) });
}

console.log(fail ? `\n${fail} 条没过` : '\n全部通过');
process.exit(fail ? 1 : 0);
