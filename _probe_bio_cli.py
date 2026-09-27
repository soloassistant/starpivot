# -*- coding: utf-8 -*-
"""CLI 端到端判据：跑真实二进制，检查真实 JSON。

这是三层验证里的最后一层，也是唯一一层真的执行 bio.cpp 的地方。
  * _probe_bio.py   用 SI 单位独立重推物理 → 验"物理对不对"
  * _bio_selftest.cpp 直接调 bio.cpp 的函数 → 验"代码有没有抄错"
  * 本文            跑 starpivot.exe 读 JSON → 验"接线有没有接上、输出有没有走形"
三层不能互相替代：bio.cpp 编译通过、数值也对，仍然可能因为 CLI 里没把
step_bio 接进帧循环、或者 bio 块的字段名写歪，而让页面拿到一份没用的数据。

判据：
 1. 输出是合法 JSON，且 solar 场景下 bio 块存在。
 2. `bio.bodies` 与 `bodies` 同长、id 逐个对齐（页面按下标索引，错位就全错）。
 3. 每颗星的六个逐帧数组长度 == bio.frame_count == frames 的长度。
 4. 地球：T_surf ≈ 287.3 K、判定 = 演化中(2)、末帧阶 = 4、进度 ≈ 0.50。
 5. 水星 = 灭菌(3)、火星 = 冻结(1)、木星 = 冻结(1)。
 6. 太阳：无光照(0)、T_surf = 0（不能凭空有 33 K 温室）。
 7. progress 全程单调不减（同一颗星），且始终在 [0,1]——灭菌那一支例外（归零）。
 8. --no-bio：bio 块整个消失，帧序列照旧。
 9. --greenhouse 100：火星从冻结(1)变成演化中(2)，且它真的开始有进度。
10. --bio-years 10：地球更快顶格（末帧阶 = 8）。
11. 偏心轨道上的自定义天体：能看到"灭菌归零"这一支真的发生过（进度从 >0 掉到 0）。
12. 三层 JSON 声明齐全（layer1_physics / layer2_stylized / caveats 都非空）。
13. 阈值回显与内核常量一致（273 / 373）。
14. 逐帧数组里不出现 NaN / inf（它们会被 json.loads 变成 NaN 浮点数，静默污染页面）。
"""

import json
import math
import subprocess
import sys
from pathlib import Path

R = Path("C:/Users/geral/WorkBuddy/2026-09-24-16-11-48/starpivot")
EXE = R / "build" / "bin" / "starpivot.exe"

fails = []
LOG = []


def emit(line=""):
    print(line)
    LOG.append(line)


def check(name, ok, detail=""):
    emit(("PASS  " if ok else "FAIL  ") + name + (("   " + detail) if detail else ""))
    if not ok:
        fails.append(name)


def run(args, timeout=300):
    r = subprocess.run([str(EXE)] + args, capture_output=True, text=True,
                       timeout=timeout, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError("CLI 退出码 %d: %s" % (r.returncode, (r.stderr or "")[:400]))
    return json.loads(r.stdout)


def has_bad_float(seq):
    """内核不许把 NaN/inf 写进 JSON。json.loads 会把裸 NaN 读成 float('nan')，
    所以这里逐个查 —— 一旦有，页面上的数字会变成 "NaN" 而没人知道为什么。"""
    for v in seq:
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            return True
        if isinstance(v, list) and has_bad_float(v):
            return True
    return False


def bio_by_id(js):
    return {b["id"]: b for b in js["bio"]["bodies"]}


# ---------------------------------------------------------------------------
emit("=" * 74)
emit("1-7. 太阳系默认场景（--years 50）")
solar = run(["nbody", "--scenario", "solar", "--years", "50", "--samples", "60"])
B = solar.get("bio")
check("bio 块存在", isinstance(B, dict))
check("输出是合法 JSON", True, "bodies=%d frames=%d" % (len(solar["bodies"]), len(solar["frames"])))

ids_body = [b["id"] for b in solar["bodies"]]
ids_bio = [b["id"] for b in B["bodies"]]
check("bio.bodies 与 bodies 同长同序（页面按下标索引）",
      ids_body == ids_bio, "%s" % (ids_body[:4] + ["..."] if len(ids_body) > 4 else ids_body))

nf = B["frame_count"]
check("frame_count == frames 长度", nf == len(solar["frames"]), "%d vs %d" % (nf, len(solar["frames"])))

series_keys = ["stage", "verdict", "progress", "insolation", "t_eq_K", "t_surf_K"]
badlen = [b["id"] for b in B["bodies"] if any(len(b[k]) != nf for k in series_keys)]
check("六个逐帧数组长度都等于 frame_count", not badlen, "异常: %s" % badlen if badlen else "%d 帧 × 6 数组" % nf)

badf = [b["id"] for b in B["bodies"] if has_bad_float(b["stage"]) or has_bad_float(b["verdict"])
        or has_bad_float(b["progress"]) or has_bad_float(b["insolation"])
        or has_bad_float(b["t_eq_K"]) or has_bad_float(b["t_surf_K"])]
check("逐帧数组里没有 NaN/inf", not badf, "异常: %s" % badf if badf else "")

S = bio_by_id(solar)

earth = S["Earth"]
# 注意：这里必须看"整条轨道上的取值范围"，不能只看到末帧那一个数。
# 第一版判据就栽在这上面：地球的 e=0.0167，r 在 0.9833–1.0167 AU 之间摆动，
# 而 t=50 年时它恰好走到近日点附近（r=0.9833 AU）→ S=1.034、T_surf=289.4 K。
# 我按 r ≡ 1 AU 写期望值，于是把正确的物理判成了错。
emit("  地球：S ∈ [%.5f, %.5f]，T_surf ∈ [%.1f, %.1f] K，末帧阶=%d(%s) 进度=%.4f"
     % (min(earth["insolation"]), max(earth["insolation"]),
        min(earth["t_surf_K"]), max(earth["t_surf_K"]),
        earth["stage_final"], earth["stage_name"], earth["progress_final"]))
# 边界从地球的 J2000 根数现算，不手打 —— 第一版就是手打成 0.9674，
# 而真值是 1/1.016715² = 0.967392，差 8e-6 就把正确的物理判成了错。
A_EARTH, E_EARTH = 1.00000261, 0.01671123
s_at_r = lambda r: 1.0 / (r * r)
s_min = s_at_r(A_EARTH * (1.0 + E_EARTH))     # 远日点
s_max = s_at_r(A_EARTH * (1.0 - E_EARTH))     # 近日点
check("地球 S 落在由 a、e 现算出的区间内（远日点..近日点）",
      min(earth["insolation"]) >= s_min - 1e-4 and max(earth["insolation"]) <= s_max + 1e-4,
      "实测 %.5f..%.5f ⊂ 现算 %.5f..%.5f"
      % (min(earth["insolation"]), max(earth["insolation"]), s_min, s_max))
t_lo = 278.6 * ((1.0 - 0.306) * s_min) ** 0.25
t_hi = 278.6 * ((1.0 - 0.306) * s_max) ** 0.25
# 用逐帧的 S 现场反算 T_eq，和内核给的 t_eq_K 比 —— 这是"内核有没有把公式写对"
# 的交叉验算。容忍度取决于输出精度（%.6g ⇒ 1e-4 相对），所以卡 0.01 K。
worst = max(abs(278.6 * ((1.0 - 0.306) * earth["insolation"][i]) ** 0.25
                - earth["t_eq_K"][i]) for i in range(len(earth["t_eq_K"])))
check("地球 T_eq 逐帧等于 278.6·((1−A)·S)^(1/4)（用实测 S 反算）", worst < 0.01,
      "最大偏差 %.5f K；T_eq 区间 %.2f–%.2f K" % (worst, t_lo, t_hi))
check("地球 T_surf = T_eq + 33（逐帧都成立）",
      all(abs(earth["t_surf_K"][i] - earth["t_eq_K"][i] - 33.0) < 0.02
          for i in range(len(earth["t_surf_K"]))),
      "差值的最大值 %.4f" % max(abs(earth["t_surf_K"][i] - earth["t_eq_K"][i] - 33.0)
                                for i in range(len(earth["t_surf_K"]))))
check("地球全程判定恒为演化中(2)（近日点也不越界）",
      set(earth["verdict"]) == {2}, "出现过的判定 %s" % sorted(set(earth["verdict"])))
check("地球末帧 = 演化中(2)", earth["verdict"][-1] == 2, "verdict=%d" % earth["verdict"][-1])
check("地球末帧 = 第 4 阶", earth["stage_final"] == 4, "stage=%d" % earth["stage_final"])
check("地球 50 年进度 ≈ 0.50", abs(earth["progress_final"] - 0.4997) < 0.005,
      "%.4f" % earth["progress_final"])
check("地球 step_reached_at 落在 [0,50]", 0.0 <= earth["stage_reached_at_Y"] <= 50.0,
      "%.3f 年" % earth["stage_reached_at_Y"])

expect = {"Mercury": (3, "灭菌"), "Venus": (2, "演化中"), "Mars": (1, "冻结"),
          "Jupiter": (1, "冻结"), "Neptune": (1, "冻结")}
for name, (code, zh) in expect.items():
    got = S[name]["verdict"][-1]
    tar = S[name]["t_surf_final"]
    check("%-8s = %s(%d)" % (name, zh, code), got == code, "T_surf=%.1f K，verdict=%d" % (tar, got))

sun = S["Sun"]
check("太阳：无光照(0) 且 T_surf = 0（不凭空得到温室）",
      sun["verdict"][-1] == 0 and sun["t_surf_final"] == 0.0 and sun["insolation_final"] == 0.0,
      "verdict=%d T_surf=%s" % (sun["verdict"][-1], sun["t_surf_final"]))

mono_bad = []
for b in B["bodies"]:
    p = b["progress"]
    for i in range(1, len(p)):
        if p[i] < p[i - 1] - 1e-12 and p[i] != 0.0:      # 归零是灭菌那一支，允许
            mono_bad.append(b["id"])
            break
check("progress 单调不减（灭菌归零除外）", not mono_bad, "异常: %s" % mono_bad if mono_bad else "")
rng_bad = [b["id"] for b in B["bodies"] if any((v < 0.0 or v > 1.0) for v in b["progress"])]
check("progress 全程落在 [0,1]", not rng_bad, "异常: %s" % rng_bad if rng_bad else "")
stg_bad = [b["id"] for b in B["bodies"] if any((s < 0 or s > 8) for s in b["stage"])]
check("stage 全程落在 [0,8]", not stg_bad, "异常: %s" % stg_bad if stg_bad else "")

# ---------------------------------------------------------------------------
emit("=" * 74)
emit("12-13. 分层声明与阈值回显")
for k in ("layer1_physics", "layer2_stylized", "caveats"):
    check("%s 非空（分层口径写进了内核产物）" % k, bool(B.get(k)) and len(B[k]) > 20,
          "%d 字" % len(B.get(k, "")))
check("冰点/沸点回显 = 273 / 373",
      B["freezing_K"] == 273.0 and B["sterilization_K"] == 373.0,
      "%s / %s" % (B["freezing_K"], B["sterilization_K"]))
check("主星 = Sun，L = 1 L☉",
      B["primary"] == "Sun" and abs(B["luminosity_Lsun"] - 1.0) < 1e-9,
      "%s / %s" % (B["primary"], B["luminosity_Lsun"]))
check("未改旋钮时 defaults_used = true（页面据此知道用的是内核默认）",
      B["defaults_used"] is True, "albedo=%s greenhouse=%s ladder=%s"
      % (B["albedo"], B["greenhouse_K"], B["full_ladder_years"]))
check("stage_names 有 9 项且首尾正确",
      len(B["stage_names"]) == 9 and B["stage_names"][0] == "死寂岩石"
      and B["stage_names"][8] == "工业文明", " / ".join(B["stage_names"][:2]) + " ...")
check("verdict_names 顺序 = 码值顺序",
      B["verdict_names"] == ["no_light", "frozen", "evolving", "sterilized"],
      str(B["verdict_names"]))

# ---------------------------------------------------------------------------
emit("=" * 74)
emit("8. --no-bio：演化层整个消失，帧序列照旧")
nb = run(["nbody", "--scenario", "solar", "--years", "5", "--samples", "10", "--no-bio"])
check("--no-bio 时不输出 bio 块", "bio" not in nb, "keys=%s" % sorted(nb.keys())[:8])
check("--no-bio 时帧序列与诊断照旧",
      len(nb["frames"]) > 0 and "diagnostics" in nb and len(nb["bodies"]) > 0)

# ---------------------------------------------------------------------------
emit("=" * 74)
emit("9. --greenhouse 100：给火星厚大气，它应该从冻结变成演化中")
gh = run(["nbody", "--scenario", "solar", "--years", "50", "--samples", "20",
          "--greenhouse", "100"])
G = bio_by_id(gh)
mars = G["Mars"]
check("火星判定变成演化中(2)", mars["verdict"][-1] == 2,
      "T_surf=%.1f K" % mars["t_surf_final"])
check("火星真的开始有进度", mars["progress_final"] > 0.0, "%.4f" % mars["progress_final"])
check("温室参数被回显（defaults_used = false）",
      gh["bio"]["greenhouse_K"] == 100.0 and gh["bio"]["defaults_used"] is False,
      "greenhouse=%s" % gh["bio"]["greenhouse_K"])

# ---------------------------------------------------------------------------
emit("=" * 74)
emit("10. --bio-years 10：阶梯更短，地球更快顶格")
fast = run(["nbody", "--scenario", "solar", "--years", "50", "--samples", "20",
            "--bio-years", "10"])
F = bio_by_id(fast)
check("地球末帧 = 第 8 阶（工业文明）", F["Earth"]["stage_final"] == 8,
      "progress=%.6f" % F["Earth"]["progress_final"])
check("progress 恰好钳在 1.0", F["Earth"]["progress_final"] == 1.0,
      repr(F["Earth"]["progress_final"]))

# ---------------------------------------------------------------------------
emit("=" * 74)
emit("11. 偏心轨道：能看到'灭菌归零'这一支真实发生过")
# 一颗大偏心率天体：近日点 0.1 AU（过沸点 → 灭菌归零），远日点 1.9 AU（冻结）。
# 从 aphelion 出发，走到 perihelion 时进度应被清掉。
ecc = run(["nbody", "--scenario", "custom", "--solar", "sun", "--years", "10",
           "--samples", "200", "--bio-years", "20",
           "--body", "Zigzag,1.0,0.9,0,0,0,180,1e-6"])
Z = bio_by_id(ecc)["Zigzag"]
tsf = Z["t_surf_K"]
prog, vd = Z["progress"], Z["verdict"]
emit("  T_surf 从 %.0f K（远日点）到 %.0f K（近日点）；进度峰值 %.4f"
     % (min(tsf), max(tsf), max(prog)))
check("T_surf 真的跨过沸点 373 K", max(tsf) > 373.0, "最高 %.0f K" % max(tsf))
check("T_surf 真的跨过冰点 273 K", min(tsf) < 273.0, "最低 %.0f K" % min(tsf))

# 灭菌归零的判据要按"事件"来写，不要设一个凭感觉的进度阈值。
# 第一版写的是 peak > 0.02，而这个天体的进度峰值只有 0.0049 —— 它穿过液态水窗口
# 太快、没攒下多少进度，于是我的阈值把"确实发生过的灭菌"判成了没发生。
# 正确写法：找"先有进度、后遇灭菌"的帧对，检查那一刻进度确实被清零。
first_accrued = next((i for i, p in enumerate(prog) if p > 0.0), None)
first_boiled = next((i for i, v in enumerate(vd) if v == 3), None)
emit("  首次攒到进度：帧 %s；首次灭菌：帧 %s" % (first_accrued, first_boiled))
check("出现过'先有进度、后遇灭菌'的顺序", first_accrued is not None
      and first_boiled is not None and first_accrued < first_boiled,
      "帧 %s < 帧 %s" % (first_accrued, first_boiled))
check("灭菌帧处进度确实被清零", first_boiled is not None and prog[first_boiled] == 0.0,
      "该帧 progress=%s" % (prog[first_boiled] if first_boiled is not None else "N/A"))
check("灭菌后离开近日点能重新开始攒进度",
      first_boiled is not None and any(p > 0.0 for p in prog[first_boiled:]),
      "灭菌后最大进度 %.4f" % (max(prog[first_boiled:]) if first_boiled is not None else 0.0))
check("判定码在一条轨道上出现过至少两档（同一颗星按位置换状态）",
      len(set(Z["verdict"])) >= 2, "出现过的判定: %s" % sorted(set(Z["verdict"])))

emit()
if fails:
    emit("FAILED: %d 项未通过 -> %s" % (len(fails), "; ".join(fails)))
else:
    emit("全部通过：真实二进制跑出来的 JSON 与三层文档口径一致。")

with open(Path(__file__).with_name("_probe_bio_cli.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(LOG) + "\n")
raise SystemExit(1 if fails else 0)
