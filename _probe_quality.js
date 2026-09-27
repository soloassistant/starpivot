// 画质相关的判据：
//   1) 默认帧数与内核标定一致，页面把"每圈几个采样点"如实显示出来
//   2) "改成推荐值"按钮真的把年数/帧数改掉并重算，画质读数随之变好
//   3) 帧间插值真的生效 —— 用"记录 canvas 的 arc 调用"来直接观测绘制坐标，
//      而不是靠读代码猜（jsdom 不渲染像素，但调用参数是真实的）
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
function makeCtx(arcs) {
  return new Proxy({}, {
    get: (t, k) => {
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop: noop });
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'arc') return (x, y, r) => { arcs.push([x, y, r]); };
      return noop;
    },
    set: () => true
  });
}
async function open() {
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', e => errs.push(String(e && e.message)));
  vc.on('jsdomError', noop);
  const rafQueue = [], fetchLog = [], arcs = [];
  const dom = new JSDOM(await (await nodeFetch(BASE + '/universe.html')).text(), {
    url: BASE + '/universe.html', runScripts: 'dangerously', virtualConsole: vc,
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = () => makeCtx(arcs);
      w.requestAnimationFrame = cb => { rafQueue.push(cb); return rafQueue.length; };
      w.cancelAnimationFrame = noop;
      w.fetch = (u, o) => {
        const url = String(u);
        let body = null;
        if (o && o.body) { try { body = JSON.parse(o.body); } catch (e) {} }
        fetchLog.push({ url, body });
        return nodeFetch(new URL(url, BASE).href, o);
      };
    }
  });
  const w = dom.window, d = w.document;
  let t = 0;
  const step = (k = 1, dt = 16) => { for (let i = 0; i < k; i++) { const cb = rafQueue.shift(); if (cb) cb(1000 + (t += dt)); } };
  const $ = id => d.getElementById(id);
  const fire = (el, ty) => el.dispatchEvent(new w.Event(ty, { bubbles: true }));
  const settle = async (ms = 500) => { await sleep(ms); step(2); await sleep(30); };
  return { w, d, $, fire, step, settle, fetchLog, errs, arcs,
           kc: () => fetchLog.filter(f => f.url.includes('/api/nbody')).length,
           close: () => dom.window.close() };
}

(async () => {
  const t0 = Date.now();
  const p = await open();
  await p.settle(2500);
  ok(p.errs.length === 0, '首次加载无脚本异常' + (p.errs.length ? ' — ' + p.errs[0] : ''));
  ok(p.$('samples').value === '2000',
     `默认输出帧数 = ${p.$('samples').value}（从 400 提到页面上限：50 年/400 帧时水星一圈只有 2 个采样点）`);

  const body = p.fetchLog.find(f => f.url.includes('/api/nbody')).body;
  ok(body.samples === 2000, `发给内核的 samples = ${body.samples}`);
  const respBytes = Date.now() - t0;

  const q = p.$('qrow').textContent;
  ok(/每圈/.test(q) && /采样点/.test(q), '画质读数是内核给的"每圈采样点数"：' + q.slice(0, 60));
  const m = q.match(/每圈\s*([\d.]+)\s*个采样点/);
  ok(!!m, '能解析出点数：' + (m && m[1]));
  const before = m ? +m[1] : 0;
  ok(Math.abs(before - 0.24085 * 2000 / 50) < 0.1,
     `50 年 / 2000 帧下最内圈（水星）= ${before} 点/圈，与内核标定一致`);
  ok(!!p.$('qfix'), '点数远低于目标时，页面给出「改成 N 年 / M 帧」的一键建议');

  // ---- 一键改成推荐值 ----
  const n0 = p.kc();
  if (p.$('qfix')) {
    const label = p.$('qfix').textContent;
    p.fire(p.$('qfix'), 'click');
    await p.settle(3500);
    ok(p.kc() > n0, '点建议按钮后真的重算了一次（' + label + '）');
    ok(p.$('years').value === '16', `年数被改成 ${p.$('years').value}（内核建议的年数）`);
    ok(p.$('samples').value === '2000', `帧数保持 ${p.$('samples').value}`);
    const m2 = p.$('qrow').textContent.match(/每圈\s*([\d.]+)\s*个采样点/);
    const after = m2 ? +m2[1] : 0;
    ok(after > before * 2.5, `画质读数从 ${before.toFixed(1)} 提升到 ${after.toFixed(1)} 点/圈`);
    ok(after >= 24, `提升后达到"够用"档（>= 24）：${after.toFixed(1)}`);
    ok(!p.$('qfix'), '达到够用线后建议按钮自动消失（否则它会永远赖在页面上点不掉）');
  } else { ok(false, '找不到建议按钮，后面的判据跳过'); }

  // ---- 帧间插值：直接观测画出来的坐标 ----
  ok(p.$('interp') && p.$('interp').checked, '帧间插值默认开启');
  // 让 frameF 落在两帧之间：播放几帧再暂停
  if (p.$('play').textContent.indexOf('播放') >= 0) { p.fire(p.$('play'), 'click'); await p.settle(200); }
  for (let i = 0; i < 4; i++) { p.step(1, 37); await sleep(20); }   // 37ms×40fps → 小数帧
  p.fire(p.$('play'), 'click'); await p.settle(200);               // 暂停，frameF 保留小数
  const scrubPos = +p.$('scrub').value;

  p.arcs.length = 0; p.step(1); await sleep(20);
  const withInterp = p.arcs.slice();
  p.$('interp').checked = false; p.fire(p.$('interp'), 'change');
  p.arcs.length = 0; p.step(1); await sleep(20);
  const noInterp = p.arcs.slice();
  ok(withInterp.length > 0 && withInterp.length === noInterp.length,
     `两种模式下弧的条数一致（${withInterp.length} 条），说明是同一批天体在画`);
  const diff = withInterp.filter((a, i) => {
    const b = noInterp[i];
    return b && (Math.abs(a[0] - b[0]) > 1e-6 || Math.abs(a[1] - b[1]) > 1e-6);
  }).length;
  ok(diff > 0, `关掉插值后绘制坐标确实变了（${diff} 处不同）→ 插值真的作用在绘制上，不是摆设`);
  // 关掉插值时，坐标应当恰好落在整数帧的采样点上
  p.$('interp').checked = true; p.fire(p.$('interp'), 'change');

  ok(p.$('qrow').textContent.indexOf('vis-viva') >= 0,
     '页面写明了标定的出处（vis-viva）——玩家知道这个数不是页面编的');
  ok(/帧间插值/.test(p.d.body.textContent), '页面上说明了"帧间插值"这个例外的性质');
  ok(p.errs.length === 0, '全程无脚本异常' + (p.errs.length ? ' — ' + p.errs[0] : ''));
  L.push(`  [info] 首次加载含 2000 帧响应共 ${respBytes} ms`);
  p.close();

  fs.writeFileSync(path.join(__dirname, '_probe_quality.txt'),
    L.join('\n') + '\n\n[quality] n=' + n + ' fail=' + fail + '\n', 'utf8');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  L.push('  FAIL  探针自身异常：' + (e && e.stack || e));
  fs.writeFileSync(path.join(__dirname, '_probe_quality.txt'),
    L.join('\n') + '\n\n[quality] n=' + n + ' fail=' + (fail + 1) + '\n', 'utf8');
  process.exit(1);
});
