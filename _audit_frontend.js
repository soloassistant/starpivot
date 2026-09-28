// _audit_frontend.js —— 前端审查：用真 Chrome 采集四页的**运行时事实**。
//
// 定位：这不是判据，是审查。判据（_check_bio_page 等 63 条）管的是"页面有没有算物理、字段名对不对"，
// 完全没有覆盖**语义与无障碍**。这里专门补那块空白，且**只采集事实、不下结论**——
// 结论写在报告里，且每条都要指得出是哪次采集得到的。
//
// 只读：不点任何会改状态的控件，只等页面自己把首屏画完。
const { chromium } = require('playwright-core');
const fs = require('fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:8765';
const PAGES = [
  ['/', 'home.html（首页）'],
  ['/orbit', 'index.html（轨道递推）'],
  ['/universe', 'universe.html（N 体沙盒）'],
  ['/kids', 'kids.html（小朋友页）'],
];

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
  });

  const result = {};
  for (const [path, name] of PAGES) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errs = [], warns = [], reqs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    page.on('console', m => {
      if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 120));
      else if (m.type() === 'warning') warns.push(m.text().slice(0, 120));
    });
    page.on('request', r => reqs.push(r.url()));

    let loadOk = true;
    try {
      await page.goto(BASE + path, { waitUntil: 'load', timeout: 45000 });
    } catch (e) {
      loadOk = false;
      errs.push('加载失败: ' + e.message.slice(0, 80));
    }
    if (loadOk) await page.waitForTimeout(path === '/universe' ? 14000 : 5000);

    // ---- 无障碍树：按钮有没有可访问名 ----
    let buttonTotal = 0, unnamed = [];
    try {
      const snap = await page.accessibility.snapshot({ interestingOnly: true });
      const walk = n => {
        if (!n) return;
        if (n.role === 'button') {
          buttonTotal++;
          if (!n.name || !String(n.name).trim()) unnamed.push('(无)');
        }
        (n.children || []).forEach(walk);
      };
      walk(snap);
    } catch (e) {
      unnamed.push('无障碍快照不可用: ' + e.message.slice(0, 60));
    }

    // ---- DOM 层事实 ----
    const dom = await page.evaluate(() => {
      const q = s => document.querySelectorAll(s).length;
      const cv = document.querySelector('canvas');
      const hs = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => +h.tagName[1]);
      let skip = null;
      for (let i = 1; i < hs.length; i++) if (hs[i] - hs[i - 1] > 1) { skip = 'h' + hs[i - 1] + ' → h' + hs[i]; break; }
      const ins = [...document.querySelectorAll('input,select,textarea')];
      return {
        lang: document.documentElement.lang || '(无)',
        title: document.title,
        buttons: q('button'), links: q('a[href]'), inputs: q('input'), selects: q('select'),
        ariaLive: q('[aria-live]'), ariaLabel: q('[aria-label]'), roles: q('[role]'),
        imgs: q('img'),
        canvas: cv ? {
          fallbackText: (cv.textContent || '').trim().length,
          ariaLabel: cv.getAttribute('aria-label') ? '有' : '无',
          role: cv.getAttribute('role') || '(无)',
        } : null,
        headings: hs.length ? hs.join('>') : '(无)',
        headingSkip: skip,
        focusable: q('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'),
        unlabeledControls: ins.filter(el => !el.labels || el.labels.length === 0).length,
        controlsTotal: ins.length,
      };
    });

    const external = reqs.filter(u => !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:'));
    result[name] = { path, errs, warnCount: warns.length, external, buttonTotal, unnamedCount: unnamed.length, dom };
    await ctx.close();
  }

  await browser.close();

  // ---- 输出 ----
  const L = [];
  L.push('# 前端运行时审查（真 Chrome 采集）');
  L.push('');
  L.push('采集时间：' + new Date().toLocaleString('zh-CN'));
  L.push('');
  L.push('| 页面 | 加载 | console 错误 | console 警告 | 外部请求 | 按钮数 | 无可访问名 | roles | aria-live | aria-label |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [name, r] of Object.entries(result)) {
    L.push('| ' + name + ' | ' + (r.errs.length ? '✗' : '✓') + ' | ' + r.errs.length
      + ' | ' + r.warnCount + ' | ' + r.external.length + ' | ' + r.buttonTotal
      + ' | ' + r.unnamedCount + ' | ' + r.dom.roles + ' | ' + r.dom.ariaLive
      + ' | ' + r.dom.ariaLabel + ' |');
  }
  L.push('');
  for (const [name, r] of Object.entries(result)) {
    L.push('## ' + name);
    L.push('');
    L.push('```json');
    L.push(JSON.stringify(r, null, 1));
    L.push('```');
    L.push('');
  }
  const text = L.join('\n');
  fs.writeFileSync('_audit_frontend.out.md', text, 'utf-8');
  console.log('已写 _audit_frontend.out.md');
  console.log(text.slice(0, 1800));
  process.exit(0);
})();
