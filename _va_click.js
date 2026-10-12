// _va_click.js —— 点一个控件之后取景（用于验证"模式切换"这类双态界面）。
// 用法：node _va_click.js <url> <clickSel> <out.png> [fullPage] [viewW] [viewH] [scale] [waitMs] [waitSel]
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const URL = process.argv[2], CLICK = process.argv[3], OUT = process.argv[4];
const FULL = (process.argv[5] || '0') === '1';
const W = +(process.argv[6] || 1440), H = +(process.argv[7] || 1000), SCALE = +(process.argv[8] || 1);
const WAIT = +(process.argv[9] || 3000), WAITSEL = process.argv[10] || '';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
  });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });
  await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
  if (WAITSEL) await page.waitForFunction(s => { const e = document.querySelector(s); return e && (e.textContent || '').trim().length > 0; }, WAITSEL, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // 记录点击前状态
  const before = await page.evaluate(() => ({
    simpleVisible: !!document.querySelector('.simple-only') && getComputedStyle(document.querySelector('.simple-only')).display !== 'none',
    proVisible: !!document.querySelector('.pro-only') && getComputedStyle(document.querySelector('.pro-only')).display !== 'none',
    docH: document.documentElement.scrollHeight,
  }));

  try { await page.click(CLICK, { timeout: 8000 }); } catch (e) { console.log('CLICK FAILED:', e.message.slice(0, 120)); }

  await page.waitForTimeout(WAIT);
  const after = await page.evaluate(() => ({
    simpleVisible: !!document.querySelector('.simple-only') && getComputedStyle(document.querySelector('.simple-only')).display !== 'none',
    proVisible: !!document.querySelector('.pro-only') && getComputedStyle(document.querySelector('.pro-only')).display !== 'none',
    docH: document.documentElement.scrollHeight,
    docW: document.documentElement.scrollWidth,
    vw: window.innerWidth,
  }));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await page.screenshot({ path: OUT, fullPage: FULL });
  console.log('before :', JSON.stringify(before));
  console.log('after  :', JSON.stringify(after));
  console.log('errors :', errs.length ? errs.join(' | ') : '(无)');
  console.log('saved  :', OUT);
  await browser.close();
})();
