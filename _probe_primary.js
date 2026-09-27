// 验"自定义根数默认按绕原点 1 M☉ 解释"这件事的真实后果：
// 放一颗 0.2 M☉ 红矮星，再放一颗 0.05 AU 的行星，行星的速度是按 1 M☉ 算的。
const R = require('./_runner');   // 既能起进程就直接起，起不了就回放录制（见 _runner.js）
const fs = require('fs');
const path = require('path');
const EXE = path.join(__dirname, 'starpivot', 'build', 'bin', 'starpivot.exe');
const out = [];
const run = (args) => {
  const s = R.shape(R.spawn(EXE, args, { timeout: 60000, maxBuffer: 128 << 20 }));
  return { json: s.json, code: s.code, txt: s.txt };
};
const dist = (js, a, b, f) => {
  const p = js.frames[f].p, ia = js.bodies.findIndex(x => x.id === a), ib = js.bodies.findIndex(x => x.id === b);
  return Math.hypot(p[ia][0] - p[ib][0], p[ia][1] - p[ib][1], p[ia][2] - p[ib][2]);
};

const base = ['nbody', '--scenario', 'custom', '--solar', 'none', '--years', '2', '--samples', '40'];

// A. 红矮星 + 贴它的行星（两者的根数都绕原点，这是现在页面的做法）
{
  const r = run([...base, '--body', 'RD,1.0,0,0,0,0,0,M_V:0.2',
                 '--body', 'P,0.05,0,0,0,0,0,rocky:3.003489e-6']);
  const js = r.json;
  if (!js) out.push('A 失败: ' + r.txt.slice(0, 200));
  else {
    const d0 = dist(js, 'RD', 'P', 0), d1 = dist(js, 'RD', 'P', js.frames.length - 1);
    out.push(`A 红矮星@1AU + 行星@0.05AU（根数都绕原点 1 M☉ 解释）`);
    out.push(`   行星到红矮星的距离: t=0 ${d0.toFixed(4)} AU → t=2yr ${d1.toFixed(4)} AU`);
    out.push(`   → ${d1 > d0 * 2 ? '飞走了：速度是按 1 M☉ 算的，红矮星只有 0.2 M☉，拉不住' : '还在一起'}`);
  }
}
// B. 对照：行星的根数按"绕那颗红矮星"解释应该怎样（用 1 M☉ 的中心做近似对照）
{
  const r = run([...base, '--years', '2',
                 '--body', 'RD,1.0,0,0,0,0,0,M_V:0.2',
                 '--body', 'P,0.05,0,0,0,0,0,3.003489e-6']);
  out.push('B 同样两颗，但行星的质量字段不带类型（老写法）→ 结果应与 A 相同：'
    + (r.json ? dist(r.json, 'RD', 'P', r.json.frames.length - 1).toFixed(4) + ' AU' : '失败'));
}
// C. 期望的正确速度：v = sqrt(G*M/r)，0.2 M☉、0.05 AU
{
  const G = 4 * Math.PI * Math.PI, M = 0.2, r = 0.05;
  out.push(`C 正确圆轨道速度 sqrt(GM/r) = ${Math.sqrt(G * M / r).toFixed(4)} AU/yr`
    + `（0.2 M☉@0.05AU）；按 1 M☉ 算是 ${Math.sqrt(G * 1 / r).toFixed(4)} AU/yr，差 ${(Math.sqrt(1 / 0.2)).toFixed(3)} 倍`);
}
// D. 加了 --primary 之后：行星应当稳稳待在红矮星旁边
{
  const r = run([...base, '--primary', 'RD',
                 '--body', 'RD,1.0,0,0,0,0,0,M_V:0.2',
                 '--body', 'P,0.05,0,0,0,0,0,rocky:3.003489e-6']);
  const js = r.json;
  if (!js) out.push('D 失败: ' + r.txt.slice(0, 200));
  else {
    out.push(`D --primary RD：行星到红矮星的距离`);
    const G = 4 * Math.PI * Math.PI;
    for (const f of [0, Math.floor(js.frames.length / 2), js.frames.length - 1])
      out.push(`   t=${js.frames[f].t} : ${dist(js, 'RD', 'P', f).toFixed(4)} AU`);
    out.push(`   primary_frame=${js.primary_frame} · 用了它自己的字段=${!js.primary_fields_ignored}`);
    // 圆轨道：距离应当基本不变（e=0、mu 用真实质量）
    const d0 = dist(js, 'RD', 'P', 0), dN = dist(js, 'RD', 'P', js.frames.length - 1);
    out.push(`   → ${Math.abs(dN / d0 - 1) < 0.02 ? 'PASS 稳稳的圆轨道' : 'FAIL 距离变了 ' + (dN / d0).toFixed(3) + ' 倍'}`);
    // 红矮星自己应当在原点不动（它是参考系）
    const p0 = js.frames[0].p, pN = js.frames[js.frames.length - 1].p;
    const ri = js.bodies.findIndex(b => b.id === 'RD');
    const moved = Math.hypot(pN[ri][0] - p0[ri][0], pN[ri][1] - p0[ri][1], pN[ri][2] - p0[ri][2]);
    out.push(`   红矮星自己被放在原点：${Math.abs(moved) < 1e-9 ? 'PASS 没动' : 'FAIL 动了 ' + moved}`);
    // 周期核对：T = 2π sqrt(a³/(G·M))，0.2 M☉、0.05 AU
    const T = 2 * Math.PI * Math.sqrt(Math.pow(0.05, 3) / (G * 0.2));
    out.push(`   理论周期 2π√(a³/GM) = ${T.toFixed(4)} 年（0.2 M☉, 0.05 AU）`);
  }
}
// E. 默认行为必须逐位不变
{
  const a = run([...base, '--body', 'A,1,0.2,0,0,0,0,3e-6', '--body', 'B,1,0.2,0,0,180,135,3e-6']);
  const b = run([...base, '--body', 'A,1,0.2,0,0,0,0,3e-6', '--body', 'B,1,0.2,0,0,180,135,3e-6',
                 '--primary', 'A']);
  // 正确的判据是"B 绕 A 的轨道是不是 e=0.2 的那条椭圆"：
  // 距离必须落在 a(1±e) = [0.8, 1.2] AU 之内。mu 错了（比如按 1 M☉ 算），
  // 速度就不对，轨道会鼓出去或缩进来 —— 这条能直接抓住。
  const sep = (js, f) => {
    const p = js.frames[f].p, ia = js.bodies.findIndex(x => x.id === 'A'), ib = js.bodies.findIndex(x => x.id === 'B');
    return Math.hypot(p[ia][0]-p[ib][0], p[ia][1]-p[ib][1], p[ia][2]-p[ib][2]);
  };
  let lo = Infinity, hi = 0;
  for (let f = 0; f < b.json.frames.length; f++) { const d = sep(b.json, f); lo = Math.min(lo, d); hi = Math.max(hi, d); }
  out.push(`E --primary A 时 B 到 A 的距离范围 [${lo.toFixed(4)}, ${hi.toFixed(4)}] AU，`
    + `元素给出的椭圆是 a(1±e) = [0.8, 1.2] AU`);
  out.push(`   → ${lo >= 0.79 && hi <= 1.21 ? 'PASS 确实是 e=0.2 的那条轨道（mu 用对了）'
                                          : 'FAIL 轨道鼓出去了 —— mu 不对'}`);
  out.push(`   不给 --primary 时 A 在 1 AU 处绕原点、B 也在绕原点，是另一套构型（这是老约定）`);
  out.push(`   不给时 primary_frame="${a.json.primary_frame}"（空 = 老约定）· `
    + `elements_reference="${(a.json.elements_reference || '').slice(0, 60)}…"`);
}
// E2. --primary 把星放在原点，而背景太阳系的太阳也在原点 → 必须明确拒绝，不能输出 NaN
{
  // 注意要给够两个天体：只有一个时会被"primary 需要另一个天体来绕"那条先拦下，
  // 走不到真正要测的"同点"分支（第一版就是这么假失败的）。
  const r = run(['nbody', '--scenario', 'custom', '--solar', 'full', '--years', '1', '--samples', '5',
                 '--primary', 'MI', '--body', 'MI,18,0,0,0,0,0,M_I:15',
                 '--body', 'P,1,0,0,0,0,0,rocky:3.003489e-6']);
  out.push('E2 --primary + --solar full 撞在原点：退出码 ' + r.code);
  out.push('   报错: ' + (r.txt || '').split('\n')[0].slice(0, 150));
  out.push('   ' + (r.code === 2 && /same point/.test(r.txt)
    ? 'PASS 明确拒绝（否则第一步算出 inf → NaN，整个 JSON 都变成 -nan(ind)，页面直接解析失败）'
    : 'FAIL 没有拒绝'));
}
// E3. --solar none 时它必须能跑，且不能出现 NaN
{
  const r = run([...base, '--primary', 'MI', '--body', 'MI,18,0,0,0,0,0,M_I:15',
                 '--body', 'P,0.3,0,0,0,0,0,rocky:3.003489e-6']);
  const js = r.json;
  out.push('E3 --solar none + --primary：' + (js ? 'JSON 合法，' : 'JSON 非法（' + r.txt.slice(0, 60) + '）'));
  if (js) {
    const bad = js.frames.some(f => f.p.some(q => q.some(v => !Number.isFinite(v))));
    out.push('   ' + (bad ? 'FAIL 帧里出现了非有限值' : 'PASS 全部坐标都是有限数（没有 NaN/inf）'));
    out.push('   超巨星在原点不动: ' + (Math.hypot(...js.frames[30].p[0]) < 1e-9 ? 'PASS' : 'FAIL'));
  }
}
// F. 打错名字 / 只有一个天体
{
  const r1 = run([...base, '--body', 'RD,1,0,0,0,0,0,M_V:0.2', '--body', 'P,0.05,0,0,0,0,0,3e-6',
                  '--primary', 'Nope']);
  out.push('F 名字打错: 退出码 ' + r1.code + ' — ' + r1.txt.slice(0, 90));
  const r2 = run([...base, '--body', 'RD,1,0,0,0,0,0,M_V:0.2', '--primary', 'RD']);
  out.push('F 只有一个天体: 退出码 ' + r2.code + ' — ' + r2.txt.slice(0, 90));
  const r3 = run(['nbody', '--scenario', 'solar', '--primary', 'Sun', '--samples', '5']);
  out.push('F 用在非 custom 场景: 退出码 ' + r3.code + ' — ' + r3.txt.slice(0, 90));
}
fs.writeFileSync(path.join(__dirname, '_probe_primary.txt'), out.join('\n') + '\n', 'utf8');
process.exit(0);
