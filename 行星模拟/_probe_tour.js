// 导览 / 积分器选择 / 能量曲线 / CSV 导出 的判据。
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const BASE = 'http://localhost:8765';
const nodeFetch = globalThis.fetch;
let n = 0, fail = 0;
const L = [];
const ok = (c, m) => { n++; L.push((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const STORE_KEY = 'starpivot.universe.session';
const noop = () => {};
const texts = [];
const ctxStub = new Proxy({}, { get: (t, k) =>
  (k === 'createRadialGradient' || k === 'createLinearGradient') ? () => ({ addColorStop: noop })
  : (k === 'measureText' ? () => ({ width: 10 })
     : (k === 'fillText' ? (s) => { texts.push(String(s)); } : noop)), set: () => true });

async function open(hash = '', seed = null) {
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', e => errs.push(String(e && e.message)));
  vc.on('jsdomError', noop);
  const rafQueue = [], fetchLog = [], respLog = [];
  const dom = new JSDOM(await (await nodeFetch(BASE + '/universe.html')).text(), {
    url: BASE + '/universe.html' + hash, runScripts: 'dangerously', virtualConsole: vc,
    beforeParse(w) {
      if (seed) { try { w.localStorage.setItem(STORE_KEY, seed); } catch (e) {} }
      w.HTMLCanvasElement.prototype.getContext = () => ctxStub;
      w.requestAnimationFrame = cb => { rafQueue.push(cb); return rafQueue.length; };
      w.cancelAnimationFrame = noop;
      w.scrollTo = noop;
      w.fetch = (u, o) => {
        let b = null; if (o && o.body) { try { b = JSON.parse(o.body); } catch (e) {} }
        fetchLog.push({ url: String(u), body: b });
        return nodeFetch(new URL(String(u), BASE).href, o).then(r => {
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

(async () => {
  // ---------- 1. 第一次打开自动开导览 ----------
  const p = await open();
  await p.settle(3000);
  ok(p.$('tourcard').style.display === 'block', '第一次打开（无存档）自动进入导览');
  ok(/第 1 \/ \d+ 步/.test(p.$('tourcount').textContent),
     '导览显示步数：' + p.$('tourcount').textContent);
  const total = +(/\/ (\d+)/.exec(p.$('tourcount').textContent) || [])[1];
  ok(total >= 8, `导览共 ${total} 步`);
  ok(/欢迎/.test(p.$('tourcount').textContent), '第 1 步是欢迎页：' + p.$('tourcount').textContent);
  ok(p.w.location.hash === '#step-welcome',
     '地址栏带上这一步的 deep link：' + p.w.location.hash);
  ok(/这一步的链接/.test(p.$('tourdeep').innerHTML), '页面上也把这一步的链接写给用户');
  // 关键：欢迎页**不能**改场景（否则"开机画面"被导览劫持，还会写进存档）
  ok(p.$('scenario').value === 'solar' && !/custom/.test(p.$('scenario').value),
     '欢迎页没有改动场景（仍是默认的' + p.$('scenario').value + '）');
  ok(p.$('tour_next').textContent.indexOf('下一步') >= 0, '按钮提示按"下一步"往下走');

  // 第 2 步才动场景
  p.fire(p.$('tour_next'), 'click'); await p.settle(3000);
  ok(/引力是什么/.test(p.$('tourcount').textContent),
     '第 2 步讲"引力是什么"：' + p.$('tourcount').textContent);
  // 判据看真实证据，不看标签文案：场景确实变 custom，且**真的算出了两颗恒星**
  // （第一版这里写的是 /双星/ 匹配预设说明，但说明正文写的是"两颗等质量恒星"，
  //   没出现"双星"二字 —— 判据不能假设文案。）
  const wg = p.lastPayload() || {};
  ok(p.$('scenario').value === 'custom' && (wg.bodies || []).length === 2
     && (wg.bodies || []).every(b => /^(StarA|StarB)$/.test(b.name)),
     '这一步才把场景换成双星系统（scenario=' + p.$('scenario').value
     + '，天体=' + (wg.bodies || []).map(b => b.name).join('+') + '）');

  // ---------- 2. 继续往下：每一步都会重算 ----------
  const before = p.kc();
  p.fire(p.$('tour_next'), 'click');
  await p.settle(3500);
  ok(p.kc() > before, '点"下一步"真的重算了一次');
  ok(/为什么地球不会掉进太阳/.test(p.$('tourcount').textContent), '进到第 3 步：' + p.$('tourcount').textContent);
  ok(p.w.location.hash === '#step-why-no-fall', 'deep link 跟着更新：' + p.w.location.hash);
  ok(/永远在掉|掉过头/.test(p.$('tourbody').innerHTML), '这一步把"轨道 = 一直掉但掉过头"讲清楚了');

  // ---------- 3. 讲数值方法的那几步必须真的切算法 ----------
  const idx = (kw) => { for (let i = 0; i < total; i++) { };
    return -1; };
  // 手动走到 "漂移" 那一步：连点下一步直到 hash 命中
  let guard = 0;
  while (p.w.location.hash !== '#step-drift' && guard++ < 12) {
    p.fire(p.$('tour_next'), 'click'); await p.settle(2600);
  }
  ok(p.w.location.hash === '#step-drift', '能走到"数值方法为什么会漂"这一步');
  ok(p.$('integ').value === 'euler',
     '这一步真的把算法切成了半隐式欧拉（' + p.$('integ').value + '）—— 不是只换文字');
  p.step(1); await sleep(200); p.step(1);
  const enote = p.$('enote').textContent;
  ok(/往上爬|持续注入/.test(enote), '能量曲线的说明对得上（欧拉 = 能量被持续注入）：' + enote.slice(0, 46));

  // 再走到"高阶 ≠ 长期更好"
  guard = 0;
  while (p.w.location.hash !== '#step-higher-order' && guard++ < 12) {
    p.fire(p.$('tour_next'), 'click'); await p.settle(2600);
  }
  ok(p.$('integ').value === 'hermite', '那一步切到 Hermite4（' + p.$('integ').value + '）');
  ok(/单步精度和长期稳定性是两件事/.test(p.$('tourbody').innerHTML),
     '并且明确讲了"单步精度 ≠ 长期更好"（这正是判据测出来的结论）');

  // ---------- 4. 能量曲线画布真的画了 ----------
  p.texts.length = 0; p.step(1); await sleep(60);
  ok(p.texts.some(t => /^1e-?\d+$/.test(t)), '能量曲线画了纵轴量级刻度：'
     + p.texts.filter(t => /^1e-?\d+$/.test(t)).slice(0, 4).join(' '));
  ok(p.texts.some(t => /^\|E/.test(t)), '纵轴标签写的是 |E−E₀|/|E₀|');
  ok(p.texts.some(t => /^当前 t =/.test(t)), '曲线上有"当前时刻"的游标');

  // ---------- 5. 跳过 / 关闭 ----------
  p.fire(p.$('tour_skip'), 'click'); await sleep(150);
  ok(p.$('tourcard').style.display === 'none', '「跳过 · 自由探索」能退出导览');
  p.fire(p.$('tourstart'), 'click'); await p.settle(2600);
  ok(p.$('tourcard').style.display === 'block' && /第 1 \/ /.test(p.$('tourcount').textContent),
     '「▶ 开始导览」能从头重看');

  // ---------- 6. 下拉直接换算法 ----------
  const n0 = p.kc();
  p.$('integ').value = 'leapfrog'; p.fire(p.$('integ'), 'change');
  await p.settle(2600);
  ok(p.kc() > n0, '换算法会自动重算');
  ok(p.lastPayload().integrator === 'leapfrog', 'payload 里带上 integrator');
  ok(/最稳/.test(p.$('integplain').textContent), '下拉旁边给了一句人话解释：'
     + p.$('integplain').textContent);
  const r = p.lastResp();
  ok(Array.isArray(r.energy_series) && r.energy_series.length === r.frames.length,
     `内核回了逐帧能量序列（${r.energy_series.length} 个）`);
  ok(r.integrator_key === 'leapfrog' && /symplectic/.test(r.integrator), '回显算法名与性质');

  // ---------- 7. CSV 导出 ----------
  p.fire(p.$('exportcsv'), 'click'); await sleep(250);
  ok(/CSV/.test(p.$('toolnote').textContent), 'CSV 按钮有明确反馈：'
     + p.$('toolnote').textContent.slice(0, 60));

  // ---------- 8. 存档后不再自动弹导览 ----------
  await sleep(700);
  const raw = p.w.localStorage.getItem(STORE_KEY);
  ok(raw !== null, '会话已保存');
  p.close();
  const q = await open('', raw);
  await q.settle(3000);
  ok(q.$('tourcard').style.display !== 'block', '第二次打开不再自动弹导览（不打扰）');
  ok(q.$('integ').value === 'leapfrog', '算法选择跟着会话恢复');
  q.close();

  // ---------- 9. deep link 直接落到那一步 ----------
  const s = await open('#step-collide');
  await s.settle(4000);
  ok(/撞上会发生什么/.test(s.$('tourcount').textContent),   // 标题在 stepcount 里，不在正文里
     '直接打开 #step-collide 会落到那一步：' + s.$('tourcount').textContent);
  ok(s.$('collide').value === 'fragment',
     '那一步把场景也带上了（碰撞模式 = ' + s.$('collide').value + '）');
  const cr = s.lastResp();
  ok((cr.events || []).length > 0, `并且真的撞了（${(cr.events || []).length} 次事件）`);
  s.close();

  // ---------- 9b. 导览必须告诉用户"还有个挑战"（融入主流程的一部分）----------
  // 原文 12 步里一次都没提挑战 —— 跟着导览走完的人根本不知道有这回事，
  // 而它是这个页面上唯一的"玩法"（其余都是看现象）。
  {
    const t = await open('#step-challenge');
    await t.settle(4000);
    ok(/挑战/.test(t.$('tourcount').textContent),
       '导览里有"稳定性挑战"这一步：' + t.$('tourcount').textContent);
    // 指路必须指到真东西：正文里点名的那两个按钮要在页面上真的存在。
    const body = t.$('tourbody').textContent;
    const pointsAtReal = (txt, doc) => /稳定性挑战/.test(txt) && /开始挑战/.test(txt)
      && !!doc.getElementById('ch_start') && doc.getElementById('ch_start').textContent.includes('开始挑战');
    ok(pointsAtReal(body, t.d),
       '而且这一步点名的按钮是真的（页面上有「开始挑战」）');
    ok(!pointsAtReal('自己去看下面那张表吧。', t.d),
       '负样本：换成一句空指路，同一处判不通过（自证这条检查不是空话）');
    t.close();
  }

  // ---------- 10. 新预设能跑通 ----------
  const z = await open();
  await z.settle(3000);
  const labels = [...z.d.querySelectorAll('#presets button')].map(b => b.textContent);
  ok(labels.includes('地月系统') && labels.includes('轨道共振 1:2:4'),
     '新预设已加入：' + labels.join(' / '));
  const btn = (kw) => [...z.d.querySelectorAll('#presets button')].find(b => b.textContent.includes(kw));
  for (const [kw, check] of [
    ['地月系统', (js) => {
        // 月球周期应当是 27.3 天 = 0.0748 年：看它的半径在一年里振荡多少次太麻烦，
        // 直接查距离范围是否落在 a(1±e) = [0.00243, 0.00271] AU
        const mi = js.bodies.findIndex(b => b.id === 'Moon');
        const ri = js.bodies.findIndex(b => b.id === 'Earth');
        const ds = js.frames.map(f => Math.hypot(
          f.p[mi][0] - f.p[ri][0], f.p[mi][1] - f.p[ri][1], f.p[mi][2] - f.p[ri][2]));
        const lo = Math.min(...ds), hi = Math.max(...ds);
        return { okv: lo > 0.0024 && hi < 0.00275, msg: `月球到地球 ${lo.toFixed(5)}~${hi.toFixed(5)} AU` };
      }],
    ['轨道共振', (js) => {
        // 三颗行星的周期比应当是 1:2:4 → 看同一时间里各自绕了几圈
        const ids = ['P1','P2','P3'];
        const counts = ids.map(id => {
          const i = js.bodies.findIndex(b => b.id === id);
          let c = 0;
          for (let f = 1; f < js.frames.length; f++) {
            const a = js.frames[f-1].p[i], b = js.frames[f].p[i];
            const th0 = Math.atan2(a[1], a[0]), th1 = Math.atan2(b[1], b[0]);
            let d = th1 - th0; if (d < -Math.PI) d += 2*Math.PI; if (d > Math.PI) d -= 2*Math.PI;
            c += d;
          }
          return c / (2*Math.PI);
        });
        // P1 的 a 最小 ⇒ 跑得最快 ⇒ 圈数最多。所以比是 counts[0]/counts[1]，别搞反。
        const ratio = counts[1] > 0 ? counts[0] / counts[1] : 0;
        const ratio2 = counts[2] > 0 ? counts[0] / counts[2] : 0;
        return { okv: Math.abs(ratio - 2) < 0.06 && Math.abs(ratio2 - 4) < 0.12,
                 msg: `圈数 ${counts.map(c=>c.toFixed(2)).join(' : ')} ⇒ 比值 ${ratio.toFixed(2)} : 1 : `
                      + (counts[2] > 0 ? (counts[1]/counts[2]).toFixed(2) : '?') + '（应为 2 : 1 : 0.5）' };
      }]
  ]) {
    btn(kw).dispatchEvent(new z.w.Event('click', { bubbles: true }));
    await z.settle(4500);
    const js = z.lastResp();
    const res = check(js);
    ok(res.okv, `预设「${kw}」跑出来的东西是对的：${res.msg}`);
  }
  ok(z.errs.length === 0, '全程无脚本异常' + (z.errs.length ? ' — ' + z.errs[0] : ''));
  z.close();

  fs.writeFileSync(path.join(__dirname, '_probe_tour.txt'),
    L.join('\n') + '\n\n[tour] n=' + n + ' fail=' + fail + '\n', 'utf8');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  L.push('  FAIL  探针自身异常：' + (e && e.stack || e));
  fs.writeFileSync(path.join(__dirname, '_probe_tour.txt'),
    L.join('\n') + '\n\n[tour] n=' + n + ' fail=' + (fail + 1) + '\n', 'utf8');
  process.exit(1);
});
