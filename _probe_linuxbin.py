#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Linux 内核产物的判据（离线、可复现）。

为什么需要它：线上跑的是 `kernel/linux-x86_64/starpivot`，本地判据跑的是
`build/bin/starpivot.exe` —— **两颗二进制，同一份源码**。只要有人改了 `src/` 却忘了重编
Linux 版，线上就会**安静地停在旧内核上**：页面照常打开、照样出数，只是数的行为跟
文档/判据描述的不是同一个东西。这类"在线但过期"的故障没有任何页面症状，只能靠判据挡。

三条断言：
  A  产物存在
  B  是**静态** x86-64 ELF（程序头没有 PT_INTERP）—— 发布沙箱里没有我们的 libc，
     动态链接的产物在那儿是必然起不来的
  C  **不过期**：产物比 `src/**`、`include/**`、`tools/starpivot_cli.cpp` 里
     最新的那个文件还新。这一条就是"忘了重编"的报警线。
"""
import atexit
import os
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "starpivot"
ELF = ROOT / "kernel" / "linux-x86_64" / "starpivot"

LOG = []
n = fail = 0


def say(s):
    print(s)
    LOG.append(s)


# 落盘通道：汇总入口把子进程 stdout 丢进 /dev/null，只留一个退出码 ——
# 只打印不落盘时，失败时能拿到的全部信息就是"退出码 1"。（本探针第一版就漏了这一句。）
atexit.register(lambda: open(Path(__file__).resolve().parent / "_probe_linuxbin.txt",
                             "w", encoding="utf-8").write("\n".join(LOG) + "\n"))


def ok(cond, what, detail=""):
    global n, fail
    n += 1
    if not cond:
        fail += 1
    say("  %s  %s%s" % ("PASS" if cond else "FAIL", what,
                        ("   " + detail) if (detail and not cond) else ""))


# ---- A 存在 ----
exists = ELF.is_file()
ok(exists, "Linux 内核产物存在：%s" % ELF.relative_to(ROOT.parent),
   "没有这个文件，线上会报 no-exe（发布包里缺少 Linux 内核）")
if not exists:
    say("")
    say("[linuxbin] n=%d fail=%d" % (n, fail))
    sys.exit(1)

b = ELF.read_bytes()
size = len(b)

# ---- B 静态 x86-64 ELF ----
ok(b[:4] == b"\x7fELF", "是 ELF 文件", "头 4 字节不是 \\x7fELF")
mach = struct.unpack("<H", b[18:20])[0]
ok(mach == 0x3E, "机器架构是 x86-64", "实际 machine=0x%x" % mach)
phoff = struct.unpack("<Q", b[32:40])[0]
phentsz = struct.unpack("<H", b[54:56])[0]
phnum = struct.unpack("<H", b[56:58])[0]
ptypes = [struct.unpack("<I", b[phoff + i * phentsz: phoff + i * phentsz + 4])[0]
          for i in range(phnum)]
ok(3 not in ptypes, "是**静态**链接（程序头里没有 PT_INTERP）",
   "有 PT_INTERP → 依赖目标机的动态链接器，发布沙箱里必起不来")

# ---- C 不过期 ----
newest, newest_p = 0.0, ""
paths = (list((ROOT / "src").glob("*.cpp"))
         + list((ROOT / "include" / "starpivot").glob("*.hpp"))
         + [ROOT / "tools" / "starpivot_cli.cpp"])
for p in paths:
    if p.is_file() and p.stat().st_mtime > newest:
        newest, newest_p = p.stat().st_mtime, str(p.relative_to(ROOT.parent))
fresh = ELF.stat().st_mtime >= newest
ok(fresh, "不过期：产物比最新源码（%s）新" % newest_p,
   "源码已改但 Linux 产物是旧的 —— 线上会安静地停在旧内核上。重编："
   "zig c++ -target x86_64-linux-musl … -o kernel/linux-x86_64/starpivot src/*.cpp tools/starpivot_cli.cpp")

say("  [info] 产物 %d 字节；最新源码 %s" % (size, newest_p))
say("")
say("[linuxbin] n=%d fail=%d" % (n, fail))
sys.exit(1 if fail else 0)
