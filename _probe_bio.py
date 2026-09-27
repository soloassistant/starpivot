# -*- coding: utf-8 -*-
"""生物演化层的独立复算。

本机没有 C++ 编译器，所以 bio.cpp 无法编译验证。这里换一条路：把同一份物理
用 SI 单位从第一性原理重推一遍，再和内核里的归一化写法对答案。

关键区别 —— 这不是把 bio.cpp 抄一遍：
  * 内核:  T_eq = 278.6 · ((1−A)·S)^(1/4)，S = (L/L☉)/r_AU²
  * 本文:  flux = L/(4πd²)  [W/m²]，T_eq = (flux·(1−A)/(4σ))^(1/4)
两条路径只在数值上相遇，谁抄错常量都会当场露出来。特别是 278.6 这个系数，
本文是现算出来的（[L☉/(16πσ·AU²)]^(1/4)），不是抄进代码里的。

第二件事：把 step_bio 的推进算术在 Python 里重放，验证 test_bio.cpp 里那几条
判据的期望值——如果单测的期望本身写错了，编译通过也没用。上一轮这一层抓出了
4 处期望值错误（含我自己口算错的倍率与锚点末位）。

第三件事：把太阳系九颗星按日心距跑一遍，看模型到底给出什么，而不是我以为
它给出什么。
"""

import math
import os

# ---- 物理常量（SI，CODATA / IAU 2015 名义值）----
SIGMA = 5.670374419e-8        # Stefan-Boltzmann, W m^-2 K^-4
L_SUN = 3.828e26              # 太阳光度, W
AU = 1.495978707e11           # m
T_SUN = 5772.0                # 太阳有效温度, K
R_SUN = 6.957e8               # 太阳半径, m

# ---- 内核里的常量（必须与 bio.hpp 逐字一致）----
K_TEQ_REF = 278.6             # T_sun = 5778 K 那一支
K_FREEZE = 273.0              # 水的冰点，有物理出处
K_BOIL = 373.0                # 水的沸点，有物理出处
K_GREENHOUSE = 33.0           # 地球实测温室增温，经验常数
K_DEFAULT_ALBEDO = 0.306
K_PEAK = 288.0                # 速率高斯峰（地表温度，编排）
K_SIGMA = 28.0                # 半宽（编排）
K_STAGES = 9
FULL_LADDER = 100.0           # 默认编排旋钮

fails = []
LOG = []


def emit(line=""):
    print(line)
    LOG.append(line)


def check(name, ok, detail=""):
    emit(("PASS  " if ok else "FAIL  ") + name + (("   " + detail) if detail else ""))
    if not ok:
        fails.append(name)


# ---------------------------------------------------------------------------
# 1. 系数 278.6 的来源：AU 处的归一化因子，现算
# ---------------------------------------------------------------------------
ref = (L_SUN / (16.0 * math.pi * SIGMA * AU * AU)) ** 0.25
check("278.6 可由 SI 常量现算出来（残差 0.1%，来自 T_sun 的取值）", abs(ref - K_TEQ_REF) < 0.5,
      "现算 %.3f vs 内核 %.1f，相对差 %.2e" % (ref, K_TEQ_REF, abs(ref - K_TEQ_REF) / K_TEQ_REF))

# 另一条独立路径：T_sun·sqrt(R_sun/(2d))，d = 1 AU。5778 K 给 278.62，5772 K 给 278.33。
ref2 = T_SUN * math.sqrt(R_SUN / (2.0 * AU))
ref3 = 5778.0 * math.sqrt(R_SUN / (2.0 * AU))
check("278.6 也可由 T_sun·sqrt(R_sun/2d) 现算出来（5772 K 支）", abs(ref2 - K_TEQ_REF) < 0.5,
      "现算 %.3f" % ref2)
check("278.6 对应 T_sun = 5778 K 那一支（不是 5772 K）",
      abs(ref3 - K_TEQ_REF) < 0.1 and abs(ref2 - K_TEQ_REF) > 0.2,
      "5778 K -> %.2f K（与内核 %.1f 差 %.2f），5772 K -> %.2f K（差 %.2f）" % (
          ref3, K_TEQ_REF, abs(ref3 - K_TEQ_REF), ref2, abs(ref2 - K_TEQ_REF)))


# ---------------------------------------------------------------------------
# 2. 内核对写法的复刻 vs SI 第一性原理
# ---------------------------------------------------------------------------
def luminosity_msun(m):
    if not (m > 0.0):
        return 0.0
    return m ** 3.5


def insolation_au(r_au, lum_lsun):
    if not (r_au > 0.0) or not (lum_lsun > 0.0):
        return 0.0
    return lum_lsun / (r_au * r_au)


def teq_kernel(s, albedo):
    if not (s > 0.0):
        return 0.0
    a = albedo if albedo > 0.0 else K_DEFAULT_ALBEDO
    if not (a < 1.0):
        return 0.0
    f = (1.0 - a) * s
    if not (f > 0.0):
        return 0.0
    return K_TEQ_REF * f ** 0.25


def tsurf_kernel(t_eq, greenhouse):
    if not (t_eq > 0.0):
        return 0.0
    return t_eq + (greenhouse if greenhouse > 0.0 else 0.0)


def teq_si(r_au, lum_lsun, albedo):
    """完全走 SI：光度 -> 通量 -> 斯特藩-玻尔兹曼。"""
    d = r_au * AU
    if not (d > 0.0) or not (lum_lsun > 0.0):
        return 0.0
    flux = lum_lsun * L_SUN / (4.0 * math.pi * d * d)
    return (flux * (1.0 - albedo) / (4.0 * SIGMA)) ** 0.25


worst, worst_at = 0.0, (0, 0)
for m in (0.3, 0.8, 1.0, 1.4, 2.0):
    for r in (0.2, 0.5, 1.0, 1.524, 5.2, 19.2, 30.1):
        k = teq_kernel(insolation_au(r, luminosity_msun(m)), K_DEFAULT_ALBEDO)
        s = teq_si(r, luminosity_msun(m), K_DEFAULT_ALBEDO)
        rel = abs(k - s) / s
        if rel > worst:
            worst, worst_at = rel, (m, r)
check("内核对写法 == SI 第一性原理（残差即 278.6 vs 278.33）", worst < 2e-3,
      "最大相对差 %.2e @ M=%.1f r=%.2f AU" % (worst, worst_at[0], worst_at[1]))


# ---------------------------------------------------------------------------
# 3. 距离方向：越远必须越冷（这正是内核曾经写错的地方）
# ---------------------------------------------------------------------------
t_near = teq_kernel(insolation_au(0.5, 1.0), K_DEFAULT_ALBEDO)
t_far = teq_kernel(insolation_au(4.0, 1.0), K_DEFAULT_ALBEDO)
# 0.5 AU -> 4 AU 距离差 8 倍 -> 通量差 64 倍 -> 温度差 64^(1/4) = sqrt(8) = 2.828。
# 第一版这里写的期望是 2.0（口算成"通量差 8 倍"），是判据错，被这一条自己抓出来。
check("越远越冷，比值 sqrt(8)=2.828", t_near > t_far and abs(t_near / t_far - math.sqrt(8.0)) < 1e-9,
      "%.2f K @0.5AU  vs  %.2f K @4AU，比值 %.4f" % (t_near, t_far, t_near / t_far))

prev, mono = 1e300, True
r = 0.05
while r < 60.0:
    t = teq_kernel(insolation_au(r, 1.0), K_DEFAULT_ALBEDO)
    if not (t < prev):
        mono = False
    prev = t
    r *= 1.2
check("沿日心距单调递减", mono)

# 反向判据：把内核写成除法（本轮真实踩到的 bug），地球处照样对，但方向会翻。
# 这一条必须成立，否则"只测地球"就是漏的 —— 这就是为什么单测里要专门有一条
# ColderFartherFromTheStar 而不是只留锚点。
div_at_1 = K_TEQ_REF * ((1.0 - K_DEFAULT_ALBEDO) / 1.0) ** 0.25
mul_at_1 = teq_kernel(1.0, K_DEFAULT_ALBEDO)
check("S=1 处乘法与除法给出同一个值（锚点抓不到这个错）", abs(div_at_1 - mul_at_1) < 1e-9,
      "乘法版 %.3f K，除法版 %.3f K" % (mul_at_1, div_at_1))
div_at_4 = K_TEQ_REF * ((1.0 - K_DEFAULT_ALBEDO) / 0.0625) ** 0.25   # 4 AU: S = 1/16
mul_at_4 = teq_kernel(insolation_au(4.0, 1.0), K_DEFAULT_ALBEDO)
check("但 4 AU 处两种写法方向相反（除法版把远行星算得更热）", div_at_4 > mul_at_4,
      "4AU: 乘法 %.1f K vs 除法 %.1f K" % (mul_at_4, div_at_4))


# ---------------------------------------------------------------------------
# 4. 锚点与地表温度
# ---------------------------------------------------------------------------
earth = teq_kernel(insolation_au(1.0, 1.0), K_DEFAULT_ALBEDO)
# 精确值 278.6 · 0.694^(1/4) = 254.285 K。第一版期望写的 254.58 来自我自己口算时
# 把 0.694^(1/4) 取成 0.9137（正确 0.91272），差 0.3 K —— 也是判据错。
check("地球平衡温度 = 254.285 K（教科书 255 K）", abs(earth - 254.285) < 0.01, "%.4f K" % earth)
check("系数用 5772 K 那一支则得 254.03 K，两者差 0.1%（内核取 5778 K 支）",
      abs(teq_si(1.0, 1.0, K_DEFAULT_ALBEDO) - 254.03) < 0.05,
      "SI 口径 %.3f K vs 内核算术 %.3f K" % (teq_si(1.0, 1.0, K_DEFAULT_ALBEDO), earth))

check("地表温 = T_eq + 33 K", abs(tsurf_kernel(earth, K_GREENHOUSE) - 287.285) < 0.01,
      "%.3f K" % tsurf_kernel(earth, K_GREENHOUSE))
check("无光照时地表温保持 0（不能凭空加上温室）",
      tsurf_kernel(0.0, K_GREENHOUSE) == 0.0 and tsurf_kernel(0.0, 0.0) == 0.0)
# 没有温室，地球自己的 T_eq 就在冰点以下 —— 这是把 ΔT 当常数用、而不是当定律的理由。
check("无温室时地球 T_eq 低于冰点（所以 ΔT 是必需的）", earth < K_FREEZE,
      "T_eq %.1f K < 冰点 %.0f K" % (earth, K_FREEZE))
check("加上 33 K 温室后地球进入液态水窗口",
      K_FREEZE < tsurf_kernel(earth, K_GREENHOUSE) < K_BOIL,
      "T_surf %.1f K" % tsurf_kernel(earth, K_GREENHOUSE))


# ---------------------------------------------------------------------------
# 5. 太阳系九颗星：模型到底给出什么
# ---------------------------------------------------------------------------
PLANETS = [
    ("Mercury", 0.38709927), ("Venus", 0.72333566), ("Earth", 1.00000261),
    ("Mars", 1.52371034), ("Jupiter", 5.20288700), ("Saturn", 9.53667594),
    ("Uranus", 19.18916464), ("Neptune", 30.06992276), ("Pluto", 39.48211675),
]


def rate_per_year(t_surf, full_years):
    if not (full_years > 0.0) or not (t_surf > 0.0):
        return 0.0
    d = (t_surf - K_PEAK) / K_SIGMA
    return math.exp(-d * d) / full_years


def verdict(t_surf):
    if t_surf >= K_BOIL:
        return "sterilized"
    if t_surf > K_FREEZE:
        return "evolving"
    return "frozen"


ZH = {"sterilized": "灭菌(>=373K)", "frozen": "冻结(<=273K)", "evolving": "液态水窗口内"}


def progress_after(t_surf, years, full_years):
    """与 step_bio 的分支结构一致：先沸点、再冰点、最后才是高斯速率。
    表格里必须走同一套闸门，否则会打出"火星有 0.047 进度"这种实现上不可能的数。"""
    if not (t_surf > K_FREEZE) or t_surf >= K_BOIL:
        return 0.0
    return min(rate_per_year(t_surf, full_years) * years, 1.0)


emit()
emit("太阳系按日心距的演化倾向（默认 --bio-years 100，50 年积分）：")
emit("  %-9s %8s %9s %9s %9s  %-14s %s" % (
    "body", "a/AU", "S(/Earth)", "T_eq/K", "T_surf/K", "模型判定", "50年进度(阶)"))
for name, a in PLANETS:
    s = insolation_au(a, 1.0)
    t = teq_kernel(s, K_DEFAULT_ALBEDO)
    ts = tsurf_kernel(t, K_GREENHOUSE)
    p = progress_after(ts, 50.0, FULL_LADDER)
    emit("  %-9s %8.4f %9.5f %9.1f %9.1f  %-14s %.4f (第 %d 阶)" % (
        name, a, s, t, ts, ZH[verdict(ts)], p, min(int(p * K_STAGES), K_STAGES - 1)))

# 判据：与 test_bio.cpp 的 SolarSystemVerdictsFollowFromTheTwoGates 逐条对齐
EXPECT_VERDICT = {
    "Mercury": "sterilized", "Venus": "evolving", "Earth": "evolving",
    "Mars": "frozen", "Jupiter": "frozen", "Neptune": "frozen",
}
for name, a in PLANETS:
    if name not in EXPECT_VERDICT:
        continue
    ts = tsurf_kernel(teq_kernel(insolation_au(a, 1.0), K_DEFAULT_ALBEDO), K_GREENHOUSE)
    check("判定 %-8s = %s" % (name, EXPECT_VERDICT[name]), verdict(ts) == EXPECT_VERDICT[name],
          "T_surf %.1f K" % ts)

check("金星 T_eq 与真实地表 737 K 相差极大（模型已知局限）",
      teq_kernel(insolation_au(0.72333566, 1.0), K_DEFAULT_ALBEDO) < 400.0,
      "T_eq/T_surf %.0f/%.0f K vs 真实地表 ~737 K" % (
          teq_kernel(insolation_au(0.72333566, 1.0), K_DEFAULT_ALBEDO),
          tsurf_kernel(teq_kernel(insolation_au(0.72333566, 1.0), K_DEFAULT_ALBEDO), K_GREENHOUSE)))

# 火星加厚大气 -> 进窗口。这是"位置 + 大气决定演化"的交互卖点，必须真能成立。
mars_t = tsurf_kernel(teq_kernel(insolation_au(1.52371034, 1.0), K_DEFAULT_ALBEDO), 100.0)
check("给火星 100 K 温室后进入液态水窗口", verdict(mars_t) == "evolving", "T_surf %.1f K" % mars_t)


# ---------------------------------------------------------------------------
# 6. step_bio 的推进算术重放：验证 test_bio.cpp 的期望值本身对不对
# ---------------------------------------------------------------------------
def P(full=FULL_LADDER, greenhouse=K_GREENHOUSE, albedo=K_DEFAULT_ALBEDO):
    """与 C++ 的 BioParams 同构。用字典而不用位置参数，是因为上一版把
    (albedo, greenhouse, full) 的次序在几处调用里写反了，静默算出"albedo=10"
    这种输入 —— 位置参数在这里没有犯错的价值。"""
    return {"full": full, "greenhouse": greenhouse, "albedo": albedo}


def step_bio(st, r_au, lum, dt, p, t_now):
    albedo, greenhouse, full = p["albedo"], p["greenhouse"], p["full"]
    s = insolation_au(r_au, lum)
    t = teq_kernel(s, albedo)
    ts = tsurf_kernel(t, greenhouse)
    st["insolation"], st["t_eq_K"], st["t_surf_K"] = s, t, ts
    if not (dt > 0.0):
        return
    if ts >= K_BOIL:
        if st["progress"] > 0.0:
            st["progress"], st["stage"], st["t_stage"] = 0.0, 0, t_now
        return
    if not (ts > K_FREEZE):
        return
    rate = rate_per_year(ts, full)
    if not (rate > 0.0):
        return
    p0 = st["progress"]
    p1 = min(p0 + rate * dt, 1.0)
    if p1 <= p0:
        return
    st["progress"] = p1
    target = min(int(p1 * K_STAGES), K_STAGES - 1)
    if target <= st["stage"]:
        return
    denom = p1 - p0
    frac = 1.0 if denom <= 0 else max(0.0, min(1.0, (target / K_STAGES - p0) / denom))
    st["t_stage"] = t_now - dt * (1.0 - frac)
    st["stage"] = target


def fresh():
    return {"progress": 0.0, "t_eq_K": 0.0, "t_surf_K": 0.0, "insolation": 0.0,
            "t_stage": 0.0, "stage": 0}


def run_earth(years, full=FULL_LADDER, greenhouse=K_GREENHOUSE, albedo=K_DEFAULT_ALBEDO):
    st = fresh()
    for i in range(years):
        step_bio(st, 1.0, 1.0, 1.0, P(full, greenhouse, albedo), float(i))
    return st


st = run_earth(50)
# 地球 T_surf 287.285 K，高斯峰 288 K -> g = 0.99935；50 年 / 100 年阶梯 = 一半 -> 第 4 阶。
# 第一版期望写的是第 8 阶（我按错误的速率手算），这一条也是判据错。
check("50 年 / 100 年阶梯 -> 进度一半、第 4 阶",
      st["stage"] == 4 and abs(st["progress"] - 0.49967) < 0.002,
      "stage=%d progress=%.5f" % (st["stage"], st["progress"]))

st = run_earth(120)
check("120 年 / 100 年阶梯 -> 第 8 阶且 progress 恰为 1.0",
      st["stage"] == 8 and st["progress"] == 1.0,
      "stage=%d progress=%.10f" % (st["stage"], st["progress"]))

st = run_earth(50, greenhouse=0.0)
check("温室归零后地球停在死寂岩石（模型的自洽性检验）",
      st["progress"] == 0.0 and st["stage"] == 0,
      "T_surf %.1f K < 冰点" % st["t_surf_K"])

st = fresh()
step_bio(st, 1.0, 1.0, 1.0e6, P(full=1.0), 1.0e6)
check("巨步长下 progress 钳到 1 不溢出", st["progress"] == 1.0 and st["stage"] == 8,
      "progress=%.6f stage=%d" % (st["progress"], st["stage"]))

st = fresh()
st["progress"], st["stage"] = 1.0, 8
step_bio(st, 1.0, 1.0, 1.0, P(full=1.0), 1.0)
check("progress 已满时不新造出第 9 阶", st["stage"] == 8, "stage=%d" % st["stage"])

# 沸点：0.05 AU 处 T_surf ≈ 1171 K
st = fresh()
for i in range(10):
    step_bio(st, 1.0, 1.0, 1.0, P(full=10.0), float(i))
before = (st["progress"], st["stage"])
step_bio(st, 0.05, 1.0, 1.0, P(full=10.0), 20.0)
check("0.05 AU 处灭菌归零", st["stage"] == 0 and st["progress"] == 0.0,
      "灭菌前 progress=%.4f stage=%d，0.05AU 处 T_surf=%.0f K" % (
          before[0], before[1], st["t_surf_K"]))

# 冰点：6 AU 处 T_surf ≈ 137 K，冻住但不倒退；回到 1 AU 后从原处继续
st = fresh()
for i in range(20):
    step_bio(st, 1.0, 1.0, 1.0, P(), float(i))
held, held_stage = st["progress"], st["stage"]
step_bio(st, 6.0, 1.0, 1.0, P(), 100.0)
froze = st["progress"] == held and st["stage"] == held_stage
step_bio(st, 1.0, 1.0, 10.0, P(), 200.0)
check("冰点处停滞不倒退，回暖后从原处续上",
      froze and held_stage > 0 and st["progress"] > held,
      "6AU 处 T_surf=%.1f K；进度 %.4f -> 冻住 -> %.4f" % (
          tsurf_kernel(teq_kernel(insolation_au(6.0, 1.0), K_DEFAULT_ALBEDO), K_GREENHOUSE),
          held, st["progress"]))

# 0.5 AU 现在是 392 K —— 加了温室后跨过沸点了，正好用来验证"过热"与"过冷"是两支
t05 = tsurf_kernel(teq_kernel(insolation_au(0.5, 1.0), K_DEFAULT_ALBEDO), K_GREENHOUSE)
check("0.5 AU 加温室后 T_surf ≈ 392.6 K，落在灭菌侧而不是停滞侧", t05 >= K_BOIL, "%.1f K" % t05)

st = fresh()
step_bio(st, 1.0, 1.0, 4.0, P(full=10.0), 100.0)
check("首次跨阶时刻落在步内 (96,100]", 96.0 <= st["t_stage"] <= 100.0 and st["stage"] == 3,
      "t_stage=%.4f stage=%d" % (st["t_stage"], st["stage"]))
last, ok_mono = st["t_stage"], True
for i in range(1, 20):
    t = 100.0 + i * 4.0
    step_bio(st, 1.0, 1.0, 4.0, P(full=10.0), t)
    if st["t_stage"] < last - 1e-9:
        ok_mono = False
    last = st["t_stage"]
check("跨阶时刻单调不减", ok_mono)

st = fresh()
step_bio(st, 1.0, 1.0, 0.0, P(), 0.0)
check("dt=0 时仍回报三个温度（页面要能解释为什么不动）",
      abs(st["insolation"] - 1.0) < 1e-12 and abs(st["t_eq_K"] - 254.285) < 0.02
      and abs(st["t_surf_K"] - 287.285) < 0.02,
      "S=%.3f T_eq=%.3f T_surf=%.3f" % (st["insolation"], st["t_eq_K"], st["t_surf_K"]))

st = fresh()
step_bio(st, 1.0, 1.0, 1.0, P(full=0.0), 1.0)
check("阶梯长度 0 时不推进（不除以零、也不瞬间产生文明）",
      st["progress"] == 0.0 and st["t_surf_K"] > 0.0, "T_surf=%.1f K" % st["t_surf_K"])


# ---------------------------------------------------------------------------
# 7. 退化输入：CLI 会把质量 0 的试验粒子、albedo >= 1、负温室都送进来
# ---------------------------------------------------------------------------
ok_finite, first_bad = True, ""
for r in (0.0, -1.0, 5.0):
    for l in (0.0, -1.0, 5.0):
        for a in (0.0, 0.5, 1.0, 4.0):
            for g in (-50.0, 0.0, 33.0, 1e6):
                s = insolation_au(r, l)
                t = teq_kernel(s, a)
                ts = tsurf_kernel(t, g)
                for v in (s, t, ts):
                    if math.isnan(v) or math.isinf(v):
                        ok_finite = False
                        first_bad = first_bad or "r=%g l=%g a=%g g=%g -> %g" % (r, l, a, g, v)
check("退化输入不产生 NaN/inf", ok_finite, first_bad)

check("质量 0 的光源光度为 0", luminosity_msun(0.0) == 0.0 and luminosity_msun(-1.0) == 0.0)
check("恒星自身（r=0）为死寂岩石且没有phantom地表温",
      teq_kernel(insolation_au(0.0, 1.0), K_DEFAULT_ALBEDO) == 0.0
      and tsurf_kernel(0.0, K_GREENHOUSE) == 0.0)

# 1e300 这类输入：r*r 在 double 下溢出为 inf，内核靠 !isfinite 兜住
over = 1e300 * 1e300
check("r=1e300 时 r*r 确实溢出为 inf，内核返回 0 是必要的而不是多余的",
      math.isinf(over), "1e300^2 = %s" % over)

check("albedo >= 1 返回 0（不能给负温度）",
      teq_kernel(1.0, 1.0) == 0.0 and teq_kernel(1.0, 1.5) == 0.0,
      "albedo=1.0 -> %.1f K，albedo=1.5 -> %.1f K" % (teq_kernel(1.0, 1.0), teq_kernel(1.0, 1.5)))
check("albedo <= 0 回退到地球默认值（而不是炸掉）",
      abs(teq_kernel(1.0, 0.0) - earth) < 1e-12 and abs(teq_kernel(1.0, -0.5) - earth) < 1e-12)

emit()
if fails:
    emit("FAILED: %d 项未通过 -> %s" % (len(fails), "; ".join(fails)))
else:
    emit("全部通过：内核对写法与 SI 第一性原理一致，单测期望值经独立复算确认。")

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "_probe_bio.txt"),
          "w", encoding="utf-8") as f:
    f.write("\n".join(LOG) + "\n")
raise SystemExit(1 if fails else 0)
