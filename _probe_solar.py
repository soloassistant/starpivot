"""--solar none/sun/full 的物理判据：用一套独立写的 Python 复算内核在做什么。

不为替代 C++，而是回答两个必须诚实回答的问题：
  Q1 「不放太阳系」时，默认那对 A/B 到底会发生什么？（会不会看起来像坏了）
  Q2 没有太阳时如果有中心天体，轨道还是不是真开普勒？
判据写死在数值上，而不是"看代码觉得对"。
"""
import math
import subprocess
import sys

# 证据通道：这个沙箱里子进程的 stdout 接不出来（外层只能拿到退出码），
# 所以结论必须落盘，否则失败时只知道"退出码 1"、不知道为什么。
# 用 atexit 而不是在末尾显式写：中途抛异常时也能看到"走到哪一步、前面几条结论是什么"。
import atexit
import builtins
import os

_LOG = []
_real_print = builtins.print


def print(*a, **k):                       # noqa: A001 — 有意遮蔽：结论要落盘
    _LOG.append(" ".join(str(x) for x in a))
    _real_print(*a, **k)


def _flush():
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "_probe_solar.txt"),
              "w", encoding="utf-8") as f:
        f.write("\n".join(_LOG) + "\n")


atexit.register(_flush)

G = 4.0 * math.pi ** 2           # AU^3 / (Msun * yr^2)
D2R = math.pi / 180.0
KM_PER_AU = 1.495978707e8


def elem_to_state(mu, a, e, i_rad, Om_rad, w_rad, M_rad):
    """照抄 starpivot_cli.cpp::elem_to_state 的公式与 3-1-3 旋转。"""
    E = M_rad
    for _ in range(200):
        f = E - e * math.sin(E) - M_rad
        fp = 1.0 - e * math.cos(E)
        d = f / fp
        E -= d
        if abs(d) < 1e-15:
            break
    ce, se = math.cos(E), math.sin(E)
    sq = math.sqrt(1.0 - e * e)
    xp = a * (ce - e)
    yp = a * sq * se
    k = math.sqrt(mu * a)
    rPeri = a * (1.0 - e * ce)
    vxp = -k * se / rPeri
    vyp = k * sq * ce / rPeri
    cO, sO = math.cos(Om_rad), math.sin(Om_rad)
    ci, si = math.cos(i_rad), math.sin(i_rad)
    cw, sw = math.cos(w_rad), math.sin(w_rad)
    r = ((cO * cw - sO * sw * ci) * xp + (-cO * sw - sO * cw * ci) * yp,
         (sO * cw + cO * sw * ci) * xp + (-sO * sw + cO * cw * ci) * yp,
         sw * si * xp + cw * si * yp)
    v = ((cO * cw - sO * sw * ci) * vxp + (-cO * sw - sO * cw * ci) * vyp,
         (sO * cw + cO * sw * ci) * vxp + (-sO * sw + cO * cw * ci) * vyp,
         sw * si * vxp + cw * si * vyp)
    return list(r), list(v)


def acc(ms, ps, G):
    n = len(ms)
    a = [[0.0, 0.0, 0.0] for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if i == j:
                continue
            d = [ps[i][k] - ps[j][k] for k in range(3)]
            r2 = sum(x * x for x in d)
            f = -G * ms[j] / (r2 * math.sqrt(r2))
            for k in range(3):
                a[i][k] += f * d[k]
    return a


def leapfrog(ms, ps, vs, dt, t_end):
    """KDK leapfrog（与内核同阶、同辛结构）。"""
    ps = [list(p) for p in ps]
    vs = [list(v) for v in vs]
    a = acc(ms, ps, G)
    n = max(1, int(round(t_end / dt)))
    for _ in range(n):
        for i in range(len(ms)):
            for k in range(3):
                vs[i][k] += 0.5 * dt * a[i][k]
                ps[i][k] += dt * vs[i][k]
        a = acc(ms, ps, G)
        for i in range(len(ms)):
            for k in range(3):
                vs[i][k] += 0.5 * dt * a[i][k]
    return ps, vs


def energy(ms, ps, vs):
    ke = sum(0.5 * ms[i] * sum(v * v for v in vs[i]) for i in range(len(ms)))
    pe = 0.0
    n = len(ms)
    for i in range(n):
        for j in range(i + 1, n):
            d = math.dist(ps[i], ps[j])
            pe -= G * ms[i] * ms[j] / d
    return ke + pe


def mom(ms, vs):
    return [sum(ms[i] * vs[i][k] for i in range(len(ms))) for k in range(3)]


def sep(ps):
    return math.dist(ps[0], ps[1])


def two_body_period(ms, ps, vs):
    """相对轨道的周期（开普勒第三定律直接给，不靠数圈）。"""
    m0, m1 = ms
    mu = G * (m0 + m1)
    r = [ps[1][k] - ps[0][k] for k in range(3)]
    v = [vs[1][k] - vs[0][k] for k in range(3)]
    rn = math.sqrt(sum(x * x for x in r))
    vn2 = sum(x * x for x in v)
    eps = 0.5 * vn2 - mu / rn
    if eps >= 0:
        return None
    a = -mu / (2 * eps)
    return 2 * math.pi * math.sqrt(a ** 3 / mu)


fails = []


def bad(msg):
    print("FAIL:", msg)
    fails.append(msg)


# ---------------------------------------------------------------- Q1
print("=" * 74)
print("Q1  --solar none，默认那对 A/B（各 3e-6 M☉，a=1, e=0.2, ω 相差 180°）")
# 内核给自定义天体用的仍是日心开普勒 IC：位置/速度按 μ=G(1+m) 铺在日心椭圆上，
# 但 --solar none 时原点没有引力源。
bodies = [("A", 3.0e-6, 1.0, 0.2, 0, 0, 0, 0),
          ("B", 3.0e-6, 1.0, 0.2, 0, 0, 180, 135)]
ms, ps, vs = [], [], []
for _, m, a, e, inc, raan, argp, M0 in bodies:
    mu = G * (1.0 + m)
    r, v = elem_to_state(mu, a, e, inc * D2R, raan * D2R, argp * D2R, M0 * D2R)
    ms.append(m)
    ps.append(r)
    vs.append(v)
e0 = energy(ms, ps, vs)
p0 = mom(ms, vs)
print("  t=0   间距 = %.4f AU" % sep(ps))
ps_end, vs_end = leapfrog(ms, ps, vs, 0.001, 5.0)
e1 = energy(ms, ps_end, vs_end)
drift = abs((e1 - e0) / e0)
pdrift = math.sqrt(sum(x * x for x in (mom(ms, vs_end)[k] - p0[k] for k in range(3))))
print("  t=5yr 间距 = %.4f AU" % sep(ps_end))
print("  能量漂移 = %.3e   动量漂移 = %.3e" % (drift, pdrift))
if drift > 1e-6:
    bad("能量漂移 %.2e 过大，积分出问题" % drift)
if pdrift > 1e-12:
    bad("动量漂移 %.2e 不为 0" % pdrift)
if sep(ps_end) < 1.5:
    bad("默认 A/B 在 none 下没有飞散，与预期不符（间距 %.3f）" % sep(ps_end))
else:
    print("  → 两颗几乎无质量的天体在直线飞散（间距 %.2f AU），不是渲染坏了。"
          % sep(ps_end))

# ---------------------------------------------------------------- Q2
print("=" * 74)
print("Q2  --solar none + 自己放一颗 1 M☉ 中心星，轨道还是不是真开普勒？")
ms2 = [1.0, 1.0e-6]
ps2 = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]]
mu = G * (ms2[0] + ms2[1])
r, v = elem_to_state(mu, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0)
ps2[1] = r
vs2 = [[0.0, 0.0, 0.0], v]
T = two_body_period(ms2, ps2, vs2)
print("  解析周期 = %.6f yr（a=1, 中心星 1 M☉）" % T)
ps2e, vs2e = leapfrog(ms2, ps2, vs2, 0.001, T)
back = math.dist(ps2e[1], ps2[1])
print("  跑一个周期后行星回到出发点，偏差 = %.3e AU" % back)
if not (back < 1e-3):
    bad("一个周期后没回到出发点，偏差 %.3e AU" % back)
else:
    print("  → 无太阳系但自己放中心星时，轨道仍是一个闭合的开普勒椭圆。")

# ---------------------------------------------------------------- Q3
print("=" * 74)
print("Q3  --solar none，两颗等质量恒星互绕（纯二体，没有中心天体）")
# 间距 1 AU 的圆轨道：相对速度 sqrt(G·M_tot/d) = 2π，周期 = 1 yr
mt = 0.5
ms3 = [mt, mt]
ps3 = [[-0.5, 0.0, 0.0], [0.5, 0.0, 0.0]]
vs3 = [[0.0, -math.pi, 0.0], [0.0, math.pi, 0.0]]
T3 = two_body_period(ms3, ps3, vs3)
print("  解析周期 = %.6f yr" % T3)
ps3e, vs3e = leapfrog(ms3, ps3, vs3, 0.001, T3)
back3 = math.dist(ps3e[1], ps3[1])
print("  跑一个周期后回到出发点，偏差 = %.3e AU" % back3)
if not (abs(T3 - 1.0) < 1e-6):
    bad("等质量双星周期应为 1 yr，实际 %.6f" % T3)
if not (back3 < 1e-3):
    bad("双星一个周期后没闭合，偏差 %.3e AU" % back3)
else:
    print("  → 两个天体互为引力源时就是真二体，周期与开普勒第三定律一致。")

# ---------------------------------------------------------------- Q4
print("=" * 74)
print("Q4  webapp.py 能否通过语法检查，并把 solar 转发给内核")
r = subprocess.run(
    [sys.executable, "-m", "py_compile",
     "C:/Users/geral/WorkBuddy/2026-09-24-16-11-48/starpivot/tools/webapp.py"],
    capture_output=True, text=True)
if r.returncode != 0:
    bad("webapp.py 编译失败: " + r.stderr.strip())
else:
    print("  py_compile 通过")
src = open("C:/Users/geral/WorkBuddy/2026-09-24-16-11-48/starpivot/tools/webapp.py",
           encoding="utf-8").read()
if '"--solar", solar' not in src:
    bad("webapp.py 没有把 --solar 传给内核")
elif 'solar not in ("full", "sun", "none")' not in src:
    bad("webapp.py 没有校验 solar 的合法取值")
else:
    print("  --solar 转发路径存在且会先挡非法取值")

print("=" * 74)
print("全部判据通过" if not fails else "%d 项失败" % len(fails))
sys.exit(1 if fails else 0)
