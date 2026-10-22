#!/usr/bin/env python3
"""Generate .xsys v1.0 scenario files.

This is one of the three sanctioned Python roles: writing .xsys scenario files.
It emits JSON only; it computes no trajectory and integrates nothing. The
initial conditions mirror tests/fixtures.hpp so a scenario produced here and the
same case compiled into the C++ suite agree to the last bit.

Usage:
    python tools/xsys_gen.py list
    python tools/xsys_gen.py build two_body --years 100 --steps-per-orbit 1000
    python tools/xsys_gen.py build figure8 --out cases/figure8.xsys
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys

SCHEMA = "1.0"

G_AU_MSUN_YR = 4.0 * math.pi * math.pi
M_SUN = 1.0
M_EARTH = 3.0034895966e-6
M_JUPITER = 9.547919e-4
M_MOON = 3.694302e-8


def _wrap(doc: dict) -> str:
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


# ---------------------------------------------------------------------------
# scenarios
# ---------------------------------------------------------------------------


def two_body(a: float = 1.0) -> dict:
    n = math.sqrt(G_AU_MSUN_YR * (M_SUN + M_EARTH) / a**3)
    xe = a * M_SUN / (M_SUN + M_EARTH)
    xs = -a * M_EARTH / (M_SUN + M_EARTH)
    return {
        "bodies": [
            {"id": "sun", "mass": M_SUN, "position": [xs, 0.0, 0.0],
             "velocity": [0.0, n * xs, 0.0]},
            {"id": "earth", "mass": M_EARTH, "position": [xe, 0.0, 0.0],
             "velocity": [0.0, n * xe, 0.0]},
        ]
    }


def figure8() -> dict:
    x1, y1 = 0.97000436, -0.24308753
    vx3, vy3 = -0.93240737, -0.86473146
    return {
        "bodies": [
            {"id": "b1", "mass": 1.0, "position": [x1, y1, 0.0],
             "velocity": [-vx3 / 2.0, -vy3 / 2.0, 0.0]},
            {"id": "b2", "mass": 1.0, "position": [-x1, -y1, 0.0],
             "velocity": [-vx3 / 2.0, -vy3 / 2.0, 0.0]},
            {"id": "b3", "mass": 1.0, "position": [0.0, 0.0, 0.0],
             "velocity": [vx3, vy3, 0.0]},
        ],
        # Figure-8 runs in units where G = 1
        "_units_override": {"length": "natural", "mass": "natural", "time": "natural"},
    }


def perturbed() -> dict:
    specs = [
        ("p1", 1e-6, 0.40, 0.0),
        ("p2", 2e-6, 0.70, 1.1),
        ("p3", 1e-5, 1.50, 2.4),
        ("jup", M_JUPITER * 10.0, 5.20, 4.0),
    ]
    bodies = [{"id": "sun", "mass": M_SUN, "position": [0.0, 0.0, 0.0],
               "velocity": [0.0, 0.0, 0.0]}]
    for bid, m, a, phase in specs:
        n = math.sqrt(G_AU_MSUN_YR * (M_SUN + m) / a**3)
        v = n * a
        bodies.append({
            "id": bid, "mass": m,
            "position": [a * math.cos(phase), a * math.sin(phase), 0.0],
            "velocity": [-v * math.sin(phase), v * math.cos(phase), 0.0],
        })
    return {"bodies": bodies}


def earth_moon(a: float = 0.00257) -> dict:
    """Earth + Moon, barycentric, Moon on a circular orbit."""
    n = math.sqrt(G_AU_MSUN_YR * (M_EARTH + M_MOON) / a**3)
    xm = a * M_EARTH / (M_EARTH + M_MOON)
    xe = -a * M_MOON / (M_EARTH + M_MOON)
    return {
        "bodies": [
            {"id": "earth", "mass": M_EARTH, "position": [xe, 0.0, 0.0],
             "velocity": [0.0, n * xe, 0.0]},
            {"id": "moon", "mass": M_MOON, "position": [xm, 0.0, 0.0],
             "velocity": [0.0, n * xm, 0.0]},
        ],
        "_units_override": {"length": "au", "mass": "msun", "time": "yr"},
    }


def lagrange_l4(a: float = 1.0) -> dict:
    """Sun + Earth + a Trojan parked at the stable L4 point."""
    base = two_body(a)
    n = math.sqrt(G_AU_MSUN_YR * (M_SUN + M_EARTH) / a**3)
    xs = -a * M_EARTH / (M_SUN + M_EARTH)
    l4 = [xs + a * 0.5, a * math.sqrt(3.0) / 2.0, 0.0]
    vel = [-n * l4[1], n * l4[0], 0.0]
    base["bodies"].append({"id": "trojan", "mass": 1e-14, "position": l4, "velocity": vel})
    return base


SCENARIOS = {
    "two_body": two_body,
    "figure8": figure8,
    "perturbed": perturbed,
    "earth_moon": earth_moon,
    "lagrange_l4": lagrange_l4,
}

# Default total run time (yr) and step strategies per scenario.
DEFAULTS = {
    "two_body": {"years": 100.0, "steps_per_orbit": 1000, "orbit_period_yr": 1.0},
    "figure8": {"years": 6.32591398, "steps_per_orbit": 20000, "orbit_period_yr": 6.32591398},
    "perturbed": {"years": 1000.0, "steps_per_orbit": 2000, "orbit_period_yr": 1.0},
    "earth_moon": {"years": 1.0, "steps_per_orbit": 5000, "orbit_period_yr": 0.0748},
    "lagrange_l4": {"years": 100.0, "steps_per_orbit": 1000, "orbit_period_yr": 1.0},
}


def build(name: str, years: float | None = None, steps_per_orbit: int | None = None,
          integrator: str = "hermite4") -> dict:
    if name not in SCENARIOS:
        raise SystemExit("unknown scenario %r; known: %s" % (name, ", ".join(SCENARIOS)))

    raw = SCENARIOS[name]()
    units = raw.pop("_units_override", {"length": "au", "mass": "msun", "time": "yr"})

    d = DEFAULTS[name]
    years = years if years is not None else d["years"]
    steps_per_orbit = steps_per_orbit if steps_per_orbit is not None else d["steps_per_orbit"]

    # Choose dt so that t_end is an EXACT integer multiple of dt (xsys rule 02),
    # then rebuild both numbers from the integer step count so no rounding can
    # reintroduce a remainder.
    period = d["orbit_period_yr"]
    nsteps = int(round(years / period * steps_per_orbit))
    dt = years / nsteps
    t_end = dt * nsteps

    return {
        "xsys": SCHEMA,
        "units": units,
        "integrator": {
            "name": integrator,
            "dt": dt,
            "t_end": t_end,
            "softening": 0.0,
            "adaptive": {"enabled": False, "eta": 0.02},
            "snapshot_every": dt * max(1, nsteps // 1000),
        },
        "output": ["energy", "elements", "trajectory"],
        "bodies": raw["bodies"],
    }


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Generate .xsys scenario files")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="list available scenarios")

    b = sub.add_parser("build", help="build a scenario file")
    b.add_argument("scenario", choices=sorted(SCENARIOS))
    b.add_argument("--years", type=float, default=None)
    b.add_argument("--steps-per-orbit", type=int, default=None)
    b.add_argument("--integrator", default="hermite4", choices=["hermite4", "leapfrog2"])
    b.add_argument("--out", default=None, help="output path (default: stdout)")
    b.add_argument("--cases-dir", default=None,
                   help="write to <dir>/<scenario>.xsys instead of stdout")

    args = p.parse_args(argv)

    if args.cmd == "list":
        for name in sorted(SCENARIOS):
            print("%-14s %s" % (name, DEFAULTS[name]))
        return 0

    doc = build(args.scenario, args.years, args.steps_per_orbit, args.integrator)
    text = _wrap(doc)

    out = args.out
    if out is None and args.cases_dir:
        os.makedirs(args.cases_dir, exist_ok=True)
        out = os.path.join(args.cases_dir, args.scenario + ".xsys")

    if out:
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(text)
        print("wrote %s" % out, file=sys.stderr)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
