// 并发重算的序号守卫（2026-10-12 新增）。
//
// 钉住一件事：`compute()` 里**先发后返回的旧结果不许覆盖新结果**。
// 为什么需要：按钮 disabled 只挡得住"点按钮重复发"，而首页装载、切场景/太阳系档位、
// 进放置模式、时长「永久」延长这几条路径都是**直接调 compute()**，不经过按钮 ——
// 两发并发时，后**返回**的那一发会覆盖先发的，页面显示**上一组参数**的结果，
// 而且界面上没有任何可见异常（按钮会从"积分中"变回可用，看起来一切正常）。
// 这不是假想：tools 探针 2026-10-09 那次"反解出的 a 时好时坏"就是它的一个实例。
//
// ⚠ 本探针**自带负对照**：同一套测法会在"把守卫就地变异掉"的同一份页面上再跑一遍，
//   那一遍必须**复现**竞态。只测修复后的版本等于恒真 —— 测法本身可能根本测不到竞态。
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const BASE = 'http://localhost:8765';
const nodeFetch = globalThis.fetch;
let n = 0, fail = 0, skip = 0;
const lines = [];
const ok = (c, m) => { n++; lines.push((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const noop = () => {};
const ctxStub = new Proxy({}, {
  get: (t, k) => (k === 'createRadialGradient' || k === 'createLinearGradient')
    ? () => ({ addColorStop: noop }) : (k === 'measureText' ? () => ({ width: 10 }) : noop),
  set: () => true
});

// 跑一轮竞态：连发两发重算（A: samples=400，B: samples=2000），
// 并**在网络上把先发的 A 拖后 2.5 s** —— 于是 A 后返回，正好是守卫要挡的场景。
// 观测点用页面自己的 #tlabel（它写着「帧 i/data.frames.length」）：
//   屏幕上留下 2001 帧 = 最新那一发（B）；留下 401 帧 = 被先发后到的 A 覆盖了。
// drop=true 时把守卫表达式就地变异掉（`mySeq !== computeSeq`→`false`、`===`→`true`）。
async function race(drop){
  const raw = await (await nodeFetch(BASE + '/universe.html')).text();
  const guardHits = (raw.match(/mySeq [!=]== computeSeq/g) || []).length;   // 只统计，不改
  const html = drop
    ? raw.replace(/mySeq !== computeSeq/g, 'false').replace(/mySeq === computeSeq/g, 'true')
    : raw;

  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', e => errs.push(String(e && e.message)));
  const rafQueue = [], arrivals = [];
  let armed = false;                       // 只拖"我们制造的那一发"，不拖首屏
  const dom = new JSDOM(html, {
    url: BASE + '/universe.html', runScripts: 'dangerously', virtualConsole: vc,
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = () => ctxStub;
      w.requestAnimationFrame = cb => { rafQueue.push(cb); return rafQueue.length; };
      w.cancelAnimationFrame = noop;
      w.fetch = (u, o) => {
        const url = String(u), isN = url.includes('/api/nbody');
        let body = null; if (o && o.body) { try { body = JSON.parse(o.body); } catch (e) {} }
        const slow = isN && armed && body && body.samples === 400;
        return nodeFetch(new URL(url, BASE).href, o).then(r => r.text().then(txt => {
          const mk = () => new Response(txt, { status: r.status,
            headers: { 'content-type': 'application/json' } });
          return slow ? new Promise(res => setTimeout(() => res(mk()), 2500)) : mk();
        })).then(r => {
          if (isN) r.clone().json().then(j => arrivals.push(body && body.samples)).catch(noop);
          return r;
        });
      };
    }
  });
  const w = dom.window, d = w.document;
  let t = 0;
  const step = (k = 1) => { for (let i = 0; i < k; i++) { const cb = rafQueue.shift(); if (cb) cb(1000 + (t += 16)); } };
  const $ = id => d.getElementById(id);
  const fire = (el, ty) => el.dispatchEvent(new w.Event(ty, { bubbles: true }));
  const cvEl = d.getElementById('view');
  Object.defineProperty(cvEl, 'width', { value: 800, writable: true });
  Object.defineProperty(cvEl, 'height', { value: 600, writable: true });
  cvEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  cvEl.setPointerCapture = () => {}; cvEl.releasePointerCapture = () => {};
  const waitFor = async (fn, ms, hint) => {
    const t0 = Date.now();
    for (;;) {
      let hit = false; try { hit = !!fn(); } catch (e) {}
      if (hit) return;
      if (Date.now() - t0 > ms) throw new Error('等条件超时 ' + ms + 'ms（' + hint + '）');
      await sleep(60); step(1);
    }
  };
  try {
    // 首屏那一发先落地 —— 别把它和被测的两发混在一起
    await waitFor(() => arrivals.length >= 1 && !$('compute').disabled, 120000, '首屏落地');
    arrivals.length = 0;          // 从这里开始只记被测的那两发（首屏默认也是 samples=2000，会混淆）
    armed = true;
    $('samples').value = '400';  $('integ').value = 'hermite';  fire($('integ'), 'change');  // A：先发，被拖后
    $('samples').value = '2000'; $('integ').value = 'leapfrog'; fire($('integ'), 'change');  // B：后发，先到
    await waitFor(() => arrivals.length >= 2, 180000, '两发都到齐');
    await sleep(300); step(5);                       // 让 render() 把 #tlabel 写出来
    const tlabel = $('tlabel').textContent;
    const frames = +((tlabel.match(/\/\s*(\d+)/) || [])[1] || 0);
    return { frames, tlabel, arrivals: arrivals.join(','), errs, guardHits };
  } finally { try { w.close(); } catch (e) {} }
}

(async () => {
  lines.push('本判据自带负对照：先跑"修复后"，再把守卫就地变异掉跑一遍 ——');
  lines.push('只有"修复后通过 + 变异后复现竞态"才算这条判据真的测到了东西。');
  lines.push('');

  const fixed = await race(false);
  lines.push('  [info] 回执到达顺序 samples=' + fixed.arrivals + '（期望 2000,400：先发的被拖到后面）');
  lines.push('  [info] 修复后 #tlabel = ' + JSON.stringify(fixed.tlabel));
  ok(fixed.guardHits > 0,
     '被测页面上确实带着序号守卫（源码里出现 ' + fixed.guardHits + ' 处；为 0 说明这一轮测的不是修复后的版本）');
  ok(fixed.arrivals === '2000,400',
     '先发的那一发确实**后**返回 —— 竞态窗口真的造出来了（否则下面的断言恒真、什么也没测）');
  ok(fixed.frames === 2001,
     '屏幕上留下的是**最新那一发**的数据（帧数 ' + fixed.frames + '），先发后到的旧结果没有覆盖它');

  const ctrl = await race(true);
  lines.push('');
  lines.push('  [info] 负对照（守卫变异掉）#tlabel = ' + JSON.stringify(ctrl.tlabel));
  ok(ctrl.arrivals === '2000,400', '（负对照）回执到达顺序同样是 2000,400');
  ok(ctrl.frames === 401,
     '负对照：把守卫摘掉后，先发后到的旧结果**确实覆盖**了新结果（帧数 ' + ctrl.frames
     + '）—— 说明本判据真的测得到这个竞态，不是恒真');

  fs.writeFileSync(path.join(__dirname, '_probe_seqguard.txt'),
    lines.join('\n') + '\n\n[seqguard] n=' + n + ' fail=' + fail + ' skip=' + skip + '\n', 'utf8');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  lines.push('  FAIL  探针自身异常：' + (e && e.stack || e));
  fs.writeFileSync(path.join(__dirname, '_probe_seqguard.txt'),
    lines.join('\n') + '\n\n[seqguard] n=' + n + ' fail=' + (fail + 1) + ' skip=' + skip + '\n', 'utf8');
  process.exit(1);
});
