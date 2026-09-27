// 轨道页（index.html / 路由 /orbit）的**页面级**判据：jsdom 真加载、真驱动、真调内核。
//
// 为什么有这一条：全仓探针此前只加载 /universe.html —— 这一页的脚本**从来没被任何判据
// 执行过**，而它上面有 SGP4 星下点、预计算样本回放、碰撞预警三块功能，界面改版时还被改过。
//
// 这一页有两半，两半都要真跑：
//   · 上半页回放随页打包的**预计算样本**（viewer/demo.js，见 _probe_orbit_data.py 验它今天仍能逐位复现）；
//   · 下半页 conj 面板是**唯一真·现场计算**的入口（打给本机内核）。
//
// 判据：
//   1. 页面脚本跑完不抛异常；world.js / demo.js 真的加载进来了（否则只是安静地画空底图）。
//   2. #scenario 按样本填出 3 个选项；切换后三张表随之变化（不是写死的默认场景）。
//   3. 三张表渲染出的数**逐字等于样本里的数**；且"周期"那一格不许是 0 s（真发生过的假数）。
//   4. 页面对自己的承诺："实测打开本页只发过一次 /api/health" —— 数一次请求。
//   5. 播放按钮真的推进滑块并改按钮文字。
//   6. conj 面板：默认 TLE → 真调内核 → 表里的最近距离/TCA 与探针**独立再问一次**内核的结果一致。
//   7. 只给一行 TLE：明确报"需要两行"，且**不发请求**（本地能判的错不该打给内核）。
//   8. find-close 空结果：明确报"没有可用结果"，不静默；正常返回时把备选对填进输入框。
//   9. 负样本：把样本里一个数改掉，第 3 条那个比较函数必须判不一致（自证判据有效）。
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const BASE = process.env.STARPIVOT_BASE || 'http://localhost:8765';
const nodeFetch = globalThis.fetch;

let n = 0, fail = 0;
const L = [];
const ok = (c, m) => { n++; L.push((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const noop = () => {};

process.on('exit', () => {
  const tail = `\n[orbit-probe] n=${n} fail=${fail}`;
  L.push(tail);
  fs.writeFileSync(path.join(__dirname, '_probe_orbit.txt'), L.join('\n') + '\n', 'utf8');
});

// 把页面渲染出来的文字（表格 + 判定区）与样本对照。**唯一的比较函数**：负样本也走它。
// 只要有一项对不上就返回非空 —— 页面把内核的数画错、或者干脆画了别的数，都在这里露出来。
function missingFromRender(text, sc) {
  const el = sc.initial_elements, m1 = sc.mean_elements_end, dr = sc.secular_drift, m = sc.model;
  const want = [
    ['周期', el.period_s.toFixed(0) + ' s  (' + (el.period_s / 60).toFixed(1) + ' min)'],
    ['末期平均半长轴', m1.a_km.toFixed(3) + ' km'],
    ['末期平均偏心率', m1.e.toExponential(3)],
    ['升交点速率', dr.draan_deg_per_day.toFixed(4)],
    ['积分器与步长', m.integrator + '  (步长 ' + m.step_s + ' s)'],
    ['引力场', m.gravity],
    ['地球形状', m.earth_model],
  ];
  return want.filter(([, v]) => !text.includes(v)).map(([k, v]) => `${k}（缺「${v}」）`);
}

(async () => {
  L.push('轨道页页面级判据（' + BASE + '）');

  const rawHtml = await (await nodeFetch(BASE + '/orbit')).text();
  const srcs = [...rawHtml.matchAll(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g)].map(m => m[1]);
  ok(srcs.length === 2 && srcs.includes('world.js') && srcs.includes('demo.js'),
     '页面自己声明了随页打包的脚本：' + srcs.join(', '));

  // 随页打包的脚本由探针替 jsdom 取（jsdom 默认不抓外部脚本），但**文件名是从页面上读的**：
  // 页面改名或漏引用都会在上面那条断言里露出来，而不是被探针偷偷补上。
  const srcText = {};
  for (const s of srcs) srcText[s] = await (await nodeFetch(BASE + '/' + s)).text();
  const demoTxt = srcText['demo.js'] || '{}';
  const demo = JSON.parse(demoTxt.split('=')[1].trim().replace(/;$/, ''));
  const keys = Object.keys(demo).filter(k => !k.startsWith('__'));

  const ctxStub = new Proxy({}, {
    get: (t, k) => (k === 'measureText' ? () => ({ width: 10 })
      : (k === 'createLinearGradient' || k === 'createRadialGradient')
        ? () => ({ addColorStop: noop }) : noop),
    set: () => true,
  });

  const fetchLog = [];
  let mockFindClose = null;   // 设了就替换 find-close 的响应（不碰真网络，判据因此是确定的）
  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push(String(e && e.message)));

  const html = rawHtml.replace(/<script[^>]*src="[^"]+"[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, {
    url: BASE + '/orbit', runScripts: 'dangerously', virtualConsole: vc,
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = () => ctxStub;
      w.fetch = (u, o) => {
        const abs = new URL(String(u), BASE).href;
        let b = null; if (o && o.body) { try { b = JSON.parse(o.body); } catch (e) { b = String(o.body); } }
        fetchLog.push({ url: String(u), abs, body: b, method: (o && o.method) || 'GET' });
        if (mockFindClose && abs.includes('/api/find-close')) return Promise.resolve(mockFindClose);
        return nodeFetch(abs, o);
      };
      for (const s of srcs) w.eval(srcText[s]);
    },
  });
  const w = dom.window, d = w.document;
  const $ = id => d.getElementById(id);
  const fire = (el, ty) => el.dispatchEvent(new w.Event(ty, { bubbles: true }));
  await sleep(120);

  // 1. 页面脚本跑完不抛异常
  ok(errs.length === 0, '页面脚本跑完没有抛异常' + (errs.length ? '   ' + errs[0] : ''));
  ok(Array.isArray(w.WORLD_LAND) && w.WORLD_LAND.length > 0,
     `地图陆地数据真的加载了（${(w.WORLD_LAND || []).length} 个环）—— 否则只是安静地画个空底图`);
  ok(keys.length >= 3 && keys.every(k => (demo[k].ground_track || []).length > 1),
     `样本里 ${keys.length} 个场景都带轨道数据：`
     + keys.map(k => `${k}(${demo[k].ground_track.length}点)`).join('，')
     + `（顶层还有 __end 哨兵，页面按 __ 前缀过滤）`);

  // 2. 场景下拉是按样本填的，不是写死的
  const opts = [...$('scenario').options];
  ok(opts.length === keys.length && opts.every(o => o.textContent.trim()),
     `${opts.length} 个场景选项都有文案：` + opts.map(o => o.textContent.trim().slice(0, 12)).join(' / '));

  // 3. 三张表的数逐字等于样本里的数
  for (const k of keys) {
    $('scenario').value = k;
    fire($('scenario'), 'change');
    const text = $('kv').textContent + ' ' + $('model').textContent + ' ' + $('verdict').textContent;
    const miss = missingFromRender(text, demo[k]);
    ok(miss.length === 0, `${k}：关键量/模型/判定三张表的数逐字等于样本` + (miss.length ? '   缺: ' + miss.join('；') : ''));
    // 回归守卫：这一格曾经读一个不存在的字段，于是三个场景全显示 "0 s  (0.0 min)"。
    const periodCell = [...$('kv').querySelectorAll('tr')][1];
    const ptext = periodCell ? periodCell.children[1].textContent : '';
    ok(!/^0 s/.test(ptext.trim()),
       `${k}："周期"不是那个安静显示成 0 的假数（实测 ${ptext.trim()}）`);
    if (demo[k].model.spacecraft) {
      const sc = demo[k].model.spacecraft;
      ok($('model').textContent.includes(sc.area_over_mass_m2_per_kg.toExponential(2)),
         `${k}：模型表把样本里的 A/m 显示出来了（${sc.area_over_mass_m2_per_kg.toExponential(2)}）`);
    } else {
      ok(!/航天器面积/.test($('model').textContent),
         `${k}：样本没记面积/质量，模型表就不占那一行（不补零）`);
    }
  }

  // 9. 负样本：同一个比较函数，喂一个被改坏的样本，必须判不一致
  const broken = JSON.parse(JSON.stringify(demo[keys[0]]));
  broken.mean_elements_end.a_km += 1.0;
  ok(missingFromRender($('kv').textContent + ' ' + $('model').textContent + ' ' + $('verdict').textContent,
                       broken).length > 0,
     '负样本：把样本里的半长轴改 1 km，同一处会判渲染对不上（自证判据有效）');

  // 4. 页面自己宣称的"只发过一次 /api/health"
  const healthOnly = fetchLog.length === 1 && fetchLog[0].abs.includes('/api/health');
  ok(healthOnly, `加载本页只发过一次 /api/health（实测 ${fetchLog.length} 次：`
     + fetchLog.map(f => f.url).join(', ') + '）—— 这是页面原文写着的承诺');
  const h = await (await nodeFetch(BASE + '/api/health')).json();
  ok('exists' in h && 'exe' in h, '页面读的健康字段（exists / exe）内核真的回显了');

  // 5. 播放按钮真的推进
  $('scenario').value = keys[0]; fire($('scenario'), 'change');
  $('slider').value = 0;
  fire($('play'), 'click');
  await sleep(200);
  const v1 = +$('slider').value;
  ok(v1 > 0 && /暂停/.test($('play').textContent),
     `播放：滑块被推到 ${v1}，按钮变成"${$('play').textContent.trim()}"`);
  fire($('play'), 'click');
  ok(/播放/.test($('play').textContent) && +$('slider').value >= v1,
     '再点一次回到"播放"且不倒退');

  // 6. conj 面板：真调内核，并与探针独立再问一次的结果比对
  const tleA = $('tleA').value.split('\n').filter(Boolean);
  const tleB = $('tleB').value.split('\n').filter(Boolean);
  ok(tleA.length === 2 && tleB.length === 2, '页面预置了一对真实编目 TLE（各两行）');
  const exp = await (await nodeFetch(BASE + '/api/conj', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ line1: tleA[0], line2: tleA[1], line3: tleB[0], line4: tleB[1],
                           window_min: 1440, step_min: 1, threshold_km: 100 }),
  })).json();
  fire($('crun'), 'click');
  for (let i = 0; i < 60 && !$('cresult').textContent.trim(); i++) await sleep(250);
  const rtext = $('cresult').textContent;
  const missKm = (exp.result || {}).miss_distance_km;
  ok(rtext.includes(missKm.toFixed(3)),
     `conj：表里的最近距离与探针独立问内核的结果一致（${missKm.toFixed(3)} km）`);
  ok(rtext.includes(exp.result.tca_utc), `conj：TCA 时刻一致（${exp.result.tca_utc}）`);
  ok(rtext.includes(String(exp.object_a.satnum)) && rtext.includes(String(exp.object_b.satnum)),
     'conj：两颗对象的编目号都显示出来了');
  let rawOk = false;
  try { rawOk = Object.keys(JSON.parse($('cjson').textContent)).length >= 4; } catch (e) { rawOk = false; }
  ok(rawOk, 'conj：折叠区里的原始 JSON 是完整可解析的（不是半截）');
  ok($('cmapbox').style.display === 'block', 'conj：TCA 地面轨迹图真的显示了（有星下点数据才显示）');

  // 7. 只给一行 TLE：本地就能判的错，不许打给内核，也不许静默
  const before = fetchLog.length;
  $('tleA').value = tleA[0];
  fire($('crun'), 'click');
  await sleep(300);
  ok(/需要两行 TLE/.test($('cstatus').textContent),
     '只给一行 TLE：明确报「需要两行 TLE」（实测 ' + $('cstatus').textContent.trim().slice(0, 40) + '）');
  ok(fetchLog.length === before, '而且没有把请求打给内核（本地能判的错不该发出去）');

  // 8. find-close：空结果要说话；正常结果要填进输入框
  mockFindClose = { ok: true, json: async () => ({ pairs: [] }) };
  fire($('cfind'), 'click');
  await sleep(300);
  ok(/没有可用结果/.test($('cstatus').textContent),
     'find-close 返回空：明确报「没有可用结果」，不静默');
  const emptyUrl = fetchLog[fetchLog.length - 1].abs;
  ok(/top=12/.test(emptyUrl) && /cap=1500/.test(emptyUrl) && /groups=/.test(emptyUrl),
     'find-close 的请求带上分组/条数/上限：' + decodeURIComponent(emptyUrl.replace(BASE, '')));

  mockFindClose = { ok: true, json: async () => ({ pairs: [
    { satnum_a: 99001, satnum_b: 99002, miss_km: 1.234, rel_speed_kms: 7.891,
      tca_utc: '2026-01-01T00:00:00Z',
      l1_a: '1 99001U 26001A   26001.00000000  .00000000  00000+0  00000+0 0  9991',
      l2_a: '2 99001  70.0000   0.0000 0001000   0.0000   0.0000 14.90000000    01',
      l1_b: '1 99002U 26001B   26001.00000000  .00000000  00000+0  00000+0 0  9992',
      l2_b: '2 99002  70.0000   0.1000 0001000   0.0000   0.0000 14.90000000    02' }] }) };
  fire($('cfind'), 'click');
  await sleep(300);
  ok($('tleA').value.includes('99001') && $('tleB').value.includes('99002'),
     'find-close 有结果时：第 1 名被填进两个输入框');
  ok($('cresult').textContent.includes('1.23') && $('cresult').textContent.includes('99001'),
     'find-close 有结果时：候选表按内核给的数渲染（miss 1.23 km）');

  // 提示（不是判据）：默认分组里 iridium 已被上游 CelesTrak 改名，另两组仍供数。
  console.log('  [note] 默认分组含 iridium —— 上游已把该组改名（返回 not found）；');
  console.log('         这不是本页的缺陷，但触屏/线上取不到那一组时是这个原因。');
})().catch(e => {
  ok(false, '探针自身异常：' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
}).finally(() => {
  console.log(L.join('\n'));
  process.exit(fail ? 1 : 0);
});
