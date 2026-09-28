// _shot_design.js —— 我自己写的一次性脚本（不参与判据）：整页截图 + 读计算样式。
// 起因：_shot.js 只截"首屏一屏 + 画布"，改版要看的恰恰是首屏之外（折叠区、表格、结果盒）
// 和"算出来的字号/颜色到底是不是我想的那几个值"。这两件事都只能靠真浏览器。
//
// 用法：node _shot_design.js <url> <输出png>
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const URL = process.argv[2];
const OUT = process.argv[3];
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// 想核对的：元素 -> 想看的几个属性（默认 color / background-color / font-size / border / box-shadow）
const PROBE = {
  'http://127.0.0.1:8765/': [
    'header', 'h1', '.ver', '.lead', '.entry', '.entry .ico', '.entry.kids',
    '.promise li', '.kbar', 'details.card', 'details.card>summary', 'footer',
  ],
  'http://127.0.0.1:8765/orbit': [
    'header', 'h1', '.sub', '.warnbox', '.card', 'h2', '.badge',
    'table th', 'table td', '.legend', '.sw', 'button', '#crun',
  ],
  'http://127.0.0.1:8765/kids': [
    'h1', '.lead', '.card', 'canvas', '.val', '.big', '.big b', 'button', 'details', 'summary',
  ],
  'http://127.0.0.1:8765/universe': [
    'header', 'h1', '.sub', '.card', 'h2', '.legend', '.dot', '#statline',
    'details.card', 'details.card>summary', '.tychip', '#bodytable th',
  ],
};

(async () => {
  const errors = [];
  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    channel: fs.existsSync(CHROME) ? undefined : 'chrome',
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
  await page.waitForTimeout(6000);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await page.screenshot({ path: OUT, fullPage: true });

  const info = await page.evaluate((sels) => {
    const out = {};
    for (const s of sels) {
      const el = document.querySelector(s);
      if (!el) { out[s] = '(没有这个元素)'; continue; }
      const c = getComputedStyle(el);
      out[s] = [c.fontSize + '/' + c.lineHeight, c.fontWeight, 'color=' + c.color,
                'bg=' + c.backgroundColor, 'border=' + c.borderTopWidth + ' ' + c.borderTopColor,
                'shadow=' + (c.boxShadow || 'none').slice(0, 46)].join('  |  ');
    }
    out['[page]'] = '高 ' + document.documentElement.scrollHeight + 'px';
    return out;
  }, PROBE[URL] || []);

  console.log('url    :', URL);
  console.log('saved  :', OUT);
  console.log('errors :', errors.length ? errors.slice(0, 6).join(' | ') : '(无)');
  for (const [k, v] of Object.entries(info)) console.log('  ' + k.padEnd(22) + ' ' + v);

  await browser.close();
  process.exit(errors.length ? 3 : 0);
})();
