// 小朋友页的判据（A 层）：把"给小孩看"写成一条会红的规则。
//
// 为什么要有它：这个仓库反复吃过同一个亏 —— **只写在意图里的标准都会漂**
// （"全部用观测值"、"交叉编译不可用"、"最大偏差在容差内"都是这么来的）。
// "给孩子看"如果不写成判据，迟早会漂回"术语堆"。
//
// 规则本身（照着量出来的事实定的，不是拍脑袋）：
//   另三页的术语密度是 3.81% / 4.10% / 4.16%（见 _check_home.js 同批的评估），
//   而给孩子看的材料一般要 < 0.5%。所以这里：
//     ① **正文**（`<details>` 之外的部分）不得出现任何"黑名单"里的词；
//     ② 正文术语密度 < 0.5%（用与另三页**同一份**术语表，数字才可比）；
//     ③ 正文汉字数 ≥ 120 —— 否则"用空白通过术语检查"就成了作弊路径；
//     ④ 被挡在正文外的那些词（AU、开普勒…）必须**真的**躺进 `<details>` 里：
//        证明我们是"把术语挪到该去的地方"，不是"删掉了"。
//   还有一条：页面不许自己算周期（不许出现 a^1.5 这类式子）——
//   它必须读内核回显的 `sampling.min_period_years`。
const fs = require('fs');
const path = require('path');

const LOG = [];
const _print = console.log.bind(console);
console.log = (...a) => { LOG.push(a.join(' ')); _print(...a); };
process.on('exit', () => {
  fs.writeFileSync(path.join(__dirname, '_check_kids.txt'), LOG.join('\n') + '\n', 'utf8');
});

let n = 0, fail = 0;
const ok = (c, m) => { n++; if (c) console.log('  PASS  ' + m); else { fail++; console.log('  FAIL  ' + m); } };

const KIDS = path.join(__dirname, 'starpivot', 'viewer', 'kids.html');
const WEBAPP = path.join(__dirname, 'starpivot', 'tools', 'webapp.py');
if (!fs.existsSync(KIDS)) {
  ok(false, '小朋友页存在（starpivot/viewer/kids.html）');
  console.log('\n[kids] n=' + n + ' fail=' + fail);
  process.exit(1);
}
const html = fs.readFileSync(KIDS, 'utf8');

// ---- 提取器：正文 vs 折叠起来的部分 ----
// 折起来的部分（<details>）是**孩子主动点开**才看的，术语放那里是允许的 ——
// 这一点必须写进判据，否则"术语一律不许出现"会逼着人去删掉必要的解释。
const strip = (s) => s
  .replace(/<style[\s\S]*?<\/style>/g, '')
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&[a-z]+;/g, ' ')
  .replace(/\s+/g, ' ');

const optIn = [...html.matchAll(/<details>([\s\S]*?)<\/details>/g)].map(m => m[1]);
const bodyHtml = html.replace(/<details>[\s\S]*?<\/details>/g, ' ');
const body = strip(bodyHtml);
const zhOf = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length;

// 黑名单：正文里一个都不许有。挑的都是"小孩要么不认识、要么会理解错"的词。
const BLACK = ['内核', '判据', '标定', '阈值', '积分', '辛', '半长轴', '偏心率', '近心点',
  '升交点', '倾角', '辐照度', '光度', '有效温度', '视差', '星等', '初值', '角动量', '自由度',
  '吸积', '碎裂', '星下点', '编目', 'TLE', 'SGP4', 'Hermite', '蛙跳', '开普勒', '数值', '参数',
  '模型', 'CLI', 'JSON', 'API', 'AU', 'M☉', '轨道根数', '速度', '质量', '公式'];
// 与另三页同一份术语表 —— 数字可比才有意义。
const TERMS = ['内核', '积分', '判据', '标定', '推导', '阈值', '轨道根数', '半长轴', '偏心率',
  '近地点', '升交点', 'SGP4', 'TLE', 'Hermite', '蛙跳', '辛', '辐照度', '光度', '有效温度',
  '开普勒', '数值', '初值', '自由度', '角动量', 'J2', '光压', '吸积', '碎裂', '演化', '星下点',
  '编目', '视差', '星等'];

// ---- 1. 基本 ----
ok(/<title>[^<]{4,}<\/title>/.test(html), '有实质的 <title>');
ok(/<meta\s+name="viewport"/i.test(html), '声明了 viewport（手机上要能看）');
ok(/lang="zh-CN"/.test(html), '声明了页面语言');
const compile = (code) => {
  try { new (require('vm').Script)(code, { filename: 'kids.html#script' }); return ''; }
  catch (e) { return String((e && e.name) || 'Error') + ': ' + String((e && e.message) || e); }
};
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const synErr = scripts.map(compile).find(Boolean) || '';
ok(scripts.length > 0 && !synErr, '内联脚本通过语法编译（' + scripts.length + ' 段）'
   + (synErr ? ' — ' + synErr.split('\n')[0] : ''));
ok(/SyntaxError/.test(compile('function broken( {')), '负样本：坏脚本会被同一处抓到（自证判据有效）');

// ---- 2. 正文不许出现黑名单里的词 ----
const hits = BLACK.filter(w => body.includes(w));
ok(hits.length === 0, '正文里没有"小孩看不懂"的词（黑名单 ' + BLACK.length + ' 个）'
   + (hits.length ? ' — 出现：' + hits.join('、') : ''));
{
  const neg = BLACK.filter(w => (body + ' 这里是内核').includes(w));
  ok(neg.length > 0, '负样本：往正文塞一个黑名单词会被同一处抓到（自证判据有效）',
     neg.length ? '' : '塞了"内核"却仍然"通过"');
}

// ---- 3. 密度 < 0.5%，且正文不能靠"写得少"过关 ----
const zh = zhOf(body);
const termHits = TERMS.reduce((s, w) => s + (body.split(w).length - 1), 0);
const density = 100.0 * termHits / Math.max(zh, 1);
ok(density < 0.5, '正文术语密度 ' + density.toFixed(2) + '% < 0.5%'
   + '（另三页是 3.81% / 4.10% / 4.16%）');
ok(zh >= 120, '正文有实质内容（' + zh + ' 个汉字 ≥ 120）—— 排除"用空白通过术语检查"');

// ---- 4. 孩子要看到的东西在不在 ----
const NEED = [['点', '给出"点一下就放"的动作'], ['多', '能调远近'], ['扁', '能调路的形状'],
  ['转一圈', '把"转一圈要多久"讲成人话'], ['年', '用"年"这个熟悉的单位']];
const miss = NEED.filter(([k]) => !body.includes(k)).map(([, why]) => why);
ok(miss.length === 0, '正文里有孩子要的那些东西（' + NEED.length + ' 项）'
   + (miss.length ? ' — 缺：' + miss.join('；') : ''));

// ---- 5. 术语没被删掉，而是挪进了折叠区 ----
const inOpt = strip(optIn.join(' '));
ok(optIn.length >= 2, '有两个折叠区（给好奇的人 / 这些词什么意思）');
ok(inOpt.includes('AU') && inOpt.includes('开普勒'),
   '被挡在正文外的术语（AU、开普勒…）真的躺在折叠区里 —— 是"挪走"，不是"删掉"',
   '折叠区里找不到它们');
ok(/sampling\.min_period_years/.test(scripts.join('')),
   '页面读的是内核回显的"一圈多久"（sampling.min_period_years），不是自己算的');
ok(!/Math\.pow\([^)]*1\.5|\*\*\s*1\.5/.test(scripts.join('')),
   '页面没有自己实现 a^1.5 那类公式（"页面不算物理"这条规矩在这一页也成立）');

// ---- 6. 真的能进得来 ----
const app = fs.readFileSync(WEBAPP, 'utf8');
ok(/"\/kids"\s*:\s*"kids\.html"/.test(app), '网关有 `/kids` 路由（否则这页访问不到）');
const home = fs.readFileSync(path.join(__dirname, 'starpivot', 'viewer', 'home.html'), 'utf8');
ok(/href="kids\.html"/.test(home), '首页有指向这一页的入口（孩子得找得到）');
const kidsLinksBack = /href="home\.html"/.test(html);
ok(kidsLinksBack, '这一页能回到首页（不会变成死胡同）');

// ---- 7. 文字对比度：承载文字的令牌必须在各自的**实际底色**上 ≥4.5:1 ----
// 为什么补这一条：改版把表头 / 页脚 / 版本行从 ink2 换成了 ink3（#948872），
// 实测在 --card2 上只有 3.27:1 —— 低于 AA，而表头是 fs-xs 的小字，属于回归。
// 口径：从 CSS 里把令牌读出来，用 WCAG 相对亮度公式自己算 —— 配色再被改一次，这里先红。
const _lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const _lum = (h) => {
  const rgb = [0, 2, 4].map(i => parseInt(h.slice(1 + i, 3 + i), 16) / 255).map(_lin);
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
};
const contrast = (fg, bg) => {
  const a = _lum(fg), b = _lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
// 这一处判断本身要能被负样本走一遍。
const textOK = (fg, bg) => contrast(fg, bg) >= 4.5;
const tok = (h, k) => {
  const m = h.match(new RegExp('--' + k + ':\\s*(#[0-9a-fA-F]{6})'));
  return m ? m[1] : null;
};
{
  const grounds = [tok(html, 'bg'), tok(html, 'card'), tok(html, 'card2')];
  const inks = ['ink', 'ink2', 'ink3'].map(k => tok(html, k));
  console.log('  [对比度] 小朋友页（暖色底）  ' + grounds.join(' / '));
  grounds.forEach(g => console.log('    on ' + g + '  ' + inks
    .map((v, i) => ['ink', 'ink2', 'ink3'][i] + ' ' + contrast(v, g).toFixed(2)).join('   ')));
  const bad = [];
  ['ink', 'ink2', 'ink3'].forEach(k => {
    const v = tok(html, k);
    grounds.forEach(g => { if (!textOK(v, g)) bad.push(k + ' on ' + g + ' = ' + contrast(v, g).toFixed(2)); });
  });
  ok(bad.length === 0, 'ink / ink2 / ink3 在各自的 bg、card、card2 上都 ≥4.5:1'
    + (bad.length ? ' — 不达标：' + bad.join('；') : ''));
  const bg = tok(html, 'bg');
  ok(contrast(tok(html, 'ink'), bg) > contrast(tok(html, 'ink2'), bg)
     && contrast(tok(html, 'ink2'), bg) > contrast(tok(html, 'ink3'), bg),
     '三级层次仍是三级（同一底色上 ink > ink2 > ink3，没被压成同一个色）：'
     + inks.map(v => contrast(v, bg).toFixed(2)).join(' > '));
  // 负样本走同一个 textOK：回归前的那个 ink3 值必须被判成不达标。
  ok(!textOK('#948872', bg) && !textOK('#948872', tok(html, 'card2')),
     '负样本：回归前的 ink3 #948872 在暖色 --bg / --card2 上会被同一处判成不达标（自证判据有效）');
}

// ---- 8. 玩法：拆成可判的函数，负样本走同一个函数 ----
const bodyOf = (h) => strip(h.replace(/<details>[\s\S]*?<\/details>/g, ' '));
const scriptOf = (h) => [...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const playFacts = (h) => {
  const b = bodyOf(h);
  const s = scriptOf(h);
  const colFn = s.slice(s.indexOf('function colPayload'), s.indexOf('function drawColPaths'));
  return {
    guessUI: /id="guess"/.test(h) && (h.match(/data-g="(near|double|much)"/g) || []).length === 3,
    ruleLabeled: /玩法规则/.test(b) && /不是大自然的规定/.test(b),
    buckets: /NEAR_MAX\s*=\s*1\.5/.test(s) && /DOUBLE_MAX\s*=\s*2\.4/.test(s)
             && /function bucketOf/.test(s),
    bothBranches: /你猜对了/.test(s) && /没猜中/.test(s),
    firstTimeNoAsk: /tried\.length > 0/.test(s),
    discloseScale: /450\s*倍/.test(b) && /画大/.test(b),
    noFragment: !/fragment/.test(h),
    kernelEvents: /events/.test(s) && /mass_before/.test(s) && /mass_after/.test(s),
    framesTrail: /col\.frames\[i\]\.p\[/.test(s),
    noPrimaryInCol: colFn.length > 0 && !/\bprimary\s*:/.test(colFn)
  };
};
{
  const f = playFacts(html);
  ok(f.guessUI, '玩法 A：有"猜一猜"面板与三个猜测按钮（和刚才差不多 / 长一倍左右 / 长得多）');
  ok(f.ruleLabeled, '玩法 A：对错判定被明写成"玩法规则…不是大自然的规定"（不冒充物理结论）');
  ok(f.buckets, '玩法 A：分档界（1.5 / 2.4）与分档函数在页面里，输入是回执给的两个周期值');
  ok(f.bothBranches, '玩法 A：猜中与猜错两条路都有文案（猜错不许假装对）');
  ok(f.firstTimeNoAsk, '玩法 A：只有"已经试过一次"（tried 非空）才先问，第一次进来不问');
  ok(f.discloseScale, '玩法 B：半径放大 450 倍在正文里明说了（不披露就是让人以为行星真有那么大）');
  ok(f.noFragment, '玩法 B：小朋友页没有用 fragment（碎裂会炸出上百个天体，不适合这一页）');
  ok(f.kernelEvents, '玩法 B：撞上时讲的话（年份 / 撞前撞后多重）读的是回执 events 里的字段');
  ok(f.framesTrail, '玩法 B：轨迹是回执的逐帧位置画的（没有为好看重画理想椭圆）');
  ok(f.noPrimaryInCol, '玩法 B：碰撞请求不带 primary（实测 solar:sun + primary 会被网关拒 400）');
  // 负样本：同一个 playFacts，改坏哪一处就该红哪一处。
  ok(!playFacts(html.replace(/data-g="much"/, '')).guessUI,
     '负样本：拿掉一个猜测按钮，同一处会判"面板不完整"（自证判据有效）');
  ok(!playFacts(html.replace(/450/g, '999')).discloseScale,
     '负样本：把 450 改成别的数，同一处会判"没披露放大倍数"（自证判据有效）');
  ok(!playFacts(html.replace(/玩法规则/g, '别的东西')).ruleLabeled,
     '负样本：把"玩法规则"那句抹掉，同一处会判"没标成玩法"（自证判据有效）');
}

// ---- 9. 触屏 / 自适应：只能验"结构性声明"（本机没有浏览器，像素级布局验不了）----
const touchFacts = (h) => ({
  viewportCover: /viewport-fit=cover/.test(h),
  safeArea: /env\(safe-area-inset-/.test(h),
  tapHighlight: /-webkit-tap-highlight-color/.test(h),
  touchAction: /touch-action\s*:\s*manipulation/.test(h),
  ctrlFont: /font-size\s*:\s*max\(16px/.test(h),
  tablet: /@media\(min-width:561px\) and \(max-width:1024px\)/.test(h),
  tapTarget: (() => {
    const m = h.match(/@media\(pointer:coarse\)\{([\s\S]*?)\n\s*\}/);
    return !!m && /min-height:44px/.test(m[1]);
  })()
});
{
  const t = touchFacts(html);
  ok(t.viewportCover, '触屏：viewport 声明了 viewport-fit=cover（刘海屏才拿得到安全区尺寸）');
  ok(t.safeArea, '触屏：用了 env(safe-area-inset-*)，刘海 / Home 指示条不会压住内容');
  ok(t.tapHighlight, '触屏：声明了 -webkit-tap-highlight-color（点按不再闪系统灰）');
  ok(t.touchAction, '触屏：画布声明了 touch-action:manipulation（这一页的玩法就是"点一下画布"）');
  ok(t.ctrlFont, '触屏：表单控件字号 ≥16px（否则 iOS Safari 一聚焦就整页放大）');
  ok(t.tablet, '自适应：有 561–1024px 平板档（iPad 竖 768 / 横 1024）');
  ok(t.tapTarget, '触屏：触摸档里声明了最小点击区 44px');
  ok(!touchFacts(html.replace(/env\(safe-area-inset-/g, 'env(zz-safezone-')).safeArea,
     '负样本：去掉安全区声明会被同一处抓到（自证判据有效）');
  ok(!touchFacts(html.replace(/min-height:44px/g, 'min-height:4px')).tapTarget,
     '负样本：把最小点击区改回 4px 会被同一处抓到（自证判据有效）');
}

console.log('\n[kids] n=' + n + ' fail=' + fail);
process.exit(fail ? 1 : 0);
