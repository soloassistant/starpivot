// _audit_frontend2.js —— 补采：把"哪些控件没有可访问名 / 没有 label"点到具体元素。
//
// 为什么另写一个：第一版用了 page.accessibility.snapshot()，而新版 Playwright 已弃用它 →
// 异常被 catch 吞掉后，buttonTotal 变成 0、unnamedCount 变成 1，两个数互相矛盾。
// 所以这里改用**两条互不依赖的路**：① 直接读 DOM 算可访问名；② 若可用，再用 ariaSnapshot 交叉验证。
const { chromium } = require('playwright-core');
const fs = require('fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:8765';
const PAGES = [['/', 'home'], ['/orbit', 'index'], ['/universe', 'universe'], ['/kids', 'kids']];

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'] });
  const rep = {};

  for (const [path, key] of PAGES) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE + path, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(path === '/universe' ? 12000 : 4000);

    const dom = await page.evaluate(() => {
      const short = s => (s || '').replace(/\s+/g, ' ').trim().slice(0, 26);
      // ---- 按钮：可访问名 = aria-label || 可见文字（本项目的按钮都带文字）----
      const btns = [...document.querySelectorAll('button')];
      const btnNoName = btns.filter(b => {
        const n = (b.getAttribute('aria-label') || b.textContent || '').trim();
        return n.length === 0;
      }).map(b => ({ id: b.id || '(无id)', cls: short(b.className), html: short(b.outerHTML) }));

      // ---- 表单控件：有没有 label 关联（显式 for 或隐式包裹）----
      const ins = [...document.querySelectorAll('input,select,textarea')];
      const noLabel = ins.filter(el => !el.labels || el.labels.length === 0)
        .map(el => ({
          tag: el.tagName.toLowerCase(), id: el.id || '(无id)', type: el.getAttribute('type') || '',
          aria: el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || '',
          // 它前后最近的一段可见文字（判断"视觉上有标签但没语义关联"）
          near: short((el.closest('label,div,td') || el.parentElement || {}).textContent || ''),
        }));

      // ---- canvas ----
      const cv = document.querySelector('canvas');
      const canvas = cv ? {
        ariaLabel: cv.getAttribute('aria-label'), role: cv.getAttribute('role'),
        fallbackTextLen: (cv.textContent || '').trim().length,
        tabIndex: cv.tabIndex, parentHasLabel: !!cv.closest('label'),
      } : null;

      // ---- 按钮总数里，带 emoji 前缀的（可访问名会念出 emoji 名）----
      const emojiIdx = btns.filter(b => /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test((b.textContent || '').trim())).length;

      return {
        btnTotal: btns.length, btnNoName: btnNoName.slice(0, 8), btnNoNameCount: btnNoName.length,
        ctrlTotal: ins.length, ctrlNoLabelCount: noLabel.length, ctrlNoLabel: noLabel.slice(0, 10),
        canvas, emojiButtons: emojiIdx,
      };
    });

    let aria = '';
    try {
      aria = await page.locator('body').ariaSnapshot();
    } catch (e) {
      aria = 'ERR ' + e.message.slice(0, 70);
    }
    const nameLine = (aria.match(/^\s*-\s*button\s+"[^"]+"/gm) || []).length;
    const anonLine = (aria.match(/^\s*-\s*button\s*$/gm) || []).length;

    rep[key] = { ...dom, ariaSnapshotButtonsWithName: nameLine, ariaSnapshotButtonsAnonymous: anonLine };
    await ctx.close();
  }
  await browser.close();

  const L = ['# 前端可访问性补采（具体到元素）', ''];
  for (const [k, v] of Object.entries(rep)) {
    L.push('## ' + k);
    L.push('```json');
    L.push(JSON.stringify(v, null, 1));
    L.push('```');
    L.push('');
  }
  fs.writeFileSync('_audit_frontend2.out.md', L.join('\n'), 'utf-8');
  console.log(L.join('\n').slice(0, 3000));
  process.exit(0);
})();
