// 验证 renderer/app.js 里的 parseAgentOutput() 到底怎么拆 CLI 输出。
// 改了解析器或提示词之后先跑它，而不是在界面上靠肉眼看气泡。
//
//   node skills/workflow-studio/scripts/parse-agent-output.js /tmp/hermes-raw.txt
//   node skills/workflow-studio/scripts/parse-agent-output.js --live "用三句话说明：为什么卖点卡必须先有证据出处？"
//
// 输出：{secs, steps:[{label,time}], think 字数, answer 字数, answer 尾巴}
// 加 --full 打印完整 think / answer，方便确认回答没有被截断或被分隔线污染。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.join('<REPO>', 'renderer', 'app.js');
const HERMES = path.join(process.env.HOME || '', '.hermes', 'hermes-agent', '.hermes', 'bin', 'hermes');
const PROFILE = process.env.HF_PROFILE || 'flowdev';

// 从 app.js 里抠出 parseAgentOutput（花括号配对，免得下次改文件就找不到）
function loadParser() {
  const src = fs.readFileSync(APP, 'utf8');
  const start = src.indexOf('function parseAgentOutput');
  if (start < 0) throw new Error('app.js 里找不到 parseAgentOutput()');
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  if (end < 0) throw new Error('parseAgentOutput 花括号不配对');
  return new Function('raw', src.slice(start, end) + '\nreturn parseAgentOutput(raw);');
}

const args = process.argv.slice(2);
const full = args.includes('--full');
const live = args.includes('--live');
let raw = '';

if (live) {
  const q = args[args.indexOf('--live') + 1];
  if (!q) { console.error('--live 后面要跟一个提问'); process.exit(1); }
  raw = execFileSync(HERMES, ['-p', PROFILE, 'chat', '-q', q], { encoding: 'utf8', timeout: 180000 });
} else {
  const file = args[0];
  if (!file || !fs.existsSync(file)) { console.error('usage: parse-agent-output.js <raw.txt | --live "提问"> [--full]'); process.exit(1); }
  raw = fs.readFileSync(file, 'utf8');
}

const parse = loadParser();
const r = parse(raw);
console.log(JSON.stringify({
  secs: r.secs,
  steps: r.steps,
  thinkChars: r.think.length,
  answerChars: r.answer.length,
  answerHead: r.answer.slice(0, 60),
  answerTail: r.answer.slice(-60),
  leakedEcho: /^(Query:|☤ Hermes|────)/.test(r.answer),
}, null, 1));
if (r.answer.includes('Resume this session')) console.error('WARN: 回答里还带着会话尾巴');
if (full) { console.log('\n--- think ---\n' + r.think); console.log('\n--- answer ---\n' + r.answer); }
