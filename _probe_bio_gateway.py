# -*- coding: utf-8 -*-
"""完整链路判据（进程内版）：页面 payload → webapp 网关 → 真内核 → 回到 JSON。

与 _probe_bio_http.py 的区别：这里不经过 TCP，直接把页面会发的 payload 交给
webapp.Handler.api_nbody，但**不拦 subprocess** —— 所以真内核真的被执行，
JSON 真的是内核产出的。少掉的只有 socket 那一层（那一层由 _probe_http.py 覆盖）。

为什么不干脆用 HTTP：本沙箱里 Start-Process 被拦（返回空进程对象），
我起不来新服务；而 8765 上恰好留着一个上一轮起的旧 webapp 进程，它不认本轮的
新参数 —— 于是"HTTP 判据失败"其实反映的是进程太旧，不是代码不对。
把 TCP 拿掉，这条判据就不再依赖"端口上是哪个进程"这种环境偶然性。

顺带把上一轮遗留的两处"写下但从未编译验证"补上：--solar 三档与 --set。
上一轮没有编译器；现在内核是新编的，可以真跑了。
"""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

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


spec = importlib.util.spec_from_file_location("webapp", ROOT / "tools" / "webapp.py")
webapp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(webapp)


class Fake(webapp.Handler):
    """只替换"从 socket 读请求 / 往 socket 写响应"这两件事，转发逻辑一行没动。"""

    def __init__(self, payload):
        self._payload = payload
        self.result = None

    def _read_body(self):
        return self._payload

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        self.result = (code, body)

    def _json_error(self, code, msg):
        self._send(code, json.dumps({"error": msg}, ensure_ascii=False))


def call(payload):
    """走真网关、真 subprocess、真内核。"""
    f = Fake(payload)
    webapp.Handler.api_nbody(f)
    code, body = f.result
    try:
        return code, json.loads(body)
    except Exception:
        return code, {"_raw": body[:300]}


def cli(args):
    r = subprocess.run([str(EXE)] + args, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=300)
    return r.returncode, r.stdout, r.stderr


# ---------------------------------------------------------------------------
emit("=" * 74)
emit("1. 页面默认 payload（太阳系 50 年）：网关 → 内核 → JSON")
code, js = call({"scenario": "solar", "years": 50, "samples": 30, "greenhouse": 33})
check("HTTP 200", code == 200, "code=%d %s" % (code, js.get("error", "")))
if code == 200:
    b = {x["id"]: x for x in js["bio"]["bodies"]}
    emit("  地球：T_surf ∈ [%.1f, %.1f] K，末帧 %d(%s)，进度 %.4f"
         % (min(b["Earth"]["t_surf_K"]), max(b["Earth"]["t_surf_K"]),
            b["Earth"]["stage_final"], b["Earth"]["stage_name"],
            b["Earth"]["progress_final"]))
    check("地球在演化中且有实质进度", b["Earth"]["verdict"][-1] == 2
          and b["Earth"]["progress_final"] > 0.4, "%.4f" % b["Earth"]["progress_final"])
    check("水星灭菌 / 火星冻结 / 木星冻结",
          b["Mercury"]["verdict"][-1] == 3 and b["Mars"]["verdict"][-1] == 1
          and b["Jupiter"]["verdict"][-1] == 1,
          "Mercury=%d Mars=%d Jupiter=%d"
          % (b["Mercury"]["verdict"][-1], b["Mars"]["verdict"][-1],
             b["Jupiter"]["verdict"][-1]))
    check("分层声明完整到达",
          all(len(js["bio"].get(k, "")) > 20
              for k in ("layer1_physics", "layer2_stylized", "caveats")))
    check("逐帧数组长度 == frame_count",
          all(len(x["stage"]) == js["bio"]["frame_count"] and
              len(x["t_surf_K"]) == js["bio"]["frame_count"]
              for x in js["bio"]["bodies"]))

emit("=" * 74)
emit("2. 页面取消勾选演化（payload.bio = false）")
code, js = call({"scenario": "solar", "years": 10, "samples": 10, "bio": False})
check("HTTP 200 且响应不含 bio 块", code == 200 and "bio" not in js,
      "code=%d 含 bio=%s" % (code, "bio" in js))

emit("=" * 74)
emit("3. 页面拖温室滑杆到 100：火星应该进窗口")
code, js = call({"scenario": "solar", "years": 50, "samples": 20, "greenhouse": 100})
check("HTTP 200", code == 200, "code=%d" % code)
if code == 200:
    b = {x["id"]: x for x in js["bio"]["bodies"]}
    m = b["Mars"]
    check("火星从冻结变演化中且开始有进度",
          m["verdict"][-1] == 2 and m["progress_final"] > 0,
          "T_surf=%.1f K progress=%.4f" % (m["t_surf_final"], m["progress_final"]))
    check("内核确认收到 greenhouse=100 且 defaults_used=false",
          js["bio"]["greenhouse_K"] == 100.0 and js["bio"]["defaults_used"] is False,
          "greenhouse=%s defaults_used=%s" % (js["bio"]["greenhouse_K"],
                                              js["bio"]["defaults_used"]))

emit("=" * 74)
emit("4. 页面自定义场景：太阳系三档（上一轮写下但从未编译验证）")
for mode, want in (("full", ["Sun", "Jupiter"]), ("sun", ["Sun"]), ("none", [])):
    code, js = call({"scenario": "custom", "solar": mode, "years": 5, "samples": 10,
                     "bodies": [{"name": "X", "a": 1, "e": 0, "mass": 1e-6}]})
    names = [x["id"] for x in js.get("bodies", [])] if code == 200 else []
    ok = code == 200 and js.get("solar") == mode and names and names[-1] == "X"
    if mode == "full":
        ok = ok and all(w in names for w in want) and len(names) == 11
    elif mode == "sun":
        ok = ok and names == ["Sun", "X"]
    else:
        ok = ok and names == ["X"]
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
    check("只给 density → 反解出的半径让密度精确回到 13.0",
          abs(e["density_g_cm3"] - 13.0) < 1e-6,
          "density=%.9f radius=%.1f km" % (e["density_g_cm3"], e["radius_km"]))
    check("--set 被回显", any(o.get("density_g_cm3") == 13.0 for o in js["overrides"]),
          str(js["overrides"]))

emit("=" * 74)
emit("6. 三个旋钮与非法值：网关不吞、内核拒绝")
code, js = call({"scenario": "solar", "years": 50, "samples": 10,
                 "bio_years": 10, "albedo": 0.12, "greenhouse": 0})
check("三个旋钮都生效（bio_years=10 地球顶格 / albedo 与 greenhouse 被回显）",
      code == 200 and js["bio"]["full_ladder_years"] == 10.0
      and js["bio"]["albedo"] == 0.12 and js["bio"]["greenhouse_K"] == 0.0,
      "ladder=%s albedo=%s greenhouse=%s"
      % (js["bio"].get("full_ladder_years"), js["bio"].get("albedo"),
         js["bio"].get("greenhouse_K")))
for bad in ({"greenhouse": -1}, {"albedo": 1.5}, {"bio_years": 0}):
    code, js = call({"scenario": "solar", "years": 2, "samples": 5, **bad})
    check("非法值 %-20s 被内核拒绝（HTTP 400）" % str(bad),
          code == 400, "HTTP %d %s" % (code, str(js.get("error", ""))[:60]))

emit()
if fails:
    emit("FAILED: %d 项未通过 -> %s" % (len(fails), "; ".join(fails)))
else:
    emit("全部通过：页面 payload → 网关转发 → 真内核执行 → JSON，整条链路闭合。")

with open(Path(__file__).with_name("_probe_bio_gateway.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(LOG) + "\n")
raise SystemExit(1 if fails else 0)
