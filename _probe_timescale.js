// 时间压缩档位（跨度）的判据。契约：docs/bench-contract-2026-10-05.md §4.2。
//
// 这条探针存在的理由是「死控件」这个家族里最难查的一支：
// 现有 #years 是一个自由输入框，页面上任何「跨度」下拉都可以只改一个显示文本就看起来能用。
// 判据因此只认两件事 —— (a) 改档位之后真的多发了一次 /api/nbody 且 body 里 years 变了；
// (b) 页面把「跨度」和「播放速度」写成两件事（#speed 是播放帧率，不许动它）。
// 两者任一为假就是红的，不接受「下拉存在」算通过。
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
const ctxStub = new Proxy({}, { get: (t, k) =>
  (k === 'createRadialGradient' || k === 'createLinearGradient') ? () => ({ addColorStop: noop })
  : (k === 'measureText' ? () => ({ width: 10 }) : noop), set: () => true });

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
  const rafQueue = [], fetchLog = [];
  const dom = new JSDOM(await pageHtml(), {
    url: BASE + '/universe.html' + (opts.hash || ''), runScripts: 'dangerously', virtualConsole: vc,
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = () => ctxStub;
      w.requestAnimationFrame = cb => { rafQueue.push(cb); return rafQueue.length; };
      w.cancelAnimationFrame = noop;
      w.scrollTo = noop;
      // "重开页面"：把上次真写进 localStorage 的字节喂进新实例，
      // 必须在页面脚本跑之前塞好，否则它已经读完了。
      if (opts.store) { try { w.localStorage.setItem('starpivot.universe.session', opts.store); } catch (e) {} }
      w.fetch = (u, o) => {
        const url = String(u);
        let body = null; if (o && o.body) { try { body = JSON.parse(o.body); } catch (e) {} }
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
  const nb = () => fetchLog.filter(f => f.url.includes('/api/nbody'));
  return { w, d, $, fire, step, settle, fetchLog, errs, nb,
           kc: () => nb().length,
           lastBody: () => (nb().slice(-1)[0] || {}).body,
           close: () => dom.window.close() };
}

(async () => {
  const health = await (await nodeFetch(BASE + '/api/health')).json();
  ok(health.exists && health.exec, '前置：8765 上内核可执行（' + (health.exe || '?') + '）');

  // ---------- 1. 控件存在且是 select，4 档 ----------
  const p = await open();
  await p.settle(2000);
  // 页面没跑起来的话下面会整片变红，而那是判据环境的问题不是功能的问题 ——
  // 所以先钉住这一条，让人一眼看出红在哪一层。
  ok(p.kc() > 0, `页面真的跑起来了（发出 ${p.kc()} 次 /api/nbody）—— 下面若整片红，看这一条`);
  const sel = p.$('spanmode');
  ok(!!sel, '存在 #spanmode 下拉（跨度档位，契约 §4.2）');
  ok(sel && sel.tagName === 'SELECT', '#spanmode 真的是 <select>（不是 input 也不是 div 伪下拉）');
  const opts = sel ? [...sel.querySelectorAll('option')] : [];
  const vals = opts.map(o => o.value);
  ok(vals.length === 4, `档位数 = ${vals.length}（应为 4：1/10/100/1000 年）`);
  ok(JSON.stringify(vals) === JSON.stringify(['1', '10', '100', '1000']),
     '四档的 value 逐字是 "1" / "10" / "100" / "1000"（年跨度）：' + vals.join(','));
  ok(opts.length > 0 && opts.every(o => o.textContent.trim().length > 0),
     `每个档位都有可读标签（不是空白项，共 ${opts.length} 项）`);

  // ---------- 2. 切档必须真的重下发 payload ----------
  // 现有 #years 是自由输入框：一个只改显示文本的下拉可以让这一整节全绿，
  // 所以判据直接看发出去的 body.years。
  const before = p.kc();
  const firstBody = p.lastBody();
  if (sel) {
    sel.value = '1000';
    p.fire(sel, 'change');
    await p.settle(3000);
  }
  const after = p.kc();
  ok(after > before, `切到 1000 年档真的重发了一次内核（请求 ${before} → ${after}）`);
  const b2 = p.lastBody();
  ok(!!b2 && String(b2.years) === '1000',
     `新 payload 的 years 跟着档位变了（${JSON.stringify(firstBody && firstBody.years)} → ${JSON.stringify(b2 && b2.years)}）`);
  ok(!!b2 && b2.years !== (firstBody && firstBody.years),
     'years 确实变了（不是把同一个值又发了一遍）');

  // 再切回来：档位与 payload 仍要一一对应，否则「双向可切」是假的
  if (sel) {
    const n1 = p.kc();
    sel.value = '1'; p.fire(sel, 'change'); await p.settle(3000);
    const b3 = p.lastBody();
    ok(p.kc() > n1 && String(b3 && b3.years) === '1',
       `切回 1 年档也重发且 years=1（请求 ${n1} → ${p.kc()}，years=${JSON.stringify(b3 && b3.years)}）`);
  }

  // ---------- 3. 页面上写清「跨度」≠「播放速度」 ----------
  // #speed 是播放帧率，契约明令不许删。这里钉住它还在，同时要求页面有解释文案。
  ok(!!p.$('speed') && p.$('speed').type === 'range',
     '#speed（播放帧率滑杆）仍然存在且是 range —— 跨度档位不许把它顶掉');
  {
    // 取证范围：#spanmode 所在的那块。拿整页当证据会踩到"跨度拉长到几千年"
    // 这类算法说明里的"跨度"二字 —— 那与档位无关。
    // 取证范围优先用外层 section：说明文字常与控件分成兄弟 div，
    // 只看 closest('div') 只会拿到"标签 + 下拉"那一个窄盒。
    const scope = sel ? (sel.closest('section') || sel.closest('fieldset')
                         || sel.closest('details') || sel.closest('div') || sel.parentElement) : null;
    const t = scope ? (scope.textContent || '').replace(/\s+/g, ' ') : '';
    ok(!!scope, '跨度控件有自己的容器（文案判据有明确取证范围）');
    const bothMentioned = (s) => /跨度/.test(s) && /播放速度|播放帧率|每秒帧|帧率/.test(s);
    ok(t.length > 0 && bothMentioned(t),
       '跨度控件附近同时出现「跨度」与「播放速度/帧率」两个概念：' + JSON.stringify(t.slice(0, 90)));
    const saysDifferent = (s) => bothMentioned(s)
      && /(两件事|不是一回事|不同于|≠|两码事|分别|各管|互相独立|另一件事|不影响)/.test(s);
    ok(saysDifferent(t),
       '并且说清两者是两件事（不是同一个旋钮的两种叫法）：' + JSON.stringify(t.slice(0, 120)));
    // 负样本：换成一句空话，同一处判不通过 —— 自证这条检查不是恒真
    ok(!saysDifferent('跨度就是播放速度。'),
       '负样本：把文案换成「跨度就是播放速度」，同一处判不通过');
  }

  // ---------- 4. 档位不该偷偷改播放帧率（两个旋钮各管各的） ----------
  {
    const spd0 = p.$('speed').value;
    const n0 = p.kc();
    if (sel) { sel.value = '100'; p.fire(sel, 'change'); await p.settle(3000); }
    ok(!!sel && p.$('speed').value === spd0,
       `切跨度不动播放速度滑杆（仍为 ${spd0}）—— 两者是独立旋钮`);
    ok(!!sel && p.kc() > n0 && String((p.lastBody() || {}).years) === '100',
       `100 年档重发且 years=100（years=${JSON.stringify((p.lastBody() || {}).years)}）`);
  }

  // ---------- 5. 档位要进会话（不然每次进来都回到默认，等于没有档位） ----------
  await p.settle(800);
  {
    const raw = p.w.localStorage.getItem('starpivot.universe.session');
    const snap = raw ? JSON.parse(raw) : {};
    const hasSpan = snap.spanmode !== undefined || snap.span !== undefined
                 || String(snap.years) === String(p.$('spanmode') && p.$('spanmode').value);
    ok(hasSpan, '档位（或它映射出来的 years）落进了会话快照：'
       + JSON.stringify({ spanmode: snap.spanmode, span: snap.span, years: snap.years }));
  }
  const rawSave = p.w.localStorage.getItem('starpivot.universe.session');
  ok(!!rawSave, '会话已落盘（下面重开要用它）');
  ok(p.errs.length === 0, '全程无脚本异常' + (p.errs.length ? ' — ' + p.errs[0] : ''));
  p.close();

  // 重开：档位回来
  const q = await open({ store: rawSave });
  await q.settle(2500);
  ok(!!q.$('spanmode') && q.$('spanmode').value === '100',
     `重开后档位回到 100（实际 ${q.$('spanmode') && q.$('spanmode').value}）`);
  ok(String((q.lastBody() || {}).years) === '100',
     `而且重开时是按 100 年去问内核的（years=${JSON.stringify((q.lastBody() || {}).years)}）`);
  ok(q.errs.length === 0, '重开无脚本异常' + (q.errs.length ? ' — ' + q.errs[0] : ''));
  q.close();

  fs.writeFileSync(path.join(__dirname, '_probe_timescale.txt'),
    L.join('\n') + '\n\n[timescale] n=' + n + ' fail=' + fail + '\n', 'utf8');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  L.push('  FAIL  探针自身异常：' + (e && e.stack || e));
  fs.writeFileSync(path.join(__dirname, '_probe_timescale.txt'),
    L.join('\n') + '\n\n[timescale] n=' + n + ' fail=' + (fail + 1) + '\n', 'utf8');
  process.exit(1);
});
