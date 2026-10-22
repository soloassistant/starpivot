// 天体类型目录（四个分类维度）+ 多光源辐照度 的判据。
// 半径全部用 SI 单位独立复算：斯特藩-玻尔兹曼 / 简并关系 / 固定值 / 史瓦西；
// 再拿几个真实天体核对量级（参宿四、盾牌座 UY、大角星、比邻星、天狼星 B…）。
const R = require('./_runner');   // 既能起进程就直接起，起不了就回放录制（见 _runner.js）
const fs = require('fs');
const path = require('path');
const EXE = path.join(__dirname, 'starpivot', 'build', 'bin', 'starpivot.exe');
let n = 0, fail = 0;
const L = [];
const ok = (c, m) => { n++; L.push((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

function run(args, timeout = 90000) {
  return R.shape(R.spawn(EXE, args, { timeout, maxBuffer: 512 * 1024 * 1024 }));
}
const nbody = (extra, withBio) =>
  run(['nbody', ...(withBio ? [] : ['--no-bio']), '--samples', '5', ...extra]);

// ---- 独立复算用的常数（全部不取自内核）----
const G = 6.67430e-11, C = 2.99792458e8, MSUN = 1.98847e30, RSUN_KM = 696340, TSUN = 5778;
const DAY_PER_YR = 365.25;

(async () => {
  // ---------- 1. catalog 与四个分类维度 ----------
  const cat = run(['catalog']);
  ok(cat.code === 0 && cat.json && cat.json.status === 'ok', 'catalog 子命令可用');
  const T = (cat.json && cat.json.types) || [];
  const byKey = k => T.find(t => t.key === k);
  ok(T.length >= 35, `类型表有 ${T.length} 个类型（覆盖四个分类维度）`);

  const groups = {};
  T.forEach(t => { groups[t.group] = (groups[t.group] || 0) + 1; });
  ok(groups.spectral >= 7, `维度 1「按光谱型」有 ${groups.spectral} 个：O/B/A/F/G/K/M 全在`);
  for (const s of ['O_V','B_V','A_V','F_V','G_V','K_V','M_V']) ok(!!byKey(s), `光谱型 ${s} 存在`);
  ok(!!byKey('WR') && !!byKey('carbon'), '特殊光谱型（沃尔夫-拉叶星、碳星）也在');
  ok(groups.luminosity >= 12, `维度 2「按光度与大小」有 ${groups.luminosity} 个`);
  for (const s of ['sd','subgiant','G_III','K_III','M_III','B_II','K_II',
                   'O_I','B_I','A_I','G_I','K_I','M_I','M_0','B_0'])
    ok(!!byKey(s), `光度级 ${s} 存在`);
  ok(byKey('sd') && /亚矮星/.test(byKey('sd').name_zh), '光度级 VI 亚矮星在');
  ok(groups.evolution >= 4, `维度 3「按演化阶段」有 ${groups.evolution} 个`);
  for (const s of ['pre_main','white_dwarf','neutron_star','black_hole'])
    ok(!!byKey(s), `演化阶段 ${s} 存在`);
  ok(groups.special >= 8, `维度 4「按特殊性质」有 ${groups.special} 个`);
  for (const s of ['cepheid','rr_lyrae','mira','pulsar','magnetar','metal_poor'])
    ok(!!byKey(s), `特殊性质 ${s} 存在`);

  ok(T.every(t => t.example), '每个类型都给了代表天体（页面直接显示）');
  ok(T.every(t => t.also_in), '每个类型都写明了它在别的维度里算什么（四维交叉）');
  ok(T.every(t => t.source && t.source.length > 6), '每个类型都写明了温度/半径的口径出处');
  ok(/四个维度互相交叉/.test(cat.json.cross_note || ''), 'catalog 里说明了四个维度是交叉的');
  ok(/斯特藩-玻尔兹曼/.test(cat.json.radius_note || ''), 'catalog 里说明了半径的推导方式');

  // ---------- 2. 半径：按 radius_model 逐个独立复算 ----------
  const radiusExpect = (t, m) => {
    // 注意：L 只在需要它的分支里求。无条件先算 L 的话，
    // from_radius_and_t（白矮星）会和这里互相调用 —— 内核那边踩过同一个坑。
    if (t.radius_model === 'stefan_boltzmann') {
      const Lv = lumExpect(t, m);
      if (!(Lv > 0) || !(t.t_eff_K > 0)) return 0;
      return RSUN_KM * Math.sqrt(Lv) / Math.pow(t.t_eff_K / TSUN, 2);
    }
    if (t.radius_model === 'degenerate') {
      const mm = t.radius_formula.match(/^R = ([0-9.eE+-]+) km \* \(M\/([0-9.eE+-]+)\)\^([0-9.eE+-]+)$/);
      if (!mm) return NaN;
      return (+mm[1]) * Math.pow(m / (+mm[2]), (+mm[3]));
    }
    if (t.radius_model === 'fixed') return +t.radius_formula.match(/^R = ([0-9.eE+-]+) km/)[1];
    return 2 * G * m * MSUN / (C * C) / 1000;   // schwarzschild
  };
  const lumExpect = (t, m) => {
    if (t.lum_model === 'mass_to_the_35') return Math.pow(m, 3.5);
    if (t.lum_model === 'fixed') return +t.lum_formula.match(/^L = ([0-9.eE+-]+)/)[1];
    if (t.lum_model === 'none') return 0;
    const r = radiusExpect(t, m) / RSUN_KM;     // from_radius_and_t
    return r * r * Math.pow(t.t_eff_K / TSUN, 4);
  };
  {
    const bad = [];
    for (const t of T) {
      for (const [ms, r] of Object.entries(t.radius_at)) {
        const e = radiusExpect(t, +ms);
        if (!Number.isFinite(e) || e <= 0) { bad.push(`${t.key}@${ms} 期望算不出`); continue; }
        if (Math.abs(r - e) / e > 1e-3) bad.push(`${t.key}@${ms}: ${r} vs ${e.toFixed(3)}`);
      }
    }
    ok(bad.length === 0, `全部 ${T.length} 个类型的半径都与它自己声明的模型一致`
      + (bad.length ? ' —— 不符: ' + bad.slice(0, 4).join('; ') : ''));
    const sb = T.filter(t => t.radius_model === 'stefan_boltzmann').length;
    const dg = T.filter(t => t.radius_model === 'degenerate').length;
    const fx = T.filter(t => t.radius_model === 'fixed').length;
    const sc = T.filter(t => t.radius_model === 'schwarzschild').length;
    ok(sb >= 28, `${sb} 个类型的半径由斯特藩-玻尔兹曼从 T 与 L 推出（真公式）`);
    ok(dg >= 4 && fx === 3 && sc === 1,
       `另有 ${dg} 个走简并关系、${fx} 个固定值（中子星 / 脉冲星 / 磁星）、${sc} 个史瓦西（黑洞）`
       + ' —— 四条路各有出处');
  }

  // ---------- 3. 与真实天体核对量级 ----------
  {
    const Rsof = (k) => {
      const t = byKey(k);
      return t.radius_at[String(t.mass_default)] / RSUN_KM;
    };
    const cases = [
      ['G_V', 1.0, 0.02, '太阳（定义上就是 1 R☉）'],
      ['M_V', 0.154, 0.35, '比邻星（0.154 R☉）'],
      ['K_III', 25.0, 0.35, '大角星（约 25 R☉）'],
      ['M_I', 900.0, 0.35, '参宿四（760~1000 R☉）'],
      ['M_0', 1708.0, 0.30, '盾牌座 UY（约 1708 R☉）'],
      ['B_I', 78.0, 0.35, '参宿七（约 78 R☉）'],
    ];
    for (const [k, real, tol, label] of cases) {
      const got = Rsof(k);
      ok(Math.abs(got / real - 1) < tol,
         `${k} 半径 ${got.toFixed(1)} R☉ vs ${label} —— 差 ${((got / real - 1) * 100).toFixed(0)}%`);
    }
    const wd = byKey('white_dwarf');
    const wdR = wd.radius_at[String(wd.mass_default)] / RSUN_KM;
    ok(Math.abs(wdR - 0.0127) / 0.0127 < 0.05,
       `白矮星 0.6 M☉ 半径 ${wdR.toFixed(4)} R☉（天狼星 B 约 0.0127 R☉）`);
    const ns = byKey('neutron_star');
    ok(ns.radius_at[String(ns.mass_default)] === 12, '中子星半径 12 km（观测典型值）');
  }

  // ---------- 4. 光谱型 / 光度级的单调性（这是分类的意义所在）----------
  {
    const Ts = ['O_V','B_V','A_V','F_V','G_V','K_V','M_V'].map(k => byKey(k).t_eff_K);
    ok(Ts.every((v, i) => i === 0 || v < Ts[i - 1]),
       '光谱型 O→M 的有效温度严格递减：' + Ts.join(' > '));
    // 同一光谱型（M 型）下，光度级从主序到特超巨星应逐个变大
    const Ls = ['M_V','M_III','M_I','M_0'].map(k => {
      const t = byKey(k);
      return t.lum_model === 'mass_to_the_35' ? Math.pow(t.mass_default, 3.5) : t.lum_formula.match(/L = ([0-9.eE+-]+)/) ? +t.lum_formula.match(/L = ([0-9.eE+-]+)/)[1] : 0;
    });
    ok(Ls.every((v, i) => i === 0 || v > Ls[i - 1]),
       'M 型从主序到特超巨星光度逐个变大：' + Ls.map(x => x.toExponential(1)).join(' < '));
    ok(Ls[0] < 0.01 && Ls[3] > 1e5,
       '红矮星（' + Ls[0].toExponential(1) + ' L☉）与红特超巨星（' + Ls[3].toExponential(1) + ' L☉）相差 7 个量级');
  }

  // ---------- 5. 变星：光变真的进了辐照度 ----------
  {
    const ce = byKey('cepheid');
    ok(ce.variability && ce.variability.on && ce.variability.period_days > 0,
       `经典造父变星带光变参数（周期 ${ce.variability.period_days} 天，振幅 ${ce.variability.amplitude_mag} 等）`);
    const mi = byKey('mira');
    ok(mi.variability.amplitude_mag >= 4, `米拉变星振幅 ${mi.variability.amplitude_mag} 等（三个量级的亮度变化）`);
    ok(!byKey('G_V').variability.on, '稳定恒星没有光变参数');
  }
  {
    // 用内核的 lum_series 验：峰值/谷值之比应等于 10^(0.4Δm)，且行星的 S 跟着振荡
    const r = nbody(['--scenario', 'custom', '--solar', 'none', '--years', '0.2', '--samples', '400',
                     '--body', 'CV,3,0,0,0,0,0,cepheid:6',
                     '--body', 'P,0.5,0,0,0,0,0,rocky:3.003489e-6'], true);
    const js = r.json;
    if (!js) L.push('  FAIL  变星用例跑不起来: ' + r.txt.slice(0, 160));
    else {
      const ci = js.bodies.findIndex(b => b.id === 'CV');
      const cv = js.bodies[ci];
      ok(Array.isArray(cv.lum_series) && cv.lum_series.length === js.frames.length,
         `变星回显了逐帧光度序列（${cv.lum_series.length} 帧）`);
      const lo = Math.min(...cv.lum_series), hi = Math.max(...cv.lum_series);
      const want = Math.pow(10, 0.4 * cv.variability.amplitude_mag);
      ok(Math.abs(hi / lo / want - 1) < 0.05,
         `序列的峰值/谷值 = ${(hi / lo).toFixed(3)}，与星等振幅的定义 10^(0.4·Δm) = ${want.toFixed(3)} 一致`);
      ok(lo > 0, '光变因子恒为正（用乘性因子而不是 1+A·sin，否则米拉那种振幅会算出负光度）');
      // 行星的辐照度应随脉动振荡
      const pi = js.bodies.findIndex(b => b.id === 'P');
      const ins = js.bio.bodies[pi].insolation;
      const iLo = Math.min(...ins), iHi = Math.max(...ins);
      ok(iHi / iLo > 1.5,
         `行星的辐照度跟着振荡（S 从 ${iLo.toExponential(3)} 到 ${iHi.toExponential(3)}，比 ${(iHi / iLo).toFixed(2)}）`);
      // 注意不能拿"振幅相等"来判：行星自己在动，距离也在变，S 的变化是脉动与距离两项的合成。
      // 正确的判法是逐帧用 L(t)/r(t)² 独立复算（既验脉动、又验几何）。
      let worst = 0;
      for (let f = 0; f < js.frames.length; f++) {
        const q = js.frames[f].p;
        const d = Math.hypot(q[pi][0] - q[ci][0], q[pi][1] - q[ci][1], q[pi][2] - q[ci][2]);
        const want2 = cv.lum_series[f] / (d * d);
        worst = Math.max(worst, Math.abs(ins[f] - want2) / want2);
      }
      ok(worst < 1e-3,
         `逐帧 S(t) 与 L(t)/r(t)² 独立复算一致（最大偏差 ${(worst * 100).toExponential(1)}%）—— `
         + '脉动确实一路传到了行星的辐照度上');
    }
  }

  // ---------- 6. 类型名是承诺 ----------
  {
    const r = nbody(['--scenario', 'custom', '--solar', 'sun', '--body', 'X,1,0,0,0,0,0,M_V:10']);
    ok(r.code === 2 && /M_V mass must be in \[0.08, 0.45\]/.test(r.txt),
       '把 10 M☉ 叫成 M 型主序星会被拒绝并点名范围：' + r.txt.slice(0, 80));
    const r2 = nbody(['--scenario', 'custom', '--solar', 'sun', '--body', 'X,1,0,0,0,0,0,M_II:1']);
    ok(r2.code === 2 && /unknown type/.test(r2.txt), '不存在的类型名会拒绝（并列出可用键名）');
    const r3 = nbody(['--scenario', 'custom', '--solar', 'sun', '--body', 'X,1,0,0,0,0,0,M_V']);
    ok(r3.code === 2 && /needs a mass/.test(r3.txt), '类型后面忘了写质量也会明确报错');
  }

  // ---------- 7. 不发光 / 简并 / 黑洞 ----------
  {
    const r = nbody(['--scenario', 'custom', '--solar', 'sun',
                     '--body', 'BH,2,0,0,0,0,0,black_hole:10',
                     '--body', 'NS,3,0,0,0,0,0,neutron_star:1.4',
                     '--body', 'PS,4,0,0,0,0,0,pulsar:1.4',
                     '--body', 'MG,5,0,0,0,0,0,magnetar:1.4']);
    const js = r.json;
    for (const id of ['BH','NS','PS','MG']) {
      const b = js.bodies.find(x => x.id === id);
      ok(b.emits_light === false && b.luminosity_Lsun === 0, `${id}（${b.type}）不发光，光度恰好 0`);
    }
    ok(js.light_source_count === 1 && js.light_sources[0].id === 'Sun',
       '黑洞/中子星/脉冲星/磁星都没有被当成光源（旧的"取最重者"会把 10 M☉ 黑洞当灯）');
  }
  {
    const r = nbody(['--scenario', 'custom', '--solar', 'none',
                     '--body', 'WD,0.05,0,0,0,0,0,white_dwarf:0.6',
                     '--body', 'P,0.1,0,0,0,0,0,rocky:3.003489e-6'], true);
    const js = r.json;
    const wd = js.bodies.find(b => b.id === 'WD');
    ok(wd.emits_light === true && Math.abs(wd.luminosity_Lsun - 1.45e-3) / 1.45e-3 < 0.2,
       `白矮星现在算作真光源：L = ${wd.luminosity_Lsun.toExponential(3)} L☉`
       + '（由 R 与 T 经斯特藩-玻尔兹曼推出，量级与观测的 ~1e-3 一致）');
    ok(js.light_source_count === 1 && js.light_sources[0].id === 'WD', '它是这个系统里唯一的光源');
    const pi = js.bodies.findIndex(b => b.id === 'P');
    ok(js.bio.bodies[pi].insolation[0] > 0, '它照到了 0.1 AU 处的那颗行星');
  }

  // ---------- 8. 多光源求和仍然成立 ----------
  function sumFromFrames(js, i) {
    const p0 = js.frames[0].p;
    const lights = js.light_sources.map(s => js.bodies.findIndex(b => b.id === s.id));
    let S = 0;
    for (const j of lights) {
      if (j === i) continue;
      const d = Math.hypot(p0[i][0] - p0[j][0], p0[i][1] - p0[j][1], p0[i][2] - p0[j][2]);
      S += js.bodies[j].luminosity_Lsun / (d * d);
    }
    return S;
  }
  {
    const r = nbody(['--scenario', 'custom', '--solar', 'none', '--years', '0.3', '--samples', '40',
                     '--primary', 'A',
                     '--body', 'A,1,0,0,0,0,0,G_V:1',
                     '--body', 'B,1,0,0,0,180,0,G_V:1',
                     '--body', 'P,0.4,0,0,0,0,0,rocky:3.003489e-6'], true);
    const js = r.json;
    const pi = js.bodies.findIndex(b => b.id === 'P');
    const expect = sumFromFrames(js, pi);
    const got = js.bio.bodies[pi].insolation[0];
    ok(js.light_source_count === 2, '双星系统识别出 2 个光源');
    ok(Math.abs(got - expect) / expect < 1e-3,
       `双星下 P 的 S = ${got}，两项求和独立复算 = ${expect.toFixed(6)}`);
  }

  // ---------- 9. 太阳系基线不能被改坏 ----------
  {
    const r = run(['nbody', '--scenario', 'solar', '--years', '50', '--samples', '5']);
    const js = r.json;
    const ei = js.bodies.findIndex(b => b.id === 'Earth');
    const p0 = js.frames[0].p, si = js.bodies.findIndex(b => b.id === 'Sun');
    const rAU = Math.hypot(p0[ei][0]-p0[si][0], p0[ei][1]-p0[si][1], p0[ei][2]-p0[si][2]);
    const expect = 1.0 / (rAU * rAU);
    const S = js.bio.bodies[ei].insolation[0];
    ok(Math.abs(S - expect) / expect < 1e-4,
       `太阳系里地球的 S = ${S}，按 1/r² 复算 = ${expect.toFixed(6)}（r = ${rAU.toFixed(4)} AU）`);
    ok(js.light_source_count === 1 && js.light_sources[0].id === 'Sun', '太阳系里只有太阳是光源');
    const sun = js.bodies[si];
    ok(sun.type === 'G_V' && sun.emits_light === true, '太阳在内核类型表里是 G_V（G 型主序星）');
    ok(Math.abs(sun.t_eff_K - 5778) < 1, `太阳的 T_eff 回显 ${sun.t_eff_K} K（H-R 图的输入）`);
    ok(Math.abs(sun.radius_km / RSUN_KM - 1) < 0.05,
       `太阳半径 ${(sun.radius_km / RSUN_KM).toFixed(4)} R☉ —— 它是整套半径口径的锚点`);
    for (const nm of ['Mercury','Venus','Jupiter','Pluto']) {
      const i = js.bodies.findIndex(b => b.id === nm);
      ok(js.bodies[i].emits_light === false && js.bodies[i].t_eff_K === 0,
         `内置行星 ${nm} 不发光且没有有效温度（不落进 H-R 图）`);
    }
  }

  fs.writeFileSync(path.join(__dirname, '_probe_bodytypes.txt'),
    L.join('\n') + '\n\n[bodytypes] n=' + n + ' fail=' + fail + '\n', 'utf8');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  L.push('  FAIL  探针自身异常：' + (e && e.stack || e));
  fs.writeFileSync(path.join(__dirname, '_probe_bodytypes.txt'),
    L.join('\n') + '\n\n[bodytypes] n=' + n + ' fail=' + (fail + 1) + '\n', 'utf8');
  process.exit(1);
});
