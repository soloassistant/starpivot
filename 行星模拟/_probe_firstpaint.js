// 首屏那 3.1 秒到底花在哪：内核 / 传输 / JSON.parse / 首帧渲染。
// 分开量，才决定"要不要做渐进加载"值不值。
const R = require('./_runner');   // 起不了子进程时用录制回放（见 _runner.js）
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:8765';
const EXE = path.join(__dirname, 'starpivot', 'build', 'bin', 'starpivot.exe');
const out = [];
const nodeFetch = globalThis.fetch;
// 回放时"内核自己花多久"用的是录制里记下的真实耗时，不是此刻的墙钟。
// 必须标出来 —— 否则读这份报告的人会以为这是刚刚测的，那是谎报。
const TAG = R.replaying() ? '[回放录制，第 1 项耗时取自录制时] ' : '';

(async () => {
  // 1) 内核自己花多久（不经过网络）
  for (const s of [400, 2000]) {
    const t0 = Date.now();
    const r = R.spawn(EXE, ['nbody', '--scenario', 'solar', '--years', '50', '--samples', String(s)],
                      { maxBuffer: 256 * 1024 * 1024 });
    const ms = (r.ms !== undefined && r.ms !== null) ? r.ms : (Date.now() - t0);
    out.push(TAG + `内核 --samples ${s}: ${ms} ms，stdout ${((r.stdout || '').length / 1048576).toFixed(2)} MB`);
  }
  // 2) 经过网关（含 subprocess + 捕获 + HTTP）
  for (const s of [400, 2000]) {
    const t0 = Date.now();
    const r = await nodeFetch(BASE + '/api/nbody', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'solar', years: 50, samples: s }) });
    const txt = await r.text();
    const tNet = Date.now() - t0;
    const t1 = Date.now();
    const js = JSON.parse(txt);
    const tParse = Date.now() - t1;
    out.push(`经网关 --samples ${s}: 共 ${tNet} ms（其中 JSON.parse ${tParse} ms），`
      + `响应 ${(txt.length / 1048576).toFixed(2)} MB，帧 ${js.frames.length}`);
  }
  // 3) 页面里的真实分段：用 PerformanceObserver 拿不到，就手测 fetch+parse+首次渲染
  const { JSDOM, VirtualConsole } = require('jsdom');
  const noop = () => {};
  const ctxStub = new Proxy({}, { get: (t, k) =>
    (k === 'createRadialGradient' || k === 'createLinearGradient') ? () => ({ addColorStop: noop })
    : (k === 'measureText' ? () => ({ width: 10 }) : noop), set: () => true });
  const vc = new VirtualConsole();
  vc.on('jsdomError', noop);
  const marks = {};
  const rafQueue = [];
  const dom = new JSDOM(await (await nodeFetch(BASE + '/universe.html')).text(), {
    url: BASE + '/universe.html', runScripts: 'dangerously', virtualConsole: vc,
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = () => ctxStub;
      w.requestAnimationFrame = cb => { rafQueue.push(cb); return rafQueue.length; };
      w.cancelAnimationFrame = noop;
      w.fetch = async (u, o) => {
        const t0 = Date.now();
        const r = await nodeFetch(new URL(String(u), BASE).href, o);
        marks.req = Date.now() - t0;                 // 网络+内核
        const txt = await r.text();
        marks.bodyRead = Date.now() - t0;
        return new Response(txt, { status: r.status, headers: { 'Content-Type': 'application/json' } });
      };
    }
  });
  const w = dom.window;
  const t0 = Date.now();
  await new Promise(res => {
    const iv = setInterval(() => {
      const d = w.document;
      if (d.getElementById('legend').textContent) { clearInterval(iv); res(); }
      if (Date.now() - t0 > 30000) { clearInterval(iv); res(); }
    }, 20);
  });
  const tData = Date.now() - t0;
  // 首帧：手动推一次 rAF
  const t1 = Date.now();
  const cb = rafQueue.shift(); if (cb) cb(1000);
  const tRender = Date.now() - t1;
  out.push(`页面实测：fetch+内核+读体 ${marks.req}→${marks.bodyRead} ms；`
    + `从加载到 legend 有内容 ${tData} ms；首帧 render ${tRender} ms`);
  out.push('结论要看那个差值：如果"网络+内核"远小于总时间，说明时间花在 JSON.parse 与首帧绘制上，'
    + '渐进加载（先低帧数再补高帧数）才有意义。');
  fs.writeFileSync(path.join(__dirname, '_probe_firstpaint.txt'), out.join('\n') + '\n', 'utf8');
  process.exit(0);
})();
