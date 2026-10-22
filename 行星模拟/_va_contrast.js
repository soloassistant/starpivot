// _va_contrast.js —— 渲染后的对比度实测（WCAG），跑在真 Chrome 上。
// 为什么另做：静态令牌表只能验"声明"，验不了"实际叠出来的那对颜色"。
//
// 用法：node _va_contrast.js <base> [viewW] [viewH]
const { chromium } = require('playwright-core');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:8765';
const W = +(process.argv[3] || 1440);
const H = +(process.argv[4] || 1000);
const ROUTES = ['/', '/orbit', '/universe', '/kids'];
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
  });

  for (const route of ROUTES) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(BASE + route, { waitUntil: 'load', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);

    const out = await page.evaluate(() => {
      const parse = s => {
        const m = String(s).match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const p = m[1].split(',').map(x => parseFloat(x.trim()));
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      };
      const lum = c => {
        const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      };
      const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };
      // 在 bg 上叠一个带 alpha 的 fg
      const over = (fg, bg) => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
      });
      const effBg = el => {
        let p = el, acc = null;
        while (p && p !== document.documentElement.parentElement) {
          const cs = getComputedStyle(p);
          const bg = parse(cs.backgroundColor);
          const bi = parse(cs.backgroundImage || 'none');
          if (bg && bg.a > 0) {
            acc = acc ? over(acc, bg) : bg;
            if (acc.a >= 0.999) return acc;
          }
          if (cs.backgroundImage && cs.backgroundImage !== 'none') return acc ? { ...acc } : { r: 255, g: 255, b: 255, a: 1 };
          p = p.parentElement;
        }
        return acc || { r: 255, g: 255, b: 255, a: 1 };
      };

      const bad = [], stats = { checked: 0 };
      const isVisible = el => {
        if (!el.getClientRects().length) return false;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05;
      };
      // 只看"直接含可见文字"的元素
      document.querySelectorAll('body *').forEach(el => {
        let direct = '';
        el.childNodes.forEach(n => { if (n.nodeType === 3) direct += n.nodeValue; });
        direct = direct.replace(/\s+/g, ' ').trim();
        if (!direct || direct.length < 2) return;
        if (!isVisible(el)) return;
        const cs = getComputedStyle(el);
        const fg0 = parse(cs.color);
        if (!fg0) return;
        const bg = effBg(el);
        const fg = fg0.a < 1 ? over(fg0, bg) : fg0;
        const cr = ratio(fg, bg);
        const fs = parseFloat(cs.fontSize);
        const bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
        const large = fs >= 24 || (fs >= 18.66 && bold);
        const need = large ? 3.0 : 4.5;
        stats.checked++;
        if (cr < need) {
          bad.push({
            text: direct.slice(0, 48), tag: el.tagName.toLowerCase(), id: el.id || '',
            cls: typeof el.className === 'string' ? el.className.slice(0, 28) : '',
            cr: +cr.toFixed(2), need, fs, bold,
            fg: `rgb(${Math.round(fg.r)},${Math.round(fg.g)},${Math.round(fg.b)})`,
            bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`,
          });
        }
      });
      bad.sort((a, b) => a.cr - b.cr);
      return { checked: stats.checked, bad: bad.slice(0, 20), badCount: bad.length };
    });

    console.log(`\n######## ${route} ########`);
    console.log(`检查了 ${out.checked} 处直接文字；低于 WCAG 阈值的 ${out.badCount} 处`);
    out.bad.forEach(b => console.log(`   ${String(b.cr).padStart(5)} (需${b.need}) ${b.tag}${b.id ? '#' + b.id : ''}${b.cls ? '.' + b.cls : ''} [${b.fs}px${b.bold ? ' bold' : ''}] "${b.text}"  ${b.fg} on ${b.bg}`));
    await ctx.close();
  }
  await browser.close();
})();
