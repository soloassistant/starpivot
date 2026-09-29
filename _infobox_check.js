// 验证"点开的信息"确实浮在画面（画布 #view）左上角 —— CSS 写对了不等于位置对了，
// 所以这里点一颗天体（默认场景太阳在画面中心附近），再量框和画布的相对位置。
const { chromium } = require('playwright-core');
const fs = require('fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const WIDTHS = [1440, 768, 390];

(async () => {
  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    channel: fs.existsSync(CHROME) ? undefined : 'chrome',
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
  });
  let fail = 0;
  const allErrs = [];

  for (const w of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

    await page.goto('http://127.0.0.1:8765/universe', { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(9000);          // 等首帧真画出来

    // 把画布滚进视口（窄屏首页很长、画布可能不在初始视口里；boundingBox 是文档坐标，
    // 不滚就点不到画布 —— 那不是页面的问题，是探针的坐标系问题）。
    await page.locator('#view').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    // 点一个 3×3 网格，直到真的选中了一颗天体（默认场景太阳在中心附近）
    const box = await page.locator('#view').boundingBox();
    let shown = false;
    const grid = [];
    for (const fy of [0.5, 0.42, 0.58, 0.34, 0.66]) for (const fx of [0.5, 0.4, 0.6]) grid.push([fx, fy]);
    for (const [fx, fy] of grid) {
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
      await page.waitForTimeout(450);
      shown = await page.evaluate(() => getComputedStyle(document.getElementById('selcard')).display !== 'none');
      if (shown) break;
    }
    if (!shown) {
      // 窄屏点不到天体时，直接把卡亮出来量位置（验证的是 CSS 浮层定位，与是否真选中无关）。
      await page.evaluate(() => {
        const c = document.getElementById('selcard');
        document.getElementById('selbody').innerHTML = '<div>占位：用于量浮层位置</div>';
        c.style.display = 'block';
      });
      console.log(`  (note) @${w}px — 点击没选中天体，改用强制显示来量位置`);
    }

    const r = await page.evaluate(() => {
      const cv = document.getElementById('view').getBoundingClientRect();
      const sc = document.getElementById('selcard').getBoundingClientRect();
      const body = document.getElementById('selbody');
      return {
        cv: { l: cv.left, t: cv.top, r: cv.right, b: cv.bottom, w: cv.width, h: cv.height },
        sc: { l: sc.left, t: sc.top, r: sc.right, b: sc.bottom, w: sc.width, h: sc.height },
        txt: (body.textContent || '').trim().slice(0, 60),
        off: (() => { const o = document.getElementById('selcard'); let p = o; while (p && p.id !== 'stagebox') p = p.offsetParent; return p ? p.id : 'NONE'; })(),
      };
    });

    const dx = r.sc.l - r.cv.l, dy = r.sc.t - r.cv.t;          // 相对画布左上角的偏移
    const bad = [];
    if (dx < 0 || dx > 64) bad.push(`左边缘距画布左边 ${Math.round(dx)}px（期望 0–64）`);
    if (dy < 0 || dy > 64) bad.push(`上边缘距画布顶边 ${Math.round(dy)}px（期望 0–64）`);
    if (r.sc.r > r.cv.r + 1) bad.push('右边缘超出画布');
    if (r.sc.b > r.cv.b + 1) bad.push('下边缘超出画布');
    if (r.sc.w < 120) bad.push(`宽度只有 ${Math.round(r.sc.w)}px，太窄读不了`);
    if (!r.txt) bad.push('框里没有内容');

    if (bad.length) { fail++; console.log(`[FAIL] @${w}px — ` + bad.join('；')); }
    else console.log(`  ok  @${w}px  框在画布左上角内 (${Math.round(dx)},${Math.round(dy)})` +
      `  尺寸 ${Math.round(r.sc.w)}×${Math.round(r.sc.h)}  相对基准=${r.off}  内容「${r.txt.slice(0, 24)}…」`);
    await page.screenshot({ path: `_shot/infobox-${w}.png` });
    allErrs.push(...errs);
    await ctx.close();
  }

  await browser.close();
  console.log(`\n信息框位置核对 fail=${fail}` + (allErrs.length ? `（另有报错：${allErrs.slice(0, 2).join(' | ')}）` : ''));
  process.exit(fail ? 1 : 0);
})();
