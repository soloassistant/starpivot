// 设计改完之后的"有没有改坏"体检 —— 不靠肉眼，靠可测量的三条：
//   ① 横向溢出（页面被撑出水平滚动条）
//   ② 元素越界（任何可见块超出视口右边界 / 文字被容器裁掉）
//   ③ console / pageerror
// 这三条是改样式最容易引入、而静态判据一个字节都查不到的问题。
const { chromium } = require('playwright-core');
const fs = require('fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGES = [
  ['/', 'home'], ['/universe', 'universe'], ['/kids', 'kids'], ['/orbit', 'orbit'],
];
const WIDTHS = [1440, 768, 390];   // 桌面 / iPad 竖 / 手机

(async () => {
  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    channel: fs.existsSync(CHROME) ? undefined : 'chrome',
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
  });
  let fail = 0;
  for (const [route, name] of PAGES) {
    for (const w of WIDTHS) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push('pageerror: ' + e.message));
      page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
      try {
        await page.goto('http://127.0.0.1:8765' + route, { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(route === '/universe' ? 9000 : 1500);
        const r = await page.evaluate(() => {
          const out = { overflowX: document.documentElement.scrollWidth - window.innerWidth, out: [] };
          const vw = window.innerWidth;
          // 宽表是**故意**放在可横滚容器里的（.tablewrap{overflow-x:auto}），
          // 它在容器里超出不算"改坏" —— 所以先看有没有可横滚的祖先。
          const inScroller = (el) => {
            for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
              const ox = getComputedStyle(p).overflowX;
              if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
            }
            return false;
          };
          for (const el of document.querySelectorAll('body *')) {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
            const b = el.getBoundingClientRect();
            if (b.width === 0 || b.height === 0) continue;
            const visible = (el.textContent || '').trim().length > 0
              || cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.borderTopWidth !== '0px';
            if (!visible) continue;
            if (b.right > vw + 1 || b.left < -1) {
              if (inScroller(el)) continue;              // 在滚动容器里 —— 是设计意图
              out.out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} ` +
                `[${Math.round(b.left)}→${Math.round(b.right)}] 视口 0→${vw}`);
            }
          }
          return out;
        });
        const bad = [];
        if (r.overflowX > 1) bad.push(`横向溢出 ${r.overflowX}px`);
        if (r.out.length) bad.push(`${r.out.length} 个元素越界：` + r.out.slice(0, 3).join('；'));
        if (errs.length) bad.push('报错：' + errs.slice(0, 2).join(' | '));
        if (bad.length) { fail++; console.log(`[FAIL] ${name} @${w}px — ` + bad.join('；')); }
        else console.log(`  ok  ${name} @${w}px  无溢出/无越界/无报错`);
      } catch (e) {
        fail++; console.log(`[FAIL] ${name} @${w}px — 加载失败：${e.message.split('\n')[0]}`);
      }
      await ctx.close();
    }
  }
  await browser.close();
  console.log(`\n设计体检 fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
