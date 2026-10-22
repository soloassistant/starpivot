// 内核探针的「录制 / 回放」桥：让 Node 起不了子进程的机器也能把断言真跑完。
//
// 为什么需要它（不是权宜之计，是把一条环境限制变成一项能力）：
//   本沙箱里 Node 的 spawnSync / execFileSync 一律 EBUSY —— 连 `cmd /c echo` 都是。
//   而 bash→zig、bash→python、python→exe 全部正常。也就是说能执行内核的进程
//   只剩 python（和 bash），Node 只能看别人执行的结果。于是类型表、积分器、
//   --primary、时间参数、工具导出命令这几个探针在本机只能全 FAIL ——
//   那等于内核的类型名、辛性、参考系语义、参数校验在这台机器上**一次都没被验证**。
//   本项目不接受"没验过就说好"，所以把「执行」这一步挪出去：
//
//     python _record.py           把探针要的命令真跑一遍 → _replay.json
//     STARPIVOT_REPLAY=… node p.js  探针在真输出上跑断言
//
// 收敛方式（重要）：不能指望"跑一遍就把要的命令全报出来"。
// 探针在第 1 条命令拿不到数据时就会崩（例如 cat.json.cross_note 读到 null），
// 所以第 1 遍只能看到它崩之前那几条。于是做成**不动点循环**：
//   循环 { 跑探针 → 它把"我要但还没有"的命令记进 _plan_*.json → 退出码 2
//          → python _record.py 只补录缺的 → 再跑探针 }
// 直到探针退出码不是 2（0 全过 / 1 真失败）。每轮至少多录一条，必然收敛。
//
// 两个容易写错的地方（都真踩过）：
//   · 每轮都得让**下一轮读得到**上一轮录的东西（把 _replay.json 的位置传下去）。
//     不传的话 table() 永远为空、每轮把同样的命令再缺一遍：退出码恒为 2，跑满也不收敛。
//     而"恒为 2"最坏的地方不是慢 —— 它把 rc=1（探针在收集时就真崩了）淹没成噪音，
//     于是"收集其实什么都没收到"这件事一直没人发现。
//   · 收集**之前**，探针要用的环境必须已就绪。曾经有个 jsdom 探针因为 NODE_PATH
//     设在了晚一层的地方，在 require('jsdom') 处 rc=1、一条命令都没收到；
//     报出来的却是后面一层那句"某条命令没录到"，与真实原因隔了一整层。
//
// 退出码 2 = 「缺录制，请先录」，与 1（真失败）严格分开 —— 否则"没验"会被读成
// "验失败了"，或者更糟：被读成"通过了"。
//
// 为什么回放不等于自欺：_replay.json 里只有内核真跑出来的原始 stdout/stderr，
// 没有任何期望值；断言仍然要自己解析、自己独立复算。而且录制绑定了二进制的
// sha1 —— 二进制变了就整份作废（见下面的 exeOk()），杜绝"拿旧内核的输出喂新内核的断言"。
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PROBE = process.env.STARPIVOT_PROBE
  || path.basename(process.argv[1] || '_probe', '.js');
const REPLAY = process.env.STARPIVOT_REPLAY || '';
const PLAN = path.join(ROOT, '_plan_' + PROBE + '.json');
const EXE = path.join(ROOT, 'starpivot', 'build', 'bin', 'starpivot.exe');

const BLOCKED = new Set(['EBUSY', 'EPERM', 'EACCES']);

let _table = null, _can = null, _raw = null, _handler = false;
const _notes = new Map();
let _flushed = false;

const keyOf = (argv) => argv.join(' | ');

// 录制必须与当前这份二进制对得上。对不上就整份作废而不是"能对上几条算几条" ——
// 用旧内核的输出喂新内核的断言，是会悄悄通过的假绿灯。
// 体积与 sha1 都核：只核体积挡不住"改了几行但字节数没变"的重建。
// 没有指纹（旧版录制）时如实说明并跳过，而不是假装校验过了。
function exeOk(meta) {
  if (!fs.existsSync(EXE)) return true;                 // 没有二进制就没得比（C 层没过，D 层本来也不跑）
  if (!meta.exe_size && !meta.exe_sha1) {
    console.error('[_runner] 这份录制里没有二进制指纹（旧版录制）→ 跳过校验：'
      + '它有可能不是当前这颗内核录的。要让保护真生效，重跑 python _record.py。');
    return true;
  }
  try {
    if (meta.exe_size && meta.exe_size !== fs.statSync(EXE).size) return false;
    if (meta.exe_sha1) {
      const h = require('crypto').createHash('sha1').update(fs.readFileSync(EXE)).digest('hex');
      if (h !== meta.exe_sha1) return false;
    }
    return true;
  } catch (e) { return true; }
}

function table() {
  if (_table) return _table;
  _table = {};
  if (REPLAY) {
    try {
      const doc = JSON.parse(fs.readFileSync(REPLAY, 'utf8'));
      if (exeOk(doc)) {
        _table = doc.cmds || {};
      } else {
        console.error('[_runner] 回放录制对应的二进制不是当前这个（录入时 '
          + (doc.exe_size || '?') + ' 字节 / ' + String(doc.exe_sha1 || '?').slice(0, 12)
          + '，现在 ' + fs.statSync(EXE).size + ' 字节 / '
          + require('crypto').createHash('sha1').update(fs.readFileSync(EXE)).digest('hex').slice(0, 12)
          + '），整份作废，重新收集。'
          + '（这是故意的：拿旧内核的输出去喂新内核的断言会悄悄通过。）');
      }
    } catch (e) {
      console.error('[_runner] 回放文件读不了：' + REPLAY + ' —— ' + e.message);
    }
  }
  return _table;
}

// 只探一次：用一条与内核无关的命令问「这个进程能不能起子进程」。
// 不用内核去试，是因为"起不了"和"内核崩了"必须能分辨 —— 前者要跳过，后者是真失败。
function canSpawn() {
  if (_can !== null) return _can;
  if (!_raw) _raw = require('child_process').spawnSync;
  const r = _raw(process.execPath, ['-e', '0'], { encoding: 'utf8', timeout: 20000 });
  _can = !(r.error && BLOCKED.has(r.error.code));
  if (!_can) console.error('[_runner] 本进程起不了子进程（' + (r.error && r.error.code) + '）→ 走录制回放');
  return _can;
}

// 命令根本没跑时的返回值。字段要与 spawn() 的返回**同形** ——
// 少一个 txt，探针里那句 `r.txt.slice(0,80)` 就会变成 "Cannot read properties of
// undefined"，于是收集轮提前中断、命令清单收不全（第一次就是这么踩的）。
const blank = (code) => ({
  status: null, stdout: '', stderr: '', ms: 0,
  code: null, txt: '', json: null,
  error: { code: code || 'EBUSY' }
});

// 只在"收集"那一轮用的宽容替身。目的单一：让探针把「我要哪些命令」一口气报完。
// 为什么需要它：探针拿不到数据时会在第一条 null 解引用处崩掉（例如 cat.json.cross_note），
// 那样每轮只能多收一两条命令，60 条要跑 60 轮。
// 它给出的结果**一定是错的**，所以只在 status===null（命令根本没跑）时给出去：
// 这一轮 `_notes` 非空 → 退出码 2 → 断言结果全部作废，只取命令清单。
// 命令跑了但失败（rc≠0）时 json 仍是 null —— 那是真实观测，不允许被糊掉。
function stub() {
  const P = new Proxy(function () { return P; }, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === Symbol.iterator) return function* () { };
      if (k === 'then') return undefined;        // 别被当成 thenable 把 await 挂住
      if (k === 'length') return 0;              // 让"长度不足"这类断言照常失败
      if (k === 'size') return 0;
      return P;
    },
    apply() { return P; },
    construct() { return P; },
    has() { return true; }
  });
  return P;
}

// 探针的 run() 统一走这里，少写三遍形状转换：
//   json 在"命令根本没跑"时换成替身（见 stub 的理由），其余情况如实为 null
function shape(r) {
  return {
    code: r.status, txt: r.txt, ms: r.ms,
    json: r.json !== null ? r.json : (r.status === null ? stub() : null)
  };
}

function note(argv, opts) {
  const k = keyOf(argv);
  if (!_notes.has(k)) _notes.set(k, { argv, timeout: opts.timeout || 0 });
  if (_handler) return;
  _handler = true;
  // 缺数据时探针往往顺着就崩了（它没写防御 null 的分支，也不该写）。
  // 那不是产品缺陷，只是这段代码在这一轮注定读不到数据，统一收成退出码 2。
  // 关键：这条 handler 只在**真的缺**（_notes 非空）时才挂。一旦数据齐了，
  // 未捕获异常照原样抛出（退出码 1）—— 探针自己崩了必须看得见，不能被这层盖住。
  // 所以就算某次"真崩"被这里误当成 2，下一轮数据齐了它还会再崩一次，届时如实报 1。
  process.on('uncaughtException', (e) => {
    console.error('[_runner] 缺录制状态下中断：' + (e && e.message));
    flush();
    _realExit(2);
  });
}

function flush() {
  if (_flushed) return;
  _flushed = true;
  if (!_notes.size) return;
  const cmds = [..._notes.values()];
  fs.writeFileSync(PLAN, JSON.stringify({ probe: PROBE, cmds }, null, 1), 'utf8');
  console.error('[_runner] 还缺 ' + cmds.length + ' 条命令 → ' + path.basename(PLAN)
    + '（跑 python _record.py 补录，再带 STARPIVOT_REPLAY 重跑本探针）');
}

// 探针里的 spawnSync(EXE, args, opts) 换成这个。返回值是 spawnSync 的超集：
//   status/stdout/stderr  —— 与 spawnSync 同名，探针原有代码一行不用改
//   ms                    —— 真实（或录制时记下的）墙钟耗时，供"它挡得快不快"这类断言用
//   code/txt/json         —— 本仓库探针惯用的三个省事字段
function spawn(exe, args, opts) {
  opts = opts || {};
  const argv = [exe].concat(args);
  const k = keyOf(argv);
  const e = table()[k];
  if (e) {
    // 键是给人看的（用 " | " 拼 argv），好处是 _replay.json 打开就能读；代价是理论上会撞。
    // 所以逐位核一遍 argv：撞了就当没录到 —— 宁可报"缺"，也不能拿别人的输出去喂断言。
    if (JSON.stringify(e.argv) !== JSON.stringify(argv)) {
      console.error('[_runner] 录制里这条命令对不上（键碰撞？）：' + JSON.stringify(argv.slice(1)));
      return blank('KEYCOLLISION');
    }
    const out = e.out || '', err = e.err || '';
    return {
      status: e.rc, stdout: out, stderr: err, error: null, ms: e.ms || 0,
      code: e.rc, txt: (out + err).trim(),
      json: (() => { try { return JSON.parse(out); } catch (x) { return null; } })()
    };
  }
  if (!canSpawn()) { note(argv, opts); return blank(); }

  const t0 = Date.now();
  const r = _raw(exe, args, {
    encoding: 'utf8',
    timeout: opts.timeout,
    maxBuffer: opts.maxBuffer || (256 * 1024 * 1024)
  });
  const ms = Date.now() - t0;
  if (r.error && BLOCKED.has(r.error.code)) { note(argv, opts); return blank(r.error.code); }
  const out = r.stdout || '', err = r.stderr || '';
  return {
    status: r.status, stdout: out, stderr: err, error: r.error, ms,
    code: r.status, txt: (out + err).trim(),
    json: (() => { try { return JSON.parse(out); } catch (x) { return null; } })()
  };
}

const _realExit = process.exit.bind(process);
// 退出码 2 的语义要盖过探针自己算出来的 1：缺录制不是"判据失败"。
// 探针都是 process.exit(fail ? 1 : 0) 收尾，所以包一层就够；再挂个 exit 兜底。
process.exit = (code) => { flush(); _realExit(_notes.size ? 2 : code); };
process.on('exit', () => { flush(); });

module.exports = {
  spawn, shape, stub, canSpawn, replaying: () => !!REPLAY,
  planPath: () => PLAN, keyOf, EXE
};
