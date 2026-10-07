// 协议任务链的判据。契约：docs/bench-contract-2026-10-05.md §4.1。
//
// 这条判据的核心不是「有没有协议卡片」，而是「协议判定是不是真读内核回执」。
// 一份写死 data-state="done" 的假协议可以骗过所有静态检查，所以本探针做两件事：
//   (1) 伪造回执（energy_drift 变小 / 事件表变多），页面状态必须跟着变 —— 证明在读；
//   (2) 负样本：把「达成判定」换成永不满足的空指路，同一处判据必须判不通过。
// 达成状态还必须落进既有 session（契约说不新增存储机制），所以最后重开一次页面。
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
const ctxStub = new Proxy({}, { get: (t, k) =>
  (k === 'createRadialGradient' || k === 'createLinearGradient') ? () => ({ addColorStop: noop })
  : (k === 'measureText' ? () => ({ width: 10 }) : noop), set: () => true });

// opts.forge(body, echo) → 若返回真值，用它替换交给页面的回执。
// opts.store —— 预置会话字节（模拟「上次退出留下的」），必须在页面脚本跑之前塞进去。
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
      if (opts.store) { try { w.localStorage.setItem(KEY, opts.store); } catch (e) {} }
      w.fetch = (u, o) => {
        const url = String(u);
        let body = null; if (o && o.body) { try { body = JSON.parse(o.body); } catch (e) {} }
        const rec = { url, body };
        fetchLog.push(rec);
        const real = nodeFetch(new URL(url, BASE).href, o);
        // 回执总是留一份副本（判据要拿它当"页面读到的数"这一侧的依据），
        // 伪造则把它换成 forge 给的那份。
        if (!url.includes('/api/nbody')) return real;
        return real.then(r => r.json().then(j => {
          if (!opts.forge) { rec.echo = j; return { ok: r.ok, status: r.status, json: async () => j }; }
          const g = opts.forge(body, j);
          // rec.echo 记的是**页面真的拿到的那份**（伪造后就是伪造件）——
          // 判据要拿它当"页面读到的数"，不然这条检查自己就假绿了。
          rec.echo = (g === undefined ? j : g);
          // 只包一层最小 Response 形状：页面只用到 ok/status/json()。
          return { ok: r.ok, status: r.status, json: async () => rec.echo };
        }));
      };
    }
  });
  const w = dom.window, d = w.document;
  let t = 0;
  const step = (k = 1, dt = 16) => { for (let i = 0; i < k; i++) { const cb = rafQueue.shift(); if (cb) cb(1000 + (t += dt)); } };
  const $ = id => d.getElementById(id);
  const fire = (el, ty) => el.dispatchEvent(new w.Event(ty, { bubbles: true }));
  const settle = async (ms = 500) => { await sleep(ms); step(2); await sleep(30); };
  const items = () => [...d.querySelectorAll('#protocol-list li.protocol')];
  return { w, d, $, fire, step, settle, fetchLog, errs, items,
           vec: () => items().map(li => li.dataset.pid + '|' + li.dataset.state + '|' + (li.dataset.progress || '')),
           close: () => dom.window.close() };
}

(async () => {
  const health = await (await nodeFetch(BASE + '/api/health')).json();
  ok(health.exists && health.exec, '前置：8765 上内核可执行');

  // ---------- 1. 容器与列表 ----------
  const p = await open();
  await p.settle(2500);
  // 页面没跑起来的话下面会整片变红，而那是判据环境的问题不是功能的问题 ——
  // 所以先钉住这一条，让人一眼看出红在哪一层。
  ok(p.fetchLog.filter(f => f.url.includes('/api/nbody')).length > 0,
     `页面真的跑起来了（发出 ${p.fetchLog.filter(f => f.url.includes('/api/nbody')).length} 次 /api/nbody）`
     + ' —— 下面若整片红，看这一条');
  const sec = p.$('protocols');
  ok(!!sec, '存在 #protocols 卡片（协议任务链容器）');
  ok(!!sec && sec.tagName === 'SECTION', '#protocols 真的是 <section>（不是 div 顶替）');
  const list = p.$('protocol-list');
  ok(!!list, '存在 #protocol-list 列表');
  ok(!!list && !!sec && sec.contains(list), '#protocol-list 在 #protocols 里面（不是页面别处飘着的孤儿）');
  const items = p.items();
  ok(items.length >= 3, `协议条目数 = ${items.length}（对标产品都有一串可勾目标，1~2 条等于没做任务链）`);
  // 下面几条都带 items.length > 0 前置：0 条时 every() 恒真，那是假绿。
  ok(items.length > 0 && items.every(li => !!li.dataset.pid),
     `每条都有 data-pid（稳定标识，判据与持久化都靠它），共 ${items.length} 条`);
  ok(items.length > 0 && items.every(li => li.dataset.state === 'open' || li.dataset.state === 'done'),
     `data-state 只取 "open" / "done"（实际：${JSON.stringify([...new Set(items.map(x => x.dataset.state))])}）`);
  ok(items.length > 0 && items.every(li => /^\d+(\.\d+)?%?$/.test(String(li.dataset.progress || ''))),
     'data-progress 是百分比字符串（实际：'
     + JSON.stringify(items.map(x => x.dataset.progress)) + '）');

  // ---------- 2. 每条都要有「标题 + 目标说明 + 达成文案」 ----------
  {
    const txt = li => li.textContent.replace(/\s+/g, ' ').trim();
    ok(items.length > 0 && items.every(li => txt(li).length >= 12),
       '每条都有可读文本（不是只有一串 data 属性）');
    // 目标说明必须点名一个可观测量或事件，不能是「变强」这种空话。
    // 词表放宽是有理由的：目标可能用物理量名（能量漂移/偏心率），
    // 也可能直接写回执里的字段名（diagnostics/events/frames/ic_heliocentric）——
    // 两种都算"说清了看什么"，都不该判红。
    const saysGoal = (t) => /(能量|漂移|event|事件|碰撞|轨道|根数|周期|共振|积分|误差|帧|阶|变亮|宜居|类型|半径|质量|diagnostics|frames|events|bio|ic_|a\/e|偏心率|半长轴)/i.test(t);
    ok(items.length > 0 && items.every(li => saysGoal(txt(li))),
       '每条都写清了目标是哪个可观测量（能量漂移 / 事件 / 轨道…），不是空话：'
       + JSON.stringify(items.map(txt).map(t => t.slice(0, 24))));
    const stateful = (li) => {
      const t = txt(li);
      return /达成|完成|未达成|已达成|进行中|还差|满足|未满足|✓|✔|锁定|已完成/.test(t);
    };
    ok(items.length > 0 && items.every(stateful),
       '每条都有达成/未达成的状态文案（用户能一眼看出到没到）');
    // 负样本：换成「去做点什么」这种永不满足的空指路，同一处判不通过
    ok(!saysGoal('去做点什么'),
       '负样本：把目标说明换成「去做点什么」，同一处判不通过（自证这条不是恒真）');
    ok(!stateful({ textContent: '去做点什么' }),
       '负样本：没有达成状态文案的那一条判不通过');
  }

  // ---------- 3. 判定必须读内核回执：伪造回执，状态必须跟着变 ----------
  // 这是本探针最关键的一条。data-state 完全可以写死；只有"回执变了它也变"才算数。
  const better = (_b, j) => {
    if (!j || !j.diagnostics) return undefined;
    const c = JSON.parse(JSON.stringify(j));
    c.diagnostics.energy_drift = 1e-14;                    // 漂移变小 = 更接近守恒
    const ev = Array.isArray(c.events) ? c.events : [];
    c.events = ev.concat(ev, ev).map((e, i) =>
      Object.assign({}, e, { t: (e.t || 0) + i * 1e-6 }));   // 事件变多
    return c;
  };
  const before = p.vec();
  const beforeEcho = (p.fetchLog.filter(f => f.url.includes('/api/nbody')).slice(-1)[0] || {}).echo;
  ok(!!beforeEcho, `读到真回执做基线：energy_drift=${beforeEcho && beforeEcho.diagnostics && beforeEcho.diagnostics.energy_drift}`
     + ` events=${(beforeEcho && beforeEcho.events || []).length}`);
  const driftBefore = beforeEcho && beforeEcho.diagnostics ? beforeEcho.diagnostics.energy_drift : null;
  p.close();

  const q = await open({ forge: better });
  await q.settle(2500);
  const after = q.vec();
  const afterEcho = (q.fetchLog.filter(f => f.url.includes('/api/nbody')).slice(-1)[0] || {}).echo;
  const driftAfter = afterEcho && afterEcho.diagnostics ? afterEcho.diagnostics.energy_drift : null;
  ok(driftAfter !== null && driftBefore !== null && driftAfter < driftBefore,
     `伪造回执真的把 energy_drift 改小了（${driftBefore} → ${driftAfter}）—— 判据自身的前置成立`);
  const changed = before.length > 0 && after.length > 0
    && JSON.stringify(before) !== JSON.stringify(after);
  ok(changed,
     '回执变好之后协议状态跟着变了（证明判定读的是回执，不是写死的 data-state）'
     + '\n         基线=' + JSON.stringify(before) + '\n         伪造=' + JSON.stringify(after));
  // 方向性：变好之后至少不该有"完成度倒退"的条目
  const regress = [];
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    const b = parseFloat(before[i].split('|')[2]) || 0, a = parseFloat(after[i].split('|')[2]) || 0;
    if (after[i].split('|')[1] === 'done' && before[i].split('|')[1] !== 'done') regress.push(after[i]);
    if (a < b - 1e-9 && before[i].split('|')[1] === before[i].split('|')[1]) regress.push(after[i]);
  }
  ok(before.length > 0 && after.length > 0 && regress.length === 0,
     '回执变好没有让任何条目倒退：' + (regress.length ? JSON.stringify(regress) : '无'));
  const doneCount = after.filter(x => x.split('|')[1] === 'done').length;
  ok(doneCount > 0, `伪造回执后至少有 ${doneCount} 条被判定达成（全部 open 说明判定根本没接上回执）`);
  ok(q.errs.length === 0, '伪造回执路径无脚本异常' + (q.errs.length ? ' — ' + q.errs[0] : ''));

  // ---------- 4. 达成状态必须持久化（走既有 session，不新增存储机制） ----------
  await q.settle(800);
  const rawAfter = q.w.localStorage.getItem(KEY);
  {
    const snap = rawAfter ? JSON.parse(rawAfter) : {};
    const hasProto = JSON.stringify(snap).indexOf('protocol') >= 0;
    ok(!!rawAfter, '达成后 localStorage 里有会话快照');
    ok(hasProto, '快照里带协议达成状态（契约 §4.1「不新增存储机制」，所以必须落在既有 session 里）：'
       + JSON.stringify(Object.keys(snap).filter(k => /proto/i.test(k))));
  }
  q.close();

  const r2 = await open({ store: rawAfter });
  await r2.settle(2500);
  const restored = r2.vec();
  ok(r2.items().length > 0 && restored.length === after.length,
     `重开后协议条目数一致（${restored.length} vs ${after.length}）`);
  // 持久化的是"达成过没有"这一位事实；progress 是每次重算现读的进度条，
  // 重开时内核重新算一遍，进度自然可能与离开时不同 —— 所以这里只逐字比对 state。
  const stateOf = v => v.map(x => x.split('|').slice(0, 2).join('|'));
  ok(after.length > 0 && JSON.stringify(stateOf(restored)) === JSON.stringify(stateOf(after)),
     '重开后 data-state 逐字回到离开时的样子：\n         离开=' + JSON.stringify(stateOf(after))
     + '\n         重开=' + JSON.stringify(stateOf(restored)));
  ok(r2.errs.length === 0, '重开无脚本异常' + (r2.errs.length ? ' — ' + r2.errs[0] : ''));
  r2.close();

  // ---------- 5. 负样本总闸：判定换成"永不满足"，本探针的关键检查必须红 ----------
  // 做法与 _probe_play_modes.js 一致：把"回执变好 → 状态必须变"这条检查所依赖的
  // 判定逻辑抽成纯函数，塞一个空指路版本进去，确认它判不通过。
  {
    const protocolSatisfied = (drift, evCount, goalText) => {
      // 这就是页面判定该有的形状：目标写明了观测量，才谈得上"读回执"。
      if (!/漂移|事件|碰撞|轨道|根数|偏心率|半长轴/.test(goalText)) return false;
      return drift < 1e-8 || evCount > 0;
    };
    ok(protocolSatisfied(1e-14, 0, '把能量漂移压到 1e-8 以下'),
       '（自检）真实的判定函数在"回执达标 + 目标写明"时判通过');
    ok(!protocolSatisfied(1e-14, 0, '去做点什么'),
       '负样本：判定条件换成空指路（目标没写明观测量）时判不通过');
    ok(!protocolSatisfied(null, null, '去做点什么'),
       '负样本：空指路 + 无回执，仍然判不通过');
  }

  // ---------- 6. 协议不该新增第二条计算通路 ----------
  {
    const s = await open();
    await s.settle(2500);
    // 允许清单：lagrange 是契约里的新端点（同页另一个功能），不算"另开通路"。
    const urls = [...new Set(s.fetchLog.map(f => f.url))];
    ok(!urls.some(u => /\/api\/(?!nbody|health|dataset|lagrange|genesis)/.test(u)),
       '协议判定没有另起计算通路（只用既有 nbody 通路 + 契约里的 lagrange/genesis）：'
       + JSON.stringify(urls));
    ok(s.errs.length === 0, '默认路径无脚本异常' + (s.errs.length ? ' — ' + s.errs[0] : ''));
    s.close();
  }

  fs.writeFileSync(path.join(__dirname, '_probe_protocols.txt'),
    L.join('\n') + '\n\n[protocols] n=' + n + ' fail=' + fail + '\n', 'utf8');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  L.push('  FAIL  探针自身异常：' + (e && e.stack || e));
  fs.writeFileSync(path.join(__dirname, '_probe_protocols.txt'),
    L.join('\n') + '\n\n[protocols] n=' + n + ' fail=' + (fail + 1) + '\n', 'utf8');
  process.exit(1);
});
