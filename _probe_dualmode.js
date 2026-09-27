// 双模式（普通人 / 教授）+ 天体类型调色板 的判据。
// 关键一条：切模式**不能改变计算结果** —— 两套界面必须发同一份 payload。
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
// 画布桩顺便记下 fillText：H-R 图上的刻度字母与分区标签都是这么画的，
// jsdom 不渲染像素，但调用参数是真的。
const texts = [];
// 所有页面（每 open() 一份 jsdom）累计的页面级异常 —— 最后统一断言一次。
const ALL_ERRS = [];
const ctxStub = new Proxy({}, { get: (t, k) =>
  (k === 'createRadialGradient' || k === 'createLinearGradient') ? () => ({ addColorStop: noop })
  : (k === 'measureText' ? () => ({ width: 10 })
     : (k === 'fillText' ? (s) => { texts.push(String(s)); } : noop)), set: () => true });
const STORE_KEY = 'starpivot.universe.session';
// 每个 JSDOM 有各自的 localStorage，所以"重开一次"必须把上一份存档喂进去，
// 否则测的不是"恢复"而是"第一次打开"（第一版就栽在这里）。
async function open(hash = '', seedStore = null) {
  const vc = new VirtualConsole();
  const errs = [];
  // 页面**自己**抛的异常要单独收一份：这份探针的结果文件原来只记 PASS/FAIL，
  // 页面里一句 TypeError 的后果可能只是"某几处断言莫名不成立"，看不出是异常。
  // （本轮定位那 5 条红时就吃了这个亏：症状与原因毫不相关。）
  vc.on('jsdomError', e => {
    errs.push(String(e && e.message));
    ALL_ERRS.push('[jsdomError] ' + (e && e.message) + ' @ '
      + String((e && e.stack) || '').split('\n')[1]);
  });
  vc.on('console', m => {
    if (m.type() === 'error') { errs.push('[console.error] ' + m.text()); ALL_ERRS.push('[console.error] ' + m.text()); }
  });
  vc.on('jsdomError', noop);
  const rafQueue = [], fetchLog = [], respLog = [];
  let nbSeq = 0;
  const html = await (await nodeFetch(BASE + '/universe.html')).text();
  const dom = new JSDOM(html, {
    url: BASE + '/universe.html' + hash, runScripts: 'dangerously', virtualConsole: vc,
    pretendToBeVisual: true,
    beforeParse(w) {
      if (seedStore) { try { w.localStorage.setItem(STORE_KEY, seedStore); } catch (e) {} }
      w.HTMLCanvasElement.prototype.getContext = () => ctxStub;
      w.requestAnimationFrame = cb => { rafQueue.push(cb); return rafQueue.length; };
      w.cancelAnimationFrame = noop;
      w.fetch = (u, o) => {
        let b = null; if (o && o.body) { try { b = JSON.parse(o.body); } catch (e) {} }
        const isNb = String(u).includes('/api/nbody');
        const seq = isNb ? (++nbSeq) : 0;
        fetchLog.push({ url: String(u), body: b, seq: seq });
        return nodeFetch(new URL(String(u), BASE).href, o).then(r => {
          if (isNb) r.clone().json().then(j => {
            j.__nbseq = seq;
            respLog.push(j);
            // ⚠ 只留最近 3 份。这一份 payload 的回执是 **27.5 MB**（237 颗 × 2001 帧 × 3 个数），
            //   解析成对象图是几百 MB 量级；攒十几份会把 node 的事件循环拖住，于是"页面侧拿到
            //   回执要 10 s"里有一大截是**探针自己攒出来的**（同一份 payload 直接打网关只要 3.7 s）。
            //   量具不能改变它量的东西 —— 这里只留够 lastResp() 用的份数。
            while (respLog.length > 3) respLog.shift();
          }).catch(() => {});
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
  // ---- 等**条件成立**，而不是等一个固定毫秒数 ----
  // 起因：这份默认 payload（custom + solar:full + years 50 + collide:fragment）会级联出两百多颗，
  // 回执 27.5 MB：内核 ~2.5 s、网关 ~3.7 s、经 jsdom 还要更久。原来写死的 settle(3000) 比它还短，
  // 于是"页面还没收到回执"被记成了 5 条 FAIL —— 那是**机器快慢在判分**，不是行为不对。
  // 判据要等条件成立（有上限，真不成立照样红），并且把实际等了多久记进文案里（慢要看得见）。
  const waitFor = async (fn, ms = 90000, hint = '') => {
    const t0 = Date.now();
    for (;;) {
      let hit = false;
      try { hit = !!fn(); } catch (e) {}
      if (hit) return Date.now() - t0;
      if (Date.now() - t0 > ms)
        throw new Error('等条件超时 ' + ms + 'ms' + (hint ? '（' + hint + '）' : ''));
      await sleep(120); step(1);        // 推帧：页面的绘制循环要靠 rAF 往前走
    }
  };
  const cvEl = $('view');
  Object.defineProperty(cvEl, 'width', { value: 800, writable: true });
  Object.defineProperty(cvEl, 'height', { value: 600, writable: true });
  cvEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  cvEl.setPointerCapture = () => {}; cvEl.releasePointerCapture = () => {};
  return { w, d, $, fire, step, settle, waitFor, fetchLog, respLog, errs, texts,
           lastPayload: () => (fetchLog.filter(f => f.url.includes('/api/nbody')).slice(-1)[0] || {}).body,
           lastResp: () => respLog.slice(-1)[0],
           // 回执**不是**按请求顺序到达的（两份同时在飞时，先发的可能后回）。
           // 所以要按"里面有没有这颗天体"去找，而不是只看最后到的那一份。
           // ⚠ 注意这两个的返回值不一样：respWith 给**整份回执**，bodyIn 给**那一颗天体**。
           //   （踩过：想拿那颗天体的 radius_km 却用了 respWith，取到的是回执对象的同名字段 → undefined。）
           respWith: (id) => respLog.slice().reverse()
             .find(j => (j.bodies || []).some(b => b.id === id)),
           bodyIn: (id) => {
             const j = respLog.slice().reverse().find(x => (x.bodies || []).some(b => b.id === id));
             return j && j.bodies.find(b => b.id === id);
           },
           kc: () => fetchLog.filter(f => f.url.includes('/api/nbody')).length,
           close: () => dom.window.close() };
}
const mouse = (p, x, y) => {
  const ev = ty => new p.w.PointerEvent(ty, { clientX: x, clientY: y, bubbles: true, pointerId: 1 });
  p.d.getElementById('view').dispatchEvent(ev('pointerdown'));
  p.d.getElementById('view').dispatchEvent(ev('pointerup'));
};

(async () => {
  const p = await open();
  // 先等页面真的拿到第一份内核回执 —— 类型表、调色板、首屏那些数字全都来自它。
  const tBoot = await p.waitFor(() => p.lastResp() && (p.lastResp().body_types || []).length,
                                90000, '首份内核回执');
  await p.settle(300);
  if (p.$('play').textContent.indexOf('暂停') >= 0) { p.fire(p.$('play'), 'click'); await p.settle(200); }

  // ---------- 1. 默认是"普通人" ----------
  ok(p.d.body.classList.contains('mode-simple'), '默认进「普通人」模式（不必先懂开普勒根数）');
  ok(p.$('mode_simple').classList.contains('on') && !p.$('mode_pro').classList.contains('on'),
     '模式切换器上"普通人"是选中态');
  const css = p.d.querySelector('style').textContent;
  ok(/body\.mode-simple \.pro-only\{display:none !important\}/.test(css)
     && /body\.mode-pro\s+\.simple-only\{display:none !important\}/.test(css),
     '两模式的显隐规则确实写在样式里（不是靠 JS 逐个元素改 display）');
  const disp = el => p.w.getComputedStyle(el).display;
  const proEl = p.$('bodytable');
  const simEl = p.$('simplebodies');
  ok(disp(proEl) === 'none', `普通人模式下，9 列开普勒参数表被隐藏（display=${disp(proEl)}）`);
  ok(disp(simEl) !== 'none', '而"两个旋钮"的天体卡片是显示的');
  ok(/只露两个旋钮|两个旋钮值得动/.test(p.$('custombox').textContent)
     || /离恒星多远/.test(simEl.textContent), '普通人模式的说明告诉他就动两个旋钮就行');

  // ---------- 2. 切到教授：术语与完整表格回来 ----------
  p.fire(p.$('mode_pro'), 'click');
  await p.settle(300);
  ok(p.d.body.classList.contains('mode-pro'), '切到「教授」模式');
  ok(disp(proEl) !== 'none', '完整参数表显示出来');
  ok(disp(simEl) === 'none', '两个旋钮的卡片收起');
  const thead = p.$('bodytable').textContent;
  ok(/a \(AU\)/.test(thead) && /Ω/.test(thead) && /M0/.test(thead),
     '教授模式看得到 a / e / i / Ω / ω / M0 / 质量 / 半径');
  ok(/开普勒根数/.test(p.$('custombox').textContent), '教授模式的说明用的是专业措辞');

  // ---------- 3. 切模式不能改变计算 ----------
  const before = JSON.stringify(p.lastPayload());
  p.fire(p.$('mode_simple'), 'click'); await p.settle(300);
  p.fire(p.$('mode_pro'), 'click'); await p.settle(300);
  ok(JSON.stringify(p.lastPayload()) === before,
     '来回切模式没有重新下发 payload（模式只是外观，不进计算）');
  p.fire(p.$('mode_simple'), 'click'); await p.settle(300);

  // ---------- 3b. 操作简化：首屏只留"画面 + 演奏条 + 一键开局 + 常用类型" ----------
  // 起因是一条用户反馈："将宇宙模拟操作简化"。改版前实测：**95 个可见交互控件**，
  // 而且画布排在所有控件之后（第 11 块）—— 第一屏是一堵带标签的输入框。
  // 这条只验**可测的那部分**：首屏可见控件有预算、画布在最前、折叠区默认收起。
  // 内容一句没删（39 种类型 / 15 个开局仍在原地，由本文件与 _probe_bodytypes.js 逐项验）。
  //
  // ⚠ 折叠起来的内容**不是** display:none —— 只看 display 会把 <details> 里的元素全算成"可见"。
  //   正确的规则：details 未展开时，只有它的 <summary> 还看得见。
  //   （这个坑真踩过：第一版量尺漏了它，改完数字一点没降，差点把"没效果"当成结论。）
  const visibleCount = () => [...p.d.querySelectorAll('button,select,input,summary,[tabindex]')]
    .filter(el => {
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        if (n.tagName === 'DETAILS' && !n.open) {
          if (!(el.tagName === 'SUMMARY' && el.parentElement === n)) return false;
        }
        if (p.w.getComputedStyle(n).display === 'none') return false;
      }
      return true;
    }).length;
  const nVis = visibleCount();
  ok(nVis <= 45, `普通人模式下首屏可见控件 ≤ 45（实测 ${nVis}；改版前 95）`);
  const dets = [...p.d.querySelectorAll('details')];
  ok(dets.length >= 3 && dets.every(d => !d.open),
     `${dets.length} 个折叠区默认都是收起的（首屏才短得下来）`);
  ok(!!p.$('advbox') && p.$('advbox').querySelectorAll('input,select,button').length >= 15,
     `「更多设置」里确实装着那些参数（${p.$('advbox') ? p.$('advbox').querySelectorAll('input,select,button').length : 0} 个控件）`);
  {
    // 画面优先：画布要排在第一个折叠区之前，也排在类型墙之前。
    const all = [...p.d.querySelectorAll('*')];
    const at = el => all.indexOf(el);
    ok(at(p.$('view')) > -1 && at(p.$('view')) < at(p.$('advbox')) && at(p.$('view')) < at(p.$('palette')),
       '画布排在「更多设置」与类型墙之前（改版前排在第 11 块，前面全是控件）');
  }
  {
    const fold = p.d.querySelector('#palette details > summary');
    ok(fold && /其余\s*\d+\s*种/.test(fold.textContent),
       '收起来的类型有明确交代：' + (fold ? fold.textContent.trim() : '（找不到折叠区）'));
  }
  {
    // 负样本走**同一个量尺**：把折叠区全展开，就是"没做这件事"的样子，必须判超预算。
    const saved = dets.map(d => d.open);
    dets.forEach(d => { d.open = true; });
    const nOpen = visibleCount();
    dets.forEach((d, i) => { d.open = saved[i]; });
    ok(nOpen > 45, `负样本：把折叠区全展开 → 可见控件涨到 ${nOpen}，同一处会判超预算（自证判据有效）`);
  }

  // ---------- 4. 类型调色板：整份来自内核 ----------
  const kb = p.lastResp().body_types || [];
  const btns = [...p.d.querySelectorAll('#palette button')];
  ok(kb.length >= 11, `内核回了 ${kb.length} 个类型`);
  ok(btns.length === kb.length, `调色板按钮数 ${btns.length} == 内核类型数 ${kb.length}`);
  const labels = btns.map(b => b.textContent.replace(/^[☀●]\s*/, ''));
  ok(kb.every(t => labels.includes(t.name_zh)),
     '按钮上的名字逐字来自内核的 name_zh（页面没有自己那份类型名表）');
  // 注意用「包含」而不是「相等」：内核的名字本身可能就是带限定的，比如
  // "M 型主序星（红矮星）" —— 判据不该按我脑子里的旧标签写死。
  const has = (kw) => labels.some(x => x.includes(kw));
  ok(has('黑洞') && has('红矮星') && has('中子星'),
     '黑洞 / 红矮星 / 中子星都在可放列表里：' + labels.slice(0, 4).join(' '));
  ok(has('超巨星') && has('白矮星') && has('变星'),
     '光度级（超巨星）与特殊性质（变星）也都在同一张表里');
  ok(btns.filter(b => /^☀/.test(b.textContent)).length
     === kb.filter(t => t.emits_light).length,
     '会发光的类型带 ☀ 标记（数量与内核声明的发光类型一致）');

  // 悬停看说明
  const bhBtn = btns.find(b => b.textContent.includes('黑洞'));
  bhBtn.dispatchEvent(new p.w.Event('mouseenter', { bubbles: true }));
  await sleep(50);
  const tn = p.$('typenote').textContent;
  ok(/2GM\/c\^2/.test(tn), '黑洞的说明里给出半径公式原文 R = 2GM/c^2（来自内核）');
  ok(/0\.5–1e\+4|0\.5–10000/.test(tn) || /质量/.test(tn), '给出质量范围与默认值');

  // ---------- 5. 选类型 → 进放置模式 → 点画面放一颗黑洞 ----------
  bhBtn.dispatchEvent(new p.w.Event('click', { bubbles: true }));
  await p.settle(500);       // 选类型会立刻切到自定义场景并**发**一次重算（这一发不用等它回来）
  ok(/放置中/.test(p.$('placemode').textContent), '选类型后自动进入放置模式（少一步操作）');
  ok(/黑洞/.test(p.$('placemode').textContent), '而且按钮上说清了要放的是黑洞');
  const nBefore = p.d.querySelectorAll('#simplebodies .bodycard').length;
  mouse(p, 620, 300);
  // 卡片是**同步**加上的（renderSimpleBodies 在放置处理器里就跑了）
  await p.waitFor(() => p.d.querySelectorAll('#simplebodies .bodycard').length === nBefore + 1,
                  20000, '卡片多一张').catch(() => {});
  const cards = [...p.d.querySelectorAll('#simplebodies .bodycard')];
  ok(cards.length === nBefore + 1, `点画面后普通人模式的卡片多了一张（${nBefore} → ${cards.length}）`);
  const pl = p.lastPayload();
  const added = pl.bodies[pl.bodies.length - 1];
  // 名字是页面自动生成的（BH3），所以先在 payload 里拿到它，再等**带它的那一份回执**回来。
  // 原来是 settle(3000) 之后直接查 —— 而这一发要 ~10 s（27.5 MB 的回执），于是"还没回来"
  // 被记成了"页面没落上数字"。
  const tBH = await p.waitFor(() => p.bodyIn(added.name), 90000, '回执里出现 ' + added.name);
  ok(added.type === 'black_hole', `下发的 payload 里带类型（type=${added.type}）`);
  ok(Math.abs(added.mass - 10) < 1e-9, `质量用的是内核给的默认值 ${added.mass} M☉`);
  ok(/^[A-Za-z]/.test(added.name) && /^[\x20-\x7e]+$/.test(added.name),
     `自动生成的天体名是纯 ASCII（${added.name}）—— 名字要过 CLI 的 argv，而 Windows 的 argv 不是可靠的 Unicode 通道`);
  const bresp = p.bodyIn(added.name);
  const G = 6.67430e-11, C = 2.99792458e8, MSUN = 1.98847e30;
  const sch = 10 * 2 * G * MSUN / (C * C) / 1000;
  // 把这一颗在回执里长什么样原样贴出来：radius_km 缺失 / 字段名走散的时候，
  // 只报 "undefined km" 是没法分辨"没找到这颗"还是"找到但没有那个字段"的。
  const shape = bresp ? JSON.stringify({ id: bresp.id, radius_km: bresp.radius_km,
    emits_light: bresp.emits_light, mass_msun: bresp.mass_msun, type: bresp.type,
    keys: Object.keys(bresp).join(',') }) : '(回执里没找到这颗)';
  ok(bresp && Math.abs(bresp.radius_km - sch) / sch < 1e-3,
     `内核按史瓦西算出的半径落到页面上：${bresp && bresp.radius_km} km`
     + `（独立复算 ${sch.toFixed(4)}；这一发回执等了 ${tBH} ms）\n           回执里这颗 = ${shape}`);
  ok(bresp && bresp.emits_light === false, '页面上这颗黑洞不发光');

  // ---------- 6. 两个旋钮真的能改 ----------
  // 注意：上面已经等到了"带黑洞的那份回执"，所以这里按钮是**算完**的状态。
  // 原来是回执还没回来就拖滑杆，而算的时候按钮是 disabled 的 → 这一条测的其实不是
  // "标记会不会出现"，而是"机器够不够快"。
  const card = cards[cards.length - 1];
  const sliders = [...card.querySelectorAll('input[type=range]')];
  ok(sliders.length === 2, `每张卡片只有两个旋钮（${sliders.map(s => s.dataset.k).join(', ')}）`);
  const kA = sliders.find(s => s.dataset.k === 'a');
  kA.value = '2.5'; p.fire(kA, 'input'); await sleep(150);
  ok(/参数已改/.test(p.$('compute').textContent),
     '拖了旋钮 → 按钮变成「参数已改」（提醒需要重算）');
  ok(/2\.50 AU/.test(card.textContent), '卡片上实时显示新值：' + (card.textContent.match(/[\d.]+ AU/) || [])[0]);

  // ---------- 6b. 算的**路上**改参数：算完回来不能把「参数已改」抹掉 ----------
  // 这是一条真缺陷（本轮修掉）：按钮在算的时候是 disabled 的，paintComputeBtn() 会早退，
  // 于是那一刻的 setDirty(true) 只改了状态、按钮上没写出来；而重算回来那句原来是**无条件**
  // setDirty(false) —— 用户的改动既没进这一版结果（payload 是发出去那一刻抓的），
  // 按钮还说"没什么要算的"。属于"标记不老实"，和这个页面其它地方的纪律相冲突。
  {
    const c2 = [...p.d.querySelectorAll('#simplebodies .bodycard')].slice(-1)[0];
    const kE = c2 && [...c2.querySelectorAll('input[type=range]')].find(s => s.dataset.k === 'e');
    p.fire(p.$('compute'), 'click');          // 开始算；compute() 第一句就把按钮置为 disabled
    const wasDisabled = p.$('compute').disabled;
    ok(wasDisabled && !!kE, '点了「重新计算」后按钮立刻进入算中状态（说明下面这一改确实落在"算的路上"）');
    if (kE){
      kE.value = '0.05'; p.fire(kE, 'input');  // 算的路上改「偏心率」
      await p.waitFor(() => !p.$('compute').disabled, 90000, '这一轮重算回来');
      await sleep(80);
      ok(/参数已改/.test(p.$('compute').textContent),
         '算完之后「参数已改」还在（这一版结果里没有刚改的值，不能被算完的重绘抹掉）'
         + '：按钮现在是「' + p.$('compute').textContent + '」');
    } else {
      ok(false, '最后一颗天体没有偏心率旋钮，6b 只能跳过');
    }
  }

  // ---------- 7. 简单模式的人话 ----------
  mouse(p, 400, 300);      // 点中一颗（太阳大致在中心）
  // 选中卡片是**同步**更新的，这里只是给一点余量；真没选中照样走下面的 else 分支记 FAIL。
  await p.waitFor(() => p.$('selcard').style.display === 'block', 5000, '选中卡片').catch(() => {});
  if (p.$('selcard').style.display === 'block'){
    const t = p.$('selbody').textContent;
    ok(/离恒星多远/.test(t) && /多重/.test(t), '普通人模式的信息卡用人话标签（离恒星多远 / 多重）');
    ok(!/辐照度 S/.test(t), '不出现"辐照度 S"这种术语');
    ok(/有没有可能有生命/.test(t), '判定那一行写成"有没有可能有生命"');
    p.fire(p.$('mode_pro'), 'click'); await p.settle(400);
    const t2 = p.$('selbody').textContent;
    ok(/辐照度 S/.test(t2) && /质量/.test(t2), '切到教授后换成术语（辐照度 S / 质量）');
    ok(/平衡温 \/ 地表温/.test(t2), '并且把 T_eq 与 T_surf 分开列');
    p.fire(p.$('mode_simple'), 'click'); await p.settle(300);
  } else { ok(false, '点了中心却没选中天体，信息卡相关判据跳过'); }

  // ---------- 8. 模式跟着会话走 ----------
  p.fire(p.$('mode_pro'), 'click'); await p.settle(300);
  await sleep(700);
  const rawStore = p.w.localStorage.getItem(STORE_KEY);
  const saved = JSON.parse(rawStore);
  ok(saved.uiMode === 'pro', `模式写进了会话（uiMode=${saved.uiMode}）`);
  ok(typeof saved.pendingType === 'string' && saved.pendingType === 'black_hole',
     `选中的类型也记住了（pendingType=${saved.pendingType}）`);
  p.close();

  const q = await open('', rawStore);
  // 这份存档里有黑洞 + 太阳系全带，重开后的第一发回执同样是大件 —— 等它回来，
  // 因为"上次选的类型被恢复成选中态"是**建调色板时**打上去的（buildPalette 里按 pendingType）。
  await q.waitFor(() => q.lastResp() && (q.lastResp().body_types || []).length,
                  90000, '重开后的首份回执');
  await q.settle(300);
  ok(q.d.body.classList.contains('mode-pro'), '重新打开还是教授模式');
  ok(q.$('mode_pro').classList.contains('on'), '切换器状态也对');
  const qbtns = [...q.d.querySelectorAll('#palette button')];
  ok(qbtns.some(b => b.classList.contains('on') && b.textContent.includes('黑洞')),
     '上次选的类型也被恢复（黑洞按钮是选中态）');
  q.close();

  // ---------- 8b. 放恒星 → 自动以它为参考（这是"行星不会飞走"的关键） ----------
  {
    const r = await open();
    // 调色板按钮是**拿到内核类型表之后**才建的；没等到就去 clickType 会拿到 undefined 然后炸，
    // 那正是这一节原来把后面 22 条判据一起带走的死法。
    await r.waitFor(() => r.d.querySelectorAll('#palette button').length, 90000, 'r 页的调色板');
    await r.settle(200);
    if (r.$('play').textContent.indexOf('暂停') >= 0) { r.fire(r.$('play'), 'click'); await r.settle(200); }
    const clickType = (kw) => {
      const b = [...r.d.querySelectorAll('#palette button')].find(x => x.textContent.includes(kw));
      b.dispatchEvent(new r.w.Event('click', { bubbles: true }));
      return b;
    };
    // 注意：重复点同一个类型按钮会**取消**选择（selectType 是切换语义），
    // 所以这里每一步只点一次，不加多余的点。
    clickType('红矮星');                      // 选中类型 + 进放置模式 + 切自定义场景
    await r.settle(3000);
    while (r.d.querySelector('#bodytable button[data-del]')) {   // 先清空默认那两颗
      r.fire(r.d.querySelector('#bodytable button[data-del]'), 'click');
      await sleep(40);
    }
    mouse(r, 560, 300);                        // 放一颗红矮星
    await r.waitFor(() => ((r.lastPayload() || {}).bodies || []).length, 30000, '红矮星那一发的 payload');
    await r.settle(300);
    const nm = r.lastPayload().bodies.slice(-1)[0].name;
    // 名字是"类型键首字母缩写 + 序号"（M_V → MV1）。不写死具体缩写：
    // 类型表会变，但"纯 ASCII 的短名字"这条约束不该变（名字要过 CLI 的 argv）。
    ok(/^[A-Z]{1,4}\d+$/.test(nm), '放下了一颗恒星，名字是纯 ASCII 缩写 ' + nm);
    ok(r.$('solarmode').value === 'none',
       '放下恒星后背景太阳系自动收起（否则会有第二颗恒星搅乱轨道）');
    ok(/背景太阳系已自动收起/.test(r.$('toolnote').textContent),
       '并且把这件事说出来了，不是偷偷改');
    ok(new RegExp('以<b>' + nm + '</b>为参考').test(r.$('toolnote').innerHTML),
       '并说明了后续天体会以它（' + nm + '）为参考');
    // 换成一颗粒质行星再放一颗 → payload 里应带 primary
    clickType('岩质行星');
    await r.settle(400);
    mouse(r, 470, 300);
    const pl = r.lastPayload();
    const pName = (pl.bodies || []).slice(-1)[0].name;
    // 等**带这颗行星的那一份**回执 —— 不赌毫秒数，而且不靠"最后到的那一份"（两份同时在飞时
    // 先发的可能后回，那样会把上一发的结果当成本发的结果）。
    await r.waitFor(() => r.respWith(pName), 90000, '回执里出现 ' + pName);
    ok(pl.primary === nm, `之后的天体以那颗恒星为参考（payload.primary=${pl.primary}）`);
    const js = r.respWith(pName);
    ok(js.primary_frame === nm && js.primary_fields_ignored === true,
       `内核确认参考系是 ${js.primary_frame}，并如实标明它自己的根数字段未被使用`);
    // 最关键的一条：行星没有被甩掉
    const ip = js.bodies.findIndex(b => b.id === pl.bodies.slice(-1)[0].name);
    const is = js.bodies.findIndex(b => b.id === nm);
    const d = f => Math.hypot(js.frames[f].p[ip][0] - js.frames[f].p[is][0],
                              js.frames[f].p[ip][1] - js.frames[f].p[is][1],
                              js.frames[f].p[ip][2] - js.frames[f].p[is][2]);
    const d0 = d(0), dN = d(js.frames.length - 1);
    ok(Math.abs(dN / d0 - 1) < 0.1,
       `行星一直待在恒星旁边（${d0.toFixed(3)} → ${dN.toFixed(3)} AU）—— 不再是"按 1 M☉ 给速度然后飞走"`);
    r.close();
  }

  // ---------- 8c. H-R 图 ----------
  {
    const r = await open();
    await r.waitFor(() => r.lastResp() && (r.lastResp().body_types || []).length,
                    90000, '§8c 的首份回执');
    await r.waitFor(() => r.$('hrcard').style.display === 'block', 20000, 'H-R 卡片').catch(() => {});
    ok(r.$('hrcard').style.display === 'block',
       '有发光天体时 H-R 卡片显示出来（太阳系里至少有太阳）');
    r.texts.length = 0;
    // ⚠ H-R 图有 0.7 秒的重绘节流（页面写在代码里的间隔，免得每次推帧都重画）。
    //   所以"卡片显示出来了" ≠ "这一帧已经把刻度画上去了" —— 原来靠 settle(2500) 先把
    //   那 0.7 s 睡过去，换成"等卡片出现"之后反而会立刻推帧、被节流吃掉 → 一个字都没有。
    //   这里等到字母真的出现在这一帧上为止。
    const SPEC = ['O', 'B', 'A', 'F', 'G', 'K', 'M'];
    await r.waitFor(() => {
      r.texts.length = 0;                 // 只看最新这一帧
      r.step(1);
      return SPEC.every(s => r.texts.includes(s));
    }, 20000, 'H-R 图横轴刻度画出来').catch(() => {});
    // 画布上应当出现七个光谱型的字母刻度
    const spec = ['O', 'B', 'A', 'F', 'G', 'K', 'M'].filter(s => r.texts.includes(s));
    ok(spec.length === 7, `H-R 图横轴画出了七个光谱型刻度：${spec.join(' ')}`);
    ok(r.texts.some(t => /^1e-?\d$/.test(t)), '纵轴画出了光度刻度（对数轴）');
    ok(r.texts.some(t => /主序带/.test(t)), '图上标出了主序带区域');
    ok(r.texts.some(t => /巨星支/.test(t)) && r.texts.some(t => /超巨星/.test(t))
       && r.texts.some(t => /白矮星/.test(t)), '巨星支 / 超巨星 / 白矮星区域也都标出来了');
    ok(r.texts.some(t => /^Sun/.test(t)), '太阳按内核回显的 (T,L) 落了一个点：'
       + r.texts.filter(t => /^Sun/.test(t)).join(''));
    ok(/示意区域/.test(r.$('hrnote').textContent),
       '图下说明里如实标注了分区是"教科书示意区域"而不是内核算出来的边界');
    ok(/从热到冷/.test(r.$('hrnote').textContent), '说明了横轴方向（天文惯例：左热右冷）');
    ok(/怎么看/.test(r.$('hrnote').textContent),
       '普通人模式下多给了一句"怎么看这张图"（教授模式没有这句）');

    // 放一颗红超巨星，它应当落进超巨星带（T 低、L 高）
    const btns = [...r.d.querySelectorAll('#palette button')];
    const mi = btns.find(b => b.textContent.includes('红超巨星'));
    ok(!!mi, '调色板里有 M 型红超巨星');
    r.texts.length = 0;
    mi.dispatchEvent(new r.w.Event('click', { bubbles: true }));   // 选中类型 → 进放置模式
    await r.settle(400);
    mouse(r, 520, 300);                                            // 真的点画面放下去
    const rName = ((r.lastPayload() || {}).bodies || []).slice(-1)[0].name;
    await r.waitFor(() => r.respWith(rName), 90000, '回执里出现 ' + rName);
    // H-R 图有 0.7 秒的重绘节流，所以再推一帧 + 等一下再读说明文字（第一版读早了，
    // 拿到的是上一份说明，于是断言假失败）。
    r.step(1); await sleep(250); r.step(1); await sleep(50);
    const cnt = (r.$('hrnote').textContent.match(/当前有 (\d+) 颗/) || [])[1];
    const nbResp = (r.respWith(rName).bodies || []).filter(b => b.emits_light && b.t_eff_K > 0).length;
    // 注意期望值不是 2：放下恒星时页面会自动把背景太阳系收起（免得两颗恒星互相搅），
    // 所以图上仍然是 1 颗 —— 只是从太阳换成了这颗红超巨星。
    // 正确的判法是"说明里的点数与内核回显的发光天体数一致"。
    ok(cnt === String(nbResp),
       `H-R 图上的点数与内核回显的发光天体数一致（说明里 ${cnt} 颗，内核 ${nbResp} 颗）`);
    ok(cnt === '1' && r.$('solarmode').value === 'none',
       '放下恒星后背景太阳系被收起，图上就只剩这一颗（不是漏画）');
    r.texts.length = 0; r.step(1); await sleep(40);
    // 红超巨星应当落在"温度低、光度高"的位置 —— 图上它对应的标签是它自己那颗
    const newName = (r.$('hrnote').textContent, (r.lastPayload().bodies.slice(-1)[0] || {}).name);
    ok(r.texts.some(t => t.indexOf(newName) === 0),
       `H-R 图上出现了新天体的标签（${newName}）：`
       + r.texts.filter(t => t.indexOf(newName) === 0).join(','));
    r.fire(r.$('mode_pro'), 'click'); await r.settle(400);
    ok(!/怎么看/.test(r.$('hrnote').textContent), '教授模式下不再显示"怎么看"那句（术语表已经够了）');
    r.close();
  }

  // ---------- 9. 坏类型不会渗进 payload ----------
  const r = await open();
  // ⚠ 这一条原来是"settle(2500) 之后读 payload" —— 两处都错：
  //   ① 那一发还没发出去就读，读到空对象，`.every()` 在空数组上恒真（**空过**）；
  //   ② 就算读到了，页面**第一发是 solar 场景**，那份 payload 里根本没有 bodies 字段
  //      （只有自定义场景才把天体放进 bodies）→ 还是恒真。
  //   它真正要守的是"自定义场景里那两颗默认天体不带 type"，所以要先把页面推到自定义场景。
  await r.waitFor(() => r.lastPayload() && r.lastPayload().scenario, 90000, '§9 的首份 payload');
  const solarPl = r.lastPayload();
  ok(solarPl.bodies === undefined || solarPl.bodies.every(b => b.type === undefined),
     `第一发是 ${solarPl.scenario} 场景、payload 里不带自带 type 的天体`
     + (solarPl.bodies ? `（bodies ${solarPl.bodies.length} 颗）` : '（这一场景的 payload 连 bodies 字段都没有）'));
  await r.waitFor(() => r.d.querySelectorAll('#palette button').length, 90000, '§9 的调色板');
  const anyChip = [...r.d.querySelectorAll('#palette button')].find(b => b.textContent.includes('岩质行星'))
    || r.d.querySelector('#palette button');
  anyChip.dispatchEvent(new r.w.Event('click', { bubbles: true }));
  await r.waitFor(() => ((r.lastPayload() || {}).bodies || []).length, 90000, '§9 的自定义 payload');
  {
    const cb = r.lastPayload().bodies;
    ok(cb.length > 0 && cb.every(b => b.type === undefined || typeof b.type === 'string'),
       `自定义场景里那 ${cb.length} 颗默认天体没有类型 → payload 里不带 type 字段（老写法行为不变）`);
  }
  r.close();

  // ---------- 10. 全程没有页面级异常 ----------
  // 页面自己抛异常时，症状经常表现为"别处的某几条断言莫名不成立"，很难倒推。
  // 单独钉一条，让异常有名字。
  ok(ALL_ERRS.length === 0,
     '全程没有页面抛异常（jsdomError / console.error 一条都没有）'
     + (ALL_ERRS.length ? '：' + ALL_ERRS.slice(0, 4).join(' ｜ ') : ''));

  fs.writeFileSync(path.join(__dirname, '_probe_dualmode.txt'),
    L.join('\n') + '\n\n[dualmode] n=' + n + ' fail=' + fail + '\n', 'utf8');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  L.push('  FAIL  探针自身异常：' + (e && e.stack || e));
  fs.writeFileSync(path.join(__dirname, '_probe_dualmode.txt'),
    L.join('\n') + '\n\n[dualmode] n=' + n + ' fail=' + (fail + 1) + '\n', 'utf8');
  process.exit(1);
});
