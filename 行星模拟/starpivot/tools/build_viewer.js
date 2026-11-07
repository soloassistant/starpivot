// 构建期去注释：源码不动，产出 viewer/dist/universe.html 供网关发送。
//   node tools/build_viewer.js           生成产物
//   node tools/build_viewer.js --check   只校验：产物与源码是否同步（不同步 → 退出码 1）
//
// 三条硬约束：
//   1. 不用正则剥注释。HTML/CSS/JS 各走一个显式状态机；JS 是一个真正的词法器：
//      字符串、模板串（含 ${} 嵌套）、正则字面量与除号都按 token 上下文判断，
//      注释边界不会切错。切错是静默损坏，所以这一层宁可写长也不取巧。
//   2. 可复现。输出只由源码字节决定：不写时间戳，输入先归一 CRLF→LF。
//   3. 行号可回查。注释被替换成空格而不是删除，换行原样保留 ——
//      产物第 n 行（n>=2）恒对应源码第 n-1 行，堆栈行号减 1 即源码位置。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'viewer', 'universe.html');
const OUT = path.join(ROOT, 'viewer', 'dist', 'universe.html');

const norm = (s) => s.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

// ---------------------------------------------------------------- JS 词法
// 只做扫描，不给 AST：回答"哪些区间是注释"。
// 关键在区分 `/` 是除号还是正则起点 —— 看上一个有意义 token，而不是看字符。
const KW_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
]);

function lexJs(src) {
  const comments = [];
  const n = src.length;
  let i = 0;
  let last = null; // { kind, value }
  // 上下文栈：{tpl:true} = 模板文本；{tpl:false, depth} = 模板里的 ${ 表达式
  const stack = [];

  const isIdStart = (c) => /[A-Za-z_$\u0080-\uffff]/.test(c);
  const isIdPart = (c) => /[A-Za-z0-9_$\u0080-\uffff]/.test(c);
  const isDigit = (c) => c >= '0' && c <= '9';
  const top = () => stack[stack.length - 1];
  const atLineStart = (k) => {
    let j = k - 1;
    while (j >= 0 && (src[j] === ' ' || src[j] === '\t')) j--;
    return j < 0 || src[j] === '\n';
  };

  function regexAllowed() {
    if (!last) return true;
    if (last.kind === 'id') return KW_BEFORE_REGEX.has(last.value);
    if (last.kind === 'punc') return ![')', ']', '}'].includes(last.value);
    return false; // 数字 / 字符串 / 模板 / 正则之后只能是除号
  }

  while (i < n) {
    const c = src[i];

    // —— 模板文本区：只认 ` 与 ${ ——
    if (top() && top().tpl) {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); i++; last = { kind: 'tpl', value: '`' }; continue; }
      if (c === '$' && src[i + 1] === '{') {
        stack.push({ tpl: false, depth: 1 });
        i += 2;
        last = null;
        continue;
      }
      i++;
      continue;
    }

    // —— 以下都在 JS 代码区 ——
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      comments.push([i, j]);
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      if (j < 0) throw new Error(`未闭合的块注释，偏移 ${i}`);
      comments.push([i, j + 2]);
      i = j + 2;
      continue;
    }
    // Annex B：<!-- 是行注释；--> 只在行首是
    if (c === '<' && src.startsWith('<!--', i)) {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      comments.push([i, j]);
      i = j;
      continue;
    }
    if (c === '-' && src.startsWith('-->', i) && atLineStart(i)) {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      comments.push([i, j]);
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        if (src[j] === '\n') throw new Error(`未闭合的字符串，偏移 ${i}`);
        j++;
      }
      if (j > n) throw new Error(`未闭合的字符串，偏移 ${i}`);
      last = { kind: 'str', value: c };
      i = j;
      continue;
    }
    if (c === '`') {
      stack.push({ tpl: true });
      last = null;
      i++;
      continue;
    }
    if (c === '/') {
      if (!regexAllowed()) {
        last = { kind: 'punc', value: '/' };
        i++;
        continue;
      }
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '\n') break;
        if (inClass) { if (ch === ']') inClass = false; j++; continue; }
        if (ch === '[') { inClass = true; j++; continue; }
        if (ch === '/') { j++; closed = true; break; }
        j++;
      }
      if (!closed) throw new Error(`未闭合的正则，偏移 ${i}`);
      while (j < n && /[a-z]/i.test(src[j])) j++;
      last = { kind: 'regex', value: '/' };
      i = j;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(src[j])) j++;
      last = { kind: 'id', value: src.slice(i, j) };
      i = j;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let j = i + 1;
      while (j < n && /[0-9a-zA-Z_.]/.test(src[j])) {
        if ((src[j] === 'e' || src[j] === 'E') && (src[j + 1] === '+' || src[j + 1] === '-')) j++;
        j++;
      }
      last = { kind: 'num', value: src.slice(i, j) };
      i = j;
      continue;
    }
    if (c === '{') {
      const t = top();
      if (t && !t.tpl) t.depth++;
      last = { kind: 'punc', value: '{' };
      i++;
      continue;
    }
    if (c === '}') {
      const t = top();
      if (t && !t.tpl) {
        t.depth--;
        if (t.depth === 0) { stack.pop(); i++; last = null; continue; }
      }
      last = { kind: 'punc', value: '}' };
      i++;
      continue;
    }
    // 其余标点：多字符的先吃掉，供 regexAllowed 判断
    const three = src.substr(i, 3);
    if (['===', '!==', '>>>', '**=', '...', '&&=', '||=', '??=', '<<=', '>>='].includes(three)) {
      last = { kind: 'punc', value: three };
      i += 3;
      continue;
    }
    last = { kind: 'punc', value: c };
    i++;
  }
  if (stack.length) throw new Error('模板串没有闭合');
  return comments;
}

// ---------------------------------------------------------------- CSS
// 只处理注释边界：字符串、url() 内的 /* 不是注释。
function scanCss(src) {
  const comments = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      if (j < 0) throw new Error(`未闭合的 CSS 注释，偏移 ${i}`);
      comments.push([i, j + 2]);
      i = j + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        j++;
      }
      i = j;
      continue;
    }
    if ((c === 'u' || c === 'U') && /^url\(/i.test(src.substr(i, 4))) {
      let j = i + 4;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === '"' || src[j] === "'") { i = j; continue; }
      while (j < n && src[j] !== ')') {
        if (src[j] === '\\') j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return comments;
}

// ---------------------------------------------------------------- HTML
// 数据状态机：注释、标签（含引号属性）、raw text（script/style）。
function scanHtml(src) {
  const n = src.length;
  const out = [];
  let i = 0;

  function skipTag(from) {
    let j = from + 1;
    while (j < n) {
      const ch = src[j];
      if (ch === '"' || ch === "'") {
        const q = ch;
        j++;
        while (j < n && src[j] !== q) j++;
        j++;
        continue;
      }
      if (ch === '>') return j + 1;
      j++;
    }
    return n;
  }

  while (i < n) {
    if (src[i] !== '<') { i++; continue; }
    if (src.startsWith('<!--', i)) {
      const j = src.indexOf('-->', i + 4);
      if (j < 0) throw new Error(`未闭合的 HTML 注释，偏移 ${i}`);
      out.push({ type: 'comment', start: i, end: j + 3 });
      i = j + 3;
      continue;
    }
    if (src[i + 1] === '/' || src[i + 1] === '!' || src[i + 1] === '?') {
      i = skipTag(i);
      continue;
    }
    const m = /^<([A-Za-z][\w:-]*)/.exec(src.slice(i, i + 40));
    if (!m) { i++; continue; }
    const tag = m[1].toLowerCase();
    const after = i + 1 + m[1].length;
    if (after < n && !/[\s/>]/.test(src[after])) { i++; continue; } // 文本里的 a<b
    const tagEnd = skipTag(i);
    if (tag === 'script' || tag === 'style') {
      const closeRe = new RegExp(`</${tag}[\\s/>]`, 'i');
      const cm = closeRe.exec(src.slice(tagEnd));
      if (!cm) throw new Error(`<${tag}> 没有结束标签，偏移 ${i}`);
      out.push({ type: tag, start: tagEnd, end: tagEnd + cm.index });
      i = tagEnd + cm.index;
      continue;
    }
    i = tagEnd;
  }
  return out;
}

// ---------------------------------------------------------------- 组装
function build(inputRaw) {
  const src = norm(inputRaw);
  const sha = crypto.createHash('sha256').update(src, 'utf8').digest('hex').slice(0, 16);
  const cuts = [];
  let nComment = 0, nCss = 0, nJs = 0;
  for (const node of scanHtml(src)) {
    if (node.type === 'comment') {
      cuts.push([node.start, node.end]);
      nComment++;
    } else {
      const body = src.slice(node.start, node.end);
      const rs = node.type === 'script' ? lexJs(body) : scanCss(body);
      if (node.type === 'script') nJs += rs.length; else nCss += rs.length;
      for (const [a, b] of rs) cuts.push([node.start + a, node.start + b]);
    }
  }
  // 注释 → 空格，换行保留（行号 1:1 回查）
  const chars = src.split('');
  for (const [a, b] of cuts) {
    for (let k = a; k < b; k++) if (chars[k] !== '\n') chars[k] = ' ';
  }
  const head = `<!-- 构建产物，勿手改：由 viewer/universe.html 生成；源 sha256=${sha}；` +
    `生成器 tools/build_viewer.js。本行不计入行号：产物第 n 行（n>=2）对应源码第 n-1 行。 -->\n`;
  return {
    text: head + chars.join(''),
    sha,
    stats: { html: nComment, css: nCss, js: nJs, total: cuts.length },
  };
}

function main() {
  const raw = fs.readFileSync(SRC, 'utf8');
  const { text, sha, stats } = build(raw);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(OUT)) {
      console.error(`[dist] 缺产物：${path.relative(ROOT, OUT)} —— 跑 node tools/build_viewer.js`);
      process.exit(1);
    }
    const cur = norm(fs.readFileSync(OUT, 'utf8'));
    if (cur !== text) {
      const a = cur.split('\n');
      const b = text.split('\n');
      let line = 0;
      while (line < Math.min(a.length, b.length) && a[line] === b[line]) line++;
      console.error(`[dist] 产物与源码不同步：首个差异在第 ${line + 1} 行`);
      console.error(`  产物: ${JSON.stringify((a[line] || '').slice(0, 90))}`);
      console.error(`  应为: ${JSON.stringify((b[line] || '').slice(0, 90))}`);
      console.error('  源码改了必须跑 node tools/build_viewer.js 重新生成');
      process.exit(1);
    }
    console.log(`[dist] 同步 OK  source_sha256=${sha}  comments=${stats.total}（html ${stats.html} / css ${stats.css} / js ${stats.js}）`);
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text, 'utf8');
  const gz = require('zlib').gzipSync(Buffer.from(text, 'utf8'), { level: 6 }).length;
  console.log(`[dist] 生成 ${path.relative(ROOT, OUT)}  source_sha256=${sha}`);
  console.log(`[dist] 剥掉注释 ${stats.total} 处（html ${stats.html} / css ${stats.css} / js ${stats.js}）`);
  console.log(`[dist] bytes=${Buffer.byteLength(text, 'utf8')}  gzip6=${gz}`);
}

if (require.main === module) main();
module.exports = { build, lexJs, scanCss, scanHtml };
