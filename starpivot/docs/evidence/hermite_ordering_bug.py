# -*- coding: utf-8 -*-
"""
Starpivot / Hermite 4th-order integrator reference implementation.

Pure Python 3 standard library (no numpy) so it runs anywhere without a toolchain.
Purpose: numerically verify integrator correctness claims before any C++ port.

Usage:
    python hermite_ref.py
"""

import math
import time

# ---------------------------------------------------------------------------
# Vec3 minimal
# ---------------------------------------------------------------------------


class Vec3:
    __slots__ = ("x", "y", "z")

    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.x = float(x)
        self.y = float(y)
        self.z = float(z)

    def __add__(self, o):
        return Vec3(self.x + o.x, self.y + o.y, self.z + o.z)

    def __sub__(self, o):
        return Vec3(self.x - o.x, self.y - o.y, self.z - o.z)

    def __mul__(self, s):
        return Vec3(self.x * s, self.y * s, self.z * s)

    __rmul__ = __mul__

    def __neg__(self):
        return Vec3(-self.x, -self.y, -self.z)

    def dot(self, o):
        return self.x * o.x + self.y * o.y + self.z * o.z

    def norm(self):
        return math.sqrt(self.x * self.x + self.y * self.y + self.z * self.z)

    def copy(self):
        return Vec3(self.x, self.y, self.z)

    def __repr__(self):
        return "Vec3(%.6e, %.6e, %.6e)" % (self.x, self.y, self.z)


ZERO = Vec3(0.0, 0.0, 0.0)


# ---------------------------------------------------------------------------
# System
# ---------------------------------------------------------------------------


class Body:
    __slots__ = ("mass", "position", "velocity")

    def __init__(self, mass, position, velocity):
        self.mass = float(mass)
        self.position = position
        self.velocity = velocity


class System:
    def __init__(self, bodies, softening=0.0, G=1.0):
        self.bodies = bodies
        self.softening = softening
        self.G = G
        self.time = 0.0


# ---------------------------------------------------------------------------
# Force kernel: acceleration + jerk
# ---------------------------------------------------------------------------


def compute_acceleration_jerk(sys, x, v, out_a, out_j):
    """Plummer-softened pairwise a and j. G=1 convention encoded via sys.G."""
    n = len(sys.bodies)
    for i in range(n):
        out_a[i] = Vec3()
        out_j[i] = Vec3()

    eps2 = sys.softening * sys.softening
    G = sys.G
    m = [b.mass for b in sys.bodies]

    for i in range(n):
        xi, vi = x[i], v[i]
        for k in range(i + 1, n):
            dx = xi - x[k]
            dv = vi - v[k]
            r2 = dx.x * dx.x + dx.y * dx.y + dx.z * dx.z + eps2
            r = math.sqrt(r2)
            inv_r = 1.0 / r
            inv_r3 = inv_r * inv_r * inv_r
            inv_r5 = inv_r3 * inv_r * inv_r

            # acceleration bracket: dx / r^3
            fb_x, fb_y, fb_z = dx.x * inv_r3, dx.y * inv_r3, dx.z * inv_r3
            out_a[i].x -= fb_x * m[k]
            out_a[i].y -= fb_y * m[k]
            out_a[i].z -= fb_z * m[k]
            out_a[k].x += fb_x * m[i]
            out_a[k].y += fb_y * m[i]
            out_a[k].z += fb_z * m[i]

            # jerk bracket: dv/r^3 - 3*(dx.dv)*dx/r^5
            dvdx = dv.x * dx.x + dv.y * dx.y + dv.z * dx.z
            c = 3.0 * dvdx * inv_r5
            jb_x = dv.x * inv_r3 - dx.x * c
            jb_y = dv.y * inv_r3 - dx.y * c
            jb_z = dv.z * inv_r3 - dx.z * c
            out_j[i].x -= jb_x * m[k]
            out_j[i].y -= jb_y * m[k]
            out_j[i].z -= jb_z * m[k]
            out_j[k].x += jb_x * m[i]
            out_j[k].y += jb_y * m[i]
            out_j[k].z += jb_z * m[i]

    if G != 1.0:
        for i in range(n):
            out_a[i] = out_a[i] * G
            out_j[i] = out_j[i] * G


# ---------------------------------------------------------------------------
# Variant A: exactly as written in the design doc (a0/j0 never initialised)
# ---------------------------------------------------------------------------


def step_as_written(sys, dt):
    """Reproduces the doc's code path verbatim, including its ordering bug."""
    n = len(sys.bodies)
    a0 = [Vec3() for _ in range(n)]  # never filled -> all zero
    j0 = [Vec3() for _ in range(n)]  # never filled -> all zero
    a1 = [Vec3() for _ in range(n)]
    j1 = [Vec3() for _ in range(n)]

    x1 = [Vec3() for _ in range(n)]
    v1 = [Vec3() for _ in range(n)]

    for i in range(n):
        b = sys.bodies[i]
        x1[i] = b.position + b.velocity * dt + a0[i] * (0.5 * dt * dt) + j0[i] * (dt * dt * dt / 6.0)
        v1[i] = b.velocity + a0[i] * dt + j0[i] * (0.5 * dt * dt)

    compute_acceleration_jerk(sys, x1, v1, a1, j1)

    for i in range(n):
        da = a0[i] - a1[i]
        dj = j0[i] - j1[i]
        b = sys.bodies[i]
        b.position = x1[i] + da * (dt * dt / 12.0) + dj * (dt * dt * dt / 24.0)
        b.velocity = v1[i] + da * (dt / 2.0) + dj * (dt * dt / 6.0)

    sys.time += dt


# ---------------------------------------------------------------------------
# Variant B: correct Hermite 4 (Hut, Makino & McMillan 1995)
# ---------------------------------------------------------------------------


def step_correct(sys, dt, work=None):
    n = len(sys.bodies)
    if work is None:
        work = _make_work(n)
    a0, j0, a1, j1, xp, vp = work

    x = [b.position for b in sys.bodies]
    v = [b.velocity for b in sys.bodies]

    # 1. evaluate a0, j0 at CURRENT state  <-- the missing call
    compute_acceleration_jerk(sys, x, v, a0, j0)

    # 2. predict
    for i in range(n):
        xp[i] = x[i] + v[i] * dt + a0[i] * (0.5 * dt * dt) + j0[i] * (dt * dt * dt / 6.0)
        vp[i] = v[i] + a0[i] * dt + j0[i] * (0.5 * dt * dt)

    # 3. evaluate a1, j1 at predicted state
    compute_acceleration_jerk(sys, xp, vp, a1, j1)

    # 4. correct with second and third derivative of acceleration
    dt2 = dt * dt
    dt3 = dt2 * dt
    for i in range(n):
        da0 = a0[i] - a1[i]
        jsum = j0[i] + j1[i]
        # a2 = (-6*(a0-a1) - dt*(4*j0 + 2*j1)) / dt^2
        a2 = da0 * (-6.0 / dt2) + j0[i] * (-4.0 / dt) + j1[i] * (-2.0 / dt)
        # a3 = (12*(a0-a1) + 6*dt*(j0+j1)) / dt^3
        a3 = da0 * (12.0 / dt3) + jsum * (6.0 / dt2)

        b = sys.bodies[i]
        b.position = (
            x[i]
            + v[i] * dt
            + a0[i] * (0.5 * dt2)
            + j0[i] * (dt3 / 6.0)
            + a2 * (dt2 * dt2 / 24.0)
            + a3 * (dt2 * dt3 / 120.0)
        )
        b.velocity = (
            v[i]
            + a0[i] * dt
            + j0[i] * (0.5 * dt2)
            + a2 * (dt3 / 6.0)
            + a3 * (dt2 * dt2 / 24.0)
        )

    sys.time += dt


def _make_work(n):
    return (
        [Vec3() for _ in range(n)],
        [Vec3() for _ in range(n)],
        [Vec3() for _ in range(n)],
        [Vec3() for _ in range(n)],
        [Vec3() for _ in range(n)],
        [Vec3() for _ in range(n)],
    )


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------


def total_energy(sys):
    G = sys.G
    eps2 = sys.softening * sys.softening
    kin = 0.0
    for b in sys.bodies:
        kin += 0.5 * b.mass * (b.velocity.dot(b.velocity))
    pot = 0.0
    n = len(sys.bodies)
    for i in range(n):
        for k in range(i + 1, n):
            d = sys.bodies[i].position - sys.bodies[k].position
            r = math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z + eps2)
            pot -= G * sys.bodies[i].mass * sys.bodies[k].mass / r
    return kin + pot


def orbital_elements(sys, i=1, j=0):
    """Two-body osculating a, e from relative state of bodies i,j."""
    bi, bj = sys.bodies[i], sys.bodies[j]
    r = bi.position - bj.position
    v = bi.velocity - bj.velocity
    mu = sys.G * (bi.mass + bj.mass)
    rn = r.norm()
    vn2 = v.dot(v)
    energy = 0.5 * vn2 - mu / rn
    a = -mu / (2.0 * energy)
    rv = r.dot(v)
    # e_vec = ((v^2 - mu/r) r - (r.v) v) / mu
    ex = ((vn2 - mu / rn) * r.x - rv * v.x) / mu
    ey = ((vn2 - mu / rn) * r.y - rv * v.y) / mu
    ez = ((vn2 - mu / rn) * r.z - rv * v.z) / mu
    e = math.sqrt(ex * ex + ey * ey + ez * ez)
    return a, e


def make_two_body():
    """Sun + Earth, circular orbit. Units: AU, solar mass, year. G = 4*pi^2."""
    G = 4.0 * math.pi * math.pi
    M = 1.0
    m = 3.0034896e-6
    a = 1.0
    mu = G * (M + m)
    n = math.sqrt(mu / (a * a * a))
    # barycentric: Earth at +a*M/(M+m), Sun at -a*m/(M+m)
    xe = a * M / (M + m)
    xs = -a * m / (M + m)
    ve = n * xe
    vs = -n * xs
    sun = Body(M, Vec3(xs, 0.0, 0.0), Vec3(0.0, vs, 0.0))
    earth = Body(m, Vec3(xe, 0.0, 0.0), Vec3(0.0, ve, 0.0))
    return System([sun, earth], softening=0.0, G=G), n


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_kepler(step_fn, label, years=100.0, steps_per_orbit=1000):
    sys, n = make_two_body()
    period = 2.0 * math.pi / n
    dt = period / steps_per_orbit
    nsteps = int(round(years / dt))

    a0, e0 = orbital_elements(sys)
    E0 = total_energy(sys)
    worst_de = 0.0
    t0 = time.perf_counter()
    for s in range(nsteps):
        step_fn(sys, dt)
        if s % 50 == 0:
            E = total_energy(sys)
            worst_de = max(worst_de, abs((E - E0) / E0))
    el = time.perf_counter() - t0

    a1, e1 = orbital_elements(sys)
    return {
        "label": label,
        "steps": nsteps,
        "dt": dt,
        "a0": a0,
        "a1": a1,
        "a_err": abs(a1 - a0) / a0,
        "e0": e0,
        "e1": e1,
        "e_drift": abs(e1 - e0),
        "dE_E": worst_de,
        "wall_s": el,
    }


def test_jerk_analytic(sys):
    """Validate analytic jerk against finite-difference da/dt."""
    n = len(sys.bodies)
    x = [b.position for b in sys.bodies]
    v = [b.velocity for b in sys.bodies]
    a0 = [Vec3() for _ in range(n)]
    j0 = [Vec3() for _ in range(n)]
    compute_acceleration_jerk(sys, x, v, a0, j0)

    h = 1e-7
    xp = [x[i] + v[i] * h for i in range(n)]
    ah = [Vec3() for _ in range(n)]
    jh = [Vec3() for _ in range(n)]
    compute_acceleration_jerk(sys, xp, v, ah, jh)

    worst = 0.0
    for i in range(n):
        fd = (ah[i] - a0[i]) * (1.0 / h)
        d = (fd - j0[i]).norm()
        scale = max(1e-30, j0[i].norm())
        worst = max(worst, d / scale)
    return worst


def bench_throughput(n=200, steps=200):
    """Measure pairwise-interaction throughput to bound the 1000-body claim."""
    import random

    random.seed(7)
    bodies = []
    for _ in range(n):
        bodies.append(
            Body(
                1.0 / n,
                Vec3(random.uniform(-1, 1), random.uniform(-1, 1), random.uniform(-1, 1)),
                Vec3(random.uniform(-0.1, 0.1), random.uniform(-0.1, 0.1), random.uniform(-0.1, 0.1)),
            )
        )
    sys = System(bodies, softening=1e-3, G=1.0)
    work = _make_work(n)
    t0 = time.perf_counter()
    for _ in range(steps):
        step_correct(sys, 1e-4, work)
    el = time.perf_counter() - t0
    pairs_per_step = n * (n - 1) // 2
    return {
        "n": n,
        "steps": steps,
        "wall_s": el,
        "pairs_per_step": pairs_per_step,
        "pairs_per_sec": pairs_per_step * steps / el,
    }


def main():
    print("=" * 74)
    print("Starpivot Hermite-4 verification reference (pure Python stdlib)")
    print("=" * 74)

    sys, _ = make_two_body()
    jerr = test_jerk_analytic(sys)
    print("\n[0] analytic jerk vs finite-difference da/dt")
    print("    relative discrepancy = %.3e   %s" % (jerr, "OK" if jerr < 1e-5 else "FAIL"))

    print("\n[1] Two-body Kepler, 100 yr, dt = T/1000")
    print("-" * 74)
    rows = []
    rows.append(test_kepler(step_as_written, "as-written"))
    rows.append(test_kepler(step_correct, "corrected "))
    print("    %-12s %10s %14s %14s %14s" % ("variant", "steps", "a_err", "e_drift", "|dE/E|"))
    for r in rows:
        print(
            "    %-12s %10d %14.3e %14.3e %14.3e"
            % (r["label"], r["steps"], r["a_err"], r["e_drift"], r["dE_E"])
        )
    print("\n    target: a_err < 1e-9, e_drift < 1e-8")

    print("\n[2] Pairwise throughput (for bounding the 1000-body baseline)")
    print("-" * 74)
    b = bench_throughput()
    print("    N=%d, %d steps -> %.3f s" % (b["n"], b["steps"], b["wall_s"]))
    print("    pairs/step = %d" % b["pairs_per_step"])
    print("    pair-interactions/sec (Python) = %.3e" % b["pairs_per_sec"])

    need = 1000 * 999 // 2 * 100000
    print("\n    required for N=1000, 1e5 steps: %.3e pair-interactions" % need)
    for factor in (40, 80):
        est = need / (b["pairs_per_sec"] * factor)
        print("      -> if C++ is %dx faster: %.1f s" % (factor, est))
    print("      -> to hit the claimed 2 s you would need %.3e pairs/sec"
          % (need / 2.0))

    print("\n" + "=" * 74)


if __name__ == "__main__":
    main()
