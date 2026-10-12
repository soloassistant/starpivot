// _va_vp.js —— 只截"当前视口"（不 fullPage），便于在手机上按屏看。
// 用法：node _va_vp.js <url> <out.png> <viewW> <viewH> [scale] [scrollY] [waitMs] [waitSel]
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const URL = process.argv[2];
const OUT = process.argv[3];
const W = +(process.argv[4] || 390);
const H = +(process.argv[5] || 844);
const SCALE = +(process.argv[6] || 2);
const SCROLLY = +(process.argv[7] || 0);
const WAIT = +(process.argv[8] || 4000);
const WAITSEL = process.argv[9] || '';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
  });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
  if (WAITSEL) {
    await page.waitForFunction(s => { const e = document.querySelector(s); return e && (e.textContent || '').trim().length > 0; },
      WAITSEL, { timeout: 60000 }).catch(() => {});
  }
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(WAIT);
  if (SCROLLY) { await page.evaluate(y => window.scrollTo(0, y), SCROLLY); await page.waitForTimeout(800); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await page.screenshot({ path: OUT, fullPage: false });
  console.log('scrollY now:', await page.evaluate(() => Math.round(window.scrollY)));
  console.log('saved:', OUT);
  await browser.close();
})();
