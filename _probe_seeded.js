// 随机宇宙种子的判据。契约：docs/bench-contract-2026-10-05.md §3 / §4.6。
//
// 关键性质是"同 seed 逐位复现"—— 这不是"差不多"，是逐字相同。
// 所以判据里绝不用 Math.random 造随机源：种子是写死的 fixture 字符串，
// 随机性必须来自内核自己的哈希与采样。
//
// 第二条红线：genesis 拿回的 bodies 必须塞进**现有**的 /api/nbody payload，
// 不许另起一条计算通路。判据 hook fetch，断言"genesis 之后紧跟着一次 nbody，
// 且 bodies 与 genesis 回执逐字相同"。
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
// 写死的种子 fixture：判据要能复现，就不能用随机源
const SEED = '2026-10-05';
const SEED2 = 'starpivot-anchor-seed';

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
      w.fetch = (u, o) => {
        const url = String(u);
        let body = null; if (o && o.body) { try { body = JSON.parse(o.body); } catch (e) {} }
        const rec = { url, body };
        fetchLog.push(rec);
        const run = nodeFetch(new URL(url, BASE).href, o);
        if (!url.includes('/api/genesis')) return run;
        // 必须回 Promise：页面用的是 fetchT，里面有 .finally()。
        // 直接返回普通对象会让 fetchT 抛 "run is not a function" —— 那是判据自己造的错。
        return run.then(r => r.json().then(j => {
          rec.echo = j;
          return { ok: r.ok, status: r.status, json: async () => j };
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
  return { w, d, $, fire, step, settle, fetchLog, errs,
           gen: () => fetchLog.filter(f => f.url.includes('/api/genesis')),
           nb: () => fetchLog.filter(f => f.url.includes('/api/nbody')),
           close: () => dom.window.close() };
}

async function generate(p, seed) {
  const inp = p.$('seedin');
  if (!inp) return null;
  inp.value = seed;
  p.fire(inp, 'input'); p.fire(inp, 'change');
  const k0 = p.gen().length, n0 = p.nb().length;
  if (p.$('seedgo')) p.fire(p.$('seedgo'), 'click');
  await p.settle(4000);
  return { genNew: p.gen().slice(k0), nbNew: p.nb().slice(n0) };
}

(async () => {
  const health = await (await nodeFetch(BASE + '/api/health')).json();
  ok(health.exists && health.exec, '前置：8765 上内核可执行');

  // ---------- 0. 内核侧：/api/genesis 得先存在 ----------
  {
    const r = await nodeFetch(BASE + '/api/genesis', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seed: SEED, bodies: 6 }) });
    const j = await r.json().catch(() => null);
    ok(r.ok && j && j.status === 'ok',
       `POST /api/genesis 可用（HTTP ${r.status}，回 ${JSON.stringify(j).slice(0, 90)}）`);
  }

  // ---------- 1. 控件 ----------
  const p = await open();
  await p.settle(2500);
  // 页面没跑起来的话下面会整片变红，而那是判据环境的问题不是功能的问题 ——
  // 所以先钉住这一条，让人一眼看出红在哪一层。
  ok(p.nb().length > 0, `页面真的跑起来了（发出 ${p.nb().length} 次 /api/nbody）—— 下面若整片红，看这一条`);
  const inp = p.$('seedin');
  ok(!!inp, '存在 #seedin（种子输入框）');
  ok(!!inp && inp.tagName === 'INPUT', '#seedin 真的是 <input>');
  ok(!!p.$('seedgo'), '存在 #seedgo（生成按钮）');
  ok(!!p.$('seedgo') && p.$('seedgo').tagName === 'BUTTON', '#seedgo 真的是 <button>');

  // ---------- 2. 点了之后发 /api/genesis，body 里带 seed ----------
  const r1 = await generate(p, SEED);
  ok(!!r1, `填了种子「${SEED}」并点了生成`);
  ok(r1 && r1.genNew.length > 0, `真的发了 /api/genesis（${r1 ? r1.genNew.length : 0} 次）`);
  {
    const g = r1 && r1.genNew[0];
    ok(g && g.body && g.body.seed === SEED,
       `body 里 seed 逐字是输入框的值：${JSON.stringify(g && g.body && g.body.seed)}`);
    const e = g && g.echo;
    ok(!!e && e.status === 'ok', `拿到回执：status=${e && e.status} bodies=${(e && e.bodies || []).length}`);
    ok(!!e && Array.isArray(e.bodies) && e.bodies.length > 0,
       `回执里有 bodies（${(e && e.bodies || []).length} 个）—— 页面没有可生成的素材就等于没做`);
    ok(!!e && typeof e.seed_hash === 'string',
       `回执给出 seed_hash（${e && e.seed_hash}）—— 内核自己哈希，页面不生成`);
  }

  // ---------- 3. bodies 必须塞进现有 nbody payload（不另起通路） ----------
  {
    const g = (r1 && r1.genNew[0]) || p.gen()[0];
    const echo = g && g.echo;
    ok(!!echo && !!echo.status,
       `拿到 /api/genesis 的回执（status=${echo && echo.status}）`);
    const genBodies = (echo && Array.isArray(echo.bodies)) ? echo.bodies : [];
    const nbNew = (r1 && r1.nbNew) || [];
    ok(nbNew.length > 0,
       `genesis 之后紧跟着发了一次 /api/nbody（新增 ${nbNew.length} 次）`);
    const nb = nbNew[nbNew.length - 1];
    ok(!!nb && Array.isArray(nb.body.bodies) && nb.body.bodies.length > 0,
       '那次 nbody 的 payload 里带着 bodies：'
       + JSON.stringify(nb && nb.body && nb.body.bodies && nb.body.bodies.slice(0, 1)));
    // "逐字相同"要**按字段映射逐值比**，不能对整个对象 JSON.stringify 判等：
    // genesis 回执用内核命名（a_au / mass_msun / inc_deg…），页面搬进 customBodies
    // 后由 payloadBody 转成 nbody 载荷格式（a / mass / inc…），字段名链路上必然被
    // 改名、对象不可能字节相等。真正要守的是契约 4.6 的意图 —— 页面没自己算物理：
    // 质量/半长轴/半径等值必须与内核回执 1:1 相等，天体名也不能被改。
    const FIELD_MAP = { name: 'name', a_au: 'a', e: 'e', inc_deg: 'inc',
                        raan_deg: 'raan', argp_deg: 'argp', M0_deg: 'M0',
                        mass_msun: 'mass', radius_km: 'radius_km', type: 'type' };
    const sameAll = genBodies.length > 0 && !!nb && Array.isArray(nb.body.bodies)
      && nb.body.bodies.length === genBodies.length
      && genBodies.every((g, i) => Object.keys(FIELD_MAP).every(k => {
          const nv = nb.body.bodies[i][FIELD_MAP[k]];
          const gv = g[k];
          return typeof gv === 'number' ? nv === gv : String(nv) === String(gv);
        }));
    ok(sameAll, 'bodies 逐值对应内核回执（页面没改名/换单位/自算半径）：'
       + JSON.stringify(genBodies.map((g, i) => nb && nb.body.bodies[i]
           && [nb.body.bodies[i].name, nb.body.bodies[i].mass, g.mass_msun,
               nb.body.bodies[i].radius_km, g.radius_km])));
    // 允许清单：新内核端点（lagrange/genesis）本身是契约要求的，不算"另开通路"；
    // 真正要禁的是**为种子新造**的计算通路。
    const urls = [...new Set(p.fetchLog.map(f => f.url))];
    ok(!urls.some(u => /\/api\/(?!nbody|health|dataset|genesis|lagrange)/.test(u)),
       '没有为种子另开一条计算通路（只用既有 nbody 通路 + 契约里的 genesis/lagrange）：'
       + JSON.stringify(urls));
  }

  // ---------- 4. 生成物物理合法（e<1、质量正、半长轴正、Hill 不打架） ----------
  {
    const g = p.gen()[0];
    const bs = (g && g.echo && Array.isArray(g.echo.bodies)) ? g.echo.bodies : [];
    ok(bs.length > 0, `取到生成物作为物理合法性检查的输入（${bs.length} 个）`);
    ok(bs.length > 0 && bs.every(b => typeof b.e === 'number' && b.e >= 0 && b.e < 1),
       '每颗偏心率都在 [0,1) —— e ≥ 1 是双曲线，页面不能给出这种初值：'
       + JSON.stringify(bs.map(b => b && b.e)));
    ok(bs.length > 0 && bs.every(b => typeof b.a_au === 'number' && b.a_au > 0),
       '每颗半长轴为正：' + JSON.stringify(bs.map(b => b && b.a_au)));
    ok(bs.length > 0 && bs.every(b => typeof b.mass_msun === 'number' && b.mass_msun > 0),
       '每颗质量取自内核类型表（为正，页面不自造质量）：'
       + JSON.stringify(bs.map(b => b && [b.type, b.mass_msun])));
    ok(bs.length > 0 && bs.every(b => typeof b.radius_km === 'number' && b.radius_km > 0),
       '每颗带内核算的半径：' + JSON.stringify(bs.map(b => b && b.radius_km)));
    const st = g && g.echo && g.echo.stability;
    ok(!!st && typeof st.min_sep_ratio === 'number' && st.min_sep_ratio > 0,
       `回执给出稳定性检查 min_sep_ratio=${st && st.min_sep_ratio}`);
    // 契约里的稳定判据是 min_margin（实际间距比 / Gladman 临界值）> 1 —— 这比
    // "有个 mutual_hill_ok 布尔"更强：内核给的是数值余量，不只是是/否。字段名以
    // 契约 bench-contract-2026-10-05.md 与内核实测输出为准：min_sep_ratio /
    // min_margin / criterion / note（早期草稿里的 min_pair_sep_au / mutual_hill_ok
    // / notes 并不存在于真实回执）。
    ok(!!st && st.criterion === 'gladman' && typeof st.min_margin === 'number'
       && st.min_margin > 1,
       '内核按 Gladman 判据说相互 Hill 半径不打架（criterion=' + (st && st.criterion)
       + ', min_margin=' + (st && st.min_margin) + ' > 1）');
    const note = String((st && st.note) || '');
    ok(!!note && /Gladman/.test(note),
       'stability.note 说清 min_margin 的含义：' + JSON.stringify(note.slice(0, 50)));
  }

  // ---------- 5. 页面标明"今天的种子"由内核按日期生成 ----------
  {
    // 取证范围必须是 #seedin 所在的那块；退到整页 body 会让"内核"两个字
    // 从页脚说明里凑出来，这条就成了恒真。
    // 取证范围取 #seedin 所在的 section：契约 §4.6 要求的那句说明写在
    // 结果区（#seednote）里，只看 label 所在的窄 div 永远看不到。
    const scope = p.$('seedin')
      ? (p.$('seedin').closest('section') || p.$('seedin').closest('div, .card, details')
         || p.$('seedin').parentElement) : null;
    const t = scope ? (scope.textContent || '').replace(/\s+/g, ' ') : '';
    ok(!!scope, '种子控件有自己的容器（文案判据有明确取证范围）');
    ok(t.length > 0 && /种子/.test(t), '种子控件附近说明了它是种子：' + JSON.stringify(t.slice(0, 80)));
    ok(t.length > 0 && /内核/.test(t), '并且说清随机性来自内核（页面不自己算）：' + JSON.stringify(t.slice(0, 80)));
    // 负样本：一句"随机生成一颗宇宙"通不过
    const saysSource = (s) => /种子/.test(s) && /内核/.test(s);
    ok(!saysSource('随机生成一颗宇宙。'),
       '负样本：把说明换成"随机生成一颗宇宙"，同一处判不通过（自证不是恒真）');
  }
  p.close();

  // ---------- 6. 同 seed 逐位复现 / 异 seed 不同（内核侧，直连） ----------
  {
    // 端点还不存在时网关回的是 HTML 404 页，.json() 会抛 —— 收成 {status:'(非 JSON)'}，
    // 让这一节判红而不是让整个探针崩掉（崩掉就看不出"哪一条红"）。
    const call = (seed) => nodeFetch(BASE + '/api/genesis', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seed, bodies: 6 }) })
      .then(r => r.json().catch(() => ({ status: '(非 JSON 响应，可能是 404 HTML 页)' })))
      .catch(e => ({ status: '(请求失败: ' + e.message + ')' }));
    const a1 = await call(SEED), a2 = await call(SEED), b1 = await call(SEED2);
    ok(a1.status === 'ok' && a2.status === 'ok', `两次调用都成功：${a1.status} / ${a2.status}`);
    ok(!!a1.bodies && !!a2.bodies, `两次都拿到 bodies（${(a1.bodies || []).length} / ${(a2.bodies || []).length}）`);
    ok(a1.bodies && a2.bodies && JSON.stringify(a1.bodies) === JSON.stringify(a2.bodies),
       `同一 seed 连续两次得到**逐字相同**的 bodies（各 ${(a1.bodies || []).length} 个）`);
    ok(!!a1.seed_hash && !!a2.seed_hash
       && JSON.stringify(a1.seed_hash) === JSON.stringify(a2.seed_hash),
       `seed_hash 也逐字相同（${a1.seed_hash}）`);
    ok(b1.status === 'ok' && JSON.stringify(b1.bodies) !== JSON.stringify(a1.bodies),
       '不同 seed 得到不同的 bodies（不是拿一个固定样本糊弄）');
    // 负样本：把 bodies 换成"同一个样本"之后，复现检查就失去意义 —— 明确写出这条依赖
    ok(!!a1.bodies && !!b1.bodies && JSON.stringify(a1.bodies) !== JSON.stringify(b1.bodies),
       '（自证）复现性不是"所有 seed 都一样"这种平凡成立');
  }

  // ---------- 7. 页面里连点两次同 seed，也必须复现 ----------
  {
    const q = await open();
    await q.settle(2500);
    const x1 = await generate(q, SEED);
    const x2 = await generate(q, SEED);
    const b1 = (x1 && x1.genNew[0] && x1.genNew[0].echo && x1.genNew[0].echo.bodies) || null;
    const b2 = (x2 && x2.genNew[0] && x2.genNew[0].echo && x2.genNew[0].echo.bodies) || null;
    ok(!!b1 && !!b2, '页面里用同一个 seed 生成了两次');
    ok(!!b1 && !!b2 && JSON.stringify(b1) === JSON.stringify(b2),
       '页面上同 seed 连点两次，拿到逐字相同的 bodies');
    ok(q.errs.length === 0, '种子路径无脚本异常' + (q.errs.length ? ' — ' + q.errs[0] : ''));
    q.close();
  }

  fs.writeFileSync(path.join(__dirname, '_probe_seeded.txt'),
    L.join('\n') + '\n\n[seeded] n=' + n + ' fail=' + fail + '\n', 'utf8');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  L.push('  FAIL  探针自身异常：' + (e && e.stack || e));
  fs.writeFileSync(path.join(__dirname, '_probe_seeded.txt'),
    L.join('\n') + '\n\n[seeded] n=' + n + ' fail=' + (fail + 1) + '\n', 'utf8');
  process.exit(1);
});
