// 首页的静态判据（A 层）：页面在不在、脚本过不过语法、**该说的话有没有说**。
//
// 为什么单独给它写判据：首页此前**根本不存在** —— `/` 直接指向轨道递推工具页，
// 第一次来的人落地就在一堆轨道参数里，而这页该说的三件事（这是什么 / 数据从哪来 /
// 怎么验）没人说。补上之后，**它本身也得有判据**；否则它会成为整个页面里
// 唯一一处"没人看着"的地方，而"没有判据的地方就是会烂的地方"（这个仓库反复吃过）。
//
// 判据怎么选：不盯排版，只盯**那些说出口就是承诺的话**在不在页面上 ——
// 数据来源、四类标注（观测/标定/模型参数/假设）、诚实边界、等价命令行。
// 这些句子一旦被谁顺手删掉，是"产品开始说假话"的第一步，而在页面上看不出来。
const fs = require('fs');
const path = require('path');

// 证据通道：汇总入口把子进程 stdout 丢进 /dev/null，结论必须落盘。
const LOG = [];
const _print = console.log.bind(console);
console.log = (...a) => { LOG.push(a.join(' ')); _print(...a); };
process.on('exit', () => {
  fs.writeFileSync(__dirname + '/_check_home.txt', LOG.join('\n') + '\n', 'utf8');
});

let fail = 0, n = 0;
const ok = (c, m) => { n++; if (c) console.log('  PASS  ' + m); else { fail++; console.log('  FAIL  ' + m); } };

const HOME = path.join(__dirname, 'starpivot', 'viewer', 'home.html');
const WEBAPP = path.join(__dirname, 'starpivot', 'tools', 'webapp.py');

if (!fs.existsSync(HOME)) {
  ok(false, '首页存在（starpivot/viewer/home.html）');
  console.log('\n[home-static] n=' + n + ' fail=' + fail);
  process.exit(1);
}
const html = fs.readFileSync(HOME, 'utf8');
ok(true, '首页存在');

// ---- 1. 是完整的 HTML ----
ok(/<title>[^<]{4,}<\/title>/.test(html), '有实质的 <title>（不是占位）');
ok(/<meta\s+charset="utf-8">/i.test(html), '声明了 utf-8');
ok(/<meta\s+name="viewport"/i.test(html), '声明了 viewport（手机上不至于缩成一团）');
ok(/lang="zh-CN"/.test(html), '声明了页面语言');

// ---- 2. 内联脚本过语法编译（进程内 vm.Script，不起子进程）----
const compile = (code) => {
  try { new (require('vm').Script)(code, { filename: 'home.html#script' }); return ''; }
  catch (e) { return String((e && e.name) || 'Error') + ': ' + String((e && e.message) || e); }
};
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
let synErr = '';
scripts.forEach((s, i) => { const e = compile(s); if (e && !synErr) synErr = '#' + i + ' ' + e; });
ok(scripts.length > 0 && !synErr, '内联脚本通过语法编译（' + scripts.length + ' 段）'
   + (synErr ? ' — ' + synErr.split('\n')[0] : ''));
{
  // 负样本走**同一个函数**：换个解析器就得重新自证一次。
  const neg = compile('function broken( {');
  ok(/SyntaxError/.test(neg), '负样本：坏脚本会被同一处抓到（自证判据有效）',
     neg ? '' : '坏脚本竟然编译通过了');
}

// ---- 3. 该说的话：数据来源 + 四类标注 ----
// 走同一个函数，负样本才真的在验"这一处判断"。
const REQUIRED = [
  ['JPL',                     '行星初值来源'],
  ['Hipparcos',               '真实恒星来源'],
  ['Exoplanet Archive',       '真实系外行星来源'],
  ['Vallado',                 'TLE 传播的对齐依据'],
  ['CelesTrak',               '在轨编目的实时来源'],
  ['Natural Earth',           '陆地边界来源'],
  ['观测',                    '四类标注之一'],
  ['标定',                    '四类标注之一'],
  ['模型参数',                '四类标注之一'],
  ['假设',                    '四类标注之一（最容易被漏的那一类）'],
  ['共面',                    '写明"轨道朝向与相位是假设"'],
  ['随探测方法而异',          '写明"质量性质随方法而异"'],
  ['标定表',                  '写明恒星温度/光度为什么现在不显示'],
  ['1800',                    '写明星历精度边界（Standish 有效区间）'],
  ['starpivot nbody',         '给出可复制的等价命令行'],
  ['fail=0 skip=0',           '写明判据当前状态，且"有跳过不算全绿"'],
];
const missingIn = (s) => REQUIRED.filter(([k]) => !s.includes(k)).map(([k, why]) => why + '（缺 "' + k + '"）');
const miss = missingIn(html);
ok(miss.length === 0, '首页把该说的话都说了（' + REQUIRED.length + ' 项）'
   + (miss.length ? ' — 缺：' + miss.join('；') : ''));
{
  // 负样本：删掉"假设"这一类，必须被同一处抓到。
  const neg = missingIn(html.replace(/假设/g, ''));
  ok(neg.length > 0, '负样本：抽掉「假设」这一类会被同一处抓到（自证判据有效）',
     neg.length ? '' : '整类被删掉却仍然"通过"');
}

// ---- 4. 首页真的能被访问到（路由对得上）----
// 页写得再好，网关没把 `/` 指过来就等于不存在 —— 这正是补首页之前的状态。
const app = fs.readFileSync(WEBAPP, 'utf8');
ok(/ROUTES\s*=\s*\{[\s\S]*?"\/"\s*:\s*"home\.html"/.test(app),
   '网关把 `/` 路由到 home.html（否则这页访问不到）');
ok(/"\/orbit"\s*:\s*"index\.html"/.test(app) && /"\/universe"\s*:\s*"universe\.html"/.test(app),
   '两个工具页各有一条具名路由（/orbit、/universe）');
// 工具页要能回到首页，否则用户进了工具页就出不来。
const idx = fs.readFileSync(path.join(__dirname, 'starpivot', 'viewer', 'index.html'), 'utf8');
const uni = fs.readFileSync(path.join(__dirname, 'starpivot', 'viewer', 'universe.html'), 'utf8');
ok(/href="home\.html"/.test(idx), '轨道页有回到首页的链接');
ok(/href="home\.html"/.test(uni), '沙盒页有回到首页的链接');

// ---- 5. 文字对比度（首页 / 轨道页 / 沙盒页）----
// 与 _check_kids.js 同一套口径：从 CSS 里读令牌，用 WCAG 相对亮度自己算比值。
// 起因是一个真实回归 —— 改版把表头 / 页脚 / 版本行 / .badge.off 从 ink2 换成了 ink3，
// 而浅色页的 ink3 #828b9a 在 --card2 上只有 3.15:1；表头是 fs-xs 的小字，属于正文，必须 ≥4.5。
const _lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const _lum = (h) => {
  const rgb = [0, 2, 4].map(i => parseInt(h.slice(1 + i, 3 + i), 16) / 255).map(_lin);
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
};
const contrast = (fg, bg) => {
  const a = _lum(fg), b = _lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
const textOK = (fg, bg) => contrast(fg, bg) >= 4.5;   // 负样本也走这一处判断
const tok = (h, k) => {
  const m = h.match(new RegExp('--' + k + ':\\s*(#[0-9a-fA-F]{6})'));
  return m ? m[1] : null;
};
const PAGES = [['首页', html], ['轨道页', idx], ['沙盒页', uni]];
PAGES.forEach(([name, h]) => {
  const grounds = [tok(h, 'bg'), tok(h, 'card'), tok(h, 'card2')];
  const inks = ['ink', 'ink2', 'ink3'].map(k => tok(h, k));
  console.log('  [对比度] ' + name + '  ' + grounds.join(' / '));
  grounds.forEach(g => console.log('    on ' + g + '  ' + inks
    .map((v, i) => ['ink', 'ink2', 'ink3'][i] + ' ' + contrast(v, g).toFixed(2)).join('   ')));
  const bad = [];
  ['ink', 'ink2', 'ink3'].forEach(k => {
    const v = tok(h, k);
    grounds.forEach(g => { if (!textOK(v, g)) bad.push(k + ' on ' + g + ' = ' + contrast(v, g).toFixed(2)); });
  });
  ok(bad.length === 0, name + '：ink / ink2 / ink3 在各自的 bg、card、card2 上都 ≥4.5:1'
    + (bad.length ? ' — 不达标：' + bad.join('；') : ''));
  const bg = tok(h, 'bg');
  ok(contrast(tok(h, 'ink'), bg) > contrast(tok(h, 'ink2'), bg)
     && contrast(tok(h, 'ink2'), bg) > contrast(tok(h, 'ink3'), bg),
     name + '：三级层次仍是三级（同一底色上 ink > ink2 > ink3）：'
     + inks.map(v => contrast(v, bg).toFixed(2)).join(' > '));
});
ok(!textOK('#828b9a', tok(html, 'card2')) && !textOK('#828b9a', tok(idx, 'card2')),
   '负样本：回归前的 ink3 #828b9a 在浅色 --card2 上会被同一处判成不达标（自证判据有效）');

// 首屏那张暖色入口卡：标题必须用 ink，**不能**用 accent2。
// accent2 #b45c15 在 accent2-soft #fdf0e2 上只有 4.18:1 —— 这是"美化"时最容易顺手弄坏的一处
// （与上一轮表头 ink3 3.21 同一类：判据扫的是令牌，扫不到这种"新写出来的组合"）。
// 实测 15.55，用同一个 textOK() 判。
ok(textOK(tok(html, 'ink'), tok(html, 'accent2-soft')),
   '首屏暖色入口卡的标题色在自家底色上过 AA：ink on accent2-soft = '
   + contrast(tok(html, 'ink'), tok(html, 'accent2-soft')).toFixed(2));
ok(!textOK(tok(html, 'accent2'), tok(html, 'accent2-soft')),
   '负样本：换成 accent2 会被同一处判不达标（实测 '
   + contrast(tok(html, 'accent2'), tok(html, 'accent2-soft')).toFixed(2) + '）—— 所以标题不用它');

// ---- 6. 触屏 / 自适应：只验"结构性声明"（本机没有浏览器，像素级布局验不了）----
const touchFacts = (h) => ({
  viewportCover: /viewport-fit=cover/.test(h),
  safeArea: /env\(safe-area-inset-/.test(h),
  tapHighlight: /-webkit-tap-highlight-color/.test(h),
  touchAction: /touch-action/.test(h),
  ctrlFont: /font-size\s*:\s*max\(16px/.test(h),
  tablet: /@media\(min-width:561px\) and \(max-width:1024px\)/.test(h),
  tapTarget: (() => {
    const m = h.match(/@media\(pointer:coarse\)\{([\s\S]*?)\n\s*\}/);
    return !!m && /min-height:44px/.test(m[1]);
  })()
});
PAGES.forEach(([name, h]) => {
  const t = touchFacts(h);
  // 只有页面里真的有表单控件时才要求"控件字号 ≥16px" —— 首页一个控件都没有，不该为它编一条。
  const need = [['viewportCover', 'viewport-fit=cover'], ['safeArea', 'env(safe-area-inset-*)'],
    ['tapHighlight', '-webkit-tap-highlight-color'], ['touchAction', 'touch-action'],
    ['tablet', '561–1024 平板档'], ['tapTarget', '触摸档最小点击区 44px']];
  if (/<(input|select|textarea)\b/i.test(h)) need.push(['ctrlFont', '控件字号 ≥16px']);
  const miss = need.filter(([k]) => !t[k]).map(([, w]) => w);
  ok(miss.length === 0, name + '：触屏 / 自适应声明齐了（' + need.length + ' 项）'
    + (miss.length ? ' — 缺：' + miss.join('；') : ''));
});
ok(!touchFacts(uni.replace(/env\(safe-area-inset-/g, 'env(zz-safezone-')).safeArea
   && !touchFacts(uni.replace(/min-height:44px/g, 'min-height:4px')).tapTarget,
   '负样本：去掉安全区 / 把最小点击区改小，会被同一处抓到（自证判据有效）');

// ---- 7. 触屏够不到 hover：说明必须有"点按也能看到"的路径 ----
// universe.html 那两处说明原本只在 mouseenter 里写；触屏没有 hover，iPad 上永远看不到。
// ⚠ "把鼠标放到按钮上"这句被 _probe_play_modes.js 逐字断言 —— 只能**追加**，不能改删。
const hoverFacts = (h) => ({
  presetKeep: /把鼠标放到按钮上/.test(h),
  presetTap: /(手机\s*\/\s*iPad 上直接点一下按钮)/.test(h) && /showPresetNote\(i\);/.test(h),
  typeKeep: /把鼠标放到类型上/.test(h),
  typeTap: /(手机\s*\/\s*iPad 上直接点一下类型)/.test(h)
    && /pendingType === t\.key\) showTypeNote\(t\)/.test(h)
});
{
  const f = hoverFacts(uni);
  ok(f.presetKeep && f.presetTap,
     '沙盒页：预设说明既保留"把鼠标放到按钮上"（原判据的锚点），又补了点按路径');
  ok(f.typeKeep && f.typeTap,
     '沙盒页：天体类型说明同样保留 hover 文案，并补了"点一下类型"的触摸路径');
  ok(!hoverFacts(uni.replace(/手机\s*\/\s*iPad 上直接点一下按钮/, '')).presetTap,
     '负样本：拿掉预设的点按说明，同一处会判"触屏够不到"（自证判据有效）');
  ok(!hoverFacts(uni.replace(/pendingType === t\.key\) showTypeNote\(t\)/, '')).typeTap,
     '负样本：拿掉类型卡的点按路径，同一处会判"触屏够不到"（自证判据有效）');
}

// ---- 8. 首屏能不能一眼看到重点 ----
// 这一条来自一次**用户反馈**："给普通人的主页内容太多了，看不到重点"。
// 改版前实测：**2 158 个汉字 + 3 张表格全在首屏**，而三个入口被夹在"是/不是"两栏之后 ——
// 第一次来的人滑过去只看到表格，看不到"从哪开始"。
// 所以把"要查才查"的东西（数据来源、五层判据、等价命令、未做事项）收进 <details>，
// 首屏只留：它是什么 / 从哪开始 / 三条承诺。**内容一句没删**（第 3 组仍在逐项验它们在不在），
// 只是移到了"点开就能看"的位置。
//
// 这里只验**可测的那部分**：折叠区之外不许有表格、入口不许在折叠区里、首屏正文有字数上限。
const stripDetails = (s) => s.replace(/<details[\s\S]*?<\/details>/g, '');
const visibleZh = (s) => {
  const t = s.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ');
  return (stripDetails(t).replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').match(/[\u4e00-\u9fff]/g) || []).length;
};
const firstScreen = (s) => {
  const above = stripDetails(s);
  return {
    entries: ['kids.html', 'index.html', 'universe.html'].every(h => above.includes('href="' + h + '"')),
    noTable: !/<table/i.test(above),
    status: /id="kstatus"/.test(above),
    lead: /真在算/.test(above),
    zh: visibleZh(s),
    folded: (s.match(/<details/g) || []).length,
    summaries: [...s.matchAll(/<summary>([^<]*)<\/summary>/g)].map(m => m[1].trim()),
  };
};
const FS = firstScreen(html);
ok(FS.entries, '折叠区之外就能看到三个入口（不用点开、也不用翻过表格）');
ok(FS.noTable, '折叠区之外一张表格都没有（表格是"要查才查"的东西）');
ok(FS.status && FS.lead, '首屏留着"真在算"这句与内核在线状态条（那是首页最直接的一次自证）');
ok(FS.zh <= 420, `首屏可见正文 ≤ 420 汉字（实测 ${FS.zh}；改版前 2 158 字 + 3 张表全在首屏）`);
ok(FS.folded >= 4 && FS.summaries.length === FS.folded && FS.summaries.every(t => t.length >= 8),
   `${FS.folded} 个折叠区的标题都自己说清里面有什么（不是"更多"这种空标题）`);
{
  // 负样本：把折叠区全部展开 —— 这就是"没做这件事"时的样子，同一处必须判首屏太多。
  const neg = firstScreen(html.replace(/<details class="card">/g, '<div class="card">')
                               .replace(/<\/details>/g, '</div>'));
  ok(!neg.noTable && neg.zh > 420,
     `负样本：把折叠区全展开 → 表格回到首屏、正文涨到 ${neg.zh} 字，同一处会判不通过（自证判据有效）`);
}

console.log('\n[home-static] n=' + n + ' fail=' + fail);
process.exit(fail ? 1 : 0);
