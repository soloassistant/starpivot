// 方案保存与分享的判据。契约：docs/bench-contract-2026-10-05.md §4.3。
//
// 现有 share-hash 机制把整份 snapshot 编成 base64 塞进 #s=。
// 这一版要把它升级成"可命名、可收藏、可再载入"，所以判据盯：
//   (1) 命名保存 → #schemelist 里出现 li.scheme[data-sid]，含名字与可点的载入按钮；
//   (2) 载入逐项还原（初值 / 积分器 / 跨度 / 选中态）—— 逐项断言，不看整体"像是变了"；
//   (3) 不冲掉对方会话：打开别人的分享链接时不能覆盖你自己已存的那份
//       （沿用 persistBlocked 既有行为，见 _probe_nav.js §3）。
// 负样本放在最后：把"载入还原"抽成纯函数，塞一份没变的初值进去，必须判不通过。
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
const NAME = '我的第一次星系';
const NAME2 = '备选：共振布局';

// opts.store —— 预置会话字节（模拟"上次退出留下的"），必须在页面脚本跑之前塞进去
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
      w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
        get: (t, k) => (k === 'createRadialGradient' || k === 'createLinearGradient')
          ? () => ({ addColorStop: noop }) : (k === 'measureText' ? () => ({ width: 10 }) : noop),
        set: () => true });
      w.requestAnimationFrame = cb => { rafQueue.push(cb); return rafQueue.length; };
      w.cancelAnimationFrame = noop;
      w.scrollTo = noop;
      // 页面在 pointerdown 里调 setPointerCapture；jsdom 没有这个方法，
      // 不补上就会抛 TypeError 并被算成页面异常（那是判据环境的问题，不是页面的）。
      w.HTMLCanvasElement.prototype.setPointerCapture = noop;
      w.HTMLCanvasElement.prototype.releasePointerCapture = noop;
      if (opts.store) { try { w.localStorage.setItem(KEY, opts.store); } catch (e) {} }
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
  const set = (id, v, ty = 'change') => { const el = $(id); if (!el) return null; el.value = v; fire(el, ty); return el; };
  return { w, d, $, fire, step, settle, set, fetchLog, errs,
           items: () => [...d.querySelectorAll('#schemelist li.scheme')],
           kc: () => fetchLog.filter(f => f.url.includes('/api/nbody')).length,
           close: () => dom.window.close() };
}

// 选一个方案：填名字 → 点保存
async function save(p, name) {
  const el = p.$('schemename');
  if (!el) return null;
  el.value = name;
  p.fire(el, 'input'); p.fire(el, 'change');
  const n0 = p.items().length;
  if (p.$('schemesave')) p.fire(p.$('schemesave'), 'click');
  await p.settle(600);
  return { before: n0, after: p.items().length };
}

// 载入一个方案：点该条目的载入按钮
async function load(p, sid) {
  const li = p.items().find(x => x.dataset.sid === sid) || p.items()[0];
  if (!li) return null;
  const btn = li.querySelector('button[data-load], button[data-act="load"], button') || li;
  btn.dispatchEvent(new p.w.Event('click', { bubbles: true }));
  await p.settle(4000);
  return li;
}

(async () => {
  const health = await (await nodeFetch(BASE + '/api/health')).json();
  ok(health.exists && health.exec, '前置：8765 上内核可执行');

  // ---------- 1. 控件 ----------
  const p = await open();
  await p.settle(2500);
  // 页面没跑起来的话下面会整片变红，而那是判据环境的问题不是功能的问题 ——
  // 所以先钉住这一条，让人一眼看出红在哪一层。
  ok(p.kc() > 0, `页面真的跑起来了（发出 ${p.kc()} 次 /api/nbody）—— 下面若整片红，看这一条`);
  ok(!!p.$('schemename'), '存在 #schemename（方案名字输入）');
  ok(!!p.$('schemename') && p.$('schemename').tagName === 'INPUT', '#schemename 是 <input>');
  ok(!!p.$('schemesave'), '存在 #schemesave（保存按钮）');
  ok(!!p.$('schemename') && p.$('schemesave') && !!p.$('schemesave').closest('div, .card, section'),
     '方案控件有明确的容器（文案与取证范围）');
  ok(!!p.$('schemelist'), '存在 #schemelist（方案列表）');
  ok(!!p.$('schemelist') && p.$('schemelist').tagName === 'UL', '#schemelist 是 <ul>');
  ok(!!p.$('share'), '原有「复制分享链接」按钮仍在（分享机制不许被删）');

  // ---------- 2. 命名保存 ----------
  const s1 = await save(p, NAME);
  ok(!!s1, `填了名字「${NAME}」并点了保存`);
  ok(!!s1 && s1.after > s1.before, `列表多了一条（${s1 && s1.before} → ${s1 && s1.after}）`);
  const items = p.items();
  ok(items.length > 0, `li.scheme 存在（${items.length} 条）`);
  // 下面几条都带 items.length > 0：0 条时 every() 恒真，那是假绿
  ok(items.length > 0 && items.every(li => !!li.dataset.sid),
     `每条都有 data-sid（稳定标识，再载入靠它），共 ${items.length} 条`);
  ok(items.length > 0 && items.every(li => li.textContent.indexOf(NAME) >= 0),
     `每条都显示自己起的名字（找「${NAME}」）`);
  ok(items.length > 0 && items.every(li => !!li.querySelector('button')),
     '每条里有一个可点的载入按钮');
  // 负样本：没名字不许存（否则点一下就多一条垃圾）
  {
    const nBefore = p.items().length;
    await save(p, '');
    await sleep(300);
    ok(p.items().length === nBefore,
       `空名字点保存不会新增条目（${nBefore} → ${p.items().length}）—— 否则"命名"是假的`);
  }
  const s2 = await save(p, NAME2);
  ok(!!s2 && s2.after > s1.after, '能存第二份不同名字的方案：' + JSON.stringify(p.items().map(x => x.textContent.slice(0, 12))));
  ok(p.items().length >= 2, `列表里有多份方案（${p.items().length} 条）`);
  ok(p.items().length > 0 && new Set(p.items().map(x => x.dataset.sid)).size === p.items().length,
     `每份方案的 data-sid 互不相同（${p.items().length} 条）`);

  // ---------- 3. 载入逐项还原 ----------
  // 造一套"非默认"设定：初值、积分器、跨度、选中态都要与默认不同，
  // 否则"还原"与"什么都没做"分不开。
  const saved = {
    scenario: 'custom', integ: 'hermite',
    years: '7', samples: '333', a: '2.25', sel: 0,
  };
  p.set('scenario', 'custom', 'change'); await p.settle(4000);
  p.set('integ', 'hermite', 'change'); await p.settle(3000);
  // 跨度先定档，再手工把 years 改成非档位值 —— 这样"跨度档位"与"年数"是两个
  // 独立维度，载入时才能分清是哪个被还原了。
  p.set('spanmode', '10', 'change'); await p.settle(3500);
  p.set('years', saved.years, 'change'); p.set('samples', saved.samples, 'change');
  await p.settle(1000);
  // 改一个天体的半长轴
  {
    let rows = p.d.querySelectorAll('#bodytable input[data-k="a"]').length;
    let g = 0;
    while (rows === 0 && g++ < 3) { p.fire(p.$('addbody'), 'click'); await sleep(150); rows = p.d.querySelectorAll('#bodytable input[data-k="a"]').length; }
    const el = p.d.querySelector('#bodytable input[data-k="a"]');
    if (el) { el.value = saved.a; p.fire(el, 'change'); }
  }
  // 选中态：点画面选中一颗（走页面自己的 pickAt，不手工改内部变量）。
  // 扫一圈点位是因为页面按"离光标最近且在半径内"命中，猜一个坐标不一定中。
  {
    const cv = p.$('view');
    if (cv) {
      cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
      const ev = (t, x, y) => {
        const e = new p.w.MouseEvent(t, { bubbles: true, clientX: x, clientY: y });
        e.pointerId = 1; e.pointerType = 'mouse';
        return e;
      };
      outer:
      for (let y = 60; y <= 560; y += 20) {
        for (let x = 60; x <= 760; x += 20) {
          try {
            cv.dispatchEvent(ev('pointerdown', x, y));
            cv.dispatchEvent(ev('pointerup', x, y));
          } catch (e) { /* 指针事件造不出来就停 */ }
          // updateSelCard 是在 render() 里跑的，必须推帧才看得到卡片翻出来
          p.step(1); await sleep(20); p.step(1);
          if (p.$('selcard') && p.$('selcard').style.display === 'block') break outer;
        }
      }
    }
  }
  ok(p.$('selcard') && p.$('selcard').style.display === 'block',
     '能通过点画面选中一颗星（选中态这一项才有东西可还原）：selcard.display='
     + (p.$('selcard') && p.$('selcard').style.display));
  await p.settle(4000);
  const s3 = await save(p, '还原基准');
  ok(!!s3, '把上面这套非默认设定存成第三份方案');
  // schemes 是 unshift 的：刚存的那份在**第一条**，不是最后一条。
  const sidA = p.items()[1] && p.items()[1].dataset.sid;
  const sidC = p.items()[0] && p.items()[0].dataset.sid;
  ok(!!sidA && !!sidC && sidA !== sidC, '两份方案的 sid 不同，可以分别载入');

  // 记下"还原基准"这套设定的实际值（从 DOM 读，不从内部变量偷看）
  const readState = () => ({
    scenario: p.$('scenario') && p.$('scenario').value,
    integ: p.$('integ') && p.$('integ').value,
    years: p.$('years') && p.$('years').value,
    samples: p.$('samples') && p.$('samples').value,
    span: p.$('spanmode') ? p.$('spanmode').value : null,
    a: (p.d.querySelector('#bodytable input[data-k="a"]') || {}).value,
    selcard: p.$('selcard') ? p.$('selcard').style.display : null,
  });
  const stateC = readState();
  ok(stateC.scenario === 'custom' && stateC.integ === 'hermite' && String(stateC.years) === '7',
     `存下来的设定是非默认的：scenario=${stateC.scenario} integ=${stateC.integ} years=${stateC.years}`);
  ok(stateC.a === '2.25', `存下来的初值是非默认的：a=${stateC.a}`);
  ok(stateC.selcard === 'block',
     `存下来时确实选中了天体（selcard.display=${stateC.selcard}）—— 否则"还原选中态"无从断言`);

  // 改乱：切场景、换算法、拖年数、拖帧数、改半长轴。
  // 每一项都要真的与存下来那份不同，否则"还原"与"没动"分不开。
  p.set('scenario', 'figure8', 'change'); await p.settle(4000);
  p.set('integ', 'euler', 'change'); await p.settle(3000);
  p.set('years', '31', 'change'); p.set('samples', '777', 'change'); await p.settle(1000);
  // 跨度也要改乱：档位与年数是两套语义，这一项单独验
  p.set('spanmode', '1', 'change'); await p.settle(3500);
  {
    const el = p.d.querySelector('#bodytable input[data-k="a"]');
    if (el) { el.value = '9.99'; p.fire(el, 'change'); }
  }
  if (p.$('selclose')) p.fire(p.$('selclose'), 'click');
  await p.settle(3000);
  p.step(2); await sleep(100);
  const stateScrambled = readState();
  ok(JSON.stringify(stateScrambled) !== JSON.stringify(stateC), '设定确实被改乱了：'
     + JSON.stringify(stateScrambled));

  await load(p, sidC);
  const after = readState();
  // 每一项都要求"改乱时确实与存的不一样"——否则这条判据在还原失败时也可能靠
  // "反正没改过"蒙混过去。
  const differs = (k) => String(stateScrambled[k]) !== String(stateC[k]);
  ok(differs('scenario') && after.scenario === stateC.scenario,
     `载入还原了场景（改乱成 ${stateScrambled.scenario} → 还原 ${after.scenario}，应为 ${stateC.scenario}）`);
  ok(differs('integ') && after.integ === stateC.integ,
     `载入还原了积分器（改乱成 ${stateScrambled.integ} → 还原 ${after.integ}，应为 ${stateC.integ}）`);
  ok(differs('years') && String(after.years) === String(stateC.years),
     `载入还原了年数（改乱成 ${stateScrambled.years} → 还原 ${after.years}，应为 ${stateC.years}）`);
  ok(differs('samples') && String(after.samples) === String(stateC.samples),
     `载入还原了帧数（改乱成 ${stateScrambled.samples} → 还原 ${after.samples}，应为 ${stateC.samples}）`);
  // 跨度：#spanmode 不存在时（还没实现）这条判不通过，正是本探针要的红
  ok(differs('span') && String(after.span) === String(stateC.span),
     `载入还原了跨度档位（改乱成 ${JSON.stringify(stateScrambled.span)} → 还原 ${JSON.stringify(after.span)}，`
     + `应为 ${JSON.stringify(stateC.span)}）`);
  ok(differs('a') && String(after.a) === String(stateC.a),
     `载入还原了初值 a（改乱成 ${stateScrambled.a} → 还原 ${after.a}，应为 ${stateC.a}）`
     + ' —— 这一项最能说明"逐项还原"不是空话');
  ok(differs('selcard') && after.selcard === stateC.selcard,
     `载入还原了选中态（改乱成 ${stateScrambled.selcard} → 还原 ${after.selcard}，应为 ${stateC.selcard}）`
     + ' —— 方案里存了视角与 cam.sel，载入后画面上要真的亮起那张卡');
  ok(p.errs.length === 0, '保存/载入路径无脚本异常' + (p.errs.length ? ' — ' + p.errs[0] : ''));

  // ---------- 4. 方案要落盘（关掉重开还在） ----------
  await p.settle(800);
  const raw = p.w.localStorage.getItem(KEY);
  ok(!!raw, '方案保存后 localStorage 里有会话快照');
  const snapHasScheme = !!raw && /scheme|方案/i.test(raw);
  ok(snapHasScheme, '快照里带着方案清单（契约 §4.3「不新增存储机制」的话它必须在既有 session 里）：'
     + JSON.stringify(raw ? Object.keys(JSON.parse(raw)).filter(k => /scheme/i.test(k)) : []));
  p.close();

  const q = await open({ store: raw });
  await q.settle(3000);
  ok(q.items().length >= 3, `重开后方案清单还在（${q.items().length} 条）`);
  ok(q.items().some(li => li.textContent.indexOf(NAME) >= 0), `重开后名字「${NAME}」还在`);
  ok(q.errs.length === 0, '重开无脚本异常' + (q.errs.length ? ' — ' + q.errs[0] : ''));

  // ---------- 5. 不冲掉对方会话 ----------
  // 沿用现有 share 行为：打开别人的分享链接时 persistBlocked，不许写盘。
  {
    q.fire(q.$('share'), 'click');
    await sleep(300);
    const hash = q.w.location.hash;
    ok(/^#s=[A-Za-z0-9_-]+$/.test(hash), '点分享后拿到 #s= 链接（' + hash.slice(0, 20) + '…）');
    const mine = q.w.localStorage.getItem(KEY);
    const shared = hash.slice(3);
    q.close();

    const v = await open({ hash: '#s=' + shared, store: mine });   // 对方带着自己的存档来开链接
    await v.settle(3500);
    ok(v.errs.length === 0, '打开分享链接无脚本异常' + (v.errs.length ? ' — ' + v.errs[0] : ''));
    // 被动操作（点逐帧）不该改写自己的存档
    if (v.$('fr_next')) v.fire(v.$('fr_next'), 'click');
    await v.settle(400);
    await sleep(800);
    ok(v.w.localStorage.getItem(KEY) === mine,
       '只是打开别人的分享链接、点了个逐帧，自己的会话没有被改写');
    // 方案清单也不该被对方的设定冲掉。
    // 注意取证：预览别人的设定时，页面上那列显示的是**当前会话**（也就是对方的），
    // 所以空列表是可以接受的设计；真正不许丢的是 localStorage 里你那份字节。
    const stillThere = (() => {
      const cur = v.w.localStorage.getItem(KEY) || '';
      return cur.indexOf(NAME) >= 0 && /scheme/i.test(cur);
    })();
    ok(stillThere,
       `打开分享链接后 localStorage 里你自己那份方案清单（含「${NAME}」）还在`
       + `（页面当前渲染 ${v.items().length} 条 —— 那是当前会话的，不是你的存档）`);
    // 自己动手改了才认下：这时写进去的必须是"你自己在看的这套"，
    // 也就是链接里带来的那份，而不是把对方的东西继续原样留着。
    v.set('years', '99', 'change');
    let afterMine = null;
    for (let i = 0; i < 20; i++) { afterMine = v.w.localStorage.getItem(KEY); if (afterMine !== mine) break; await sleep(100); }
    ok(!!afterMine && afterMine !== mine && JSON.parse(afterMine).years === '99',
       `自己改了参数之后才写入（years=${afterMine && JSON.parse(afterMine).years}，`
       + '存的是你自己这份会话）');
    ok(!!afterMine && afterMine.indexOf(NAME) >= 0,
       '而且你自己的方案清单没被这次写入挤掉');
    v.close();
  }

  // ---------- 6. 负样本总闸 ----------
  // 把"载入还原"抽成纯函数：逐项比对。塞一份没改的初值进去，必须判不通过。
  {
    const restored = (before, after) => {
      const keys = ['scenario', 'integ', 'years', 'samples', 'a'];
      return keys.every(k => String(before[k]) === String(after[k]));
    };
    const B = { scenario: 'custom', integ: 'hermite', years: '7', samples: '333', a: '2.25' };
    ok(restored(B, Object.assign({}, B)),
       '（自检）纯函数在"逐项都没变"时判通过 —— 负样本的前提是它本来能通过');
    ok(!restored(B, Object.assign({}, B, { a: '9.99' })),
       '负样本：只把初值改坏，同一处判不通过');
    ok(!restored(B, Object.assign({}, B, { integ: 'euler' })),
       '负样本：只把积分器改坏，同一处判不通过');
    ok(!restored(B, { scenario: 'custom', integ: 'hermite', years: '7' }),
       '负样本：缺项（连 samples 与初值都没了）判不通过');
  }

  fs.writeFileSync(path.join(__dirname, '_probe_scheme.txt'),
    L.join('\n') + '\n\n[scheme] n=' + n + ' fail=' + fail + '\n', 'utf8');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  L.push('  FAIL  探针自身异常：' + (e && e.stack || e));
  fs.writeFileSync(path.join(__dirname, '_probe_scheme.txt'),
    L.join('\n') + '\n\n[scheme] n=' + n + ' fail=' + (fail + 1) + '\n', 'utf8');
  process.exit(1);
});
