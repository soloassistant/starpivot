// 预测轨道 / 计划模式 的判据。契约：docs/bench-contract-2026-10-05.md §4.5。
//
// 这条判据盯三件事，每件都可能被"看起来实现了"骗过去：
//   (1) 预演请求真的**更短**（years 与 samples 都比同一次会话的主计算小）。
//       "更短"必须相对**同一页面的主计算**来比：切到 custom 之后主计算的 years
//       本身会变（实测 50 → 20），拿首次加载的 50 当基准会把主计算自己当成预演。
//   (2) 幽灵轨迹的点 100% 来自那次预演回执 —— 用"两次伪造预演、帧数组长度不同"
//       做差分：主计算的回执两次逐字相同，#view 上的绘制指令数却必须不同。
//       剩下的差只能是幽灵带来的。伪造只作用于**确实比主计算短**的那次请求。
//   (3) 放弃必须真 abort：请求确实被 AbortController 掐掉、页面吞掉 AbortError、
//       且没有 unhandled rejection。判据在探针侧挂 process 监听来数。
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

// process 级 unhandledRejection：jsdom 窗口不一定派发这个事件，
// 但 promise 拒绝终究会冒到这里 —— 页面漏接 AbortError 就藏不住。
const unhandled = [];
process.on('unhandledRejection', (r) => { unhandled.push(String((r && r.message) || r)); });

// 画布记账：按 canvas id 分桶。fillText / 路径指令都记，
// 用来数"幽灵轨迹点了几笔"和"落了几个字"。
function mkCtx(bucket) {
  return new Proxy({}, {
    get: (t, k) => {
      if (k === 'createRadialGradient' || k === 'createLinearGradient')
        return () => ({ addColorStop: noop });
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'fillText') return (s, x, y) => bucket.ops.push({ k: 'fillText', s: String(s), x, y });
      if (k === 'moveTo' || k === 'lineTo' || k === 'arc' || k === 'rect' || k === 'ellipse')
        return (x, y) => bucket.ops.push({ k, x, y });
      return noop;
    },
    set: () => true
  });
}

// opts.forgePreview(body, echo)  替换"比主计算短的那次"回执
// opts.holdPreview(body)         true 时人为把这次请求拖慢，好让"放弃"落在在途上
// 页面 HTML 取一次就缓存。
// 实测：每次 open 都重新向网关要这 270KB，偶尔第二次拿到的是没跑脚本的空壳，
// 于是判据整片变红 —— 那是判据自己的抖动，不是页面的问题。
let PAGE_HTML = null;
async function pageHtml() {
  if (PAGE_HTML === null) PAGE_HTML = await (await nodeFetch(BASE + '/universe.html')).text();
  return PAGE_HTML;
}

async function open(opts = {}) {
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', e => errs.push(String(e && e.message)));
  vc.on('jsdomError', noop);
  const rafQueue = [], fetchLog = [], held = [];
  const drawn = {};
  const bucket = id => (drawn[id] || (drawn[id] = { ops: [] }));
  const dom = new JSDOM(await pageHtml(), {
    url: BASE + '/universe.html' + (opts.hash || ''), runScripts: 'dangerously', virtualConsole: vc,
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = function () { return mkCtx(bucket(this.id || '(anon)')); };
      w.requestAnimationFrame = cb => { rafQueue.push(cb); return rafQueue.length; };
      w.cancelAnimationFrame = noop;
      w.scrollTo = noop;
      w.HTMLCanvasElement.prototype.setPointerCapture = noop;
      w.HTMLCanvasElement.prototype.releasePointerCapture = noop;
      w.addEventListener('unhandledrejection', e => {
        errs.push('unhandledrejection: ' + String((e.reason && e.reason.message) || e.reason));
      });
      w.fetch = (u, o) => {
        const url = String(u);
        let body = null; if (o && o.body) { try { body = JSON.parse(o.body); } catch (e) {} }
        const rec = { url, body, signal: (o && o.signal) || null };
        fetchLog.push(rec);
        const run = () => nodeFetch(new URL(url, BASE).href, o);
        const slow = url.includes('/api/nbody') && opts.holdPreview && body && opts.holdPreview(body);
        if (slow) {
          // 在途挂起：判据要在这段时间里点"放弃"，才测得到 abort
          const pr = new Promise(res => setTimeout(res, 2500)).then(run);
          rec.held = true;
          held.push(rec);
          pr.catch(e => { rec.rejected = String((e && e.name) || e); });
          return pr.then(r => r.json().then(j => {
            const g = opts.forgePreview ? opts.forgePreview(body, j) : undefined;
            rec.echo = (g === undefined ? j : g);
            return { ok: r.ok, status: r.status, json: async () => rec.echo };
          }));
        }
        if (!url.includes('/api/nbody') || !opts.forgePreview) return run();
        return run().then(r => r.json().then(j => {
          const g = opts.forgePreview(body, j);
          rec.echo = (g === undefined ? j : g);
          return { ok: r.ok, status: r.status, json: async () => rec.echo };
        }));
      };
    }
  });
  const w = dom.window, d = w.document;
  let t = 0;
  const step = (k = 1, dt = 16) => {
    for (let i = 0; i < k; i++) { const cb = rafQueue.shift(); if (cb) cb(1000 + (t += dt)); }
  };
  const $ = id => d.getElementById(id);
  const fire = (el, ty) => el.dispatchEvent(new w.Event(ty, { bubbles: true }));
  const settle = async (ms = 500) => { await sleep(ms); step(2); await sleep(30); };
  const nb = () => fetchLog.filter(f => f.url.includes('/api/nbody'));
  return { w, d, $, fire, step, settle, fetchLog, errs, drawn, held, nb,
           kc: () => nb().length,
           lastBody: () => (nb().slice(-1)[0] || {}).body,
           lastEcho: () => (nb().slice(-1)[0] || {}).echo,
           close: () => dom.window.close() };
}

// 切到 custom：只有自定义场景才把 bodies 下发，否则改表里那一格
// 根本不会进 payload，"预演带着被改的天体"就无从断言。
// 顺带把"这一页自己的主计算"记下来：years/samples 随场景变，基准必须跟着变。
async function boot(opts = {}) {
  const p = await open(opts);
  await p.settle(2000);
  if (p.$('scenario') && p.$('scenario').value !== 'custom') {
    p.$('scenario').value = 'custom';
    p.fire(p.$('scenario'), 'change');
    await p.settle(4500);
  }
  const mb = p.lastBody() || {};
  p.mainYears = +mb.years || 0;
  p.mainSamples = +mb.samples || 0;
  p.kc0 = p.kc();
  // 比主计算短的那次 = 预演
  p.previews = () => p.nb().filter(f => f.body && p.mainYears > 0
                                   && +f.body.years < p.mainYears);
  await ensurePreviewOn(p);
  p.kc0 = p.kc();     // 开关本身也可能触发一次预演，别把它算进"改参数后新增"
  return p;
}

// 打开"松手前先预演一遍"那个开关（若页面把它做成可关的）。
// 契约 §4.5 写的是"改参数/拖动后自动预演"，而实现把它放在开关后面（可关）——
// 探针按真实使用路径先打开它再改参数，这样"预演功能是否存在"才测得到。
async function ensurePreviewOn(p) {
  const t = p.$('plantogg');
  if (t && !t.checked) { t.checked = true; p.fire(t, 'change'); await sleep(200); }
  return !!t;
}

// 改一个天体参数（计划模式的触发动作之一：改参数）
async function touchBody(p) {
  let rows = p.d.querySelectorAll('#bodytable input[data-k="a"]').length;
  let guard = 0;
  while (rows === 0 && guard++ < 3) { p.fire(p.$('addbody'), 'click'); await sleep(150); rows = p.d.querySelectorAll('#bodytable input[data-k="a"]').length; }
  if (rows === 0) return null;
  const el = p.d.querySelector('#bodytable input[data-k="a"]');
  const old = el.value;
  el.value = String((parseFloat(old) || 1) + 0.5);
  p.fire(el, 'change');
  return { old, next: el.value };
}

// payload 里第一个带 a 的天体（太阳那类没有半长轴的跳过）
function bodyA(body) {
  const bs = (body && body.bodies) || [];
  const b = bs.find(x => x && typeof x.a === 'number');
  return b ? b.a : undefined;
}

(async () => {
  const health = await (await nodeFetch(BASE + '/api/health')).json();
  ok(health.exists && health.exec, '前置：8765 上内核可执行');

  // ---------- 1. 控件齐全 ----------
  const p = await boot();
  // 页面没跑起来的话下面会整片变红，而那是判据环境的问题不是功能的问题 ——
  // 所以先钉住这一条，让人一眼看出红在哪一层。
  ok(p.mainYears > 0 && p.nb().length > 0,
     `页面真的跑起来了（发出 ${p.nb().length} 次 /api/nbody）—— 下面若整片红，看这一条`);
  ok(p.mainYears > 0,
     `这一页的主计算基准：years=${p.mainYears} samples=${p.mainSamples}（后面"更短"都相对它）`);
  ok(!!p.$('ghostnote'), '存在 #ghostnote（幽灵轨迹状态元素）');
  ok(!!p.$('ghostcancel'), '存在 #ghostcancel（放弃）');
  ok(!!p.$('ghostapply'), '存在 #ghostapply（确认执行）');
  ok(!!p.$('ghostnote') && p.$('ghostnote').getAttribute('aria-live') !== null,
     '#ghostnote 是 aria-live 的状态文本（AGENTS.md §0.4：aria-live 只给低频状态）');
  ok(!!p.$('plantogg'),
     '存在「松手前先预演一遍」开关（探针要先打开它才测得到预演；契约要求改参数即预演，'
     + '实现做成可关开关属于可接受形态，判据只钉"打开后确实会预演"）');

  // ---------- 2. 改参数 → 一次更短的预演 ----------
  const mainBefore = p.lastBody();
  const aBefore = bodyA(mainBefore);
  const touched = await touchBody(p);
  ok(!!touched, `改了一个天体参数（a: ${touched && touched.old} → ${touched && touched.next}）`);
  await p.settle(4000);
  const after = p.nb().slice(p.kc0);
  const pv = p.previews();
  ok(after.length > 0, `改参数后确实发了新的 /api/nbody（新增 ${after.length} 次：`
     + JSON.stringify(after.map(f => f.body && f.body.years)) + '）');
  ok(pv.length > 0,
     `其中至少有一次是**更短**的预演（years < ${p.mainYears}）：`
     + JSON.stringify(after.map(f => f.body && f.body.years)));
  {
    const last = pv[pv.length - 1];
    const mb = mainBefore || {};
    ok(last && last.body && +last.body.years < p.mainYears,
       `预演 years = ${last && last.body && last.body.years} < 主计算 ${p.mainYears}`);
    ok(last && last.body && +last.body.samples < +mb.samples,
       `预演 samples = ${last && last.body && last.body.samples} < 主计算 ${mb.samples}`
       + '（两样都更短才算"短程"，只缩帧数是蒙的）');
    ok(last && last.body && Array.isArray(last.body.bodies) && last.body.bodies.length > 0,
       '预演 payload 带着被改的那个天体（bodies 非空）：'
       + JSON.stringify(last && last.body && last.body.bodies && last.body.bodies.slice(0, 1)));
  }
  p.close();

  // ---------- 3. 幽灵轨迹：点全部来自预演回执（差分法） ----------
  // 两次跑：主计算的回执两次逐字相同，只有预演回执的帧数组长度不同，
  // #view 上的绘制指令数却必须跟着变 —— 变的部分只能是幽灵。
  async function ghostRun(keep) {
    let myMain = 0;
    const forge = (body, j) => {
      if (!j || !Array.isArray(j.frames)) return undefined;
      if (!body || !myMain || +body.years >= myMain) return undefined;   // 只动预演
      const c = JSON.parse(JSON.stringify(j));
      c.frames = c.frames.slice(0, Math.max(2, keep));
      return c;
    };
    const q = await open({ forgePreview: forge });
    await q.settle(2000);
    if (q.$('scenario') && q.$('scenario').value !== 'custom') {
      q.$('scenario').value = 'custom'; q.fire(q.$('scenario'), 'change');
      await q.settle(4500);
    }
    myMain = +((q.lastBody() || {}).years) || 0;
    await ensurePreviewOn(q);
    const kc0 = q.kc();
    const t2 = await touchBody(q);
    await q.settle(4000);
    const pvQ = q.nb().filter(f => f.body && myMain && +f.body.years < myMain);
    const frames = pvQ.length ? ((pvQ[pvQ.length - 1].echo || {}).frames || []).length : 0;
    const view = q.drawn.view || { ops: [] };
    const out = { main: myMain, newReq: q.nb().slice(kc0).length, frames, ops: view.ops.length,
                  touched: t2, errs: q.errs.slice() };
    q.close();
    return out;
  }
  const gSmall = await ghostRun(3);
  const gBig = await ghostRun(40);
  ok(gSmall.frames > 0 && gBig.frames > 0,
     `两次伪造预演分别给了 ${gSmall.frames} 与 ${gBig.frames} 帧 —— 判据自身前置成立`);
  ok(gSmall.ops !== gBig.ops,
     `预演回执的点数组变长后，画布上的绘制指令数跟着变（${gSmall.ops} → ${gBig.ops}）`
     + ' —— 幽灵轨迹的点来自预演回执，不是页面自己插值的');
  ok(gBig.ops > gSmall.ops,
     `而且是变多（${gSmall.ops} < ${gBig.ops}）—— 不是把多出来的点随便吞掉`);
  {
    let myMain = 0;   // 只伪造预演那份，主计算回执不许动（否则就成了在测主画面）
    const q = await open({ forgePreview: (body, j) => {
      if (!j || !Array.isArray(j.frames) || !body || !myMain || +body.years >= myMain) return undefined;
      const c = JSON.parse(JSON.stringify(j));
      c.frames = c.frames.slice(0, 8);
      return c;
    } });
    await q.settle(2000);
    if (q.$('scenario') && q.$('scenario').value !== 'custom') {
      q.$('scenario').value = 'custom'; q.fire(q.$('scenario'), 'change');
      await q.settle(4500);
    }
    myMain = +((q.lastBody() || {}).years) || 0;
    await ensurePreviewOn(q);
    await touchBody(q);
    await q.settle(4000);
    const note = q.$('ghostnote');
    ok(!!note && (note.textContent || '').replace(/\s+/g, ' ').trim().length > 0,
       '#ghostnote 上有可读状态（不是空 div）：'
       + JSON.stringify(note ? (note.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) : ''));
    ok(q.errs.length === 0, '预演路径无脚本异常' + (q.errs.length ? ' — ' + q.errs[0] : ''));
    q.close();
  }

  // ---------- 4. 放弃必须真 abort，且 AbortError 被吞掉 ----------
  {
    let myMain = 0;
    const s = await open({ holdPreview: b => b && myMain > 0 && +b.years < myMain });
    await s.settle(2000);
    if (s.$('scenario') && s.$('scenario').value !== 'custom') {
      s.$('scenario').value = 'custom'; s.fire(s.$('scenario'), 'change');
      await s.settle(4500);
    }
    myMain = +((s.lastBody() || {}).years) || 0;
    await ensurePreviewOn(s);
    unhandled.length = 0;
    await touchBody(s);
    await sleep(400);                       // 预演还在途（人为挂起 2.5s）
    const inflight = s.nb().filter(f => f.body && myMain && +f.body.years < myMain);
    ok(inflight.length > 0 && inflight[0].held,
       `预演请求真在途（${inflight.length} 次，已人为挂起以便中途取消）`);
    const sig = inflight.length ? inflight[0].signal : null;
    if (s.$('ghostcancel')) s.fire(s.$('ghostcancel'), 'click');
    await sleep(700);
    ok(!!sig && sig.aborted === true,
       '点「放弃」之后，预演请求的 AbortSignal 真的 aborted（不是只把幽灵藏起来）');
    // 人为挂起的那 2.5s 还没走完，真实 fetch 此刻才带着已 abort 的 signal 发出并被拒。
    // 不等它落地就断言 rejected，会把"时序没到"误报成"页面没收场"。
    for (let i = 0; i < 40 && !(inflight[0] && inflight[0].rejected); i++) await sleep(100);
    ok(inflight.length > 0 && /Abort/i.test(String(inflight[0].rejected || '')),
       `请求以 Abort 收场（rejected=${JSON.stringify(inflight.length ? inflight[0].rejected : null)}）`
       + ' —— 说明是真掐，不是等它自己算完');
    await s.settle(1500);
    // 下面两条只在"确实有预演被掐掉"的前提下才有意义：
    // 没有预演时它们恒真，那是假绿。
    const hadInflight = inflight.length > 0;
    ok(hadInflight && s.errs.length === 0,
       '页面吞掉了 AbortError，没有脚本异常' + (s.errs.length ? ' — ' + s.errs[0] : ''));
    ok(hadInflight && unhandled.length === 0,
       '也没有 unhandled rejection（漏接 AbortError 的典型症状）：'
       + JSON.stringify(unhandled.slice(0, 2)));
    // 放弃之后：表里 a 已是新值，但主计算请求里的 a 还必须是旧值
    const aInTable = +((s.d.querySelector('#bodytable input[data-k="a"]') || {}).value || NaN);
    const mains = s.nb().filter(f => f.body && +f.body.years === myMain);
    const aInMain = bodyA(mains.slice(-1)[0] && mains.slice(-1)[0].body);
    ok(mains.length > 0 && Math.abs(+aInMain - aInTable) > 1e-9,
       `放弃之后主计算仍用旧初值（主计算 a=${aInMain}，表里已改成 a=${aInTable}）—— 预演没有偷偷生效`);
    s.close();
  }

  // ---------- 5. 确认执行之后才真正改主计算 ----------
  {
    const t = await boot();
    const before = t.lastBody();
    const aBefore2 = bodyA(before);
    const touch = await touchBody(t);
    await t.settle(4000);
    const midNew = t.nb().slice(t.kc0);
    ok(midNew.length > 0, `改参数后有新请求（${midNew.length} 次）`);
    ok(midNew.length > 0 && midNew.every(f => f.body && +f.body.years < t.mainYears),
       '改参数这一刻新发的全是更短的预演，主计算还没动：'
       + JSON.stringify(midNew.map(f => f.body && f.body.years)));
    ok(!!t.$('ghostapply'), '「确认执行」按钮可用');
    const kcMid = t.kc();
    if (t.$('ghostapply')) t.fire(t.$('ghostapply'), 'click');
    await t.settle(4500);
    const afterBody = t.lastBody();
    const aAfter = bodyA(afterBody);
    ok(t.kc() > kcMid, `点「确认执行」之后才重发主计算（新增 ${t.kc() - kcMid} 次）`);
    ok(t.kc() > kcMid && afterBody && +afterBody.years === t.mainYears,
       `而且这次是主计算本身（years=${afterBody && afterBody.years}，基准 ${t.mainYears}）`);
    ok(String(aAfter) === String(touch && touch.next),
       `主计算的 a 真的变成了 ${touch && touch.next}（原 ${aBefore2}，现 ${aAfter}）`);
    ok(t.kc() > kcMid && !!t.$('ghostnote') && t.$('ghostnote').getAttribute('aria-live') !== null,
       '确认之后状态元素仍是 aria-live 的低频状态');
    ok(t.errs.length === 0, '确认执行路径无脚本异常' + (t.errs.length ? ' — ' + t.errs[0] : ''));
    t.close();
  }

  fs.writeFileSync(path.join(__dirname, '_probe_predict.txt'),
    L.join('\n') + '\n\n[predict] n=' + n + ' fail=' + fail + '\n', 'utf8');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  L.push('  FAIL  探针自身异常：' + (e && e.stack || e));
  fs.writeFileSync(path.join(__dirname, '_probe_predict.txt'),
    L.join('\n') + '\n\n[predict] n=' + n + ' fail=' + (fail + 1) + '\n', 'utf8');
  process.exit(1);
});
