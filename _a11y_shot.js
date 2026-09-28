// 用真 Chrome 确认"补齐语义"没有改变视觉。
// 唯一有理论风险的一处是把「逐帧」的 <label> 换成了 <span class="grouplabel">
// —— 所以这里不去猜，直接把两者的**计算样式**逐项读出来比对（比肉眼可靠）。
// 同时截两张图留证，并顺带看 console 有没有报错。
const { chromium } = require('playwright-core');
const fs = require('fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const KEYS = ['fontSize', 'color', 'display', 'marginBottom', 'marginTop', 'fontWeight',
              'lineHeight', 'fontFamily', 'letterSpacing', 'textAlign'];

(async () => {
  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    channel: fs.existsSync(CHROME) ? undefined : 'chrome',
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  let fail = 0;
  const cmp = (a, b, what) => {
    const diff = KEYS.filter(k => a[k] !== b[k]);
    if (diff.length) { fail++; console.log(`[FAIL] ${what} 样式不一致：` +
      diff.map(k => `${k} ${a[k]} ≠ ${b[k]}`).join('、')); }
    else console.log(`  ok  ${what} 与 label 的 ${KEYS.length} 项计算样式逐项相同`);
  };

  // ---- universe：「逐帧」那处 ----
  await page.goto('http://127.0.0.1:8765/universe', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(9000);                       // 等首帧真画出来（默认场景要算 2001 帧）
  await page.evaluate(() => {
    document.querySelectorAll('details').forEach(d => { d.open = true; });
  });
  await page.waitForTimeout(600);
  const u = await page.evaluate((KEYS) => {
    const pick = el => { const c = getComputedStyle(el); const o = {};
      KEYS.forEach(k => o[k] = c[k]); return o; };
    const gl = document.querySelector('.grouplabel');
    const lb = document.querySelector('#advbox label, details label');
    return {
      grouplabel: gl ? pick(gl) : null,
      label: lb ? pick(lb) : null,
      glText: gl ? gl.textContent.trim() : null,
      lbText: lb ? lb.textContent.trim().slice(0, 16) : null,
    };
  }, KEYS);
  if (!u.grouplabel) { fail++; console.log('[FAIL] 页面上找不到 .grouplabel'); }
  else if (!u.label) { fail++; console.log('[FAIL] 找不到可对比的 label'); }
  else {
    console.log(`  对比对象：.grouplabel「${u.glText}」 vs label「${u.lbText}」`);
    cmp(u.grouplabel, u.label, '「逐帧」那行');
  }
  await page.screenshot({ path: '_shot/a11y-universe.png', fullPage: false });

  // ---- home：确认 h3 字号没被 aria-level 改动 ----
  await page.goto('http://127.0.0.1:8765/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(800);
  const h = await page.evaluate(() => {
    document.querySelectorAll('details').forEach(d => { d.open = true; });
    const hs = [...document.querySelectorAll('h3')];
    return { n: hs.length, sizes: [...new Set(hs.map(x => getComputedStyle(x).fontSize))],
             levels: [...new Set(hs.map(x => x.getAttribute('aria-level')))] };
  });
  console.log(`  home：h3 共 ${h.n} 个，字号 ${h.sizes.join('/')}，aria-level ${h.levels.join('/')}`);
  if (h.sizes.length === 1 && h.sizes[0] === '15px') console.log('  ok  h3 仍是 15px —— 没被当成 h2 放大到 16.5px');
  else { fail++; console.log('[FAIL] h3 字号变了：' + h.sizes.join('/')); }
  await page.screenshot({ path: '_shot/a11y-home.png', fullPage: false });

  console.log('  console/page 错误：' + (errors.length ? errors.slice(0, 3).join(' | ') : '（无）'));
  if (errors.length) fail++;
  await browser.close();
  console.log(`\n真 Chrome 核对 fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
