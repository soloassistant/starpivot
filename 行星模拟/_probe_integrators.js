// 四种积分器的对比判据。
// 核心断言不是"数值对上了"，而是**长期能量行为符合各自的理论性质**：
//   蛙跳（辛、2 阶）   能量误差有界振荡，50 年后仍在 ~1e-7 量级
//   半隐式欧拉（辛、1 阶）误差大得多，且明显大于蛙跳
//   Hermite4（非辛、4 阶）单步更准，但 50 年后的漂移会超过蛙跳
//   开普勒解析          不做积分；总能量**不守恒**（它只考虑二体），差得最多
// 再加一条：默认不给 --integrator 必须与 --integrator leapfrog 逐位一致（老行为不变）。
const R = require('./_runner');   // 既能起进程就直接起，起不了就回放录制（见 _runner.js）
const fs = require('fs');
const path = require('path');
const EXE = path.join(__dirname, 'starpivot', 'build', 'bin', 'starpivot.exe');
let n = 0, fail = 0;
const L = [];
const ok = (c, m) => { n++; L.push((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

function run(args, timeout = 120000) {
  return R.shape(R.spawn(EXE, args, { timeout, maxBuffer: 512 << 20 }));
}

(async () => {
  const base = ['nbody', '--scenario', 'solar', '--no-bio', '--years', '50', '--samples', '60'];
  const get = (i) => run([...base, '--integrator', i]);

  const R = {};
  for (const k of ['leapfrog', 'hermite', 'euler', 'kepler']) R[k] = get(k);
  for (const k of Object.keys(R))
    ok(R[k].code === 0 && !!R[k].json && Array.isArray(R[k].json.energy_series),
       `--integrator ${k} 可用，并回显 energy_series`);

  const maxOf = k => Math.max(...R[k].json.energy_series);
  const lastOf = k => R[k].json.energy_series[R[k].json.energy_series.length - 1];
  L.push('  [info] 太阳系 50 年，逐帧相对能量误差：');
  for (const k of ['leapfrog', 'hermite', 'euler', 'kepler'])
    L.push(`    ${k.padEnd(9)} 末帧 ${lastOf(k).toExponential(2).padStart(9)}  峰值 ${maxOf(k).toExponential(2).padStart(9)}  ← ${R[k].json.integrator}`);

  // 1) 蛙跳：有界、极小
  ok(maxOf('leapfrog') < 1e-5,
     `蛙跳的能量误差有界且极小（峰值 ${maxOf('leapfrog').toExponential(2)}）`);
  // 2) 欧拉：显著更差
  ok(maxOf('euler') > maxOf('leapfrog') * 10,
     `半隐式欧拉明显在偷能量（峰值是蛙跳的 ${(maxOf('euler') / maxOf('leapfrog')).toExponential(1)} 倍）`);
  // 3) 辛性：把跨度拉大 100 倍，蛙跳的峰值应当基本不动（有界振荡），
  //    Hermite4 应当明显增长（漂移），并在某个跨度上反超蛙跳。
  //    注意 50 年这个跨度上 Hermite4 反而**比蛙跳准两个量级**（单步 4 阶的功劳），
  //    所以"非辛就更差"是错的 —— 必须测到 crossover，不能凭理论想当然。
  {
    const peak = (years, integ) => {
      const r = run(['nbody', '--scenario', 'solar', '--no-bio', '--years', String(years),
                     '--dt', '0.01', '--samples', '30', '--integrator', integ]);
      return Math.max(...r.json.energy_series);
    };
    const lf200 = peak(200, 'leapfrog'), lf20000 = peak(20000, 'leapfrog');
    const hm200 = peak(200, 'hermite'), hm20000 = peak(20000, 'hermite');
    L.push(`  [info] dt=0.01：蛙跳 200 年 ${lf200.toExponential(2)} → 20000 年 ${lf20000.toExponential(2)}`);
    L.push(`  [info] dt=0.01：Hermite 200 年 ${hm200.toExponential(2)} → 20000 年 ${hm20000.toExponential(2)}`);
    ok(lf20000 / lf200 < 1.3,
       `蛙跳跨 100 倍跨度后能量峰值几乎不变（比值 ${(lf20000 / lf200).toFixed(3)}）—— 这就是"有界振荡"`);
    ok(hm20000 / hm200 > 10,
       `Hermite4 同一跨度下能量峰值增长 ${(hm20000 / hm200).toFixed(0)} 倍 —— 这就是"非辛的漂移"`);
    ok(hm200 < lf200 && hm20000 > lf20000,
       `交叉点确实存在：200 年时 Hermite 更准（${hm200.toExponential(2)} < ${lf200.toExponential(2)}），`
       + `20000 年时蛙跳反超（${lf20000.toExponential(2)} < ${hm20000.toExponential(2)}）`
       + ' —— 单步精度高 ≠ 长期更好');
  }
  // 4) 解析：完全不守恒（因为它只考虑二体）
  ok(maxOf('kepler') > maxOf('euler'),
     `开普勒解析的总能量误差最大（${maxOf('kepler').toExponential(2)}）—— 它有意不含互相扰动`);

  // 5) 解析轨道本身必须是精确椭圆：单天体 + 只有一个中心时，形状不随时间变
  {
    // 周期不能拿"1 年"当整数：内核用 G=4π²、mu=G(1+m)，所以 T = 1/√(1+m) 年，不是恰好 1。
    // 用开普勒第三定律算出来的 T 去取整周期，才能验"解析解精确闭合"。
    const m_planet = 3.003489e-6;
    const T = 1 / Math.sqrt(1 + m_planet);            // a=1 AU、中心 1 M☉（G=4π²）
    // 让最后一帧**正好**落在 10T 上：dt = T/100，跑 1000 步。
    // 否则帧落在整年上，与整周期差 1.5e-5 个周期 → 位置差 1e-4 AU，那是我取样的问题不是内核的问题。
    const r = run(['nbody', '--scenario', 'custom', '--solar', 'none', '--no-bio',
                   '--years', (10 * T).toFixed(9), '--dt', (T / 100).toFixed(12),
                   '--samples', '200', '--integrator', 'kepler',
                   '--body', 'C,1,0,0,0,0,0,G_V:1', '--body', 'P,1,0.3,0,0,0,0,rocky:' + m_planet]);
    const js = r.json;
    if (!js) L.push('  FAIL  解析椭圆用例跑不起来: ' + r.txt.slice(0, 120));
    else {
      const pi = js.bodies.findIndex(b => b.id === 'P');
      // 逐帧验椭圆方程 r = a(1-e²)/(1+e·cos ν)：轨道形状必须**处处**精确，
      // 这比"极值半径相等"强 —— 后者受取样位置影响（apoapsis 未必被采到）。
      let worst = 0;
      for (const f of js.frames) {
        const q = f.p[pi];
        const rr = Math.hypot(q[0], q[1], q[2]);
        const nu = Math.atan2(q[1], q[0]);           // argp=0、i=0 ⇒ 极角就是真近点角
        const want = 1 * (1 - 0.3 * 0.3) / (1 + 0.3 * Math.cos(nu));
        worst = Math.max(worst, Math.abs(rr - want) / want);
      }
      // 容差不能小于**输出的打印精度**：坐标按 %.6f 输出，r≈1 AU 时相对量化误差就是 ~5e-7。
      // 定 1e-12 会得到一个"看起来像内核缺陷"的假失败（第一版就是这么栽的）。
      ok(worst < 2e-6,
         `解析模式下每一帧都落在椭圆 r = a(1-e²)/(1+e·cosν) 上（最大相对偏差 ${worst.toExponential(1)}，`
         + '已到 %.6f 输出精度地板）');
      const p0 = js.frames[0].p[pi], pN = js.frames[js.frames.length - 1].p[pi];
      const d = Math.hypot(p0[0] - pN[0], p0[1] - pN[1], p0[2] - pN[2]);
      ok(d < 1e-6, `10 个整周期（T=${T.toFixed(9)} 年，由 Kepler 第三定律算出）后精确回到出发点`
         + `（偏差 ${d.toExponential(2)} AU）—— 解析解没有积分误差`);
    }
  }

  // 6) 默认行为不变
  {
    const a = run([...base]);
    const b = run([...base, '--integrator', 'leapfrog']);
    const same = JSON.stringify(a.json.frames[0]) === JSON.stringify(b.json.frames[0])
      && JSON.stringify(a.json.energy_series) === JSON.stringify(b.json.energy_series);
    ok(same, '不给 --integrator 与给 leapfrog 逐位一致（默认行为没有变）');
    ok(a.json.integrator_key === 'leapfrog' && /symplectic/.test(a.json.integrator),
       '默认回显 integrator_key=leapfrog 并写明它是辛的');
  }

  // 7) 拼错/给错积分器名要拒绝
  {
    const r = run([...base, '--integrator', 'runge-kutta']);
    ok(r.code === 2 && /--integrator must be/.test(r.txt),
       '不认识的积分器名会明确拒绝并列出可用的四个：' + r.txt.slice(0, 70));
  }
  // 8) figure8 没有根数，解析模式必须拒绝
  {
    const r = run(['nbody', '--scenario', 'figure8', '--no-bio', '--samples', '5',
                   '--integrator', 'kepler']);
    ok(r.code === 2 && /figure8 has none/.test(r.txt),
       'figure8 没有根数，解析模式会拒绝并说明原因：' + r.txt.slice(0, 80));
  }

  // 9) 解析模式与 N 体的差 = 扰动：加了木星之后地球轨道应当被扰动
  {
    // 用 solar 场景（每个行星都有根数）；custom 场景必须至少给一个 --body，不能空跑。
    const one = run(['nbody', '--scenario', 'solar', '--no-bio',
                     '--years', '50', '--samples', '50', '--integrator', 'kepler']);
    const many = run(['nbody', '--scenario', 'solar', '--no-bio',
                      '--years', '50', '--samples', '50', '--integrator', 'leapfrog']);
    const idx = one.json.bodies.findIndex(b => b.id === 'Earth');
    const f = one.json.frames.length - 1;
    const d = Math.hypot(one.json.frames[f].p[idx][0] - many.json.frames[f].p[idx][0],
                         one.json.frames[f].p[idx][1] - many.json.frames[f].p[idx][1],
                         one.json.frames[f].p[idx][2] - many.json.frames[f].p[idx][2]);
    ok(d > 1e-3, `50 年后地球在"解析 vs N 体"里的位置差 ${d.toExponential(2)} AU —— 这个差就是扰动`);
  }

  fs.writeFileSync(path.join(__dirname, '_probe_integrators.txt'),
    L.join('\n') + '\n\n[integrators] n=' + n + ' fail=' + fail + '\n', 'utf8');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  L.push('  FAIL  探针自身异常：' + (e && e.stack || e));
  fs.writeFileSync(path.join(__dirname, '_probe_integrators.txt'),
    L.join('\n') + '\n\n[integrators] n=' + n + ' fail=' + (fail + 1) + '\n', 'utf8');
  process.exit(1);
});
