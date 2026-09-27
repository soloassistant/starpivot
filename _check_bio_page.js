// 页面侧判据：universe.html 的演化部分。
//
// 本机没有浏览器自动化可用，所以把"能不跑浏览器就验证"的部分全做成静态判据。
// 最值钱的一条是第 4 条：**页面读取的每个 bio 字段名，都必须真的出现在内核输出里**。
// 页面 ↔ 内核的字段名走散（把 t_surf_K 写成 tsurf 之类）在两边都不会报错，
// 只会安静地显示 "-"，是最难查的一类错。
//
// 判据：
//   1. 内联脚本能被解析（括号 / 引号 / 语法）。
//   2. 脚本里 $('x') / getElementById('x') 引用的每个 id 都在 HTML 里存在。
//   3. 新增的演化控件 id 全部到位。
//   4. 页面读的每个 bio 字段名都在内核 printf 的 bio 块里出现。
//   5. STAGE_COLORS 的格子数 == 内核 kBioStageCount。
//   6. VERDICT 的档数 == 内核输出的 verdict_names 档数，且码值一一对应。
//   7. compute() 真的把 bio 旋钮放进了 payload（不是只画了控件）。
//   8. 页面不自己算物理：不该出现 278.6 / 273 / 373 这类常量参与运算。

const fs = require('fs');
const path = require('path');

const ROOT = 'C:/Users/geral/WorkBuddy/2026-09-24-16-11-48/starpivot';
const html = fs.readFileSync(path.join(ROOT, 'viewer', 'universe.html'), 'utf8');
const cli = fs.readFileSync(path.join(ROOT, 'tools', 'starpivot_cli.cpp'), 'utf8');

const out = [];
let bad = 0;
const check = (name, ok, detail) => {
  out.push((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!ok) bad++;
};

// ---- 抠出内联脚本 ----
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.log('FAIL 找不到内联脚本'); process.exit(1); }
const js = m[1];

// 1. 语法
let synOk = true, synErr = '';
try { new Function(js); } catch (e) { synOk = false; synErr = e.message; }
check('内联脚本语法可解析', synOk, synErr);

// 2. 引用的 id 都存在
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(x => x[1]));
const refIds = new Set([
  ...[...js.matchAll(/\$\('([^']+)'\)/g)].map(x => x[1]),
  ...[...js.matchAll(/getElementById\('([^']+)'\)/g)].map(x => x[1]),
]);
const missingIds = [...refIds].filter(id => !htmlIds.has(id));
check(`脚本引用的 ${refIds.size} 个 id 全部存在`, missingIds.length === 0,
  missingIds.length ? '缺失: ' + missingIds.join(', ') : '');

// 3. 演化控件
const WANT_IDS = ['biobox', 'bioon', 'bioyears', 'albedo', 'greenhouse', 'ghlabel',
                  'bionote', 'biocard', 'biowarn', 'biotable', 'biolayer'];
const noCtrl = WANT_IDS.filter(id => !htmlIds.has(id));
const notUsed = WANT_IDS.filter(id => !refIds.has(id));
check('演化控件 id 齐全', noCtrl.length === 0, noCtrl.length ? '缺: ' + noCtrl.join(', ') : '');
check('演化控件全部被脚本使用（不是死元素）', notUsed.length === 0,
  notUsed.length ? '未引用: ' + notUsed.join(', ') : '');

// ---- 内核 bio 块里输出的字段名 ----
// 源码里字符串内的引号是转义的（\"layer1_physics\"），用裸引号找会返回 -1，
// 截取窗口就变成反向空串 —— 那样整条判据会"全过"，其实什么都没检查。
// 所以这里既按转义形式找，也把找不到变成显式失败。
const bioStart = cli.search(/\\"layer1_physics\\"/);
const bioEnd = cli.indexOf('std::printf("]\\n  },\\n")', bioStart);
check('能在 CLI 源码里定位到 bio 输出块', bioStart > 0 && bioEnd > bioStart,
  bioStart < 0 ? '找不到 \"layer1_physics\"（不该发生：判据本身要改）'
               : `块区间 ${bioStart}..${bioEnd}`);
const bioBlock = (bioStart > 0 && bioEnd > bioStart) ? cli.slice(bioStart, bioEnd) : '';
// C++ 源码里的键写作 \"key\"，所以两侧都要吃掉一个反斜杠；名字里带大写（t_eq_K、
// luminosity_Lsun）也要收，所以字符类必须含 A-Z。
const kernelKeys = new Set([...bioBlock.matchAll(/\\"([A-Za-z0-9_]+)\\":/g)].map(x => x[1]));
['stage', 'verdict', 'progress', 'insolation', 't_eq_K', 't_surf_K',
 'stage_final', 'stage_name'].forEach(k => kernelKeys.add(k));
check('从内核抠到了 bio 字段名', kernelKeys.size > 12,
  `${kernelKeys.size} 个: ${[...kernelKeys].slice(0, 8).join(',')}...`);

// 4. 页面读的每个 bio 字段名都必须由内核输出
// 只认这四种明确指向 bio 的写法；不要用裸的 `e.`，那会把事件参数
// （e.preventDefault / e.clientX）和 for..of 的 e 全吸进来，判据就没意义了。
const pageBioFields = new Set([
  ...[...js.matchAll(/\bB\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(x => x[1]),
  ...[...js.matchAll(/data\.bio\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(x => x[1]),
  ...[...js.matchAll(/\bbioE\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(x => x[1]),
  ...[...js.matchAll(/\bbioB\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(x => x[1]),
]);
// 这几个是页面自己造的对象字段（bioAt 的返回结构），不是内核字段
const LOCAL = new Set(['stage', 'verdict', 'progress', 'insolation', 't_eq', 't_surf', 'reached']);
const unknown = [...pageBioFields].filter(k => !kernelKeys.has(k) && !LOCAL.has(k));
check('页面读取的 bio 字段全部来自内核', unknown.length === 0,
  unknown.length ? '内核没有的字段: ' + unknown.join(', ') : `${pageBioFields.size} 个字段名对齐`);

// 5. 阶色阶格子数
const scm = js.match(/STAGE_COLORS\s*=\s*\[([^\]]*)\]/);
const nStageColors = scm ? (scm[1].match(/#[0-9a-fA-F]{6}/g) || []).length : 0;
const kStageCount = Number((cli.match(/kBioStageCount\s*=\s*(\d+)/) || [])[1]) ||
                    Number((fs.readFileSync(path.join(ROOT, 'include', 'starpivot', 'bio.hpp'), 'utf8')
                      .match(/kBioStageCount\s*=\s*(\d+)/) || [])[1]);
check(`STAGE_COLORS 格子数 == kBioStageCount(${kStageCount})`, nStageColors === kStageCount,
  `页面 ${nStageColors} 个`);

// 6. 判定档数与码值
const vm = js.match(/const VERDICT\s*=\s*\[([\s\S]*?)\];/);
const nVerdict = vm ? (vm[1].match(/name\s*:/g) || []).length : 0;
const kernelVerdicts = (cli.match(/verdict_names\\": \[([^\]]*)\]/) || [])[1];
// 源码里是 \"no_light\"，两侧各带一个反斜杠，必须显式吃掉，否则一个都匹配不到
// （上一版就是这样把顺序判据变成空数组对空数组、自己把自己骗过去一半）。
const kernelOrder = kernelVerdicts
  ? [...kernelVerdicts.matchAll(/\\"([a-z_]+)\\"/g)].map(x => x[1]) : [];
check(`VERDICT 档数 == 内核 verdict_names 档数(${kernelOrder.length})`,
  nVerdict === kernelOrder.length && kernelOrder.length === 4,
  `页面 ${nVerdict} 档，内核 ${kernelOrder.join(',') || '(解析失败)'}`);
// 顺序必须一致：内核的码 0..3 依次是 no_light/frozen/evolving/sterilized，
// 页面的数组顺序即码值顺序 —— 顺序错了会把"灭菌"显示成"冻结"。
const CODE_OF = { '无光照': 'no_light', '冻结': 'frozen', '演化中': 'evolving', '灭菌': 'sterilized' };
const pageOrder = vm ? [...vm[1].matchAll(/name:\s*'([^']+)'/g)].map(x => CODE_OF[x[1]]) : [];
check('VERDICT 顺序与内核码值一一对应', JSON.stringify(pageOrder) === JSON.stringify(kernelOrder),
  `页面 ${pageOrder.join(',')} vs 内核 ${kernelOrder.join(',')}`);

// 7. compute() 真的把旋钮送出去了
const wantPayload = ['bio', 'bio_years', 'albedo', 'greenhouse'];
const missed = wantPayload.filter(k => !new RegExp(`payload\\.${k}\\b`).test(js));
check('compute() 把 4 个演化字段放进 payload', missed.length === 0,
  missed.length ? '没发出去: ' + missed.join(', ') : '');
// 关掉时必须是 bio:false（而不是把所有字段清空）
check('关掉演化时发 bio=false', /payload\.bio\s*=\s*false/.test(js));

// 8. 页面不自己算物理：这些常量只能出现在"说明文字"里，不能出现在代码里。
//    所以先把字符串字面量（含模板串）整段抠掉，再在剩下的代码里找 ——
//    否则 bionote 里那句"冰点 273 K 与沸点 373 K"会被误判成页面在自己算。
// 剥串器必须认识三种东西：字符串、注释、正则字面量。
// 少了正则那一条会出"错位"这种最坏的假结论：页面里只要有一个 /[",]/ 这样的字面量，
// 里面的引号会被当成字符串开头，从此**后面所有字符串与代码的配对全部错一格**，
// 于是某些常量看起来"出现在代码里"—— 实测就是这样误报过一次"页面自己算冰点/沸点"，
// 而且这个缺陷在页面还没出现那些字符串之前一直潜伏着（上一轮恰好没踩到）。
function prevSignificant(code, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(code[j])) j--;
  return j >= 0 ? code[j] : '';
}
// 正则字面量只可能出现在"运算符位置"。这里用前一个有效字符判断，
// 够覆盖真实代码里的用法（= ( , : [ ! & | ? { } ; return 等）。
function regexAllowed(code, i) {
  const p = prevSignificant(code, i);
  if (p === '') return true;
  if ('(,=:[!&|?{};'.indexOf(p) >= 0) return true;
  const head = code.slice(Math.max(0, i - 12), i);
  return /(?:^|[^\w$])(return|typeof|instanceof|case|in|of|new|delete|void|do|else|yield|await)\s*$/.test(head);
}
function skipRegex(code, i) {
  let j = i + 1, inClass = false;
  while (j < code.length) {
    const c = code[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '\n') return i + 1;            // 正则不能跨行 → 判断错了，退回一个字符
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) { j++; break; }
    j++;
  }
  while (j < code.length && /[a-z]/i.test(code[j])) j++;   // 标志位
  return j;
}
function stripStrings(code) {
  let outS = '', i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === q) { i++; break; }
        i++;
      }
      outS += '\u0001';       // 哨兵故意不用引号：这样"剥完还有引号"能直接当自检判据
      continue;
    }
    if (c === '/' && code[i + 1] === '/') {          // 行注释
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {          // 块注释
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '/' && regexAllowed(code, i)) {         // 正则字面量
      i = skipRegex(code, i);
      outS += '\u0001';
      continue;
    }
    outS += c; i++;
  }
  return outS;
}
const codeOnly = stripStrings(js);
// 剥串器自检：字符串全剥干净之后，剩下的代码里不该再有引号。
// 为什么需要这一条：剥串器是按"见到引号就当字符串开始"走的，它不认识正则字面量 ——
// 页面里一旦出现 /"/ 这种字面量，那个引号会被当成字符串开头，后面整段错位，
// 于是"页面自己算 273/373"这种**假失败**就会出现（实测踩过）。
// 宁可在这里明确报"剥串器被带偏"，也不要吐一个看起来像代码缺陷的假结论。
check('剥串器自检：剥掉字符串/正则后不该剩下引号',
  !/['"]/.test(codeOnly), '（字符串与正则都用哨兵替代，所以这里必须一个引号都不剩）');
const PHYS = [['278.6', '平衡温度系数'], ['273', '冰点'], ['373', '沸点'],
              ['3.5', '质光关系指数'], ['0.306', 'albedo']];
const leak = PHYS.filter(([lit]) => new RegExp(`(^|[^0-9A-Za-z_.])${lit.replace('.', '\\.')}($|[^0-9])`)
  .test(codeOnly));
check('剥掉字符串后，代码里没有内核管的物理常量', leak.length === 0,
  leak.length ? '疑似页面自己算: ' + leak.map(x => x[0] + '(' + x[1] + ')').join(', ')
              : '阈值与系数只从内核回显读（freezing_K / sterilization_K / ...）');
// 说明文字里必须真的把这些数写出来（否则"标注了是编排"就是空话）
const prose = js.match(/const PHYS|bionote[\s\S]{0,600}/) || [''];
check('说明文字里确实写出了冰点/沸点这两个物理阈值',
  /273/.test(js) && /373/.test(js) && /编排/.test(js), '');
// 反过来：页面确实读了这些回显
const echoUsed = ['freezing_K', 'sterilization_K', 'rate_peak_K', 'stage_names',
                  'verdict_names', 'layer1_physics', 'layer2_stylized', 'caveats']
  .filter(k => !js.includes(k));
check('页面把内核回显的关键字段都用上了', echoUsed.length === 0,
  echoUsed.length ? '没用到: ' + echoUsed.join(', ') : '含分层声明与阈值');

// ---- 9. 球体颜色 = 物质 × 生命（两轮用户反馈叠在同一个通道上）----
// 反馈原话 ①："行星颜色为生命形态，区分由点击出此行星数据并且改变视角"。
// 反馈原话 ②："根据大小，物质，生命，做成不同颜色不同表现形态"。
// 静态这一层管的是"结构有没有走散"：颜色这一笔必须走同一个出口（不能有第二处
// 自己拼颜色）、三个通道的文案必须都在、数据卡必须还在首屏范围内。
// 数值对不对由 _probe_tools.js 第 11/11b 节在真画出来的那一笔上验（那里会独立复算）。
check('画布上球体那一笔填充取自 lifeColorOf（唯一出口）',
  /const baseCol = lifeColorOf\(b, fi\);/.test(codeOnly)
  && /ctx\.fillStyle = baseCol; ctx\.beginPath\(\); ctx\.arc\(x,y,rr,0,Math\.PI\*2\); ctx\.fill\(\);/.test(codeOnly)
  && !/ctx\.fillStyle\s*=\s*mixColor\(/.test(codeOnly),
  '画布填充必须来自 lifeColorOf，而不是就地拼一个颜色（就地拼的那种写法这里也一并挡掉）');
// 这一条是被"改了实现忘了改判据"逼出来的：原来的正则写死了
// `stage >= 1 ? stageColor(bi.stage)`，本轮把"纯阶色"改成"物质底色 + 生命染色"之后
// 它必须跟着改 —— 否则判据红的是一个**已经不再成立的旧设计**，而我会去改代码迁就它。
check('lifeColorOf 的两条分支都在：有生命 = 物质色染阶色；没生命 = 物质色压向死寂灰',
  /mixColor\(tone,\s*stageColor\(bi\.stage\),\s*lifeTintW\(bi\.stage\)\)/.test(codeOnly)
  && /mixColor\(tone,\s*stageColor\(0\),\s*LIFE_DEAD_MIX\)/.test(codeOnly)
  && /const tone = matTone\(bd, b\)/.test(codeOnly),
  '物质基调色是底色，生命只在它上面染色');
const deadMix = +(js.match(/LIFE_DEAD_MIX\s*=\s*([\d.]+)/) || [])[1];
check('死寂混色权重是个真的比例（0 < LIFE_DEAD_MIX < 1）',
  deadMix > 0 && deadMix < 1, 'LIFE_DEAD_MIX = ' + deadMix);
check('来源色没被丢掉：球外那圈细环用的是 colorOf 的结果',
  /if \(bi && !data\.bodies\[b\]\.emits_light\)\{[\s\S]{0,160}?ctx\.strokeStyle = col;[\s\S]{0,160}?arc\(x, y, rr \+ [\d.]+/.test(codeOnly),
  '细环 = 来源色（血缘），球的颜色才让给物质与生命');
check('图例把三个颜色通道各管什么写清楚了（物质 / 生命 / 来源）',
  /球体颜色/.test(js) && /物质/.test(js) && /生命形态/.test(js)
  && /球外细环/.test(js) && /来源色/.test(js),
  '球体颜色 = 物质 × 生命 / 球外细环 = 来源色');
check('数据卡（选中的天体）在第一个折叠区之前 —— 点一下就能看见，不是埋在页面底部',
  html.indexOf('id="selcard"') > 0 && html.indexOf('id="selcard"') < html.indexOf('id="advbox"'),
  'selcard 排在「更多设置」之前');
check('数据卡默认是隐藏的（不占首屏、也不进首屏控件预算）',
  /id="selcard"[^>]*style="display:none/.test(html), '');
check('卡上有一个"取消选中"的真出口',
  /id="selclose"/.test(html) && /\$\('selclose'\)\.addEventListener/.test(js), '');

// ---- 9b. 颜色要自己复算对比度（判据查不到的东西，要另外算一遍）----
// 真实的教训：一次改版把表头颜色从 ink2 换成 ink3，对比度从 6.07 掉到 3.21 而**全部判据照样绿**
// —— 因为它们查的是结构与文案，不查颜色。所以这里把对比度算出来当判据。
// 9 格阶色现在身兼两职：球体/轨迹的"面"（图形对象，AA 非文字要 3:1），
// 以及图例里的小圆点（底是卡片 #111a30，比画布还暗）。两处都得过。
// 这不是形式主义：第 0 格原来在卡片上只有 2.77:1，是**真的不过**（改成了 #6b7383 → 3.63）。
const lum = h => {
  const c = [1, 3, 5].map(k => parseInt(h.substr(k, 2), 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
const bgCol = ((html.match(/--bg:\s*(#[0-9a-fA-F]{6})/) || [])[1] || '#0a0f1e');
const cardCol = ((html.match(/--card:\s*(#[0-9a-fA-F]{6})/) || [])[1] || '#111a30');
const stageCols = (js.match(/STAGE_COLORS\s*=\s*\[([^\]]*)\]/) || ['', ''])[1]
  .split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
const stageCR = stageCols.map(c => Math.min(contrast(c, bgCol), contrast(c, cardCol)));
const worstStage = Math.min(...stageCR);
check(`${stageCols.length} 格阶色在画布(${bgCol})与图例卡(${cardCol})上都 ≥ 3:1（非文字图形底线）`,
  stageCols.length === 9 && worstStage >= 3,
  '最紧一格 ' + stageCols[stageCR.indexOf(worstStage)] + ' = ' + worstStage.toFixed(2) + ':1');
// 负样本走同一个函数：把一个接近底色的灰塞进去，必须判不过。
check('负样本：把第 0 格换成接近底色的 #1a2030，同一处会判不过（自证这个复算不是恒真）',
  Math.min(contrast('#1a2030', bgCol), contrast('#1a2030', cardCol)) < 3,
  '#' + '1a2030 = ' + Math.min(contrast('#1a2030', bgCol), contrast('#1a2030', cardCol)).toFixed(2) + ':1');
// 画布上那行"阶名"小字必须用浅色写：阶色是给"面"用的，拿它写 11px 小字
// 在深底上只有 4.0:1（第 0 阶），而文字要 4.5:1。
check('选中天体旁边那行阶名用的是浅色文字（不是阶色 —— 阶色只有 4.0:1，写小字不够）',
  /if \(b === cam\.sel && bi\)\{[\s\S]{0,420}?ctx\.fillStyle = 'rgba\(232,236,246,0\.95\)';\s*ctx\.fillText\(/.test(js),
  '');
check('画布上对 11px 小字用的浅色 rgba(232,236,246,.95) 在画布底上 ≥ 4.5:1',
  contrast('#e8ecf6', bgCol) >= 4.5, '= ' + contrast('#e8ecf6', bgCol).toFixed(2) + ':1');

// ---- 9c. 物质 / 大小 / 形态：三个新通道的接线（本轮的用户反馈）----
// 反馈原话："根据大小，物质，生命，做成不同颜色不同表现形态"。
// 这一节只查**接线**：每一维必须在各自的地方取值、都必须从内核回显读、都不许另抄一张表。
// 数值由 _probe_tools.js 第 11b 节在真画出来的那一笔上独立复算（那里会重算黑体色与密度插值）。
//
// 最值钱的一条是第一句：内核的类型表有 39 类天体，页面把它们归成 6 个"物质族"。
// 少归一类不会报错 —— 那一类会**静默掉进 'none'**、拿来源色当物质色，症状只是"这颗球
// 的颜色看着有点怪"。所以拿内核源码里的类型名逐个对，缺一个就红。
const bt = fs.readFileSync(path.join(ROOT, 'src', 'bodytype.cpp'), 'utf8');
const typeBlock = (bt.match(/kTypes\[\]\s*=\s*\{([\s\S]*?)\n\};/) || [,''])[1];
const kernTypes = [...typeBlock.matchAll(/\{"([A-Za-z_0-9]+)",\s*"/g)].map(x => x[1]);
const famKeys = [];
['MAT_STAR','MAT_REMNANT','MAT_BROWN','MAT_GAS','MAT_ICE','MAT_ROCK'].forEach(nm => {
  const blk = (js.match(new RegExp(nm + '\\s*=\\s*\\[([\\s\\S]*?)\\]')) || [,''])[1];
  famKeys.push(...[...blk.matchAll(/'([A-Za-z_0-9]+)'/g)].map(x => x[1]));
});
const noFam = kernTypes.filter(k => !famKeys.includes(k));
check(`内核类型表里的 ${kernTypes.length} 类天体，页面每一类都归了族（没有一类静默掉进"未登记"）`,
  kernTypes.length >= 39 && noFam.length === 0,
  noFam.length ? '没归族: ' + noFam.join(', ')
               : `页面归了 ${famKeys.length} 个 key，与内核逐一对应`);
// 反向：页面列的 key 必须都是内核真有的（写错一个字母会永远匹配不上，也是静默的）
const ghostKeys = famKeys.filter(k => !kernTypes.includes(k));
check('页面列的族 key 都能在内核类型表里找到（写错字母同样会静默失效）',
  ghostKeys.length === 0, ghostKeys.length ? '内核里没有: ' + ghostKeys.join(', ') : '');
check('物质基调色走内核回显的 type / t_eff_K / density_g_cm3，不是另抄一张"名字 → 颜色"表',
  /function matTone\(bd, idx\)/.test(codeOnly) && /bbColor\(bd\.t_eff_K\)/.test(codeOnly)
  && /\+bd\.density_g_cm3/.test(codeOnly) && /MAT_OF_TYPE\[t\]/.test(codeOnly), '');
check('"色温 → 颜色"是页面明说了的渲染映射，页面没有把它说成物理',
  /function bbColor\(T\)/.test(codeOnly) && /渲染映射/.test(js) && /不是物理/.test(js)
  && /不参与任何计算/.test(js), '');
check('大小由内核的 radius_km 对数压缩而来，并且有最小可见尺寸与上限',
  /function sizeR\(bd\)/.test(codeOnly) && /Math\.log10\(R \/ SIZE_REF_KM\)/.test(codeOnly)
  && /SIZE_MIN/.test(codeOnly) && /SIZE_MAX/.test(codeOnly), '');
check('画上的半径与真实半径并排给出（不让人把"画得小"读成"它真的小"）',
  /画上多大/.test(js) && /不是一比一/.test(js) && /对数压缩/.test(js), '');
check('表现形态按物质族分岔：气巨横纹 / 岩质硬边压暗 / 冰巨亮边 / 遗迹与黑洞各有画法',
  // ⚠ 这一条故意扫 **js** 而不是 codeOnly：剥串器会把每个字符串整个换成哨兵，
  //   于是 'gas' 这类字面量在 codeOnly 里根本不存在，正则必然恒假（本轮就是这么红的）。
  //   扫 js 就必须保证这四个模式**只会**出现在代码里 —— 实测各出现 1–2 次、全部在代码中，
  //   没有一条注释含这些写法（凭据是下面那条反向断言）。
  /fam === 'gas' && rr >= 5/.test(js)
  && /fam === 'rock' \|\| fam === 'none'/.test(js)
  && /fam === 'ice' \|\| fam === 'gas'/.test(js)
  && /String\(bd\.type\) === 'black_hole'/.test(js), '');
check('上面那条不是"注释里写着就算过"：这四个模式减去代码里的出现次数之后剩 0',
  (js.match(/fam === 'gas' && rr >= 5/g) || []).length
  === (codeOnly.match(/if \(fam === \u0001 && rr >= 5\)\{/g) || []).length,
  `代码里 ${(codeOnly.match(/if \(fam === \u0001 && rr >= 5\)\{/g) || []).length} 处，`
  + `全文（含注释）${(js.match(/fam === 'gas' && rr >= 5/g) || []).length} 处`);
check('球面明暗的方向取自"这颗天体指向主星"的投影差，不是写死的斜对角',
  /const ipi = primaryIndex\(\);/.test(codeOnly)
  && /lx = dx \/ L; ly = dy \/ L;/.test(codeOnly), '');
check('活着的天体才画阶色柔光，死寂的不画（"有没有生命"的第二条可见通道）',
  /if \(bi\.stage >= 1\)\{[\s\S]{0,430}?lifeHaloA\(bi\.stage\)/.test(codeOnly),
  '灰调 + 没有柔光 = 没生命，两个信号一起说');
// shadeSphere 必须只用渐变填。理由不是好看，是判据：
// _probe_tools.js 靠"细环 stroke → 球体填充 → 写名字"这个相邻序列反推"哪一笔属于哪颗球"，
// 中间插一笔**字符串样式**的填充就会认错球（渐变是对象，那段还原逻辑会跳过它）。
const ssBody = (codeOnly.match(/function shadeSphere\([\s\S]*?\n  \}/) || [''])[0];
const ssAssigns = [...ssBody.matchAll(/ctx\.fillStyle\s*=\s*([^\n;]+)/g)].map(x => x[1]);
check('shadeSphere 里每一笔填充都是渐变对象，没有字符串颜色插进来',
  ssBody.length > 400 && ssAssigns.length >= 3 && ssAssigns.every(a => !/\u0001/.test(a)),
  `shadeSphere 里 ${ssAssigns.length} 处 fillStyle 赋值，全部走渐变`);
// 下面三条是"画布上新增画法"的守门人。它们守的不是好看，是**判据的还原规则**：
// 画布桩靠"细环 stroke → 球体填充 → 写名字"这个相邻序列反推"哪一笔属于哪颗球"。
// 新画法一旦用错样式/落在错的位置，那道还原就会静默认错球 —— 所以在这里钉死。
check('标签引线用 rgba 而不是十六进制，且排在细环 stroke **之前**（判据读的是"写名字前最后一次 stroke"）',
  /strokeStyle = 'rgba\(150,162,184,0\.55\)'/.test(js)
  && codeOnly.indexOf('if (lp && lp.lead){') > 0
  && codeOnly.indexOf('if (lp && lp.lead){')
     < codeOnly.indexOf('ctx.strokeStyle = col; ctx.lineWidth = 1.6'),
  `引线在 ${codeOnly.indexOf('if (lp && lp.lead){')}，细环在 `
  + `${codeOnly.indexOf('ctx.strokeStyle = col; ctx.lineWidth = 1.6')}`);
check('行星环用 ellipse + 渐变填充，且没有用 arc / 十六进制描边（否则会被"球"或"球外细环"认走）',
  /ctx\.ellipse\(x, y, rOut, rOut \* tilt, -0\.42, 0, Math\.PI \* 2\)/.test(codeOnly)
  && /ctx\.fillStyle = gRing;/.test(codeOnly)
  && !/ctx\.strokeStyle = ringCol/.test(codeOnly)
  && !/ctx\.arc\(x, y, rOut/.test(codeOnly), '');
check('星空带色温、亮度偏斜，填充一律 rgba（球体认的是"十六进制 + alpha 0.9"，用十六进制会混成球）',
  /const c = bbColor\(T\) \|\| '#ffffff';/.test(js)
  && /Math\.pow\(rnd\(\), 2\.2\)/.test(codeOnly)
  && /'rgba\(' \+ R \+ ',' \+ G \+ ',' \+ B/.test(js), '');
// 负样本：把引线的 rgba 换成十六进制，上面那条必须抓到（证明它不是在恒真）。
check('负样本：把引线颜色换成十六进制，上面那条会红',
  !/strokeStyle = 'rgba\(150,162,184,0\.55\)'/.test(
    js.replace("strokeStyle = 'rgba(150,162,184,0.55)'", "strokeStyle = '#96a2b8'")), '');
check('负样本：同一处对 shadeSphere 之外的一段代码必须判不出"全是渐变"（自证上面那条不是恒真）',
  /ctx\.fillStyle\s*=\s*lifeColorOf\(/.test(ssBody) === false, '');

// ---- 10. 撞击的瞬时表现：闪光 / 冲击环 / 碎屑喷流（这一轮的用户反馈）----
// 反馈原话："碰撞要开始朝着这个方向去做" / "碎片要成束溅射，不是原地散开"。
// 静态这一层管的是**接线**：撞击点必须来自内核的事件表与逐帧坐标（页面不许自己编一个
// 撞击位置），喷流必须从撞击点拉出去，喷流系数必须真的进 payload 与命令行。
// 数值与几何对不对由 _probe_collide.py 的 C2 节在真内核输出上验（那里会独立复算）。
check('撞击点索引读的是内核事件表 + 逐帧坐标（页面不自己编撞击位置）',
  /function rebuildImpactIndex\(\)/.test(codeOnly)
  && /data\.events/.test(codeOnly) && /idxOf\[ev\.a\]/.test(codeOnly)
  && /data\.frames\[best\]\.p\[pi\]/.test(codeOnly),
  '位置来自内核的 p[]，时刻来自内核的 events[].t');
check('每次 compute 成功都重建撞击点索引（与颜色聚合同一处）',
  /rebuildLineageColors\(\);\s*\/\/[^\n]*\n\s*rebuildImpactIndex\(\);/.test(js),
  '两个索引必须一起重建，否则会拿上一份数据的撞击点去画这一份');
check('画布上真的画了闪光与冲击环（在 impactPts 上循环，且是渐变 + 圆环）',
  /for \(const ip of impactPts\)\{[\s\S]{0,700}?createRadialGradient[\s\S]{0,400}?arc\(fx, fy, grow/
    .test(codeOnly),
  '闪光 = 径向渐变，冲击环 = 随 age 扩散的 arc');
check('碎屑喷流从**撞击点**拉向碎屑（用的是 impactAtT[born_at]，不是随手取一点）',
  /impactAtT\[bd\.born_at\]/.test(codeOnly)
  && /ctx\.moveTo\(jx, jy\); ctx\.lineTo\(bx, by\);/.test(codeOnly),
  '所有碎屑的线共起点 —— 那一组线才成"扇"');
check('喷流的方向与系数取自内核回显（events[].spray_axis / spray），不是页面算的',
  /axis: ev\.spray_axis \|\| \[0,0,0\]/.test(codeOnly) && /spray: \+ev\.spray \|\| 0/.test(codeOnly),
  '');
const winFrac = +(js.match(/IMPACT_WIN_FRAC\s*=\s*([\d.]+)/) || [])[1];
check('撞击表现的时长是个真的比例（0 < IMPACT_WIN_FRAC ≤ 0.2）—— 它只是"看得见多久"',
  winFrac > 0 && winFrac <= 0.2, 'IMPACT_WIN_FRAC = ' + winFrac);
check('喷流成束系数进了 payload，也进了等价 CLI 命令行（不是只画了个控件）',
  /payload\.spray = Math\.max\(0, Math\.min\(1, \+\$\('spray'\)\.value/.test(js)
  && /a\.push\('--spray', String\(pl\.spray\)\)/.test(js),
  '');
check('喷流系数被存进存档并读回（刷新/分享之后不会悄悄回到默认）',
  /spray: \$\('spray'\)\.value/.test(js) && /setVal\('spray', s\.spray\)/.test(js),
  '');
check('喷流系数的改动会触发标脏（否则点了不会重算）',
  /const DIRTY_IDS = \[[^\]]*'spray'/.test(js), '');
check('天体一多就节流名字（超过 40 颗只留本体与选中的那颗）—— 级联能滚出两百多块',
  /const labelAll = nAlive <= 40;/.test(codeOnly)
  // 节流条件现在落在**标签预排版**那一步（labelPos 只收该写名字的那些）；
  // 正式绘制那一步只看"排上版了没有"（lp）。**两处都要在** —— 缺一处节流就失效了。
  // ⚠ 这一条扫 js 而不是 codeOnly：它含 '#' 字面量，剥串器会把整个字符串换成哨兵。
  && /if \(!\(labelAll \|\| b === cam\.sel \|\| String\(bd\.id\)\.indexOf\('#'\) < 0\)\) continue;/.test(js)
  && /const lp = labelPos\[id\];/.test(codeOnly)
  && /if \(lp\)\{/.test(codeOnly),
  '可读性取舍，不是隐藏数据 —— 点它一下下面那张卡里照样有全部信息');
check('预设会把四个碎裂参数一起复位（原先漏了：改过阈值之后点别的预设想当然会带过去）',
  /\$\('fmin'\)\.value\s*=\s*p\.fmin\s*!== undefined \? p\.fmin\s*: 0\.5;/.test(js)
  && /\$\('spray'\)\.value\s*=\s*p\.spray\s*!== undefined \? p\.spray\s*: 0\.6;/.test(js),
  '');
check('页面默认阈值 == 内核默认阈值 0.5（走散了"按默认跑"就不是文档说的那回事）',
  /id="fmin"[^>]*value="0\.5"/.test(html), 'fmin 默认 0.5 km/s');

// ---- 标签排版：候选行的间距要够（差 3 px 就整行作废） ----
// 真缺陷（本轮修）：名字框高 13、上下各留 3 px 余量 → 两行要 **≥19 px** 才不判重叠。
// 原来只有 -6 / +10 两行（间距 16），每一对都恰好差 3 px 判为相撞 → 排版实际**退化成一行**：
// 内太阳系五颗的名字全挤在一条线上，截图里 `Sun` 直接被 `Mercury` 压住看不见。
// 这类"看起来只是拥挤"的问题，静态判据只查得到这个数 —— 视觉结论靠真 Chrome 截图（见 _shot.js）。
const rowsOf = (s) => { const m = s.match(/const ROWS = \[([^\]]+)\];/); return m ? m[1].split(',').map(x => +x.trim()) : []; };
const rowsOk = (s) => { const r = rowsOf(s); return r.length >= 4 && r.slice(1).every((v, i) => Math.abs(v - r[i]) >= 20); };
check('标签候选行的间距 ≥ 20 px（13 框高 + 上下各 3 px 余量 = 19，差一点就整行作废）',
  rowsOk(js), 'ROWS = [' + rowsOf(js).join(', ') + ']');
check('负样本：把行距缩回 16 px（原来那两行 -6/+10）会被同一处抓到',
  !rowsOk(js.replace(/const ROWS = \[[^\]]+\];/, 'const ROWS = [-6, 10];')), '');
check('被挤到别的**行**的名字也要补引线（只看横向距离的话，上下挪的名字会悬空、看不出属于谁）',
  /\|\| Math\.abs\(pick\[1\] - it\.y\) > 20\)/.test(js), '');

// ---- 脏标记要"老实"：算的**路上**改的参数，算完回来不能被抹掉 ----
// 这是个真缺陷（本轮修掉）：按钮在算的时候是 disabled 的，paintComputeBtn() 会早退，
// 所以那一刻的 setDirty(true) 只改了状态、按钮上没写出来；而重算成功那句原来是**无条件**
// setDirty(false) —— 用户改的参数既没进这一版结果（payload 是发出去那一刻抓的），
// 按钮还说"没什么要算的"，画面上是旧结果。这类"标记不老实"正是这个页面反复在防的东西
// （设计初衷就写在 DIRTY_IDS 那段注释里：滑杆不会自动重算，必须说出来）。
const dirtyHonest = (s) => /const revSent = paramRev;/.test(s)
  && /setDirty\(paramRev !== revSent\);/.test(s)
  && /function setDirty\(v\)\{\s*if \(v\) paramRev\+\+;/.test(s);
check('重算成功时按"算的路上有没有改过"决定要不要清标记（不是无条件清掉）',
  dirtyHonest(js), 'compute() 发请求前记下 paramRev，回来后比对');
// 负样本走同一个函数：把那句换回无条件的 setDirty(false)，必须被判红。
check('负样本：把成功那句换回无条件 setDirty(false) 会被同一处抓到',
  !dirtyHonest(js.replace('setDirty(paramRev !== revSent);', 'setDirty(false);')), '');

// ---- "话里指的地方还在不在" ----
// 这一条是被真实改动逼出来的：把"行星表"收进「更多设置」、把画布移到最前、把挑战搬进演奏条
// 之后，页面里**几句话还停在旧位置上**：
//   · 挑战提示说"先在下面的行星表里把天体加好" —— 而那张表已经折叠、普通人模式还看不到它；
//   · 导览说"上面那排是<b>天体类型</b>" —— 而类型墙已经被移到导览卡**下方**；
//   · 能量曲线说"换上面的「计算方法」" —— 那个下拉现在在「更多设置」里。
// 这类错**文字没错、只是指向一个已经不在那儿的地方**，跑遍全部判据都不会红，
// 页面上也完全看不出来 —— 只能靠人读一遍。所以这里把**已经修掉的那几句原话**钉住，
// 不让它们复活（做不到通用检查，但至少让"改回去"这件事立刻变红）。
const STALE = [
  ['先在下面的行星表里把天体加好', '行星表已收进「更多设置」，且普通人模式看不到它'],
  ['上面的「计算方法」', '计算方法的下拉现在在「更多设置」里'],
  ['上面那排是', '类型墙已经移到导览卡下方'],
  ['右侧的信息卡会告诉你', '数据卡现在在画面正下方，不在右侧'],
  ['演化阶（轨迹按当时的阶着色）', '那句话是旧的颜色键；现在球体颜色 = 生命形态、来源色在细环上'],
  ['点击星体切到它的轨道平面', '点击现在做的是"出它的数据 + 镜头对准并跟住它"（切轨道面只是其中一步，共面时还是空操作）'],
];
// 扫**会说给用户听的话**，不扫注释：注释里可以引用旧文案（写"这里原先写的是…"），那不是页面在说。
// ⚠ 这个坑踩过两次：JS 注释一次（修 bug 的说明里写了旧字段名）、HTML 注释一次（这段注释本身
//   引用了那句旧提示，判据立刻红）。剥注释后要能被下面那条负样本证明"代码/字符串没被一起吃掉"。
const spoken = html
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
const staleHits = (s) => STALE.filter(([p]) => s.includes(p)).map(([p, why]) => p + '（' + why + '）');
const sHit = staleHits(spoken);
check('页面里没有"指向旧位置"的过期文案（' + STALE.length + ' 条已修的原话不再出现）',
  sHit.length === 0, sHit.join('；'));
// 负样本走同一个函数：把其中一句塞回一个**会显示出来**的字符串里，必须被抓到。
check('负样本：把"先在下面的行星表里把天体加好"塞回可见文案会被同一处抓到',
  staleHits(spoken.replace('点「✛ 点画面放行星」', '先在下面的行星表里把天体加好')).length > 0, '');

fs.writeFileSync(path.join(__dirname, '_check_bio_page.txt'), out.join('\n') + '\n', 'utf8');
console.log(out.join('\n'));
process.exit(bad ? 1 : 0);
