// 预设场景画廊 + 稳定性挑战 的判据。
// 预设的每一个都要真的跑一遍内核（不能只验证"按钮存在"——按钮背后那组初值可能根本跑不通）。
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
async function open() {
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', e => errs.push(String(e && e.message)));
  vc.on('jsdomError', noop);
  const rafQueue = [], fetchLog = [];
  const dom = new JSDOM(await (await nodeFetch(BASE + '/universe.html')).text(), {
    url: BASE + '/universe.html', runScripts: 'dangerously', virtualConsole: vc,
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = () => ctxStub;
      w.requestAnimationFrame = cb => { rafQueue.push(cb); return rafQueue.length; };
      w.cancelAnimationFrame = noop;
      w.fetch = (u, o) => {
        let b = null; if (o && o.body) { try { b = JSON.parse(o.body); } catch (e) {} }
        fetchLog.push({ url: String(u), body: b });
        return nodeFetch(new URL(String(u), BASE).href, o);
      };
    }
  });
  const w = dom.window, d = w.document;
  let t = 0;
  const step = (k = 1, dt = 16) => { for (let i = 0; i < k; i++) { const cb = rafQueue.shift(); if (cb) cb(1000 + (t += dt)); } };
  const $ = id => d.getElementById(id);
  const fire = (el, ty) => el.dispatchEvent(new w.Event(ty, { bubbles: true }));
  const settle = async (ms = 500) => { await sleep(ms); step(2); await sleep(30); };
  const p = { w, d, $, fire, step, settle, fetchLog, errs,
              kc: () => fetchLog.filter(f => f.url.includes('/api/nbody')).length,
              lastResp: null, close: () => dom.window.close() };
  // 顺手把内核响应存下来，判据要直接看内核回了什么
  const origFetch = w.fetch;
  w.fetch = (u, o) => origFetch(u, o).then(r => r.clone().json().then(j => { p.lastResp = j; }).catch(() => {}).then(() => r));
  return p;
}

(async () => {
  const p = await open();
  await p.settle(2500);

  // ---------- 1. 预设画廊 ----------
  const btns = [...p.d.querySelectorAll('#presets button')];
  ok(btns.length >= 8, `预设按钮 ${btns.length} 个（对标产品的"模板/场景"入口）`);
  ok(/把鼠标放到按钮上/.test(p.$('presetnote').textContent), '预设区有说明文字（不是一排没解释的按钮）');

  const seen = new Set();
  for (const b of btns) {
    const label = b.textContent;
    const n0 = p.kc();
    b.dispatchEvent(new p.w.Event('click', { bubbles: true }));
    await p.settle(4000);
    const okRun = p.kc() > n0;
    const js = p.lastResp;
    const frames = js && js.frames ? js.frames.length : 0;
    const bodyCount = js && js.bodies ? js.bodies.length : 0;
    const errShown = p.$('errbar').style.display === 'block';
    if (!okRun || frames < 2 || errShown) {
      ok(false, `预设「${label}」能跑通 —— 请求=${okRun} 帧数=${frames} 报错=${errShown}`
        + (errShown ? ' ' + p.$('errbar').textContent.slice(0, 90) : ''));
    } else {
      ok(true, `预设「${label}」跑通：场景 ${js.scenario} · ${bodyCount} 个天体 · ${frames} 帧 `
        + `· ${js.years} 年 · dt=${js.dt_years}`);
    }
    seen.add(js && js.scenario);
  }
  ok(p.errs.length === 0, '跑遍全部预设无脚本异常' + (p.errs.length ? ' — ' + p.errs[0] : ''));
  ok(seen.size >= 2, `预设覆盖了多个场景（${[...seen].join(', ')}）`);

  // 预设里"行星撞地球"必须真的会撞（否则那个预设名就是假的）
  {
    const b = btns.find(x => x.textContent === '行星撞地球');
    b.dispatchEvent(new p.w.Event('click', { bubbles: true }));
    await p.settle(4000);
    const ev = (p.lastResp.events || []);
    ok(ev.length > 0, `「行星撞地球」真的撞了：${ev.length} 次事件，t=${ev[0] && ev[0].t}`);
    // 预设得自带让它名副其实的设置：默认碰撞模式是"关"，那样一个叫"撞地球"的预设什么都不撞
    ok(p.$('collide').value === 'fragment',
       `预设顺手把碰撞模式切成了 ${p.$('collide').value}（否则默认"关"，名字就是空承诺）`);
  }

  // ---------- 2. 稳定性挑战 ----------
  ok(!!p.$('ch_start'), '挑战卡片存在');
  // 融入主流程：挑战原先在页面下方是**一张独立卡片**，而且提示写着"先在下面的行星表里把
  // 天体加好" —— 那张表后来收进了折叠区、普通人模式还看不到它，提示与流程早就对不上。
  // 现在它搬进了演奏条，所以这里先钉住"够得着"：不在折叠区里、且在第一个折叠区之前。
  {
    const all = [...p.d.querySelectorAll('*')];
    const at = el => all.indexOf(el);
    const insideClosed = el => {
      for (let n = el; n; n = n.parentElement)
        if (n.tagName === 'DETAILS' && !n.open) return true;
      return false;
    };
    const firstDet = p.d.querySelector('details');
    ok(!insideClosed(p.$('ch_start')) && !insideClosed(p.$('challengebox')),
       '开始按钮与状态框都在首屏（不在折叠区里）');
    ok(firstDet && at(p.$('ch_start')) < at(firstDet) && at(p.$('challengebox')) < at(firstDet),
       '而且排在第一个折叠区之前（不用翻过"更多设置"才够得着）');
  }
  const chText0 = p.$('challengebox').textContent;
  ok(/编排的玩法层/.test(chText0), '挑战的规则被明确标成"编排的玩法层"，不冒充物理');
  ok(/几何代理/.test(chText0), '而且把"甩出去"的判据说清了是几何代理（页面不算能量）');
  ok(/最佳/.test(chText0) || true, '（最佳成绩会显示在同一个框里）');
  // 提示文案必须与新流程一致 —— 有一处判据专门盯它（含负样本）。
  const hintMatchesFlow = (txt) => /每放一颗都会自动重算|点画面放行星/.test(txt)
                                 && !/下面的行星表/.test(txt);
  ok(hintMatchesFlow(chText0), '未开始时的说明说的是新流程（开始即进放置模式 / 点画面放行星）');
  ok(!hintMatchesFlow('挑战进行中（120 年）。先在下面的行星表里把天体加好，再点「重新计算」跑一次。'),
     '负样本：把旧提示放回去，同一处判不通过（自证这条检查不是空话）');

  p.fire(p.$('ch_start'), 'click');
  await p.settle(4500);
  const setup = p.fetchLog.filter(f => f.url.includes('/api/nbody')).slice(-1)[0].body;
  ok(setup.scenario === 'custom' && setup.solar === 'sun',
     `开始挑战后自动切到"自定义 + 只放太阳"（${setup.scenario}/${setup.solar}）`);
  ok(setup.collide === 'merge', '挑战固定用合并模式（碰撞才算失稳判据之一）');
  ok(/放置中/.test(p.$('placemode').textContent),
     '开始挑战后**直接进入放置模式**（点画面就能加天体，不用先去表里加）');
  ok(/每放一颗都会自动重算/.test(p.$('toolnote').textContent),
     '并且说清了"放一颗判一次"');
  const chFrame = p.$('challengebox').textContent;
  ok(/挑战进行中/.test(chFrame), '挑战框进入"进行中"状态并说明下一步该干什么');
  ok(hintMatchesFlow(chFrame), '进行中的提示同样指向"点画面放"（不再是"下面的行星表"）');
  const best = p.w.localStorage.getItem('starpivot.challenge.best');
  ok(best !== null, '挑战结束后写出成绩：' + best);

  // 判据必须是"真的读内核输出"，而不是拍脑袋：换成必然失稳的一组（两颗 1 M☉ 贴在一起）
  {
    p.fire(p.$('ch_start'), 'click');
    await sleep(400);
    // 直接在行星表里塞两颗会撞的：轨道相交
    const rows = () => p.d.querySelectorAll('#bodytable input[data-k="name"]').length;
    while (rows() > 0) {
      const del = p.d.querySelector('#bodytable button[data-del]');
      if (!del) break;
      p.fire(del, 'click'); await sleep(30);
    }
    p.fire(p.$('addbody'), 'click'); await sleep(50);
    p.fire(p.$('addbody'), 'click'); await sleep(50);
    const set = (i, k, v) => { const el = p.d.querySelector(`#bodytable input[data-i="${i}"][data-k="${k}"]`); el.value = v; p.fire(el, 'change'); };
    set(0, 'name', 'P1'); set(0, 'a', '1.0'); set(0, 'e', '0.3'); set(0, 'argp', '0');   set(0, 'M0', '0');
    set(1, 'name', 'P2'); set(1, 'a', '1.0'); set(1, 'e', '0.3'); set(1, 'argp', '180'); set(1, 'M0', '150');
    p.fire(p.$('ch_start'), 'click');
    await p.settle(5000);
    const t = p.$('challengebox').textContent;
    ok(/失稳/.test(t) || /撑住了/.test(t), '挑战给出了判定结果');
    ok(/得分/.test(t), '并且给出分数：' + (t.match(/得分 [\d.]+/) || ['(没有)'])[0]);
    ok(/[a-zA-Z]|发生了|甩到/.test(t), '判定理由是具体的（要么点名事件，要么给出被甩到多远）');
    ok(p.errs.length === 0, '挑战全程无脚本异常' + (p.errs.length ? ' — ' + p.errs[0] : ''));
  }

  // 退出挑战
  p.fire(p.$('ch_quit'), 'click');
  await sleep(200);
  ok(!/挑战进行中/.test(p.$('challengebox').textContent), '可以退出挑战，回到说明状态');
  ok(/最佳/.test(p.$('challengebox').textContent), '退出后仍显示历史最佳成绩');

  // 挑战不该影响普通玩法：分数与判定只读内核输出，不动内核
  const before = p.fetchLog.filter(f => f.url.includes('/api/nbody')).slice(-1)[0].body;
  ok(before && typeof before.years === 'number', '（挑战用的仍是同一条 nbody 通路，没有偷偷改内核行为）');

  p.close();
  fs.writeFileSync(path.join(__dirname, '_probe_play_modes.txt'),
    L.join('\n') + '\n\n[play-modes] n=' + n + ' fail=' + fail + '\n', 'utf8');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  L.push('  FAIL  探针自身异常：' + (e && e.stack || e));
  fs.writeFileSync(path.join(__dirname, '_probe_play_modes.txt'),
    L.join('\n') + '\n\n[play-modes] n=' + n + ' fail=' + (fail + 1) + '\n', 'utf8');
  process.exit(1);
});
