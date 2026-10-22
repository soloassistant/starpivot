// 时间/步长参数校验 + 输出采样标定 的判据。
// 修之前实测过：--years abc → 未捕获异常 abort；--years -5 → 静默按 50 年跑；
// --dt 0 → status ok 但 frames 空（页面收到就崩）；--years 1e6 → 不拒绝直接算十几分钟。
const R = require('./_runner');   // 既能起进程就直接起，起不了就回放录制（见 _runner.js）
const fs = require('fs');
const path = require('path');
const EXE = path.join(__dirname, 'starpivot', 'build', 'bin', 'starpivot.exe');
let n = 0, fail = 0;
const L = [];
const ok = (c, m) => { n++; L.push((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

function run(args, timeout = 30000) {
  const t0 = Date.now();
  const r = R.spawn(EXE, args, { timeout, maxBuffer: 64 * 1024 * 1024 });
  const s = R.shape(r);
  // 耗时优先取录制里记下的真实耗时：回放时墙钟约等于 0，直接量会把
  // "它挡得快不快"变成恒真 —— 那就不是判据了。
  if (s.ms === undefined || s.ms === null) s.ms = Date.now() - t0;
  return s;
}

// ---- 1. 非数字不再崩 ----
for (const [flag, v] of [['--years', 'abc'], ['--year', '1'], ['--dt', 'x'], ['--samples', 'z']]) {
  const r = run(['nbody', '--scenario', 'solar', '--no-bio', flag, v, '--samples', '5']);
  ok(r.code === 2, `${flag} ${v} → 退出码 2（明确拒绝），实际 ${r.code}`);
  ok(/starpivot: /.test(r.txt), `${flag} ${v} → 报错是内核自己写的，不是 libc++abi 崩溃信息：${r.txt.slice(0, 60)}`);
}
ok(!/terminating due to uncaught exception/.test(run(['nbody', '--years', 'abc']).txt),
   '不再出现 std::terminate / libc++abi 未捕获异常');

// ---- 1b. 地球质量回显（页面做"相当于几个地球"的换算要用，页面的物理常量越少越好）----
{
  const r = run(['nbody', '--scenario', 'solar', '--no-bio', '--years', '1', '--samples', '5']);
  const em = r.json && r.json.earth_mass_msun;
  const EARTH_M_MSUN = 5.9722e24 / 1.98847e30;   // 独立复算（IAU 标称太阳质量），不用内核那个数
  ok(typeof em === 'number' && Math.abs(em - EARTH_M_MSUN) / EARTH_M_MSUN < 1e-3,
     `earth_mass_msun = ${em} 与文献值 ${EARTH_M_MSUN.toExponential(6)} 一致（差 `
     + (em ? ((em - EARTH_M_MSUN) / EARTH_M_MSUN * 100).toFixed(4) : '-') + '%）');
  // 更要紧的是自洽：页面拿它换算"几个地球"，用的必须是同一个数，
  // 否则页面说的"3 个地球"和内核里那颗地球不是一回事。
  const earthBody = (r.json.bodies || []).find(b => b.id === 'Earth');
  ok(earthBody && Math.abs(earthBody.mass_msun - em) / em < 1e-12,
     `回显的地球质量与太阳系行星表里那颗 Earth 的质量逐位相同（${em} vs ${earthBody && earthBody.mass_msun}）`);
}

// ---- 2. 越界拒绝 ----
for (const [args, why] of [
  [['--years', '-5'], '负年数'], [['--years', '0'], '零年数'],
  [['--dt', '0'], '零步长'], [['--dt', '-0.001'], '负步长']
]) {
  const r = run(['nbody', '--scenario', 'solar', '--no-bio', ...args, '--samples', '5']);
  ok(r.code === 2, `${args.join(' ')}（${why}）→ 明确拒绝，实际退出码 ${r.code}｜${r.txt.slice(0, 70)}`);
}
// 步数上限：不拒绝就等于让一次调用把机器占死
const heavy = run(['nbody', '--scenario', 'solar', '--no-bio', '--years', '1000000', '--samples', '5'], 20000);
ok(heavy.code === 2 && /steps/.test(heavy.txt),
   `--years 1000000 → 立刻被步数上限挡住（不再算十几分钟）：${heavy.txt.slice(0, 80)}`);
ok(heavy.ms < 3000, `而且挡得很快（${heavy.ms} ms）`);

// ---- 3. 采样标定回显 ----
const r1 = run(['nbody', '--scenario', 'solar', '--no-bio', '--years', '50', '--samples', '400']);
const s = r1.json && r1.json.sampling;
ok(!!s, 'JSON 里有 sampling 块');
if (s) {
  ok(Math.abs(s.min_period_years - 0.2408) < 0.002,
     `min_period_years = ${s.min_period_years}（水星 0.2408 年，用 vis-viva 从 t=0 状态算的）`);
  // 内核输出 samples+1 帧（含 t=0），相邻帧间隔 = years/samples → 每圈点数 = P*samples/years
  const expect = 0.24085 * 400 / 50;
  ok(Math.abs(s.points_per_orbit_min - expect) < 0.05,
     `points_per_orbit_min = ${s.points_per_orbit_min}（≈ ${expect.toFixed(2)}，就是页面该显示的画质读数）`);
  ok(s.suggested_samples === 4000 && s.samples_capped === true,
     `50 年跨度下"每圈 60 点"需要 ${s.suggested_samples} 个采样区间，已超上限 → samples_capped=${s.samples_capped}`);
  ok(Math.abs(s.suggested_years - (4000 * 0.24085 / 60)) < 0.05,
     `suggested_years = ${s.suggested_years}（在上限内能做到每圈 60 点的年数）`);
  ok(/vis-viva/.test(s.method || ''), 'sampling 里写明了标定方法（vis-viva）');
  // 帧数 = samples + 1（t=0 也一帧）；这条同时钉住"标定不改变实际输出"
  ok(r1.json.frames.length === 401,
     `帧数仍是 samples+1 = 401（标定不改变输出），实际 ${r1.json.frames.length}`);
  const pp = s.points_per_orbit_min;
  const measured = 360 / (() => {   // 用真实帧数据反算最内圈每圈点数，交叉验证内核给的那个数
    let mx = 0;
    for (let k = 1; k < r1.json.frames.length; k++) {
      const a = r1.json.frames[k - 1].p[1], c = r1.json.frames[k].p[1];
      const la = Math.hypot(a[0], a[1], a[2]), lc = Math.hypot(c[0], c[1], c[2]);
      const dot = (a[0] * c[0] + a[1] * c[1] + a[2] * c[2]) / (la * lc);
      mx = Math.max(mx, Math.acos(Math.min(1, Math.max(-1, dot))) * 180 / Math.PI);
    }
    return mx;
  })();
  ok(Math.abs(measured - pp) / pp < 0.12,
     `交叉验证：从真实帧数据反算最内圈每圈 ${measured.toFixed(2)} 点，内核标定给的是 ${pp}`);
}

// 跨场景一致性：figure8 无中心天体（三体等质量），"谁是主星"本身没定义
const r2 = run(['nbody', '--scenario', 'figure8', '--no-bio', '--samples', '50']);
const s2 = r2.json && r2.json.sampling;
ok(!!s2 && s2.min_period_years > 0,
   `figure8 也能给出 min_period_years = ${s2 && s2.min_period_years}（按最大质量天体为参考）`);
const r3 = run(['nbody', '--scenario', 'custom', '--solar', 'sun', '--body', 'Solo-only,3,0.1,0,0,0,0,1e-6',
                '--no-bio', '--samples', '50']);
const s3 = r3.json && r3.json.sampling;
ok(!!s3 && s3.min_period_years > 0,
   `只有一个环绕天体时也给出周期 = ${s3 && s3.min_period_years}`);

// ---- 4. 既有的 --samples 校验还在 ----
ok(run(['nbody', '--no-bio', '--samples', '1']).code === 2, '--samples 1 仍然拒绝');
ok(run(['nbody', '--no-bio', '--samples', '4001']).code === 2, '--samples 4001 仍然拒绝');

fs.writeFileSync(path.join(__dirname, '_probe_timearg.txt'),
  L.join('\n') + '\n\n[timearg] n=' + n + ' fail=' + fail + '\n', 'utf8');
process.exit(fail ? 1 : 0);
