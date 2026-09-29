// _shot_motion2.js —— 补充截图：放大视角下的彗尾/跟随取景框 + 撞击瞬效。
// 与 _shot_motion.js 的分工：默认整屏视角下内行星只有几个像素，那里验的是外行星彗尾；
// 这里把 zoom 拉到 280 验内行星细节，再切「自定义」场景（有撞击事件）验撞击表现。
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
  await page.waitForTimeout(2000);

  const canvas = await page.$('canvas');
  const shot = async name => {
    const f = path.join(OUT, 'motion-' + name + '.canvas.png');
    await canvas.screenshot({ path: f });
    console.log('shot', name, '|', (await page.textContent('#tlabel') || '').trim());
  };
  const jumpFrames = async delta => {
    const m = /帧 (\d+)\/(\d+)/.exec(await page.textContent('#tlabel') || '');
    if (!m) return;
    const fi = +m[1] - 1, M = +m[2];
    const target = Math.max(0, Math.min(M - 1, fi + delta));
    await page.evaluate(v => {
      const s = document.getElementById('scrub');
      s.value = String(v); s.dispatchEvent(new Event('input', { bubbles: true }));
    }, Math.round(target / (M - 1) * 1000));
    await page.waitForTimeout(150);
  };

  // ① 放大 + 选中画面中心那颗（跟随）—— 看取景框角标与内行星的彗尾
  await page.evaluate(() => { document.getElementById('zoom').value = '280'; });
  await page.waitForTimeout(300);
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(800);
  await shot('follow-zoom-a');
  await page.waitForTimeout(1400);
  await shot('follow-zoom-b');
  // 跟随中逐帧反馈（脉冲在选中天体旁边最明显）
  await page.keyboard.press('ArrowLeft');
  await shot('follow-seek-pulse');
  await page.evaluate(() => document.getElementById('resetview').click());
  await page.waitForTimeout(400);

  // ② 撞击瞬效：切「自定义」场景（页面默认参数：太阳系全带 + 撞击碎裂 → 有事件）
  await page.evaluate(() => {
    const s = document.getElementById('scenario');
    s.value = 'custom'; s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const hasEvent = await page.waitForFunction(
    () => document.querySelectorAll('#eventcard table tr[data-jump-t]').length > 0,
    null, { timeout: 90000 }).then(() => true).catch(() => false);
  if (hasEvent) {
    await page.evaluate(() => document.querySelector('#eventcard table tr[data-jump-t]').click());
    await page.waitForTimeout(400);
    await shot('impact-0');
    const M = +(/\/(\d+)/.exec(await page.textContent('#tlabel')) || [0, 2000])[1];
    await jumpFrames(Math.round(M * 0.01));   // 撞击表现窗口（5% 总时长）的前 1/5
    await shot('impact-1');
    await jumpFrames(Math.round(M * 0.02));
    await shot('impact-2');
  } else {
    console.log('（自定义场景没有事件行，撞击截图跳过）');
  }

  console.log('errors    :', errors.length ? errors.slice(0, 8).join(' | ') : '(无)');
  await browser.close();
  process.exit(errors.length ? 3 : 0);
})();
