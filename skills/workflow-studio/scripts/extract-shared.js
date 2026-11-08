#!/usr/bin/env node
// 把源渲染脚本里的若干函数整段切出来，拼成一个两窗口共用的模块。
// 用法：
//   node scripts/extract-shared.js \
//     --src renderer/app.js --out renderer/cardsys.js \
//     --fn nodeEl,modsHTML,chipHTML,plugChips,plugKey,peer,statusDot,drawEdges,dragCard,startLink,hit \
//     --header "<首行说明>"
// 只做括号配对切片，不改函数体；切完自己 node --check 并补宿主适配器。
'use strict';
const fs = require('fs');

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : def;
};

const srcPath = arg('src');
const outPath = arg('out');
const names = String(arg('fn', '')).split(',').map(s => s.trim()).filter(Boolean);
const header = arg('header', '// 从源渲染脚本原样切出的共享函数：源改了要同步搬。');
if (!srcPath || !outPath || !names.length) {
  console.error('用法: extract-shared.js --src <file> --out <file> --fn a,b,c [--header "说明"]');
  process.exit(2);
}

const src = fs.readFileSync(srcPath, 'utf8');

// 从 `function NAME(` 开始，按花括号配对（跳过字符串与模板字面量里的括号）找函数结尾。
function sliceFunction(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到函数: ' + name);
  let i = src.indexOf('{', start);
  if (i < 0) throw new Error('找不到函数体: ' + name);
  let depth = 0, quote = null;
  for (; i < src.length; i++) {
    const ch = src[i], prev = src[i - 1];
    if (quote) {
      if (ch === quote && prev !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (ch === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 1; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (!depth) return src.slice(start, i + 1); }
  }
  throw new Error('括号没配对: ' + name);
}

const parts = names.map(n => {
  const body = sliceFunction(n);
  if (/\bn\.[A-Za-z]/.test(body) && !names.includes('nodeEl')) {
    console.warn('提示: ' + n + ' 里出现 n.<字段>，确认这是本模块内的变量而不是源作用域遗留');
  }
  return body;
});

const out = [header, "'use strict';", parts.join('\n\n')].join('\n') + '\n';
fs.writeFileSync(outPath, out);
console.log('写出 ' + outPath + '：' + parts.length + ' 个函数，' + out.length + ' 字节');
console.log('下一步：node --check ' + outPath + '，再在宿主脚本里补 flow/find/saveStore/openCard/chatAsk/markSel/unplugDrag/findDock/startLink。');
