// 会话持久化的端到端判据（C/D 层）：
//   用 jsdom 真加载 universe.html，跑页面里那份真的脚本（不复制、不重写）；
//   fetch 打到真的 http://localhost:8765（真网关 + 真 C++ 内核），localStorage 用 jsdom 真的那份。
//   "重开页面" = 用第一次真写进 localStorage 的字节，再开一个全新的 jsdom 实例。
// 结论全部写进 _probe_session.txt（UTF-8），不依赖控制台编码。
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML_PATH = path.join(__dirname, 'starpivot', 'viewer', 'universe.html');
const HTML = fs.readFileSync(HTML_PATH, 'utf8');
const BASE = 'http://localhost:8765';
const KEY = 'starpivot.universe.session';
const nodeFetch = globalThis.fetch;

let n = 0, fail = 0, skip = 0;
const out = [];
const ok = (c, m) => { n++; out.push((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// canvas 2d 上下文桩：页面只画，绘制结果不在判据范围内，所以全是空操作。
const noop = () => {};
const ctxStub = new Proxy({}, {
  get: (t, k) => {
    if (k === 'createRadialGradient' || k === 'createLinearGradient')
      return () => ({ addColorStop: noop });
    if (k === 'measureText') return () => ({ width: 10 });
    return noop;
  },
  set: () => true
});

// 开一个"浏览器标签"。opts:
//   seed   —— 预先塞进 localStorage 的会话字节（模拟"上次退出留下的"）
//   killStorage —— 让 localStorage 取值即抛（模拟隐私模式）
async function openPage(opts = {}) {
  const vc = new VirtualConsole();
  const jsdomErrors = [];
  vc.on('jsdomError', e => jsdomErrors.push(String(e && e.message)));
  vc.on('jsdomError', () => {});          // 不往控制台喷
  const rafQueue = [];
  const fetchLog = [];

  const dom = new JSDOM(HTML, {
    url: BASE + '/universe.html',
    runScripts: 'dangerously',
    pretendToBeVisual: false,
    virtualConsole: vc,
    beforeParse(window) {
      window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
      // requestAnimationFrame 收进队列：由判据自己决定推进几帧，避免 60fps 自发跑飞
      window.requestAnimationFrame = cb => { rafQueue.push(cb); return rafQueue.length; };
      window.cancelAnimationFrame = noop;
      window.fetch = (u, o) => {
        const url = String(u);
        if (url.includes('/api/nbody')) fetchLog.push(JSON.parse(o.body));
        return nodeFetch(new URL(url, BASE).href, o);
      };
      if (opts.killStorage) {
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          get() { throw new Error('SecurityError: localStorage denied'); }
        });
      } else if (opts.seed !== undefined) {
        window.localStorage.setItem(KEY, opts.seed);
      }
    }
  });
  const w = dom.window, d = w.document;
  const step = (k = 1, dt = 16) => {
    for (let i = 0; i < k; i++) {
      const cb = rafQueue.shift();
      if (cb) cb(1000 + i * dt + step.t);
    }
    step.t += k * dt;
  };
  step.t = 0;
  const settle = async (ms = 500) => { await sleep(ms); step(1); await sleep(50); };
  const $ = id => d.getElementById(id);
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
  const set = (id, v, type = 'input') => { const el = $(id); el.value = v; fire(el, type); return el; };
  return { dom, w, d, $, fire, set, step, settle, fetchLog, jsdomErrors,
           close: () => dom.window.close() };
}

(async () => {
  // ---------------------------------------------------------------- 0. 前置
  let health;
  try { health = await (await nodeFetch(BASE + '/api/health')).json(); }
  catch (e) { out.push('  SKIP  8765 服务不可用：' + e.message); skip++; return finish(); }
  if (!health.exists) { out.push('  SKIP  内核可执行文件不存在'); skip++; return finish(); }
  // 端口上必须是本轮页面（否则下面的判据全是假的）
  const live = await (await nodeFetch(BASE + '/universe.html')).text();
  ok(live.includes('id="sessionnote"') && live.includes('restoreSession'),
     '8765 上跑的是本轮页面（端口健康检查）');

  // ---------------------------------------------------------------- 1. 首次打开
  let p = await openPage();
  await p.settle(1200);
  ok(p.jsdomErrors.length === 0, '首次加载无脚本异常' +
     (p.jsdomErrors.length ? ' — ' + p.jsdomErrors[0] : ''));
  ok(/第一次打开/.test(p.$('sessionnote').textContent),
     '首次打开：提示"第一次打开…之后每次改动都会自动保存"');
  ok(p.fetchLog.length === 1, '首次打开真的调了一次内核（不是从缓存拿结果）');
  ok(p.w.localStorage.getItem(KEY) !== null, '首次打开后已落盘一份会话快照');
  const firstPayload = p.fetchLog[0];
  ok(firstPayload.greenhouse === undefined,
     '首次打开不下发 greenhouse（让内核用默认，回显才敢写"未改动"）');
  await p.settle(300);
  ok(/未改动，用的是内核默认/.test(p.$('biolayer').textContent),
     '首次打开：分层说明如实写"未改动，用的是内核默认"（修掉了无条件下发导致的谎报）');
  p.close();

  // ---------------------------------------------------------------- 2. 改一堆东西 → 落盘
  p = await openPage();
  await p.settle(1200);

  p.set('scenario', 'custom', 'change'); await p.settle(1400);
  p.set('solarmode', 'sun', 'change');   await p.settle(1400);
  p.set('years', '12');   p.set('samples', '222');
  p.set('speed', '77');   p.set('zoom', '180');  p.set('tilt', '-30');
  p.set('collide', 'merge', 'change');
  p.set('rscale', '900');
  p.$('starcollide').checked = true; p.fire(p.$('starcollide'), 'change');
  p.set('bioyears', '250', 'change'); await p.settle(1500);
  p.set('albedo', '0.55', 'change');  await p.settle(1500);
  const gh = p.$('greenhouse'); gh.value = '120'; p.fire(gh, 'input'); p.fire(gh, 'change');
  await p.settle(1500);
  // 暂停要放在最后：改任何旋钮都会触发重算，而重算后按既有行为会自动继续播放。
  // 所以"退出时是暂停的"这一态，只有在最后一次操作是暂停时才成立。
  p.$('play').dispatchEvent(new p.w.Event('click', { bubbles: true }));
  ok(p.$('play').textContent.indexOf('播放') >= 0, '点播放键后进入暂停态');
  // 改自定义行星表的第一格（a），走的是表格里动态渲染出来的输入框
  const aIn = p.d.querySelector('#bodytable input[data-k="a"]');
  aIn.value = '2.75'; p.fire(aIn, 'change');
  // 时间轴拖到中间
  p.set('scrub', '500');
  await p.settle(400);

  const tlabelBefore = p.$('tlabel').textContent;
  const frameBefore = (tlabelBefore.match(/帧 (\d+)\//) || [])[1];
  const raw = p.w.localStorage.getItem(KEY);
  ok(raw !== null, '改动之后 localStorage 里有快照');
  const snap = JSON.parse(raw || '{}');
  ok(snap.scenario === 'custom',   '快照记下了场景 custom');
  ok(snap.solarmode === 'sun',     '快照记下了太阳系档位 sun');
  ok(snap.years === '12',          '快照记下了积分年数 12');
  ok(snap.samples === '222',       '快照记下了输出帧数 222');
  ok(snap.speed === '77',          '快照记下了播放速度 77');
  ok(snap.zoom === '180' && snap.tilt === '-30', '快照记下了缩放与俯仰');
  ok(snap.collide === 'merge' && snap.rscale === '900' && snap.starcollide === true,
     '快照记下了碰撞设置（模式/放大/恒星参与）');
  ok(snap.bioyears === '250' && snap.albedo === '0.55' && snap.greenhouse === '120',
     '快照记下了演化三旋钮');
  ok(snap.playing === false, '快照记下了"暂停"这个状态');
  ok(Array.isArray(snap.bodies) && snap.bodies[0].a === 2.75,
     '快照记下了行星表里改过的 a=2.75');
  ok(!('frames' in snap) && !('diagnostics' in snap) && !('bio' in snap),
     '快照里没有一丁点内核计算结果（只存选择，不存结果）');
  ok(snap.schema === 1 && typeof snap.saved_at === 'number', '快照带 schema 与时间戳');
  const payloadBefore = p.fetchLog[p.fetchLog.length - 1];
  p.close();

  // ---------------------------------------------------------------- 3. 重开 → 接着上一次
  p = await openPage({ seed: raw });
  await p.settle(1600);
  ok(p.jsdomErrors.length === 0, '恢复加载无脚本异常' +
     (p.jsdomErrors.length ? ' — ' + p.jsdomErrors[0] : ''));
  ok(/已接着上一次退出继续/.test(p.$('sessionnote').textContent),
     '恢复时提示"已接着上一次退出继续"');
  ok(/重新调用内核现算/.test(p.$('sessionnote').textContent),
     '恢复提示里写明了：数值是重新调用内核现算的，不是缓存');
  ok(p.fetchLog.length === 1, '恢复时真的重新调了一次内核（没有复用任何旧结果）');
  ok(p.$('scenario').value === 'custom' && p.$('solarmode').value === 'sun',
     '恢复：场景与太阳系档位回来了');
  ok(p.$('years').value === '12' && p.$('samples').value === '222',
     '恢复：积分年数与帧数回来了');
  ok(p.$('speed').value === '77' && p.$('zoom').value === '180' && p.$('tilt').value === '-30',
     '恢复：播放速度与视角回来了');
  ok(p.$('collide').value === 'merge' && p.$('rscale').value === '900'
     && p.$('starcollide').checked === true, '恢复：碰撞设置回来了');
  ok(p.$('bioyears').value === '250' && p.$('albedo').value === '0.55'
     && p.$('greenhouse').value === '120', '恢复：演化三旋钮回来了');
  ok(p.$('bodytable').querySelector('input[data-k="a"]').value === '2.75',
     '恢复：自定义行星表的 a=2.75 回来了');
  ok(p.$('play').textContent.indexOf('播放') >= 0, '恢复：退出时是暂停的，进来还是暂停');
  const frameAfter = (p.$('tlabel').textContent.match(/帧 (\d+)\//) || [])[1];
  ok(frameAfter !== undefined && Math.abs(+frameAfter - +frameBefore) <= 1,
     '恢复：时间轴接在上次的那一帧（' + frameBefore + ' → ' + frameAfter + '）');

  // 恢复后的请求必须和退出前那次完全一致 —— 证明"接着上次"是真的拿去问内核了
  const payloadAfter = p.fetchLog[0];
  const keys = ['scenario', 'solar', 'years', 'samples', 'collide', 'radius_scale',
                'star_collide', 'bio_years', 'albedo', 'greenhouse'];
  const diff = keys.filter(k => JSON.stringify(payloadBefore[k]) !== JSON.stringify(payloadAfter[k]))
    .map(k => k + ':' + JSON.stringify(payloadBefore[k]) + '→' + JSON.stringify(payloadAfter[k]));
  ok(diff.length === 0, '恢复后发给内核的请求与退出前逐字一致' + (diff.length ? ' — ' + diff.join(', ') : ''));
  ok(payloadAfter.greenhouse === 120, '恢复后 greenhouse=120 真的下发给内核了（touched 一起恢复）');
  ok(payloadAfter.bodies && payloadAfter.bodies[0].a === 2.75, '恢复后行星表真的下发给了内核');
  await p.settle(300);
  ok(/被本次请求改写/.test(p.$('biolayer').textContent),
     '恢复后：温室被改过，分层说明如实改口为"被本次请求改写"');
  p.close();

  // ---------------------------------------------------------------- 4. 版本不认 → 丢弃，不静默迁移
  p = await openPage({ seed: JSON.stringify({ schema: 999, scenario: 'figure8', years: '3' }) });
  await p.settle(1200);
  ok(/第一次打开/.test(p.$('sessionnote').textContent), 'schema 不认：按"第一次打开"处理，不静默迁移');
  ok(p.$('scenario').value === 'solar', 'schema 不认：回落到默认场景 solar，没用旧数据');
  ok(p.jsdomErrors.length === 0, 'schema 不认：没有脚本异常');
  p.close();

  // ---------------------------------------------------------------- 5. 畸形输入 → 收口，不炸
  p = await openPage({ seed: JSON.stringify({
    schema: 1, saved_at: Date.now(), scenario: 'custom', solarmode: 'none',
    years: '9', samples: '120', speed: '30', playing: true, frameF: 999999,
    bodies: [{ name: 'X"Y,Z', a: 'oops', e: null, inc: 'NaN', mass: '1e-3', radius_km: 'x' },
             { name: '', a: 3, e: 0.1, inc: 0, raan: 0, argp: 0, M0: 0, mass: 1e-5, radius_km: 3000 }],
    collide: 'fragment', rscale: '700', nfrag: '5', disp: '0.4', fmin: '2.5', starcollide: false,
    bioon: true, bioyears: '80', albedo: '0.2', greenhouse: '60', greenhouse_touched: true,
    zoom: '90', tilt: '15',
    view: { panX: 'x', panY: 12, userScale: 1e9 },
    cam: { yaw: 0.5, pitch: 99, sel: 999 }
  }) });
  await p.settle(1600);
  ok(p.jsdomErrors.length === 0, '畸形会话：没有脚本异常' +
     (p.jsdomErrors.length ? ' — ' + p.jsdomErrors[0] : ''));
  const b0 = p.$('bodytable').querySelectorAll('input[data-k]');
  const val = (k) => p.$('bodytable').querySelector('input[data-k="' + k + '"]').value;
  ok(val('a') === '1' && val('e') === '0' && val('inc') === '0',
     '畸形 a/e/inc 被收口成有限默认值（不是 NaN 直接喂给内核）');
  ok(val('mass') === '0.001' && val('radius_km') === '6371', '畸形 mass/radius 各自回退默认值');
  ok(!/["',]/.test(val('name')), '名字里的引号和逗号被清掉（否则会破坏内核的 --set 语法）');
  ok(p.$('greenhouse').value === '60', '畸形会话里的合法值仍然照常恢复');
  ok(/帧 \d+\/\d+/.test(p.$('tlabel').textContent), 'frameF=999999 被钳到最后一帧，没有越界');
  const fr = + (p.$('tlabel').textContent.match(/帧 (\d+)\/(\d+)/) || [])[1];
  const tot = + (p.$('tlabel').textContent.match(/帧 (\d+)\/(\d+)/) || [])[2];
  ok(fr === tot, '越界的播放位置钳到了末帧（' + fr + '/' + tot + '）');
  p.close();

  // ---------------------------------------------------------------- 6. 存储不可用 → 降级并说明
  p = await openPage({ killStorage: true });
  await p.settle(1200);
  ok(/不允许本地存储/.test(p.$('sessionnote').textContent),
     '存储被禁：页面如实说明"不会被保存"，不装作已保存');
  ok(p.fetchLog.length === 1, '存储被禁：功能照常（照样调内核算了一遍）');
  ok(p.jsdomErrors.length === 0, '存储被禁：没有脚本异常');
  p.close();

  // ---------------------------------------------------------------- 7. 清除按钮
  p = await openPage({ seed: raw });
  await p.settle(1500);
  const forgetBtn = p.d.getElementById('forget');
  ok(forgetBtn !== null, '「清除并回到默认」按钮存在');
  if (forgetBtn) {
    forgetBtn.dispatchEvent(new p.w.Event('click', { bubbles: true }));
    await sleep(100);
    ok(p.w.localStorage.getItem(KEY) === null, '点了清除之后 localStorage 里的会话真的没了');
  } else skip++;
  p.close();

  // ---------------------------------------------------------------- 8. 播放推进（小数帧号回归）
  p = await openPage();
  await p.settle(1000);
  const f0 = (p.$('tlabel').textContent.match(/帧 (\d+)\//) || [])[1];
  for (let i = 0; i < 12; i++) { p.step(1, 50); await sleep(20); }
  await sleep(80);
  const f1 = (p.$('tlabel').textContent.match(/帧 (\d+)\//) || [])[1];
  ok(p.jsdomErrors.length === 0,
     '连续播放 12 帧无脚本异常（frameF 是小数，帧号必须取整才不会取到 undefined）'
     + (p.jsdomErrors.length ? ' — ' + p.jsdomErrors[0] : ''));
  ok(+f1 > +f0, '播放真的在往前推进（' + f0 + ' → ' + f1 + '）——画面不会定格在第一帧');
  ok(p.d.querySelectorAll('#biotable [data-cell="ts"]').length > 0
     && !/NaN/.test(p.$('biotable').textContent),
     '演化面板没有 NaN（小数索引曾让逐帧量取到 undefined）');
  p.close();

  finish();

  function finish() {
    fs.writeFileSync(path.join(__dirname, '_probe_session.txt'),
      out.join('\n') + '\n\n[session-e2e] n=' + n + ' fail=' + fail + ' skip=' + skip + '\n', 'utf8');
    process.exit(fail ? 1 : 0);
  }
})().catch(e => {
  out.push('  FAIL  探针自身异常：' + (e && e.stack || e));
  fail++;
  fs.writeFileSync(path.join(__dirname, '_probe_session.txt'),
    out.join('\n') + '\n\n[session-e2e] n=' + n + ' fail=' + fail + ' skip=' + skip + '\n', 'utf8');
  process.exit(1);
});
