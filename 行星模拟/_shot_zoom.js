// _shot_zoom.js —— 放大了截：默认视角下内太阳系挤在中心几十像素里，
// 根本看不清"球面画得好不好"。把缩放拉到某个档再截，才看得见明暗/条纹/环/柔光。
//
// 用法：node _shot_zoom.js <url> <输出png> <zoom值> [等待毫秒] [宽] [高]
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const URL = process.argv[2] || 'http://localhost:8765/universe';
const OUT = process.argv[3] || '_shot/zoom.png';
const ZOOM = process.argv[4] || '300';
const WAIT = +(process.argv[5] || 4000);
const W = +(process.argv[6] || 1440);
const H = +(process.argv[7] || 1000);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
  });
  const page = await (await browser.newContext({
    viewport: { width: W, height: H }, deviceScaleFactor: 2,
  })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));

  await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
  await page.waitForFunction(() => {
    const cv = document.querySelector('canvas');
    if (!cv || !cv.width) return false;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4 * 37) if (d[i] > 8) n++;
    return n > 40;
  }, null, { timeout: 30000 }).catch(() => {});

  // 把缩放滑杆推到指定档（要派发 input，页面是在 input 里读值的）
  const got = await page.evaluate(z => {
    const el = document.getElementById('zoom');
    if (!el) return null;
    el.value = String(z);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  }, ZOOM);

  await page.waitForTimeout(WAIT);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await page.screenshot({ path: OUT });
  const el = await page.$('canvas');
  if (el) await el.screenshot({ path: OUT.replace(/\.png$/, '.canvas.png') });

  console.log('zoom      :', got, '(要求', ZOOM + ')');
  console.log('pageErrors:', errs.length ? errs.join(' | ') : '(无)');
  console.log('saved     :', OUT);
  await browser.close();
})();
