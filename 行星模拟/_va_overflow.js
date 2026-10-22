// _va_overflow.js —— 判定移动端"超出视口的元素"到底是（a）被裁掉（数据看不到）
// 还是（b）处在可横向滚动的容器里（能滑到，可接受）。
// 用法：node _va_overflow.js <url> <viewW> <viewH>
const { chromium } = require('playwright-core');
const fs = require('fs');

const URL = process.argv[2];
const W = +(process.argv[3] || 390);
const H = +(process.argv[4] || 844);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
  });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const res = await page.evaluate(vw => {
    // 从某元素往上找，看第一个"裁切/滚动"祖先
    function ancestorClip(el) {
      let p = el.parentElement, hops = 0;
      while (p && hops < 12) {
        const cs = getComputedStyle(p);
        const ox = cs.overflowX, oy = cs.overflowY;
        if (ox !== 'visible' || oy !== 'visible') {
          return { tag: p.tagName.toLowerCase(), id: p.id || '',
                   cls: (typeof p.className === 'string' ? p.className.slice(0, 30) : ''),
                   overflowX: ox, overflowY: oy,
                   scrollW: p.scrollWidth, clientW: p.clientWidth,
                   scrollable: p.scrollWidth > p.clientWidth + 1 && (ox === 'auto' || ox === 'scroll') };
        }
        p = p.parentElement; hops++;
      }
      return null;
    }

    const seen = new Map();
    document.querySelectorAll('body *').forEach(el => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') return;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      if (r.right <= vw + 2 && r.left >= -2) return;
      const key = el.tagName.toLowerCase() + '#' + (el.id || '') + '.' + (typeof el.className === 'string' ? el.className.split(' ')[0] : '');
      if (seen.has(key)) return;
      seen.set(key, {
        tag: el.tagName.toLowerCase(), id: el.id || '',
        cls: (typeof el.className === 'string' ? el.className.slice(0, 36) : ''),
        left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width),
        overflowBy: Math.round(r.right - vw),
        clipAncestor: ancestorClip(el),
      });
    });
    const de = document.documentElement;
    return {
      viewport: vw,
      docOverflowX: de.scrollWidth - de.clientWidth,
      docScrollW: de.scrollWidth,
      kinds: [...seen.values()].sort((a, b) => b.overflowBy - a.overflowBy).slice(0, 25),
      total: seen.size,
    };
  }, W);

  console.log('URL        :', URL, `@ ${W}x${H}`);
  console.log('文档横向溢出:', res.docOverflowX, '(scrollWidth', res.docScrollW + ')');
  console.log('超视口元素种类:', res.total);
  console.log('--- 按超出量排序（前 25）---');
  for (const k of res.kinds) {
    const a = k.clipAncestor;
    const verdict = !a ? '⚠ 无裁切祖先 → 应把整页撑宽（但文档未溢出？）'
      : a.scrollable ? `OK 可在 <${a.tag}${a.id ? '#' + a.id : ''}> 内横滑（${a.scrollW}>${a.clientW}）`
      : `❌ 被裁：祖先 <${a.tag}${a.id ? '#' + a.id : ''}> overflowX=${a.overflowX}（${a.scrollW} vs ${a.clientW}）`;
    console.log(`  ${k.tag}${k.id ? '#' + k.id : ''}${k.cls ? '.' + k.cls : ''} w=${k.w} 超出 ${k.overflowBy}px → ${verdict}`);
  }
  await browser.close();
})();
