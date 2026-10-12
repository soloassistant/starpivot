// _va_mobile_deep.js —— 移动端"深挖"检查：先展开所有 <details> 折叠区（用户点得到的状态），
// 再逐页判定「超出视口的元素」是（a）被裁掉（内容不可达 = 真缺陷）还是（b）容器内可横滑（可接受）。
//
// 为什么必须展开：折叠区里的控件默认没有布局盒，静态扫描看不见；
// 用户一展开就露出来 —— 移动端的真缺陷最容易躲在这里。
//
// 用法：node _va_mobile_deep.js <base> <viewW> <viewH>
const { chromium } = require('playwright-core');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:8765';
const W = +(process.argv[3] || 390);
const H = +(process.argv[4] || 844);
const ROUTES = ['/', '/orbit', '/universe', '/kids'];
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
  });

  const summary = [];

  for (const route of ROUTES) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(BASE + route, { waitUntil: 'load', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);

    const r = await page.evaluate(vw => {
      // 1) 展开所有折叠区
      let openedDetails = 0;
      document.querySelectorAll('details:not([open])').forEach(d => { d.open = true; openedDetails++; });
      // 2) 把默认隐藏但"用户能打开"的面板也试一遍（只对最外层开关做，不造过多合成态）
      let openedBoxes = 0;
      ['collidebox', 'custombox'].forEach(id => {
        const e = document.getElementById(id);
        if (e && getComputedStyle(e).display === 'none') { e.style.display = 'block'; openedBoxes++; }
      });

      function clipAncestor(el) {
        let p = el.parentElement, hops = 0;
        while (p && hops < 14) {
          const cs = getComputedStyle(p);
          if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
            return { tag: p.tagName.toLowerCase(), id: p.id || '',
                     overflowX: cs.overflowX, scrollW: p.scrollWidth, clientW: p.clientWidth,
                     scrollable: p.scrollWidth > p.clientWidth + 1 && (cs.overflowX === 'auto' || cs.overflowX === 'scroll') };
          }
          p = p.parentElement; hops++;
        }
        return null;
      }

      const clipped = [], scrollable = [];
      const seen = new Set();
      document.querySelectorAll('body *').forEach(el => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') return;
        const b = el.getBoundingClientRect();
        if (b.width < 2 || b.height < 2) return;
        if (b.right <= vw + 2 && b.left >= -2) return;
        const key = el.tagName.toLowerCase() + '#' + (el.id || '') + '.' + (typeof el.className === 'string' ? el.className.split(' ')[0] : '');
        if (seen.has(key)) return;
        seen.add(key);
        const a = clipAncestor(el);
        const rec = { what: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : ''),
                      w: Math.round(b.width), overflowBy: Math.round(b.right - vw),
                      anc: a ? `${a.tag}${a.id ? '#' + a.id : ''}[overflowX=${a.overflowX}; ${a.scrollW}vs${a.clientW}]` : '(无裁切祖先)' };
        if (a && a.scrollable) scrollable.push(rec); else clipped.push(rec);
      });

      const de = document.documentElement;
      return {
        openedDetails, openedBoxes,
        docOverflowX: de.scrollWidth - de.clientWidth,
        clipped: clipped.sort((x, y) => y.overflowBy - x.overflowBy),
        scrollable: scrollable.sort((x, y) => y.overflowBy - x.overflowBy),
      };
    }, W);

    console.log(`\n######## ${route} (${W}x${H}) ########`);
    console.log(`展开折叠区: ${r.openedDetails} 个 <details>，另外打开 ${r.openedBoxes} 个隐藏面板`);
    console.log(`文档横向溢出: ${r.docOverflowX}px`);
    console.log(`❌ 被裁掉/不可达: ${r.clipped.length} 种`);
    r.clipped.slice(0, 14).forEach(c => console.log(`     ${c.what}  w=${c.w}  超出${c.overflowBy}px  祖先 ${c.anc}`));
    console.log(`✅ 容器内可横滑（可接受）: ${r.scrollable.length} 种`);
    r.scrollable.slice(0, 6).forEach(c => console.log(`     ${c.what}  w=${c.w}  超出${c.overflowBy}px  祖先 ${c.anc}`));

    summary.push({ route, ...r });
    await ctx.close();
  }

  fs.writeFileSync('_va/_report_mobile_deep.json', JSON.stringify(summary, null, 2));
  console.log('\n[report] _va/_report_mobile_deep.json');
  await browser.close();
})();
