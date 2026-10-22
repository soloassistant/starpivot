// 临时诊断：把页面按 _probe_dualmode.js 的方式加载，把**页面自己抛的错**打出来。
// 探针的结果文件只记 FAIL，不记页面异常 —— 所以先单独把异常抓出来。
const { JSDOM, VirtualConsole } = require('jsdom');
const noop = () => {};
const BASE = 'http://127.0.0.1:8765';
const ctxStub = new Proxy({}, { get: (t, k) =>
  (k === 'createRadialGradient' || k === 'createLinearGradient') ? () => ({ addColorStop: noop })
  : (k === 'measureText' ? () => ({ width: 10 })
     : (k === 'fillText' ? () => {} : noop)), set: () => true });

(async () => {
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', e => errs.push('[jsdomError] ' + (e && e.message) + '\n    ' + ((e && e.stack) || '').split('\n').slice(0, 4).join('\n    ')));
  vc.on('console', m => { if (m.type() === 'error' || m.type() === 'warn') errs.push('[' + m.type() + '] ' + m.text()); });
  const rafQueue = [];
  let html;
  try {
    html = require('fs').readFileSync('starpivot/viewer/universe.html', 'utf8');
  } catch (e) { console.log('读不到页面:', e.message); return; }
  const dom = new JSDOM(html, {
    url: BASE + '/universe.html', runScripts: 'dangerously', virtualConsole: vc,
    pretendToBeVisual: true,
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = () => ctxStub;
      w.requestAnimationFrame = cb => { rafQueue.push(cb); return rafQueue.length; };
      w.cancelAnimationFrame = noop;
      w.fetch = () => new Promise(() => {});   // 不发网络请求，只看初始化
    },
  });
  // 手动推几帧，看 render() 会不会抛
  let thrown = null;
  for (let i = 0; i < 8 && rafQueue.length; i++) {
    const cb = rafQueue.shift();
    try { cb(performance.now()); } catch (e) { thrown = e; break; }
  }
  console.log('=== 页面抛出的异常 ===');
  console.log(thrown ? (thrown.stack || thrown.message) : '（推帧时没抛）');
  console.log('');
  console.log('=== jsdom / console 报告 ===');
  console.log(errs.length ? errs.join('\n') : '（无）');
  console.log('');
  const pal = dom.window.document.querySelectorAll('#palette button').length;
  console.log('调色板按钮数:', pal);
})();
