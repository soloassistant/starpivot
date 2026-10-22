// _va_shot.js —— 视觉验收专用取景 + 体检（真 Chrome，不走内置浏览器）。
//
// 为什么不用 _shot.js：它只报 #status，看不见"版面有没有炸"。
// 这个脚本每个页面同时给三样东西：
//   ① 一张真截图（fullPage，scale 可调）
//   ② 版面体检：横向溢出 / 超出视口的元素 / 画布是否真画了 / 控制台报错
//   ③ 页面自己的读数（各页关键 DOM 的文本），用来判断"截的时候它是第几帧、有没有停在半路"
//
// 用法：node _va_shot.js <base> <tag> <viewW> <viewH> <scale> <page1,page2,...> [waitSel]
//   例：node _va_shot.js http://127.0.0.1:8765 desktop 1440 1000 1 /,/orbit,/universe,/kids
//
// 只读：不点任何会改状态的控件。
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:8765';
const TAG = process.argv[3] || 'desktop';
const W = +(process.argv[4] || 1440);
const H = +(process.argv[5] || 1000);
const SCALE = +(process.argv[6] || 1);
const ROUTES = (process.argv[7] || '/,/orbit,/universe,/kids').split(',').map(s => s.trim()).filter(Boolean);
// 等到这个选择器里有文字才算"真的出结果了"（给 universe 用；其它页可省）
const WAIT_SEL = process.argv[8] || '';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUTDIR = '_va';

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    channel: fs.existsSync(CHROME) ? undefined : 'chrome',
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
  });

  const report = [];

  for (const route of ROUTES) {
    const url = BASE + route;
    const errors = [];
    const ctx = await browser.newContext({
      viewport: { width: W, height: H },
      deviceScaleFactor: SCALE,
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
    page.on('requestfailed', r => errors.push('reqfail: ' + r.url().slice(0, 90) + ' ' + (r.failure() || {}).errorText));

    const t0 = Date.now();
    let navErr = null;
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    } catch (e) { navErr = e.message; }
    const loadMs = Date.now() - t0;

    // 等"真结果"：WAIT_SEL 只在**该选择器真的存在于这一页**时才等（否则退回 networkidle，
    // 免得在 home/orbit/kids 上白等 60 秒）
    let waitedFor = 'load';
    const selExists = WAIT_SEL
      ? await page.evaluate(s => !!document.querySelector(s), WAIT_SEL).catch(() => false)
      : false;
    if (WAIT_SEL && selExists) {
      const ok = await page.waitForFunction(
        sel => { const e = document.querySelector(sel); return e && (e.textContent || '').trim().length > 0; },
        WAIT_SEL, { timeout: 60000 }
      ).then(() => true).catch(() => false);
      waitedFor = ok ? `sel(${WAIT_SEL})有文字` : `sel(${WAIT_SEL})超时未出文字`;
      if (ok) await sleep(2500);
    } else {
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      waitedFor = WAIT_SEL ? `该页无 ${WAIT_SEL}，退回 networkidle` : 'networkidle';
      await sleep(1500);
    }

    // —— 版面体检 ——
    const probe = await page.evaluate(() => {
      const de = document.documentElement;
      const vw = window.innerWidth, vh = window.innerHeight;
      const overflowX = de.scrollWidth - de.clientWidth;

      // 超出视口右侧/左侧的"可见"元素（排除 fixed 装饰与 canvas 内部）
      const bad = [];
      document.querySelectorAll('body *').forEach(el => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') return;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        if (r.right > vw + 2 || r.left < -2) {
          bad.push({
            tag: el.tagName.toLowerCase(),
            id: el.id || '',
            cls: (el.className && typeof el.className === 'string') ? el.className.slice(0, 40) : '',
            left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width),
          });
        }
      });

      // 画布是否真画了（按 alpha 采样）
      let canvas = null;
      const cv = document.querySelector('canvas');
      if (cv && cv.width) {
        let drew = null, kind = null;
        try {
          const c2 = cv.getContext('2d');
          if (c2) {
            kind = '2d';
            const d = c2.getImageData(0, 0, cv.width, cv.height).data;
            let n = 0;
            for (let i = 3; i < d.length; i += 4 * 37) if (d[i] > 8) n++;
            drew = n;
          } else { kind = 'webgl/other'; }
        } catch (e) { kind = 'err:' + e.message.slice(0, 60); }
        canvas = { cssW: Math.round(cv.getBoundingClientRect().width),
                   cssH: Math.round(cv.getBoundingClientRect().height),
                   bw: cv.width, bh: cv.height, kind, drew };
      }

      const txt = s => { const e = document.querySelector(s); return e ? (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 150) : null; };
      return {
        title: document.title,
        vw, vh,
        docScrollW: de.scrollWidth, docScrollH: de.scrollHeight,
        overflowX,
        badCount: bad.length,
        bad: bad.slice(0, 12),
        canvas,
        reads: {
          status: txt('#status'), statline: txt('#statline'), tlabel: txt('#tlabel'),
          verdict: txt('#verdict'), enote: txt('#enote'), errbar: txt('#errbar'),
          h1: txt('h1'), lead: txt('.lead') || txt('#lead'),
        },
      };
    });

    const out = path.join(OUTDIR, `${TAG}${route.replace(/\//g, '_') || '_home'}.png`);
    fs.mkdirSync(OUTDIR, { recursive: true });
    await page.screenshot({ path: out, fullPage: true });

    report.push({ route, url, navErr, loadMs, waitedFor, out, errors: errors.slice(0, 8), ...probe });
    console.log(`\n===== ${route} =====`);
    console.log('navErr     :', navErr || '(无)');
    console.log('loadMs     :', loadMs, '| waitedFor:', waitedFor);
    console.log('viewport   :', probe.vw + 'x' + probe.vh, '| doc:', probe.docScrollW + 'x' + probe.docScrollH,
                '| overflowX:', probe.overflowX);
    console.log('canvas     :', JSON.stringify(probe.canvas));
    console.log('bad-elems  :', probe.badCount, probe.badCount ? JSON.stringify(probe.bad) : '');
    console.log('reads      :', JSON.stringify(probe.reads));
    console.log('errors     :', errors.length ? errors.slice(0, 8).join('\n             ') : '(无)');
    console.log('saved      :', out);

    await ctx.close();
  }

  fs.writeFileSync(path.join(OUTDIR, `_report_${TAG}.json`), JSON.stringify(report, null, 2));
  console.log(`\n[report] ${path.join(OUTDIR, '_report_' + TAG + '.json')}`);
  await browser.close();
})();
