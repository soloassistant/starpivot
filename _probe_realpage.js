// 判据：真实系外行星从**数据文件**走到**页面上**、再走到**内核**的整条链。
//
// 为什么这条判据必须存在（而不是"内核那条已经验过了"）：
//   前面的判据验的是"数据 → 内核"。可页面上还有两段自己的代码 ——
//   sanitizeBody（读回来的东西怎么收口）和 payloadBody / bodySpec（发出去的消息长什么样）。
//   这两段里漏一个字段、错一个单位，内核侧全绿而屏幕上就是错的。
//   而且它们两边都"能跑"：没有报错、没有断言，只是数不一样。
//
//   本判据第一轮就抓到了三个真问题（都不是新代码引入的，是本来就在的）：
//     1. sanitizeBody 的类型字符类是 [a-z_]，而内核 39 个类型键里有 21 个带大写
//        （O_V / M_V / WR / G_III / M_0…）→ 光谱型的星一经过它就被静默降级成
//        "没声明类型"，半径落回页面默认的 6371 km：一颗太阳被画成地球那么大。
//     2. 预设不复位碰撞设置 → 玩完「行星撞地球」再点「真实：TRAPPIST-1」，
//        450× 的半径缩放会跟着过去，真实行星在你眼前被撞碎。
//     3. 容差：JSON 用 %.6g 打印，最坏相对量化误差是 5e-6，而手头那组数恰好落在
//        好数上，于是 2e-6 一直"通过"。换成 1.7e4 km 量级就误报了 ——
//        容差必须按最坏情况定，不能按手头这组数定。
//
// 四层：
//   A 抠出来的页面函数是不是真的（函数改名/抠错必须立刻炸，不能静默变成"没测"）
//   B 页面建出来的预设与数据文件逐项一致（页面的解读没错）
//   C sanitizeBody / payloadBody / bodySpec 的边界行为（"没给"不能变成"给了 0"）
//   D bodySpec 与 payloadBody 互为往返（复制出去的那行命令 = 屏幕上这次计算）
//   E 页面真正会发的 payload 走**真网关**打到**真内核**：与数据文件对账 + 对照组
const fs = require('fs');
const { execFileSync } = require('child_process');   // 只在 D 的说明里提到，不用于执行

const R = 'C:/Users/geral/WorkBuddy/2026-09-24-16-11-48';
const HTML = R + '/starpivot/viewer/universe.html';
const DATA = R + '/starpivot/data/real_exoplanets.json';
const BASE = process.env.STARPIVOT_BASE || 'http://127.0.0.1:8765';

// 证据通道：这个沙箱里子进程的 stdout 接不出来（外层只能拿到退出码），
// 所以结论必须落盘。逐条追加式的记录还有个好处：中途被打断也能看到前面的结论。
const LOG = [];
const _print = console.log.bind(console);
console.log = (...a) => { LOG.push(a.join(' ')); _print(...a); };
process.on('exit', () => {
  fs.writeFileSync(__dirname + '/_probe_realpage.txt', LOG.join('\n') + '\n', 'utf8');
});

let fails = 0, n = 0;
const check = (name, ok, detail) => {
  n++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : (detail ? ('   ' + detail) : '')));
  if (!ok) fails++;
};

const h = fs.readFileSync(HTML, 'utf8');
const ds = JSON.parse(fs.readFileSync(DATA, 'utf8'));

// ===========================================================================
console.log('='.repeat(76));
console.log('A. 从 universe.html 里抠出真正会跑的那几段（不是重写一份副本）');

function decl(src, name) {
  const fnStart = src.indexOf('function ' + name + '(');
  const varStart = src.indexOf('const ' + name + ' =');
  const start = fnStart >= 0 ? fnStart : varStart;
  if (start < 0) throw new Error('抠不到声明：' + name);
  let i = src.indexOf('{', start);
  if (i < 0) throw new Error(name + ' 没有函数体（是不是被改成了单表达式箭头函数？）');
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1) + ';';
  }
  throw new Error(name + ' 的括号不匹配');
}

const WANT = ['numOr', 'numOpt', 'sanitizeBody', 'realSystemPresets',
              'bodySpec', 'payloadBody'];
const byName = {};
let grabErr = '';
for (const n of WANT) {
  try { byName[n] = decl(h, n); }
  catch (e) { grabErr += '[' + n + ': ' + e.message + ']'; }
}
check('6 段页面函数全部抠到', !grabErr, grabErr);
if (grabErr) { console.log('\n（抠不到就别往下跑了：跑的会是空壳）'); process.exit(1); }

// 抠到了，还得确认抠出来的**是它**。函数改名后 indexOf 可能命中别的同名片段，
// 那样拿到的是别的东西而脚本照样"通过" —— 所以查几个只该出现在它里面的关键字。
const SIGNS = {
  numOpt: ['undefined', 'isFinite'],
  sanitizeBody: ['teff_K', 'lum_lsun', 'radius_km', 'numOpt'],
  // '假设' 也在这一串里：真实系统预设**必须**说明"哪些是观测、哪些是我们假设的"
  // （轨道朝向与相位数据里没有 → 共面 + 同相位；质量性质随方法而异 → 不当精确值）。
  // 把它钉在关键字上，是为了让"哪天有人顺手把这句删了"变成一条会红的判据，
  // 而不是一句悄悄消失的说明。
  realSystemPresets: ['conversions', 'M_jup_to_Msun', 'R_sun_to_km', 'pl_orbeccen', '假设'],
  bodySpec: ['teff_K=', 'lum_lsun=', 'radius_given'],
  payloadBody: ['teff_K', 'lum_lsun', 'radius_given'],
};
const signBad = [];
for (const [n, keys] of Object.entries(SIGNS))
  keys.forEach(k => { if (!byName[n].includes(k)) signBad.push(n + ' 缺 ' + k); });
check('抠出来的每一段都带着它该有的关键字（防"抠到了别的东西"）',
      signBad.length === 0, signBad.join('; '));
// 抠出来的 sanitizeBody 必须带着"接受大写"的新字符类 —— 这正是被修的那个 bug。
check('抠出来的 sanitizeBody 的类型字符类包含大写字母（bug 回归线）',
      /A-Z/.test(byName.sanitizeBody), '字符类里没看到 A-Z');

const fns = new Function(WANT.map(n => byName[n]).join('\n') +
  '\nreturn { numOr, numOpt, sanitizeBody, realSystemPresets, bodySpec, payloadBody };')();
const { sanitizeBody, realSystemPresets, bodySpec, payloadBody } = fns;
console.log('    ' + byName.realSystemPresets.split('\n').length + ' 行 realSystemPresets、'
  + byName.payloadBody.split('\n').length + ' 行 payloadBody 直接来自页面');

// ===========================================================================
console.log('='.repeat(76));
console.log('B. 页面建出来的预设与 data/real_exoplanets.json 逐项对账');

const cv = ds.conversions;
const Mj = cv.M_jup_to_Msun, Re = cv.R_earth_to_km, Rs = cv.R_sun_to_km;
// %.6g 的**最坏**相对量化误差：0.5e-5 / mantissa，mantissa ∈ [1,10) → 5e-6。
// 按最坏情况定，不按手头这组数定 —— 手头这组碰巧是好数就测不出真错。
const JSON_REL = 6e-6;
const presets = realSystemPresets(ds);
check('5 个系统各建出一组预设', presets.length === ds.systems.length,
      presets.length + ' 组 vs 数据里 ' + ds.systems.length + ' 个');
check('每组都带"真实："前缀，场景 custom + 不放太阳系',
      presets.every(p => p.label.startsWith('真实：') && p.scenario === 'custom'
                         && p.solarmode === 'none'),
      presets.map(p => p.label).join(' / '));
check('每组都显式把宿主当参考系（宿主质量不是 1 M☉，不能用日心约定）',
      presets.every(p => p.primary === p.bodies[0].name && p.bodies[0].name.length > 0),
      presets.map(p => p.primary).join(' / '));
check('宿主都**不声明类型**（数据里没有光谱型，套一个类型名就是替用户编分类）',
      presets.every(p => p.bodies[0].type === undefined),
      'type=' + JSON.stringify(presets.map(p => p.bodies[0].type)));

// ---- "哪些是观测、哪些是我们假设的" ----
// Archive 的这张表只给 a / e / 周期 / 质量 / 半径，**没有**轨道朝向与相位。
// 也就是说：三维初始状态不是观测出来的，是页面自己摆的。这本身不是问题
// （数据里没有的东西不能编），问题在于不能让用户以为"全部用观测值"。
// 所以下面三条把"我们假设了什么"钉成可检查的事实：
//   ① 假设的值本身（四个角全 0 = 共面 + 同相位）；
//   ② 说明文字必须把这件事讲出来；
//   ③ 质量那一列的性质必须讲出来（视向速度给 m·sin i 下限、凌星计时给拟合质量）。
const ANG = ['inc', 'raan', 'argp', 'M0'];
const angSet = [];
presets.forEach(p => p.bodies.slice(1).forEach(b => {
  ANG.forEach(k => { if (b[k] !== 0) angSet.push(b.name + '.' + k + '=' + b[k]); });
}));
check('行星的轨道朝向与相位是页面假设（四个角全 0 = 共面 + 同相位），不是观测值',
      angSet.length === 0, angSet.slice(0, 4).join('; '));
check('每组预设的说明都写明"轨道朝向与相位是假设、不是观测"',
      presets.every(p => /假设/.test(p.note) && /共面/.test(p.note)),
      presets.filter(p => !/假设/.test(p.note) || !/共面/.test(p.note))
             .map(p => p.label).join(' / '));
check('每组预设的说明都写明质量性质随探测方法而异（不当作精确测量值）',
      presets.every(p => /m·sin i/.test(p.note) && /方法/.test(p.note)),
      presets.filter(p => !/m·sin i/.test(p.note)).map(p => p.label).join(' / '));

const rel = (x, y) => Math.abs(x - y) / Math.abs(y);
const badB = [];
presets.forEach(p => {
  const s = ds.systems.find(x => x.hostname === p.primary);
  const host = p.bodies[0];
  if (rel(host.mass, s.star.st_mass) > JSON_REL) badB.push(s.hostname + ' 宿主质量');
  if (rel(host.radius_km, s.star.st_rad * Rs) > JSON_REL) badB.push(s.hostname + ' 宿主半径');
  if (rel(host.teff_K, s.star.st_teff) > JSON_REL) badB.push(s.hostname + ' 宿主温度');
  if (host.lum_lsun !== undefined) badB.push(s.hostname + ' 宿主不该自带 L（应由内核推）');
  const full = (s.planets || []).filter(q => q.pl_orbsmax !== null && q.pl_orbeccen !== null
    && q.pl_bmassj !== null && q.pl_rade !== null);
  const dropped = (s.planets || []).length - full.length;
  if (p.bodies.length - 1 !== full.length)
    badB.push(s.hostname + ' 行星数 ' + (p.bodies.length - 1) + ' ≠ 完整项 ' + full.length);
  full.forEach(q => {
    const b = p.bodies.find(x => x.name === q.name);
    if (!b) { badB.push(s.hostname + ' 缺 ' + q.name); return; }
    if (rel(b.a, q.pl_orbsmax) > JSON_REL) badB.push(q.name + ' a');
    if (rel(b.e, q.pl_orbeccen) > JSON_REL) badB.push(q.name + ' e');
    if (rel(b.mass, q.pl_bmassj * Mj) > JSON_REL) badB.push(q.name + ' 质量');
    if (rel(b.radius_km, q.pl_rade * Re) > JSON_REL) badB.push(q.name + ' 半径');
  });
  if (dropped) console.log('    ' + s.hostname + '：有 ' + dropped
    + ' 颗因观测缺项被排除（缺项不补零），预设里如实少这几颗');
});
check('宿主与全部行星的 a/e/质量/半径都与数据文件一致（用文件里那份换算因子）',
      badB.length === 0, badB.slice(0, 6).join('; '));

const troi = presets.find(p => p.primary === 'TOI-178');
check('TOI-178 的预设里没有缺偏心率的 b（排除，而不是给它 e=0）',
      troi && !troi.bodies.some(b => b.name === 'TOI-178 b')
      && troi.bodies.some(b => b.name === 'TOI-178 c'),
      troi ? ((troi.bodies.length - 1) + ' 颗：'
        + troi.bodies.slice(1).map(b => b.name.replace('TOI-178 ', '')).join(',')) : '缺 TOI-178');
const trp = presets.find(p => p.primary === 'TRAPPIST-1');
check('TRAPPIST-1 的预设是 7 颗行星（全部完整项）',
      trp && trp.bodies.length === 8, trp ? (trp.bodies.length - 1) + ' 颗' : '缺 TRAPPIST-1');

// ===========================================================================
console.log('='.repeat(76));
console.log('C. "没给" 与 "给了 0" 必须区分开 —— 这是整条链上最容易悄悄出错的地方');

const host0 = sanitizeBody({ name: 'TRAPPIST-1', mass: 0.0898,
                             radius_km: 0.1192 * Rs, teff_K: 2566 });
check('sanitizeBody：没给 L 就不带上 L 这个字段（undefined ≠ 0）',
      !('lum_lsun' in host0) && host0.teff_K === 2566 && host0.type === '',
      JSON.stringify(host0));
check('sanitizeBody：给 0 就是 0（0 K 是一个"值"，不是"缺失"）',
      sanitizeBody({ name: 'S', mass: 0.1, teff_K: 0 }).teff_K === 0,
      'teff_K=' + JSON.stringify(sanitizeBody({ name: 'S', mass: 0.1, teff_K: 0 }).teff_K));

// 类型键：内核 39 个键里有 21 个带大写。这一条是 bug 回归线。
const KEYS = ['O_V', 'B_V', 'A_V', 'F_V', 'G_V', 'K_V', 'M_V', 'WR', 'G_III', 'K_III',
              'M_III', 'B_II', 'K_II', 'O_I', 'B_I', 'A_I', 'G_I', 'K_I', 'M_I', 'M_0', 'B_0',
              'carbon', 'sd', 'subgiant', 'pre_main', 'white_dwarf', 'neutron_star',
              'black_hole', 'cepheid', 'rr_lyrae', 'mira', 'pulsar', 'magnetar',
              'metal_poor', 'brown_dwarf', 'rocky', 'super_earth', 'ice_giant', 'gas_giant'];
const lostKeys = KEYS.filter(k => sanitizeBody({ name: 'x', mass: 1, type: k }).type !== k);
check('sanitizeBody 保留全部 39 个类型键（含 21 个带大写的）', lostKeys.length === 0,
      '被丢掉的：' + lostKeys.join(', '));
// 反面：会破坏 name:type,mass 语法的字符必须被挡住，不能漏到 --body 里去。
const badKeys = ['a,b', 'a b', 'a:b', 'a=b', '', 'x'.repeat(33), 'a-b', 'ty"pe'];
const letThrough = badKeys.filter(k => sanitizeBody({ name: 'x', mass: 1, type: k }).type !== '');
check('sanitizeBody 挡住会破坏 --body 语法的类型名（逗号/空格/冒号/等号/超长…）',
      letThrough.length === 0, '漏过：' + JSON.stringify(letThrough));

const typedNoR = sanitizeBody({ name: 'S', type: 'M_V', mass: 0.09 });
check('sanitizeBody：声明了类型、又没给半径 → 不带半径（交给内核按类型推）',
      !('radius_km' in typedNoR), JSON.stringify(typedNoR));
check('sanitizeBody：声明了类型、但给了半径 → 半径留着（那是这一颗星的观测半径）',
      sanitizeBody({ name: 'S', type: 'M_V', mass: 0.09, radius_km: 83003.7 })
        .radius_km === 83003.7, '');
check('sanitizeBody：没声明类型 → 半径必须有，落到页面约定值 6371',
      sanitizeBody({ name: 'P', mass: 3e-6 }).radius_km === 6371, '');

const pb = payloadBody(host0);
check('payloadBody：半径带上 radius_given（告诉网关"这个数是我给的观测值"）',
      pb.radius_km === host0.radius_km && pb.radius_given === true,
      'radius_given=' + pb.radius_given);
check('payloadBody：没类型的宿主不发 type 字段（不是发空串）',
      pb.type === undefined, 'type=' + JSON.stringify(pb.type));
check('payloadBody：行星不带观测字段（它们本来就没有）',
      !('teff_K' in payloadBody({ name: 'p', a: 1, e: 0, inc: 0, mass: 3e-6, radius_km: 6371 })), '');

const spec1 = bodySpec(pb);
check('bodySpec：无类型宿主 → 第 8 字段裸质量、第 9 字段半径、之后 teff_K=（与内核语法一致）',
      /^TRAPPIST-1,1,0,0,0,0,0,0\.0898,83003\.7\d*,teff_K=2566$/.test(spec1), spec1);
const noTypeNoR = { name: 'S', a: 1, e: 0, inc: 0, raan: 0, argp: 0, M0: 0, mass: 0.09, type: 'M_V' };
check('bodySpec：声明了类型但不带 radius_given → 半径那一格不下发（内核自己推）',
      bodySpec(noTypeNoR) === 'S,1,0,0,0,0,0,M_V:0.09', bodySpec(noTypeNoR));
const withR = Object.assign({}, noTypeNoR, { radius_km: 83003.7, radius_given: true });
check('bodySpec：带 radius_given 的声明类型天体 → 半径照发（观测优先于模型）',
      bodySpec(withR) === 'S,1,0,0,0,0,0,M_V:0.09,83003.7', bodySpec(withR));

// ===========================================================================
console.log('='.repeat(76));
console.log('D. bodySpec 与 payloadBody 互为往返：复制走的那行命令 = 屏幕上这次计算');

// 这一段**不能**用真内核来跑：本沙箱里 Node 起不了任何子进程
// （execFileSync 连 `cmd /c echo` 都是 EBUSY，而 bash 里同一个 exe 跑得好好的）。
// 所以这里改验一条等价但自足的性质：把 bodySpec 的输出**按内核的语法解析回来**，
// 应当逐字段等于喂进去的 payload。解析器就是内核 parse_custom_body 的那几条规则：
//   8 个定字段；fields[8] 不带 '=' 就是半径；其余都是 key=value。
// 而"这些字面串内核真的收"由 _probe_obsstar.py 的 H/I/J 三节覆盖
// （那边用同一个语法手拼同样的串，打的是真内核）。
function parseSpec(s) {
  const f = s.split(',');
  const o = { name: f[0], a: +f[1], e: +f[2], inc: +f[3], raan: +f[4],
              argp: +f[5], M0: +f[6] };
  const m = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(f[7]);
  if (m) { o.type = m[1]; o.mass = +m[2]; } else { o.mass = +f[7]; }
  let k = 8;
  if (f.length > 8 && f[8].indexOf('=') < 0) { o.radius_km = +f[8]; k = 9; }
  for (; k < f.length; k++) {
    const i = f[k].indexOf('=');
    o[f[k].slice(0, i)] = +f[k].slice(i + 1);
  }
  return o;
}
let rtBad = [];
presets.forEach(p => p.bodies.forEach(b => {
  const want = payloadBody(b);
  const got = parseSpec(bodySpec(want));
  const bad = [];
  ['name', 'a', 'e', 'inc', 'raan', 'argp', 'M0', 'mass'].forEach(kk => {
    if (got[kk] !== want[kk]) bad.push(kk + ' ' + got[kk] + '≠' + want[kk]);
  });
  if ((got.type || undefined) !== want.type) bad.push('type ' + got.type + '≠' + want.type);
  if ((got.radius_km) !== want.radius_km) bad.push('radius ' + got.radius_km + '≠' + want.radius_km);
  if ((got.teff_K) !== want.teff_K) bad.push('teff_K ' + got.teff_K + '≠' + want.teff_K);
  if ((got.lum_lsun) !== want.lum_lsun) bad.push('lum ' + got.lum_lsun + '≠' + want.lum_lsun);
  // radius_given 是页面内部的标记，不进 --body 语法；它的作用体现在"半径有没有出现"上。
  const wantRadiusOut = want.radius_km !== undefined
    && (want.type === undefined || want.radius_given === true);
  if (wantRadiusOut !== (want.radius_km !== undefined && 'radius_km' in got))
    bad.push('半径该不该下发对不上');
  if (bad.length) rtBad.push(b.name + ': ' + bad.join(', '));
}));
check('全部 ' + presets.reduce((n, p) => n + p.bodies.length, 0)
      + ' 个天体的 --body 串都能解析回原 payload（逐字段相等）',
      rtBad.length === 0, rtBad.slice(0, 4).join('; '));
check('往返里确实有半径、也确实有 teff_K（不是"两边都空所以相等"）', (() => {
  let withR = 0, withT = 0;
  presets.forEach(p => p.bodies.forEach(b => {
    const s = bodySpec(payloadBody(b));
    if (/^[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,([^,]*),[^,]*/.test(s)
        && s.split(',').length > 8) withR++;
    if (s.includes('teff_K=')) withT++;
  }));
  console.log('    ' + withR + ' 个带半径字段、' + withT + ' 个带 teff_K=，'
    + presets.reduce((n, p) => n + p.bodies.length, 0) + ' 个天体总数');
  return withR > 0 && withT === presets.length;   // 5 个宿主都该带 teff_K
})(), '宿主数 ' + presets.length);

// ===========================================================================
console.log('='.repeat(76));
console.log('E. 同一份 payload 走真网关（HTTP）—— 覆盖网关的 teff_K / lum_lsun / radius 转发');

(async () => {
  let alive = false;
  try { alive = (await fetch(BASE + '/api/health')).ok; } catch (e) { alive = false; }
  if (!alive) {
    // 服务没起时**不算失败**：A~D 节（页面函数、数据文件、payload 形态）都是自足的，
    // 已经跑完并落盘。E 节缺席要显式说出来，并且用退出码 2 区别于"通过"和"失败" ——
    // 让 _verify_all.ps1 把它记成 skip。安静跳过等于假绿，这是本仓库的规矩。
    console.log('SKIP  E. 网关链路未验证：' + BASE + ' 上没有服务'
      + '（先跑 tools/webapp.py --port 8765 再重跑本判据）');
    console.log('');
    console.log(fails
      ? ('FAILED: ' + fails + ' 项未通过')
      : ('A~D 节全过（页面函数 / 数据对账 / 边界 / 往返），E 节因服务缺席未验证'
         + ' —— 不要当作全绿。'));
    process.exit(fails ? 1 : 2);
  }
  check('本地服务在跑（' + BASE + '）', alive, '');

  // 陈旧进程陷阱：8765 上可能还留着上一轮起的 webapp，它不知道 /api/dataset，
  // 于是后面所有判据"正确地"失败 —— 失败的是进程太旧，不是代码。
  // 所以先问一次数据接口，把这种情况直接点名出来。
  let dsOK = false;
  try { dsOK = (await fetch(BASE + '/api/dataset/real_exoplanets')).ok; } catch (e) { dsOK = false; }
  check('网关认得 /api/dataset（不认得 = 8765 上是个陈旧进程，先重启它）', dsOK,
        dsOK ? '' : '重启 webapp 后重跑本判据');
  if (dsOK) {
    const dsBody = await (await fetch(BASE + '/api/dataset/real_exoplanets')).json();
    check('网关转发的数据文件与磁盘上的逐字段一致',
          JSON.stringify(dsBody) === JSON.stringify(ds), '');
    check('网关拒绝不存在的数据集（负路径）',
          (await fetch(BASE + '/api/dataset/no_such_thing')).status === 404, '');
  }

  function pagePayload(p) {
    return { scenario: 'custom', solar: 'none', integrator: 'leapfrog',
             years: Math.min(60, p.years), samples: 120,
             primary: p.primary, bodies: p.bodies.map(payloadBody) };
  }
  async function post(pl) {
    const r = await fetch(BASE + '/api/nbody', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pl) });
    return { status: r.status, js: await r.json() };
  }

  // 顺手拿一次内核的类型表，把"页面的类型收口"与"内核真实的 39 个键"钉在一起 ——
  // 上面 C 节那份硬编码的 KEYS 若是抄错的，这条会指出来。
  const probe = await post({ scenario: 'custom', solar: 'none', years: 1, samples: 3,
                             bodies: [{ name: 'P', a: 1, e: 0, inc: 0, mass: 3e-6 }] });
  const kernelKeys = (probe.js.body_types || []).map(t => t.key);
  check('拿到内核回显的类型表（' + kernelKeys.length + ' 个键）', kernelKeys.length > 0, '');
  const lostK = kernelKeys.filter(k => sanitizeBody({ name: 'x', mass: 1, type: k }).type !== k);
  check('sanitizeBody 保留内核**实际**的每一个类型键（不信 C 节那份手抄表）',
        kernelKeys.length > 0 && lostK.length === 0, '丢掉的：' + lostK.join(', '));
  const missingInC = kernelKeys.filter(k => !KEYS.includes(k));
  check('C 节那份类型键表与内核一致（手抄表没抄漏）', missingInC.length === 0,
        'C 节漏了：' + missingInC.join(', '));

  function audit(hostname, js, tag) {
    const s = ds.systems.find(x => x.hostname === hostname);
    const bodies = js.bodies || [];
    const host = bodies.find(b => b.id === hostname);
    const bad = [];
    if (!host) bad.push('宿主体不在回显里');
    else {
      if (host.t_eff_src !== 'given') bad.push('宿主 T 来源 ' + host.t_eff_src);
      if (rel(host.t_eff_K, s.star.st_teff) > JSON_REL) bad.push('宿主 T 值');
      if (host.luminosity_src !== 'derived_from_radius_and_t_eff')
        bad.push('宿主 L 来源 ' + host.luminosity_src);
      // SI 独立复算：L = 4πR²σT⁴ / Lsun（不走内核那条 (R/Rsun)²(T/Tsun)⁴ 的归一化）
      const SIG = 5.670374419e-8, L_SUN = 3.828e26;
      const lSi = 4 * Math.PI * (host.radius_km * 1000) ** 2 * SIG * host.t_eff_K ** 4 / L_SUN;
      const dev = Math.abs(host.luminosity_Lsun - lSi) / lSi;
      if (dev > 0.02) bad.push('宿主 L 与 SI 复算差 ' + (dev * 100).toFixed(2) + '%');
      if (host.emits_light !== true) bad.push('宿主被判成不发光');
      if (rel(host.radius_km, s.star.st_rad * Rs) > JSON_REL) bad.push('宿主半径');
    }
    const full = (s.planets || []).filter(q => q.pl_orbsmax !== null && q.pl_orbeccen !== null
      && q.pl_bmassj !== null && q.pl_rade !== null);
    full.forEach(q => {
      const b = bodies.find(x => x.id === q.name);
      if (!b) { bad.push('缺 ' + q.name); return; }
      if (rel(b.ic_heliocentric.a_AU, q.pl_orbsmax) > JSON_REL) bad.push(q.name + ' a');
      if (Math.abs(b.ic_heliocentric.e - q.pl_orbeccen) > JSON_REL) bad.push(q.name + ' e');
      if (rel(b.mass_msun, q.pl_bmassj * Mj) > JSON_REL) bad.push(q.name + ' 质量');
      if (rel(b.radius_km, q.pl_rade * Re) > JSON_REL) bad.push(q.name + ' 半径');
    });
    if (bodies.length !== full.length + 1)
      bad.push('天体数 ' + bodies.length + ' ≠ ' + (full.length + 1));
    check(hostname + '：经网关 → 内核 的回显与数据文件全部对上', bad.length === 0,
          bad.slice(0, 5).join('; '));
    return !bad.length;
  }

  const observedL = {};
  for (const p of presets) {
    const pl = pagePayload(p);
    let r;
    try { r = await post(pl); }
    catch (e) { check(p.primary + '：网关 → 内核 能跑通', false, String(e).slice(0, 140)); continue; }
    if (r.status !== 200) {
      check(p.primary + '：网关 → 内核 能跑通', false,
            'HTTP ' + r.status + ' ' + JSON.stringify(r.js).slice(0, 160));
      continue;
    }
    check(p.primary + '：经网关回显里带着宿主的两项来源标记'
          + '（网关没把 teff_K= / radius 吃掉）',
          r.js.bodies[0] && r.js.bodies[0].t_eff_src === 'given'
          && r.js.bodies[0].luminosity_src === 'derived_from_radius_and_t_eff',
          r.js.bodies[0] ? ('T=' + r.js.bodies[0].t_eff_src
                            + ' L=' + r.js.bodies[0].luminosity_src) : '');
    if (audit(p.primary, r.js, 'http'))
      observedL[p.primary] = r.js.bodies.find(b => b.id === p.primary).luminosity_Lsun;

    // 对照组：把宿主的两个观测字段摘掉再发一次。如果网关**根本没转发**这两个字段，
    // 上面那条"来源标成 given"就不会成立；而这条对照把"转发是起作用的"量化出来 ——
    // 两者必须不同，且差异应是模型与观测的真实差距，不是排版差异。
    const ctrl = pagePayload(p);
    const cb = ctrl.bodies[0];
    delete cb.teff_K;
    delete cb.lum_lsun;
    delete cb.radius_given;   // 半径也一并摘掉：这才是"只知道质量"的对照组
    const rc = await post(ctrl);
    if (rc.status === 200) {
      const ch = rc.js.bodies.find(b => b.id === p.primary);
      check(p.primary + ' 对照组（摘掉观测值）：来源必须退回模型，'
            + '否则说明观测字段其实没生效',
            ch && ch.t_eff_src !== 'given'
            && ch.luminosity_src !== 'derived_from_radius_and_t_eff',
            ch ? ('T_src=' + ch.t_eff_src + ' L_src=' + ch.luminosity_src) : '');
      if (observedL[p.primary] && ch && ch.luminosity_Lsun > 0) {
        const ratio = observedL[p.primary] / ch.luminosity_Lsun;
        console.log('    ' + p.primary + '：观测 L=' + observedL[p.primary].toPrecision(4)
          + ' vs 模型 L=' + ch.luminosity_Lsun.toPrecision(4)
          + '（差 ' + ratio.toFixed(2) + ' 倍）');
      }
    } else {
      check(p.primary + ' 对照组能跑通', false, 'HTTP ' + rc.status);
    }
  }

  console.log('');
  console.log(fails ? ('FAILED: ' + fails + ' 项未通过')
    : ('全部通过：数据文件 → 页面函数 → 网关 → 内核，每一步都对上了账'
       + '（' + presets.length + ' 个真实系统 + 对照组）。'));
  // 自报项数：文档里那句"X 项"应当取自探针自己的输出，而不是有人去数 PASS 行 ——
  // 数出来的数不跟着代码走，它只会在某次加判据之后静静过期（"39 项"就是这么来的，
  // 而真实项数已经是 47）。
  console.log('[realpage] n=' + n + ' fail=' + fails);
  process.exit(fails ? 1 : 0);
})();
