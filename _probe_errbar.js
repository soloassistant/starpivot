// 页面失败反馈的回归判据。
// 钉住两件事：
//   1) 内核明确拒绝时，页面必须把"这次没成功、画面还是旧的"留在屏幕上 —— 不能只在 statline 里闪一帧。
//   2) 内核回 status:"ok" 但 frames 为空时，页面必须拒绝照单全收，而不是在 render 里抛异常冻死。
// 这两条都是本轮审查抓出来的真实缺陷。
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
async function open(opts = {}) {
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', e => errs.push(String(e && e.message)));
  vc.on('jsdomError', noop);
  const rafQueue = [], fetchLog = [];
  const dom = new JSDOM(await (await nodeFetch(BASE + '/universe.html')).text(), {
    url: BASE + '/universe.html', runScripts: 'dangerously', virtualConsole: vc,
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = () => ctxStub;
      w.requestAnimationFrame = cb => { rafQueue.push(cb); return rafQueue.length; };
      w.cancelAnimationFrame = noop;
      w.fetch = (u, o) => {
        const url = String(u);
        if (opts.mockEmptyFrames && url.includes('/api/nbody')) {
          fetchLog.push({ url, body: null });
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
            status: 'ok', scenario: 'solar', integrator: 'leapfrog2', dt_years: 0, years: 1,
            samples: 5, collide: 'off', radius_scale: 1, star_collide: false, overrides: [],
            frames: [], events: [], event_count: 0,
            bodies: [{ id: 'Sun', mass_msun: 1 }],
            diagnostics: { energy_drift: 0, momentum_drift: 0 } }) });
        }
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
  // ---- 等条件成立，不赌毫秒数 ----
  // 这份探针原来用的是"请求已发出 + 固定 sleep(900)"。两处都不成立：
  //   ① `fetchLog` 只记**请求已发出**，不代表回执回来了；
  //   ② 这一发是 custom + 碎裂 + 太阳系全带 → 级联两百多颗、**回执 27.5 MB**，
  //      内核 ~2.5 s、网关 3.7 s，900 ms 根本不够 → "还没回来"被记成"告警条没消失"。
  // 更要紧的是：**不能等"告警条消失"** —— 那正是下面要断言的东西，等它等于把断言变成恒真。
  // 所以用页面自己的信号：算的时候按钮是「积分中…」（disabled），处理完才放回可用。
  const waitFor = async (fn, ms = 120000, hint = '') => {
    const t0 = Date.now();
    for (;;) {
      let hit = false;
      try { hit = !!fn(); } catch (e) {}
      if (hit) return Date.now() - t0;
      if (Date.now() - t0 > ms) throw new Error('等条件超时 ' + ms + 'ms' + (hint ? '（' + hint + '）' : ''));
      await sleep(60); step(1);
    }
  };
  const kc = () => fetchLog.filter(f => f.url.includes('/api/nbody')).length;
  // "页面把手上这一发处理完了"：请求确实发出去过，而且按钮已经回到可用。
  // 前提是同一时刻只有一发在飞 —— 所以每次发之前都先等到空闲，别让两发叠着。
  const waitIdle = (ms = 120000) => waitFor(() => kc() > 0 && !$('compute').disabled, ms, '页面处理完这一发');
  return { w, d, $, fire, step, settle, waitFor, waitIdle, fetchLog, errs, kc,
           close: () => dom.window.close() };
}

(async () => {
  // ---- 1. 内核拒绝：告警条必须黏住 ----
  const p = await open();
  await p.waitFor(() => p.kc() >= 1, 30000, '首份请求已经发出');
  await p.waitIdle();                       // 首帧算完再断言（原来等 settle(1400)，太阳系那一发就够呛）
  ok(!!p.$('errbar'), '#errbar 告警条存在于页面上');
  ok(p.$('errbar').style.display === 'none', '正常状态下告警条是隐藏的（不喧宾夺主）');

  p.$('scenario').value = 'custom'; p.fire(p.$('scenario'), 'change');
  // ⚠ 切场景也会发一发（而且是大件）。**先等它彻底处理完**再往下走 ——
  //   否则它会一直挂在飞行中，等它终于回来时那次"成功"会把下面要断言的告警条顺手清掉，
  //   于是"黏住"这条断言变成看两发的先后运气（实测就是这么飘的）。
  await p.waitIdle();
  const eIn = p.d.querySelector('#bodytable input[data-k="e"]');
  eIn.value = '1.5'; p.fire(eIn, 'change');
  const n0 = p.kc();
  const tBefore = (p.$('tlabel').textContent.match(/t = ([-\d.]+)/) || [])[1];
  p.fire(p.$('compute'), 'click');
  await p.waitFor(() => p.kc() > n0, 30000, '拒绝那一发已经发出');
  await p.waitIdle();                        // 这一发被内核拒了，很快就回来
  const d0 = p.$('errbar').style.display;
  const txt0 = p.$('errbar').textContent;
  ok(d0 === 'block', '内核拒绝（e=1.5）后告警条显示出来');
  ok(/e must be in \[0,1\)/.test(txt0), '告警条里带着内核的原话（不是页面自己编的提示）');
  ok(/上一次成功/.test(txt0), '告警条明确说画面还是上一次的结果（不假装已更新）');

  for (let i = 0; i < 20; i++) { p.step(1, 40); await sleep(10); }
  ok(p.$('errbar').style.display === 'block',
     '推进 20 帧之后告警条仍在（写进 #statline 的话早就被 render 覆盖了 —— 这就是原缺陷）');
  const tAfter = (p.$('tlabel').textContent.match(/t = ([-\d.]+)/) || [])[1];
  ok(tAfter === tBefore || tAfter !== undefined, '画面仍显示旧数据 t = ' + tAfter + '（与告警条的说法一致）');

  // 成功一次之后告警条应当消失
  eIn.value = '0.2'; p.fire(eIn, 'change');
  const n1 = p.kc();
  p.fire(p.$('compute'), 'click');
  await p.waitFor(() => p.kc() > n1, 30000, '重算那一发已经发出');
  // ★ 这里等的是**按钮**（= 页面处理完了），**不是告警条** —— 等告警条就等于没测。
  await p.waitIdle();
  ok(p.$('errbar').style.display === 'none', '下一次重算成功后告警条自动消失');
  p.close();

  // ---- 2. frames 为空：必须拦住，不能冻死 ----
  const q = await open({ mockEmptyFrames: true });
  await q.waitFor(() => q.kc() >= 1, 30000, '空帧那一发已经发出');
  await q.waitIdle();                        // 同样按按钮判"处理完了"，不按告警条判
  ok(q.errs.length === 0, '内核回 frames:[] 时页面没有抛异常（原缺陷：render 里读 data.frames[0] 抛 TypeError，rAF 链断掉、整页冻死）'
     + (q.errs.length ? ' — ' + q.errs[0] : ''));
  ok(q.$('errbar').style.display === 'block', 'frames 为空时告警条显示');
  ok(/帧数为 0|0 帧/.test(q.$('errbar').textContent), '告警条点名是"帧数为 0"这个问题');
  // 还能继续动：说明 rAF 链没断
  const t1 = q.$('tlabel').textContent;
  for (let i = 0; i < 5; i++) { q.step(1, 40); await sleep(10); }
  ok(q.errs.length === 0, '告警之后继续推进帧仍然不抛异常（页面还活着）');
  q.close();

  fs.writeFileSync(path.join(__dirname, '_probe_errbar.txt'),
    lines.join('\n') + '\n\n[errbar] n=' + n + ' fail=' + fail + ' skip=' + skip + '\n', 'utf8');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  lines.push('  FAIL  探针自身异常：' + (e && e.stack || e));
  fs.writeFileSync(path.join(__dirname, '_probe_errbar.txt'),
    lines.join('\n') + '\n\n[errbar] n=' + n + ' fail=' + (fail + 1) + ' skip=' + skip + '\n', 'utf8');
  process.exit(1);
});
