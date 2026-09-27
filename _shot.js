// _shot.js —— 用本机真实 Chrome 打开页面并截图。
// 目的：把"画面到底长什么样"变成可以直接看的东西（本机没有浏览器自动化工具时，
// 靠 jsdom 桩只能断言"调用了什么"，看不到"画出来是什么"）。
//
// 用法：
//   node _shot.js <url> <输出png> [等待毫秒] [宽] [高]
//
// 只读：不点任何会改状态的控件，只等页面自己把首帧画完。
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const URL = process.argv[2] || 'http://localhost:8765/universe';
const OUT = process.argv[3] || '_shot/out.png';
const WAIT = +(process.argv[4] || 6000);
const W = +(process.argv[5] || 1440);
const H = +(process.argv[6] || 1000);

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const errors = [];
  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    channel: fs.existsSync(CHROME) ? undefined : 'chrome',
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
  });
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 2,          // 2 倍图，便于看清细节
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(URL, { waitUntil: 'load', timeout: 45000 });

  // 等到画布上真的有东西（不是一片空白）
  const drew = await page.waitForFunction(() => {
    const cv = document.querySelector('canvas');
    if (!cv || !cv.width) return false;
    const c = cv.getContext('2d');
    if (!c) return false;
    const d = c.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4 * 37) if (d[i] > 8) n++;
    return n > 40;
  }, null, { timeout: 30000 }).then(() => true).catch(() => false);

  await page.waitForTimeout(WAIT);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await page.screenshot({ path: OUT });

  // 顺便把画布单独再截一张（去掉 UI，方便看画本身）
  const cvBox = await page.evaluate(() => {
    const cv = document.querySelector('canvas');
    if (!cv) return null;
    const r = cv.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height),
             cw: cv.width, ch: cv.height };
  });
  if (cvBox) {
    const cvEl = await page.$('canvas');
    const out2 = OUT.replace(/\.png$/, '.canvas.png');
    await cvEl.screenshot({ path: out2 });
    console.log('canvas png:', out2);
  }

  // 页面自己报的状态，帮助判断"截图时它是第几帧、有没有报错"
  const info = await page.evaluate(() => {
    const t = s => { const e = document.querySelector(s); return e ? (e.textContent || '').trim().slice(0, 160) : null; };
    return { status: t('#status'), legendLen: (document.querySelector('#legend') || {}).textContent?.length || 0,
             title: document.title };
  });

  console.log('url        :', URL);
  console.log('engineDrew :', drew);
  console.log('canvas     :', JSON.stringify(cvBox));
  console.log('pageInfo   :', JSON.stringify(info, null, 1));
  console.log('errors     :', errors.length ? errors.slice(0, 8).join(' | ') : '(无)');
  console.log('saved      :', OUT);

  await browser.close();
  process.exit(errors.length ? 3 : 0);
})();
