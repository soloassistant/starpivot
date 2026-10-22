// 用 WASI 宿主把内核模块真实例化一次，并跑它的 _start。
//
// 这一步回答的是一个与"能不能编译"完全不同的问题：**编出来的模块，宿主能不能加载并执行。**
// 编译器说"success"只证明它写出了字节，不证明这些字节是某个宿主认得的模块
// （缺数据段、需要环境不支持的 import、start 段不可执行都会在这一步才暴露）。
//
// 做法与内核无关：任何 WASI command 模块都能这么跑。这里刻意把 argv 也传进去，
// 因为它正是"页面要调内核"那条路将来要面对的接口形状（argv 进、stdout 出）。
const fs = require('fs');
const path = require('path');

const wasmPath = process.argv[2];
const argv = process.argv.slice(3);

let WASI;
try { ({ WASI } = require('node:wasi')); }
catch (e) { console.error('这个 Node 没有 node:wasi：' + e.message); process.exit(2); }

(async () => {
  const wasi = new WASI({ version: 'preview1', args: ['starpivot.wasm', ...argv] });
  const bytes = fs.readFileSync(wasmPath);
  const mod = await WebAssembly.compile(bytes);
  const inst = await WebAssembly.instantiate(mod, wasi.getImportObject());
  console.log('[wasm] 模块编译并实例化成功，字节数 ' + bytes.length);

  // WASI command 模块的入口是 _start。它若返回，说明整个进程跑完了。
  const rc = wasi.start(inst);
  console.log('[wasm] _start 返回 ' + rc);
  process.exit(typeof rc === 'number' ? rc : 0);
})().catch(e => {
  console.error('[wasm] 实例化/执行失败：' + (e && e.message));
  process.exit(1);
});
