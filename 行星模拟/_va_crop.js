// _va_crop.js —— 定点放大取景：把页面上某个选择器对应的区域，用高倍率单独截出来。
// 用途：fullPage 长图被缩得看不清细节时，用它看"这一块到底画了什么"。
//
// 用法：node _va_crop.js <url> <selector> <out.png> [scale] [waitMs] [selForWait]
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const URL = process.argv[2];
const SEL = process.argv[3];
const OUT = process.argv[4];
const SCALE = +(process.argv[5] || 3);
const WAIT = +(process.argv[6] || 3000);
const WAITSEL = process.argv[7] || '';
const VW = +(process.argv[8] || 1440);
const VH = +(process.argv[9] || 1000);
const OPEN = process.argv[10] || '';   // 可选的：先点开这个选择器（如 details 的 summary）

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
  });
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: SCALE });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'load', timeout: 45000 });

  if (WAITSEL) {
    await page.waitForFunction(s => { const e = document.querySelector(s); return e && (e.textContent || '').trim().length > 0; },
      WAITSEL, { timeout: 60000 }).catch(() => {});
  }
  await page.waitForTimeout(WAIT);
  if (OPEN) { await page.click(OPEN, { timeout: 8000 }).catch(() => {}); await page.waitForTimeout(1200); }

  const el = await page.$(SEL);
  if (!el) { console.log('NOT FOUND:', SEL); await browser.close(); process.exit(2); }
  const box = await el.boundingBox();
  console.log('box:', JSON.stringify(box));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await el.screenshot({ path: OUT });

  // 顺便把这个元素里所有画布的像素统计打出来（判断"是不是一片空白"）
  const cvStat = await page.evaluate(sel => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const out = [];
    root.querySelectorAll('canvas').forEach(cv => {
      let n = 0, tot = 0, nonzero = 0;
      try {
        const c = cv.getContext('2d');
        if (c && cv.width) {
          const d = c.getImageData(0, 0, cv.width, cv.height).data;
          for (let i = 0; i < d.length; i += 4 * 29) {
            tot++;
            const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
            if (a > 8) n++;
            if (a > 8 && (r + g + b) < 720) nonzero++; // 非纯白像素
          }
        }
      } catch (e) { return out.push({ err: e.message.slice(0, 60) }); }
      out.push({ w: cv.width, h: cv.height, alphaHit: n, darkHit: nonzero, sampled: tot });
    });
    return out;
  }, SEL);
  console.log('canvas-in-el:', JSON.stringify(cvStat));
  console.log('saved:', OUT);
  await browser.close();
})();
