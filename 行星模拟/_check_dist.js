// 构建期去注释的判据（A 层）：源码保留注释，发布产物去掉注释，两边必须同步。
//
// 为什么这条判据不能省：`viewer/universe.html` 的注释是物理口径说明书（56KB），
// 从源码删掉不可逆；但用户下载 135KB 时并不需要读它们，所以去掉注释这件事
// 只能发生在生成环节。一旦源码改了却没重新生成，线上就会发一份旧页面 ——
// 它照样能打开、照样能跑，**没有任何症状**。所以"同步"必须由退出码盯着。
//
// 另外三件事一起钉住：
//   1. 可复现：同输入两次生成逐字节相同；
//   2. 剥得干净：除首行声明外不再有 HTML/CSS/JS 注释；
//   3. 行号可回查：注释换成空格而不是删行，产物第 n 行（n>=2）= 源码第 n-1 行。
// 词法的对抗用例走的是生成器**同一个函数**（lexJs/scanCss/build），
// 不是另写一套正则去"模拟"它 —— 那只能证明两套错法一致。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const LOG = [];
const _print = console.log.bind(console);
console.log = (...a) => { LOG.push(a.join(' ')); _print(...a); };
process.on('exit', () => {
  fs.writeFileSync(__dirname + '/_check_dist.txt', LOG.join('\n') + '\n', 'utf8');
});

let fail = 0, n = 0;
const ok = (c, m) => { n++; if (c) console.log('  PASS  ' + m); else { fail++; console.log('  FAIL  ' + m); } };

const ROOT = path.join(__dirname, 'starpivot');
const SRC = path.join(ROOT, 'viewer', 'universe.html');
const OUT = path.join(ROOT, 'viewer', 'dist', 'universe.html');
const WEBAPP = path.join(ROOT, 'tools', 'webapp.py');
const m = require(path.join(ROOT, 'tools', 'build_viewer.js'));

if (!fs.existsSync(SRC)) { ok(false, '源码存在（viewer/universe.html）'); console.log('\n[dist] n=' + n + ' fail=' + fail); process.exit(1); }
const src = fs.readFileSync(SRC, 'utf8');
const built = m.build(src);

// ---- 1. 产物存在，且与源码同步（与 `--check` 同一条等式）----
const hasOut = fs.existsSync(OUT);
ok(hasOut, '产物存在（viewer/dist/universe.html）');
if (hasOut) {
  const cur = fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
  ok(cur === built.text, '产物与源码同步（改了源码没重跑 node tools/build_viewer.js 会红）');
} else {
  ok(false, '产物与源码同步（产物缺失）');
}

// ---- 2. 可复现：两次生成逐字节相同 ----
const again = m.build(src);
ok(again.text === built.text, '确定性：同输入生成两次逐字节相同');

// ---- 3. 源码注释没被删（这是上游承诺：一个字节都不动）----
ok(built.stats.total > 1000, '源码仍保留注释（' + built.stats.total + ' 处；不因构建而减少）');

// ---- 4. 产物剥干净：除首行声明外 0 注释 ----
{
  const nodes = m.scanHtml(built.text);
  let html = 0, css = 0, js = 0;
  for (const node of nodes) {
    if (node.type === 'comment') { html++; continue; }
    const body = built.text.slice(node.start, node.end);
    if (node.type === 'script') js += m.lexJs(body).length; else css += m.scanCss(body).length;
  }
  ok(html === 1 && css === 0 && js === 0,
     '产物无残留注释（html ' + html + ' / css ' + css + ' / js ' + js + '；html 仅首行声明）');
}

// ---- 5. 产物脚本仍能编译（去注释不许切坏语法）----
{
  const scripts = m.scanHtml(built.text).filter(x => x.type === 'script');
  let bad = '';
  for (const s of scripts) {
    try { new vm.Script(built.text.slice(s.start, s.end), { filename: 'dist#script' }); }
    catch (e) { bad = String(e && e.message || e); break; }
  }
  ok(scripts.length > 0 && !bad, '产物内联脚本通过语法编译' + (bad ? ' — ' + bad : ''));
}

// ---- 6. 头部声明：源 sha / 生成器 / 行号映射 ----
{
  const first = built.text.split('\n')[0];
  const sha = require('crypto').createHash('sha256')
    .update(src.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'), 'utf8').digest('hex').slice(0, 16);
  ok(first.includes(sha) && first.includes('build_viewer.js') && first.includes('勿手改'),
     '产物首行写明来源与源 sha256（' + sha + '）');
  ok(first.includes('第 n 行') && first.includes('n-1'), '首行写明行号映射（产物 n 行 = 源码 n-1 行）');
}

// ---- 7. 行号 1:1：整行注释在产物里必须变成空白行，行数只多首行 ----
{
  const sl = src.replace(/\r\n/g, '\n').split('\n');
  const dl = built.text.split('\n');
  ok(dl.length === sl.length + 1, '行数守恒（源码 ' + sl.length + ' 行 → 产物 ' + dl.length + ' 行）');
  const blanked = [];
  for (let i = 0; i < sl.length && blanked.length < 3; i++) {
    const t = sl[i].trim();
    if (!t) continue;
    const isCommentLine = /^(\/\/|\/\*|\*|<!--)/.test(t);
    if (isCommentLine && (dl[i + 1] || '').trim() === '') blanked.push(i + 1);
  }
  ok(blanked.length === 3, '整行注释映射正确（源码第 ' + blanked.join('/') + ' 行在产物中为空白行，行号不变）');
}

// ---- 8. 词法对抗用例：https://、正则、字符串、模板 ${}、除号 ----
{
  const cases = [
    { name: '字符串里的 // 不切', code: "const u = 'https://a//b'; // real", want: 1 },
    { name: '正则字面量 /\\/\\// 不切', code: 'const r = /\\/\\//g; /* real */', want: 1 },
    { name: '模板串里的 // 不切，${} 内注释照切', code: 'const t = `a//b${x /* in */}`; // real', want: 2 },
    { name: '除号不是正则也不是注释', code: 'const q = a / b / c;', want: 0 },
    { name: '模板 ${} 内嵌套对象与正则', code: 'const s = `${ {k: "/\\/"}.k }x`; // real', want: 1 },
  ];
  for (const c of cases) {
    let got = -1, err = '';
    try { got = m.lexJs(c.code).length; } catch (e) { err = String(e.message || e); }
    ok(!err && got === c.want, '词法：' + c.name + '（注释 ' + got + '/' + c.want + '）' + (err ? ' — ' + err : ''));
  }
  // CSS：url() 里的 /* 不是注释
  {
    const css = 'a{background:url(https://x/*y*/z)} /* real */';
    let got = -1, err = '';
    try { got = m.scanCss(css).length; } catch (e) { err = String(e.message || e); }
    ok(!err && got === 1, '词法：CSS url() 内的 /* 不当注释（注释 ' + got + '/1）' + (err ? ' — ' + err : ''));
  }
  // 端到端：迷你文档过 build()，注释被等长空格替换且换行保留
  {
    const mini = '<!doctype html>\n<!-- head -->\n<script>\nconst u="https://a//b"; // tail\n</script>\n';
    const b = m.build(mini);
    ok(b.text.includes('const u="https://a//b";') && !b.text.includes('tail')
       && b.text.split('\n').length === mini.split('\n').length + 1,
       '端到端：注释被替换为空格，代码与行数不变');
  }
}

// ---- 9. 负样本走同一个函数：真改动必须让"同步"这条等式不成立 ----
{
  const mutated = m.build(src + '\n<!-- appended -->\n');
  ok(mutated.text !== built.text, '负样本：源码变了而产物没重生成 → 同步判据必红');
  const strip = m.build('<script>var a=1; // x\nvar b=2;</script>');
  ok(!strip.text.includes('// x') && strip.text.includes('var a=1;') && strip.text.includes('var b=2;'),
     '负样本：真注释确实被剥（同一函数，不是另写一套）');
}

// ---- 10. 网关确实发产物 ----
{
  const py = fs.readFileSync(WEBAPP, 'utf8');
  ok(py.includes('"/universe": "dist/universe.html"'), '网关 /universe 指向产物');
  ok(py.includes('"/universe.html": "dist/universe.html"'), '网关 /universe.html 指向产物');
}

// 证据：产物体积与 gzip（不设阈值，只落数字）
console.log('  INFO  产物 bytes=' + Buffer.byteLength(built.text, 'utf8')
  + ' gzip6=' + zlib.gzipSync(Buffer.from(built.text, 'utf8'), { level: 6 }).length);
console.log('\n[dist] n=' + n + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
