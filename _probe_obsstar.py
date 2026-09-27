# -*- coding: utf-8 -*-
"""观测覆盖判据：把「某一类星」变成「这一颗星」，并证明这件事不是装饰。

为什么需要这条功能（先有反例，再写判据）
----------------------------------------
内核原本只能按「天体类型」给光度。类型表是**代表值**，而质光关系 L∝M^3.5 只在
约 0.43~2 Msun 可靠，0.43 Msun 以下只是外推，且实测偏低。TRAPPIST-1 是最尖锐的一例：

    实测    M=0.0898 Msun, R=0.1192 Rsun, T=2566 K  →  L=5.53e-4 Lsun
    类型表  M_V 走 L=M^3.5                          →  L=2.17e-4 Lsun（低 2.5 倍）

这**不是**「显示得不好看」：辐照度 S=L/r² 直接决定行星是否落在可居带。用错的光度，
同一颗 TRAPPIST-1 e 的地表温会差 47 K（213 K vs 261 K）—— 页面会在它最不该出错的
地方出错。所以内核必须能表达"这一颗星的观测值"。

判据分四类，层层不可互相替代
----------------------------
  A 常数自洽     先证明判据自己算得对（SI 复算太阳 → 1 Lsun）
  B 覆盖生效     观测值真的进了内核，且能被 SI 路径独立复算出来
  C 数据没抄错   7 颗行星的 a/e/质量/半径逐个对齐 data/real_exoplanets.json
  D 反例仍然在   只用类型表会低 2.5 倍、行星地表温差几十 K（这条功能存在的理由）
  E 负路径       不该接受的东西必须被拒，且给出准确的错因
"""

import json
import math
import subprocess
import sys
from pathlib import Path

ROOT = Path("C:/Users/geral/WorkBuddy/2026-09-24-16-11-48/starpivot")
EXE = ROOT / "build" / "bin" / "starpivot.exe"
DATA = ROOT / "data" / "real_exoplanets.json"

# ---- 判据里用到的常数，全部走 SI，与被测代码的归一化写法分开 ----
SIGMA_SB = 5.670374419e-8      # W m^-2 K^-4
L_SUN_W = 3.828e26             # W（IAU 2015 nominal）
R_SUN_KM = 696340.0            # km（IAU nominal）
T_SUN_K = 5778.0               # K（内核 bodytype.hpp 的锚点）
M_JUP_MSUN = 9.5458e-4         # IAU nominal GM_Jup / GM_sun
R_EARTH_KM = 6371.0            # km（IAU nominal）
G_AU3_MSUN_YR2 = 4.0 * math.pi ** 2

fails = []
LOG = []


def emit(s=""):
    print(s)
    LOG.append(s)


def check(name, ok, detail=""):
    emit(("PASS  " if ok else "FAIL  ") + name + (("   " + detail) if detail else ""))
    if not ok:
        fails.append(name)


def lum_from_radius_t_si(radius_km, t_eff_K):
    """SI 路径：L = 4πR²σT⁴ / Lsun。与被测代码的 (R/Rsun)²(T/Tsun)⁴ 是两条路。"""
    r_m = radius_km * 1000.0
    return 4.0 * math.pi * r_m * r_m * SIGMA_SB * (t_eff_K ** 4) / L_SUN_W


def radius_from_lum_t_si(lum_lsun, t_eff_K):
    """SI 路径反解：R = sqrt(L / (4πσT⁴))。"""
    l_w = lum_lsun * L_SUN_W
    return math.sqrt(l_w / (4.0 * math.pi * SIGMA_SB * (t_eff_K ** 4))) / 1000.0


def run(args, timeout=900):
    r = subprocess.run([str(EXE)] + args, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout)
    if r.returncode != 0:
        return None, (r.stderr or r.stdout or "")[:300]
    try:
        return json.loads(r.stdout), ""
    except Exception as e:                                  # noqa: BLE001
        return None, "JSON parse failed: %s" % e


data = json.loads(DATA.read_text(encoding="utf-8"))
systems = {s["hostname"]: s for s in data["systems"]}
tr = systems["TRAPPIST-1"]

# ===========================================================================
emit("=" * 76)
emit("A. 先校准判据自己：SI 复算太阳，应当回到 1 Lsun")
sun_si = lum_from_radius_t_si(R_SUN_KM, T_SUN_K)
# IAU nominal 的 Rsun / Tsun / Lsun 三者本身不完全自洽，这条偏差是常数取值的既有性质，
# 不是本判据的误差 —— 把它量出来并写进报告，后面所有比较才有正确的容差。
check("SI 复算太阳 ≈ 1 Lsun（把常数集自身的不自洽量出来）",
      abs(sun_si - 1.0) < 0.02,
      "%.5f Lsun（偏差 %+.3f%%）—— 后续比较的容差按它定" % (sun_si, (sun_si - 1) * 100))
# 容差必须由证据定，不能凭手感。两条独立的量化误差：
#   1. 常数集不自洽：IAU nominal 的 Rsun / Tsun / Lsun 三者不是自洽的一组，
#      太阳在 SI 路径下得 1.006 Lsun。任何"内核归一化值 ↔ SI 值"的比较都要带上它。
#      L 的容差直接取它，R ∝ √L 所以容差约一半。
#   2. 输出量化：JSON 里 radius_km / a_AU / e / mass 都是 %.6g（6 位有效数字）。
#      最坏相对误差 = 0.5 × 10^(-5) / mantissa，mantissa ∈ [1,10)
#      → 最大 5e-6（尾数接近 1 时），最小 5e-7（尾数接近 10 时）。
#      ——这一条本轮连续踩了两次：先卡 1e-9 误报 6 颗行星"半径对不上"；
#        改成 2e-6 之后，TOI-178 的 1.7e4 km 量级又误报 2 颗 ——
#        因为它恰好落在"尾数接近 1"那一档。容差必须按**最坏**情况定，不能按手头这组数定：
#        手头这组数碰巧是好数，就测不出真错；恰好是坏数，就误报。取 6e-6 留一点余量。
#      这个容差比"抄错一位"（10% 量级）紧四个数量级，抓错能力一点没少。
_SUN_BIAS = abs(sun_si - 1.0)
SI_TOL_L = max(0.01, 2.0 * _SUN_BIAS)
SI_TOL_R = max(0.005, _SUN_BIAS)
JSON_REL = 6e-6

# 数据文件自带的单位换算因子，必须等于判据独立知道的 IAU nominal 值。
# 为什么值得单独一条：页面要拿 (pl_bmassj, pl_rade, st_rad) 去拼 --body，
# 而它**只能**读数据文件里这一份因子（页面不许自己抄常数）。若文件里的数
# 与判据用的不一致，判据验的是"A 换算"、页面跑的是"B 换算"，两边都绿而线上是错的。
_conv = data["conversions"]
check("数据文件的单位换算因子 = IAU nominal（页面与判据必须是同一次换算）",
      abs(_conv["M_jup_to_Msun"] - M_JUP_MSUN) < 1e-15
      and abs(_conv["R_earth_to_km"] - R_EARTH_KM) < 1e-9
      and abs(_conv["R_sun_to_km"] - R_SUN_KM) < 1e-9,
      "M_jup=%.6g  R_earth=%.6g  R_sun=%.6g"
      % (_conv["M_jup_to_Msun"], _conv["R_earth_to_km"], _conv["R_sun_to_km"]))

# ===========================================================================
emit("=" * 76)
emit("B. TRAPPIST-1：观测覆盖真的进了内核，且能被 SI 路径独立复算")

star = tr["star"]
st_m, st_r, st_t = star["st_mass"], star["st_rad"], star["st_teff"]
st_radius_km = st_r * R_SUN_KM
# L 不是直接观测的：由两个观测量 R 与 T 推出来（这就是"推导值"，不是"观测值"）
st_lum = lum_from_radius_t_si(st_radius_km, st_t)
emit("  宿主（NASA Exoplanet Archive pscomppars）：M=%.4f Msun  R=%.4f Rsun=%.1f km  "
     "T=%.1f K" % (st_m, st_r, st_radius_km, st_t))
emit("  由 R 与 T 推出的 L = %.6g Lsun（SI 路径；推导值，不是直接观测）"
     % st_lum)


def star_spec(mass, radius_km=None, extra=""):
    s = "TRAPPIST-1,1,0,0,0,0,0,M_V:%.10g" % mass
    if radius_km is not None:
        s += ",%.10g" % radius_km
    return s + extra


def planet_specs():
    out = []
    for p in tr["planets"]:
        out.append("%s,%.10g,%.10g,0,0,0,0,%.10g,%.10g"
                   % (p["name"], p["pl_orbsmax"], p["pl_orbeccen"],
                      p["pl_bmassj"] * M_JUP_MSUN, p["pl_rade"] * R_EARTH_KM))
    return out


def run_system(spec_star, years="0.05", samples=120):
    args = ["nbody", "--scenario", "custom", "--solar", "none",
            "--years", years, "--samples", str(samples),
            "--primary", "TRAPPIST-1", "--body", spec_star]
    for p in planet_specs():
        args += ["--body", p]
    return run(args)


js, err = run_system(star_spec(st_m, st_radius_km,
                               ",teff_K=%.10g,lum_lsun=%.10g" % (st_t, st_lum)))
check("内核接受「TRAPPIST-1 宿主 + 7 颗行星」这一组真实初值", js is not None, err)
if js is None:
    emit("\n（后续判据无法进行）")
    Path(__file__).with_name("_probe_obsstar.txt").write_text("\n".join(LOG) + "\n",
                                                             encoding="utf-8")
    sys.exit(1)

bodies = {b["id"]: b for b in js["bodies"]}
S = bodies["TRAPPIST-1"]
check("天体数与数据文件一致（宿主 + %d 颗行星）" % len(tr["planets"]),
      len(js["bodies"]) == len(tr["planets"]) + 1,
      "内核回显 %d 个" % len(js["bodies"]))
check("有效温度标成 given（页面据此说这是观测值）",
      S["t_eff_src"] == "given" and abs(S["t_eff_K"] - st_t) < 1e-9,
      "t_eff_K=%.6g src=%s" % (S["t_eff_K"], S["t_eff_src"]))
check("光度标成 given", S["luminosity_src"] == "given",
      "src=%s" % S["luminosity_src"])
check("光度数值与 SI 独立复算一致",
      abs(S["luminosity_Lsun"] - st_lum) / st_lum < 1e-6,
      "内核 %.6g / SI %.6g" % (S["luminosity_Lsun"], st_lum))
check("显式给的观测半径被尊重（没被类型表顶掉）",
      abs(S["radius_km"] - st_radius_km) / st_radius_km < JSON_REL,
      "内核 %.6g km / 观测 %.6g km（差 %.2g%%）"
      % (S["radius_km"], st_radius_km,
         abs(S["radius_km"] - st_radius_km) / st_radius_km * 100))
check("宿主被认成发光天体（0.0898 刚好在氢燃烧下限 0.08 之上）",
      S["emits_light"] is True, "")

# 辐照度真的用了观测光度（总光度 = 那些发光的 L 之和）
check("系统总光度 = 观测光度（辐照度 S=L/r² 用的就是它）",
      abs(js.get("total_luminosity_Lsun", -1) - st_lum) / st_lum < 1e-6,
      "%.6g Lsun" % js.get("total_luminosity_Lsun", float("nan")))

# ===========================================================================
emit("=" * 76)
emit("C. 半径推导路径：不给半径，只给观测 T 与 L，半径应由内核按 SB 重推")
js2, err2 = run_system(star_spec(st_m, None,
                                 ",teff_K=%.10g,lum_lsun=%.10g" % (st_t, st_lum)))
check("不给半径时内核仍然接受", js2 is not None, err2)
if js2 is not None:
    S2 = {b["id"]: b for b in js2["bodies"]}["TRAPPIST-1"]
    r_si = radius_from_lum_t_si(st_lum, st_t)
    check("推出来的半径 = SB(T,L) 的 SI 复算值",
          abs(S2["radius_km"] - r_si) / r_si < SI_TOL_R,
          "内核 %.1f km / SI %.1f km（差 %.3f%%，容差 %.3f%% 来自常数集不自洽）"
          % (S2["radius_km"], r_si, abs(S2["radius_km"] - r_si) / r_si * 100,
             SI_TOL_R * 100))
    # 这是本轮修掉的一个真实陷阱：若拿类型表的代表 T/L 去推，会得到 0.048 Rsun。
    check("推出来的半径接近观测半径（说明用的是观测 T/L，不是类型表的代表值）",
          abs(S2["radius_km"] - st_radius_km) / st_radius_km < SI_TOL_R,
          "偏差 %.2f%%（若误用类型 T/L 会偏 %.0f%%）"
          % (abs(S2["radius_km"] - st_radius_km) / st_radius_km * 100,
             abs(0.0481 * R_SUN_KM - st_radius_km) / st_radius_km * 100))

# ===========================================================================
emit("=" * 76)
emit("D. 数据没有抄错：每颗行星的初值逐个对齐 data/real_exoplanets.json")
bad = []
for p in tr["planets"]:
    b = bodies.get(p["name"])
    if b is None:
        bad.append("%s 不在内核输出里" % p["name"])
        continue
    ic = b["ic_heliocentric"]
    m_expect = p["pl_bmassj"] * M_JUP_MSUN
    r_expect = p["pl_rade"] * R_EARTH_KM
    # 容差取 JSON 的打印精度（radius_km / a_AU / e 都是 %.6g）。
    # 抄错一位是 10% 量级的差，这个容差比它紧三个数量级，足够抓错。
    if abs(ic["a_AU"] - p["pl_orbsmax"]) / p["pl_orbsmax"] > JSON_REL: bad.append("%s a" % p["name"])
    if abs(ic["e"] - p["pl_orbeccen"]) > JSON_REL: bad.append("%s e" % p["name"])
    if abs(b["mass_msun"] - m_expect) / m_expect > JSON_REL: bad.append("%s mass" % p["name"])
    if abs(b["radius_km"] - r_expect) / r_expect > JSON_REL: bad.append("%s radius" % p["name"])
check("7 颗行星的 a / e / 质量 / 半径与数据文件逐位一致", not bad, "; ".join(bad))

# ===========================================================================
emit("=" * 76)
emit("E. 开普勒第三定律：用**接线之后**的 a 与宿主质量算周期，对实测周期")
worst = ("", 0.0)
for p in tr["planets"]:
    a = p["pl_orbsmax"]
    t_pred_yr = math.sqrt(a ** 3 / st_m)
    t_pred_d = t_pred_yr * 365.25
    dev = abs(t_pred_d - p["pl_orbper"]) / p["pl_orbper"]
    if dev > worst[1]:
        worst = (p["name"], dev)
    emit("    %-14s a=%.5f AU → 预测 %.6f d，实测 %.6f d，偏差 %.3f%%"
         % (p["name"], a, t_pred_d, p["pl_orbper"], dev * 100))
check("全部 7 颗的预测周期都在实测的 0.5% 内（a 与周期来自不同观测量）",
      worst[1] < 0.005, "最大偏差 %s %.4f%%" % (worst[0], worst[1] * 100))

# ===========================================================================
emit("=" * 76)
emit("F. 反例仍然在（这条功能存在的理由）：只用类型表会低 2.5 倍，行星差几十 K")
js_type, err3 = run_system(star_spec(st_m, st_radius_km))
check("不给覆盖时内核仍然可用（类型表这条路没被破坏）", js_type is not None, err3)
if js_type is not None:
    S3 = {b["id"]: b for b in js_type["bodies"]}["TRAPPIST-1"]
    ratio = st_lum / S3["luminosity_Lsun"] if S3["luminosity_Lsun"] > 0 else float("inf")
    emit("    类型表 L=%.6g (src=%s)  vs  观测 L=%.6g  →  类型表低估 %.2f 倍"
         % (S3["luminosity_Lsun"], S3["luminosity_src"], st_lum, ratio))
    check("类型表确实低估（若哪天质光关系被修好，这条会失败并提醒可以撤掉覆盖）",
          ratio > 2.0, "低估 %.2f 倍" % ratio)
    check("类型表这条路如实标成 type_grid（页面能区分「一类星」与「这一颗星」）",
          S3["luminosity_src"] == "type_grid" and S3["t_eff_src"] == "type_grid",
          "%s / %s" % (S3["luminosity_src"], S3["t_eff_src"]))

    def earth_e_temp(jsx):
        bio = {x["id"]: x for x in jsx["bio"]["bodies"]}
        return max(bio["TRAPPIST-1 e"]["t_surf_K"])

    t_obs = earth_e_temp(js)
    t_grid = earth_e_temp(js_type)
    emit("    TRAPPIST-1 e 地表温：观测光度 %.1f K  vs  类型表光度 %.1f K（差 %.1f K）"
         % (t_obs, t_grid, t_obs - t_grid))
    check("换用观测光度后行星地表温差 > 30 K（这就是「用错光度」的代价）",
          t_obs - t_grid > 30.0, "差 %.1f K" % (t_obs - t_grid))

# ===========================================================================
emit("=" * 76)
emit("G. 负路径：不该接受的东西必须被拒，且错因要准确")
neg = [
    ("给岩石行星设亮度",
     ["nbody", "--scenario", "custom", "--solar", "none", "--years", "1", "--samples", "3",
      "--body", "Rock,1,0,0,0,0,0,rocky:1e-6,6371,teff_K=300"],
     "does not emit light"),
    ("未知的 key=value 键",
     ["nbody", "--scenario", "custom", "--solar", "none", "--years", "1", "--samples", "3",
      "--body", "S,1,0,0,0,0,0,M_V:0.2,teff_K=3000,temperature=9"],
     "unknown extra key"),
    ("teff_K 给了 0",
     ["nbody", "--scenario", "custom", "--solar", "none", "--years", "1", "--samples", "3",
      "--body", "S,1,0,0,0,0,0,M_V:0.2,0,teff_K=0"],
     "positive finite"),
    ("可选项忘了写等号",
     ["nbody", "--scenario", "custom", "--solar", "none", "--years", "1", "--samples", "3",
      "--body", "S,1,0,0,0,0,0,M_V:0.2,0,teff_K"],
     "key=value"),
]
for label, args, needle in neg:
    jsx, errx = run(args)
    ok = jsx is None and needle in errx
    check("拒绝：%s" % label, ok, errx.strip()[:150] if not ok else
          ("如约报错（含 \"%s\"）" % needle))

# ===========================================================================
emit("=" * 76)
emit("H. 其余 4 个真实系统也都能接上（不只看 TRAPPIST-1）")
# 真实数据里本来就有缺测：TOI-178 b 没有偏心率。**缺测不补零** —— 给一颗行星
# 编一个 e=0 会静默改变它的动力学，而页面上看不出来。所以缺测的行星直接不喂给
# 内核，并把"排除了哪几颗、为什么"如实记在报告里。
REQUIRED = ("pl_orbsmax", "pl_orbeccen", "pl_bmassj", "pl_rade")
skipped = []
for name, sysx in systems.items():
    if name == "TRAPPIST-1":
        continue
    sx = sysx["star"]
    rkm = sx["st_rad"] * R_SUN_KM
    lum = lum_from_radius_t_si(rkm, sx["st_teff"])
    spec = "H,1,0,0,0,0,0,%.10g,%.10g,teff_K=%.10g,lum_lsun=%.10g" % (
        sx["st_mass"], rkm, sx["st_teff"], lum)
    args = ["nbody", "--scenario", "custom", "--solar", "none", "--years", "0.2",
            "--samples", "12", "--primary", "H", "--body", spec]
    fed = 0
    for p in sysx["planets"]:
        if any(p[k] is None for k in REQUIRED):
            skipped.append((p["name"], [k for k in REQUIRED if p[k] is None]))
            continue
        args += ["--body", "%s,%.10g,%.10g,0,0,0,0,%.10g,%.10g"
                 % (p["name"], p["pl_orbsmax"], p["pl_orbeccen"],
                    p["pl_bmassj"] * M_JUP_MSUN, p["pl_rade"] * R_EARTH_KM)]
        fed += 1
    jsy, erry = run(args)
    ok = jsy is not None
    detail = ""
    if ok:
        h = {b["id"]: b for b in jsy["bodies"]}["H"]
        ok = h["luminosity_src"] == "given" and abs(h["luminosity_Lsun"] - lum) / lum < 1e-6
        detail = "喂进 %d 颗；宿主 L=%.6g (src=%s)" % (
            fed, h["luminosity_Lsun"], h["luminosity_src"])
    else:
        detail = erry.strip()[:150]
    check("%s：接入 %d 颗行星且宿主光度走观测覆盖" % (name, fed), ok, detail)

check("缺测项按缺失处理，不补零（排除而不是编一个数）",
      len(skipped) == 1 and skipped[0][0] == "TOI-178 b",
      ("排除 " + "; ".join("%s 缺 %s" % (n, ",".join(k)) for n, k in skipped))
      if skipped else "（未发现缺测项）")

# ===========================================================================
emit("=" * 76)
emit("I. 数据表只给 (M, R, T)：L 必须由内核从这两个观测量推出来")
# NASA Exoplanet Archive pscomppars 里**没有** st_lum —— 只有 st_mass / st_rad / st_teff。
# 所以"数据 → 内核"这段路必须能只靠 (R, T) 得到 L；否则页面就得自己写
# L = (R/Rsun)^2*(T/Tsun)^4，等于把物理抄进了页面（本项目的规矩是页面一个数都不算）。
# 这段判据存在的原因：没有它，页面只能靠"显式传 L"才能正确 —— 而真实数据里没有 L。
js_rt, err_rt = run_system(star_spec(st_m, st_radius_km, ",teff_K=%.10g" % st_t))
check("只给 R 与 T（不给 L），内核照样收", js_rt is not None, err_rt)
if js_rt is not None:
    S4 = {b["id"]: b for b in js_rt["bodies"]}["TRAPPIST-1"]
    check("L 的来源标成 derived_from_radius_and_t_eff"
          "（页面据此说「由 R 与 T 推的」，而不是「直接观测的」）",
          S4["luminosity_src"] == "derived_from_radius_and_t_eff",
          "src=%s" % S4["luminosity_src"])
    check("由 R 与 T 推出来的 L 与 SI 复算一致",
          abs(S4["luminosity_Lsun"] - st_lum) / st_lum < SI_TOL_L,
          "内核 %.6g / SI %.6g（差 %.3f%%，容差 %.2f%%）"
          % (S4["luminosity_Lsun"], st_lum,
             abs(S4["luminosity_Lsun"] - st_lum) / st_lum * 100.0, SI_TOL_L * 100))
    # 这两条路的差应当**正好**等于常数集自身的不自洽（A 小节量出来的那个数，
    # 而不是"差不多大"）。理由可以说清：内核走 (R/Rsun)²(T/Tsun)⁴，SI 走
    # 4πR²σT⁴/Lsun，两者之比 = 把名义太阳代进 SI 公式的结果，与 (R,T) 无关。
    # 所以差值只能是 A 小节那个数。**差得比它更多**就说明内核里还有第二处不一致 ——
    # 这正是这条判据要盯的东西。（一开始我把容差写成 1e-9，那是把口径差当成了 bug。）
    _rel = (st_lum - S4["luminosity_Lsun"]) / S4["luminosity_Lsun"]
    check("与「显式给 L」那条路的差 = 常数集固有偏差（同一颗星只有一个 L）",
          abs(_rel - _SUN_BIAS) < 1e-9,
          "差 %+.4f%%  vs  A 小节量出的 %+.4f%%"
          % (_rel * 100, _SUN_BIAS * 100))
    _bio_rt = {x["id"]: x for x in js_rt["bio"]["bodies"]}
    _bio_L = {x["id"]: x for x in js["bio"]["bodies"]}
    _pairs = [(max(_bio_rt[k]["t_surf_K"]), max(_bio_L[k]["t_surf_K"]))
              for k in _bio_rt if k in _bio_L and _bio_rt[k].get("t_surf_K")]
    # 温度差由 L 的偏差按 T ∝ L^(1/4) 传下来：0.601% 的 L 差 → 0.15% 的 T 差，
    # 262 K 上是 0.4 K 量级。所以容差是 1 K，不是 1e-9 —— 温差不为零是对的，
    # 它就在告诉你"两个 L 确实只差常数口径那一项"。
    _dmax = max(abs(a - b) for a, b in _pairs) if _pairs else -1.0
    check("每颗行星的地表温差也在 L^(1/4) 该有的量级内（< 1 K）",
          bool(_pairs) and _dmax < 1.0,
          "最大差 %.3f K（预测 %.3f K = 0.15%% × 温度）"
          % (_dmax, ((1.0 + _SUN_BIAS) ** 0.25 - 1.0) * 262.0))

# 边界：只给 T、不给 R 时**不该**推 L —— 那时 R 是未知量，
# 硬推等于替用户编一个半径，再拿这个编出来的数去算行星温度。
js_t_only, err_t_only = run_system(star_spec(st_m, None, ",teff_K=%.10g" % st_t))
if js_t_only is None:
    check("只给 T、不给 R 时内核仍可用（这时退回类型表）", False, err_t_only)
else:
    _s = {b["id"]: b for b in js_t_only["bodies"]}["TRAPPIST-1"]
    check("只给 T、不给 R 时不推 L（缺 R 就退回类型表，不编半径）",
          _s["luminosity_src"] == "type_grid" and _s["t_eff_src"] == "given",
          "L_src=%s / T_src=%s" % (_s["luminosity_src"], _s["t_eff_src"]))

# ===========================================================================
emit("=" * 76)
emit("J. 页面真实发出的那条消息：宿主**不声明类型**，只给 (质量, 半径, 温度)")
# 页面从数据文件里能拿到的就是 (st_mass, st_rad, st_teff) 三样。它**没有**
# 光谱型的依据，所以不该给宿主套一个"某类星"的帽子 —— 那是在替用户编分类。
# 但"不声明类型"的后果必须逐条验清楚，否则页面这条路是假绿：
#   发光与否  → 只能按质量判（0.0898 > 氢燃烧下限 0.08）
#   半径      → 观测给的必须原样生效（没有类型模型来顶它）
#   L 与 T    → 由 (R,T) 推 / 观测给，且与"声明了类型"那条路逐位同值
_typeless = "TRAPPIST-1,1,0,0,0,0,0,%.10g,%.10g,teff_K=%.10g" % (st_m, st_radius_km, st_t)
js_nl, err_nl = run(["nbody", "--scenario", "custom", "--solar", "none",
                     "--years", "0.05", "--samples", "120",
                     "--primary", "TRAPPIST-1", "--body", _typeless]
                    + [x for p in planet_specs() for x in ("--body", p)])
check("不声明类型的宿主（页面真实的发法）内核照样收", js_nl is not None, err_nl)
if js_nl is not None:
    _H = {b["id"]: b for b in js_nl["bodies"]}["TRAPPIST-1"]
    check("不声明类型 → 按质量判定发光（0.0898 > 氢燃烧下限 0.08）",
          _H["emits_light"] is True, "emits_light=%s" % _H["emits_light"])
    check('不声明类型 → type 回显为空串（页面能区分"它就是个行星/恒星"与"它没说"）',
          _H["type"] == "", "type=%r" % _H["type"])
    check("不声明类型 → 观测半径原样生效（没有类型模型来顶掉它）",
          abs(_H["radius_km"] - st_radius_km) / st_radius_km < JSON_REL,
          "内核 %.1f km / 观测 %.1f km" % (_H["radius_km"], st_radius_km))
    _ok_src = (_H["luminosity_src"] == "derived_from_radius_and_t_eff"
               and _H["t_eff_src"] == "given")
    check("不声明类型 → T 标 given、L 标 derived_from_radius_and_t_eff",
          _ok_src, "T_src=%s / L_src=%s" % (_H["t_eff_src"], _H["luminosity_src"]))
    if js_rt is not None:
        _S4 = {b["id"]: b for b in js_rt["bodies"]}["TRAPPIST-1"]
        check("声明类型 与 不声明类型，两条路给出的 L 逐位同值"
              "（类型不该影响一颗星的观测值）",
              abs(_H["luminosity_Lsun"] - _S4["luminosity_Lsun"])
              / _S4["luminosity_Lsun"] < 1e-12,
              "%.10g vs %.10g" % (_H["luminosity_Lsun"], _S4["luminosity_Lsun"]))

# ===========================================================================
emit()
if fails:
    emit("FAILED: %d 项未通过 -> %s" % (len(fails), "; ".join(fails)))
else:
    emit("全部通过：真实观测的宿主（T/L/R + 行星初值）走通了内核，"
         "且与类型表那条路有可量化的区别；数据表只给 (M,R,T) 时内核自己把 L 推出来。")

with open(Path(__file__).with_name("_probe_obsstar.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(LOG) + "\n")
raise SystemExit(1 if fails else 0)
