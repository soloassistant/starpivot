// 本轮新增的四件工具：点画面放行星 / 选中信息卡 / 倒放与键盘 / 导出（CLI 命令 + PNG）/ 错误人话。
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
// 画布桩顺便记下所有 fillText 的内容：这样"画面上有没有画出距离标尺"这种
// 纯视觉的东西也能被断言（jsdom 不渲染像素，但调用参数是真的）。
const texts = [];
// 同理记下画出来的圆（天体、镜头十字、落点标记都是圆）：用来回答"那颗星**当时画在哪儿**"。
// 这一条是被一次假失败逼出来的：判据以为"放在 (640,300) 的星就在 (640,300)"，
// 于是点它却点空了 —— 而真正的原因只能靠量出来。
const arcs = [];
// 画布调用日志：arc / fill / stroke / fillText，**连同那一刻的 fillStyle / strokeStyle**。
// 为什么需要它：这一轮"球体颜色 = 生命形态"，要验的是"画上去的那一笔是什么颜色"，
// 而那个颜色由 render() 里的一个表达式决定 —— 从源码里正则匹配等于把实现抄一遍。
// 记下真调用之后，判据可以拿内核回显的 stage 独立复算出期望色，再与页面真画的那笔比。
// arc 与 fillText 一起看还能把"哪一笔填充属于哪颗天体"还原出来：页面是先填充、紧接着写名字。
const drawLog = [];
let lastArc = null;
const ctxStore = {};
const ctxStub = new Proxy(ctxStore, {
  get: (t, k) => {
    if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop: noop });
    if (k === 'measureText') return () => ({ width: 10 });
    if (k === 'arc') return (x, y, r) => { arcs.push([x, y, r]); lastArc = [x, y, r];
      drawLog.push({ k: 'arc', x, y, r }); };
    // moveTo / lineTo 也要记：碎屑喷流是"从撞击点拉一条线到碎屑"（moveTo → lineTo → stroke），
    // 而**描边本身不带坐标**（stroke() 只记那一刻的 lastArc，那是上一次 arc() 的陈旧值）。
    // 不记折线顶点的话，"这些线是不是从**同一点**发出来的"就只能从源码里猜。
    if (k === 'moveTo') return (x, y) => drawLog.push({ k: 'move', x, y });
    if (k === 'lineTo') return (x, y) => drawLog.push({ k: 'line', x, y });
    if (k === 'fill') return () => drawLog.push({ k: 'fill', arc: lastArc, style: t.fillStyle, alpha: t.globalAlpha });
    if (k === 'stroke') return () => drawLog.push({ k: 'stroke', arc: lastArc, style: t.strokeStyle, alpha: t.globalAlpha });
    if (k === 'fillText') return s => { texts.push(String(s)); drawLog.push({ k: 'text', s: String(s), style: t.fillStyle }); };
    return (k in t) ? t[k] : noop;
  },
  set: (t, k, v) => { t[k] = v; return true; }
});
async function open() {
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', e => errs.push(String(e && e.message)));
  vc.on('jsdomError', noop);
  const rafQueue = [], fetchLog = [], respLog = [];
  const dom = new JSDOM(await (await nodeFetch(BASE + '/universe.html')).text(), {
    url: BASE + '/universe.html', runScripts: 'dangerously', virtualConsole: vc,
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = () => ctxStub;
      w.requestAnimationFrame = cb => { rafQueue.push(cb); return rafQueue.length; };
      w.cancelAnimationFrame = noop;
      w.fetch = (u, o) => {
        let b = null; if (o && o.body) { try { b = JSON.parse(o.body); } catch (e) {} }
        fetchLog.push({ url: String(u), body: b });
        return nodeFetch(new URL(String(u), BASE).href, o).then(r => {
          // 把内核响应也留一份：后面要拿"导出的命令"跑出来的结果跟它逐帧比对
          if (String(u).includes('/api/nbody')) r.clone().json().then(j => respLog.push(j)).catch(() => {});
          return r;
        });
      };
    }
  });
  const w = dom.window, d = w.document;
  let t = 0;
  const step = (k = 1, dt = 16) => { for (let i = 0; i < k; i++) { const cb = rafQueue.shift(); if (cb) cb(1000 + (t += dt)); } };
  const $ = id => d.getElementById(id);
  const fire = (el, ty) => el.dispatchEvent(new w.Event(ty, { bubbles: true }));
  const settle = async (ms = 500) => { await sleep(ms); step(2); await sleep(30); };
  // ---- 等条件成立，不赌毫秒数（和 `_probe_dualmode.js` / `_probe_errbar.js` 同一套） ----
  // 页面默认的 custom payload 是"碎裂 + 太阳系全带 + 50 年" → 级联两百多颗、**回执 27.5 MB**，
  // 网关一跳就要 3.7 s。凡是用固定 settle(N) 等回执的地方，机器一慢就会把"还没回来"
  // 记成"页面没做"（本族判据已经这样假红过两次：dualmode 5 条、errbar 1 条）。
  const kcFn = () => fetchLog.filter(f => f.url.includes('/api/nbody')).length;
  const waitFor = async (fn, ms = 180000, hint = '') => {
    const t0 = Date.now();
    for (;;) {
      let hit = false;
      try { hit = !!fn(); } catch (e) {}
      if (hit) return Date.now() - t0;
      if (Date.now() - t0 > ms) throw new Error('等条件超时 ' + ms + 'ms' + (hint ? '（' + hint + '）' : ''));
      await sleep(80); step(1);
    }
  };
  // 用**页面自己的信号**判"这一发处理完了"：算的时候按钮是「积分中…」，处理完才放回可用。
  // 两个信号要一起看 —— 只看按钮的话，别的并发请求会把按钮借去。
  const waitResponses = (wantLen, ms = 180000) => waitFor(
    () => respLog.length >= wantLen && !$('compute').disabled, ms, '回执到齐 ' + wantLen + ' 条');
  // 画布尺寸在 jsdom 里是 0，页面会走 resizeCanvas 的提前返回；
  // 为了让"反解屏幕坐标"有确定的数，直接把画布尺寸与容器尺寸定死。
  const cvEl = d.getElementById('view');
  Object.defineProperty(cvEl, 'width', { value: 800, writable: true });
  Object.defineProperty(cvEl, 'height', { value: 600, writable: true });
  cvEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  // jsdom 的 canvas 没有指针捕获（真浏览器有）。这是桩的缺口，不是页面缺陷，
  // 不补上的话页面在 pointerdown 里抛异常，后面所有判据都不可信。
  cvEl.setPointerCapture = () => {};
  cvEl.releasePointerCapture = () => {};
  return { w, d, $, fire, step, settle, waitFor, waitResponses, fetchLog, respLog, errs, texts, arcs, drawLog,
           lastPayload: () => (fetchLog.filter(f => f.url.includes('/api/nbody')).slice(-1)[0] || {}).body,
           lastResp: () => respLog.slice(-1)[0],
           kc: () => fetchLog.filter(f => f.url.includes('/api/nbody')).length,
           close: () => dom.window.close() };
}
const mouse = (p, x, y) => {
  const ev = ty => new p.w.PointerEvent(ty, { clientX: x, clientY: y, bubbles: true, pointerId: 1 });
  p.d.getElementById('view').dispatchEvent(ev('pointerdown'));
  p.d.getElementById('view').dispatchEvent(ev('pointerup'));
};
// 放置现在绑在 canvas 的 dblclick 上（单击只做选中）——"放一颗"必须走这个。
// jsdom 不会从两次 click 自动合成 dblclick（真浏览器会自动发），所以要手动派发一次 dblclick。
// 两次 pointerdown/up 也照样派：那是单击的选中路径，页面会各跑一次，与真双击一致。
const dblclick = (p, x, y) => {
  const cv = p.d.getElementById('view');
  const ev = ty => new p.w.PointerEvent(ty, { clientX: x, clientY: y, bubbles: true, pointerId: 1 });
  cv.dispatchEvent(ev('pointerdown')); cv.dispatchEvent(ev('pointerup'));
  cv.dispatchEvent(ev('pointerdown')); cv.dispatchEvent(ev('pointerup'));
  cv.dispatchEvent(new p.w.MouseEvent('dblclick', { clientX: x, clientY: y, bubbles: true }));
};

(async () => {
  const p = await open();
  await p.settle(2500);
  p.fire(p.$('play'), 'click'); await p.settle(200);   // 暂停，免得帧一直在动

  // ---------- 1. 点画面放行星 ----------
  ok(p.$('placemode').textContent.indexOf('双击画面放行星') >= 0, '有「双击画面放行星」按钮：' + p.$('placemode').textContent);
  ok(p.d.getElementById('bodytable') && !p.$('placemode').classList.contains('primary'),
     '默认不在放置模式');
  // 从太阳系场景进入放置模式：应当自动切到自定义，否则行星表被忽略、点了没反应
  ok(p.$('scenario').value === 'solar', '起点是太阳系场景');
  p.fire(p.$('placemode'), 'click');
  await p.settle(3000);
  ok(p.$('scenario').value === 'custom', '进入放置模式后自动切到「自定义」（否则行星表不生效，点了没反应）');
  ok(p.$('placemode').classList.contains('primary'), '按钮变成"放置中"状态');
  ok(/反解回黄道面/.test(p.$('toolnote').textContent), '并且说明位置是怎么来的（屏幕坐标反解回黄道面）');

  // 点画布中心偏右一点 → 应当放下一个天体
  const before = p.d.querySelectorAll('#bodytable input[data-k="name"]').length;
  dblclick(p, 560, 300);
  await p.settle(3000);
  const after = p.d.querySelectorAll('#bodytable input[data-k="name"]').length;
  ok(after === before + 1, `点画面后行星表多了一行（${before} → ${after}）`);
  const rows = [...p.d.querySelectorAll('#bodytable tr')];
  const last = i => p.d.querySelectorAll('#bodytable input[data-k="' + i + '"]');
  const idx = after - 1;
  const aVal = +last('a')[idx].value, m0Val = +last('M0')[idx].value, eVal = +last('e')[idx].value;
  ok(aVal > 0 && Number.isFinite(aVal), `反解出的半长轴 a = ${aVal} AU`);
  ok(eVal === 0, `默认给正圆轨道 e = ${eVal}（免得一出生就撞）`);
  ok(m0Val >= 0 && m0Val < 360, `M0 = ${m0Val.toFixed(1)}° 就是点击的方位角`);
  const pl = p.lastPayload();
  ok(pl.scenario === 'custom' && pl.bodies.length === after,
     `新天体真的下发给了内核（payload.bodies = ${pl.bodies.length}）`);
  ok(/一出生就停在/.test(p.$('toolnote').textContent), '页面说明了"它会停在你点的那个位置"');

  // 位置正确性：把 M0 与 a 反算回世界坐标，看是否落在点击点上（用页面的投影正算回来比）
  {
    const deg = m0Val * Math.PI / 180;
    // 正俯视（pitch=0，yaw=0）时，屏幕上 (x,y) 直接对应世界 (x,-(y-cy))，尺度一致
    const wx = aVal * Math.cos(deg), wy = aVal * Math.sin(deg);
    // 屏幕上点 (560,300) 对中心 (400,300) 偏移 +160 px；比例 = aVal / 160 AU/px
    ok(Math.abs(wy) < aVal * 0.02, `放下的点在水平中线上（世界 y ≈ ${wy.toFixed(4)} AU，应接近 0）`);
    ok(wx > 0, `点在中心右侧 → 世界 x > 0（${wx.toFixed(4)} AU）`);
  }

  // 侧视时不该硬算
  p.$('tilt').value = '90'; p.fire(p.$('tilt'), 'input'); await p.settle(150);
  const n0 = p.d.querySelectorAll('#bodytable input[data-k="name"]').length;
  dblclick(p, 300, 200);
  await p.settle(400);
  ok(p.d.querySelectorAll('#bodytable input[data-k="name"]').length === n0,
     '俯仰到 90°（正侧视）时拒绝放置，没有瞎放一个');
  ok(/看不清|一条线|侧视/.test(p.$('toolnote').textContent),
     '并且说明了原因：' + p.$('toolnote').textContent.slice(0, 60));
  p.$('tilt').value = '0'; p.fire(p.$('tilt'), 'input'); await p.settle(150);

  // ---------- 1b. 放置模式下的距离标尺 ----------
  // 没有标尺，玩家点下去之前不知道自己点的是 0.5 AU 还是 20 AU（只能放下后从文字里看）。
  {
    p.texts.length = 0; p.step(1); await sleep(20);
    const withRings = p.texts.filter(s => / AU$/.test(s));
    ok(withRings.length > 0, `放置模式下画出了距离标尺：${withRings.join(' / ')}`);
    // 标尺必须跨到"1 AU 量级"：只在 10 的整数次幂上取基数的话，
    // 视野落在 3–30 AU 时最小一圈就是 10 AU，想在 1 AU 附近放一颗时等于没有刻度。
    const smallest = Math.min(...withRings.map(s => parseFloat(s)));
    ok(smallest <= 2, `最内一圈是 ${smallest} AU —— 能覆盖"在 1 AU 附近放一颗"的用法`);
    p.fire(p.$('placemode'), 'click'); await p.settle(200);   // 退出放置模式
    p.texts.length = 0; p.step(1); await sleep(20);
    ok(p.texts.filter(s => / AU$/.test(s)).length === 0, '退出放置模式后标尺不再画（不干扰看轨道）');
    p.fire(p.$('placemode'), 'click'); await p.settle(3000);  // 再进去，后面还要用
  }

  // ---------- 2. 选中信息卡 ----------
  // 信息卡的措辞分两套（普通人/教授），这里验的是术语那一套 ——
  // 两套的说法本身在 _probe_dualmode.js 里验。默认是普通人，所以先切过去。
  p.fire(p.$('mode_pro'), 'click'); await p.settle(300);
  ok(p.d.body.classList.contains('mode-pro'), '已切到教授模式再检查术语标签');
  ok(p.$('selcard').style.display === 'none', '没选中时信息卡是隐藏的');
  // 点中一个已知天体：用渲染时记录的 hits —— 直接点画布中心（太阳大约在那里）
  // 更可靠的做法：先跑一次还原，然后用"点空白处"验证隐藏，再点太阳。
  mouse(p, 400, 300);
  await p.settle(300);
  const shown = p.$('selcard').style.display === 'block';
  ok(shown, '点中天体后信息卡出现');
  if (shown) {
    const txt = p.$('selbody').textContent;
    ok(/质量/.test(txt) && /M☉/.test(txt), '信息卡给出质量（含 M☉）');
    ok(/个地球/.test(txt), '并换算成"几个地球"（用的是内核回显的地球质量）');
    ok(/半径/.test(txt) && /km/.test(txt), '给出半径');
    ok(/到主星距离/.test(txt), '给出到主星的距离');
    ok(/辐照度 S/.test(txt) && /平衡温 \/ 地表温/.test(txt), '给出 S / T_eq / T_surf');
    ok(/演化判定/.test(txt), '给出演化判定');
    ok(/内核回显/.test(txt), '卡上写明了这些数来自内核回显');
  }
  p.fire(p.$('resetview'), 'click'); await p.settle(200);
  ok(p.$('selcard').style.display === 'none', '取消选中后信息卡收起来');
  p.fire(p.$('mode_simple'), 'click'); await p.settle(300);   // 切回默认，后面的用例按普通人算

  // ---------- 3. 倒放 ----------
  const frameOf = () => +((p.$('tlabel').textContent.match(/帧 (\d+)\//) || [])[1] || 0);
  p.fire(p.$('fr_first'), 'click'); await p.settle(150);
  if (p.$('play').textContent.indexOf('播放') >= 0) { p.fire(p.$('play'), 'click'); await p.settle(150); }
  for (let i = 0; i < 8; i++) { p.step(1, 40); await sleep(12); }     // 正放到第 3 帧左右
  const fA = frameOf();
  p.fire(p.$('play'), 'click'); await p.settle(150);                  // 暂停
  ok(p.$('dirbtn').textContent.indexOf('倒放') >= 0, '方向按钮默认显示「倒放」：' + p.$('dirbtn').textContent);
  p.fire(p.$('dirbtn'), 'click'); await p.settle(150);
  ok(p.$('dirbtn').textContent.indexOf('正放') >= 0, '点一下变成「正放」');
  if (p.$('play').textContent.indexOf('播放') >= 0) { p.fire(p.$('play'), 'click'); await p.settle(150); }
  for (let i = 0; i < 6; i++) { p.step(1, 40); await sleep(12); }
  const fB = frameOf();
  p.fire(p.$('play'), 'click'); await p.settle(150);
  ok(fB < fA, `倒放时帧号在减小（${fA} → ${fB}）`);
  ok(p.w.localStorage.getItem('starpivot.universe.session').indexOf('"dir":-1') >= 0
     || JSON.parse(p.w.localStorage.getItem('starpivot.universe.session')).dir === -1,
     '倒放这个状态被记住了（下次进来还是倒放）');

  // ---------- 4. 键盘 ----------
  const key = (k, shift) => p.d.dispatchEvent(new p.w.KeyboardEvent('keydown',
    { key: k, code: k === ' ' ? 'Space' : k, shiftKey: !!shift, bubbles: true, cancelable: true }));
  p.fire(p.$('fr_first'), 'click'); await p.settle(150);
  key('ArrowRight'); await p.settle(150);
  ok(frameOf() === 2, `→ 键走一帧（到第 ${frameOf()} 帧）`);
  key('ArrowLeft'); await p.settle(150);
  ok(frameOf() === 1, `← 键退一帧（到第 ${frameOf()} 帧）`);
  key('ArrowRight', true); await p.settle(150);
  const total = +((p.$('tlabel').textContent.match(/帧 \d+\/(\d+)/) || [])[1] || 0);
  ok(frameOf() === total, `Shift+→ 跳到末尾（第 ${frameOf()}/${total} 帧）`);
  // 键盘判据必须在"确定已暂停"的前提下测：否则播放循环一直在推帧，
  // "帧号没变"这种断言无论如何都不成立（第一版就栽在这里）。
  const pauseNow = async () => {
    if (p.$('play').textContent.indexOf('暂停') >= 0) { p.fire(p.$('play'), 'click'); await p.settle(150); }
  };
  await pauseNow();
  const lbl0 = p.$('play').textContent;
  key(' '); await p.settle(200);
  ok(p.$('play').textContent !== lbl0, `空格切换播放态（${lbl0} → ${p.$('play').textContent}）`);
  key(' '); await p.settle(200);
  ok(p.$('play').textContent === lbl0, '再按空格切回去（' + p.$('play').textContent + '）');
  await pauseNow();
  // 输入框里打字时不能接管
  const before2 = frameOf();
  p.$('years').focus();
  p.$('years').dispatchEvent(new p.w.KeyboardEvent('keydown',
    { key: 'ArrowRight', bubbles: true, cancelable: true }));
  await p.settle(150);
  ok(frameOf() === before2, '焦点在输入框里时 ← → 不被页面接管（否则没法用键盘改数字）');

  // ---------- 4b. 把碎裂四参数挪出**内核默认值**，再算一次；后面两节都建在这份 payload 上 ----------
  // 为什么非改不可：页面默认值里有**三项恰好等于内核默认值**
  // （`spray 0.6 == 0.6`、`fragments 4 == 4`、`frag-min-speed 0.5 == 0.5`）。
  // 而在"页面值 == 内核默认值"的 payload 上，"网关把这个参数吞掉"与"转发成功"
  // 产生的内核输出是**逐位相同**的 —— 端到端比对对这种缺陷是**瞎的**。
  // 上一轮漏掉 `spray`（网关 `api_nbody` 不转发它 → 那个控件是死的）正是栽在这里。
  // 口径与 `_probe_argv.py` K 节一致：**四个数一个都不许等于内核默认值**。
  const FRAG_UI = { nfrag: 5, disp: 0.45, fmin: 1.0, spray: 0.33 };
  {
    const KDEF = { nfrag: 4, disp: 1.0, fmin: 0.5, spray: 0.6 };   // 内核默认值
    ok(Object.keys(FRAG_UI).every(k => FRAG_UI[k] !== KDEF[k]),
       `本节刻意用的四个数都**不等于**内核默认值（${JSON.stringify(FRAG_UI)} vs ${JSON.stringify(KDEF)}）`
       + ' —— 否则"被吞掉"与"转发成功"看起来一模一样');
    const setNum = async (id, v) => { p.$(id).value = String(v); p.fire(p.$(id), 'change'); await sleep(40); };
    p.$('collide').value = 'fragment'; p.fire(p.$('collide'), 'change'); await p.settle(200);
    for (const k of Object.keys(FRAG_UI)) await setNum(k, FRAG_UI[k]);
    const prevResp = p.respLog.length;
    p.fire(p.$('compute'), 'click');
    // 等到内核回话为止。⚠ 别只 sleep 一个固定数：这是真算（页面默认 50 年 / 2000 帧），
    //   固定等待要么白等要么等到一半就开始断言。同时还留一条"页面自己报了错就早退"的路。
    const t0 = Date.now();
    while (p.respLog.length <= prevResp && Date.now() - t0 < 240000) {
      await sleep(100); p.step(1);
      if (p.$('errbar').style.display === 'block' && p.$('errbar').textContent.trim()) break;
    }
    await p.settle(800);
    ok(p.respLog.length > prevResp, '改完参数重算一次，拿到了新的内核响应');
    const pl4 = p.lastPayload();
    ok(!!pl4 && pl4.collide === 'fragment' && pl4.fragments === FRAG_UI.nfrag
       && pl4.dispersion_kms === FRAG_UI.disp && pl4.frag_min_speed_kms === FRAG_UI.fmin
       && pl4.spray === FRAG_UI.spray,
       `页面确实把四个数都发出去了（fragments=${pl4 && pl4.fragments}、dispersion=${pl4 && pl4.dispersion_kms}、`
       + `frag_min_speed=${pl4 && pl4.frag_min_speed_kms}、spray=${pl4 && pl4.spray}）`);
  }

  // ---------- 5. 导出等价 CLI 命令 ----------
  p.fire(p.$('exportcl'), 'click'); await sleep(250);
  const tn = p.$('toolnote').textContent;
  const cmd = (p.$('toolnote').innerHTML.match(/<code[^>]*>([\s\S]*?)<\/code>/) || [])[1];
  ok(!!cmd && /^starpivot nbody --scenario custom/.test(cmd.trim()), '导出的是一行 starpivot nbody 命令');
  ok(/--years/.test(cmd) && /--samples/.test(cmd) && /--body/.test(cmd),
     '命令里带着年数/帧数/自定义天体：' + cmd.slice(0, 90) + '…');
  ok(/同一份 payload|等价/.test(tn), '页面上说明了这行命令与刚才那次计算等价');
  // 命令必须与页面真正发出去的那一份一致：把命令解析回来，逐字段和 payload 比
  {
    const argv = cmd.trim().split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
    const bodyIdx = argv.reduce((a, v, i) => (v === '--body' ? a.concat(i + 1) : a), []);
    const pl = p.lastPayload();
    ok(get('--scenario') === pl.scenario, `命令的 --scenario 与页面一致（${get('--scenario')}）`);
    ok(+get('--years') === pl.years, `--years 一致（${get('--years')} vs ${pl.years}）`);
    ok(+get('--samples') === pl.samples, `--samples 一致（${get('--samples')} vs ${pl.samples}）`);
    ok(bodyIdx.length === (pl.bodies || []).length,
       `--body 条数与页面一致（${bodyIdx.length} vs ${(pl.bodies || []).length}）`);
    const first = argv[bodyIdx[0]].replace(/^"|"$/g, '').split(',');
    ok(+first[1] === pl.bodies[0].a, `第一条 --body 的 a 一致（${first[1]} vs ${pl.bodies[0].a}）`);
    // ---- 碰撞那一串也要逐个比 ----
    // ⚠ 这六项原来**一项都没比**：命令里少写一项，判据照样绿。而"等价 CLI 命令"
    //   是给用户复制到终端去跑的 —— 少一项就等于**承诺了另一件事**。
    //   注意这一节比的是"命令字符串 vs 页面 payload"，与网关转不转发无关；
    //   "网关有没有把参数交到内核手里"由 §6b 读内核回显来验。
    ok(get('--collide') === pl.collide, `命令的 --collide 与页面一致（${get('--collide')} vs ${pl.collide}）`);
    ok(+get('--radius-scale') === pl.radius_scale,
       `--radius-scale 一致（${get('--radius-scale')} vs ${pl.radius_scale}）`);
    ok(+get('--fragments') === pl.fragments,
       `--fragments 一致（${get('--fragments')} vs ${pl.fragments}）`);
    ok(Math.abs(+get('--dispersion-kms') - pl.dispersion_kms) < 1e-12,
       `--dispersion-kms 一致（${get('--dispersion-kms')} vs ${pl.dispersion_kms}）`);
    ok(Math.abs(+get('--frag-min-speed-kms') - pl.frag_min_speed_kms) < 1e-12,
       `--frag-min-speed-kms 一致（${get('--frag-min-speed-kms')} vs ${pl.frag_min_speed_kms}）`);
    ok(Math.abs(+get('--spray') - pl.spray) < 1e-12,
       `--spray 一致（${get('--spray')} vs ${pl.spray}）—— 这四项一旦缺一，那条"等价命令"就是假的`);
  }

  // ---------- 6. 导出 PNG ----------
  p.fire(p.$('exportpng'), 'click'); await sleep(250);
  const pngNote = p.$('toolnote').textContent;
  ok(/PNG/.test(pngNote), 'PNG 按钮有明确反馈：' + pngNote.slice(0, 70));
  // 这个环境（jsdom）的 toDataURL 会"不抛异常但返回空数据"，页面必须如实说失败 ——
  // 否则就是"没验过就宣称成功"，而那正是本项目一直在防的那类谎报。
  ok(/失败/.test(pngNote) && /有效的 PNG 数据/.test(pngNote),
     '拿不到有效 PNG 时如实报失败（而不是照样说"已导出"）');

  // ---------- 6b. 导出的命令必须真的能跑，而且跑出来的东西与页面一致 ----------
  {
    const EXE = path.join(__dirname, 'starpivot', 'build', 'bin', 'starpivot.exe');
    const argv = cmd.trim().replace(/^starpivot\s+/, '').split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    // 这条断言必须真跑一遍页面上导出的那条命令（只比对字符串等于没验）。
    // 用 _runner 而不是直接 spawnSync：在起不了子进程的机器上它会把这条命令
    // 记进 _plan_*.json，由 python 录制后再回放 —— 见 _runner.js 开头那段。
    const r = require('./_runner').spawn(EXE, argv, { maxBuffer: 256 * 1024 * 1024, timeout: 120000 });
    ok(r.status === 0 && r.stdout.trim().startsWith('{'),
       `导出的命令真能跑（退出码 ${r.status}）`);
    let js2 = null;
    try { js2 = JSON.parse(r.stdout); } catch (e) {}
    const pl2 = p.lastPayload();
    const pageResp = p.lastResp();
    ok(!!js2 && !!pageResp, '页面那份响应也拿到了，可以做同一次计算的比对');
    ok(!!js2 && js2.frames.length === pageResp.frames.length,
       `帧数一致（命令 ${js2 && js2.frames.length} vs 页面 ${pageResp && pageResp.frames.length}）`);
    ok(!!js2 && js2.bodies.length === pageResp.bodies.length,
       `天体数一致（${js2 && js2.bodies.length}）`);
    // 逐点比：两次必须是同一次计算（同一个二进制的同一组参数 → 输出应当逐位相同）
    let maxDiff = 0;
    if (js2 && pageResp) {
      const k = Math.min(js2.frames.length, pageResp.frames.length) - 1;
      const nb = Math.min(js2.bodies.length, pageResp.bodies.length);
      for (let b = 0; b < nb; b++)
        for (let c = 0; c < 3; c++)
          maxDiff = Math.max(maxDiff, Math.abs(js2.frames[k].p[b][c] - pageResp.frames[k].p[b][c]));
    } else {
      // ⚠ 缺录制时 js2 / pageResp 会是 null。原来这里直接往下走 → 解引用 null → 探针自身抛异常，
      //   后面所有分节都不会跑（"一条真失败"会掩盖掉"后面全没验"）。显式判一下。
      maxDiff = Infinity;
    }
    ok(js2 && pageResp && maxDiff < 1e-6, `末帧每个坐标的最差偏差 ${maxDiff.toExponential(2)} AU —— `
      + '导出的命令与页面那一次是同一次计算，不是"看起来差不多"');
    // 天体总数 = 太阳系背景（solar=full 时是 10 个）+ 自定义天体，所以直接点名核对更可靠
    const missing = js2 && pl2 ? (pl2.bodies || []).filter(b => !js2.bodies.some(x => x.id === b.name)) : null;
    ok(missing !== null && missing.length === 0,
       `自定义的 ${pl2 && (pl2.bodies || []).length} 个天体全部出现在结果里（总数 ${js2 && js2.bodies.length} = `
       + `太阳系背景 + 自定义）` + (missing && missing.length ? ' 缺: ' + missing.map(m => m.name) : '')
       + (missing === null ? '（没拿到命令输出，这一条没验）' : ''));

    // ---- 端到端第二问：内核**自己回显**的参数，等于页面下发的吗？----
    // 上面比的都是"页面自己拼的字符串"（payload 与导出的命令）。网关**吞不吞**这个参数，
    // 那两条都看不见 —— 命令是页面拼的，它与 payload 当然一致。唯一能回答的只有
    // "内核回显了什么"。四参数都取了非默认值（§4b），所以四个回显都得逐个对上；
    // 任何一个被中间层吞掉，回显就会退回内核默认值，这里立刻红。
    const fragEcho = (pageResp && pageResp.fragmentation) || {};
    const nearEcho = (got, want) => got !== undefined && Math.abs(+got - want) < 1e-12;
    ok(nearEcho(fragEcho.fragments, FRAG_UI.nfrag),
       `内核回显的碎块数 = 页面下发的 ${FRAG_UI.nfrag}（拿到 ${fragEcho.fragments}）`);
    ok(nearEcho(fragEcho.dispersion_kms, FRAG_UI.disp),
       `内核回显的色散速度 = 页面下发的 ${FRAG_UI.disp}（拿到 ${fragEcho.dispersion_kms}）`);
    ok(nearEcho(fragEcho.frag_min_speed_kms, FRAG_UI.fmin),
       `内核回显的碎裂阈值 = 页面下发的 ${FRAG_UI.fmin}（拿到 ${fragEcho.frag_min_speed_kms}）`);
    ok(nearEcho(fragEcho.spray, FRAG_UI.spray),
       `内核回显的喷流成束 = 页面下发的 ${FRAG_UI.spray}（拿到 ${fragEcho.spray}）—— `
       + '**这一条才是端到端的**：上一轮网关漏转发 `spray`，默认值又是 0.6，'
       + '于是"控件是死的"在默认 payload 上一点症状都没有');

    // §4b 是**故意**用非默认值的，别把这份"非默认"漏给后面的小节：
    // §10 的级联/颜色聚合建在"页面默认阈值 0.5"上（它自己会重算）。
    // 还原本身也断言一下，否则还原失败会伪装成 §10 的红。
    p.$('nfrag').value = '4';  p.fire(p.$('nfrag'), 'change');
    p.$('disp').value  = '0.3'; p.fire(p.$('disp'), 'change');
    p.$('fmin').value  = '0.5'; p.fire(p.$('fmin'), 'change');
    p.$('spray').value = '0.6'; p.fire(p.$('spray'), 'change');
    await p.settle(200);
    ok([p.$('nfrag').value, p.$('disp').value, p.$('fmin').value, p.$('spray').value].join('/')
       === '4/0.3/0.5/0.6', '四个旋钮已还原成页面默认（后面几节按默认阈值算）');
  }

  // ---------- 6c. 挑战进行中用鼠标放下的天体必须计分 ----------
  // （最自然的操作路径是"开着挑战，点画面加行星"，如果那时加的天体不计分，挑战就是坏的）
  {
    // ⚠ 页面现在会在「开始挑战」时**自动进放置模式**（用户反馈"把稳定性挑战融入进去"）。
    //   所以这里不能盲目点一下 placemode —— 那一下会把它关掉，后面的"点画面加一颗"就没发生，
    //   而症状看着像"挑战不计分"。改成先归零、再按**期望状态**设置，并把新行为本身也断言上。
    const placingOn = () => /放置中/.test(p.$('placemode').textContent);
    const setPlacing = async (want, ms = 300) => {
      if (placingOn() !== want) p.fire(p.$('placemode'), 'click');
      await p.settle(ms);
    };
    p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await p.settle(250);
    p.fire(p.$('ch_start'), 'click');
    await p.settle(4000);
    ok(placingOn(), '开始挑战后自动进入放置模式（不用先去表里加天体）');
    const before = (p.$('challengebox').textContent.match(/得分 ([\d.]+)/) || [])[1];
    const massBefore = (p.$('challengebox').textContent.match(/([\d.]+) 个地球质量/) || [])[1];
    ok(massBefore !== undefined, `挑战给出的质量项：${massBefore} 个地球质量`);
    // 开着挑战，用鼠标放一颗
    await setPlacing(true);
    ok(placingOn(), '挑战进行中也允许进放置模式');
    dblclick(p, 640, 300);
    await p.settle(4000);
    const massAfter = (p.$('challengebox').textContent.match(/([\d.]+) 个地球质量/) || [])[1];
    const scoreAfter = (p.$('challengebox').textContent.match(/得分 ([\d.]+)/) || [])[1];
    ok(massAfter !== undefined && +massAfter > +massBefore,
       `鼠标放下的天体计入了挑战（质量项 ${massBefore} → ${massAfter} 个地球质量）`);
    ok(scoreAfter !== undefined && (before === undefined || +scoreAfter !== +before),
       `分数随之下发（前 ${before} → 后 ${scoreAfter}）`);
    p.fire(p.$('ch_quit'), 'click'); await p.settle(200);
    await setPlacing(false);
  }

  // ---------- 7. 错误人话 ----------
  // 造一个内核必然拒绝的请求：自定义 + e=1.5
  // ⚠ 切到 custom 会**立刻发一发重算**（而且是碎裂的大件）。必须**先等它算完**再制造错误 ——
  //   否则它一直在飞，等它终于回来时那次"成功"会 clearError()，把下面要断言的告警条顺手清掉：
  //   "告警条黏住"就变成看两发的先后运气（`_probe_errbar.js` 就是这么飘的，已修）。
  const nR7 = p.respLog.length;
  p.$('scenario').value = 'custom'; p.fire(p.$('scenario'), 'change');
  await p.waitResponses(nR7 + 1);
  p.fire(p.$('placemode'), 'click'); await p.settle(200);   // 关掉放置模式，免得误放
  const eIn = p.d.querySelector('#bodytable input[data-k="e"]');
  eIn.value = '1.5'; p.fire(eIn, 'change');
  const n1 = p.kc();
  p.fire(p.$('compute'), 'click');
  // 按"按钮回到可用"判这一发处理完了（**不是**等告警条出现 —— 那正是下面要断言的东西）。
  await p.waitFor(() => p.kc() > n1, 30000, '错误那一发已经发出');
  await p.waitFor(() => !p.$('compute').disabled, 120000, '页面处理完这一发');
  const et = p.$('errbar').textContent;
  ok(p.$('errbar').style.display === 'block', '失败告警条出现');
  ok(/e must be in/.test(et), '保留内核原话');
  ok(/为什么/.test(et), '并且给出了"为什么"');
  ok(/不再闭合/.test(et) && /一去不回/.test(et),
     '把 e≥1 的物理含义讲成人话（轨道不再闭合、一去不回）');
  // ---------- 8. 投放星体：落点预览 / 撤销 / Esc ----------
  // 起因是用户反馈"优化一下投放"。改之前：点下去才知道落在哪（只有几圈标尺能眼估），
  // 放错了唯一的办法是"删了重放"（页面提示自己就这么写的）。
  // 这里验三件事，其中第 1 条是根：**预览与真正点击共用同一个判定**（placeCandidate），
  // 所以"预览显示的 3 位小数"必须与"真正落地的 a 的 3 位小数"逐位相同 ——
  // 分成两份判定就会出现"预览说能放、点下去被拒绝"这类没法分辨的谎。
  {
    const moveTo = (x, y) => p.d.getElementById('view').dispatchEvent(
      new p.w.PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true, pointerId: 1 }));
    const ghostText = () => (p.texts.filter(s => / AU · 方位 /.test(s)).slice(-1)[0] || '');
    const ghostAU = () => { const m = ghostText().match(/^([\d.]+) AU/); return m ? +m[1] : null; };
    // 同一个比法喂正负两种输入 —— 负样本才是在验"这一处判断"。
    const sameSpot = (previewAU, placedAU) => Math.abs(previewAU - placedAU) < 0.001;

    // 切到一个已知起点（预设会清掉撤销栈 —— 这一条本身在下面当负样本验）
    p.fire(p.d.querySelectorAll('#presets button')[2], 'click');   // 「类地行星」
    await p.settle(1200);
    ok(p.$('unplace').disabled === true,
       '刚套用预设时"撤销"是禁用的（预设不是"你刚放下的"，不该能撤）');

    // 放置模式可能是前面几段留下的状态 —— 先归零再自己进入，不依赖上游留下的状态。
    p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await p.settle(250);
    p.fire(p.$('placemode'), 'click'); await p.settle(300);
    ok(/放置中/.test(p.$('placemode').textContent),
       '进入放置模式（本段自己归零后再进，不依赖前几段留下的状态）');

    // 1) 光标处先给出落点与距离方位
    p.texts.length = 0; moveTo(620, 330); await p.settle(250);
    const g1 = ghostText(), a1 = ghostAU();
    ok(/^\d+\.\d{3} AU · 方位 \d+°$/.test(g1),
       '光标一动就显示落点与距离方位：' + (g1 || '（什么都没画）'));

    // 2) 预览的数 == 真落地后的数（共用 placeCandidate 的直接后果）
    const nB0 = p.lastPayload().bodies.length;
    dblclick(p, 620, 330); await p.settle(1200);
    const placedA = p.lastPayload().bodies.slice(-1)[0].a;
    ok(p.lastPayload().bodies.length === nB0 + 1, '在同一个点按下去，真的多了一颗');
    ok(a1 !== null && sameSpot(a1, placedA),
       `预览值与落地值同一处一致（预览 ${a1} AU vs 落地 a=${placedA}）`);

    // 3) 换个位置，预览跟着变
    p.texts.length = 0; moveTo(700, 260); await p.settle(250);
    const a2 = ghostAU();
    ok(a2 !== null && a2 !== a1, `换个位置预览就变（${a1} → ${a2}）`);
    ok(!sameSpot(a2, placedA),
       '负样本：拿**另一个位置**的预览去比已落地的值，同一处判不一致（自证这个比法不是恒真）');

    // 4) 撤销：只撤"你刚点画面放下的"
    const namesBefore = p.lastPayload().bodies.map(b => b.name);
    const placedName = namesBefore[namesBefore.length - 1];
    p.fire(p.$('unplace'), 'click'); await p.settle(1200);
    const namesAfter = p.lastPayload().bodies.map(b => b.name);
    ok(!namesAfter.includes(placedName) && namesAfter.length === namesBefore.length - 1,
       `撤销掉的是刚放下的那颗（${placedName}）：${namesBefore.length} → ${namesAfter.length} 颗`);
    ok(/已撤销/.test(p.$('toolnote').textContent), '并且说清了撤掉的是哪一颗、在多少 AU');
    ok(p.$('unplace').disabled === true,
       '没有可撤销的投放时按钮禁用（预设那颗没被当成"刚放下的"）');

    // 5) Ctrl+Z 走同一条路
    dblclick(p, 640, 340); await p.settle(1200);
    const nB2 = p.lastPayload().bodies.length;
    p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await p.settle(1200);
    ok(p.lastPayload().bodies.length === nB2 - 1, 'Ctrl+Z 也能撤销（与按钮走同一个函数）');

    // 6) Esc 退出放置模式；退出后点画面不再投放
    p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await p.settle(300);
    ok(!/放置中/.test(p.$('placemode').textContent), '按 Esc 退出放置模式（按钮文字回到常态）');
    const nB3 = p.lastPayload().bodies.length;
    dblclick(p, 600, 320); await p.settle(600);
    ok(p.lastPayload().bodies.length === nB3, '退出后双击也不会再放一颗');

    // 7) 越界：预览与点击说的是同一句话（同一判定）。
    //    旧代码把上限写死 60 AU：在宽画布上 fitScale 按短边把系统塞进去、长边映射到的 AU 更多，
    //    于是右边/左边明明看得见的一大片被误判成"超出范围"——点画面放行星却放不进去（用户实踩）。
    //    修复后上限改为"画面能容纳的最远距离"（中心到画布四角），点画面里看得见的地方都能放。
    //    为触发旧代码的越界，这里用大系统（太阳系九星，到冥王星 39 AU）把缩放拉到最小：
    //    旧代码此时整屏都 >60 AU、点哪儿都拒；新代码因为 (760,300) 仍在画布内，应当**允许**。
    p.fire(p.d.querySelectorAll('#presets button')[0], 'click');   // 「太阳系九星」
    await p.settle(1500);
    p.$('zoom').value = '20'; p.fire(p.$('zoom'), 'input'); await p.settle(500);
    p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await p.settle(200);
    p.fire(p.$('placemode'), 'click'); await p.settle(400);
    const nB4 = p.lastPayload().bodies.length;
    p.texts.length = 0; moveTo(760, 300); await p.settle(300);
    const previewTxt = p.texts.filter(s => /AU · 方位/.test(s)).slice(-1)[0] || '';
    ok(!/超出范围/.test(p.texts.join(' ')),
       '宽画布/缩到最小时，光标在画面内（760,300）也应可放，不再误报"超出范围"（预览：'
       + (previewTxt || '（无）') + '）');
    dblclick(p, 760, 300); await p.settle(800);
    ok(!/超出可放置范围|超出范围/.test(p.$('toolnote').textContent),
       '双击真的放进去了，不再被"超出范围"拦下');
    ok(p.lastPayload().bodies.length === nB4 + 1, '确实多放进去一颗（可见空间不再被误判成越界）');
    // 反过来：太靠近中心（<0.02 AU）仍要拒绝 —— 这条下限分支没删，仍然 alive。
    p.fire(p.$('placemode'), 'click'); await p.settle(200);   // 退出再进，清掉残留 ghost
    p.fire(p.$('placemode'), 'click'); await p.settle(300);
    p.texts.length = 0; moveTo(400, 300); await p.settle(250);
    ok(/超出范围/.test(p.texts.join(' ')),
       '但点正中心（太靠近中心）预览仍当场写明"超出范围"（下限分支仍生效）');
    dblclick(p, 400, 300); await p.settle(500);
    ok(p.lastPayload().bodies.length === nB4 + 1, '双击正中心没有多放一颗（太靠近中心被拦下，没悄悄放）');
    p.fire(p.$('placemode'), 'click'); await p.settle(200);
    p.$('zoom').value = '100'; p.fire(p.$('zoom'), 'input'); await p.settle(300);
  }

  // ---------- 9. 点一颗天体 → 镜头对准并跟住它；默认"碰到就合并" ----------
  // 起因是一条使用反馈："点击一颗行星自动调整视角，碰撞自然发生"。
  // 改之前两件事都不成立：
  //   ① 点一下只按轨道面摆相机（yaw=−Ω、pitch=−i），而太阳系的行星几乎共面 ——
  //      对它们这是个空操作，点一下看着像没反应；就算摆对了，天体几秒后也转出画面。
  //   ② 碰撞默认是"关"，两颗轨道相交的行星会**互相穿过**；而页面上那句"默认 A/B 真会撞上"
  //      其实要另外开一个开关才成立。
  {
    // ---- (1) 默认值要在**全新打开的页面**上验 ----
    // 前面那些小节已经把 collide 改来改去（预设会把它复位成"关"），拿它当"默认值"是假的。
    const mergesIn = (resp) => ((resp && resp.events) || []).filter(e => e.kind === 'merge');
    const q = await open();
    await q.settle(4000);
    ok(q.$('collide').value === 'fragment',
       '全新打开的页面：碰撞模式默认是「撞击碎裂」（高速撞碎、低速重聚）');
    // (2) 默认设置下那对 A/B 真的撞上 —— 直接读内核事件，不看页面怎么说
    q.$('scenario').value = 'custom'; q.fire(q.$('scenario'), 'change');
    await q.settle(6000);
    const ms = mergesIn(q.lastResp());
    ok(ms.length > 0,
       '默认设置下那对 A/B 真的合并了（内核事件 ' + (ms[0] ? 't=' + ms[0].t + ' 年' : '（一个都没有）') + '）');
    // 负样本走同一个函数：把碰撞关掉、**显式重算**（改设置只标脏，不自动重算），
    // 同一处必须判"没有合并"。不重算的话读到的还是上一次的响应 —— 那样的负样本是假的。
    q.$('collide').value = 'off'; q.fire(q.$('collide'), 'change');
    await q.settle(500);
    q.fire(q.$('compute'), 'click');
    await q.settle(6000);
    ok(mergesIn(q.lastResp()).length === 0,
       '负样本：碰撞设成「关」后同一个函数判"没有合并事件"（说明上面那条不是恒真）');
    q.close();

    // ---- (3) 点一颗天体：镜头对准它，并钉在画面中心 ----
    //  先把它放在一个**已知的屏幕位置**上，再点它 —— 这样"镜头应该挪多少"是可以算出来的。
    const cvEl2 = p.d.getElementById('view');      // 探针把画布钉成 800×600，中心 (400,300)
    const store = () => {
      try { return JSON.parse(p.w.localStorage.getItem('starpivot.universe.session') || 'null'); }
      catch (e) { return null; }
    };
    const flush = async () => {                    // 存档有 250ms 节流，用一个无害的 change 催一下
      p.fire(p.$('interp'), 'change');
      await sleep(420);
    };
    const centered = (panX, panY, clickX, clickY) =>
      Math.abs(panX - (400 - clickX)) < 40 && Math.abs(panY - (300 - clickY)) < 40;
    const key = (k) => p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: k, bubbles: true }));
    const dragTo = async (x0, y0, x1, y1) => {
      const ev = (ty, x, y) => new p.w.PointerEvent(ty, { clientX: x, clientY: y, bubbles: true, pointerId: 7 });
      cvEl2.dispatchEvent(ev('pointerdown', x0, y0));
      cvEl2.dispatchEvent(ev('pointermove', x1, y1));
      cvEl2.dispatchEvent(ev('pointerup', x1, y1));
      await p.settle(200);
    };

    p.fire(p.d.querySelectorAll('#presets button')[2], 'click');   // 「类地行星」
    await p.settle(1500);
    // 暂停并回到第 0 帧：这样"放在哪儿就画在哪儿"，后面点它才点得中
    //（不暂停的话它 4 秒里已经转走 87°，那个点就空了 —— 第一版就是这么假失败的）。
    if (/暂停/.test(p.$('play').textContent)) { p.fire(p.$('play'), 'click'); await p.settle(300); }
    p.fire(p.$('fr_first'), 'click'); await p.settle(300);
    p.fire(p.$('resetview'), 'click'); await p.settle(300);        // 平移量归零，后面好算
    const s0 = store();
    ok(s0 && Math.abs(s0.view.panX) < 1 && Math.abs(s0.view.panY) < 1,
       '「⊙ 黄道复位」真的把平移量也归零了（原来只复位了角度）');

    p.fire(p.$('placemode'), 'click'); await p.settle(300);
    dblclick(p, 640, 300); await p.settle(3000);                   // 在那个位置放一颗（双击）
    // 放完之后**再**暂停 + 回到第 0 帧：第 0 帧就是它"出生"的那一刻，正好在点击处。
    // （算完会自动续播，3 秒里它已经转开 20 多 px —— 第一版就是因此点空的。）
    if (/暂停/.test(p.$('play').textContent)) { p.fire(p.$('play'), 'click'); await p.settle(200); }
    p.fire(p.$('fr_first'), 'click'); await p.settle(300);
    key('Escape'); await p.settle(300);
    ok(!/放置中/.test(p.$('placemode').textContent), 'Esc 退出放置模式，接下来点是"选中"');
    // 先量一下"它到底画在哪儿"——判据对位置的假设必须自己先被验一遍，
    // 否则后面"点空"这种失败会看着像功能坏了。
    p.arcs.length = 0; await p.settle(300);
    const dmin = Math.min(...p.arcs.map(([x, y]) => Math.hypot(x - 640, y - 300)));
    ok(dmin < 12, `刚放下的天体确实画在点击处（最近的一个圆离 (640,300) ${dmin.toFixed(1)} px）`);
    mouse(p, 640, 300); await p.settle(500);                       // 点它 = 选中
    ok(/镜头已对准/.test(p.$('toolnote').textContent),
       '点中的那一刻就说清了镜头在做什么：' + p.$('toolnote').textContent.slice(0, 30) + '…');
    await flush();
    const s1 = store();
    ok(s1 && centered(s1.view.panX, s1.view.panY, 640, 300),
       `镜头真的把它挪到了画面中心（panX ${s0.view.panX} → ${s1.view.panX}，期望 ≈ −240）`);
    ok(!centered(s1.view.panX, s1.view.panY, 500, 300),
       '负样本：拿**另一个位置**当期望，同一处判不居中（自证这个比法不是恒真）');

    // 手动拖动 = 自己接管镜头，跟随必须松开（否则跟鼠标打架）
    await dragTo(400, 300, 470, 300);
    await flush();
    const s2 = store();
    ok(s2 && s2.cam.follow === -1, '手动拖动之后不再跟随（镜头交给手）');
    ok(s2 && Math.abs(s2.view.panX - s1.view.panX) > 20, '拖动确实平移了画面');

    // 「⊙ 黄道复位」= 回到原点并取消跟随
    p.fire(p.$('resetview'), 'click');
    await flush();
    const s3 = store();
    ok(s3 && s3.cam.follow === -1 && Math.abs(s3.view.panX) < 1 && Math.abs(s3.view.panY) < 1,
       '「⊙ 黄道复位」回到原点、取消选中与跟随');
  }

  // ---------- 10. 碰撞过程要"分散"、颜色按来源"聚合"、时长可以设成"永久" ----------
  // 起因是一条使用反馈："碰撞过程分散，颜色聚合一定要模拟起来，时间可以调整并且定为永久"。
  // 三件事都要求**从内核数据推**，不许是装饰：
  //   · 分散：碎片是内核把母体炸开产生的（X#1…X#n），要能看到它们在时间上真的分开；
  //   · 聚合：碎片继承母体色系、合并按**质量**混合 —— 质量与血缘都是内核回显的；
  //   · 永久：到末尾不回头，把时长翻倍再算，并**保住观众正看的那个时刻**。
  {
    // ---- (1) 默认就是"撞击碎裂"，而且碎片真的散开 ----
    const q = await open();
    await q.settle(4000);
    ok(q.$('collide').value === 'fragment',
       '全新打开的页面：碰撞模式默认是「撞击碎裂」（高速撞碎、低速重聚）');
    q.$('scenario').value = 'custom'; q.fire(q.$('scenario'), 'change');
    await q.settle(6000);
    const resp = q.lastResp();
    const kinds = (resp.events || []).map(e => e.kind);
    ok(kinds.includes('merge') && kinds.includes('fragment'),
       '默认那对 A/B 先并后碎（内核事件：' + kinds.join(' → ') + '）');
    const fragEv = (resp.events || []).find(e => e.kind === 'fragment');
    const debris = resp.bodies.map((b, i) => ({ id: b.id, i })).filter(o => o.id.indexOf('#') > 0);
    // ⚠ 别拿 `fragEv.fragments` 直接比 —— 那只是**第一次**碎裂的块数。
    //   页面默认阈值 `#fmin = 0.5`（与内核默认对齐）会让碎屑**再撞再碎**，
    //   登记表里的碎屑数是**各次碎裂之和**。实测：4 + 4 + 4 + 4 = 16 块。
    //   （这条判据原来是按"只碎一次"写的，把页面的默认阈值从 3 改成 0.5 之后立刻就见红了。）
    const totalFrag = (resp.events || []).filter(e => e.kind === 'fragment')
      .reduce((a, e) => a + (+e.fragments || 0), 0);
    ok(debris.length === totalFrag && fragEv && +fragEv.fragments >= 2,
       `登记表里的碎屑 ${debris.length} 块 = 内核各次碎裂回显之和 ${totalFrag}`
       + `（第一次碎裂 ${fragEv ? fragEv.fragments : '?'} 块，其余来自**级联**）；`
       + `与内核回的第一次 fragments 一致：${fragEv && +fragEv.fragments >= 2}`);
    // "分散"要能量出来：碎片两两之间的最大间距，最终应当比出生时大得多。
    // ⚠ 别只看"出生后 0.3 年"那一段 —— 实测它们**先挤在一起**（0.048 → 0.025 AU，1 年附近），
    //   之后才明显地炸开（1.3 年时 0.80 AU）。按 0.3 年取阈值会把"真的在散开"判成没散开。
    const dia = (fi) => {
      let mx = 0;
      for (const A of debris) for (const B of debris){
        if (A.i >= B.i) continue;
        const fr = resp.frames[fi];
        if (!fr || A.i >= fr.p.length || B.i >= fr.p.length) continue;
        const p = fr.p[A.i], r = fr.p[B.i];
        if (!p || !r) continue;
        mx = Math.max(mx, Math.hypot(p[0] - r[0], p[1] - r[1], p[2] - r[2]));
      }
      return mx;
    };
    const idxAt = (t) => {
      let best = 0, bd = Infinity;
      resp.frames.forEach((f, i) => { const d = Math.abs(f.t - t); if (d < bd){ bd = d; best = i; } });
      return best;
    };
    const dBirth = dia(idxAt(+fragEv.t + 1e-6));
    let dMax = 0, tMax = 0;
    resp.frames.forEach((f, i) => { const v = dia(i); if (v > dMax){ dMax = v; tMax = f.t; } });
    ok(dBirth > 0 && dMax > dBirth * 5,
       `碎片最终明显散开（出生 ${dBirth.toFixed(4)} AU → ${tMax.toFixed(2)} 年时 ${dMax.toFixed(3)} AU，`
       + (dMax / dBirth).toFixed(1) + ' 倍）');
    ok(+fragEv.ring_AU > 0, `内核还给了碎片环半径 ${fragEv.ring_AU} AU（出生时它们在那个环上）`);
    q.close();

    // ---- (2) 颜色按来源聚合 ----
    // 颜色从**图例**里读（那就是用户看到的那一份）。基础色先在"碰撞关"的那一份里取 ——
    // 那时谁都没合并过，图例上的就是本体自己的颜色；然后切回碎裂场景，把事件链按
    // 事件卡里写的那条规则**独立复算**一遍再比。这样判据验的是规则，不是页面的实现。
    const colorOfId = () => {
      const map = {};
      const html = p.$('legend').innerHTML;
      for (const m of html.matchAll(/background:(#[0-9a-fA-F]{6})"[^>]*><\/i>([^\s<]+)/g)) map[m[2]] = m[1];
      return map;
    };
    const hex2rgb = (h) => [1, 3, 5].map(k => parseInt(h.substr(k, 2), 16));
    const hexOf = (c) => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
    const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
    const mixOf = (c1, c2, w) => hex2rgb(c1).map((v, i) => v * (1 - w) + hex2rgb(c2)[i] * w);
    const norm = (h) => { const c = hex2rgb(h), s = c[0] + c[1] + c[2] || 1; return c.map(v => v / s); };
    const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
    // 用「行星撞地球」预设拿 A/B 那一对（前面几节已经用别的预设换过整份天体表了）
    const colPreset = [...p.d.querySelectorAll('#presets button')]
      .find(b => b.textContent.indexOf('行星撞地球') >= 0);
    ok(!!colPreset, '找得到「行星撞地球」预设（带 A/B 相撞的那一对）');
    p.fire(colPreset, 'click');
    await p.settle(8000);
    p.$('collide').value = 'off'; p.fire(p.$('collide'), 'change'); await p.settle(300);
    p.fire(p.$('compute'), 'click'); await p.settle(8000);
    const baseCol = colorOfId();
    ok(!!baseCol['A'] && !!baseCol['B'],
       `先取到本体基础色（A=${baseCol['A']} B=${baseCol['B']}，此时没合并过）`);
    p.$('collide').value = 'fragment'; p.fire(p.$('collide'), 'change'); await p.settle(300);
    p.fire(p.$('compute'), 'click'); await p.settle(9000);
    const rp = p.lastResp();
    let colNow = colorOfId();
    let fragIds = Object.keys(colNow).filter(id => id.indexOf('#') > 0);
    for (let attempt = 0; attempt < 3 && !fragIds.length; attempt++){
      await p.settle(5000);
      colNow = colorOfId();
      fragIds = Object.keys(colNow).filter(id => id.indexOf('#') > 0);
    }
    const parentOf = id => id.slice(0, id.indexOf('#'));
    ok(fragIds.length > 0, `碎裂后图例里有碎片：${fragIds.join(' ')}`);
    // ① 碎片：比母体深、彼此不同（规则写在事件卡里）
    const darkerOrEq = (c, root) => hex2rgb(c).every((v, i) => v <= hex2rgb(root)[i] + 1);
    const fragOk = fragIds.length > 0 && fragIds.every(id => colNow[parentOf(id)]
      && darkerOrEq(colNow[id], colNow[parentOf(id)]));
    ok(fragOk, `碎片继承母体色系（${fragIds.length} 块，例如 ${fragIds[0] || '（无）'} 比 `
      + `${parentOf(fragIds[0] || '#x')} 深）`);
    ok(new Set(fragIds.map(id => colNow[id])).size > 1,
       '而且不是同一个色 —— 按编号分深浅，看得出是几块不同的碎片');
    // ② 合并：A 吸收了 B，颜色应当 = 按**质量**混合（权重取内核的质量数）
    const byId = {};
    rp.bodies.forEach(b => { byId[b.id] = b; });
    const firstMerge = (rp.events || []).find(e => e.kind === 'merge' && e.a === 'A' && e.b === 'B');
    ok(!!firstMerge, '内核给了 A←B 的合并事件');
    const w = (+byId['B'].mass_msun) / (+firstMerge.mass_before || 1);
    const expect = mixOf(baseCol['A'], baseCol['B'], w);
    ok(near(hex2rgb(colNow['A']), expect, 3),
       `A 吸收 B 之后颜色 = 按质量混合（w=${w.toFixed(2)}，实测 ${colNow['A']} vs 期望 ${hexOf(expect)}）`);
    // 负样本：权重换个值（±0.3）必须判不一致
    const wBad = w > 0.5 ? w - 0.3 : w + 0.3;
    ok(!near(hex2rgb(colNow['A']), mixOf(baseCol['A'], baseCol['B'], wBad), 3),
       `负样本：权重换成 ${wBad.toFixed(2)}，同一处判不一致（说明"按质量"不是空话）`);
    // ③ 聚合会**传给后代**：碎片是母体"当时那条颜色"的变体，
    //    所以按色度（归一化 RGB）应当更像混合色、而不是更像母体原来那个色。
    const chromaCloserToMix = fragIds.filter(id => {
      const c = norm(colNow[id]);
      return dist(c, norm(hexOf(expect))) < dist(c, norm(baseCol['A']));
    });
    ok(fragIds.length > 0 && chromaCloserToMix.length === fragIds.length,
       `碎片带的是"混合后"的色（${chromaCloserToMix.length}/${fragIds.length} 块的色度更接近 A←B 的混合色，`
       + `而不是 A 原来的色）`);

    // ---- (3) 时长「永久」：到末尾不回头，翻倍再算，并接上当前时刻 ----
    const nb = () => p.fetchLog.filter(f => f.url.includes('/api/nbody')).length;
    const curYear = () => (parseFloat((p.$('tlabel').textContent.match(/t = ([\d.]+)/) || [])[1]) || 0);
    const setYears = async (y) => { p.$('years').value = String(y); p.fire(p.$('years'), 'change'); await p.settle(250); };
    // ⚠ 顺序与等待都要稳：手动定位（#fr_last）会**先暂停**，所以"先开播再跳末尾"等于没播；
    //   而"到末尾"是靠 tick 里那一帧触发的，跳没跳到位得**读画面确认**再开播。
    //   正负两种情形走同一段等待（不然比较不公平）。
    const seekToEnd = async () => {
      p.fire(p.$('fr_last'), 'click');
      for (let i = 0; i < 12; i++){
        await p.settle(150);
        if (curYear() >= (+p.$('years').value) * 0.98) return true;
      }
      return false;
    };
    const runToEndAndWait = async (ms = 3000) => {
      // ⚠ 先确保是**正向**播放：前面有一节测过倒放，那时 dir = −1 —— 于是"跳到末尾"之后
      //   画面会往回走，`frameF >= n-1` 那一支永远不触发（看到的现象是 t 稳定在 1.89 而不是 2.0）。
      if (/正放/.test(p.$('dirbtn').textContent)) { p.fire(p.$('dirbtn'), 'click'); await p.settle(150); }
      const seated = await seekToEnd();
      if (/播放/.test(p.$('play').textContent)) { p.fire(p.$('play'), 'click'); await p.settle(200); }
      const t0 = Date.now();
      let seen = '';
      // 延长期间画面应当**停在末尾**（新数据一到就接着播）。这里顺手把"延长之后看到的最小 t"
      // 记下来 —— 老写法 `if (!(perpetual && extendRun())) frameF = 0;` 在延长期间每帧归零，
      // 于是这个最小值会是 0（实测就是这条抓到的）。
      const nStart = nb();
      let ext = false, minAfterExt = Infinity;
      while (Date.now() - t0 < ms){
        p.step(3); await sleep(200);
        const cy = curYear();
        if (nb() > nStart){ ext = true; minAfterExt = Math.min(minAfterExt, cy); }
        seen = `t=${cy} 请求=${nb()} 方向=${/正放/.test(p.$('dirbtn').textContent) ? '倒' : '正'}`;
      }
      return { seated, seen, ext, minAfterExt };
    };
    await setYears(2);
    p.$('samples').value = '20'; p.fire(p.$('samples'), 'change'); await p.settle(250);
    p.fire(p.$('compute'), 'click'); await p.settle(2500);
    // 先验"关着的时候不会延长"
    p.$('perpetual').checked = false; p.fire(p.$('perpetual'), 'change'); await p.settle(200);
    const n0 = nb();
    const offRun = await runToEndAndWait();
    ok(offRun.seated && nb() === n0,
       `「永久」没勾时，跑到末尾就无缝循环，不会偷偷再算一次（${offRun.seen}）`);
    // 再验"勾上就会延长，而且时刻接得上"
    p.$('perpetual').checked = true; p.fire(p.$('perpetual'), 'change'); await p.settle(200);
    p.step(2); await sleep(60);
    ok(p.$('perpetual').checked === true && /时长：永久/.test(p.$('statline').textContent),
       '勾上之后页面确实进入了"永久"状态（状态行写明）：'
       + p.$('statline').textContent.slice(0, 90));
    await setYears(2);
    p.fire(p.$('compute'), 'click'); await p.settle(2500);
    const rBefore = p.respLog.length;
    const n1 = nb();
    const onRun = await runToEndAndWait();
    const n2 = nb();
    ok(n2 > n1, `勾上「永久」后到末尾会自动延长（内核请求 ${n1} → ${n2} 次；${onRun.seen}）`);
    // ⚠ 延长是**异步**的，所以不能跑完固定时长就去读时刻：
    //   那一刻可能正好"延长还在算"，也可能已经连做了好几次延长（2→4→8→16）。
    //   做法：先暂停（不再触发新的延长），再等响应真的到齐，最后才读。
    if (/播放/.test(p.$('play').textContent)) { p.fire(p.$('play'), 'click'); await p.settle(150); }
    for (let i = 0; i < 25 && p.respLog.length <= rBefore; i++){ p.step(1); await sleep(120); }
    p.step(1); await sleep(60);
    const lastReq = p.fetchLog.filter(f => f.url.includes('/api/nbody')).slice(-1)[0];
    const lastYears = +lastReq.body.years;
    ok(lastYears >= 4, `延长是把时长翻倍（年数 2 → ${lastYears}）`);
    ok(p.respLog.length > rBefore, `延长的结果已经落地（内核响应 ${rBefore} → ${p.respLog.length} 条）`);
    ok(onRun.ext && onRun.minAfterExt > 1.2,
       `**延长期间画面停在末尾**，没有闪回开头（延长后看到的最小 t = ${onRun.minAfterExt} 年；`
       + '老写法在延长那一瞬间会把 frameF 归零 → 画面闪回 t=0）');
    ok(curYear() > 1.2, `而且**接上了当前时刻**（画面 t = ${curYear()} 年，没有跳回开头）`);

    // ---- (4) 颜色规则要写在页面上（用户得知道那不是随机配色）----
    p.$('scenario').value = 'custom'; p.fire(p.$('scenario'), 'change');
    await p.settle(6000);
    const evNote = p.$('eventcard').textContent;
    ok(/按\s*来源|血缘|继承母体/.test(evNote) && /质量/.test(evNote),
       '事件卡里写明了颜色规则（按来源聚合 / 按质量混合），不是随手配的');
  }

  // ---------- 11. 球体颜色 = 生命形态；点一下出它的数据并把镜头对准它 ----------
  // 起因是一条使用反馈："行星颜色为生命形态，区分由点击出此行星数据并且改变视角"。
  // 要证的三件事，全部在**真画出来的那一笔**上读（画布桩记了 arc/fill/stroke/fillText
  // 以及那一刻的 fillStyle/strokeStyle），而不是从源码里正则匹配一个表达式：
  //   ① 球体填充色 == 内核给的阶 → 页面源码里那 9 格色阶（两个来源分开取）；
  //   ② 死寂天体是"灰调本色"，来源色挪到球外那圈细环上（颜色聚合没被丢掉）；
  //   ③ 点一颗 → 画面下方出它的数据（第一行就是生命形态）、镜头把它钉到画面正中心。
  {
    const r = await open();
    await r.settle(2500);
    // 阶是**在这段时长里**演化出来的（默认 50 年地球才长出生命）：第 0 帧人人都是
    // "死寂岩石"，那样子验不到"有生命 → 阶色"这一支，整节会变成空转。
    if (/暂停/.test(r.$('play').textContent)) { r.fire(r.$('play'), 'click'); await r.settle(300); }
    r.fire(r.$('fr_last'), 'click'); await r.settle(500);
    // ⚠ 标签写的是 "帧 (fi+1)/N"（给人看的从 1 起编号），取下标要减 1。
    //   不减也不会红（后面有 min(fi, len-1) 兜底），但那样就是"我用错的一帧数被夹住了"，
    //   而不是"我读对了"—— 判据不该靠兜底活着。
    const fi = +((r.$('tlabel').textContent.match(/帧 (\d+)\//) || [])[1] || 1) - 1;
    const resp = r.lastResp();
    ok(!!resp && !!resp.bio && Array.isArray(resp.bio.bodies),
       `内核回了演化数据，画面停在第 ${fi} 帧（默认 50 年的太阳系）`);

    // 期望值独立取：色阶与混色权重从**页面源码文本**里读（不调页面内部函数），
    // 来源色从图例的小圆点读（那是另一条通道，前面第 10 节已经单独验过它按血缘聚合）。
    const pageTxt = await (await nodeFetch(BASE + '/universe.html')).text();
    const STAGE = (pageTxt.match(/STAGE_COLORS\s*=\s*\[([^\]]*)\]/) || ['', ''])[1]
      .split(',').map(s => s.trim().replace(/^'|'$/g, ''));
    const DEADMIX = +((pageTxt.match(/LIFE_DEAD_MIX\s*=\s*([\d.]+)/) || [])[1]);
    const TINTB = +((pageTxt.match(/LIFE_TINT_BASE\s*=\s*([\d.]+)/) || [])[1]);
    const TINTP = +((pageTxt.match(/LIFE_TINT_PER\s*=\s*([\d.]+)/) || [])[1]);
    const HALOB = +((pageTxt.match(/LIFE_HALO_BASE\s*=\s*([\d.]+)/) || [])[1]);
    ok(STAGE.length === 9 && DEADMIX > 0 && DEADMIX < 1,
       `从页面源码读到 9 格阶色阶 + 死寂混色权重 LIFE_DEAD_MIX=${DEADMIX}`);
    ok(TINTB > 0 && TINTB < 1 && TINTP > 0 && TINTP < 0.5 && HALOB > 0,
       `生命染色的权重与柔光底数也读到了：LIFE_TINT_BASE=${TINTB}、每阶 +${TINTP}、`
       + `LIFE_HALO_BASE=${HALOB}`);
    const lin = {};
    for (const m of r.$('legend').innerHTML.matchAll(
         /background:(#[0-9a-fA-F]{6})"[^>]*><\/i>([^\s<]+)/g)) lin[m[2]] = m[1];
    const hx = h => String(h).toLowerCase();
    const rgb = h => [1, 3, 5].map(k => parseInt(h.substr(k, 2), 16));
    const nearC = (a, b, tol = 1) => !!a && !!b && rgb(a).every((v, i) => Math.abs(v - rgb(b)[i]) <= tol);
    const mixC = (c1, c2, w) => '#' + rgb(c1).map((v, i) =>
      Math.max(0, Math.min(255, Math.round(v * (1 - w) + rgb(c2)[i] * w)))
        .toString(16).padStart(2, '0')).join('');
    const lumOf = h => { const v = rgb(h).map(x => x / 255)
      .map(x => x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
      return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    const blueOf = h => { const v = rgb(h); return v[2] - v[0]; };
    const tintW = s => Math.min(1, TINTB + TINTP * Math.max(0, s | 0));

    // ---- 期望值：物质那一层**另写一份实现**（与页面同一条规则、不同一份代码）----
    // 读进来的是页面的**参数**（族的清单、族基调色与密度锚点、渲染用的常数），
    // 复算的是**规则**。页面里少一个系数、写错一个指数、锚点写反，这里立刻对不上。
    const FAM_KEYS = [['star','MAT_STAR'],['remnant','MAT_REMNANT'],['brown','MAT_BROWN'],
                      ['gas','MAT_GAS'],['ice','MAT_ICE'],['rock','MAT_ROCK']];
    const famTables = {};
    FAM_KEYS.forEach(([fam, key]) => {
      const blk = (pageTxt.match(new RegExp(key + '\\s*=\\s*\\[([\\s\\S]*?)\\]')) || [,''])[1];
      famTables[fam] = [...blk.matchAll(/'([A-Za-z_0-9]+)'/g)].map(x => x[1]);
    });
    ok(FAM_KEYS.every(([f]) => famTables[f].length > 0),
       `从页面源码读到 6 个物质族的成员清单（${FAM_KEYS.map(([f]) =>
         f + ':' + famTables[f].length).join(' ')}）`);
    const famOf = t => { for (const [f] of FAM_KEYS) if (famTables[f].includes(t)) return f; return 'none'; };
    const MT = {};
    for (const fam of ['rock','gas','ice']){
      const blk = (pageTxt.match(new RegExp('^\\s*' + fam + ':\\s*\\{([^}]*)\\}', 'm')) || [,''])[1];
      const g = k => ((blk.match(new RegExp(k + ":\\s*'(#[0-9a-fA-F]{6})'")) || [])[1]);
      const n = k => +((blk.match(new RegExp(k + ":\\s*([\\d.]+)")) || [])[1]);
      MT[fam] = { lo: g('lo'), mid: g('mid'), hi: g('hi'),
                  rlo: n('rlo'), rmid: n('rmid'), rhi: n('rhi') };
    }
    ok(['rock','gas','ice'].every(f => MT[f].lo && MT[f].mid && MT[f].hi
        && MT[f].rlo < MT[f].rmid && MT[f].rmid < MT[f].rhi),
       '读到行星三族的基调色与密度锚点（且锚点递增：'
       + ['rock','gas','ice'].map(f => f + ' ' + MT[f].rlo + '/' + MT[f].rmid + '/'
         + MT[f].rhi).join('，') + '）');
    const DENSE = ((pageTxt.match(/MAT_DENSE_TONE\s*=\s*'([^']+)'/) || [])[1] || '').toLowerCase();
    const BHTONE = ((pageTxt.match(/MAT_BH_TONE\s*=\s*'([^']+)'/) || [])[1] || '').toLowerCase();
    // 褐矮星那一档：页面把它往一个更暗更红的色上压（真实褐矮星比同温度的黑体色暗得多）。
    // 那两个参数也从源码里读 —— 不然判据里写死一份、页面改一份，就走散了。
    const BROWNT = ((pageTxt.match(/return mixColor\(c, '(#[0-9a-fA-F]{6})',/) || [])[1] || '').toLowerCase();
    const BROWNK = +((pageTxt.match(/return mixColor\(c, '#[0-9a-fA-F]{6}', ([\d.]+)\)/) || [])[1]);
    ok(DENSE.startsWith('#') && BHTONE.startsWith('#') && BROWNT.startsWith('#')
       && BROWNK > 0 && BROWNK < 1,
       `读到页面自己定的三个色值（内核在 t_eff_K 上给不出温度的那几档）：`
       + `中子星族 ${DENSE}、黑洞 ${BHTONE}、褐矮星往 ${BROWNT} 压 ${BROWNK}`);
    // 黑体色温 → sRGB：把页面用的那套公开近似**另写一份**。
    // 为什么可以"重写一遍"：它是显示层的渲染映射、不是物理量，页面自己也这么标注了
    // （_check_bio_page.js 有一条专门查它没被说成物理）。判据的意义在于
    // 「页面那个函数算出来的颜色 == 这里这份清单算出来的颜色」。
    const bb = T => {
      if (!(T > 0)) return null;
      const t = Math.max(1000, Math.min(40000, T)) / 100;
      const cl = v => Math.max(0, Math.min(255, Math.round(v)));
      const rr2 = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
      const gg = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661
                         : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
      const bbv = t >= 66 ? 255
               : (t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307);
      return '#' + [cl(rr2), cl(gg), cl(bbv)].map(v => v.toString(16).padStart(2, '0')).join('');
    };
    // 参照自身的两个性质先被验一遍（不然"参照"本身可疑）：越热越蓝、越冷越红
    ok(blueOf(bb(20000)) > blueOf(bb(5778)) && blueOf(bb(5778)) > blueOf(bb(3200)),
       `参照本身站得住：色温→sRGB 的次序是对的（20000 K ${bb(20000)} / `
       + `5778 K ${bb(5778)} / 3200 K ${bb(3200)}，蓝度递减）`);
    const toneOf = bd => {
      const fam = famOf(String(bd.type || ''));
      if (fam === 'star'){ const c = bb(bd.t_eff_K); return c ? hx(c) : hx(lin[bd.id]); }
      if (fam === 'remnant'){
        if (String(bd.type) === 'black_hole') return hx(BHTONE);
        const c = bb(bd.t_eff_K); return c ? hx(c) : hx(DENSE);
      }
      if (fam === 'brown'){ const c = bb(bd.t_eff_K) || MT.gas.hi; return hx(mixC(c, BROWNT, BROWNK)); }
      if (fam === 'gas' || fam === 'ice' || fam === 'rock'){
        const s = MT[fam], rho = +bd.density_g_cm3;
        if (!(rho > 0)) return hx(MT.rock.mid);
        const w = (rho - s.rlo) / (s.rmid - s.rlo);
        return hx(w <= 1 ? mixC(s.lo, s.mid, Math.max(0, w))
                         : mixC(s.mid, s.hi, Math.min(1, (rho - s.rmid) / (s.rhi - s.rmid))));
      }
      return hx(lin[bd.id]);
    };

    // 把"哪一笔填充属于哪颗天体"从绘制日志里还原出来：
    // 页面的顺序是 [细环 stroke] → [填充 fill] → 写名字 fillText(id)。
    // ⚠ 日志里叠着整段播放过程里每一帧的绘制，而天体的屏幕位置在那些帧里是变的；
    //   所以后面凡是"按圆心认领某颗天体周围的画法"的地方，都只在 logAll.slice() 的
    //   **该天体最后那一段**上找（见 segOf），不在整份日志上按坐标捞。
    const logAll = r.drawLog.slice();
    const seen = {};
    let pendFill = null, pendStroke = null;
    for (const e of logAll){
      if (e.k === 'stroke' && e.arc) pendStroke = e;
      else if (e.k === 'fill' && typeof e.style === 'string' && e.arc) pendFill = e;
      else if (e.k === 'text' && resp.bodies.some(b => b.id === e.s) && pendFill){
        seen[e.s] = { fill: hx(pendFill.style), r: pendFill.arc[2],
          x: pendFill.arc[0], y: pendFill.arc[1],
          ring: pendStroke ? hx(pendStroke.style) : null,
          dr: (pendStroke && pendStroke.arc) ? +(pendStroke.arc[2] - pendFill.arc[2]).toFixed(2) : null };
      }
    }
    const ids = resp.bodies.map(b => b.id);
    ok(ids.every(id => seen[id]),
       `每颗天体都从绘制日志里认了出来（${ids.filter(id => seen[id]).length}/${ids.length}）`);
    // 某颗天体**最后一次**被画出来的那一段（从它写名字的那一处往前到上一颗写名字之后）
    const bodyIds = new Set(ids);
    const segOf = id => {
      let end = -1;
      for (let i = logAll.length - 1; i >= 0; i--)
        if (logAll[i].k === 'text' && logAll[i].s === id){ end = i; break; }
      if (end < 0) return [];
      let start = 0;
      for (let i = end - 1; i >= 0; i--)
        if (logAll[i].k === 'text' && logAll[i].s !== id && bodyIds.has(logAll[i].s)){ start = i + 1; break; }
      return logAll.slice(start, end + 1);
    };

    // 独立复算期望填充色：物质基调色 × 生命调制（阶从内核回显的 stage 数组取）
    const stageAt = id => {
      const s = (resp.bio.bodies[ids.indexOf(id)] || {}).stage || [];
      return (s.length ? s[Math.min(fi, s.length - 1)] : 0) | 0;
    };
    const isLight = id => !!((resp.bodies[ids.indexOf(id)] || {}).emits_light);
    const expectFill = id => {
      const bd = resp.bodies[ids.indexOf(id)] || {};
      const tone = toneOf(bd);
      if (isLight(id)) return tone;                    // 恒星/遗迹：保持物质色
      const st = stageAt(id);
      return st >= 1 ? hx(mixC(tone, STAGE[st], tintW(st)))
                     : hx(mixC(tone, STAGE[0], DEADMIX));
    };
    const wrong = ids.filter(id => seen[id] && !nearC(seen[id].fill, expectFill(id)));
    ok(wrong.length === 0,
       '每颗球体的填充色 == 独立复算的期望（物质基调色 × 生命染色）'
       + (wrong.length ? ' — 对不上：' + wrong.slice(0, 6).map(id => id + ' 画成 ' + seen[id].fill
           + '，期望 ' + expectFill(id) + '（阶 ' + stageAt(id) + '）').join('；') : ''));

    const living = ids.filter(id => !isLight(id) && stageAt(id) >= 1);
    const dead = ids.filter(id => !isLight(id) && stageAt(id) === 0);
    ok(living.length >= 1 && dead.length >= 1,
       `这一段时长里既有活着的也有死寂的（有生命 ${living.map(id => id + '(' + stageAt(id) + ')').join(' ')}`
       + ` / 死寂 ${dead.length} 颗）—— 否则这一节是空转`);

    // ---- 11b. 物质：球体本色**不再**是"名字 → 颜色"那张表，而是从内核的类型/温度/密度推的 ----
    // 这一节要挡的是最安静的一种退化：物质这一层看着"配了色"，其实是把手挑的颜色
    // 原样抄了一遍 —— 那时"根据物质做成不同颜色"就是句空话，而画面上谁也看不出来。
    const KEY = ['Sun','Jupiter','Saturn','Uranus','Neptune','Earth','Mars','Pluto'];
    const have = KEY.filter(id => ids.includes(id) && seen[id]);
    const asIs = have.filter(id => nearC(seen[id].fill, lin[id], 6));
    ok(have.length >= 6 && asIs.length === 0,
       `球体本色不再等于"来源色表"里那个手挑的真实色（查了 ${have.length} 颗，`
       + `仍然等于来源色的 ${asIs.length} 颗）—— 物质色是从内核的 type/温度/密度推出来的`
       + (asIs.length ? '；撞上了：' + asIs.slice(0, 4).map(id => id + ' ' + seen[id].fill).join(' ') : ''));
    // 次序不变量：这些**由内核密度决定**、而且在现实里也成立的顺序，必须出现在画布上。
    // （冰巨星的深浅就是内核给的密度差：天王星 1.27 偏青、海王星 1.64 偏蓝；
    //   土星 0.69 比木星 1.33 淡 —— 这两条都是可观测事实，不是我们挑出来的好看。）
    // 先钉住"这三个取样点在**这一段时长里确实是死寂的**"：活着的话球体会被阶色染色，
    // 那时比"色相次序"比的是生命那一层，这一节就成了空转（本项目的例行要求）。
    const icy3 = ['Jupiter', 'Uranus', 'Neptune'];
    ok(icy3.every(id => dead.includes(id)),
       `取样点是可判的：木星/天王星/海王星在这一帧都是死寂的（否则下面比的是生命那一层）`
       + ` —— 实际 ${icy3.map(id => id + ':' + (dead.includes(id) ? '死寂' : '有生命')).join(' ')}`);
    if (seen.Uranus && seen.Neptune && seen.Jupiter){
      ok(blueOf(seen.Neptune.fill) > blueOf(seen.Uranus.fill)
         && blueOf(seen.Uranus.fill) > blueOf(seen.Jupiter.fill),
         `物质的色相次序对得上内核的密度：海王星(1.639)比天王星(1.271)更蓝、天王星比木星(1.327)更蓝`
         + `（蓝度 ${blueOf(seen.Neptune.fill).toFixed(0)} > ${blueOf(seen.Uranus.fill).toFixed(0)}`
         + ` > ${blueOf(seen.Jupiter.fill).toFixed(0)}）`);
    }
    if (seen.Saturn && seen.Jupiter){
      ok(lumOf(seen.Saturn.fill) > lumOf(seen.Jupiter.fill),
         `土星(0.687)比木星(1.327)淡 —— 同一族的密度锚点两端：`
         + `相对亮度 ${lumOf(seen.Saturn.fill).toFixed(3)} > ${lumOf(seen.Jupiter.fill).toFixed(3)}`);
    }
    // 负样本：把密度的锚点顺序反过来，同一处必须判不一致（自证"按密度定深浅"不是空话）
    {
      const s = MT.rock;
      const flipLo = hx(mixC(s.hi, s.mid, 0.03));
      const real = toneOf({ type: 'rock', density_g_cm3: 1.862 });
      ok(!nearC(real, flipLo, 4),
         `负样本：把密度锚点反着代进去会得到另一个颜色（冥王星 ρ=1.862 实得 ${real}，`
         + `反过来代是 ${flipLo}）—— 所以"按密度定深浅"这一条真的在起作用`);
    }

    // ---- 11c. 大小：球的像素半径 == 内核 radius_km 的对数压缩（独立复算）----
    const SZ = {
      ref: +((pageTxt.match(/SIZE_REF_KM\s*=\s*([\d.]+)/) || [])[1]),
      k:   +((pageTxt.match(/SIZE_LOG_K\s*=\s*([\d.]+)/) || [])[1]),
      base:+((pageTxt.match(/SIZE_BASE\s*=\s*([\d.]+)/) || [])[1]),
      min: +((pageTxt.match(/SIZE_MIN\s*=\s*([\d.]+)/) || [])[1]),
      max: +((pageTxt.match(/SIZE_MAX\s*=\s*([\d.]+)/) || [])[1]),
    };
    ok(SZ.ref > 0 && SZ.k > 0 && SZ.min > 0 && SZ.max > SZ.min,
       `读到大小映射的参数：参考半径 ${SZ.ref} km、对数系数 ${SZ.k}、`
       + `clamp(${SZ.min}, ${SZ.max}) px`);
    const sizeR = km => (km > 0)
      ? Math.max(SZ.min, Math.min(SZ.max, SZ.base + SZ.k * Math.log10(km / SZ.ref))) : 4.5;
    const badR = ids.filter(id => {
      const km = +((resp.bodies[ids.indexOf(id)] || {}).radius_km);
      return seen[id] && Math.abs(seen[id].r - sizeR(km)) > 0.05;
    });
    ok(badR.length === 0,
       '每颗球画出来的半径 == 由内核 radius_km 独立复算的对数压缩值（'
       + have.slice(0, 4).map(id => id + ' ' + seen[id].r.toFixed(1) + 'px').join('，') + ' …）'
       + (badR.length ? ' — 对不上：' + badR.slice(0, 5).map(id => id + ' 画成 '
           + seen[id].r.toFixed(2) + '，期望 '
           + sizeR(resp.bodies[ids.indexOf(id)].radius_km).toFixed(2)).join('；') : ''));
    // 压缩必须是真的：否则这一节只是把 radius_km 换了个单位写
    if (seen.Sun && seen.Earth){
      const trueRatio = resp.bodies[ids.indexOf('Sun')].radius_km
                      / resp.bodies[ids.indexOf('Earth')].radius_km;
      const drawRatio = seen.Sun.r / seen.Earth.r;
      ok(trueRatio > 50 && drawRatio < 4,
         `大小真的是对数压缩的：真实半径比 ${trueRatio.toFixed(0)}×（太阳/地球），`
         + `画布上只剩 ${drawRatio.toFixed(2)}× —— 一比一的话地球在这张图上不到 0.02 px`);
      ok(drawRatio > 1.05, `而且次序还在（大的画得确实更大：${drawRatio.toFixed(2)}× > 1）`);
    }
    ok(Math.abs(sizeR(12) - SZ.min) < 1e-9 && Math.abs(sizeR(1e9) - SZ.max) < 1e-9,
       `极小与极大的天体被夹在最小可见尺寸与上限上（12 km → ${sizeR(12)} px，`
       + `10 亿 km → ${sizeR(1e9)} px）—— 太小看不见、太大糊成一片，两头都要夹`);

    // ---- 11d. 代谢：活着的天体外面有阶色柔光，死寂的一个都没有 ----
    // 这是"有没有生命"的第二条可见通道（第一条是球体被阶色染色）。
    // 读法：球心处的**渐变**填充里，有没有一个半径明显大于球本身的。
    const haloRadii = id => {
      const c = seen[id]; if (!c) return [];
      return segOf(id).filter(e => e.k === 'fill' && typeof e.style !== 'string' && e.arc
        && Math.abs(e.arc[0] - c.x) <= 0.5 && Math.abs(e.arc[1] - c.y) <= 0.5).map(e => e.arc[2]);
    };
    const haloed = living.filter(id => haloRadii(id).some(x => x >= seen[id].r + 8));
    ok(living.length > 0 && haloed.length === living.length,
       `活着的天体都画了那圈阶色柔光（${haloed.length}/${living.length}；例：${living[0]} `
       + `球 ${seen[living[0]].r.toFixed(1)} px，柔光半径 `
       + (haloRadii(living[0]).filter(x => x >= seen[living[0]].r + 8).map(x => x.toFixed(1))
          .join('/') || '（没有）') + ' px）');
    const deadHalo = dead.filter(id => haloRadii(id).some(x => x > seen[id].r + 6));
    ok(deadHalo.length === 0,
       `负样本：死寂天体一个柔光都没有（${dead.length} 颗全查过，命中 ${deadHalo.length} 颗）`
       + ' —— 灰调 + 无光两个信号一起说"这里没有生命"');

    // 光源不参与：它的填充就该是**由它自己的表面温度算出来的黑体色**
    if (ids.some(isLight)){
      const s0 = ids.find(isLight);
      const bd0 = resp.bodies[ids.indexOf(s0)] || {};
      const want = bb(bd0.t_eff_K) ? hx(bb(bd0.t_eff_K)) : hx(lin[s0]);
      ok(nearC(seen[s0].fill, want, 1),
         `光源（${s0}）不套生命形态色：球体本色 == 由它的表面温度 ${bd0.t_eff_K} K `
         + `按黑体色算出的 ${want}（画成 ${seen[s0].fill}）`);
      ok(!nearC(seen[s0].fill, lin[s0], 4),
         `负样本：它也**不再**是来源色表里的 ${lin[s0]}（物质那一层真的把它接管了）`);
    }

    // 来源色没丢 —— 它画在球外那圈细环上（半径比球体本身大一点点）
    const ringed = dead.filter(id => seen[id] && nearC(seen[id].ring, lin[id], 1)
      && seen[id].dr >= 2 && seen[id].dr <= 4.5);
    ok(ringed.length === dead.length,
       `死寂天体的来源色都落在球外那圈细环上（${ringed.length}/${dead.length} 颗；`
       + `例：${dead[0]} 环=${seen[dead[0]] && seen[dead[0]].ring}，比球体大 ${seen[dead[0]] && seen[dead[0]].dr} px）`);
    ok(!Object.keys(seen).some(id => seen[id].ring && nearC(seen[id].ring, '#123456', 1)),
       '负样本：随便编一个颜色 #123456，同一个查找必须找不到（自证环色是读出来的）');

    // 图例得自己说清**三个**通道 + 怎么区分个体
    const legTxt = r.$('legend').textContent;
    ok(/球体颜色\s*=\s*物质\s*×\s*生命/.test(legTxt) && /球外细环\s*=\s*来源色/.test(legTxt),
       '图例写明了三个颜色通道各管什么（球体 = 物质 × 生命 / 细环 = 来源色）');
    ok(/对数压缩/.test(legTxt) && /不是一比一/.test(legTxt),
       '图例还说清了球的大小是**对数压缩**的、不是一比一（否则"画得小"会被读成"它真的小"）');
    ok(/点它/.test(legTxt), '并且写明"认不出谁是谁就点它一下"（点击就是区分手段）');

    // ---- 点一颗有生命的天体：数据卡 + 视角 ----
    const target = living[0], t0 = seen[target];
    ok(!!t0 && t0.r > 0, `已量出 ${target} 画在 (${t0 && Math.round(t0.x)}, ${t0 && Math.round(t0.y)})，接下来点它`);
    const cardBefore = r.$('selcard').style.display;
    mouse(r, t0.x, t0.y);
    await r.settle(600);
    ok(cardBefore === 'none' && r.$('selcard').style.display === 'block',
       '点中它之后数据卡从隐藏变成出现，而且它就在画面下方（画布之后第 '
       + [...r.d.querySelectorAll('.card, #selcard')].indexOf(r.$('selcard')) + ' 块）');
    const stName = (resp.bio.stage_names || [])[stageAt(target)];
    const cardTxt = r.$('selbody').textContent;
    ok(!!stName && cardTxt.indexOf(stName) >= 0,
       `卡上给出了它的生命形态「${stName}」（阶名来自内核回显，页面不自己抄）`);
    // 卡上那个色点必须等于**画布上真画出来的那一笔**（不是等于阶色 ——
    // 阶色只是球体颜色的一半，另一半是物质底色；拿阶色当期望是本轮改版前那一版的说法）。
    const dot = (r.$('selbody').innerHTML.match(/<i class="dot"[^>]*background:(#[0-9a-fA-F]{6})/) || [])[1];
    ok(nearC(dot, seen[target].fill, 1),
       `卡上那个色点与画布上球体那一笔是同一个颜色（卡 ${dot} == 画布 ${seen[target].fill}）`);
    const pureTone = toneOf(resp.bodies[ids.indexOf(target)]);
    ok(!nearC(dot, pureTone, 1) && !nearC(dot, STAGE[stageAt(target)], 1),
       `负样本：卡上的色点既不是**纯物质底色** ${pureTone}、也不是**纯阶色** `
       + `${STAGE[stageAt(target)]} —— 两层真的都混在里面`);
    ok(/物质/.test(cardTxt) && /来源色/.test(cardTxt),
       '卡上把三层都说清了：球体色 = 物质 × 生命、来源色是球外那圈细线');
    ok(/镜头已对准/.test(r.$('toolnote').textContent), '并且说清了镜头已经对准它');

    // 视角：重画一帧，量它现在画在哪儿 —— 应当正好落在画面中心
    r.drawLog.length = 0; r.arcs.length = 0;
    r.step(1); await sleep(40);
    const seen2 = {}; let pf = null;
    for (const e of r.drawLog){
      if (e.k === 'fill' && typeof e.style === 'string' && e.arc) pf = e;
      else if (e.k === 'text' && ids.includes(e.s) && pf) seen2[e.s] = { x: pf.arc[0], y: pf.arc[1] };
    }
    const cc = seen2[target];
    const dC = cc ? Math.hypot(cc.x - 400, cc.y - 300) : Infinity;
    ok(dC < 3, `镜头把 ${target} 钉在了画面正中心（离中心 ${dC.toFixed(1)} px）—— 这就是"改变视角"`);
    ok(!(cc && Math.hypot(cc.x - 400, cc.y - 100) < 20),
       '负样本：拿画面上的**另一个位置**当期望，同一个量法判不居中（自证这个比法不是恒真）');
    ok(r.texts.some(t => String(t).indexOf(stName) === 0),
       '它的阶名也写在它旁边（画布上就有一份，不用挪眼去看卡片）');

    // 卡上那个「✕ 取消选中 · 回全景」得是一个真出口（不然只能靠猜"点空白处"）
    r.fire(r.$('selclose'), 'click'); await r.settle(400);
    ok(r.$('selcard').style.display === 'none', '按「✕ 取消选中 · 回全景」卡收起来');
    const s3 = JSON.parse(r.w.localStorage.getItem('starpivot.universe.session') || '{}');
    ok(s3.cam && s3.cam.follow === -1 && Math.abs(s3.view.panX) < 1 && Math.abs(s3.view.panY) < 1,
       `松开跟随并且平移量归零（panX=${s3.view && s3.view.panX}），不是把人留在那一小块上`);

    const realErrs2 = r.errs.filter(e => !/Not implemented/.test(e));
    ok(realErrs2.length === 0, '这一节全程无脚本异常' + (realErrs2.length ? ' — ' + realErrs2[0] : ''));
    r.close();
  }

  // ---------- 12. 撞的那一下要看得见：闪光 / 扩散的冲击环 / 从撞击点拉出的碎屑扇 ----------
  // 起因是一条使用反馈："碰撞要开始朝着这个方向去做"（用户附了一张图，那张图在本机读不到，
  // 用户口述了三个方向）。这一节钉**显示层**的两件：
  //   ② 撞的那一下画布上有表现（闪光 + 一圈往外扩的冲击环），此前"撞完什么都不发生"；
  //   ③ 碎屑要在画面上看出是**成束溅射** —— 看得见的那一半是"所有碎屑的线从**同一个点**拉出来"；
  //      另一半（碎屑真的朝那个方向飞、而且沿轴拉长）在内核里，由 _probe_collide.py 的 C2 节钉住。
  // （④"碎片再撞再碎"是内核行为，这里只顺带确认页面默认参数下它真的发生了。）
  //
  // ⚠ 为了能量"线是从哪一点拉出来的"，本探针的画布桩**新记了 moveTo / lineTo**：
  //   原来只记 arc/fill/stroke/fillText，而 stroke() **不带坐标** —— 它记的是那一刻的 lastArc，
  //   那是**上一次 arc() 的陈旧值**（轨道/环用 arc 或 ellipse 画，喷流用折线画）。
  //   拿陈旧值当线的端点会得出假的结论。
  //
  // 选择器都是从**实测日志**里读出来的（先量、再写断言），不是从源码里猜表达式：
  //   * 喷流 = `move → line → stroke` 紧挨着三笔，**且描边色是十六进制**（`#rrggbb`）、
  //     alpha ∈ (0, 0.55]。轨道拖尾也是"两笔折线"，但它的色写成 `rgba(122,150,200,0.16)` ——
  //     不筛颜色的话会把 29 条轨迹段当成喷流（第一版就是这么错的）。
  //   * 冲击环 = 完全不透明的 `rgba(r,g,b,1)` 描边，且**紧跟**一次同半径的 `arc()`。
  //     球外那圈细环用十六进制本色 + alpha 0.9，轨道拖尾用 `rgba(...,<1)`，据此分开。
  //   * 球 = 十六进制本色 + alpha 0.9 + 紧跟一次同半径 `arc()`（= 那颗球当时画在哪儿）。
  {
    const s = await open();
    await s.settle(3000);
    if (/暂停/.test(s.$('play').textContent)) { s.fire(s.$('play'), 'click'); await s.settle(300); }
    // 年数**写死**，不让判据跟着页面的默认值走；用页面上那对必然会撞的 A/B（内核实测 t≈0.798 年）。
    s.$('years').value = '20'; s.fire(s.$('years'), 'change');
    s.$('scenario').value = 'custom'; s.fire(s.$('scenario'), 'change');
    await s.settle(12000);
    const resp = s.lastResp();
    ok(!!resp && Array.isArray(resp.events) && resp.events.length >= 2,
       `自定义场景算出来了：${((resp && resp.events) || []).length} 个碰撞事件 / `
       + `${((resp && resp.bodies) || []).length} 个天体（至少要有"并"和"碎"各一次）`);
    const N = resp.frames.length;
    const t0 = resp.frames[0].t, t1 = resp.frames[N - 1].t;
    const fragEv = (resp.events || []).find(e => e.kind === 'fragment');
    const mergeEv = (resp.events || []).find(e => e.kind === 'merge');
    ok(!!fragEv && !!mergeEv && +fragEv.fragments >= 2,
       `内核给了 merge（${mergeEv && mergeEv.a}←${mergeEv && mergeEv.b}，t=${mergeEv && mergeEv.t} 年）`
       + ` 与 fragment（母体 ${fragEv && fragEv.a}，${fragEv && fragEv.fragments} 块，t=${fragEv && fragEv.t} 年）`);

    // 页面把"撞击表现持续多久"定成一个**比例**（纯显示参数）。从页面源码里读它，
    // 这样后面挑"窗口内 / 窗口外"的帧不是靠我写死的数。
    const pageTxt = await (await nodeFetch(BASE + '/universe.html')).text();
    const FRAC = +((pageTxt.match(/IMPACT_WIN_FRAC\s*=\s*([\d.]+)/) || [])[1]);
    ok(FRAC > 0 && FRAC <= 0.2,
       `页面用一个比例决定撞击表现持续多久：IMPACT_WIN_FRAC=${FRAC}（占模拟总时长，这里是 `
       + `${((t1 - t0) * FRAC).toFixed(2)} 年）—— 它不参与任何计算`);
    const tWin = (t1 - t0) * FRAC;

    // 图例给出"每颗天体自己的颜色"（那是**来源/血缘色**，第 10 节已单独验过它按质量混合）。
    // 喷流的线用色是否就是碎屑自己的色，靠它来对。
    const lin = {};
    for (const m of s.$('legend').innerHTML.matchAll(
         /background:(#[0-9a-fA-F]{6})"[^>]*><\/i>([^\s<]+)/g)) lin[m[2]] = m[1];
    const A = fragEv.a;
    ok(!!lin[A], `图例里有母体 ${A} 的来源色 ${lin[A]}（下面是"喷流用色对不对"的对照物）`);

    const rgbaN = t => (t.match(/\d+/g) || []).map(Number);
    const idxAt = tt => { let b = 0, bd = Infinity;
      resp.frames.forEach((f, i) => { const d = Math.abs(f.t - tt); if (d < bd){ bd = d; b = i; } }); return b; };
    const aliveAt = (b, now) => (b.born_at || 0) <= now + 1e-9
      && (b.died_at === undefined || b.died_at === null || b.died_at >= now - 1e-9);

    // 把某一帧真画出来。⚠ 时间滑条是 0–1000 的**整数**，所以只有一部分帧号**可达**
    //   （实测 2001 帧时只能落到偶数帧）。因此这里的 t/fi **从画面上那行标签读回来**，
    //   而不是用我想要的那个 t —— 第一版就是拿"想要的 t"当"渲染的 t"，
    //   于是把第 80 帧当成第 79 帧，得出"母体在这一帧没画"的假结论。
    const obs = async v => {
      s.$('scrub').value = String(v);
      s.fire(s.$('scrub'), 'input');
      s.drawLog.length = 0;
      s.step(1); await sleep(45);
      const lbl = s.$('tlabel').textContent;
      const fi = +(((lbl.match(/帧 (\d+)\//) || [])[1]) || 0) - 1;   // 标签从 1 起编号
      const t = parseFloat((lbl.match(/t = ([\d.]+)/) || [])[1]);
      const log = s.drawLog.slice();
      const rings = [], balls = [], jets = [];
      for (let i = 1; i < log.length; i++){
        const e = log[i];
        if (e.k !== 'stroke' || typeof e.style !== 'string') continue;
        const st = e.style, fresh = log[i - 1].k === 'arc' && e.arc
          && Math.abs(log[i - 1].r - e.arc[2]) < 1e-9;
        if (fresh && /^rgba\(\d{1,3},\d{1,3},\d{1,3},1\)$/.test(st) && e.arc[2] > 3){
          // 紧跟其后应当有一个以**同一圆心**画的闪光（径向渐变 → fillStyle 不是字符串）
          const fl = (log[i + 1] && log[i + 1].k === 'arc'
            && log[i + 2] && log[i + 2].k === 'fill' && typeof log[i + 2].style !== 'string')
            ? { cx: log[i + 1].x, cy: log[i + 1].y, r: log[i + 1].r } : null;
          rings.push({ i, cx: e.arc[0], cy: e.arc[1], r: e.arc[2], style: st, alpha: +e.alpha, flash: fl });
        } else if (fresh && /^#[0-9a-fA-F]{6}$/.test(st) && +e.alpha === 0.9){
          balls.push({ i, cx: e.arc[0], cy: e.arc[1], style: st.toLowerCase() });
        }
      }
      for (let i = 2; i < log.length; i++){
        const e = log[i];
        if (e.k !== 'stroke') continue;
        if (!(log[i - 1].k === 'line' && log[i - 2].k === 'move')) continue;
        if (typeof e.style !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(e.style)) continue;
        const a = +e.alpha;
        if (!(a > 0 && a <= 0.55)) continue;      // 轨道拖尾是 alpha 0.9 + rgba 色，落不进这里
        jets.push({ i, from: [log[i - 2].x, log[i - 2].y], to: [log[i - 1].x, log[i - 1].y],
                    style: e.style.toLowerCase(), alpha: a });
      }
      return { v, fi, t, log, rings, jets, balls };
    };
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const vAt = tt => Math.round(idxAt(tt) / (N - 1) * 1000);
    const vEvent = vAt(fragEv.t);

    // ---- (2) 撞之前：环与喷流一个都不画（负样本，自证上面两个选择器不是恒有） ----
    const pre = await obs(vAt(fragEv.t - 0.5 * tWin));
    ok(pre.t < fragEv.t && pre.rings.length === 0 && pre.jets.length === 0,
       `负样本：撞之前（t=${pre.t} 年，比撞击早 ${(fragEv.t - pre.t).toFixed(2)} 年）画布上`
       + `既没有冲击环也没有喷流（环 ${pre.rings.length} 个 / 线 ${pre.jets.length} 条）`);

    // ---- (2a) 撞击点就是"内核说母体在哪儿"：环心 == 母体最后一帧被画出来的位置 ----
    // 母体的 `died_at` 正是事件时刻（内核给的），所以它在撞击前一帧还画着、撞击那一帧已经不在；
    // 而内核把它的位置**冻在撞击点**上（实测 frames[79].p[A] 与 frames[80].p[A] 逐位相同）。
    const ev = await obs(vEvent);
    // 沿时间往回找母体**还被画着**的帧（它 died_at 正是事件时刻）。顺手取两个样本：
    // 一比就得到"默认视角下 1 AU 有多少像素" —— 这是页面投影与内核世界坐标之间的一次实测对照，
    // 后面要解释"扇口为什么只有几个像素"就得靠它。
    const pi = resp.bodies.findIndex(x => x.id === A);
    const samp = [];
    for (let v = vEvent; v >= vEvent - 8 && v >= 0; v--){
      const o = await obs(v);
      if (!(o.t < fragEv.t - 1e-9)) continue;
      const b = o.balls.find(x => x.style === String(lin[A]).toLowerCase());
      const p = (pi >= 0 && o.fi >= 0 && resp.frames[o.fi]) ? resp.frames[o.fi].p[pi] : null;
      if (b && p) samp.push({ t: o.t, x: b.cx, y: b.cy, p });
      if (samp.length >= 2) break;
    }
    const anchor = samp[0] || null;
    const pxPerAU = samp.length === 2 ? (() => {
      const dpx = dist([samp[0].x, samp[0].y], [samp[1].x, samp[1].y]);
      const dau = Math.hypot(samp[0].p[0] - samp[1].p[0], samp[0].p[1] - samp[1].p[1],
                             samp[0].p[2] - samp[1].p[2]);
      return dau > 0 ? dpx / dau : null;
    })() : null;
    const R0 = ev.rings[0];
    const dAnchor = (anchor && R0) ? dist([anchor.x, anchor.y], [R0.cx, R0.cy]) : null;
    ok(!!anchor && !!R0 && dAnchor < 0.6,
       `撞击点不是页面挑的：母体 ${A} 最后一帧（t=${anchor && anchor.t} 年）画在 `
       + `(${anchor && anchor.x.toFixed(1)}, ${anchor && anchor.y.toFixed(1)})，`
       + `冲击环就画在同一处（${R0 && R0.cx.toFixed(1)}, ${R0 && R0.cy.toFixed(1)}，差 `
       + `${dAnchor === null ? '（没量到）' : dAnchor.toFixed(2)} px）—— 位置来自内核事件 + 内核逐帧坐标`);
    ok(pxPerAU !== null && pxPerAU > 1,
       `默认视角的像素尺度（= 母体相邻帧的**屏幕位移 ÷ 内核给的世界位移**，一次实测对照）：`
       + `≈ ${pxPerAU === null ? '?' : pxPerAU.toFixed(1)} px/AU —— 整屏 800 px 要装下整个太阳系，`
       + '所以 1 AU 只有几个像素；这是后面"扇口很窄"的原因，不是画错了');
    ok(ev.rings.length === (resp.events || []).filter(e => Math.abs(e.t - fragEv.t) < 1e-9).length,
       `撞击那一刻画了 ${ev.rings.length} 个环，与"同一时刻的内核事件数"一致`
       + `（并：${mergeEv && mergeEv.kind} + 碎：${fragEv && fragEv.kind}）`);

    // ---- (2b) 环会往外扩、会衰减；闪光在环心；环心钉在原地 ----
    const o1 = await obs(vAt(fragEv.t + 0.2 * tWin));
    const o2 = await obs(vAt(fragEv.t + 0.8 * tWin));
    ok(o1.rings.length >= 1 && o2.rings.length >= 1,
       `撞击后两个时刻都画出了冲击环（t=${o1.t} 年 ${o1.rings.length} 个 / t=${o2.t} 年 ${o2.rings.length} 个）`);
    const R1 = o1.rings[0], R2 = o2.rings[0];
    ok(R2.r > R1.r * 2,
       `冲击环随年龄往外扩：${(0.2 * tWin).toFixed(2)} 年后半径 ${R1.r.toFixed(1)} px → `
       + `${(0.8 * tWin).toFixed(2)} 年后 ${R2.r.toFixed(1)} px（${(R2.r / R1.r).toFixed(2)} 倍）`);
    ok(Math.abs(R2.r - R1.r) > 1,
       '负样本：两个时刻的半径差的不是一星半点（同一比法不会"因为都一样"而恒过）');
    ok(R1.alpha > R2.alpha * 2 && R2.alpha > 0,
       `闪光/环随年龄衰减：alpha ${R1.alpha.toFixed(3)} → ${R2.alpha.toFixed(3)}（但不会提前消失）`);
    ok(o1.rings.every(r => r.flash && dist([r.flash.cx, r.flash.cy], [r.cx, r.cy]) < 0.6 && r.flash.r > 0),
       `每个冲击环的心上都有一个闪光（径向渐变填充，画在环心、比环小）：`
       + o1.rings.map(r => `环 ${r.r.toFixed(1)}px/闪 ${r.flash ? r.flash.r.toFixed(1) : '-'}px`).join('、'));
    ok(dist([R1.cx, R1.cy], [R2.cx, R2.cy]) < 0.3,
       `撞击点在整个表现窗口里**钉在原地**（t=${o1.t} 与 t=${o2.t} 两次量到的环心差 `
       + `${dist([R1.cx, R1.cy], [R2.cx, R2.cy]).toFixed(2)} px）—— 它不是挂在某颗会动的天体上的`);

    // 暖色 vs 冷色：碎裂用暖（R>B），合并用冷（B>R）—— 按通道大小判，不比对写死的色值
    const warm = o1.rings.filter(r => rgbaN(r.style)[0] > rgbaN(r.style)[2] + 20);
    const cool = o1.rings.filter(r => rgbaN(r.style)[2] > rgbaN(r.style)[0] + 20);
    ok(warm.length >= 1 && cool.length >= 1,
       `两种事件画两种色：碎裂偏暖 ${warm.map(r => r.style).join(',') || '（无）'} / `
       + `合并偏冷 ${cool.map(r => r.style).join(',') || '（无）'}（按 R/B 通道大小判，不是比写死的色值）`);
    ok(new Set(o1.rings.map(r => r.style)).size >= 2,
       '负样本：这些环不是同一个颜色（否则"两种色"就是一句空话）');

    // ---- (3) 碎屑扇：所有线从**同一个点**拉出来，那个点就是撞击点 ----
    const nDeb = resp.bodies.filter(b => String(b.id).indexOf('#') > 0 && aliveAt(b, o1.t)).length;
    ok(nDeb >= 2 && o1.jets.length === nDeb,
       `t=${o1.t} 年画了 ${o1.jets.length} 条喷流线，与那一刻**活着的碎屑数** ${nDeb} 一致`
       + '（喷流是"从撞击点拉向碎屑"，所以条数就该等于碎屑数）');
    const ax = o1.jets.reduce((a, j) => a + j.from[0], 0) / (o1.jets.length || 1);
    const ay = o1.jets.reduce((a, j) => a + j.from[1], 0) / (o1.jets.length || 1);
    const spread = Math.max(...o1.jets.map(j => dist(j.from, [ax, ay])));
    ok(spread < 0.6,
       `${o1.jets.length} 条线共用同一个起点 (${ax.toFixed(1)}, ${ay.toFixed(1)})，`
       + `彼此最大偏离 ${spread.toFixed(2)} px —— 这就是画面上那个"扇"的扇柄`);
    ok(dist([ax, ay], [R1.cx, R1.cy]) < 0.6,
       `扇柄就是撞击点本身（与冲击环心差 ${dist([ax, ay], [R1.cx, R1.cy]).toFixed(2)} px）`
       + ' —— 碎屑是从撞击点被抛出去的，不是原地散开');
    ok(dist([ax, ay], [100, 100]) > 50,
       '负样本：换一个随便编的点 (100,100) 当"撞击点"，同一个比法立刻判不是同一起点（自证这个比法不是恒真）');
    // 扇口 = 各条线末端到"末端中心"的最大距离。
    // ⚠ 这一条**不能**拿刚撞完那一帧去要求"扇口很宽"：碎屑出生时整团只有 0.048 AU，
    //   默认视角下那才 **3 px** 左右 —— 那时画面上就是一支细笔，这是**对**的（它们真的还挤在一起，
    //   实测两两最近 0.2 px）。随着碎屑飞开，扇口才张开。所以判的是**扇口随时间张开**。
    const endSpread = js => {
      if (js.length < 2) return 0;
      const cx = js.reduce((a, j) => a + j.to[0], 0) / js.length;
      const cy = js.reduce((a, j) => a + j.to[1], 0) / js.length;
      return Math.max(...js.map(j => Math.hypot(j.to[0] - cx, j.to[1] - cy)));
    };
    ok(endSpread(o2.jets) > 1 && endSpread(o2.jets) > endSpread(o1.jets) * 2,
       `扇口随碎屑飞开而张开：撞击后 0.2 年时 ${endSpread(o1.jets).toFixed(2)} px，`
       + `0.8 年时 ${endSpread(o2.jets).toFixed(2)} px`
       + `（${(endSpread(o2.jets) / (endSpread(o1.jets) || 1e-9)).toFixed(0)} 倍）—— 它是"一把扇"，不是一条线重复画`);
    // ⚠ 这一条是**如实记下缺点**，不是放宽：默认视角 ≈8 px/AU（见上面那次实测），
    //   而这几块碎屑整团只有 0.05–0.10 AU —— 在撞击表现持续的这一段时间里，
    //   这条"扇"看上去就是一支细笔。碎屑要过好几年才散得开（第 10 节量过：t≈19.9 年时 2.065 AU）。
    //   所以"成束溅射"在**画面上**的可读性受视角尺度限制；要看得清得放大视角。
    //   判据把它钉住：哪天视角/尺度变了，这一条会红，逼人重新想清楚。
    ok(endSpread(o2.jets) < 4,
       `⚠ 但扇口**绝对值很小**（${endSpread(o2.jets).toFixed(2)} px）—— 碎屑整团 0.05–0.10 AU × `
       + `${pxPerAU === null ? '≈8' : pxPerAU.toFixed(1)} px/AU。`
       + '在这一段时长里它就是一支细笔；碎屑是过了好几年才散开的。想要"一眼看出成束"得放大视角');
    ok(o1.jets.every(j => dist(j.from, j.to) > 2),
       `每条线都有长度（最短 ${Math.min(...o1.jets.map(j => dist(j.from, j.to))).toFixed(1)} px）`);
    const jetCols = new Set(o1.jets.map(j => j.style));
    const linSet = new Set(Object.values(lin).map(v => v.toLowerCase()));
    ok(o1.jets.every(j => linSet.has(j.style)),
       `每条线用的是**那块碎屑自己的来源色**（图例里那个色）：${[...jetCols].join(',')}`);
    ok(jetCols.size === nDeb,
       `而且 ${nDeb} 块碎屑各自一个色（实测 ${jetCols.size} 个不同色）—— 看得出谁飞向哪边`);
    ok(o2.jets.length >= 1 && Math.max(...o2.jets.map(j => j.alpha)) < Math.max(...o1.jets.map(j => j.alpha)),
       `喷流随年龄变淡：alpha ${Math.max(...o1.jets.map(j => j.alpha)).toFixed(3)} → `
       + `${Math.max(...o2.jets.map(j => j.alpha)).toFixed(3)}`);
    // 画法层次：喷流在天体**之前**画（不糊住小球），闪光/环在天体**之后**画（压在球上）
    const firstBall = Math.min(...o1.balls.map(b => b.i));
    ok(o1.balls.length >= 1 && o1.jets.every(j => j.i < firstBall) && o1.rings.every(r => r.i > firstBall),
       `画法层次：${o1.jets.length} 条喷流都在第 1 颗天体（日志第 ${firstBall} 笔）之前画 —— 不糊住小球；`
       + `冲击环在它之后画 —— 闪光压在小球上`);

    // ---- (4) 顺带确认：页面默认参数下，"碎片再撞再碎"真的会发生（级联）----
    const casc = (resp.events || []).filter(e => String(e.a).indexOf('#') > 0
      || String(e.b).indexOf('#') > 0);
    ok(casc.length >= 1,
       `页面默认参数下发生了级联：碎屑自己又去撞了（${casc.length} 次，例：`
       + casc.slice(0, 2).map(e => `${e.kind} ${e.a}←${e.b || '—'} @ t=${e.t} 年`).join('；') + '）');
    ok(resp.bodies.some(b => (String(b.id).match(/#/g) || []).length >= 2),
       '而且出现了"碎屑的碎屑"（'
       + resp.bodies.map(b => b.id).filter(id => (String(id).match(/#/g) || []).length >= 2).slice(0, 3).join(' ')
       + ' …）—— 这是内核行为，不是页面画的');

    const realErrs3 = s.errs.filter(e => !/Not implemented/.test(e));
    ok(realErrs3.length === 0, '这一节全程无脚本异常' + (realErrs3.length ? ' — ' + realErrs3[0] : ''));
    s.close();
  }

  // jsdom 对未实现的 toDataURL 会往虚拟控制台发一条 "Not implemented"，那是宿主缺口、
  // 不是页面异常（页面已经如实报了导出失败）。除此之外不该有任何东西。
  const realErrs = p.errs.filter(e => !/Not implemented/.test(e));
  ok(realErrs.length === 0, '全程无脚本异常' + (realErrs.length ? ' — ' + realErrs[0] : ''));

  p.close();
  fs.writeFileSync(path.join(__dirname, '_probe_tools.txt'),
    L.join('\n') + '\n\n[tools] n=' + n + ' fail=' + fail + '\n', 'utf8');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  L.push('  FAIL  探针自身异常：' + (e && e.stack || e));
  fs.writeFileSync(path.join(__dirname, '_probe_tools.txt'),
    L.join('\n') + '\n\n[tools] n=' + n + ' fail=' + (fail + 1) + '\n', 'utf8');
  process.exit(1);
});
