#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WASM / WASI 路线的可复现判据（D 层；软判据：环境缺席时退出码 2）。

为什么要有这个探针：本文档上一版写的是「`zig c++ -target wasm32-wasi` 编译成功
（`gravity.cpp` → 50 691 字节）」，并据此说「正式站不需要服务器跑 C++」。
但那条证据只说明**一个 TU 能编出目标文件** —— 目标文件不是可运行模块，
更证明不了任何"浏览器里能跑"。**"能编译"和"能用"是两件事**，这个探针把它们拆开：

  A  整个内核库（`src/*.cpp`，14 个 TU）链成 WASI 模块 —— 必须成功，并留档字节数
  B  用**真 WASI 宿主**（Node 的 `node:wasi`）加载并执行它 —— 必须实例化成功、`_start` 返回 0
  C  **负样本**：把 CLI（`tools/starpivot_cli.cpp`）一起链进去 —— 必须**失败**，
     且失败原因正是缺 `__cxa_throw`。这一条是把"已知障碍"钉住：哪天它开始成功，
     说明障碍没了，这条会红，提醒我们去把 PRD 里那句"页面入口不能复用 CLI"改掉。
  D  入口点：库里没有"配置进、帧出"的函数（记为待办）。这一条**不判死**，只如实打印 ——
     别把"还没做"写成"已经能跑"。

它用 python 写而不是 Node：本沙箱里 Node 起不了子进程（理由见 `_runner.js` 开头），
而这个探针每一步都要起 zig / node。
"""
import atexit
import glob
import os
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
P = os.path.join(ROOT, "starpivot")
WASM_RUNNER = os.path.join(ROOT, "_wasm_run.js")
ART = os.path.join(P, "build", "bin", "starpivot.wasm")
LOG = []
GUARD = tempfile.gettempdir()


def say(s):
    print(s)
    LOG.append(s)


atexit.register(lambda: open(os.path.join(ROOT, "_probe_wasm.txt"), "w",
                             encoding="utf-8").write("\n".join(LOG) + "\n"))

# ---- 环境 ----
ZIG = "D:/tmp/zigdl/zig/ziglang/zig.exe"
if not os.path.exists(ZIG):
    ZIG = shutil.which("zig") or ZIG
NODE = "C:/Users/geral/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
if not os.path.exists(NODE):
    NODE = shutil.which("node") or NODE

n = fail = 0


def ok(cond, what, detail=""):
    global n, fail
    n += 1
    if not cond:
        fail += 1
    say("  %s  %s%s" % ("PASS" if cond else "FAIL", what,
                        ("   " + detail) if (detail and not cond) else ""))


def run(argv, timeout=1200):
    t0 = time.time()
    env = dict(os.environ)
    env["ZIG_GLOBAL_CACHE_DIR"] = r"D:\tmp\zigcache"
    env["ZIG_LOCAL_CACHE_DIR"] = r"D:\tmp\zigwasmprobe"
    try:
        r = subprocess.run(argv, cwd=ROOT, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=timeout, env=env)
        return (r.returncode, r.stdout.decode("utf-8", "replace"),
                r.stderr.decode("utf-8", "replace"), int((time.time() - t0) * 1000))
    except subprocess.TimeoutExpired:
        return -1, "", "[超时 %d s]" % timeout, int((time.time() - t0) * 1000)


# 环境缺席 = 退出码 2（软判据：记 skip，不当失败）
if not os.path.exists(ZIG) or not os.path.exists(NODE):
    say("[wasm] 环境缺席：zig=%s node=%s" % (os.path.exists(ZIG), os.path.exists(NODE)))
    sys.exit(2)

say("=== WASM / WASI 路线（zig %s）===" % os.path.basename(ZIG))
srcs = sorted(glob.glob(os.path.join(P, "src", "*.cpp")))
inc = "-I" + os.path.join(P, "include")

# 一个只为了"有 main 可链"的最小 TU。它不调用内核 —— 本探针要证的是
# **库能不能链成模块**，不是"某个场景跑没跑通"（那需要入口点，见 D）。
# 放在临时目录并在退出时删掉：探针不该在自己跑过的地方留垃圾。
mainf = os.path.join(GUARD, "_wasm_probe_main.cpp")
with open(mainf, "w", encoding="utf-8") as f:
    f.write("int main(){ return 0; }\n")
atexit.register(lambda: os.path.exists(mainf) and os.remove(mainf))

base = [ZIG, "c++", "-target", "wasm32-wasi", "-std=c++17", "-O2", "-ffp-contract=off", inc]

# ---- A 库链成模块 ----
os.makedirs(os.path.dirname(ART), exist_ok=True)
rc, out, err, ms = run(base + ["-o", ART] + srcs + [mainf])
size = os.path.getsize(ART) if os.path.exists(ART) else 0
ok(rc == 0, "A 整个内核库（%d 个 TU）链成 WASI 模块（%d ms）" % (len(srcs), ms),
   (err or out).strip().splitlines()[-1] if (err or out).strip() else "")
ok(size > 500_000, "A 产物是「真」模块而不是空壳：%d 字节" % size, "只有 %d 字节" % size)

# ---- B 真 WASI 宿主加载并执行 ----
if size > 0:
    rc2, out2, err2, ms2 = run([NODE, WASM_RUNNER, ART], timeout=300)
    ok(rc2 == 0, "B 真 WASI 宿主能实例化它（%d ms）" % ms2,
       (err2 or out2).strip().splitlines()[-1] if (err2 or out2).strip() else "")
    ok("_start 返回 0" in out2, "B 模块的 _start 真的跑到返回 0",
       (out2 + err2).strip().splitlines()[-1] if (out2 + err2).strip() else "")
else:
    ok(False, "B 真 WASI 宿主能实例化它", "A 没产出模块，B 无从谈起")
    ok(False, "B 模块的 _start 真的跑到返回 0", "同上")

# ---- C 负样本：CLI 链不过，且原因就是缺异常运行时 ----
rc3, out3, err3, _ = run(base + ["-o", os.path.join(GUARD, "_wasm_cli.wasm")]
                         + srcs + [os.path.join(P, "tools", "starpivot_cli.cpp")])
atexit.register(lambda: os.path.exists(os.path.join(GUARD, "_wasm_cli.wasm"))
                and os.remove(os.path.join(GUARD, "_wasm_cli.wasm")))
ok(rc3 != 0, "C 负样本：把 CLI 一起链进去**必须**失败（否则说明障碍没了，去改 PRD）",
   "竟然成功了 —— 页面入口也许可以直接复用 CLI 了，这一条该改")
ok("__cxa_throw" in err3 or "__cxa_allocate_exception" in err3,
   "C 而且失败原因就是缺异常运行时（__cxa_throw）",
   "没看到 __cxa_* 符号，报错是别的：" + (err3.strip().splitlines() or [""])[0])

# ---- D 入口点：如实打印，不判死 ----
entry = []
for h in glob.glob(os.path.join(P, "include", "starpivot", "*.hpp")):
    t = open(h, encoding="utf-8", errors="replace").read()
    if 'extern "C"' in t:
        entry.append(os.path.basename(h))
say("  [info] 可被页面调用的 C ABI 入口：%s"
    % ("有（%s）" % ", ".join(entry) if entry else "**没有** —— 这是待办，不是已完成"))
say("  [info] 产物留档：%s（%d 字节）" % (os.path.relpath(ART, ROOT), size))
say("")
say("[wasm] n=%d fail=%d" % (n, fail))
sys.exit(1 if fail else 0)
