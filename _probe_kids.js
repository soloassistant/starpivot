// 小朋友页的页面级判据（E 层）：真加载它、真点它的按钮、看它教的那件事成不成立。
//
// `_check_kids.js` 只保证"正文里没有术语" —— 那是**必要条件，不是充分条件**。
// 一页干净得像白纸的页面同样能过。这一层验的是**它到底能不能教会人**：
//   1. 真加载、脚本不报错；
//   2. 页面上那个"转一圈要多久"必须是**内核回显的那个数**（拿同一份输入独立问一次，比对上）；
//   3. 改旋钮之后，"你自己发现"那段必须出现，并且把两次结果并排摆出来；
//   4. 而且它摆出来的方向必须是**对的**：越远越慢（远 4 倍 → 一圈明显更长）。
//      这一条是整页要教的那件事本身；它错了，前面再干净也没用。
//   5. 玩法 A（猜一猜）：改远近之后**先不给答案**，先问；猜完才揭晓；
//      对错只由内核给的**两个周期值**相除得到 —— 判据自己算一遍那个倍数与档位去比页面上那句话。
//   6. 玩法 B（撞一下）：撞没撞、哪一年撞、撞前撞后多重，全部必须来自内核回执；
//      半径放大 450 倍必须被披露；这一页不许出现 fragment。
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const BASE = process.env.STARPIVOT_BASE || 'http://127.0.0.1:8765';
const nodeFetch = globalThis.fetch;
const LOG = [];
let n = 0, fail = 0;
const ok = (c, m) => { n++; LOG.push((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

process.on('exit', () => {
  fs.writeFileSync(path.join(__dirname, '_probe_kids.txt'), LOG.join('\n') + '\n', 'utf8');
});

// 页面用同一份输入问内核；判据独立问一次，两边必须是同一个数。
const payloadFor = (a, e) => ({
  scenario: 'custom', solar: 'none', primary: 'Sun', years: 12, samples: 720,
  bodies: [
    { name: 'Sun', a: 1, e: 0, inc: 0, raan: 0, argp: 0, M0: 0, mass: 1.0 },
    { name: 'Planet', a: a, e: e, inc: 0, raan: 0, argp: 0, M0: 0, mass: 3e-6 }
  ]
});
const askKernel = async (a, e) => {
  const r = await nodeFetch(BASE + '/api/nbody', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payloadFor(a, e))
  });
  return (await r.json()).sampling.min_period_years;
};

// 玩法 A 的分档口径：判据独立算一遍，拿去和页面上那句话比。
const NEAR_MAX = 1.5, DOUBLE_MAX = 2.4;
const GLABEL = { near: '和刚才差不多', double: '长一倍左右', much: '长得多（两倍以上）' };
const bucketOf = (r) => (r < NEAR_MAX ? 'near' : (r < DOUBLE_MAX ? 'double' : 'much'));
const fmtRatio = (r) => (r >= 10 ? r.toFixed(0) : r.toFixed(1));

// 玩法 B：实测过会撞上的那一组（与页面同一条配方）。判据独立问一次，比对年份与"一样重"。
const COL_BODIES = [
  { name: 'A', a: 1.0, e: 0.2, inc: 0, raan: 0, argp: 0,   M0: 0,   mass: 3e-6, radius_km: 6371 },
  { name: 'B', a: 1.0, e: 0.2, inc: 0, raan: 0, argp: 180, M0: 135, mass: 3e-6, radius_km: 6371 }
];
const colPayload = (collide) => ({
  scenario: 'custom', solar: 'sun', years: 3, samples: 2000,
  collide: collide, radius_scale: 450, bodies: COL_BODIES
});
const askCollide = async (collide) => {
  const r = await nodeFetch(BASE + '/api/nbody', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(colPayload(collide))
  });
  return await r.json();
};
const fmtNum = (x) => (+x.toFixed(2)).toString();

function fakeCtx() {
  const grad = { addColorStop: () => {} };
  return new Proxy({}, {
    get: (t, k) => {
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => grad;
      if (k === 'measureText') return () => ({ width: 10 });
      return () => {};
    },
    set: () => true
  });
}

async function openKids() {
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', e => errs.push(String((e && e.message) || e)));
  const html = await (await nodeFetch(BASE + '/kids')).text();
  // 记下页面自己发的每一条请求：玩法 A 要证明"没猜之前不去问内核"，
  // 玩法 B 要证明"下发的正是那条实测配方"。
  const fetchLog = [];
  const dom = new JSDOM(html, {
    url: BASE + '/kids', runScripts: 'dangerously', virtualConsole: vc,
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
      w.fetch = (u, o) => {
        let b = null; if (o && o.body) { try { b = JSON.parse(o.body); } catch (e) {} }
        fetchLog.push({ url: String(u), body: b });
        return nodeFetch(new URL(String(u), BASE).href, o);
      };
    }
  });
  await sleep(2200);
  return { dom, errs, doc: dom.window.document, fetchLog };
}

const nbodyCalls = (log) => log.filter(f => f.url.includes('/api/nbody')).length;

(async () => {
  console.log('=== 小朋友页（E 层）===');

  const { dom, errs, doc, fetchLog } = await openKids();
  ok(errs.length === 0, '页面加载无脚本异常' + (errs.length ? ' — ' + errs[0].slice(0, 120) : ''));

  // ---- 1. "转一圈要多久"必须是内核回显的那个数 ----
  const shown = (doc.getElementById('period').textContent || '').trim();
  ok(/^[\d.]+$/.test(shown), '页面上显示的是个数，而不是"—"或"…"', '实际显示：' + shown);
  const truth = await askKernel(2, 0);   // 页面初始就是 2 步、正圆
  ok(Math.abs(parseFloat(shown) - truth) < 0.01,
     '这个数与内核回显的 ' + truth.toFixed(4) + ' 对得上（页面没自己算）',
     '页面显示 ' + shown + '，内核说 ' + truth.toFixed(4));
  ok(/年/.test(doc.getElementById('unit').textContent || ''),
     '单位写的是"年"（孩子熟悉的说法）');

  // ---- 2. 试第一次时：不急着下结论，也不该被问"猜一猜" ----
  ok(doc.getElementById('found').style.display === 'none',
     '只放了一颗时"你自己发现"那段还不出现（先让孩子动手）');
  ok(doc.getElementById('guess').style.display === 'none',
     '第一次进来不该被问"猜一猜"（先让孩子动手放一颗，保留原来的顺序）');

  // ---- 3. 改远近：先不准给答案，先问 ----
  const d = doc.getElementById('dist');
  const kc0 = nbodyCalls(fetchLog);
  d.value = '4';
  d.dispatchEvent(new dom.window.Event('input'));
  await sleep(1200);
  const kc1 = nbodyCalls(fetchLog);
  ok(doc.getElementById('guess').style.display !== 'none',
     '改了远近之后先出现"你猜：它转一圈要多久？"（先猜再揭晓）');
  const midShown = (doc.getElementById('period').textContent || '').trim();
  ok(!/^[\d.]+$/.test(midShown), '还没揭晓 —— 页面上不是数字，而是一个问号',
     '实际显示：' + midShown);
  ok(kc1 === kc0, '还没猜之前页面**不去问内核**（不是先算好再假装让你猜）：'
     + kc0 + ' → ' + kc1 + ' 次请求');

  // ---- 4. 猜一下（这一次猜对）：揭晓的数字必须是内核那个数 ----
  doc.getElementById('g_much').dispatchEvent(new dom.window.Event('click'));
  await sleep(2200);

  const found = doc.getElementById('found');
  const ftxt = found.textContent || '';
  ok(found.style.display !== 'none', '点了猜测按钮之后，"你自己发现"那段出现了');
  ok(/2 步远/.test(ftxt) && /4 步远/.test(ftxt), '并且把两次的结果并排摆出来了', '实际：' + ftxt.slice(0, 120));

  // ---- 5. 它教的那件事，方向必须是对的 ----
  const p2 = await askKernel(2, 0), p4 = await askKernel(4, 0);
  ok(p4 > p2 * 1.5, '越远越慢：4 步远的一圈（' + p4.toFixed(2) + ' 年）明显长于 2 步远（'
     + p2.toFixed(2) + ' 年）—— 这一页要教的就是这件事');
  const shownAfter = parseFloat(doc.getElementById('period').textContent);
  ok(Math.abs(shownAfter - p4) < 0.01, '改完之后页面显示的也跟着换成新值了（' + p4.toFixed(4) + '）',
     '页面显示 ' + shownAfter);

  // ---- 6. 玩法 A：猜中 / 猜错的判定，必须与内核两个周期之比一致 ----
  const vtxt = doc.getElementById('verdict').textContent || '';
  const ratio4 = p4 / p2;
  const act4 = bucketOf(ratio4);
  ok(act4 === 'much', '（判据自检：2 步 → 4 步，内核两个周期之比 ' + ratio4.toFixed(2) + ' 落在"长得多"档）');
  ok(/你猜对了/.test(vtxt) && vtxt.indexOf(GLABEL[act4]) >= 0,
     '玩法 A：猜中时如实说"你猜对了"，且判定的档位与内核两个周期之比一致（' + GLABEL[act4] + '）',
     '实际：' + vtxt.slice(0, 140));
  ok(vtxt.indexOf(fmtRatio(ratio4) + ' 倍') >= 0,
     '玩法 A：揭晓的倍数就是内核两个周期之比（' + fmtRatio(ratio4) + ' 倍）',
     '实际：' + vtxt.slice(0, 140));

  // ---- 7. 给好奇的人：等价命令要填出来 ----
  const cli = doc.getElementById('cli').textContent || '';
  ok(/starpivot nbody/.test(cli) && /Planet,4/.test(cli),
     '折叠区里给出了与这次实验等价的命令（大人可以照着复现）', '实际：' + cli.slice(0, 80));

  // ---- 8. 玩法 A：猜错也要好好说，不许假装对 ----
  d.value = '3';
  d.dispatchEvent(new dom.window.Event('input'));
  await sleep(400);
  ok(doc.getElementById('guess').style.display !== 'none',
     '再改一次远近，又先问一次（不是只问第一次）');
  doc.getElementById('g_much').dispatchEvent(new dom.window.Event('click'));   // 故意猜错
  await sleep(2200);
  const p3 = await askKernel(3, 0);
  const ratio3 = p3 / p4;                       // 上一次揭晓的是 4 步那一回
  const act3 = bucketOf(ratio3);
  const vtxt2 = doc.getElementById('verdict').textContent || '';
  ok(/没猜中/.test(vtxt2) && !/猜对了/.test(vtxt2),
     '玩法 A：猜错时如实说"没猜中"，不假装对', '实际：' + vtxt2.slice(0, 140));
  ok(vtxt2.indexOf(GLABEL[act3]) >= 0,
     '玩法 A：猜错时给出的"其实是…"同样由内核两个周期之比定（' + GLABEL[act3]
     + '，比值 ' + ratio3.toFixed(2) + '）', '实际：' + vtxt2.slice(0, 160));

  // ---- 9. 玩法 B：撞一下。数字全部来自回执 ----
  const mergeTruth = await askCollide('merge');
  const ev = (mergeTruth.events || [])[0] || {};
  doc.getElementById('dobump').dispatchEvent(new dom.window.Event('click'));
  await sleep(3200);
  const stxt = doc.getElementById('colstory').textContent || '';
  ok(/撞上/.test(stxt) && stxt.indexOf(fmtNum(ev.t)) >= 0,
     '玩法 B：撞上时说的年份来自回执（' + fmtNum(ev.t) + ' 年，与内核 events[0].t 一致）',
     '实际：' + stxt.slice(0, 140));
  ok(String(ev.mass_before) === String(ev.mass_after),
     '（判据自检：内核回执里 mass_before = mass_after = ' + ev.mass_before + '，确实守恒）');
  ok(/一点没少/.test(stxt), '玩法 B：撞前撞后"一样重"这句有回执撑腰（比的是 mass_before / mass_after）');
  const expTxt = doc.getElementById('colexplain').textContent || '';
  ok(/450\s*倍/.test(expTxt) && /画大/.test(expTxt),
     '玩法 B：半径放大 450 倍被明确披露（不披露就是让人以为行星真有那么大）');
  const pageScripts = [...doc.querySelectorAll('script')].map(s => s.textContent).join('\n');
  ok(!/碎裂/.test(stxt + expTxt + pageScripts) && !/\bfragment\b/.test(pageScripts),
     '玩法 B：这一页全程没有"碎裂"这条路（fragment 会炸出上百个天体，不适合小朋友）');
  const colReq = fetchLog.filter(f => f.url.includes('/api/nbody') && f.body
    && f.body.collide === 'merge').slice(-1)[0];
  ok(!!colReq && !('primary' in colReq.body) && colReq.body.radius_scale === 450
     && colReq.body.bodies.length === 2 && colReq.body.bodies[0].argp === 0
     && colReq.body.bodies[1].argp === 180,
     '玩法 B：页面下发的正是那条实测过的配方（两颗近心点相反 / radius_scale=450 / 不带 primary）',
     colReq ? '实际请求：' + JSON.stringify(colReq.body).slice(0, 160) : '没抓到请求');
  const colnums = doc.getElementById('colnums').textContent || '';
  ok(colnums.indexOf(String(ev.mass_before)) >= 0 && /events/.test(colnums),
     '玩法 B：折叠区里写给大人的数字与回执对得上（mass_before=' + ev.mass_before + '）');
  ok(/col\.frames/.test(pageScripts) === false || /col\.frames\[i\]\.p\[/.test(pageScripts),
     '玩法 B：轨迹是回执的逐帧位置画的（没有为好看重画理想椭圆）');

  // ---- 10. 玩法 B 的对照：不撞，会互相穿过去 ----
  const offTruth = await askCollide('off');
  ok((offTruth.events || []).length === 0,
     '（判据自检：同一组初值、碰撞关掉时，内核一次事件都不报）');
  doc.getElementById('dopass').dispatchEvent(new dom.window.Event('click'));
  await sleep(3200);
  const stxt2 = doc.getElementById('colstory').textContent || '';
  ok(/没有撞上|穿了过去/.test(stxt2), '玩法 B：切到"不撞"时如实说没撞上、互相穿过去了',
     '实际：' + stxt2.slice(0, 140));
  ok(!/撞上了/.test(stxt2), '玩法 B：不撞时不会留着上一次"撞上了"的说法（两条路各自更新）',
     '实际：' + stxt2.slice(0, 140));

  // ---- 11. 不是死胡同：能回到小实验 ----
  doc.getElementById('backlab').dispatchEvent(new dom.window.Event('click'));
  await sleep(2400);
  ok(doc.getElementById('knobs').style.display !== 'none' && doc.getElementById('guess').style.display === 'none',
     '玩法 B：能"回到刚才的小实验"，旋钮回来、猜测面板收起');

  dom.window.close();
  console.log(LOG.join('\n'));
  console.log('\n[kids-e2e] n=' + n + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  LOG.push('  FAIL  探针自身异常：' + (e && e.message));
  console.log(LOG.join('\n'));
  console.log('\n[kids-e2e] n=' + n + ' fail=' + (fail + 1));
  process.exit(1);
});