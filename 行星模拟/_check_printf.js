// 静态检查：starpivot_cli.cpp 里每一处 std::printf 的「格式串说明符个数」必须
// 等于「实参个数」。printf 不检查这个，参数多了少了都是未定义行为——在 CLI 这个
// 场景里直接表现为多打出一个字段、或者吃掉下一个变量的值，而且不会报错。
//
// 本机没有 C++ 编译器，这是唯一能在交付前抓到这类错的办法，所以宁可糙也要覆盖全。
// 做法：扫出每个 printf 的「平衡括号 + 顶层逗号」，按字面量/括号深度切分实参。

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'starpivot', 'tools', 'starpivot_cli.cpp');
const src = fs.readFileSync(FILE, 'utf8');

// 转换说明符：% 之后到转换字符为止。这里只统计 printf 实际会吃的那些。
const CONV = new Set([...'diouxXeEfFgGaAcspr%'].map((c) => c.charCodeAt(0)));

function countSpecifiers(fmt) {
  let n = 0, i = 0;
  while (i < fmt.length) {
    if (fmt[i] !== '%') { i++; continue; }
    if (i + 1 < fmt.length && fmt[i + 1] === '%') { i += 2; continue; }  // %%
    // 走到转换字符为止；忽略 flags / width / .precision / 长度修饰符
    let j = i + 1;
    while (j < fmt.length && !CONV.has(fmt.charCodeAt(j))) j++;
    if (j >= fmt.length) return -1;      // 格式串以 % 结尾：本身已经坏了
    if (fmt[j] !== '%') n++;
    i = j + 1;
  }
  return n;
}

// 取出一次调用「第一个实参字符串字面量」与「实参个数」，以及调用的行号。
function parseCalls(text) {
  const calls = [];
  const needle = 'printf(';
  let idx = 0;
  while ((idx = text.indexOf(needle, idx)) !== -1) {
    const open = idx + needle.length - 1;
    // 找到与 open 匹配的右括号
    let depth = 0, p = open, inStr = false, esc = false, end = -1;
    for (; p < text.length; p++) {
      const c = text[p];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { end = p; break; } }
    }
    if (end === -1) { idx += needle.length; continue; }

    // 切出开括号到闭括号之间的部分，按「顶层逗号」切分
    const inner = text.slice(open + 1, end);
    const args = [];
    let d2 = 0, is2 = false, esc2 = false, start2 = 0;
    for (let q = 0; q <= inner.length; q++) {
      const c = q < inner.length ? inner[q] : ',';   // 收尾时补一个逗号
      if (is2) {
        if (esc2) esc2 = false;
        else if (c === '\\') esc2 = true;
        else if (c === '"') is2 = false;
        continue;
      }
      if (c === '"') { is2 = true; continue; }
      if (c === '(' || c === '[' || c === '{') d2++;
      else if (c === ')' || c === ']' || c === '}') d2--;
      else if (c === ',' && d2 === 0) { args.push(inner.slice(start2, q)); start2 = q + 1; }
    }

    // 格式化串：可能是相邻的多个字符串字面量（编译期拼接）。这些字面量占掉的
    // 实参位置必须从 nargs 里扣掉，否则每一处都会被误报。
    let fmt = '', literalArgs = 0;
    for (const a of args) {
      const t = a.trim();
      if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
        fmt += t.slice(1, -1).replace(/\\"/g, '"');
        literalArgs++;
      } else break;
    }
    const line = text.slice(0, idx).split('\n').length;
    calls.push({ line, fmt, nargs: args.length - literalArgs, args });
    idx = end + 1;
  }
  return calls;
}

// ---- 自检：判据本身必须先被验过，否则"0 处问题"可能只是检查器没在工作 ----
// 第二例就是本轮真实踩到的那个 bug（把 name 多传给了 printf）。
const SELF_TEST = [
  ['std::printf("t = %.6g\\n", sys.time);', 1, 1],
  ['std::printf("x = %.6g, y = %s}", a, b, c);', 2, 3],   // 多一个实参 → 必须报
  ['std::printf("a = %d, b = %d", x, y);', 2, 2],
  ['std::printf("100%% done, %s", s);', 1, 1],            // %% 不计入
  ['std::printf("%s, \\"k\\": %d", i ? ", " : "", v);', 2, 2],  // 三元里的逗号不算分隔
  ['std::printf("only a literal\\n");', 0, 0],
  ['std::printf("bad %");', -1, 0],
];
const selfLog = [];
let selfFail = 0;
for (const [code, wantSpec, wantArgs] of SELF_TEST) {
  const cc = parseCalls(code + '\n');
  const gotSpec = cc.length ? countSpecifiers(cc[0].fmt) : NaN;
  const gotArgs = cc.length ? cc[0].nargs : NaN;
  const ok = cc.length === 1 && gotSpec === wantSpec && gotArgs === wantArgs;
  if (!ok) selfFail++;
  selfLog.push(`${ok ? 'PASS' : 'FAIL'}  说明符=${gotSpec}(期望${wantSpec}) 实参=${gotArgs}(期望${wantArgs})  ${code}`);
}
if (selfFail) {
  fs.writeFileSync(path.join(__dirname, '_check_printf.txt'),
    selfLog.join('\n') + `\n\n检查器自身有问题（${selfFail} 例未按预期判定），结论不可信\n`, 'utf8');
  process.exit(2);
}

const calls = parseCalls(src);
const lines = [];
let bad = 0, checked = 0, skipped = 0;
for (const c of calls) {
  if (!c.fmt) { skipped++; continue; }   // 第一个实参不是字面量（例如变量）→ 跳过
  const want = countSpecifiers(c.fmt);
  checked++;
  if (want < 0) {
    lines.push(`行 ${c.line}: 格式串以 % 结尾 → ...${c.fmt.slice(-40)}`);
    bad++;
    continue;
  }
  if (want !== c.nargs) {
    lines.push(`行 ${c.line}: 说明符 ${want} 个，实参 ${c.nargs} 个  →  ...${c.fmt.slice(0, 70)}`);
    bad++;
  }
}
lines.push('--- 检查器自检（负样本必须被报出来）---');
lines.push(...selfLog);
lines.push('');
lines.push(`printf 调用检查：格式串字面量 ${checked} 处（跳过 ${skipped} 处含变量的），问题 ${bad} 处`);
lines.push(bad ? 'FAILED' : 'OK — 每一处 printf 的参数个数都对得上');
fs.writeFileSync(path.join(__dirname, '_check_printf.txt'), lines.join('\n'), 'utf8');
process.exit(bad ? 1 : 0);
