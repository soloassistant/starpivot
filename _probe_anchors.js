// 引力锚点 L1–L5 的判据。契约：docs/bench-contract-2026-10-05.md §2 / §4.4。
//
// 两条红线在这里：
//   (1) 五个点必须来自 /api/lagrange 的回执（页面只按坐标画）。判据 hook fetch，
//       断言请求真发了、回执真收到了；再用「伪造一份只有 3 个点的回执」证明
//       画布上的点数跟着回执走，而不是页面自己编五个。
//   (2) 文案不得夸大。L4/L5 的稳定是**有条件的**（Routh 判据 mu < 0.0385208），
//       L1/L2/L3 恒不稳定。页面把 L4 说成"绝对安全"就是在骗人。
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const BASE = 'http://localhost:8765';
const nodeFetch = globalThis.fetch;
let n = 0, fail = 0;
const L = [];
const ok = (c, m) => { n++; L.push((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const noop = () => {};
const keys = ['L1', 'L2', 'L3', 'L4', 'L5'];

// 画布上下文桩：fillText / arc 都被记下来，判据要能证明"真的画了五个点"。
// **按画布 id 分桶**：主画面 #view 每帧几百个 arc，全混在一起的话
// "锚点画了几个点"就永远被主画面淹没，这条判据就成了摆设。
function mkCtx(bucket) {
  return new Proxy({}, {
    get: (t, k) => {
      if (k === 'createRadialGradient' || k === 'createLinearGradient')
        return () => ({ addColorStop: noop });
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'fillText') return s => bucket.text.push(String(s));
      if (k === 'arc') return () => bucket.dots.push(1);
      return noop;
    },
    set: () => true
  });
}

// 页面 HTML 取一次就缓存。
// 实测：每次 open 都重新向网关要这 270KB，偶尔第二次拿到的是没跑脚本的空壳，
// 于是判据整片变红 —— 那是判据自己的抖动，不是页面的问题。
let PAGE_HTML = null;
async function pageHtml() {
  if (PAGE_HTML === null) PAGE_HTML = await (await nodeFetch(BASE + '/universe.html')).text();
  return PAGE_HTML;
}

// opts.forge(reqBody, echo) → 替换交给页面的 /api/lagrange 回执。
async function open(opts = {}) {
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', e => errs.push(String(e && e.message)));
  vc.on('jsdomError', noop);
  const rafQueue = [], fetchLog = [];
  // drawn[id] = { text, dots }，主画面与锚点画布分开记账
  const drawn = {};
  const bucket = id => (drawn[id] || (drawn[id] = { text: [], dots: [] }));
  const dom = new JSDOM(await pageHtml(), {
    url: BASE + '/universe.html' + (opts.hash || ''), runScripts: 'dangerously', virtualConsole: vc,
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = function () {
        return mkCtx(bucket(this.id || '(anon)'));
      };
      w.requestAnimationFrame = cb => { rafQueue.push(cb); return rafQueue.length; };
      w.cancelAnimationFrame = noop;
      w.scrollTo = noop;
      w.fetch = (u, o) => {
        const url = String(u);
        let body = null; if (o && o.body) { try { body = JSON.parse(o.body); } catch (e) {} }
        const rec = { url, body };
        fetchLog.push(rec);
        const real = nodeFetch(new URL(url, BASE).href, o);
        if (!url.includes('/api/lagrange')) return real;
        return real.then(r => r.json().then(j => {
          const g = opts.forge ? opts.forge(body, j) : undefined;
          rec.echo = (g === undefined ? j : g);
          return { ok: r.ok, status: r.status, json: async () => rec.echo };
        }));
      };
    }
  });
  const w = dom.window, d = w.document;
  let t = 0;
  const step = (k = 1, dt = 16) => { for (let i = 0; i < k; i++) { const cb = rafQueue.shift(); if (cb) cb(1000 + (t += dt)); } };
  const $ = id => d.getElementById(id);
  const fire = (el, ty) => el.dispatchEvent(new w.Event(ty, { bubbles: true }));
  const settle = async (ms = 500) => { await sleep(ms); step(2); await sleep(30); };
  return { w, d, $, fire, step, settle, fetchLog, errs, drawn,
           lg: () => fetchLog.filter(f => f.url.includes('/api/lagrange')),
           lgCount: () => fetchLog.filter(f => f.url.includes('/api/lagrange')).length,
           lastLg: () => (fetchLog.filter(f => f.url.includes('/api/lagrange')).slice(-1)[0] || {}).echo,
           close: () => dom.window.close() };
}

(async () => {
  const health = await (await nodeFetch(BASE + '/api/health')).json();
  ok(health.exists && health.exec, '前置：8765 上内核可执行');

  // ---------- 1. 画布与无障碍 ----------
  const p = await open();
  await p.settle(3000);
  // 页面没跑起来的话下面会整片变红，而那是判据环境的问题不是功能的问题 ——
  // 所以先钉住这一条，让人一眼看出红在哪一层。
  ok(p.fetchLog.filter(f => f.url.includes('/api/nbody')).length > 0,
     `页面真的跑起来了（发出 ${p.fetchLog.filter(f => f.url.includes('/api/nbody')).length} 次 /api/nbody）`
     + ' —— 下面若整片红，看这一条');
  const cv = p.$('anchorv');
  ok(!!cv, '存在 #anchorv 画布（引力锚点战略图，契约 §4.4）');
  ok(cv && cv.tagName === 'CANVAS', '#anchorv 真的是 <canvas>');
  ok(cv && cv.getAttribute('role') === 'img',
     'aria 硬约束（AGENTS.md §0.4）：#anchorv 有 role="img"（实际 ' + JSON.stringify(cv && cv.getAttribute('role')) + '）');
  {
    const label = cv ? (cv.getAttribute('aria-label') || '').trim() : '';
    ok(label.length > 0, '#anchorv 的 aria-label 非空（读屏用户至少知道这里是什么）');
    // aria-label 应当说清画的是什么、有什么可点
    ok(/拉格朗日|锚点|引力|L1|平衡点/.test(label),
       'aria-label 说清了内容（拉格朗日点 / 引力锚点），不是"画布"两个字：' + JSON.stringify(label));
    // 负样本：换成空标签，同一处判不通过
    ok(!(/拉格朗日|锚点|引力|L1|平衡点/.test('画布')),
       '负样本：aria-label 换成「画布」，同一处判不通过');
  }

  // ---------- 2. 数据必须来自 /api/lagrange ----------
  const nlg = p.lgCount();
  ok(nlg > 0, `页面真的请求了 /api/lagrange（${nlg} 次）—— 五个点不许由页面自己编`);
  const req = p.lg()[0];
  ok(!!req && !!req.body, '请求带了 JSON body（不是空 POST）');
  {
    const b = (req && req.body) || {};
    const hasNames = typeof b.primary === 'string' && typeof b.secondary === 'string';
    ok(hasNames, `body 里点名了主星与伴星：primary=${JSON.stringify(b.primary)} secondary=${JSON.stringify(b.secondary)}`);
  }
  const echo = p.lastLg();
  ok(!!echo && echo.status === 'ok',
     `拿到 /api/lagrange 的成功回执（status=${echo && echo.status}）—— 404 的错误 JSON 不算回执`);
  const pts = (echo && echo.points) || [];
  ok(pts.length === 5, `回执里 points 恒为 5 条（实际 ${pts.length}）`);
  ok(JSON.stringify(pts.map(x => x.key)) === JSON.stringify(keys),
     '顺序逐字是 L1,L2,L3,L4,L5：' + JSON.stringify(pts.map(x => x.key)));
  ok(pts.length > 0 && pts.every(x => Array.isArray(x.pos_au) && x.pos_au.length === 3
                     && x.pos_au.every(v => typeof v === 'number' && isFinite(v))),
     `每个点都有 3 个有限的 pos_au 分量（页面按坐标画，没有坐标就画不出来），共 ${pts.length} 个`);
  ok(typeof (echo && echo.routh_limit) === 'number',
     `回执给出 Routh 判据阈值 routh_limit=${echo && echo.routh_limit}（文案要说条件，得有这个数）`);
  ok(echo && echo.collinear_stable === false,
     '回执如实说共线点（L1/L2/L3）不稳定：collinear_stable=' + (echo && echo.collinear_stable));

  // ---------- 3. 画布上真的画了 ----------
  // 判据不能只信回执：五个坐标摆在 JSON 里，页面完全可以一张都不画。
  // 只看 #anchorv 自己的桶 —— 主画面 #view 每帧几百个 arc，混进来这条就废了。
  {
    const b = p.drawn.anchorv || { text: [], dots: [] };
    b.text.length = 0; b.dots.length = 0;
    p.step(1); await sleep(200); p.step(1); await sleep(100);
    const named = keys.filter(k => b.text.some(t => t.indexOf(k) >= 0));
    ok(!!p.drawn.anchorv, '#anchorv 真的被绘制过（getContext 被调用、留下记账桶）');
    ok(b.dots.length >= 5 || named.length >= 5,
       `#anchorv 上落了点（arc ${b.dots.length} 个 / 标签命中 ${JSON.stringify(named)}）—— 不能只有一张空图`);
    // 两种画法都接受：不标字但画满 5 个标记，或者五个标识都标出来。
    // 但"什么都没画"不算通过 —— 这条要在画布为空时判红。
    ok((b.text.length === 0 && b.dots.length >= 5) || named.length === 5,
       `#anchorv 上的点标识：${JSON.stringify(named)}（要么五个标识齐全，要么不标字但画满 5 个标记）`);
  }

  // ---------- 4. 文案不得夸大稳定性 ----------
  {
    // 限定在 #anchorv 所在的那张卡片里：整页正文里到处是"条件/判据"两个字，
    // 拿整页当证据等于没判。
    const scope = cv ? ((cv.closest('section, .card, .cardbox, fieldset') || cv.parentElement) || p.d.body)
                     : null;
    const t = scope ? (scope.textContent || '').replace(/\s+/g, ' ') : '';
    ok(!!scope, '锚点区有自己的卡片容器（文案判据有明确的取证范围）');
    const conditional = (s) => /(条件|前提|满足.{0,12}才|不一定|并非绝对|不是绝对|只要|要看|Routh|劳斯|判据)/.test(s);
    ok(t.length > 0 && conditional(t),
       '锚点区的稳定性说明里出现条件性措辞（"条件/满足…才/不一定/Routh 判据"），而不是无条件保证：'
       + JSON.stringify(t.slice(0, 100)));
    ok(t.length > 0 && /L1/.test(t) && /(不稳定|恒不稳定|永远不稳定)/.test(t),
       '并且明说 L1/L2/L3 不稳定');
    // L4/L5 不得被说成绝对安全
    const overclaim = /(L4|L5)[^。；\n]{0,24}(绝对安全|绝对稳定|永远稳定|永久稳定|必定稳定|一定稳定|完全稳定|无条件稳定)/;
    // 取证范围为空时不能判"通过"—— 没文案不等于没夸大。
    ok(t.length > 0 && !overclaim.test(t),
       `没有把 L4/L5 说成绝对/永远/必定稳定（取证 ${t.length} 字，命中：`
       + JSON.stringify((t.match(overclaim) || ['(无)'])[0]) + '）');
    // 负样本：把夸大文案塞回去，同一处判不通过
    const sample = 'L4/L5 三角点绝对稳定，是安全区。' + t;
    ok(overclaim.test(sample), '负样本：塞进"绝对稳定"后夸大检查会命中（自证不是恒真）');
    ok(!conditional('L4 绝对稳定。'), '负样本：无条件文案不含条件性措辞');
    const saysCollinearUnstable = s => /L1/.test(s) && /(不稳定)/.test(s);
    ok(!saysCollinearUnstable('L1 到 L3 都很稳定，是安全的引力位。'),
       '负样本：说 L1 稳定的那份文案通不过"明说不稳定"（自证不是恒真）');
  }

  // ---------- 5. 点数必须跟着回执走（伪造一份只有 3 个点的回执） ----------
  p.close();
  {
    const three = (_b, j) => {
      if (!j || !Array.isArray(j.points)) return undefined;
      const c = JSON.parse(JSON.stringify(j));
      c.points = c.points.slice(0, 3);      // 只留 L1..L3
      return c;
    };
    const r = await open({ forge: three });
    await r.settle(3000);
    const e2 = r.lastLg();
    const e2n = e2 && Array.isArray(e2.points) ? e2.points.length : null;
    ok(e2n === 3,
       `伪造回执只给了 3 个点（页面拿到 ${e2n} 个）—— 判据自身前置成立`);
    const b2 = r.drawn.anchorv || { text: [], dots: [] };
    b2.text.length = 0; b2.dots.length = 0;
    r.step(1); await sleep(200); r.step(1); await sleep(100);
    const named2 = keys.filter(k => b2.text.some(t => t.indexOf(k) >= 0));
    const drawnCount = Math.max(b2.dots.length, named2.length);
    ok(e2n === 3 && drawnCount < 5,
       `回执只剩 3 个点时，#anchorv 上最多画出 3 个（实测 ${drawnCount}，标签 ${JSON.stringify(named2)}）`
       + ' —— 页面画的是回执里的点，不是自己编的五个');
    ok(r.errs.length === 0, '伪造回执路径无脚本异常' + (r.errs.length ? ' — ' + r.errs[0] : ''));
    r.close();
  }

  // ---------- 6. 不许另起计算通路 ----------
  {
    const s = await open();
    await s.settle(2500);
    const urls = [...new Set(s.fetchLog.map(f => f.url))];
    ok(urls.filter(u => /\/api\//.test(u)).every(u => /\/api\/(nbody|health|dataset|lagrange)/.test(u)),
       '锚点区只用既有 API（含 lagrange），没有新开的旁路：' + JSON.stringify(urls));
    ok(s.errs.length === 0, '默认路径无脚本异常' + (s.errs.length ? ' — ' + s.errs[0] : ''));
    s.close();
  }

  fs.writeFileSync(path.join(__dirname, '_probe_anchors.txt'),
    L.join('\n') + '\n\n[anchors] n=' + n + ' fail=' + fail + '\n', 'utf8');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  L.push('  FAIL  探针自身异常：' + (e && e.stack || e));
  fs.writeFileSync(path.join(__dirname, '_probe_anchors.txt'),
    L.join('\n') + '\n\n[anchors] n=' + n + ' fail=' + (fail + 1) + '\n', 'utf8');
  process.exit(1);
});
