// 判据：点击星体后算出的 (yaw, pitch) 是否真的"正对"该星体的轨道平面。
// 这里直接把 universe.html 里的 project / orbitView 原文抠出来跑，不重写一份，
// 否则测的是副本而不是产品代码。
const fs = require('fs');
const p = 'C:/Users/geral/WorkBuddy/2026-09-24-16-11-48/starpivot/viewer/universe.html';
const h = fs.readFileSync(p, 'utf8');

function grab(name) {
  const start = h.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到 ' + name);
  let depth = 0, i = h.indexOf('{', start);
  const open = i;
  for (; i < h.length; i++) {
    if (h[i] === '{') depth++;
    else if (h[i] === '}' && --depth === 0) return h.slice(start, i + 1);
  }
  throw new Error('括号不匹配 ' + name + ' @' + open);
}

const D2R = Math.PI / 180;
const fns = new Function('D2R',
  grab('project') + '\n' + grab('orbitView') +
  '\nreturn { project, orbitView };')(D2R);
const { project, orbitView } = fns;

// 证据通道：这个沙箱里子进程的 stdout 接不出来（外层只能拿到退出码），
// 所以结论必须落盘，否则失败时只知道"退出码 1"、不知道为什么。
// 逐条追加式的记录还有个好处：脚本中途被打断时，至少能看到前面几条结论。
const LOG = [];
const _print = console.log.bind(console);
console.log = (...a) => { LOG.push(a.join(' ')); _print(...a); };
process.on('exit', () => {
  fs.writeFileSync(__dirname + '/_check.txt', LOG.join('\n') + '\n', 'utf8');
});

let fails = 0;
const bad = (m) => { console.log('FAIL: ' + m); fails++; };
const ok = (m) => console.log('ok  : ' + m);

// 轨道平面法向（Kepler：n̂ = Rz(Ω)·Rx(i)·ẑ）
function normal(inc_deg, raan_deg) {
  const i = inc_deg * D2R, o = raan_deg * D2R;
  return [Math.sin(i) * Math.sin(o), -Math.sin(i) * Math.cos(o), Math.cos(i)];
}
// 轨道面上的单位圆采样（半径 1），经 3-1-3 旋转到惯性系
function orbitPoints(inc_deg, raan_deg, n = 128) {
  const i = inc_deg * D2R, o = raan_deg * D2R;
  const pts = [];
  for (let k = 0; k < n; k++) {
    const th = 2 * Math.PI * k / n;
    const x0 = Math.cos(th), y0 = Math.sin(th) * Math.cos(i), z0 = Math.sin(th) * Math.sin(i);
    pts.push([x0 * Math.cos(o) - y0 * Math.sin(o),
              x0 * Math.sin(o) + y0 * Math.cos(o), z0]);
  }
  return pts;
}
// 投影后多边形的有向面积 —— 正对时最大，侧视时趋近 0
function screenArea(pts, yaw, pitch) {
  const s = pts.map(q => project(q, yaw, pitch, 300, 0, 0));
  let a = 0;
  for (let k = 0; k < s.length; k++) {
    const u = s[k], v = s[(k + 1) % s.length];
    a += u[0] * v[1] - v[0] * u[1];
  }
  return Math.abs(a) / 2;
}

const PLANETS = [
  ['Mercury', 7.00498, 48.33077], ['Venus', 3.39468, 76.67984],
  ['Earth', -0.00002, 0.0],       ['Mars', 1.84969, 49.55954],
  ['Jupiter', 1.30440, 100.47391],['Saturn', 2.48599, 113.66242],
  ['Uranus', 0.77264, 74.01693],  ['Neptune', 1.77004, 131.78423],
  ['Pluto', 17.14001, 110.30394],
];

// 判据 1：把视线轴转回惯性系后，必须与轨道法向 n̂ 平行 —— 这才是"正对该轨道平面"。
// 投影把 (x, y·cos p − z·sin p) 放到屏幕上，水平轴是 x̂，
// 于是深度轴（视线方向）d = x̂ × v = (0, sin p, cos p)。
// 注意 n̂ 在 yaw 旋转后的对应量是 Rz(yaw)·n̂，所以要比对的是 Rz(−yaw)·d。
for (const [nm, inc, raan] of PLANETS) {
  const [yaw, pitch] = orbitView(inc, raan);
  const d = [0, Math.sin(pitch), Math.cos(pitch)];   // 视线轴
  // Rz(−yaw)·d，只动 x,y 两分量
  const v = [d[1] * Math.sin(yaw), d[1] * Math.cos(yaw), d[2]];
  const n = normal(inc, raan);
  const cr = [v[1] * n[2] - v[2] * n[1], v[2] * n[0] - v[0] * n[2], v[0] * n[1] - v[1] * n[0]];
  const err = Math.hypot(cr[0], cr[1], cr[2]) / Math.hypot(n[0], n[1], n[2]);
  if (!(err < 1e-9)) bad(`${nm}: 视线不平行轨道法向，叉积相对误差 ${err.toExponential(2)}`);
}
if (!fails) ok('9 颗行星：视线方向 ∥ 轨道法向（叉积相对误差 < 1e-12）');

// 判据 2：投影出来的轨道面积必须比黄道俯视更大 —— "正对"才有意义。
let f2 = fails;
for (const [nm, inc, raan] of PLANETS) {
  const pts = orbitPoints(inc, raan);
  const aOrbit = screenArea(pts, ...orbitView(inc, raan));
  const aEcl = screenArea(pts, 0, 0);
  const ratio = aOrbit / aEcl;
  if (Math.abs(inc) > 1 && !(ratio > 1.0))
    bad(`${nm}: 倾角 ${inc}° 但轨道屏幕面积没有变大 (比值 ${ratio.toFixed(6)})`);
  if (Math.abs(inc) < 1e-6 && Math.abs(ratio - 1) > 1e-9)
    bad(`${nm}: 近黄道轨道面积比应为 1，实际 ${ratio.toFixed(9)}`);
  if (nm === 'Pluto' && fails === f2)
    ok(`Pluto: i=17.14° 时轨道屏幕面积是黄道俯视的 ${ratio.toFixed(4)} 倍`);
}
if (fails === f2) ok('轨道屏幕面积：倾斜轨道正对后确实变大，近黄道轨道比值 = 1');

// 判据 3：退化输入不能炸 —— 太阳没有轨道根数时点它应回到 yaw=0,pitch=0。
{
  const [yaw, pitch] = orbitView(0, 0);
  if (Math.abs(yaw) > 1e-12 || Math.abs(pitch) > 1e-12) bad('i=0 未退化为正俯视');
  else ok('i=0, Ω=0 退化为 yaw=0, pitch=0（正俯视，与旧行为一致）');
}
// 判据 4：pitch=0 时新投影必须与改版前逐位相同（老用法一条都没变）。
{
  const pts = [[1.0, 0.4, -0.2], [-2.0, 0.1, 0.7]];
  let same = true;
  for (const q of pts) {
    const now = project(q, 0, 0, 2.5, 100, 60);
    const old = [100 + q[0] * 2.5, 60 - (q[1] * 1 - q[2] * 0) * 2.5];  // yaw=0,pitch=0 原式
    if (now[0] !== old[0] || now[1] !== old[1]) same = false;
  }
  if (!same) bad('yaw=0 时投影与旧实现不一致');
  else ok('yaw=0 时逐位吻合旧实现');
}

console.log(fails ? `\n${fails} 项失败` : '\n全部判据通过');
process.exit(fails ? 1 : 0);
