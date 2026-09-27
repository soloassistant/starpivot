"""端到端 argv 判据：服务器到底把什么命令交给了内核。

拦掉 subprocess.run，把 webapp.py 的 /api/nbody **原样**跑一遍，
读回它真正发出的命令行参数。这里只验证"转发对不对"，
数值仍然全部由真内核负责（见 _probe_solar.py），两者不互相替代。

J 节还按同一条路子拦了 /api/find-close：那条路径曾经因为"网关没把内核路径传下去"
而在发布后只坏一个功能（详见那一节的注释）。
"""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path("C:/Users/geral/WorkBuddy/2026-09-24-16-11-48/starpivot")
spec = importlib.util.spec_from_file_location(
    "webapp", ROOT / "tools" / "webapp.py")
webapp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(webapp)

calls = []


class Recorded:
    returncode = 0
    stdout = '{"ok": true}'
    stderr = ""


def fake_run(argv, **kw):
    calls.append(list(argv))
    return Recorded()


webapp.subprocess.run = fake_run          # 只拦住"执行"这一步，转发逻辑一行没动

fails = []


def bad(msg):
    print("FAIL:", msg)
    fails.append(msg)


class Fake(webapp.Handler):
    def __init__(self, payload):
        self._payload = payload
        self.result = None

    def _read_body(self):
        return self._payload

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        self.result = (code, body)

    def _json_error(self, code, msg):
        self._send(code, json.dumps({"error": msg}, ensure_ascii=False))


def run(payload):
    calls.clear()
    f = Fake(payload)
    webapp.Handler.api_nbody(f)
    code, body = f.result
    got = calls[0] if calls else []
    return code, body, got


EXE = str(ROOT / "build" / "bin" / "starpivot.exe")

print("=" * 74)
print("A. custom + solar=none 时，服务器交给内核的命令行")
code, body, got = run({"scenario": "custom", "solar": "none",
                       "years": 5, "samples": 20,
                       "bodies": [{"name": "A", "a": 1, "e": 0, "mass": 0.5},
                                  {"name": "B", "a": 1, "e": 0, "mass": 0.5}]})
print("   HTTP", code, "| argv =", got[1:])
# argv[0] 是内核可执行文件路径；数值一律经 str(float(...))，所以是 1.0 不是 1。
want = [EXE, "nbody", "--scenario", "custom", "--solar", "none",
        "--body", "A,1.0,0.0,0.0,0.0,0.0,0.0,0.5",
        "--body", "B,1.0,0.0,0.0,0.0,0.0,0.0,0.5",
        "--years", "5", "--samples", "20"]
if code != 200:
    bad("solar=none 请求返回 " + str(code) + ": " + body)
elif got != want:
    bad("argv 不符\n    期望 %s\n    实际 %s" % (want, got))
else:
    print("   → 与内核 --solar 的契约逐字一致")

print("=" * 74)
print("B. 三档都转发，默认 full 不带多余的 --solar")
for mode in ("sun", "full", "none"):
    code, body, got = run({"scenario": "custom", "solar": mode,
                           "years": 2, "samples": 10,
                           "bodies": [{"name": "A", "a": 1, "e": 0, "mass": 1e-6}]})
    tail = (["--solar", mode] if mode != "full" else []) + \
        ["--body", "A,1.0,0.0,0.0,0.0,0.0,0.0,1e-06",
         "--years", "2", "--samples", "10"]
    want = [EXE, "nbody", "--scenario", "custom"] + tail
    if code != 200:
        bad(f"{mode}: HTTP {code} {body}")
    elif got != want:
        bad(f"{mode}: argv 不符\n    期望 {want[1:]}\n    实际 {got[1:]}")
    else:
        print(f"   {mode:>4}: {'转发 ' + ' '.join(tail[:2]) if mode != 'full' else '（默认，不加 --solar）'}")

print("=" * 74)
print("C. 非法取值要被挡在内核之外，且内核一个字都不该被调用")
code, body, got = run({"scenario": "custom", "solar": "half"})
if code != 400 or "solar must be" not in body or got:
    bad("非法 solar 没被拦住: HTTP %s %s argv=%s" % (code, body, got))
else:
    print("   solar=half -> HTTP 400", json.loads(body)["error"])

print("=" * 74)
print("D. solar / figure8 场景不带 --solar（内核只认 custom，别让它收到无关参数）")
for sc in ("solar", "figure8"):
    code, body, got = run({"scenario": sc, "solar": "none",
                           "years": 2, "samples": 10})
    if code != 200 or any(a == "--solar" for a in got):
        bad(f"{sc} 场景的 argv 里混进了 --solar: HTTP {code} argv={got[1:]}")
    else:
        print(f"   {sc}: argv 干净 -> {got[1:]}")

print("=" * 74)
print("E. 没给 solar 时的默认行为必须与旧版一致（custom → full，即全套太阳系）")
code, body, got = run({"scenario": "custom", "years": 2, "samples": 10,
                       "bodies": [{"name": "A", "a": 1, "e": 0, "mass": 1e-6}]})
if code != 200 or "--solar" in got:
    bad("旧请求被改写了: HTTP %s %s" % (code, got))
else:
    print("   → 不带 solar 字段时行为不变（默认 full）")

print("=" * 74)
print("F. 生物演化：默认开，且默认值由内核提供（页面不做镜像）")
code, body, got = run({"scenario": "solar", "years": 50, "samples": 40})
if code != 200:
    bad("solar + 默认 bio 失败: HTTP %s %s" % (code, body))
elif any(a in ("--no-bio", "--bio-years", "--albedo", "--greenhouse") for a in got):
    bad("默认情况下不该传任何 bio 参数，实际 %s" % got[1:])
else:
    print("   → 一个 bio 参数都不传，内核用自己的默认值 -> %s" % got[1:])

print("=" * 74)
print("G. bio=false 时只传 --no-bio（三个旋钮一个都不该出现）")
code, body, got = run({"scenario": "solar", "bio": False, "bio_years": 500,
                       "greenhouse": 99, "years": 5, "samples": 10})
if code != 200:
    bad("bio=false 失败: HTTP %s %s" % (code, body))
elif got[-1] != "--no-bio" or "--bio-years" in got or "--greenhouse" in got:
    bad("bio=false 的 argv 不符: %s" % got[1:])
else:
    print("   → %s" % got[1:])

print("=" * 74)
print("H. 三个旋钮逐一转发，数值原样交给内核校验（网关不私自钳）")
code, body, got = run({"scenario": "solar", "bio_years": 250, "albedo": 0.12,
                       "greenhouse": 200, "years": 5, "samples": 10})
want_tail = ["--bio-years", "250.0", "--albedo", "0.12", "--greenhouse", "200.0"]
if code != 200:
    bad("三个旋钮失败: HTTP %s %s" % (code, body))
elif ["--bio-years", "--albedo", "--greenhouse"] != \
        [a for a in got if a in ("--bio-years", "--albedo", "--greenhouse")]:
    bad("旋钮顺序/存在性不符: %s" % got[1:])
elif [got[got.index("--bio-years") + 1], got[got.index("--albedo") + 1],
      got[got.index("--greenhouse") + 1]] != ["250.0", "0.12", "200.0"]:
    bad("旋钮数值被改写了: %s" % got[1:])
else:
    print("   → %s" % [x for x in got[1:] if x.startswith("--") or x.replace('.', '').isdigit()])
    print("   → 期望的后缀 %s 全部命中" % want_tail)

print("=" * 74)
print("I. 边界值也照传不误：0 与负数由内核拒绝，网关负责不吞掉它")
for bad_val in ({"greenhouse": -1}, {"albedo": 1.5}, {"bio_years": 0}):
    code, body, got = run({"scenario": "solar", "years": 2, "samples": 5, **bad_val})
    key = list(bad_val)[0]
    flag = {"greenhouse": "--greenhouse", "albedo": "--albedo",
            "bio_years": "--bio-years"}[key]
    if code != 200 or flag not in got:
        bad("%s 被吞掉了: HTTP %s argv=%s" % (bad_val, code, got[1:]))
    else:
        print("   %-22s -> 原样转发 %s %s（由内核 die 拒绝）"
              % (str(bad_val), flag, got[got.index(flag) + 1]))

print("=" * 74)
print("J. 碰撞预警：网关必须把内核路径**显式**交给筛选工具（不许依赖它的默认值）")
# 这一节是被一次真实事故逼出来的：`find_close_approaches.py` 自己的默认值曾经写死成
# `build/bin/starpivot.exe`，而网关调用它时**没传 --exe** → 发布到 Linux 沙箱后
# "页面能开、主计算也正常，只有碰撞预警报找不到内核"。
# 只坏一个功能的故障最难在本地发现，而且当时**没有任何判据覆盖这个接口**，所以它安静地发出去了。
calls.clear()
f = Fake(None)
webapp.Handler.api_find_close(f, {"groups": ["iridium"], "top": ["3"]})
got = calls[0] if calls else []
if not got:
    bad("find-close 没发出任何子进程调用")
elif "--exe" not in got:
    bad("调用筛选工具时没传 --exe —— 它自己的默认值不保证与网关选中的内核一致")
else:
    exe = got[got.index("--exe") + 1]
    p = Path(exe)
    wrong_platform = p.name.endswith(".exe") != (sys.platform == "win32")
    if not p.is_file():
        bad("--exe 指向的文件不存在: " + exe)
    elif wrong_platform:
        bad("--exe 指到了别的平台的内核: " + exe)
    elif exe != str(webapp.EXE):
        bad("--exe 与网关自己用的内核不是同一个：%s vs %s" % (exe, webapp.EXE))
    else:
        print("   --exe ->", exe)
        print("   → 与网关自己那份 EXE 是同一个，且平台对得上")

print("=" * 74)
print("K. 碎裂四个参数必须**逐个**转发（含 spray）—— 而且必须用**非默认值**试")
# 这一节是被一次真实事故逼出来的，与上面 J 节同类："没有任何判据覆盖这个接口"。
# 事故：页面有「喷流成束 0–1」控件、内核有 `--spray`，而网关**没转发它** ——
# 于是那个控件是死的，而且**完全没有症状**：页面默认值 0.6 与内核默认值 0.6 刚好相等，
# 默认路径逐字都对，连"页面默认 == 内核回显"那条判据都绿。
# 只有把控件改成**别的值**才露馅。所以这一节的关键不是"检查有没有转发"，
# 而是**用的那四个数必须个个都不等于内核的默认值**（4 / 1.0 / 0.5 / 0.6）——
# 否则"被吞掉"和"转发成功"两次的 argv 一模一样，判据会恒真。
#
# 内核默认值（starpivot_cli.cpp）：fragments 4、dispersion-kms 1.0、
# frag-min-speed-kms 0.5、spray 0.6。下面这组一个都不沾。
K_FRAG = {"fragments": 7, "dispersion_kms": 0.25, "frag_min_speed_kms": 0.12, "spray": 0.33}
for key, default in (("fragments", 4), ("dispersion_kms", 1.0),
                     ("frag_min_speed_kms", 0.5), ("spray", 0.6)):
    if float(K_FRAG[key]) == float(default):
        bad("这一节自己写错了：%s 用了内核默认值 %s —— 那样「被吞掉」也会通过"
            % (key, default))
code, body, got = run({"scenario": "custom", "years": 3, "samples": 10,
                       "collide": "fragment", "radius_scale": 450,
                       **K_FRAG,
                       "bodies": [{"name": "A", "a": 1, "e": 0, "mass": 1e-6}]})
if code != 200:
    bad("碎裂请求没被接受: HTTP %s %s" % (code, body))
else:
    for key, flag, default in (("fragments", "--fragments", 4),
                               ("dispersion_kms", "--dispersion-kms", 1.0),
                               ("frag_min_speed_kms", "--frag-min-speed-kms", 0.5),
                               ("spray", "--spray", 0.6)):
        if flag not in got:
            bad("%s 没被转发（网关把 %s 吞了）—— argv = %s" % (flag, key, got[1:]))
            continue
        val = got[got.index(flag) + 1]
        want = str(float(K_FRAG[key]))
        if abs(float(val) - float(K_FRAG[key])) > 1e-12:
            bad("%s 的值不对：期望 %s 实际 %s" % (flag, want, val))
        else:
            print("   %-20s %-6s （内核默认 %s，这里刻意不用默认值）" % (flag, val, default))

# 负样本：**不给** spray 时就不该吐出 --spray，让内核用自己的默认值。
# 缺测按缺失处理 —— "没给"和"给了 0.6"是两句话。
code, body, got = run({"scenario": "custom", "years": 3, "samples": 10,
                       "collide": "fragment", "radius_scale": 450,
                       "fragments": 7, "dispersion_kms": 0.25, "frag_min_speed_kms": 0.12,
                       "bodies": [{"name": "A", "a": 1, "e": 0, "mass": 1e-6}]})
if code != 200:
    bad("没给 spray 的碎裂请求没被接受: HTTP %s %s" % (code, body))
elif "--spray" in got:
    bad("没给 spray 却吐出了 --spray（凭空补了一个值）: %s" % got[1:])
else:
    print("   负样本：不给 spray → argv 里没有 --spray（内核默认 0.6 生效）")

print("=" * 74)
print("全部判据通过" if not fails else "%d 项失败" % len(fails))
sys.exit(1 if fails else 0)
