// 首页的页面级判据（E 层）：真加载首页、真跑它里面那份脚本。
//
// 为什么在 `_check_home.js` 之外还要单开一个：那一条只看"**那些话在不在 HTML 里**"，
// 而首页还有一段**会执行的**脚本 —— 它去问 `/api/health`，然后把"内核在线"连同
// 平台、内核路径、字节数写进页面。**那段脚本是首页对用户说的第一句话**，
// 不能只是"文件里有"：写错了、选择器对不上、fetch 挂了，页面就会一直停在
// "正在问内核……"，而静态判据照样全绿。
//
// 另外两件事一起验：① 两个工具页的链接真的取得到（首页是入口，链接断了等于没入口）；
// ② 问不到内核时**必须如实说问不到**，不许仍显示"在线"（负样本）。
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const BASE = process.env.STARPIVOT_BASE || 'http://127.0.0.1:8765';
const nodeFetch = globalThis.fetch;
const LOG = [];
let n = 0, fail = 0;
const ok = (c, m) => { n++; LOG.push((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

process.on('exit', () => {
  fs.writeFileSync(path.join(__dirname, '_probe_home.txt'), LOG.join('\n') + '\n', 'utf8');
});

// 加载一页并等脚本里的异步部分跑完。
// 只替换两件事：canvas context（jsdom 不渲染）与 fetch（要能把相对路径接到 BASE 上）。
async function open(htmlPath, { breakHealth = false } = {}) {
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', e => errs.push(String((e && e.message) || e)));
  let html = await (await nodeFetch(BASE + htmlPath)).text();
  if (breakHealth) html = html.split('/api/health').join('/api/no_such_endpoint');
  const dom = new JSDOM(html, {
    url: BASE + htmlPath, runScripts: 'dangerously', virtualConsole: vc,
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
        get: () => () => {}, set: () => true
      });
      w.fetch = (u, o) => nodeFetch(new URL(String(u), BASE).href, o);
    }
  });
  await sleep(1200);
  return { dom, errs, doc: dom.window.document };
}

// 首屏顺序判据：三个入口必须排在第一个折叠区**之前**（顺序就是优先级）。
// 用节点下标比，**不用 `compareDocumentPosition` 的位掩码** —— jsdom 不导出
// `Node.FOLLOWING`（实测是 undefined），`x & undefined` 恒为 0，那样写出来的是**恒假**断言；
// 反过来写就变成恒真（全绿却是假的）。这条坑记在这儿，别再踩。
const orderOK = (root) => {
  const all = [...root.querySelectorAll('*')];
  const entries = [...root.querySelectorAll('a.entry')];
  const firstDet = root.querySelector('details');
  if (!entries.length || !firstDet) return false;
  return entries.every(a => all.indexOf(a) < all.indexOf(firstDet));
};

(async () => {
  console.log('=== 首页（E 层）===');

  const { doc, errs } = await open('/');
  ok(errs.length === 0, '首页加载无脚本异常' + (errs.length ? ' — ' + errs[0].slice(0, 120) : ''));

  // ---- 1. 那段脚本真的跑了，而且真的写进了页面 ----
  const ks = doc.getElementById('kstatus');
  ok(!!ks, '首页有内核状态那一行（#kstatus）');
  const t = ks ? ks.textContent : '';
  ok(!/正在问内核/.test(t), '脚本跑到了：状态行不再停在初始文案', '仍然是「' + t.slice(0, 40) + '」');
  ok(/在线/.test(t), '如实报告内核在线', '实际：' + t.slice(0, 80));
  // 平台与内核路径来自服务端回显，写死在页面里是写不出来的 —— 这条同时证明它真问了 /api/health。
  const health = await (await nodeFetch(BASE + '/api/health')).json();
  ok(t.includes(health.platform), '状态行里的平台来自 /api/health 回显（' + health.platform + '）',
     '实际：' + t.slice(0, 120));
  ok(t.includes(String(health.size)), '状态行里的字节数也来自回显（' + health.size + '）',
     '实际：' + t.slice(0, 120));

  // ---- 2. 两个工具页的入口真的能进 ----
  const links = [...doc.querySelectorAll('a[href]')].map(a => a.getAttribute('href'));
  for (const want of ['index.html', 'universe.html']) {
    ok(links.includes(want), '首页有指向 ' + want + ' 的入口链接');
    const r = await nodeFetch(BASE + '/' + want);
    ok(r.ok, '而且那个链接真的取得到（' + want + ' → HTTP ' + r.status + '）');
  }

  // ---- 3. 首屏：入口不能被折叠，内容确实收起来了 ----
  // 起因是一次用户反馈："内容太多，看不到重点"。静态判据（_check_home.js 第 8 组）
  // 只看文档结构，这里验**真渲染后**的情况：入口不在 <details> 里、折叠区默认是收起的、
  // 而且入口排在第一个折叠区**之前**（顺序就是优先级）。
  const entries = [...doc.querySelectorAll('a.entry')];
  ok(entries.length >= 3, '首屏有 ' + entries.length + ' 个入口卡');
  ok(['kids.html', 'index.html', 'universe.html'].every(h => links.includes(h)),
     '三个入口指向三页：' + ['kids.html', 'index.html', 'universe.html'].join(' / '));
  ok(entries.length > 0 && entries.every(a => !a.closest('details')),
     '入口都不在折叠区里（要"点开才看得到"的东西不算入口）');
  const dets = [...doc.querySelectorAll('details')];
  ok(dets.length >= 4 && dets.every(d => !d.open),
     `${dets.length} 个折叠区默认都是收起的（首屏才短得下来）`);
  ok(orderOK(doc), '入口排在第一个折叠区之前');
  {
    // 负样本走**同一个函数**：入口挪到折叠区之后，必须判不通过。
    const mini = new JSDOM('<details><summary>先折叠</summary>内容</details>' +
                           '<a class="entry" href="x.html">入口</a>');
    ok(!orderOK(mini.window.document),
       '负样本：入口排在折叠区之后 → 同一处判不通过（自证判据有效）');
  }

  // ---- 4. 负样本：问不到内核时必须如实说，不许假装在线 ----
  const bad = await open('/', { breakHealth: true });
  const bt = bad.doc.getElementById('kstatus').textContent;
  ok(!/在线/.test(bt), '负样本：/api/health 不可用时**不许**再显示"在线"', '实际：' + bt.slice(0, 80));
  ok(/问不到/.test(bt), '负样本：而是如实说"问不到"', '实际：' + bt.slice(0, 80));

  console.log(LOG.join('\n'));
  console.log('\n[home-e2e] n=' + n + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  LOG.push('  FAIL  探针自身异常：' + (e && e.message));
  console.log(LOG.join('\n'));
  console.log('\n[home-e2e] n=' + n + ' fail=' + (fail + 1));
  process.exit(1);
});
