// 真实数据的独立验证。不用内核，只用公开数据源的值 + 第一性原理算术。
// 判据分两组：
//   A 组（系外行星）：用**实测周期**与**实测半长轴**互校开普勒第三定律。两者本来自不同观测量，
//                    能对上就说明数据自洽，同时验证我们 G=4pi^2 的单位制约定。
//   B 组（恒星）：视差 -> 距离 -> 绝对星等。用**已发表的绝对星等**做外部锚点，
//                不是拿我们自己的推导值自证。
const fs = require('fs');
const path = require('path');
let n = 0, fail = 0;
const L = [];
const ok = (c, m) => { n++; L.push((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const DIR = path.join(__dirname, 'starpivot', 'data');
const exo = JSON.parse(fs.readFileSync(path.join(DIR, 'real_exoplanets.json'), 'utf8'));
const stars = JSON.parse(fs.readFileSync(path.join(DIR, 'real_stars.json'), 'utf8'));

// ---------------------------------------------------------------- A 系外行星
L.push('=== A 组：真实系外行星（开普勒第三定律互校） ===');
L.push('  规则：由实测 a 与实测宿主质量算 T_pred = sqrt(a^3/M)（年），与实测周期比。');
L.push('        a 与周期来自不同的观测量（凌星周期 vs 视向速度/动力学），能对上就是硬证据。');
L.push('');
let worst = 0, worstName = '', checked = 0, worstA = 0;
const perPlanet = [];
for (const sys of exo.systems) {
  const M = sys.star.st_mass;
  L.push(`  [${sys.hostname}]  宿主质量 ${M} Msun`);
  for (const p of sys.planets) {
    if (p.pl_orbsmax == null || p.pl_orbper == null) { L.push(`    SKIP  ${p.name}（缺 a 或周期）`); continue; }
    const tPredYr = Math.sqrt(Math.pow(p.pl_orbsmax, 3) / M);
    const tPredDay = tPredYr * 365.25;
    const tObsDay = p.pl_orbper;
    const rel = Math.abs(tPredDay - tObsDay) / tObsDay;
    // 发表的 a 写到小数点后几位 —— 决定这条数据本身能承载多少精度
    const aStr = String(p.pl_orbsmax);
    const dec = aStr.includes('.') ? aStr.split('.')[1].length : 0;
    checked++;
    perPlanet.push({ name: p.name, rel, dec, a: p.pl_orbsmax });
    if (rel > worst) { worst = rel; worstName = p.name; }
    if (rel > worstA) worstA = rel;
    L.push(`    ${p.name.padEnd(16)} a=${aStr} (${dec} 位小数)  M=${M}  ->  T_pred=${tPredDay.toFixed(6)} d`
      + `   T_obs=${tObsDay} d   相对偏差 ${(rel * 100).toFixed(4)}%`);
  }
  L.push('');
}
ok(checked === 19, `19 颗真实行星全部参与互校（实测 ${checked} 颗）`);

// 判据设计说明：a 与周期在本表里是**两个独立测量量**，各有自己的不确定度与舍入，
// 所以这里做的是**抄错位检测**，不是精度声明。容差按 a 的书写精度分档：
//   a 写到 >=5 位小数 -> 0.3%；少于 5 位 -> 放宽到 1.5%（少一位就可能多 10 倍舍入误差）
const fine = perPlanet.filter(x => x.dec >= 5);
const coarse = perPlanet.filter(x => x.dec < 5);
const fineWorst = fine.reduce((a, b) => (a.rel > b.rel ? a : b));
ok(fineWorst.rel < 0.003,
  `${fine.length} 颗「a 写到 >=5 位小数」的行星，最大相对偏差 ${(fineWorst.rel * 100).toFixed(4)}%（${fineWorst.name}），阈值 0.3%`);
ok(worst < 0.015,
  `全部 19 颗的最大相对偏差 ${(worst * 100).toFixed(4)}%（${worstName}），阈值 1.5% —— 抄错一位会远超这个数`);
// 把"最差那颗为什么差"单独钉住，而不是含糊地说"在容差内"
const wp = perPlanet.find(x => x.name === worstName);
ok(wp.dec < 5,
  `偏差最大的 ${worstName} 恰好是「a 书写精度最低」那一档（${wp.dec} 位小数，a=${wp.a}）`
  + ` —— 偏差由发表的舍入解释，不是抄错。其余 ${coarse.length} 颗同为低精度档`);
L.push('');

// 全部行星的偏心率必须落在 [0,1)，否则内核会直接拒绝
let eccBad = 0, missingKept = 0;
for (const sys of exo.systems) {
  for (const p of sys.planets) {
    if (p.pl_orbeccen == null) { missingKept++; continue; }
    if (!(p.pl_orbeccen >= 0 && p.pl_orbeccen < 1)) eccBad++;
  }
}
ok(eccBad === 0, `所有行星的偏心率都在 [0,1) 内（越界 ${eccBad} 个）—— 否则内核会拒绝`);
ok(missingKept === 1, `缺项保持缺失、没有补零顶替（${missingKept} 个 e 缺失，与原始查询一致）`);
ok(exo.systems.length === 5, `5 个真实系统（${exo.systems.map(s => s.hostname).join(', ')}）`);
ok(exo.systems.every(s => s.planets.every(p => p.pl_bmassj > 0)),
  '每颗行星都有实测质量（内核要用它做引力源；质量缺失的行星不能当有质量体放进 N 体）');
// TRAPPIST-1 的 7 颗必须全在，且周期单调（越靠外越慢）——这是物理必然，抄错一位就会破坏
const tj = exo.systems.find(s => s.hostname === 'TRAPPIST-1');
ok(tj && tj.planets.length === 7, `TRAPPIST-1 收录 7 颗行星（实测 ${tj ? tj.planets.length : 0} 颗）`);
const mono = tj.planets.every((p, i) => i === 0 || p.pl_orbper > tj.planets[i - 1].pl_orbper);
ok(mono, 'TRAPPIST-1 七颗行星的周期严格单调递增（b 最快、h 最慢）—— 抄错一位就会被这条抓住');
const tjMonoA = tj.planets.every((p, i) => i === 0 || p.pl_orbsmax > tj.planets[i - 1].pl_orbsmax);
ok(tjMonoA, 'TRAPPIST-1 七颗行星的半长轴也严格单调递增 —— 与周期互为独立佐证');
// 宿主星必须在氢燃烧下限之上，否则内核里它不会发光、整个系统没有光源
ok(exo.systems.every(s => s.star.st_mass > 0.08),
  '所有宿主星质量都在氢燃烧下限 0.08 Msun 之上 —— 否则系统里一个光源都没有');
L.push('');

// ---------------------------------------------------------------- B 恒星
L.push('=== B 组：真实恒星（视差 -> 距离 -> 绝对星等，用已发表值做外部锚点） ===');
L.push('  规则：d = 1000/Plx (pc)；M_V = Vmag - 5*log10(d) + 5。');
L.push('        锚点用**已发表的绝对星等**，不是我们的推导值。');
L.push('');
const byHip = {};
for (const s of stars.stars) byHip[s.hip] = s;
const anchors = [
  // hip, 名称, 已发表 M_V, 容差
  [32349, '天狼星 A (Sirius A)', 1.42, 0.10],
  [27989, '参宿四 (Betelgeuse)', -5.14, 0.35],   // 变星，Hipparcos 距离下的值
  [24436, '参宿七 (Rigel)', -6.70, 0.30],
  [37279, '南河三 (Procyon)', 2.66, 0.15],
  [24608, '五车二 (Capella)', -0.50, 0.20],
];
for (const [hip, name, mvPub, tol] of anchors) {
  const s = byHip[hip];
  if (!s) { ok(false, `锚点 ${name} (HIP ${hip}) 不在数据里`); continue; }
  const d = 1000 / s.plx_mas;
  const mv = s.vmag - 5 * Math.log10(d) + 5;
  const diff = Math.abs(mv - mvPub);
  ok(diff <= tol,
    `${name}：d=${d.toFixed(3)} pc  M_V=${mv.toFixed(3)}  已发表 ${mvPub}  差 ${diff.toFixed(3)} mag（容差 ${tol}）`);
}
// 距离必须单调于视差：视差最大的那颗必须是最近的
const nearest = stars.stars.reduce((a, b) => (a.plx_mas > b.plx_mas ? a : b));
ok(nearest.hip === 32349,
  `视差最大的是 HIP 32349（Plx=${nearest.plx_mas} mas → d=${(1000 / nearest.plx_mas).toFixed(3)} pc）`
  + ' —— 正是天狼星，已知最近的恒星之一');
ok(stars.stars.every(s => s.plx_mas > 0), '所有恒星视差为正（负视差是无意义测量，必须剔除而不是取绝对值）');
ok(stars.stars.every(s => s.vmag < 2.5), '所有恒星 V 星等 < 2.5（与查询条件一致）');
ok(stars.stars.length === 60, `收录 60 颗真实恒星（实测 ${stars.stars.length} 颗）`);
ok(new Set(stars.stars.map(s => s.hip)).size === stars.stars.length, 'HIP 编号无重复');
// 光谱型串必须非空 —— 后面 T_eff 标定全靠它
ok(stars.stars.every(s => s.sptype && s.sptype.length >= 2), '每颗恒星都有光谱型串（T_eff 标定的输入）');
// 刻意不做的事，也要有判据钉住：**不给恒星编星名**。
// 上一版这条判据写坏了：想用正则剥掉说明性字段再查中文，结果把合法中文说明也扫进去、误报失败。
// 判据不该靠"扫全文",应该直接盯结构：星表条目里就不该存在任何名字字段。
ok(stars.stars.every(s => !('name' in s) && !('name_zh' in s) && !('nameZh' in s) && !('proper' in s)),
  '恒星表条目只有观测字段（hip/ra/dec/vmag/plx/sptype），没有自造的星名字段');
ok(/刻意不做/.test(stars.identifier_note || ''),
  '数据文件里显式写明「刻意不做 HIP -> 中文星名映射」及其理由（不靠默契，写下来）');

L.push('');
L.push(`[realdat] n=${n} fail=${fail}`);
fs.writeFileSync(path.join(__dirname, '_probe_realdat.txt'), L.join('\n') + '\n', 'utf8');
process.exit(fail ? 1 : 0);
