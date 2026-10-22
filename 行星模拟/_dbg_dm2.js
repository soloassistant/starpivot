// 临时诊断（dualmode 那 5 条红）：按 _probe_dualmode.js 的方式真加载页面、真发网络，
// 把**每一次 /api/nbody 请求**的开始/结束、耗时、HTTP 状态、回执里有没有 body_types / bodies
// 以及页面自己抛的异常，逐条打出来。
//
// 为什么要这么细：探针只记 FAIL、不记时序。而"回执里查不到那颗黑洞"与"调色板没按钮"
// 这两种症状都可以由**同一个**原因来（请求还没回来 / 请求失败），必须先分清。
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const BASE = 'http://localhost:8765';
const nodeFetch = globalThis.fetch;
const noop = () => {};
const texts = [];
const ctxStub = new Proxy({}, { get: (t, k) =>
  (k === 'createRadialGradient' || k === 'createLinearGradient') ? () => ({ addColorStop: noop })
  : (k === 'measureText' ? () => ({ width: 10 })
     : (k === 'fillText' ? (s) => { texts.push(String(s)); } : noop)), set: () => true });
const STORE_KEY = 'starpivot.universe.session';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const lg = (...a) => console.log('[' + String(Date.now() - t0).padStart(6) + 'ms]', ...a);

async function open(hash = '', seedStore = null) {
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', e => errs.push('[jsdomError] ' + (e && e.message) + '\n    '
    + String((e && e.stack) || '').split('\n').slice(0, 4).join('\n    ')));
  vc.on('console', m => { if (m.type() === 'error') errs.push('[console.error] ' + m.text()); });
  const rafQueue = [], fetchLog = [], respLog = [];
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
        const seq = fetchLog.length + 1;
        const rt = Date.now();
        fetchLog.push({ url: String(u), body: b });
        if (isNb) lg('→ 发 #' + seq, 'bodies='
          + ((b && b.bodies || []).map(x => x.name + '(' + (x.type || '-') + ')').join(',')),
          'scenario=' + (b && b.scenario), 'primary=' + (b && b.primary));
        if (isNb) lg('   payload = ' + JSON.stringify(b).slice(0, 1400));
        return nodeFetch(new URL(String(u), BASE).href, o).then(r => {
          if (isNb) lg('← 收 #' + seq, 'HTTP ' + r.status, '耗时 ' + (Date.now() - rt) + 'ms');
          if (isNb) r.clone().json().then(j => {
            respLog.push(j);
            const names = ((j.bodies || []).map(x => x.id)).join(',');
            lg('   #' + seq + ' 回执 keys=' + Object.keys(j).slice(0, 8).join('/')
              + ' | body_types=' + ((j.body_types || []).length)
              + ' | bodies=[' + names + ']'
              + (j.error ? ' | ERROR=' + JSON.stringify(j.error).slice(0, 200) : ''));
          }).catch(e => lg('   #' + seq + ' 回执不是 JSON：' + e.message));
          return r;
        }, e => { if (isNb) lg('← 收 #' + seq, '网络错误 ' + e.message + ' 耗时 ' + (Date.now() - rt) + 'ms'); throw e; });
      };
    }
  });
  const w = dom.window, d = w.document;
  let t = 0;
  const step = (k = 1, dt = 16) => { for (let i = 0; i < k; i++) { const cb = rafQueue.shift(); if (cb) cb(1000 + (t += dt)); } };
  const $ = id => d.getElementById(id);
  const fire = (el, ty) => el.dispatchEvent(new w.Event(ty, { bubbles: true }));
  const settle = async (ms = 500) => { await sleep(ms); step(2); await sleep(30); };
  const cvEl = $('view');
  Object.defineProperty(cvEl, 'width', { value: 800, writable: true });
  Object.defineProperty(cvEl, 'height', { value: 600, writable: true });
  cvEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  cvEl.setPointerCapture = () => {}; cvEl.releasePointerCapture = () => {};
  return { w, d, $, fire, step, settle, fetchLog, respLog, errs, texts,
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

(async () => {
  // ================= 第一段：和探针完全一样地走到"放一颗黑洞" =================
  lg('=== 第一段：开页 → 放黑洞 ===');
  const p = await open();
  await p.settle(2500);
  lg('页面异常:', p.errs.length ? p.errs.join('\n') : '（无）');
  lg('调色板按钮数:', p.d.querySelectorAll('#palette button').length);
  if (p.$('play').textContent.indexOf('暂停') >= 0) { p.fire(p.$('play'), 'click'); await p.settle(200); }

  const bhBtn = [...p.d.querySelectorAll('#palette button')].find(b => b.textContent.includes('黑洞'));
  lg('黑洞按钮:', bhBtn ? bhBtn.textContent.trim() : '（没找到）');
  bhBtn.dispatchEvent(new p.w.Event('click', { bubbles: true }));
  await p.settle(3000);
  lg('--- 选类型后 ---  请求数=' + p.kc(), '当前按钮=' + p.$('compute').textContent,
     'disabled=' + p.$('compute').disabled);

  const nBefore = p.d.querySelectorAll('#simplebodies .bodycard').length;
  mouse(p, 620, 300);
  await p.settle(3000);
  lg('--- 点画面放黑洞后（settle 3000）--- 请求数=' + p.kc());
  lg('  compute 按钮 =', JSON.stringify(p.$('compute').textContent), 'disabled=' + p.$('compute').disabled);
  lg('  卡片数 =', p.d.querySelectorAll('#simplebodies .bodycard').length, '（放之前 ' + nBefore + '）');
  const added = (p.lastPayload().bodies || []).slice(-1)[0];
  lg('  payload 最后一颗 =', added && added.name, added && added.type);
  lg('  lastResp bodies =', ((p.lastResp() || {}).bodies || []).map(x => x.id).join(','));
  const hit = ((p.lastResp() || {}).bodies || []).find(b => b.id === (added && added.name));
  lg('  lastResp 里找 ' + (added && added.name) + ' →', hit ? JSON.stringify({ r: hit.radius_km, emits: hit.emits_light }) : '没找到');

  // ---- 额外等一段，看是不是"只是慢" ----
  const k0 = p.kc();
  await p.settle(6000);
  lg('--- 再等 6 秒 --- 请求数 ' + k0 + ' → ' + p.kc());
  lg('  compute 按钮 =', JSON.stringify(p.$('compute').textContent), 'disabled=' + p.$('compute').disabled);
  const hit2 = ((p.lastResp() || {}).bodies || []).find(b => b.id === (added && added.name));
  lg('  现在 lastResp 里找得到吗 →', hit2 ? JSON.stringify({ r: hit2.radius_km, emits: hit2.emits_light }) : '仍然没有');
  lg('  errbar.display =', p.$('errbar') ? p.$('errbar').style.display : '(无)');
  lg('  errbar 内容 =', JSON.stringify((p.$('errbar') ? p.$('errbar').textContent : '').slice(0, 300)));
  lg('  页面异常:', p.errs.length ? p.errs.join('\n') : '（无）');

  // ---- 拖旋钮 ----
  const cards = [...p.d.querySelectorAll('#simplebodies .bodycard')];
  const card = cards[cards.length - 1];
  const sliders = [...card.querySelectorAll('input[type=range]')];
  lg('  最后一卡旋钮 =', sliders.map(s => s.dataset.k).join(','));
  const kA = sliders.find(s => s.dataset.k === 'a');
  if (kA) {
    kA.value = '2.5'; p.fire(kA, 'input'); await sleep(150);
    lg('  拖完旋钮 compute 按钮 =', JSON.stringify(p.$('compute').textContent), 'disabled=' + p.$('compute').disabled);
    lg('  卡片文字含 2.50 AU ?', /2\.50 AU/.test(card.textContent));
    const dh = p.$('dirtyhint');
    lg('  dirtyhint.display =', dh ? dh.style.display : '(无)');
  }

  // ---- 存档 ----
  await sleep(700);
  const rawStore = p.w.localStorage.getItem(STORE_KEY);
  lg('存档 pendingType =', rawStore ? JSON.parse(rawStore).pendingType : '(无存档)');
  lg('存档 bodies =', rawStore ? (JSON.parse(rawStore).bodies || []).map(b => b.name + '(' + (b.type || '-') + ')').join(',') : '');
  p.close();

  // ================= 第二段：重开 =================
  lg('');
  lg('=== 第二段：带存档重开 ===');
  const q = await open('', rawStore);
  await q.settle(3000);
  lg('  请求数=' + q.kc(), '调色板按钮数=' + q.d.querySelectorAll('#palette button').length);
  lg('  #palette 内容 =', JSON.stringify(q.$('palette').innerHTML.slice(0, 260)));
  lg('  页面异常:', q.errs.length ? q.errs.join('\n') : '（无）');
  await q.settle(5000);
  lg('  再等 5 秒 → 请求数=' + q.kc(), '调色板按钮数=' + q.d.querySelectorAll('#palette button').length);
  q.close();
  process.exit(0);
})().catch(e => { console.error('诊断器自身异常:', e && e.stack || e); process.exit(1); });
