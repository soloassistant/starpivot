// _shot_motion.js —— 用真 Chrome 打开 /universe，在**播放中**连截多帧看运动表现。
// 与 _shot.js 的区别：它只截首帧；这里要验的是"动起来之后画面是什么样" ——
// 彗尾渐隐、跟随取景框、逐帧定位脉冲、撞击瞬效，都只在特定时刻才出现。
//
// 用法：node _shot_motion.js
// ⚠ 跑之前必须 unset 代理（本机 HTTP_PROXY 会把 127.0.0.1 也接走）。
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:8765/universe';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(__dirname, '_shot');
const W = 1440, H = 1000;

(async () => {
  const errors = [];
  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    channel: fs.existsSync(CHROME) ? undefined : 'chrome',
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
  });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  fs.mkdirSync(OUT, { recursive: true });
  await page.goto(BASE, { waitUntil: 'load', timeout: 45000 });
  await page.waitForFunction(() => {
    const cv = document.querySelector('canvas');
    if (!cv || !cv.width) return false;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4 * 37) if (d[i] > 8) n++;
    return n > 40;
  }, null, { timeout: 45000 });

  const canvas = await page.$('canvas');
  const shot = async name => {
    const f = path.join(OUT, 'motion-' + name + '.canvas.png');
    await canvas.screenshot({ path: f });
    const lbl = (await page.textContent('#tlabel') || '').trim();
    console.log('shot', name, '|', lbl);
  };
  // 把时间轴挪 delta 帧（走页面自己的 scrub 通路，等于手动定位）
  const jumpFrames = async delta => {
    const lbl = await page.textContent('#tlabel');
    const m = /帧 (\d+)\/(\d+)/.exec(lbl || '');
    if (!m) return false;
    const fi = +m[1] - 1, M = +m[2];
    const target = Math.max(0, Math.min(M - 1, fi + delta));
    await page.evaluate(v => {
      const s = document.getElementById('scrub');
      s.value = String(v); s.dispatchEvent(new Event('input', { bubbles: true }));
    }, Math.round(target / (M - 1) * 1000));
    await page.waitForTimeout(120);
    return true;
  };

  // ① 播放中连截 3 帧（间隔 900ms）—— 看彗尾是否跟着当前帧走、浓淡有没有梯度
  await page.waitForTimeout(2500);
  for (let i = 1; i <= 3; i++) { await shot('play-' + i); await page.waitForTimeout(900); }

  // ② 逐帧定位反馈：按 ← 后立刻截（脉冲只在 520 ms 内）
  await page.keyboard.press('ArrowLeft');
  await shot('seek-pulse');
  await page.waitForTimeout(900);
  await shot('seek-settled');

  // ③ 撞击瞬效：点事件时间线第一行跳到撞击帧，再看窗口内两个时刻
  const row = await page.$('#eventcard table tr[data-jump-t]');
  if (row) {
    await row.click();
    await page.waitForTimeout(400);
    await shot('impact-0');
    await jumpFrames(Math.max(6, Math.round(+(await page.textContent('#tlabel'))
      .match(/\/(\d+)/)[1] * 0.02)));
    await shot('impact-1');
  } else {
    console.log('（没有事件行，撞击那两张跳过）');
  }

  // ④ 跟随：点画布中心那颗（太阳），画面应当把它钉住，并出现取景框角标
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(900);
  await shot('follow-a');
  await page.waitForTimeout(1200);
  await shot('follow-b');

  // ⑤ 全景（松跟随）再来一张，作为对照
  await page.click('#resetview');
  await page.waitForTimeout(900);
  await shot('full');

  console.log('errors    :', errors.length ? errors.slice(0, 8).join(' | ') : '(无)');
  await browser.close();
  process.exit(errors.length ? 3 : 0);
})();
