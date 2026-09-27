#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""录制内核探针需要的命令，供 _runner.js 回放。

为什么要有这一步：本沙箱里 Node 起不了子进程（spawnSync 一律 EBUSY），
而 python 能。所以「执行内核」这件事交给这个脚本做，Node 侧只负责断言。
流程见 _runner.js 开头那段注释。

它做的事很窄，而且刻意如此：
  读   _plan_*.json  —— 探针第 1 遍记下的「我需要哪些命令」（探针自己写的，不是这里猜的）
  跑   subprocess    —— 每条命令真跑一遍，rc / stdout / stderr / 墙钟耗时全部留档
  写   _replay.json  —— 键 = argv 用 " | " 拼起来（_runner.js 的 keyOf 用同一条规则）

刻意不做的事：
  · 不猜命令、不补命令。探针要什么就录什么，少了会在第 2 遍以「键缺失」报出来。
  · 不写期望值。这里存的只有内核的原始输出，断言仍然在探针里自己解析、自己复算。
    一旦这里开始写「应该是多少」，这份录制就从证据变成了备忘录。

它会额外记一样东西：这份录制对应哪一份二进制（体积 + sha1）。
_runner.js 的 exeOk() 拿它核对 —— 内核一重建，整份录制作废，杜绝
「拿旧内核的输出去喂新内核的断言」。这一项**曾经漏写过**：payload 里没有
exe_size，于是 exeOk() 里那句 `!meta.exe_size` 恒为真、永远 return true，
保护一直写着、也一直空转。所以现在两项都记，缺一项就当没指纹。
"""
import glob
import hashlib
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
REPLAY = os.path.join(ROOT, "_replay.json")
EXE = os.path.join(ROOT, "starpivot", "build", "bin", "starpivot.exe")


def exe_meta():
    """录制要对得上哪一份二进制。读不到就返回空 —— 空 = 没有指纹，
    由 _runner.js 如实说明「跳过校验」，而不是假装校验过了。"""
    if not os.path.exists(EXE):
        return {}
    try:
        h = hashlib.sha1()
        with open(EXE, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return {"exe_size": os.path.getsize(EXE), "exe_sha1": h.hexdigest()}
    except OSError as e:
        print("  [warn] 二进制指纹读不出来（回放时将跳过校验）: %s" % e)
        return {}


def key_of(argv):
    """必须与 _runner.js 的 keyOf 完全一致（argv.join(' | ')）。"""
    return " | ".join(argv)


def collect():
    """把所有 _plan_*.json 里的命令按（探针给的顺序）去重收集。"""
    plans = sorted(glob.glob(os.path.join(ROOT, "_plan_*.json")))
    cmds, seen = [], set()
    for p in plans:
        try:
            with open(p, encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:                                   # noqa: BLE001
            print("  [warn] 计划文件读不了 %s: %s" % (os.path.basename(p), e))
            continue
        for c in data.get("cmds", []):
            k = key_of(c["argv"])
            if k in seen:
                continue
            seen.add(k)
            cmds.append(c)
    return plans, cmds


def run_one(c):
    argv, timeout_ms = c["argv"], c.get("timeout") or 0
    timeout = (timeout_ms / 1000.0) if timeout_ms else None
    t0 = time.time()
    try:
        r = subprocess.run(argv, cwd=ROOT, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=timeout)
        rc, out, err = r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired as e:
        # 超时说明内核没挡住（探针恰恰在验"它挡得住"）。如实记下：
        # 退出码给 -1 并在 stderr 写明，让第 2 遍那条断言自己失败 —— 不在这里替它下结论。
        rc = -1
        out = e.stdout or b""
        err = (e.stderr or b"") + ("\n[_record] 超过 %.0f ms 未返回，已终止" % (timeout_ms)).encode()
    except Exception as e:                                       # noqa: BLE001
        rc, out, err = -2, b"", ("[_record] 起不来: %r" % (e,)).encode()
    ms = int((time.time() - t0) * 1000)
    # 内核输出是 UTF-8；非法字节不该让整份录制失败，替换掉并保留长度感。
    return {"argv": argv, "rc": rc, "ms": ms,
            "out": out.decode("utf-8", "replace"),
            "err": err.decode("utf-8", "replace")}


def main():
    plans, cmds = collect()
    if not plans:
        print("没有 _plan_*.json —— 说明所有探针都能直接起进程，或者第 1 遍还没跑过。")
        return 0
    print("从 %d 个计划文件收到 %d 条命令，开始录制……" % (len(plans), len(cmds)))
    table, slow = {}, []
    for i, c in enumerate(cmds, 1):
        rec = run_one(c)
        table[key_of(c["argv"])] = rec
        if rec["ms"] > 3000:
            slow.append((rec["ms"], rec["argv"][3:6]))
        print("  [%2d/%2d] rc=%-3s %6d ms  %s"
              % (i, len(cmds), rec["rc"], rec["ms"], " ".join(c["argv"][1:6])))
    payload = {"note": "内核探针的录制输出（由 _record.py 从 _plan_*.json 生成）；"
                       "里面只有内核的原始 stdout/stderr，没有期望值",
               "plans": [os.path.basename(p) for p in plans],
               "count": len(table), "cmds": table}
    payload.update(exe_meta())
    with open(REPLAY, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    size = os.path.getsize(REPLAY)
    print("已写 %s（%d 条命令，%.1f MB）" % (os.path.basename(REPLAY), len(table), size / 1048576.0))
    if "exe_sha1" in payload:
        print("二进制指纹：%d 字节 / sha1 %s" % (payload["exe_size"], payload["exe_sha1"][:12]))
    if slow:
        print("其中较慢的 %d 条：" % len(slow))
        for ms, a in sorted(slow, reverse=True)[:5]:
            print("    %6d ms  %s" % (ms, " ".join(a)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
