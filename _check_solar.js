// 判据：网页端"太阳系可选"三档是否真的接到了内核的 --solar 上。
// 同样把 universe.html 里的原文抠出来跑，不重写一份副本。
const fs = require('fs');
const p = 'C:/Users/geral/WorkBuddy/2026-09-24-16-11-48/starpivot/viewer/universe.html';
const h = fs.readFileSync(p, 'utf8');

function grab(name) {
  const start = h.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到 ' + name);
  let depth = 0, i = h.indexOf('{', start);
  for (; i < h.length; i++) {
    if (h[i] === '{') depth++;
    else if (h[i] === '}' && --depth === 0) return h.slice(start, i + 1);
  }
  throw new Error('括号不匹配 ' + name);
}
function grabBlock(anchor) {
  const start = h.indexOf(anchor);
  if (start < 0) throw new Error('找不到 ' + anchor);
  let depth = 0, i = h.indexOf('{', start);
  for (; i < h.length; i++) {
    if (h[i] === '{') depth++;
    else if (h[i] === '}' && --depth === 0) return h.slice(start, i + 1);
  }
  throw new Error('括号不匹配 ' + anchor);
}

// 证据通道：同上（子进程 stdout 接不出来），结论必须落盘。
const LOG = [];
const _print = console.log.bind(console);
console.log = (...a) => { LOG.push(a.join(' ')); _print(...a); };
process.on('exit', () => {
  fs.writeFileSync(__dirname + '/_check_solar.txt', LOG.join('\n') + '\n', 'utf8');
});

let fails = 0;
const bad = (m) => { console.log('FAIL: ' + m); fails++; };
const ok = (m) => console.log('ok  : ' + m);

// ---- 1. 整段内联脚本要能解析（改名后最容易被"漏改一处"打穿）----
const m = h.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/);
if (!m) { bad('找不到内联 <script>'); process.exit(1); }
try { new Function(m[1]); ok('内联脚本语法检查通过'); }
catch (e) { bad('内联脚本语法错误: ' + e.message); }

// ---- 2. 脚本引用的每个 $('id') 都必须在 HTML 里真实存在 ----
{
  const ids = new Set([...m[1].matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map(x => x[1]));
  const declared = new Set([...h.matchAll(/\sid="([A-Za-z0-9_]+)"/g)].map(x => x[1]));
  const missing = [...ids].filter(x => !declared.has(x));
  if (missing.length) bad('脚本引用了不存在的 id: ' + missing.join(', '));
  else ok(`全部 ${ids.size} 个 $('id') 引用都能在 HTML 里找到`);
}

// ---- 3. 改名的那个控件不能留下悬空引用 ----
if (m[1].includes("withsolar")) bad('仍残留 withsolar 引用');
else ok('withsolar 已全部替换为 solarmode');

// ---- 4. 三档选择框确实存在，且选项值就是内核认的那三个 ----
{
  const sel = h.match(/<select id="solarmode"[\s\S]*?<\/select>/);
  if (!sel) { bad('找不到 #solarmode'); }
  else {
    const vals = [...sel[0].matchAll(/value="([a-z]+)"/g)].map(x => x[1]);
    const want = ['full', 'sun', 'none'];
    if (JSON.stringify(vals) !== JSON.stringify(want))
      bad('solarmode 选项应为 ' + want + '，实际 ' + vals);
    else ok('solarmode 三档 = full / sun / none（与 CLI --solar 一致）');
  }
}

// ---- 5. 真正跑一遍 compute() 的 payload 构造 ----
// 这一步是本探针独有的：其他探针（D2 真 HTTP、E 层页面级）只验"内核认不认 solar"，
// 没人验"页面把 UI 档位翻译成 payload 时有没有翻错"。页面改一处、这里就该响。
// 该 block 是页面原文，依赖两个外部名字：typeByKey()（页面函数）与 primaryOverride。
//   * typeByKey 也从页面原文抠（`const typeByKey = ...` 不是 function 声明，grab 抓不到）。
//   * bodyTypes 是运行期由内核回显填充的，页面级探针拿不到 → 这里喂**最小契约桩**，
//     只提供这段代码唯一会读的字段 emits_light。真正的类型表由 D1d（真内核 catalog）负责，
//     两边不互相替代：这里验的是"页面怎么用这个字段"，不是"字段值对不对"。
{
  const tk = h.match(/const typeByKey = [^\n]*/);
  if (!tk) { bad('找不到页面的 typeByKey 定义'); process.exit(1); }
  const typeByKey = new Function('bodyTypes', tk[0] + '\nreturn typeByKey;')([
    { key: 'star', emits_light: true },
    { key: 'planet', emits_light: false },
  ]);
  if (typeByKey('star') !== undefined && !typeByKey('star').emits_light)
    bad('typeByKey 桩没生效（页面那行可能被改写了）');

  const block = grabBlock("if (sc === 'custom') {");
  // 抠原文跑，头号失效方式是"漏喂一个外部名字"：页面把某个自由变量抽成了具名函数，
  // 探针这边还是老的那几个 —— 于是 ReferenceError，整条探针当场死掉。
  // 这个坑已经踩过两次：typeByKey、payloadBody（后者是 2026-09-26 抽具名函数时踩的）。
  // 所以两道防线：
  //   1) 静态交叉检查：页面上（顶层）声明过的名字，只要被这段 block 引用到，就必须已注入。
  //      按缩进识别顶层声明是依赖页面风格的，认不出来就退化成不检查 —— 宁可少查，不误报。
  //   2) 运行时 try/catch：真漏了就把异常当成一条 FAIL 报出来（带名字），
  //      而不是让整条探针以 ReferenceError 退出、只留一份上一轮的旧证据。
  const injected = ['sc', '$', 'customBodies', 'typeByKey', 'primaryOverride', 'payloadBody'];
  const payloadBody = new Function(grab('payloadBody') + '\nreturn payloadBody;')();
  {
    const topDecl = [...h.matchAll(/^ {2}(?:function|const)\s+([A-Za-z_$][\w$]*)/gm)].map(x => x[1]);
    const used = new Set([...block.matchAll(/([A-Za-z_$][\w$]*)/g)].map(x => x[1]));
    const missing = topDecl.filter(nm => used.has(nm) && !injected.includes(nm));
    if (missing.length) bad('block 引用的顶层名字没喂进去：' + missing.join(', '));
    else ok(`block 引用到的顶层名字都已在 runBlock 注入（在 ${topDecl.length} 个顶层声明里交叉查过）`);
  }
  const runBlock = (mode, bodies, primaryOverride) => {
    const $ = (id) => ({ value: id === 'solarmode' ? mode : 'custom' });
    try {
      return new Function(
        'sc', '$', 'customBodies', 'typeByKey', 'primaryOverride', 'payloadBody',
        `const payload = {scenario: sc}; ${block} return payload;`
      )('custom', $, bodies, typeByKey, primaryOverride, payloadBody);
    } catch (e) {
      bad(`${mode}: 跑这段 block 时抛异常 —— ${e.message}（多半是又有名字没喂进去）`);
      return {};
    }
  };

  // 5a. 两颗行星（都不会发光）→ 三档都正确下发，且永不猜 primary
  const twoPlanets = [
    { name: 'A', a: 1.0, e: 0.2, inc: 0, raan: 0, argp: 0, M0: 0, mass: 3.0e-6, radius_km: 6371, type: 'planet' },
    { name: 'B', a: 1.0, e: 0.2, inc: 0, raan: 0, argp: 180, M0: 135, mass: 3.0e-6, radius_km: 6371, type: 'planet' },
  ];
  for (const mode of ['full', 'sun', 'none']) {
    const p = runBlock(mode, twoPlanets, null);
    if (p.solar !== mode) bad(`${mode}: payload.solar = ${p.solar}`);
    if (p.scenario !== 'custom') bad(`${mode}: scenario 被改成了 ${p.scenario}`);
    if (!p.bodies || p.bodies.length !== 2) bad(`${mode}: bodies 没带上`);
    if (p.primary !== undefined) bad(`${mode}: 没有发光天体却猜了 primary=${p.primary}`);
  }
  ok('payload.solar 三档都正确下发，scenario 保持 custom，无光源时不猜 primary');

  // 5b. 一颗恒星 + 一颗行星。这是 0.2 M☉ 红矮星那一类：
  //     日心根数配 1 M☉ 的初速会把行星甩掉，所以"背景不放太阳系"时必须把参考系交给它。
  const oneStar = [
    { name: 'Kepler-16A', a: 0, e: 0, inc: 0, raan: 0, argp: 0, M0: 0, mass: 0.2, radius_km: 200000, type: 'star' },
    { name: 'b', a: 0.05, e: 0.01, inc: 0, raan: 0, argp: 0, M0: 0, mass: 3.0e-6, radius_km: 6371, type: 'planet' },
  ];
  {
    const p = runBlock('none', oneStar, null);
    if (p.primary !== 'Kepler-16A')
      bad(`solar=none + 恰好一颗发光天体 → primary 应为 Kepler-16A，实际 ${p.primary}`);
    else ok('solar=none 且正好一颗发光天体时，参考系自动交给它（否则轻恒星会把行星甩掉）');

    const pf = runBlock('full', oneStar, null);
    if (pf.primary !== undefined)
      bad(`solar=full 时背景太阳也在原点，不该再用 primary（实际 ${pf.primary}）`);
    else ok('solar=full 时不用 primary（背景太阳已是原点，两个天体同点会让 1/r² 爆掉）');

    const ps = runBlock('sun', oneStar, null);
    if (ps.primary !== undefined)
      bad(`solar=sun 时已有中心天体，不该再用 primary（实际 ${ps.primary}）`);
    else ok('solar=sun 时不用 primary');

    // 预设显式指定的参考系（地月系统）必须优先，且不要求那颗星会发光。
    const po = runBlock('full', oneStar, 'b');
    if (po.primary !== 'b')
      bad(`primaryOverride 应优先于自动判断，实际 ${po.primary}`);
    else ok('预设显式指定的参考系优先于自动判断（地月系统靠这条）');
  }
}

// ---- 6. syncPanels 必须给出"不放太阳系"的说明（不能让页面假装没事）----
{
  const f = grab('syncPanels');
  if (!/=== 'none'/.test(f)) bad('syncPanels 里没有 none 分支');
  if (!/=== 'sun'/.test(f)) bad('syncPanels 里没有 sun 分支');
  else if (!/\$\('solarhint'\)\.textContent/.test(f)) bad('solarhint 没被写入');
  else ok('切到 none 时会写出"没有中心天体"的如实说明');
}

console.log(fails ? `\n${fails} 项失败` : '\n全部判据通过');
process.exit(fails ? 1 : 0);
