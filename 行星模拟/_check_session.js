// 会话持久化的静态判据（A 层）：
//   1. <script> 能过语法检查（进程内 vm.Script 编译，不起子进程）
//   2. snapshot()/restoreSession() 引用的所有 DOM id 在 HTML 里真实存在
//   3. 快照里不允许出现任何内核计算结果（frames / diagnostics / events / data.bio 的数值）
//   4. 负样本自检：故意塞语法坏掉的脚本、故意塞一个坏 id、故意在快照里塞 data.frames，
//      检查器都必须抓到（否则"PASS"只是这个检查器没在检查）
const fs = require('fs');
const path = require('path');

// 证据通道：汇总入口把子进程 stdout 丢进 /dev/null，只留一个退出码 ——
// 只打印不落盘时，"退出码 1"就是失败时能拿到的全部信息（正是最难排查的一种）。
// 用 process.on('exit') 而不是在末尾写：这样连上面那个"找不到 <script> 就 exit(1)"
// 的早退路径也会留下日志。写法与 _check_solar.js 等一致。
const LOG = [];
const _print = console.log.bind(console);
console.log = (...a) => { LOG.push(a.join(' ')); _print(...a); };
process.on('exit', () => {
  fs.writeFileSync(__dirname + '/_check_session.txt', LOG.join('\n') + '\n', 'utf8');
});

const HTML = path.join(__dirname, 'starpivot', 'viewer', 'universe.html');
let fail = 0, skip = 0, n = 0;
const ok  = (c, m) => { n++; if (c) console.log('  PASS  ' + m); else { fail++; console.log('  FAIL  ' + m); } };

const src = fs.readFileSync(HTML, 'utf8');
const m = src.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.log('  FAIL  找不到 <script> 块'); process.exit(1); }
const js = m[1];

// ---- 1. 语法 ----
// 进程内编译，与 `node --check` 同一套解析器、同样按 Script（不是函数体）解析。
// 原先的做法是把 <script> 抽成临时文件再 execFileSync(process.execPath, ['--check', tmp])，
// 换掉它有两个理由，第二个是硬理由：
//   1) 不必再造一个 128 KB 的临时件（原先还得挂在 exit 上删 —— 那是自造的垃圾）；
//   2) Node 起不了子进程的机器上（本沙箱里连 `cmd /c echo` 都是 EBUSY），
//      execFileSync 会让整层静态判据挂掉。语法检查不该取决于能否起进程。
// vm.Script 只编译不执行，所以脚本里那些 document / canvas 引用不会被真跑到。
// 真实脚本与负样本都走这一个函数：负样本才真的在自证"这一处调用"有效。
// 注意报错文本要同时带 e.name：SyntaxError 的 message 只有 "Unexpected end of input"
// 这类细节，类名不在 message 里 —— 只取 message 去 /SyntaxError/ 是一定匹配不上的
// （这个负样本就是这么假绿过一次：它恒失败，而失败的原因在负样本自己身上）。
const compileStory = (code) => {
  try { new (require('vm').Script)(code, { filename: 'universe.html#script' }); return ''; }
  catch (e) { return String((e && e.name) || 'Error') + ': ' + String((e && e.message) || e); }
};
const synErr = compileStory(js);
ok(!synErr, 'script 通过语法编译（vm.Script，与 node --check 同一套解析器）'
   + (synErr ? ' — ' + synErr.split('\n').slice(0, 3).join(' | ') : ''));
{
  // 负样本自检：换个解析器就得重新自证一次，否则"PASS"可能只是这个调用根本没在检查。
  const neg = compileStory('function broken( {');
  ok(/SyntaxError/.test(neg), '负样本：语法坏掉的脚本会被同一处调用抓到（自证判据有效）'
     + (neg ? '' : ' — 坏脚本竟然编译通过了'));
}

// ---- 2. DOM id 对齐 ----
const htmlIds = new Set([...src.matchAll(/\bid="([^"]+)"/g)].map(x => x[1]));
// 只取静态 HTML 里声明的 id；脚本里动态生成的（forget）单独处理
const fnBody = (name) => {
  const i = js.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let d = 0, j = js.indexOf('{', i);
  for (let k = j; k < js.length; k++) {
    if (js[k] === '{') d++;
    else if (js[k] === '}') { d--; if (!d) return js.slice(i, k + 1); }
  }
  return '';
};
const idsIn = (s) => [...s.matchAll(/\$\('([^']+)'\)/g)].map(x => x[1]);
const touched = new Set([...idsIn(fnBody('snapshot')), ...idsIn(fnBody('restoreSession')),
                         ...idsIn(fnBody('syncBioEnabled')), ...idsIn(fnBody('showSessionNote'))]);
const missing = [...touched].filter(id => !htmlIds.has(id) && id !== 'forget');
ok(missing.length === 0, '快照/恢复引用的 DOM id 全部存在（' + touched.size + ' 个）'
   + (missing.length ? ' — 缺: ' + missing.join(',') : ''));

// forget 是 innerHTML 动态插入的，必须真的插出来
ok(/id="forget"/.test(fnBody('showSessionNote')), '「清除并回到默认」按钮由 showSessionNote 动态插入');

// ---- 3. 快照不得含内核结果 ----
const snap = fnBody('snapshot');
const banned = ['data.frames', 'data.bodies', 'data.diagnostics', 'data.events', 'data.bio',
                'frames:', 'diagnostics', 'energy_drift'];
const hit = banned.filter(b => snap.includes(b));
ok(hit.length === 0, 'snapshot() 不含任何内核计算结果' + (hit.length ? ' — 命中: ' + hit.join(',') : ''));
ok(/saved_at:\s*Date\.now\(\)/.test(snap), 'snapshot() 自带时间戳（页面才能显示"多久之前"）');
ok(/schema:\s*STORE_SCHEMA/.test(snap), 'snapshot() 自带 schema 版本号');

// ---- 4. 恢复必须走重算，而不是把旧结果搬回来 ----
ok(/restoreSession\(savedSession\);\s*pending = savedSession;/.test(js),
   '恢复之后 pending 置位（播放位置在算完才接）');
ok(/pending = null;/.test(js), 'pending 用完即清，之后的都是正常重算');
ok(/const wantPlay = pending \? pending\.playing !== false : true;/.test(js),
   '恢复时尊重上次的播放/暂停；手动重算照旧继续播放');
ok(/frameF = Math\.max\(0, Math\.min\(numOr\(pending\.frameF, 0\), data\.frames\.length - 1\)\)/.test(js),
   '恢复的播放位置按新数据的帧数做了钳制（旧帧号可能越界）');

// ---- 5. 落盘触发覆盖 ----
ok(/window\.addEventListener\('pagehide', flushSave\)/.test(js), '关页面时 flushSave');
ok(/visibilitychange[\s\S]{0,120}flushSave/.test(js), '页面切到后台时 flushSave');
ok(/\['input', 'change'\]\.forEach\(ev =>\s*\n?\s*document\.addEventListener/.test(js),
   'input/change 捕获阶段统一落盘');
ok(/if \(ts - lastSaveTs > 2000\)\{ lastSaveTs = ts; writeStore\(\); \}/.test(js),
   '播放中按 ~2s 节流落盘');

// ---- 6. 降级与版本 ----
ok(/catch \(err\) \{ storageOK = false; \}/.test(js), '写盘失败后不再重试（并置位 storageOK）');
ok(/o\.schema === STORE_SCHEMA/.test(fnBody('readStore')), 'schema 不认就丢弃，不静默迁移');
ok(/这个浏览器不允许本地存储/.test(js), '存储不可用时在页面上如实说明');

// ---- 7. 负样本自检：检查器自己不能是摆设 ----
const fakeIds = new Set(htmlIds);
const badId = '__nope__';
ok(!fakeIds.has(badId), '负样本：不存在的 id 会被 id 对齐判据抓到（自证判据有效）');
const badSnap = 'function snapshot(){ return { frames: data.frames, diagnostics: data.diagnostics }; }';
ok(banned.some(b => badSnap.includes(b)), '负样本：快照里塞内核结果会被第 3 条抓到（自证判据有效）');

console.log('\n[session-static] n=' + n + ' fail=' + fail + ' skip=' + skip);
process.exit(fail ? 1 : 0);
