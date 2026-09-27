# -*- coding: utf-8 -*-
"""临时对比：同一颗 TRAPPIST-1，只用类型表 vs 用观测覆盖，行星判定会不会变。"""
import json
import subprocess
import sys
from pathlib import Path

EXE = Path("C:/Users/geral/WorkBuddy/2026-09-24-16-11-48/starpivot/build/bin/starpivot.exe")

# TRAPPIST-1 实测（NASA Exoplanet Archive pscomppars）
#   宿主：M=0.0898 Msun, R=0.1192 Rsun=82970 km, T_eff=2566 K
#   L = (R/Rsun)^2 (T/Tsun)^4 = 5.53e-4 Lsun（由两个观测量推导，不是直接观测）
#   行星 e：a=0.02925 AU, e=0.005, M=0.692 Mearth=2.079e-6 Msun, R=0.920 Rearth=5866 km
STAR_BASE = "TRAPPIST-1,1,0,0,0,0,0,M_V:0.0898,82970"
PLANET_E = "e,0.02925,0.005,0,0,0,0,2.079e-6,5866"


def run(star_spec, label):
    args = [str(EXE), "nbody", "--scenario", "custom", "--solar", "none",
            "--years", "1", "--samples", "24", "--primary", "TRAPPIST-1",
            "--body", star_spec, "--body", PLANET_E]
    r = subprocess.run(args, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=600)
    if r.returncode != 0:
        print("== %s == 内核拒绝 rc=%d\n%s" % (label, r.returncode, r.stderr[:400]))
        return None
    js = json.loads(r.stdout)
    s = next(b for b in js["bodies"] if b["id"] == "TRAPPIST-1")
    p = next(b for b in js["bodies"] if b["id"] == "e")
    print("== %s ==" % label)
    print("  恒星: L=%.4g Lsun (src=%s)  T=%.6g K (src=%s)  R=%.6g km"
          % (s["luminosity_Lsun"], s["luminosity_src"], s["t_eff_K"], s["t_eff_src"],
             s["radius_km"]))
    if "bio" in js:
        b = {x["id"]: x for x in js["bio"]["bodies"]}
        e = b["e"]
        ts = e["t_surf_K"]
        print("  行星 e: T_surf ∈ [%.1f, %.1f] K  判定=%d(%s)  进度=%.4f"
              % (min(ts), max(ts), e["stage_final"], e["stage_name"],
                 e["progress_final"]))
    print("  solar/L_total = %.6g Lsun" % js.get("total_luminosity_Lsun", float("nan")))
    return js


print("=" * 70)
print("A. 只用类型表（M_V 的 L∝M^3.5 外推）")
run(STAR_BASE, "A 类型表")
print("=" * 70)
print("B. 观测覆盖 T 与 L（真实 TRAPPIST-1）")
run(STAR_BASE + ",teff_K=2566,lum_lsun=5.53e-4", "B 观测覆盖")
print("=" * 70)
print("C. 只给观测 T（L 仍走类型表）")
run(STAR_BASE + ",teff_K=2566", "C 只给 T")
print("=" * 70)
print("D. 负路径：给岩石行星设亮度，应当被拒绝")
run("rocky-star,1,0,0,0,0,0,rocky:1e-6,6371,teff_K=300", "D 负路径")
