// 脏标记 / 时间导航 / 分享链接 的判据。
// 全部用"能不能观测到"来判断：按钮文案、帧号、内核请求次数、localStorage 是否被改写。
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const BASE = 'http://localhost:8765';
const nodeFetch = globalThis.fetch;
const KEY = 'starpivot.universe.session';
let n = 0, fail = 0;
const L = [];
const ok = (c, m) => { n++; L.push((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const noop = () => {};
const ctxStub = new Proxy({}, {
  get: (t, k) => (k === 'createRadialGradient' || k === 'createLinearGradient')
    ? () => ({ addColorStop: noop }) : (k === 'measureText' ? () => ({ width: 10 }) : noop),
  set: () => true
});
async function open(hash = '') {
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', e => errs.push(String(e && e.message)));
  vc.on('jsdomError', noop);
  const rafQueue = [], fetchLog = [];
  const dom = new JSDOM(await (await nodeFetch(BASE + '/universe.html')).text(), {
    url: BASE + '/universe.html' + hash, runScripts: 'dangerously', virtualConsole: vc,
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = () => ctxStub;
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
  const frame = () => +((p.$('tlabel').textContent.match(/帧 (\d+)\//) || [])[1] || -1);
  const p = { w, d, $, fire, step, settle, fetchLog, errs, frame,
              kc: () => fetchLog.filter(f => f.url.includes('/api/nbody')).length,
              close: () => dom.window.close() };
  return p;
}

(async () => {
  // ---------- 1. 脏标记 ----------
  const p = await open();
  await p.settle(2500);
  if (p.$('play').textContent.indexOf('暂停') >= 0) { p.fire(p.$('play'), 'click'); await p.settle(200); }
  ok(p.$('compute').textContent === '重新计算', '初始按钮文案 = ' + p.$('compute').textContent);
  ok(p.$('dirtyhint').style.display === 'none', '初始没有"参数已改"提示');

  const noAuto = [['rscale', '3000'], ['nfrag', '8'], ['disp', '0.9'], ['fmin', '1.5'],
                  ['years', '12'], ['samples', '900'], ['collide', 'merge'], ['starcollide', true]];
  const n0 = p.kc();
  for (const [id, v] of noAuto) {
    const el = p.$(id);
    if (el.type === 'checkbox') { el.checked = v; p.fire(el, 'change'); }
    else { el.value = v; p.fire(el, 'input'); p.fire(el, 'change'); }
    await sleep(30);
  }
  await sleep(300);
  ok(p.kc() === n0, `这 ${noAuto.length} 个控件确实都不会自己重算（内核请求数没变）`);
  ok(/参数已改/.test(p.$('compute').textContent),
     '改完之后按钮自己说出来了：' + p.$('compute').textContent);
  ok(p.$('dirtyhint').style.display === 'block', '"参数已改"的提示条出现');
  ok(/仍是改之前的结果/.test(p.$('dirtyhint').textContent),
     '提示条说清了后果：画面还是旧结果');

  p.fire(p.$('compute'), 'click');
  await p.settle(3500);
  ok(!/参数已改/.test(p.$('compute').textContent), '重算成功后按钮文案复原');
  ok(p.$('dirtyhint').style.display === 'none', '重算成功后提示条消失');
  ok(p.fetchLog.filter(f => f.url.includes('/api/nbody')).slice(-1)[0].body.radius_scale === 3000,
     '而且新参数真的下发给内核了');

  // ---------- 2. 时间导航 ----------
  ok(p.frame() === 0 || p.frame() > 0, '当前帧号可读：' + p.frame());
  p.fire(p.$('fr_first'), 'click'); await p.settle(150);
  ok(p.frame() === 1, `⏮ 回到开头 → 第 ${p.frame()} 帧`);
  p.fire(p.$('fr_next'), 'click'); await p.settle(120);
  const f2 = p.frame();
  ok(f2 === 2, `▶ 下一帧 → 第 ${f2} 帧`);
  p.fire(p.$('fr_next'), 'click'); await p.settle(120);
  ok(p.frame() === 3, '▶ 再下一帧 → 第 ' + p.frame() + ' 帧');
  p.fire(p.$('fr_prev'), 'click'); await p.settle(120);
  ok(p.frame() === 2, `◀ 上一帧 → 第 ${p.frame()} 帧`);
  p.fire(p.$('fr_last'), 'click'); await p.settle(150);
  const nFrames = +((p.$('tlabel').textContent.match(/帧 \d+\/(\d+)/) || [])[1] || 0);
  ok(p.frame() === nFrames, `⏭ 跳到结尾 → 第 ${p.frame()}/${nFrames} 帧`);
  ok(p.$('play').textContent.indexOf('播放') >= 0, '手动定位之后是暂停态（不会被播放循环拽走）');
  // 边界：不能在开头往前、在结尾往后
  p.fire(p.$('fr_first'), 'click'); await p.settle(120);
  p.fire(p.$('fr_prev'), 'click'); await p.settle(120);
  ok(p.frame() === 1, '已在开头时再点 ◀ 停在第 1 帧，不会越界');

  // 演化表里的"达到该阶"能点着跳过去。两个前提缺一不可：
  //  (1) 阶梯真的走到过至少一阶 —— 12 年 / 100 年阶梯的话全在第 0 阶，本来就没有"达到时刻"；
  //  (2) 行星得还活着 —— 上一个用例开的 star_collide + rscale=3000 会把太阳半径放到 14 AU，
  //      内行星全被它吞掉，那时当然谁都没有阶。（这一条是实测踩出来的。）
  p.$('collide').value = 'off'; p.fire(p.$('collide'), 'change');
  p.$('starcollide').checked = false; p.fire(p.$('starcollide'), 'change');
  p.$('rscale').value = '450'; p.fire(p.$('rscale'), 'input');
  p.$('bioyears').value = '4'; p.fire(p.$('bioyears'), 'change');   // 这一下会带着上面几项一起重算
  await p.settle(3500);
  // 演化表显示的是"当前帧"的状态，刚算完停在 t≈0，那时谁都还没到任何一阶。
  // 要先跳到末帧，才会有"达到该阶的时刻"可点。
  p.fire(p.$('fr_last'), 'click'); await p.settle(250);
  L.push('  [dbg] years=' + p.$('years').value + ' samples=' + p.$('samples').value
    + ' bioyears=' + p.$('bioyears').value
    + ' biocard=' + p.$('biocard').style.display
    + ' rows=' + p.d.querySelectorAll('#biotable tr[data-row]').length
    + ' tlabel=' + p.$('tlabel').textContent
    + ' last.samples=' + JSON.stringify(p.fetchLog.filter(f => f.url.includes('/api/nbody'))
        .slice(-1)[0].body.samples)
    + ' last.bio_years=' + JSON.stringify(p.fetchLog.filter(f => f.url.includes('/api/nbody'))
        .slice(-1)[0].body.bio_years)
    + ' re=' + JSON.stringify([...p.d.querySelectorAll('#biotable [data-cell="re"]')]
        .map(c => c.textContent)));
  const jump = p.d.querySelector('#biotable [data-jump-t]');
  ok(!!jump, '演化表里"达到该阶的时刻"是可点的');
  if (jump) {
    const want = +jump.dataset.jumpT;
    p.fire(jump, 'click'); await p.settle(200);
    const t = +((p.$('tlabel').textContent.match(/t = ([-\d.]+)/) || [])[1] || 0);
    const stepYears = 12 / 900;   // 当前年数 / 帧数
    ok(Math.abs(t - want) <= stepYears * 1.5,
       `点"${want} 年"跳到了 t = ${t}（步长 ${stepYears.toFixed(4)} 年，落在最近的帧上）`);
  }

  // ---------- 3. 分享链接 ----------
  const raw = p.w.localStorage.getItem(KEY);
  ok(raw !== null, '当前会话在 localStorage 里');
  // 期望值从源页面现取，不要写死：写死的话，一改上面的用例这里就变成假失败。
  const expect = { rscale: p.$('rscale').value, years: p.$('years').value,
                   samples: p.$('samples').value, collide: p.$('collide').value };
  p.fire(p.$('share'), 'click');
  await sleep(200);
  const hash = p.w.location.hash;
  ok(/^#s=[A-Za-z0-9_-]+$/.test(hash), '点分享后地址栏 hash 变成 #s=… （' + hash.slice(0, 24) + '…）');
  ok(p.$('sharenote').style.display === 'block', '页面上给出了链接本身（复制失败时也能手动拿）');
  ok(/现场重算/.test(p.$('sharenote').textContent), '并且说明对方那边是现场重算，不是录像');
  const shared = hash.slice(3);
  p.close();

  // 另一端打开这条链接
  const q = await open('#s=' + shared);
  await q.settle(3000);
  ok(q.errs.length === 0, '打开分享链接无脚本异常' + (q.errs.length ? ' — ' + q.errs[0] : ''));
  ok(/已按分享链接载入/.test(q.$('sessionnote').textContent), '页面如实说明这是从分享链接载入的');
  ok(q.$('rscale').value === expect.rscale && q.$('years').value === expect.years,
     `链接里的设定生效了（rscale=${q.$('rscale').value}, years=${q.$('years').value}）`);
  ok(q.$('samples').value === expect.samples && q.$('collide').value === expect.collide,
     `帧数与碰撞模式也一起来了（samples=${q.$('samples').value}, collide=${q.$('collide').value}）`);
  // 关键：不能把对方（打开链接的人）自己的存档冲掉
  const before = q.w.localStorage.getItem(KEY);
  q.fire(q.$('fr_next'), 'click'); await q.settle(400);
  await sleep(600);
  ok(q.w.localStorage.getItem(KEY) === before,
     '只是打开链接、点了个逐帧，对方自己的会话没有被改写');
  // 一旦真的动手改参数，才算认下这份设定
  q.$('years').value = String(+expect.years + 18); q.fire(q.$('years'), 'input');
  await sleep(700);
  const after = q.w.localStorage.getItem(KEY);
  ok(after !== before && JSON.parse(after).years === String(+expect.years + 18),
     '自己改了参数之后才写入（新会话是你主动认下的）');
  q.close();

  // ---------- 4. 坏链接不能炸 ----------
  const r = await open('#s=this-is-not-valid-base64-@@@');
  await r.settle(2500);
  ok(r.errs.length === 0, '坏分享链接不抛异常');
  ok(/第一次打开/.test(r.$('sessionnote').textContent), '坏链接按"第一次打开"处理，不静默乱套');
  r.close();

  fs.writeFileSync(path.join(__dirname, '_probe_nav.txt'),
    L.join('\n') + '\n\n[nav] n=' + n + ' fail=' + fail + '\n', 'utf8');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  L.push('  FAIL  探针自身异常：' + (e && e.stack || e));
  fs.writeFileSync(path.join(__dirname, '_probe_nav.txt'),
    L.join('\n') + '\n\n[nav] n=' + n + ' fail=' + (fail + 1) + '\n', 'utf8');
  process.exit(1);
});
