// 页面侧静态判据：index.html（轨道递推 / 星下点 / 碰撞预警）。
//
// 为什么有这一条：全仓探针此前只加载 /universe.html —— 这一页的脚本**从来没有被任何判据
// 执行过**，而它上面有 SGP4、星下点、碰撞预警三块功能；界面改版时它也被改过（控件字号、
// 触屏声明），改的是一段没人看着的代码。页面级执行判据见 _probe_orbit.js，
// 冻结样本与内核的逐位一致性见 _probe_orbit_data.py。
//
// 本机没有浏览器，所以"能不跑浏览器就验"的部分放这里。最值钱的是第 5 条：
// **页面读的每个 demo 字段名，都必须真的在 demo.js 的三个场景里存在**。
// 字段名走散（把 mean_elements_end 写成 mean_elements_last 之类）两边都不报错，
// 页面只会安静地显示 0.000 —— 与 _check_bio_page.js 第 4 条同一类错，也是最难查的一类。
//
// 判据：
//   1. 内联脚本语法可解析；脚本引用的每个 id 都在 HTML 里存在。
//   2. 诚实披露：上半页是预计算样本 / 不会调用本地内核 / 只做绘制与转发不做计算 /
//      "不做假"栏三条未做项 / SGP4 验证出处 / 星下点近似误差 / 不含协方差。
//   3. 页面做的数值判断是**对照教科书参照值**，且每个都写明容差（不是自己造物理）；
//      并禁止出现前向传播一类的算式。
//   4. 被 _probe_orbit.js 断言的那句"实测打开本页只发过一次 /api/health"在页面上（那是承诺）。
//   5. 页面读的每个 demo 字段名都真实存在于三个场景（负样本：改掉一个字段名必须被抓到）。
//   6. 样本里记录的航天器面积/质量，页面必须显示出来（不许只在数据里躺着）。
//
// 注：conj 面板读的 r.* 字段来自 CLI 的 conj 输出，静态解析不到，改由 _probe_orbit.js
// 真调一次内核后逐字段核对。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'starpivot');
const html = fs.readFileSync(path.join(ROOT, 'viewer', 'index.html'), 'utf8');
const demoTxt = fs.readFileSync(path.join(ROOT, 'viewer', 'demo.js'), 'utf8');

let n = 0, fail = 0;
const L = [];
const ok = (c, m) => { n++; L.push((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- 抠出内联脚本（<script> 无属性那个）----
const inline = html.match(/<script>([\s\S]*?)<\/script>/);
ok(!!inline, '找得到内联脚本');
const js = inline ? inline[1] : '';

// 1. 语法
let synOk = true, synErr = '';
try { new Function(js); } catch (e) { synOk = false; synErr = e.message; }
ok(synOk, '内联脚本语法可解析' + (synErr ? '   ' + synErr : ''));

// 页面靠这两份随页打包的脚本活着；名字取自页面自己，避免判据与页面各记一份。
const srcs = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
ok(srcs.includes('world.js') && srcs.includes('demo.js'),
   '页面引用了 world.js 与 demo.js   ' + srcs.join(', '));

// 引用的 id 都存在
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const refIds = new Set([
  ...[...js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]),
  ...[...js.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]),
]);
const missIds = [...refIds].filter(i => !htmlIds.has(i));
ok(refIds.size > 10 && missIds.length === 0,
   `脚本引用的 ${refIds.size} 个 id 全部存在` + (missIds.length ? '   缺: ' + missIds.join(', ') : ''));

// ---- 2. 诚实披露（同一个函数喂正反两段文本）----
// 这些话是"被质疑时的答案"：它们被顺手删掉时页面上看不出来，而那正是产品开始说假话的第一步。
const DISCLOSURE = [
  [/预计算样本/, '上半页那三份轨道是**预计算样本**'],
  [/不会调用本地内核/, '明确说明加载时不调用本地内核'],
  [/打包那一刻算的/, '说明是"打包那一刻算的"（而不是此刻）'],
  [/本页只做绘制与请求转发，不做任何计算/, '本页不做计算、只做绘制与转发'],
  [/实测打开本页只发过一次/, '把"只发过一次健康检查"写成可核对的承诺'],
  [/不做假/, '有"还没有做的（不做假）"一栏'],
  [/田谐/, '列出未做项：田谐项重力场'],
  [/空间天气/, '列出未做项：空间天气驱动的大气密度'],
  [/定轨/, '列出未做项：定轨'],
  [/AIAA 2006-6753/, 'SGP4 验证出处（Vallado AIAA 2006-6753 附录 D）'],
  [/21 km/, '星下点球面近似的误差量级'],
  [/不含协方差/, '碰撞预警明确"不含协方差"这一边界'],
];
const disclosureGaps = (h) => DISCLOSURE.filter(([re]) => !re.test(h)).map(([, w]) => w);
const gaps = disclosureGaps(html);
ok(gaps.length === 0, `诚实披露 ${DISCLOSURE.length} 条都在`
   + (gaps.length ? '   缺: ' + gaps.join('；') : ''));
let negGaps = [];
try { negGaps = disclosureGaps(html.replace(/预计算样本/g, '示例')); } catch (e) { negGaps = []; }
ok(negGaps.length > 0, '负样本：抽掉"预计算样本"这句，同一处会判缺（自证判据有效）');

// ---- 3. 数值判断是对照教科书参照值，且写明容差 ----
// 页面确实自己算了一个数：高偏心率下 J2 效应的 (1−e²)⁻² 因子。它是**教科书参照**，
// 不是仿真输出，所以允许存在 —— 但必须仍然标明是参照；同时禁止出现前向传播一类的算式。
const REF = [
  [/Math\.abs\(rate - 0\.9856\) < 0\.02/, '太阳同步对照 0.9856 °/day，容差 0.02'],
  [/Math\.abs\(rate - \(-4\.95\)\) < 0\.3/, '升交点回归对照 −4.95 °/day，容差 0.3'],
  [/Math\.abs\(dr\.dargp_deg\) < 0\.05/, '临界倾角对照：近地点进动率 ≈ 0，容差 0.05'],
  [/解析式含|倍因子/, '把自己的那个数标明为"解析式因子"（教科书参照），不是结果'],
];
const refGaps = REF.filter(([re]) => !re.test(js)).map(([, w]) => w);
ok(refGaps.length === 0, `页面做的数值判断都是对照参照值且写明容差（${REF.length} 处）`
   + (refGaps.length ? '   缺: ' + refGaps.join('；') : ''));

const FORBIDDEN = [
  [/a\s*\*\*\s*1\.5/, '开普勒第三定律式的 a^1.5'],
  [/Math\.pow\(\s*(a|r|n)\b/, '用根数直接算幂次'],
  [/Math\.sqrt\(\s*(mu|GM|398600)/, '自己开根号算速度/周期'],
  [/3\.986004418e5|398600\.4418/, '地球引力常数参与运算'],
  [/6\.674e-11|6\.67430e-11/, '万有引力常数参与运算'],
  [/vis-?viva/i, 'vis-viva 方程'],
];
const hitForbidden = (s) => FORBIDDEN.filter(([re]) => re.test(s)).map(([, w]) => w);
const hits = hitForbidden(js);
ok(hits.length === 0, '页面没有自己实现前向传播/根数求解'
   + (hits.length ? '   出现: ' + hits.join('；') : ''));
ok(hitForbidden('const v = Math.sqrt(mu/a);').length > 0,
   '负样本：写一行 Math.sqrt(mu/a) 会被同一处抓到（自证判据有效）');

// ---- 5. 字段对齐：页面读的每个 demo 字段名都必须真的存在 ----
const demo = JSON.parse(demoTxt.split('=')[1].trim().replace(/;\s*$/, ''));
// 顶层还有一个 __end 哨兵键（页面按 __ 前缀过滤），场景名单独列出来供报错信息用 ——
// 直接拿 Object.keys(demo) 的下标去对场景名，一旦键的顺序变了报错信息就会指错场景。
const SCEN_NAMES = Object.keys(demo).filter(k => !k.startsWith('__'));
const SCEN = SCEN_NAMES.map(k => demo[k]);
const MARK = '碰撞预警（conj）面板';
ok(html.includes(MARK), '页面里找得到上半页（样本回放）/下半页（conj 面板）的分界');
const demoJsRaw = js.split(MARK)[0];   // conj 部分读的是 CLI 的 conj 输出，由页面级判据核对
// 扫代码，不扫注释：注释里提一个字段名是说明，不是读取。
// （真踩过：修完 bug 之后判据仍在报 m0.period_s —— 那是我自己写进注释里的那句"这里曾经读…"。）
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');   // 前面是 : 或引号时不当注释（http:// 之类）
const demoJs = stripComments(demoJsRaw);
ok(/getElementById\('kv'\)/.test(demoJs) && /d\.final_elements_osculating/.test(demoJs),
   '注释剥离没有把代码一起吃掉（剥离后仍认得出真实读取）');

// 别名 -> 样本里的子对象：从源码里现读（const m0 = d.mean_elements_start || {}），
// 不在这里另行硬编码一份，免得判据与页面各记一份而漂移。
const aliases = {};
for (const m of demoJs.matchAll(/const\s+(\w+)\s*=\s*d\.(\w+)\s*\|\|\s*\{\}/g)) aliases[m[1]] = m[2];
ok(aliases.dr === 'secular_drift' && aliases.m1 === 'mean_elements_end',
   `从源码里认出别名 ${Object.keys(aliases).length} 个：`
   + Object.entries(aliases).map(([a, k]) => a + '→' + k).join('，'));

const trackPointKeys = new Set(Object.keys(SCEN[0].ground_track[0]));
// 页面刻意"有则显示"的字段：它只在 m.spacecraft ? [...] : [] 里被读（第 6 条另有断言钉住那个形状）。
// 除此之外一律不许出现"读了却不存在"的字段 —— 那正是 0 s (0.0 min) 那个假数的成因。
const OPTIONAL = new Set(['m.spacecraft']);
const fieldGaps = (pageJs, scen) => {
  const gaps = [];
  // d.<key>：顶层字段
  for (const m of pageJs.matchAll(/\bd\.(\w+)/g)) {
    const k = m[1];
    scen.forEach((s, i) => { if (!(k in s)) gaps.push(`d.${k}（场景 ${SCEN_NAMES[i]} 没有）`); });
  }
  // alias.<key>：子对象字段
  for (const [a, sub] of Object.entries(aliases)) {
    for (const m of pageJs.matchAll(new RegExp('\\b' + a + '\\.(\\w+)', 'g'))) {
      if (OPTIONAL.has(a + '.' + m[1])) continue;
      scen.forEach((s, i) => {
        if (!(m[1] in (s[sub] || {}))) gaps.push(`${a}.${m[1]}（场景 ${SCEN_NAMES[i]} 的 ${sub} 没有）`);
      });
    }
  }
  // 轨道点字段：p./prev. 在上半页里只可能是 ground_track 的点
  for (const m of pageJs.matchAll(/\b(?:p|prev)\.(\w+)/g)) {
    if (!trackPointKeys.has(m[1])) gaps.push(`轨道点字段 ${m[1]}（ground_track 的点没有这个键）`);
  }
  return [...new Set(gaps)];
};
const fg = fieldGaps(demoJs, SCEN);
ok(fg.length === 0, '页面读的每个 demo 字段名都在三个场景里存在'
   + (fg.length ? '   对不上: ' + fg.join('；') : `（${trackPointKeys.size} 个点字段 + 别名 ${Object.keys(aliases).length} 组）`));
// 负样本必须改"页面确实读的"那个字段 —— 早先这条改的是 m1.period_s，而页面并不读它，
// 于是它当时"报出来的"其实是上面那个真 bug，不是负样本生效。
const fgNeg = fieldGaps(demoJs, SCEN.map(s => {
  const c = JSON.parse(JSON.stringify(s));
  c.mean_elements_end.a = c.mean_elements_end.a_km;   // 页面读的是 m1.a_km
  delete c.mean_elements_end.a_km;
  return c;
}));
ok(fgNeg.length > 0,
   '负样本：把 mean_elements_end.a_km 改名，同一处会判字段对不上（自证判据有效）'
   + (fgNeg.length ? '   ' + fgNeg[0] : ''));

// 回归（真发生过，而且在线上待过）：关键量表的"周期"原本读 m0.period_s —— 那个键
// 从来不存在，(…||0) 于是把第一行**安静地**显示成 "0 s (0.0 min)"，三个场景全一样。
// 一个用户可见的假数字，页面上看不出来（表格里它就是一行"看起来很正常"的数）。
const periodRowOK = (s) => /e0\.period_s/.test(s)
  && !/\bm0\.period_s\b/.test(s)
  && /—（内核未回显）/.test(s);   // 真的缺了要给"—"，不补零
ok(periodRowOK(demoJs), '关键量表的"周期"读内核真正回显它的那一处，缺了给"—"而不是 0');
ok(!periodRowOK(demoJs.replace(/e0\.period_s/g, 'm0.period_s')),
   '负样本：把它改回读 m0.period_s，同一处会判不通过（自证判据有效）');

// ---- 6. 样本里记录的航天器面积/质量必须显示出来 ----
// 起因：带阻力那个场景只记了 drag:true，没记面积/质量 —— 阻力只通过 A/m 进入方程，
// 于是那 641 个点只能靠拟合一个标量反推。内核现在会回显它，页面也必须把它摆出来。
const withSC = SCEN.filter(s => s.model.spacecraft);
ok(withSC.length > 0, `样本里有 ${withSC.length} 个场景记录了航天器面积/质量`);
const scRevealed = /m\.spacecraft/.test(demoJs) && /航天器面积/.test(html);
ok(scRevealed, '页面把样本里的面积/质量显示出来（不是只在数据里躺着）');
ok(/m\.spacecraft\s*\?\s*\[/.test(demoJs) && /:\s*\[\]/.test(demoJs),
   '没有记录的场景不占那一行（缺测按缺失处理，不补零）');
ok(!/Math\.(pow|sqrt)\(\s*m\.spacecraft/.test(demoJs),
   '页面只显示 A/m 回显值，不自己再算一遍');

console.log(L.join('\n'));
const TAIL = `\n[orbit-static] n=${n} fail=${fail}`;
console.log(TAIL);
// 编排脚本把 stdout 丢进 /dev/null，所以判据必须自己落盘 —— 只打印等于只有一个退出码。
fs.writeFileSync(path.join(__dirname, '_check_orbit.txt'), L.join('\n') + TAIL + '\n', 'utf8');
process.exit(fail ? 1 : 0);
