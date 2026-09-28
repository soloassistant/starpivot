// _design_interact.js —— 一次性自验：折叠区改成 display:flex 之后，点开还能不能展开？
// 为什么必须真点一次：<summary> 换成 flex 布局在部分浏览器上会破坏原生开合行为，
// 而"点不开"这件事在静态判据里一个字都查不到（判据读的是源码文本）。
const { chromium } = require('playwright-core');
const fs = require('fs');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CASES = [
  ['http://127.0.0.1:8765/', 'details.card'],
  ['http://127.0.0.1:8765/kids', 'details'],
  ['http://127.0.0.1:8765/universe', 'details.card'],
  ['http://127.0.0.1:8765/orbit', 'details'],
];
(async () => {
  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  let bad = 0;
  for (const [url, sel] of CASES) {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(5000);
    const count = () => page.$$eval(sel, els => els.filter(e => e.open).length);
    const before = await count();
    const s = await page.$(sel + ' > summary');
    await s.click(); await page.waitForTimeout(350);
    const after = await count();
    await s.click(); await page.waitForTimeout(300);
    const back = await count();
    const ok = after === before + 1 && back === before;
    if (!ok) bad++;
    console.log((ok ? 'PASS  ' : 'FAIL  ') + url + '  ' + sel
      + '  点开：' + before + ' → ' + after + ' → 再点回 ' + back
      + '   console=' + (errs.length ? errs[0] : '(无)'));
    await page.close();
  }
  await browser.close();
  console.log(bad ? '有 ' + bad + ' 处不通过' : '全部通过');
  process.exit(bad ? 1 : 0);
})();
