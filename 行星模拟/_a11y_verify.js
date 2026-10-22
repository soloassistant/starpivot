// 验证建议 1-4 真的落地了，而且没有"指错地方"这种不报错的错。
// 与判据的区别：这只是我改完后的一遍自查，不算进五层判据。
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const VIEW = path.join(__dirname, 'starpivot', 'viewer');
const FILES = ['home.html', 'index.html', 'kids.html', 'universe.html'];
// <button> 不能做 label 的目标（不是 labelable 元素），for 指过去等于没指
const LABELABLE = /^(INPUT|SELECT|TEXTAREA|METER|OUTPUT|PROGRESS)$/;

let n = 0, fail = 0;
const bad = (msg) => { fail++; console.log('[FAIL] ' + msg); };

for (const f of FILES) {
  const html = fs.readFileSync(path.join(VIEW, f), 'utf8');
  const dom = new JSDOM(html);            // 不执行页面脚本，只看静态结构
  const d = dom.window.document;

  // ① label[for] 必须指向一个真实存在、且可被关联的控件
  const withFor = [...d.querySelectorAll('label[for]')];
  for (const l of withFor) {
    n++;
    const t = d.getElementById(l.htmlFor);
    if (!t) { bad(`${f}: label for="${l.htmlFor}" 找不到这个 id 的元素`); continue; }
    if (!LABELABLE.test(t.tagName)) {
      bad(`${f}: label for="${l.htmlFor}" 指向 <${t.tagName.toLowerCase()}>，它不属于可关联控件`);
    }
  }

  // ② 没写 for 的 label 必须把控件包在里面（隐式关联），否则就是个孤儿
  for (const l of d.querySelectorAll('label:not([for])')) {
    n++;
    if (!l.querySelector('input,select,textarea')) {
      bad(`${f}: 孤儿 label「${l.textContent.trim().slice(0, 24)}」既不写 for 也不包控件`);
    }
  }

  // ③ 每块 canvas 都要有名字（role=img 让 AT 把它当一张图，而不是一个空容器）
  for (const c of d.querySelectorAll('canvas')) {
    n++;
    if (!c.getAttribute('aria-label')) bad(`${f}: canvas#${c.id || '(无 id)'} 没有 aria-label`);
    if (c.getAttribute('role') !== 'img') bad(`${f}: canvas#${c.id} 没有 role="img"`);
  }

  // ④ 标题不跳级：级别取 aria-level（有则用），相邻两级相差必须 ≤1，且从 1 级起
  const hs = [...d.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    .map(h => ({ lv: +(h.getAttribute('aria-level') || h.tagName[1]), t: h.textContent.trim().slice(0, 18) }));
  if (hs.length) {
    n++;
    if (hs[0].lv !== 1) bad(`${f}: 第一个标题是 ${hs[0].lv} 级，不是 1 级`);
    for (let i = 1; i < hs.length; i++) {
      n++;
      if (hs[i].lv - hs[i - 1].lv > 1) {
        bad(`${f}: 标题从 ${hs[i-1].lv} 级跳到 ${hs[i].lv} 级（「${hs[i-1].t}」→「${hs[i].t}」）`);
      }
    }
  }

  // ⑤ 高频刷新的区域不能挂 live region，否则读屏会一直念
  for (const id of ['statline', 'tlabel']) {
    const el = d.getElementById(id); n++;
    if (el && el.hasAttribute('aria-live')) bad(`${f}: #${id} 每帧都变，不该挂 aria-live`);
  }

  console.log(`  ${f.padEnd(14)} label[for]=${String(withFor.length).padStart(2)}` +
              ` canvas=${d.querySelectorAll('canvas').length}` +
              ` 标题=${hs.length}` +
              ` live=${d.querySelectorAll('[aria-live],[role=status]').length}`);
}

console.log(`\n自查 ${n} 条，fail=${fail}`);
process.exit(fail ? 1 : 0);
