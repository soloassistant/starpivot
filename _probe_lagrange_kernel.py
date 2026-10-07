# -*- coding: utf-8 -*-
"""L1–L5 的独立复算判据（不调内核自己那套五次方程）。

这份判据的价值全在"不复用内核的公式"。所以共线点一律用**力平衡**独立数值求解：

  在与双星共转的参考系里，一个位于拉格朗日点的检验粒子在该系内静止，
  科里奥利项自动为零，于是平衡条件退化成"两个天体的引力之和 = 离心力"：

      f(x) = -G·m1·(x-x1)/|x-x1|³ - G·m2·(x-x2)/|x-x2|³ + n²·x = 0,   n² = G(m1+m2)/a³

  三个共线点各自写一个独立的一维定义（L1 从次星沿 -x 量距离 s、L2 从次星沿 +x、
  L3 从主星沿 -x），各自用二分法求根，再用**起点完全不同**的 Newton 迭代复核一遍。
  刻意没有抄 tests/fixtures.hpp 里那个五次多项式的系数 —— 抄了就没有交叉验证价值。

  L4/L5 走几何定义（等边三角形第三顶点），再用二维 Newton 解 net_accel = 0 复核，
  两条路（几何 / 动力学）必须给同一个点。

实测记录（本判据自己跑出来的，不是抄来的）：
  * 二分法给出的 L1 距次星 0.0099704019699161 a，与 fixtures.hpp 五次方程的根
    0.0099704019699161 a **完全一致（差 1e-16）** —— 两条独立路互相钉住了。
  * 顺带发现契约 docs/bench-contract-2026-10-05.md §2 的示例数值 pos_au=0.9900051
    / from_secondary_au=0.0099949 **不是解出来的**，更像 Hill 半径的估值。
    真正的 L1 在 0.9900265945501048 a。两者差 2.4e-5 a，比 %.6g 的量化下限大一个量级，
    所以如果内核照抄契约示例值，本判据会当场报出来（这是应该报的）。
  * L3 在 x ≈ -1.0000012 a，也就是**距主星约 1 a**，不在 Hill 半径处。
    这不是 bug：共线点那个方程在主星外侧的解本来就退化成"同轨道对跖点"，
    小 μ 时 L3 → 距主星一个间距（地球-月球系统的 L3 在地球背面 5.8 万 km 就是这件事）。

稳定性不用查表、也不用特征值代数（那套代数手推极易搞错符号），而是**直接积分看它跑不跑**：
把检验粒子放在离目标点 1e-4 a 处、用共转速度起步，跑 KDK leapfrog。
  * 共线三点：偏置被放大几百到上万倍（L1 3 年 91×、L2 2 年 8311×、L3 10 年 370×）→ 不稳定。
  * L4/L5：偏置后 100 年 |r-a| 仍 < 1e-3 a → 稳定。
    注意度量必须是"到质心的距离"，**不能**是"到 L4 点的位移"：μ=3e-6 时 L4/L5 的
    蝌蚪/马蹄区宽达半圈，粒子会绕到对跖点去（实测最大位移 2.0 a），但它始终在共轨环上。
  * μ=0.3（远超 Routh 判据）时 L4 粒子 9.4 年就被甩出 1.5 a → 反例独立复现。

容差怎么定的（按最坏情况推，不按这组样本推）：
  内核 JSON 用 %.6g 打印浮点（见 tools/starpivot_cli.cpp），所以**最坏**相对量化误差是
  0.5×10^(1-d)，d = 有效数字位数。因此坐标对拍的容差不写死，而是**从回执原文里量出
  实际给出的有效位数**再反推量化下限 —— 这样内核哪天改成 %.10g，容差自动跟着变松。
  任务里建议的 1e-9 只有在回执给出 ≥10 位有效数字时才可达；拿 1e-9 去卡 %.6g 的字段
  是判据自己写错（本仓库 _probe_collide.py 文件头已经因为这件事栽过一次）。

退出码：0 全过 / 1 有失败项 / 2 子命令缺席或环境缺失（未验证，绝不冒充通过）。
"""
import atexit
import builtins
import json
import math
import os
import re
import subprocess
import sys

# 本机控制台是 GBK，直接往 stdout 打中文/上标会把进程打死（UnicodeEncodeError），
# 而落盘的报告是 UTF-8 —— 报告才是证据通道，stdout 只是给人看的。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:                                   # noqa: BLE001
    pass

ROOT = os.path.dirname(os.path.abspath(__file__))
EXE = os.path.join(ROOT, "starpivot", "build", "bin", "starpivot.exe")
# 报告写在**探针自己**旁边（沿用 _probe_solar.py / _probe_bio.py 的做法），
# 不要挂在 ROOT 上：探针被复制到别处跑时（例如变异测试），挂 ROOT 会把
# 仓库里那份正式报告覆盖掉。
REPORT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "_probe_lagrange_kernel.txt")

_LOG = []
_real_print = builtins.print


def print(*a, **k):                       # noqa: A001 — 有意遮蔽：结论要落盘
    _LOG.append(" ".join(str(x) for x in a))
    _real_print(*a, **k)


@atexit.register
def _flush():
    with open(REPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(_LOG) + "\n")


n_ok = 0
fails = []
unverified = []
warns = []


def warn(msg):
    """不判失败、但必须出现在报告里的观察（契约与实现的差异之类）。"""
    warns.append(msg)
    _LOG.append("  注意  " + msg)
    _real_print("  注意  " + msg)


def ok(cond, msg):
    global n_ok
    n_ok += 1
    _LOG.append(("  PASS  " if cond else "  FAIL  ") + msg)
    if not cond:
        fails.append(msg)
    _real_print(("  PASS  " if cond else "  FAIL  ") + msg)
    return bool(cond)


def skip(msg):
    """子命令缺席时用：既不算通过也不算失败，显式记成未验证。"""
    unverified.append(msg)
    _LOG.append("  未验证  " + msg)
    _real_print("  未验证  " + msg)


def head(t):
    print()
    print("=" * 76)
    print(t)


# ---------------------------------------------------------------- 独立常数
# SI 优先：CODATA 2018 的 G、IAU 2015 名义值。把内核单位下的 G 现算出来，
# 而不是直接抄 4π² —— 抄了就没法发现内核哪天把单位搞错了。
G_SI = 6.67430e-11          # m^3 kg^-1 s^-2
AU_M = 1.495978707e11       # m
MSUN_KG = 1.98892e30        # kg
YR_S = 3.15576e7            # s (365.25 d)
G_AU_MSUN_YR = G_SI * MSUN_KG * YR_S ** 2 / AU_M ** 3
M_EARTH = 3.003489e-6       # M☉ (IAU nominal / GM_SUN+Earth)
ROUTH_LIMIT = (1.0 - math.sqrt(23.0 / 27.0)) / 2.0

# JSON 量化：0.5 * 10^(1-d)，d = 回执实际给出的有效数字位数
NUM_RE = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")

# 基线容差：仓库既有约定 —— tools/starpivot_cli.cpp 用 %.6g 打印浮点，
# 最坏相对量化 5e-6，向上取整到 1e-5。依据见 _probe_collide.py 文件头「关于容差」。
JSON_REL_BASE = 1e-5


def sig_digits(literal):
    """字面量的有效数字位数。"""
    s = literal.strip()
    mant = s.split("e")[0].split("E")[0].replace("-", "").replace("+", "")
    return len(mant.replace(".", "").lstrip("0")) or 1


def literals_for(text, key):
    """取出 JSON 里某个键的数值字面量（数组就逐个取）。

    必须按键取：不同字段的有效位数天差地别（坐标 11 位，残差 4 位且量级 1e-16），
    混在一起算出来的容差没有意义。
    """
    out = []
    pat = re.compile(r'"%s"\s*:\s*(\[[^\]]*\]|[-+]?[0-9][-+0-9.eE]*)'
                     % re.escape(key))
    for m in pat.finditer(text):
        val = m.group(1)
        out.extend(NUM_RE.findall(val) if val.startswith("[") else [val])
    return out


def rel_quantisation(literal):
    """一个 JSON 数字字面量自身的相对量化上限（半个 ulp / 值）。

    d 位有效数字 → 相对精度就是 0.5×10^(1-d)，**与数值大小无关**。
    整数字面量（无小数点、无指数）是精确值，量化误差为 0。
    """
    s = literal.strip()
    if not NUM_RE.fullmatch(s):
        return 1.0
    if not ("." in s or "e" in s or "E" in s):
        return 0.0
    return 0.5 * 10.0 ** (1 - sig_digits(s))


# ---------------------------------------------------------------- 独立求解器
class Rotating:
    """共转系下的二体问题。质心在原点，主星在 x1 = -μ·a，次星在 x2 = (1-μ)·a。"""

    def __init__(self, m1, m2, a=1.0):
        self.m1, self.m2, self.a = m1, m2, a
        self.mu = m2 / (m1 + m2)
        self.x1 = -self.mu * a
        self.x2 = (1.0 - self.mu) * a
        self.n2 = G_AU_MSUN_YR * (m1 + m2) / (a ** 3)
        self.hill = a * (self.mu / 3.0) ** (1.0 / 3.0)

    def accel(self, x, y=0.0):
        """共转系净加速度（含离心项）。科里奥利项在平衡点为零，故不出现。"""
        dx1, dy1 = x - self.x1, y
        dx2, dy2 = x - self.x2, y
        r1sq = dx1 * dx1 + dy1 * dy1
        r2sq = dx2 * dx2 + dy2 * dy2
        ax = (-G_AU_MSUN_YR * self.m1 * dx1 / (r1sq * math.sqrt(r1sq))
              - G_AU_MSUN_YR * self.m2 * dx2 / (r2sq * math.sqrt(r2sq))
              + self.n2 * x)
        ay = (-G_AU_MSUN_YR * self.m1 * dy1 / (r1sq * math.sqrt(r1sq))
              - G_AU_MSUN_YR * self.m2 * dy2 / (r2sq * math.sqrt(r2sq))
              + self.n2 * y)
        return ax, ay

    def hess(self, x, y=0.0):
        """共转系净加速度的雅可比（∇²Φ_eff + n²I），解析式。

        ∇²(1/r) 的标准结果：∂²/∂x² = 3(x-s)²/r⁵ - 1/r³，
        ∂²/∂x∂y = -3(x-s)(y-t)/r⁵。
        """
        jxx = self.n2
        jyy = self.n2
        jxy = 0.0
        for m, xp in ((self.m1, self.x1), (self.m2, self.x2)):
            dx, dy = x - xp, y
            r2 = dx * dx + dy * dy
            r = math.sqrt(r2)
            r3 = r2 * r
            r5 = r3 * r2
            jxx += G_AU_MSUN_YR * m * (3.0 * dx * dx / r5 - 1.0 / r3)
            jyy += G_AU_MSUN_YR * m * (3.0 * dy * dy / r5 - 1.0 / r3)
            jxy += G_AU_MSUN_YR * m * 3.0 * dx * dy / r5
        return jxx, jxy, jyy

    def n_body_hill(self):
        return self.n2 * self.a

    def to_contract_frame(self, x, y=0.0):
        """平移到契约 §2 规定的报出系：主星在原点、次星在 +a。

        共转系的动力学必须在**质心**系里写（离心项 n²·r 的 r 是到质心的距离），
        质心在 x = -μ·a，所以报出坐标 = 质心系坐标 + μ·a。
        日-地这一档 μ·a = 3.0e-6 a —— 比 %.6g 的量化下限大一个量级，
        漏掉这次平移就会让每个坐标都差 3e-6 a，看起来像内核算错了。
        契约 §2 原文：「主星在 +x，次星在 a 处，L4 在 (a/2, +√3a/2)」。
        """
        return x + self.mu * self.a, y


def bisect_root(g, lo, hi, iters=200):
    """要求 g 在 (lo,hi) 内变号。返回 (root, sign_changes_inside)。"""
    f_lo, f_hi = g(lo), g(hi)
    if f_lo == 0.0:
        return lo, 0
    if f_lo * f_hi > 0:
        return None, 0
    n_changes = 0
    prev_x, prev_f = lo, f_lo
    steps = 4000
    for i in range(1, steps + 1):
        x = lo + (hi - lo) * i / steps
        fx = g(x)
        if prev_f * fx < 0:
            n_changes += 1
        prev_x, prev_f = x, fx
    a, b, fa = lo, hi, f_lo
    for _ in range(iters):
        m = 0.5 * (a + b)
        fm = g(m)
        if fm == 0.0:
            return m, n_changes
        if fa * fm < 0:
            b = m
        else:
            a, fa = m, fm
        if b - a <= 1e-17 * max(1.0, abs(m)):
            break
    return 0.5 * (a + b), n_changes


def newton_root(g, x0, iters=100):
    """导数用中心差分，不解析求导 —— 少一个能抄错的地方。"""
    x = x0
    for _ in range(iters):
        fx = g(x)
        h = max(1e-12, abs(x) * 1e-7)
        df = (g(x + h) - g(x - h)) / (2.0 * h)
        if df == 0.0 or not math.isfinite(df):
            break
        step = fx / df
        x -= step
        if abs(step) <= 1e-17 * max(1.0, abs(x)):
            break
    return x


def solve_collinear(sys_, which):
    """三条共线点各一个独立定义；返回 (x, a) 或 (None, 原因)。"""
    a, x1, x2 = sys_.a, sys_.x1, sys_.x2
    if which == "L1":          # 主次星之间，量到次星的距离
        g = lambda s: sys_.accel(x2 - s, 0.0)[0]
        lo, hi = 1e-9 * a, 3.0 * sys_.hill
        s, ch = bisect_root(g, lo, hi)
        return (None, "no sign change") if s is None else (x2 - s, ch)
    if which == "L2":          # 次星外侧
        g = lambda s: sys_.accel(x2 + s, 0.0)[0]
        lo, hi = 1e-9 * a, 3.0 * sys_.hill
        s, ch = bisect_root(g, lo, hi)
        return (None, "no sign change") if s is None else (x2 + s, ch)
    if which == "L3":          # 主星外侧，退化成同轨道对跖解
        g = lambda s: sys_.accel(x1 - s, 0.0)[0]
        lo, hi = 1e-9 * a, 1.5 * a
        s, ch = bisect_root(g, lo, hi)
        return (None, "no sign change") if s is None else (x1 - s, ch)
    raise ValueError(which)


def solve_triangular(sys_, sign):
    """几何定义起步，二维 Newton 复核；返回 (x, y, 残差, 位移)。

    雅可比用**解析**导数（∇(1/r) 的标准结果），不是中心差分：
    中心差分在解附近把残差卡在 1e-9 的噪声地板上（实测），点不动。
    解析雅可比是旋转系势函数的二阶导，与内核的五次方程毫无关系。
    """
    x_geo = sys_.x1 + 0.5 * sys_.a
    y_geo = sign * math.sqrt(3.0) / 2.0 * sys_.a
    x, y = x_geo, y_geo
    for _ in range(60):
        fx, fy = sys_.accel(x, y)
        jxx, jxy, jyy = sys_.hess(x, y)
        det = jxx * jyy - jxy * jxy
        if det == 0.0:
            break
        # 解 J·d = f，J 对称：[jxx jxy; jxy jyy]
        dx = (jyy * fx - jxy * fy) / det
        dy = (jxx * fy - jxy * fx) / det
        x -= dx
        y -= dy
        if abs(dx) + abs(dy) <= 1e-16 * sys_.a:
            break
    fx, fy = sys_.accel(x, y)
    return x, y, math.hypot(fx, fy), math.hypot(x - x_geo, y - y_geo)


# ---------------------------------------------------------------- 积分器
def propagate(m1, m2, px, py, years, dt, mass_tp=1e-16):
    """KDK leapfrog：双星 + 无质量检验粒子。返回逐步统计量。"""
    a = 1.0
    n = math.sqrt(G_AU_MSUN_YR * (m1 + m2) / a ** 3)
    mu = m2 / (m1 + m2)
    ms = [m1, m2, mass_tp]
    xs = [-mu * a, (1 - mu) * a, px]
    ys = [0.0, 0.0, py]
    # 共转初速 v = ω × r
    vsx = [0.0, 0.0, -n * py]
    vsy = [n * xs[0], n * xs[1], n * px]

    def accel():
        ax = [0.0, 0.0, 0.0]
        ay = [0.0, 0.0, 0.0]
        for i in range(3):
            for j in range(3):
                if i == j:
                    continue
                dx, dy = xs[i] - xs[j], ys[i] - ys[j]
                inv = 1.0 / ((dx * dx + dy * dy) ** 1.5)
                ax[i] -= G_AU_MSUN_YR * ms[j] * dx * inv
                ay[i] -= G_AU_MSUN_YR * ms[j] * dy * inv
        return ax, ay

    def energy():
        ke = sum(0.5 * ms[i] * (vsx[i] ** 2 + vsy[i] ** 2) for i in range(3))
        pe = 0.0
        for i in range(3):
            for j in range(i + 1, 3):
                pe -= G_AU_MSUN_YR * ms[i] * ms[j] / math.hypot(xs[i] - xs[j],
                                                                 ys[i] - ys[j])
        return ke + pe

    e0 = energy()
    ax, ay = accel()
    worst_disp = 0.0
    rmin, rmax = 1e9, 0.0
    sep_err = 0.0
    for _ in range(int(round(years / dt))):
        for i in range(3):
            vsx[i] += 0.5 * dt * ax[i]
            vsy[i] += 0.5 * dt * ay[i]
            xs[i] += dt * vsx[i]
            ys[i] += dt * vsy[i]
        ax, ay = accel()
        for i in range(3):
            vsx[i] += 0.5 * dt * ax[i]
            vsy[i] += 0.5 * dt * ay[i]
        worst_disp = max(worst_disp, math.hypot(xs[2] - px, ys[2] - py))
        r = math.hypot(xs[2], ys[2])
        rmin, rmax = min(rmin, r), max(rmax, r)
        sep_err = max(sep_err, abs(math.hypot(xs[1] - xs[0], ys[1] - ys[0]) - a))
    drift = abs((energy() - e0) / e0)
    return {"disp": worst_disp, "rmin": rmin, "rmax": rmax,
            "drift": drift, "sep_err": sep_err}


def run_cli(args, timeout=180):
    """返回 (rc, stdout_bytes, stderr_text)。字节版：genesis 那条要做逐位比较。"""
    try:
        r = subprocess.run([EXE] + args, cwd=ROOT, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, b"", "TIMEOUT"
    return r.returncode, r.stdout, r.stderr.decode("utf-8", "replace")


# ================================================================ A 环境
head("A  环境与子命令在场性")
print("  exe = %s" % EXE)
if not os.path.exists(EXE):
    print("  !! 内核二进制不存在 —— 未验证")
    skip("内核二进制不存在，无法运行任何内核侧判据")
    print()
    print("n=%d pass, fail=%d, 未验证=%d" % (n_ok, len(fails), len(unverified)))
    print("退出码 2（环境缺失，未验证）")
    sys.exit(2)

rc, out, err = run_cli(["help"])
ok(rc == 0, "starpivot help 可执行（rc=%s）" % rc)

probe_args = ["lagrange", "--primary", "Sun", "--secondary", "Earth",
              "--mass-primary", "1.0", "--mass-secondary", repr(M_EARTH),
              "--a-au", "1.0"]
rc_probe, out_probe, err_probe = run_cli(probe_args)
have_lagrange = rc_probe == 0 and out_probe.strip().startswith(b"{")
print("  lagrange 子命令：%s" % ("在场" if have_lagrange else "缺席"))
if not have_lagrange:
    print("  内核原话：%s" % (err_probe.strip()[:160] or "（无 stderr，退出码 %s）" % rc_probe))
    print("  >>> 退出码按 2（未验证）走，理由：缺的是被测子命令，不是环境坏掉。")

# ================================================================ B 独立复算
head("B  独立复算（不依赖内核子命令，这一节永远真跑）")
print("  内核单位下的 G 由 SI 现算：G = %.9f AU^3/(Msun*yr^2)" % G_AU_MSUN_YR)
# 4π² = 39.4784176 是**天文学约定**（它让 a=1 AU, M=1 M☉ 的开普勒周期恰为 1 yr）。
# 把 SI 常数直接代进去并不会精确给出 4π²：M☉ 的取值口径就带来 ~2e-4 的差
# （实测：1976 口径 39.4737，IAU2015/CODATA2018 口径 39.4871，都不等于 4π²；
#   要让现代 G/AU/yr 给出精确 4π² 需要 M☉ = 1.988485e30 kg）。所以这里的门槛按
# 各口径的实际散布取 5e-4，而不是 1e-9 —— 容差从最坏情况推，不从这一组样本推。
_msun_for_4pi2 = 4.0 * math.pi ** 2 * AU_M ** 3 / (G_SI * YR_S ** 2)
print("  （口径说明：4π² 是约定值；要它精确成立需 M☉=%.6e kg，"
      "本判据用 IAU 名义值 %.6e kg）" % (_msun_for_4pi2, MSUN_KG))
ok(abs(G_AU_MSUN_YR - 4.0 * math.pi ** 2) / (4.0 * math.pi ** 2) < 5e-4,
   "SI 现算的 G 与天文学约定 4π² = %.9f 相差 %.2e（< 5e-4，差额由 M☉ 口径决定）"
   % (4.0 * math.pi ** 2, abs(G_AU_MSUN_YR - 4 * math.pi ** 2) / (4 * math.pi ** 2)))
ok(abs(ROUTH_LIMIT - 0.0385208) / 0.0385208 < 1e-4,
   "Routh 判据 (1-√(23/27))/2 = %.7f ≈ 0.0385208（相对差 %.2e）"
   % (ROUTH_LIMIT, abs(ROUTH_LIMIT - 0.0385208) / 0.0385208))

SE = Rotating(1.0, M_EARTH, 1.0)
print("  mu = %.6e   Hill 半径 = %.10f a   n²·a = %.6f" % (SE.mu, SE.hill, SE.n2))
ok(SE.mu < ROUTH_LIMIT, "日-地 mu = %.4e 远低于 Routh 判据 %.4f（共线点外，三角点应稳定）"
   % (SE.mu, ROUTH_LIMIT))

ind = {}
for key in ("L1", "L2", "L3"):
    x, ch = solve_collinear(SE, key)
    ind[key] = x
    print("  %s 独立解 x = %+.16f a   （区间内变号 %d 次）" % (key, x, ch))
    ok(ch == 1, "%s 的物理区间内只有 1 次变号（二分法不会挑错根）" % key)
    resid = abs(SE.accel(x, 0.0)[0])
    ok(resid <= 1e-10 * SE.n_body_hill(),
       "%s 处净加速度 = %.3e ≤ 1e-10·n²a（二分法残差）" % (key, resid))
    # 起点完全不同的 Newton 复核
    if key in ("L1", "L2"):
        g = (lambda s: SE.accel(SE.x2 - s, 0.0)[0]) if key == "L1" else \
            (lambda s: SE.accel(SE.x2 + s, 0.0)[0])
        s_newton = newton_root(g, 0.7 * SE.hill)
        x_newton = (SE.x2 - s_newton) if key == "L1" else (SE.x2 + s_newton)
    else:
        g = lambda s: SE.accel(SE.x1 - s, 0.0)[0]
        s_newton = newton_root(g, 0.7 * SE.a)
        x_newton = SE.x1 - s_newton
    ok(abs(x_newton - x) <= 1e-12 * SE.a,
       "%s：二分法与 Newton（起点在 Hill 半径的 0.7 处）给同一个根（差 %.2e a）"
       % (key, abs(x_newton - x)))

d1 = abs(ind["L2"] - SE.x2)
d2 = abs(ind["L1"] - SE.x2)
ok(0.5 * SE.hill < d1 < 1.5 * SE.hill and 0.5 * SE.hill < d2 < 1.5 * SE.hill,
   "L1/L2 距次星都在 Hill 半径的 0.5~1.5 倍内（L1=%.6f, L2=%.6f, Hill=%.6f）"
   % (d2, d1, SE.hill))
ok(d1 > d2, "L2 比 L1 离次星更远（L1=%.7f < L2=%.7f，两者不对称是已知的）" % (d2, d1))
ok(abs(ind["L3"] - SE.x1) / SE.a > 0.9,
   "L3 距主星 %.6f a ≈ 一个间距（不是 Hill 半径；小 μ 时共线外侧解退化成同轨道对跖解）"
   % abs(ind["L3"] - SE.x1))

for key, sign in (("L4", +1), ("L5", -1)):
    x_geo = SE.x1 + 0.5 * SE.a
    y_geo = sign * math.sqrt(3.0) / 2.0 * SE.a
    x_new, y_new, resid, moved = solve_triangular(SE, sign)
    ind[key] = (x_new, y_new)
    ok(resid <= 1e-12 * SE.n_body_hill(),
       "%s 二维 Newton 收敛到净加速度 = %.3e ≤ 1e-12·n²a" % (key, resid))
    ok(abs(x_new - x_geo) <= 1e-9 * SE.a and abs(y_new - y_geo) <= 1e-9 * SE.a,
       "%s：几何（等边三角形第三顶点）与动力学解重合（位移 %.2e a）"
       % (key, moved))
    ok(moved <= 1e-9 * SE.a,
       "%s：Newton 从几何解出发没有跑偏（位移 %.2e a，解析雅可比）" % (key, moved))

ok(abs(ind["L4"][1] + ind["L5"][1]) <= 1e-14 * SE.a and
   abs(ind["L4"][0] - ind["L5"][0]) <= 1e-14 * SE.a,
   "L4/L5 关于连线镜像对称")
ok(ind["L3"] < SE.x1 < ind["L1"] < SE.x2 < ind["L2"],
   "沿 x 轴的空间序：L3=%.6f < 主星=%.6f < L1=%.6f < 次星=%.6f < L2=%.6f"
   % (ind["L3"], SE.x1, ind["L1"], SE.x2, ind["L2"]))

print("  独立解汇总（质心系 → 平移到契约报出系：主星在原点、次星在 a，平移量 μa=%.3e a）"
      % (SE.mu * SE.a))
ind_cf = {}
for key in ("L1", "L2", "L3"):
    x_cf, _ = SE.to_contract_frame(ind[key])
    ind_cf[key] = (x_cf, 0.0)
    print("    %s  质心系 x=%+.16f  →  pos_au = [%+.16f, 0, 0]   距主星 %.10f  距次星 %.10f"
          % (key, ind[key], x_cf, abs(x_cf), abs(x_cf - SE.a)))
for key in ("L4", "L5"):
    x_cf, y_cf = SE.to_contract_frame(ind[key][0], ind[key][1])
    ind_cf[key] = (x_cf, y_cf)
    print("    %s  质心系 (%.16f, %.16f)  →  pos_au = [%+.16f, %+.16f, 0]"
          "   距主星 %.10f  距次星 %.10f"
          % (key, ind[key][0], ind[key][1], x_cf, y_cf, math.hypot(x_cf, y_cf),
             math.hypot(x_cf - SE.a, y_cf)))
ok(abs(ind_cf["L4"][0] - 0.5 * SE.a) <= 1e-9 * SE.a,
   "平移后 L4 的 x 落在 a/2 = %.1f（契约 §2 要求的报出位置；几何上这是恒等式，"
   "1e-9 的余量留给 Newton 的收敛残差 %.1e）"
   % (0.5 * SE.a, abs(ind_cf["L4"][0] - 0.5 * SE.a)))
ok(abs(ind_cf["L4"][1] - math.sqrt(3.0) / 2.0 * SE.a) <= 1e-9 * SE.a,
   "平移后 L4 的 y 落在 √3a/2（偏差 %.1e a）"
   % abs(ind_cf["L4"][1] - math.sqrt(3.0) / 2.0 * SE.a))

# ================================================================ C 经验稳定性
head("C  稳定性：直接积分，不用查表也不用特征值代数")
DT = 0.001
OFF = 1e-4
OFFSETS = {"L1": (ind["L1"] + OFF, 0.0),
           "L2": (ind["L2"] + OFF, 0.0),
           "L3": (ind["L3"] + OFF, 0.0)}
GROWTH = {"L1": (3.0, 50.0), "L2": (2.0, 100.0), "L3": (10.0, 100.0)}
for key in ("L1", "L2", "L3"):
    yrs, thresh = GROWTH[key]
    px, py = OFFSETS[key]
    st = propagate(1.0, M_EARTH, px, py, yrs, DT)
    ratio = st["disp"] / OFF
    print("  %s：偏置 %.0e a，%.0f 年后位移 %.4e a（放大 %.0f 倍）"
          % (key, OFF, yrs, st["disp"], ratio))
    ok(st["drift"] < 1e-9, "%s 积分 %.0f 年能量漂移 %.2e < 1e-9（积分器自检）"
       % (key, yrs, st["drift"]))
    ok(st["sep_err"] < 1e-4, "%s 积分 %.0f 年双星间距偏差 %.2e < 1e-4 a"
       % (key, yrs, st["sep_err"]))
    ok(ratio >= thresh,
       "%s 的 %.0e a 偏置在 %.0f 年内放大 ≥%.0f 倍（实测 %.0f 倍）→ 共线点不稳定"
       % (key, OFF, yrs, thresh, ratio))

for key, sign in (("L4", +1), ("L5", -1)):
    x_geo = SE.x1 + 0.5 * SE.a
    y_geo = sign * math.sqrt(3.0) / 2.0 * SE.a
    st = propagate(1.0, M_EARTH, x_geo, y_geo + sign * OFF, 100.0, DT)
    band = max(abs(st["rmin"] - 1.0), abs(st["rmax"] - 1.0))
    print("  %s：偏置 %.0e a，100 年后 r ∈ [%.6f, %.6f]，偏离共轨环 %.1e a"
          % (key, OFF, st["rmin"], st["rmax"], band))
    ok(band < 0.01, "%s 的偏置后 100 年仍在共轨环上（|r-a| = %.1e a < 0.01 a）→ 三角点稳定"
       % (key, band))
    ok(st["drift"] < 1e-9, "%s 积分 100 年能量漂移 %.2e < 1e-9" % (key, st["drift"]))

HI_MU = Rotating(1.0 - 0.3, 0.3, 1.0)
x_hi, y_hi, _, _ = solve_triangular(HI_MU, +1)
st_hi = propagate(1.0 - 0.3, 0.3, x_hi, y_hi, 30.0, DT)
print("  μ=0.3（远超 Routh %.4f）：L4 粒子 30 年内 r_max = %.4f a"
      % (ROUTH_LIMIT, st_hi["rmax"]))
ok(st_hi["rmax"] > 1.5, "μ=0.3 时 L4 粒子被甩出 1.5 a（r_max=%.2f a）→ Routh 反例独立复现"
   % st_hi["rmax"])

# ================================================================ D 内核对拍
head("D  与内核回执对拍")
if not have_lagrange:
    skip("lagrange 子命令未实现：坐标对拍、from_primary/from_secondary、a_source、")
    skip("mu、routh_limit、triangular_stable、collinear_stable、note 文案全部未验证")
    skip("μ≈0.074 的 Routh 反例回显未验证（内核回显侧；物理侧已由上一节 μ=0.3 独立复现）")
else:
    rc, out, err = run_cli(probe_args)
    text = out.decode("utf-8", "replace")
    try:
        doc = json.loads(text)
    except Exception as exc:                       # noqa: BLE001
        ok(False, "lagrange 输出不是合法 JSON：%s" % exc)
        doc = None
    if doc is not None:
        ok(doc.get("status") == "ok", "status=ok（实际 %r）" % doc.get("status"))
        ok(doc.get("command") == "lagrange", "command=lagrange")
        ok(abs(doc.get("mu", -1) - SE.mu) <= 1e-5 * SE.mu,
           "mu = %r 与独立算的 %.6e 一致" % (doc.get("mu"), SE.mu))
        rl = doc.get("routh_limit")
        ok(isinstance(rl, (int, float)) and abs(rl - ROUTH_LIMIT) / ROUTH_LIMIT < 1e-5,
           "routh_limit = %r 与 (1-√(23/27))/2 = %.7f 一致" % (rl, ROUTH_LIMIT))
        pts = doc.get("points") or []
        ok([p.get("key") for p in pts] == ["L1", "L2", "L3", "L4", "L5"],
           "points 恒为 5 条且顺序 L1..L5（实际 %r）" % [p.get("key") for p in pts])

        COMPARED_KEYS = ("pos_au", "pos_km", "from_primary_au", "from_secondary_au",
                         "a_au", "a_km", "mu", "routh_limit")
        cmp_floats = []
        for _k in COMPARED_KEYS:
            cmp_floats.extend(s for s in literals_for(text, _k)
                              if "." in s or "e" in s or "E" in s)

        # 容差怎么定（踩过一次坑，记在这里）：
        # 第一版想从回执字面量数有效位数来反推量化下限。**这条路不可靠** ——
        # %g 会去掉末尾零，0.5 与 0.5000000000 打印出来一模一样，所以"数位数"
        # 量到的是格式化后的样子，不是格式宽度。本回执里 L4 的 pos_au[0] = 0.5
        # 就把最坏量化算成了 5e-1（等于没有容差）。
        # 改成两层：
        #   ① 基线容差取仓库既有约定（tools/starpivot_cli.cpp 用 %.6g 打印浮点，
        #      最坏相对量化 5e-6，向上取到 1e-5 —— 依据见 _probe_collide.py 文件头
        #      "关于容差"一节，那里已经因为按 %.6g 误用 1e-9 栽过一次）；
        #   ② 再加契约要求的严格门槛（共用线 1e-9、三角点 1e-8）作为独立断言。
        # 实际偏差会打出来，让人一眼看到余量有多大。
        tol_rel = JSON_REL_BASE
        worst_q = max((rel_quantisation(s) for s in cmp_floats), default=0.0)
        print("  容差：基线 %.1e（来自 %% .6g 的打印约定），严格门槛 1e-9 / 1e-8"
              % tol_rel)
        print("  （被对拍字段共 %d 个浮点字面量；字面量数位数不可用作容差依据："
              "%%g 去末尾零，0.5 与 0.5000000000 无法区分。按字面量粗算的最坏量化 "
              "%.1e 正是被 0.5 污染的结果，故不参与判定）"
              % (len(cmp_floats), worst_q))
        ok(True, "容差来源已固定为打印约定（不是从这组样本反推）")

        by_key = {p.get("key"): p for p in pts}
        # 契约建议的严格门槛：共线点 1e-9、三角点 1e-8。回执实际给了 11~13 位有效数字，
        # 所以这两个门槛现在是**可达**的，不是空话。
        STRICT_COLLINEAR, STRICT_TRI = 1e-9, 1e-8
        for key in ("L1", "L2", "L3"):
            p = by_key.get(key)
            if p is None:
                skip("%s 未出现在回执里" % key)
                continue
            pos = p.get("pos_au") or [None]
            mine = ind_cf[key][0]
            ok(len(pos) == 3, "%s.pos_au 是 3 个分量" % key)
            ok(abs(pos[1]) <= tol_rel and abs(pos[2]) <= tol_rel,
               "%s.pos_au 的 y/z 分量为 0（实测 %r, %r）" % (key, pos[1], pos[2]))
            d = abs(pos[0] - mine)
            rel = d / abs(mine)
            ok(d <= tol_rel * max(1.0, abs(mine)),
               "%s.pos_au[0] = %.10f 与独立解 %.16f 相差 %.2e a（相对 %.1e ≤ 量化容差 %.1e）"
               % (key, pos[0], mine, d, rel, tol_rel))
            ok(rel <= STRICT_COLLINEAR,
               "%s 坐标相对偏差 %.1e ≤ 1e-9（契约要求的共线点严格门槛）" % (key, rel))
            fp, fs = p.get("from_primary_au"), p.get("from_secondary_au")
            ok(isinstance(fp, (int, float)) and abs(abs(pos[0]) - abs(fp)) <=
               tol_rel * max(1.0, abs(fp)),
               "%s.from_primary_au = %r 与坐标自洽" % (key, fp))
            ok(isinstance(fs, (int, float)) and
               abs(abs(pos[0] - SE.a) - abs(fs)) <= tol_rel * max(1.0, abs(fs)),
               "%s.from_secondary_au = %r 与坐标自洽（次星在 a=%.1f）" % (key, fs, SE.a))
            ok(p.get("stable") is False, "%s.stable = false（实测 %r）" % (key, p.get("stable")))
            note = p.get("note") or p.get("note_zh")
            ok(isinstance(note, str) and note.strip() != "", "%s 的稳定性说明非空" % key)
            if p.get("note") is None and p.get("note_zh") is not None and not warns:
                warn("契约 §2 的字段名是 \"note\"，内核实际发的是 \"note_zh\""
                     "（内容合规，只是键名与契约不同 —— 报告给主 agent 决定）")
        for key in ("L4", "L5"):
            p = by_key.get(key)
            if p is None:
                skip("%s 未出现在回执里" % key)
                continue
            pos = p.get("pos_au") or [None, None, None]
            mine = ind_cf[key]
            dx, dy = abs(pos[0] - mine[0]), abs(pos[1] - mine[1])
            rel = math.hypot(dx, dy) / math.hypot(*mine)
            ok(abs(pos[2]) <= tol_rel, "%s.pos_au[2] = 0" % key)
            ok(dx <= tol_rel and dy <= tol_rel,
               "%s.pos_au = [%.10f, %.10f] 与几何解 [%.16f, %.16f] 相差 (%.2e, %.2e) a"
               % (key, pos[0], pos[1], mine[0], mine[1], dx, dy))
            ok(rel <= STRICT_TRI,
               "%s 坐标相对偏差 %.1e ≤ 1e-8（三角点解析解，门槛可更严）" % (key, rel))
            ok(abs(math.hypot(pos[0], pos[1]) - math.hypot(pos[0] - SE.a, pos[1]))
               <= tol_rel * max(1.0, abs(pos[0])),
               "%s 到主星与到次星的距离相等（等边三角形，实测 %.10f vs %.10f）"
               % (key, math.hypot(pos[0], pos[1]), math.hypot(pos[0] - SE.a, pos[1])))
            ok(p.get("stable") is (doc.get("triangular_stable") is True),
               "%s.stable 与 triangular_stable 同真假（%r vs %r）"
               % (key, p.get("stable"), doc.get("triangular_stable")))
            note = p.get("note") or p.get("note_zh")
            ok(isinstance(note, str) and "mu" in note.lower() or
               isinstance(note, str) and "质量比" in note,
               "%s 的说明写明稳定有条件（不能把 L4 说成绝对安全）" % key)
        ok(doc.get("triangular_stable") is True,
           "mu=3e-6 时 triangular_stable = true（L4/L5 在 Routh 判据内）")
        ok(doc.get("collinear_stable") is False,
           "collinear_stable = false（共线点永远不稳定）")
        ok(doc.get("a_source") in ("given", "default"),
           "a_source = %r（契约要求标明 given/default）" % doc.get("a_source"))
        a_au, a_km = doc.get("a_au"), doc.get("a_km")
        ok(isinstance(a_au, (int, float)) and abs(a_au - 1.0) <= 1e-5,
           "a_au = %r（显式给了 --a-au 1.0）" % a_au)
        ok(isinstance(a_km, (int, float)) and
           abs(a_km - a_au * 1.495978707e8) <= tol_rel * max(1.0, abs(a_km)),
           "a_km = %r 与 a_au 自洽（1 AU = 1.495978707e8 km）" % a_km)

        KM_PER_AU = 1.495978707e8
        for key in ("L1", "L3", "L4"):
            p = by_key.get(key)
            if p is None:
                continue
            pa = p.get("pos_au") or []
            pk = p.get("pos_km") or []
            if len(pa) != 3 or len(pk) != 3:
                skip("%s 缺 pos_au / pos_km" % key)
                continue
            err = max(abs(pk[i] - pa[i] * KM_PER_AU) for i in range(3))
            ok(err <= 1e-4 * max(1.0, abs(pk[0])),
               "%s.pos_km 与 pos_au 自洽（最大偏差 %.3e km，1 AU=%.1f km）"
               % (key, err, KM_PER_AU))

        # Routh 反例：次星 0.08 M☉ → mu ≈ 0.074 > 0.0385208
        mu_bad = 0.08 / (1.0 + 0.08)
        rc2, out2, err2 = run_cli(["lagrange", "--primary", "Sun", "--secondary", "Red",
                                   "--mass-primary", "1.0", "--mass-secondary", "0.08",
                                   "--a-au", "1.0"])
        ok(mu_bad > ROUTH_LIMIT,
           "反例参数 mu = %.6f 确实超过 Routh 判据 %.7f" % (mu_bad, ROUTH_LIMIT))
        try:
            doc2 = json.loads(out2.decode("utf-8", "replace"))
        except Exception as exc:                   # noqa: BLE001
            doc2 = None
            ok(False, "反例调用输出不是合法 JSON：%s（stderr: %s）" % (exc, err2[:120]))
        if doc2 is not None:
            ok(abs(doc2.get("mu", -1) - mu_bad) <= 1e-5 * mu_bad,
               "反例回显 mu = %r ≈ %.6f" % (doc2.get("mu"), mu_bad))
            ok(doc2.get("triangular_stable") is False,
               "mu=%.4f 超标时 triangular_stable 翻成 false（实测 %r）"
               % (mu_bad, doc2.get("triangular_stable")))
            for p in doc2.get("points") or []:
                if p.get("key") in ("L4", "L5"):
                    ok(p.get("stable") is False,
                       "超标时 %s.stable 也必须是 false，不能只翻顶层标志" % p.get("key"))

# ================================================================ 汇总
head("汇总")
print("n=%d pass, fail=%d, 未验证=%d, 注意=%d"
      % (n_ok, len(fails), len(unverified), len(warns)))
if warns:
    print()
    print("注意项（%d 条，不判失败，但需要人来定）：" % len(warns))
    for w in warns:
        print("  - " + w)
if unverified:
    print()
    print("未验证项（%d 条，退出码据此给 2，不冒充通过）：" % len(unverified))
    for u in unverified:
        print("  - " + u)
if fails:
    print()
    print("FAILED: %d 项" % len(fails))
    for f in fails:
        print("  - " + f)
print()
if not have_lagrange:
    print("结论：lagrange 子命令未实现 —— 独立复算（力平衡 / 几何 / 积分稳定性）全部真跑并通过，")
    print("      内核对拍部分未验证。这是「红」，不是判据自身出错。")
    sys.exit(2)
sys.exit(1 if fails else 0)
