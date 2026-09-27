# -*- coding: utf-8 -*-
"""完整链路判据：页面 payload → webapp 网关 → 真内核 → 回到 JSON。

前面几层都验过单独的环节（内核 JSON、网关 argv），但"串起来还能不能跑通"是另一回事：
网关可能在字段名上少转一个、内核可能对某个组合直接 die、页面可能拿到一份结构不同的数据。
这里用真 HTTP，把页面会发的 payload 原样 POST 过去。

顺带把上一轮遗留的两处"从未编译验证"补上：--solar 三档与 --set 属性覆盖。
之前没有编译器，它们只是写下了；现在内核是新编的，可以真跑了。
"""

import json
import subprocess
import sys
import urllib.request
from pathlib import Path

# 端口可覆盖：默认 8765，但跑判据前要先确认那上面确实是**本次代码**起的服务。
# 这一条是踩出来的：本机 8765 上曾留着一个上一轮起的旧 webapp 进程，
# 它不知道 --no-bio / --greenhouse / --solar，于是所有转发判据"正确地"失败了 ——
# 失败的是进程太旧，不是代码。所以判据要么自带健康检查，要么换端口重跑。
import os
BASE = os.environ.get("STARPIVOT_BASE", "http://127.0.0.1:8765")
ROOT = Path("C:/Users/geral/WorkBuddy/2026-09-24-16-11-48/starpivot")
EXE = ROOT / "build" / "bin" / "starpivot.exe"

fails = []
LOG = []


def emit(s=""):
    print(s)
    LOG.append(s)


def check(name, ok, detail=""):
    emit(("PASS  " if ok else "FAIL  ") + name + (("   " + detail) if detail else ""))
    if not ok:
        fails.append(name)


def post(payload, timeout=300):
    req = urllib.request.Request(BASE + "/api/nbody",
                                data=json.dumps(payload).encode("utf-8"),
                                headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:                       # 网关/代理返回了非 JSON 的错误页
            return e.code, {"_raw": raw[:200]}
    except Exception as e:                      # 连不上、超时等
        return 0, {"_error": "%s: %s" % (type(e).__name__, e)}


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return r.status, r.read().decode("utf-8", "replace")


def cli(args):
    r = subprocess.run([str(EXE)] + args, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=300)
    return r.returncode, r.stdout, r.stderr


# ---------------------------------------------------------------------------
# 第 0 条：先确认我们连的是"本次代码"起的服务，而不是某个遗留进程。
# 判据：服务端把 solar 场景的响应里带上 bio 块 —— 只有本轮之后的 webapp.py + 内核
# 同时在场才会成立（旧网关不转发、旧内核不认 bio 参数，任缺其一都会失败）。
emit("=" * 74)
emit("0. 端口上跑的是本次代码吗（先证明，再判后面的）")
code, js0 = post({"scenario": "solar", "years": 2, "samples": 5})
if code != 200:
    emit("FAIL  健康请求就失败了：HTTP %d %s" % (code, js0))
    emit("      —— 可能 8765 上是旧 webapp 进程，也可能服务根本没起来。")
    emit("      请重启服务，或用 STARPIVOT_BASE 指向新端口。")
    fails.append("服务健康检查")
else:
    check("服务端认识 bio 参数（说明网关与内核都是本轮之后的）",
          "bio" in js0, "keys=%s" % sorted(js0.keys())[:6])

emit("=" * 74)
emit("1. 页面默认 payload（太阳系 50 年）走完整 HTTP 链路")
code, js = post({"scenario": "solar", "years": 50, "samples": 30, "greenhouse": 33})
check("HTTP 200", code == 200, "code=%d" % code)
if code == 200:
    check("响应含 bio 块", "bio" in js)
    b = {x["id"]: x for x in js["bio"]["bodies"]}
    emit("  地球：T_surf ∈ [%.1f, %.1f] K，末帧阶 %d(%s)，进度 %.4f"
         % (min(b["Earth"]["t_surf_K"]), max(b["Earth"]["t_surf_K"]),
            b["Earth"]["stage_final"], b["Earth"]["stage_name"],
            b["Earth"]["progress_final"]))
    check("地球在演化中且在推进", b["Earth"]["verdict"][-1] == 2
          and b["Earth"]["progress_final"] > 0.4, "%.4f" % b["Earth"]["progress_final"])
    check("火星冻结、水星灭菌、木星冻结",
          b["Mars"]["verdict"][-1] == 1 and b["Mercury"]["verdict"][-1] == 3
          and b["Jupiter"]["verdict"][-1] == 1,
          "Mars=%d Mercury=%d Jupiter=%d"
          % (b["Mars"]["verdict"][-1], b["Mercury"]["verdict"][-1], b["Jupiter"]["verdict"][-1]))
    check("分层声明经网关完整到达",
          all(len(js["bio"].get(k, "")) > 20
              for k in ("layer1_physics", "layer2_stylized", "caveats")))
    check("逐帧数组与帧数一致",
          all(len(x["stage"]) == js["bio"]["frame_count"] for x in js["bio"]["bodies"]))

emit("=" * 74)
emit("2. 关掉演化（页面取消勾选 → payload.bio = false）")
code, js = post({"scenario": "solar", "years": 10, "samples": 10, "bio": False})
check("HTTP 200 且不含 bio 块", code == 200 and "bio" not in js,
      "code=%d keys=%s" % (code, "bio" in js))

emit("=" * 74)
emit("3. 页面拖温室滑杆 → 火星进窗口")
code, js = post({"scenario": "solar", "years": 50, "samples": 20, "greenhouse": 100})
check("HTTP 200", code == 200)
if code == 200:
    m = {x["id"]: x for x in js["bio"]["bodies"]}["Mars"]
    check("火星从冻结变成演化中且有进度",
          m["verdict"][-1] == 2 and m["progress_final"] > 0,
          "T_surf=%.1f K progress=%.4f" % (m["t_surf_final"], m["progress_final"]))
    check("greenhouse 被内核确认收到", js["bio"]["greenhouse_K"] == 100.0
          and js["bio"]["defaults_used"] is False)

emit("=" * 74)
emit("4. 页面自定义场景：太阳系三档（上一轮写下但从未编译验证）")
for mode, expect_bg in (("full", True), ("sun", False), ("none", False)):
    code, js = post({"scenario": "custom", "solar": mode, "years": 5, "samples": 10,
                     "bodies": [{"name": "X", "a": 1, "e": 0, "mass": 1e-6}]})
    names = [x["id"] for x in js.get("bodies", [])] if code == 200 else []
    ok = code == 200 and js.get("solar") == mode and ("X" in names)
    if mode == "full":
        ok = ok and "Sun" in names and "Jupiter" in names
    elif mode == "sun":
        ok = ok and "Sun" in names and "Jupiter" not in names
    else:
        ok = ok and "Sun" not in names and names == ["X"]
    check("--solar %-4s 摆出的天体正确" % mode, ok, "bodies=%s" % names)

emit("=" * 74)
emit("5. 页面改密度（--set，上一轮写下但从未编译验证）")
rc, out, err = cli(["nbody", "--scenario", "solar", "--years", "1", "--samples", "2",
                    "--no-bio", "--set", "Earth,density=13.0"])
if rc != 0:
    check("--set density 能跑通", False, err[:200])
else:
    js = json.loads(out)
    e = next(x for x in js["bodies"] if x["id"] == "Earth")
    # 均匀球三选二：给了密度就保留原质量、现算半径；ρ = M/(4/3πR³) 应回到 13.0
    check("只给 density → 密度精确落在 13.0 g/cm³（半径被反解）",
          abs(e["density_g_cm3"] - 13.0) < 1e-6,
          "density=%.9f radius=%.1f km mass=%.6g" % (e["density_g_cm3"],
                                                     e["radius_km"], e["mass_msun"]))
    check("--set 被回显", any(o.get("density_g_cm3") == 13.0 for o in js["overrides"]),
          str(js["overrides"]))

emit("=" * 74)
emit("6. 页面 /universe.html 确实是带演化的版本")
code, html = get("/universe.html")
need = ['id="bioon"', 'id="bioyears"', 'id="greenhouse"', 'id="biotable"',
        'id="biocard"', 'id="biolayer"', 'STAGE_COLORS', 'verdict_names']
missing = [n for n in need if n not in html]
check("页面含全部演化相关元素", not missing,
      "缺失 %s" % missing if missing else "%d 项全在（%d 字节）" % (len(need), len(html)))
check("页面不再含上一版的 withsolar 复选框", "withsolar" not in html)

# 服务端吐出来的这一份，必须就是磁盘上那一份。
# 理由：8765 上完全可能挂着一个旧进程，它手里的页面还是改动前的版本 ——
# 那时所有页面元素判据读到的都是旧页面，会给出"看起来对、其实测的不是本次代码"的绿。
# 先证明"发的是这次的文件"，后面的断言才谈得上有意义。
disk_page = (ROOT / "viewer" / "universe.html").read_text(encoding="utf-8")
check("HTTP 页面与磁盘逐字节一致（不是旧进程在发旧页面）",
      html == disk_page,
      "http=%d 字节 disk=%d 字节" % (len(html), len(disk_page)))

emit()
if fails:
    emit("FAILED: %d 项未通过 -> %s" % (len(fails), "; ".join(fails)))
else:
    emit("全部通过：页面 payload → 网关 → 内核 → JSON → 页面元素，整条链路闭合。")

with open(Path(__file__).with_name("_probe_bio_http.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(LOG) + "\n")
raise SystemExit(1 if fails else 0)
