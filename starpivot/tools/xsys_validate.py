# -*- coding: utf-8 -*-
"""
starpivot.xsys — .xsys v1.0 format validation.

Design rule for this module: EVERY rejection must be human-readable and carry a
fix hint. A user should never have to read the spec to correct their own file.
That is what "low barrier to entry" means at the file layer.

Two deliberate deviations from the original design note, both documented in
docs/M1-revised.md:

  rule 02  The spec's worked example was self-contradictory
           (t_end=31557600000.0, dt=90000.0 reported "remainder: 0.0" and then
           suggested dt=86400.0, which does NOT divide t_end). The check is
           implemented as an integer test; the example is regenerated.
  rule 04  Unknown fields are warn-and-ignore by default, not reject.
           Rejecting them breaks forward compatibility, which the PRD requires
           (".xsys 格式向后兼容"). Strict mode is opt-in via validate(...,
           strict=True) for CI.

Wire format is JSON so every language gets a parser for free.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

__all__ = [
    "XsysError",
    "ValidationReport",
    "validate",
    "validate_file",
    "load",
    "load_file",
    "OUTPUT_SECTIONS",
    "REGISTERED_INTEGRATORS",
]

SCHEMA_VERSION = "1.0"

REGISTERED_INTEGRATORS = ("hermite4", "leapfrog2")

OUTPUT_SECTIONS = ("energy", "elements", "trajectory", "collisions")

TOP_LEVEL_FIELDS = ("xsys", "units", "integrator", "output", "bodies")

INTEGRATOR_FIELDS = (
    "name",
    "dt",
    "t_end",
    "adaptive",
    "softening",
    "snapshot_every",
)

BODY_FIELDS = ("id", "mass", "position", "velocity", "radius", "spin", "tag")

# Relative tolerance for the t_end / dt integrality test.
_MULTIPLE_RTOL = 1e-9


# ---------------------------------------------------------------------------
# Error type
# ---------------------------------------------------------------------------


@dataclass
class XsysError:
    rule: str
    message: str
    hint: str = ""
    path: str = ""

    def __str__(self) -> str:
        head = "xsys error [%s]" % self.rule
        if self.path:
            head += " at %s" % self.path
        lines = [head]
        lines.append("  " + self.message)
        if self.hint:
            lines.append("  hint: " + self.hint)
        return "\n".join(lines)


@dataclass
class ValidationReport:
    errors: List[XsysError] = None
    warnings: List[str] = None

    def __post_init__(self) -> None:
        if self.errors is None:
            self.errors = []
        if self.warnings is None:
            self.warnings = []

    @property
    def ok(self) -> bool:
        return not self.errors

    def __str__(self) -> str:
        out = []
        for e in self.errors:
            out.append(str(e))
        for w in self.warnings:
            out.append("xsys warning: " + w)
        if not out:
            out.append("xsys: ok, no errors")
        return "\n".join(out)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _finite(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v))


def _num(v: Any) -> Optional[float]:
    return float(v) if _finite(v) else None


def _fmt(v: Any) -> str:
    if isinstance(v, float):
        return "%.10g" % v
    return repr(v)


def _hint_dt_divisors(t_end: float, dt: float) -> str:
    """Suggest nearby dt values that divide t_end exactly."""
    if t_end <= 0 or dt <= 0:
        return "dt and t_end must both be positive"
    approx = int(round(t_end / dt))
    cands = []
    for steps in (approx - 1, approx, approx + 1):
        if steps > 0:
            cands.append(t_end / steps)
        cands.append(t_end / max(1, steps))
    # also offer round human values
    for cand in (86400.0, 3600.0, 86400.0 / 2, 86400.0 / 24):
        r = t_end / cand
        if abs(r - round(r)) < 1e-6 and round(r) > 0:
            cands.append(cand)
    uniq = []
    for c in cands:
        if c > 0 and all(abs(c - u) > 1e-12 for u in uniq):
            uniq.append(c)
    uniq.sort(key=lambda c: abs(c - dt))
    return "try dt = %s" % ", ".join("%.10g" % c for c in uniq[:3])


# ---------------------------------------------------------------------------
# validator
# ---------------------------------------------------------------------------


def validate(doc: Dict[str, Any], strict: bool = False) -> ValidationReport:
    rep = ValidationReport()

    if not isinstance(doc, dict):
        rep.errors.append(
            XsysError(
                "00",
                "document root must be a mapping, got %s" % type(doc).__name__,
                "wrap your content in { }",
            )
        )
        return rep

    # --- schema version -----------------------------------------------------
    ver = doc.get("xsys")
    if ver is None:
        rep.errors.append(
            XsysError(
                "00",
                "missing required field 'xsys' (schema version)",
                'add "xsys": "%s" at the top level' % SCHEMA_VERSION,
            )
        )
    elif str(ver).split(".")[0] != SCHEMA_VERSION.split(".")[0]:
        rep.errors.append(
            XsysError(
                "00",
                "unsupported major schema version %s (this build reads %s.x)"
                % (_fmt(ver), SCHEMA_VERSION.split(".")[0]),
                "regenerate the file or install a build that supports this version",
            )
        )

    # --- unknown top-level fields (rule 04) ---------------------------------
    for key in doc:
        if key not in TOP_LEVEL_FIELDS:
            msg = "unknown top-level field %r" % key
            if strict:
                rep.errors.append(
                    XsysError(
                        "04",
                        msg + " (strict mode: rejected)",
                        "remove it, or rename if it is a typo; known fields: %s"
                        % ", ".join(TOP_LEVEL_FIELDS),
                        path=key,
                    )
                )
            else:
                rep.warnings.append(msg + "; ignored (forward-compatible mode)")

    # --- integrator block ---------------------------------------------------
    integ = doc.get("integrator")
    if not isinstance(integ, dict):
        rep.errors.append(
            XsysError(
                "05",
                "missing or invalid 'integrator' block",
                'add {"name": "hermite4", "dt": ..., "t_end": ...}',
                path="integrator",
            )
        )
        integ = {}

    for key in integ:
        if key not in INTEGRATOR_FIELDS:
            msg = "unknown integrator field %r" % key
            if strict:
                rep.errors.append(
                    XsysError(
                        "04",
                        msg + " (strict mode: rejected)",
                        "known fields: %s" % ", ".join(INTEGRATOR_FIELDS),
                        path="integrator." + str(key),
                    )
                )
            else:
                rep.warnings.append(msg + "; ignored")

    # rule 05: integrator name must be registered
    name = integ.get("name")
    if name not in REGISTERED_INTEGRATORS:
        rep.errors.append(
            XsysError(
                "05",
                "integrator name %s is not registered" % _fmt(name),
                "v%s registry: %s"
                % (SCHEMA_VERSION, ", ".join(REGISTERED_INTEGRATORS)),
                path="integrator.name",
            )
        )

    # rule 02: dt > 0 and t_end an integer multiple of dt
    dt = _num(integ.get("dt"))
    t_end = _num(integ.get("t_end"))
    if dt is None:
        rep.errors.append(
            XsysError(
                "02",
                "dt must be a finite positive number, got %s" % _fmt(integ.get("dt")),
                "set dt to the integration step in your time unit, e.g. 0.01",
                path="integrator.dt",
            )
        )
    elif dt <= 0:
        rep.errors.append(
            XsysError(
                "02",
                "dt must be > 0, got %s" % _fmt(dt),
                "use a positive step size",
                path="integrator.dt",
            )
        )

    if t_end is None:
        rep.errors.append(
            XsysError(
                "02",
                "t_end must be a finite positive number, got %s"
                % _fmt(integ.get("t_end")),
                "set t_end to the total simulated time",
                path="integrator.t_end",
            )
        )
    elif t_end <= 0:
        rep.errors.append(
            XsysError(
                "02",
                "t_end must be > 0, got %s" % _fmt(t_end),
                "use a positive end time",
                path="integrator.t_end",
            )
        )

    if dt is not None and dt > 0 and t_end is not None and t_end > 0:
        ratio = t_end / dt
        nearest = round(ratio)
        remainder = t_end - nearest * dt
        tol = _MULTIPLE_RTOL * max(abs(t_end), abs(dt))
        if abs(remainder) > tol:
            rep.errors.append(
                XsysError(
                    "02",
                    "t_end must be an integer multiple of dt\n"
                    "  got: t_end=%s, dt=%s (remainder: %.10g, nearest step count: %d)"
                    % (_fmt(t_end), _fmt(dt), remainder, int(nearest)),
                    _hint_dt_divisors(t_end, dt),
                    path="integrator.t_end",
                )
            )

    # rule 06: adaptive eta in (0, 1)
    adaptive = integ.get("adaptive")
    if adaptive is not None:
        if not isinstance(adaptive, dict):
            rep.errors.append(
                XsysError(
                    "06",
                    "'adaptive' must be a mapping, got %s" % type(adaptive).__name__,
                    'use {"enabled": true, "eta": 0.02}',
                    path="integrator.adaptive",
                )
            )
        elif adaptive.get("enabled"):
            eta = _num(adaptive.get("eta"))
            if eta is None:
                rep.errors.append(
                    XsysError(
                        "06",
                        "adaptive step enabled but eta is missing or not finite",
                        "set eta, e.g. 0.02",
                        path="integrator.adaptive.eta",
                    )
                )
            elif not (0.0 < eta < 1.0):
                rep.errors.append(
                    XsysError(
                        "06",
                        "eta must lie strictly in (0, 1), got %s" % _fmt(eta),
                        "0.01 - 0.05 is a sane range; smaller is more accurate and slower",
                        path="integrator.adaptive.eta",
                    )
                )

    # rule 07: softening >= 0
    soft = integ.get("softening", 0.0)
    sv = _num(soft)
    if sv is None:
        rep.errors.append(
            XsysError(
                "07",
                "softening must be a finite number >= 0, got %s" % _fmt(soft),
                "use 0.0 for pure point-mass gravity",
                path="integrator.softening",
            )
        )
    elif sv < 0:
        rep.errors.append(
            XsysError(
                "07",
                "softening must be >= 0, got %s" % _fmt(sv),
                "negative softening is unphysical; use 0.0 or a small positive length",
                path="integrator.softening",
            )
        )

    # rule 10: snapshot_every >= dt
    snap = integ.get("snapshot_every")
    if snap is not None:
        snapv = _num(snap)
        if snapv is None:
            rep.errors.append(
                XsysError(
                    "10",
                    "snapshot_every must be a finite number, got %s" % _fmt(snap),
                    "remove it, or set it to a multiple of dt",
                    path="integrator.snapshot_every",
                )
            )
        elif dt is not None and snapv < dt:
            rep.errors.append(
                XsysError(
                    "10",
                    "snapshot_every (%s) must be >= dt (%s)" % (_fmt(snapv), _fmt(dt)),
                    "snapshotting more often than the step size is not possible; "
                    "use a multiple of dt",
                    path="integrator.snapshot_every",
                )
            )

    # rule 08: output sections whitelist
    outputs = doc.get("output", [])
    if outputs is None:
        outputs = []
    if not isinstance(outputs, (list, tuple)):
        rep.errors.append(
            XsysError(
                "08",
                "'output' must be a list, got %s" % type(outputs).__name__,
                "use a list of section names",
                path="output",
            )
        )
        outputs = []
    for sec in outputs:
        if sec not in OUTPUT_SECTIONS:
            rep.errors.append(
                XsysError(
                    "08",
                    "output section %s is not in the v%s whitelist" % (_fmt(sec), SCHEMA_VERSION),
                    "allowed: %s" % ", ".join(OUTPUT_SECTIONS),
                    path="output",
                )
            )

    # --- bodies -------------------------------------------------------------
    bodies = doc.get("bodies")
    if not isinstance(bodies, list):
        rep.errors.append(
            XsysError(
                "09",
                "'bodies' must be a list, got %s" % type(bodies).__name__,
                "each entry needs id, mass, position, velocity",
                path="bodies",
            )
        )
        return rep

    # rule 09: at least 2 bodies
    if len(bodies) < 2:
        rep.errors.append(
            XsysError(
                "09",
                "at least 2 bodies are required, got %d" % len(bodies),
                "a single body has no gravitational interaction to integrate; "
                "add a central body",
                path="bodies",
            )
        )

    seen_ids = set()
    for idx, b in enumerate(bodies):
        p = "bodies[%d]" % idx
        if not isinstance(b, dict):
            rep.errors.append(
                XsysError(
                    "01",
                    "body must be a mapping, got %s" % type(b).__name__,
                    'use {"id": ..., "mass": ..., "position": [...], "velocity": [...]}',
                    path=p,
                )
            )
            continue

        for key in b:
            if key not in BODY_FIELDS:
                msg = "unknown body field %r" % key
                if strict:
                    rep.errors.append(
                        XsysError(
                            "04",
                            msg + " (strict mode: rejected)",
                            "known fields: %s" % ", ".join(BODY_FIELDS),
                            path=p + "." + str(key),
                        )
                    )
                else:
                    rep.warnings.append(msg + "; ignored")

        # rule 03: unique id
        bid = b.get("id")
        if not isinstance(bid, str) or not bid:
            rep.errors.append(
                XsysError(
                    "03",
                    "body id must be a non-empty string, got %s" % _fmt(bid),
                    'give every body a unique id, e.g. "earth"',
                    path=p + ".id",
                )
            )
        elif bid in seen_ids:
            rep.errors.append(
                XsysError(
                    "03",
                    "duplicate body id %r" % bid,
                    "ids must be globally unique across the file",
                    path=p + ".id",
                )
            )
        else:
            seen_ids.add(bid)

        # rule 01: mass > 0 and finite
        mass = _num(b.get("mass"))
        if mass is None:
            rep.errors.append(
                XsysError(
                    "01",
                    "mass must be a finite number > 0, got %s" % _fmt(b.get("mass")),
                    "mass must be positive and finite in the declared mass unit",
                    path=p + ".mass",
                )
            )
        elif mass <= 0:
            rep.errors.append(
                XsysError(
                    "01",
                    "mass must be > 0, got %s" % _fmt(mass),
                    "a zero or negative mass has no physical meaning here",
                    path=p + ".mass",
                )
            )

        for field_name in ("position", "velocity"):
            vec = b.get(field_name)
            ok = (
                isinstance(vec, (list, tuple))
                and len(vec) == 3
                and all(_finite(c) for c in vec)
            )
            if not ok:
                rep.errors.append(
                    XsysError(
                        "01",
                        "%s must be a list of 3 finite numbers, got %s"
                        % (field_name, _fmt(vec)),
                        "use [x, y, z]; NaN and Inf are rejected before integration",
                        path=p + "." + field_name,
                    )
                )

    return rep


def validate_file(path: str, strict: bool = False) -> ValidationReport:
    with open(path, "r", encoding="utf-8") as fh:
        try:
            doc = json.load(fh)
        except json.JSONDecodeError as exc:
            rep = ValidationReport()
            rep.errors.append(
                XsysError(
                    "00",
                    "not valid JSON: %s (line %d, column %d)"
                    % (exc.msg, exc.lineno, exc.colno),
                    "check for a trailing comma, or an unquoted key",
                )
            )
            return rep
    return validate(doc, strict=strict)


def load(path: str, strict: bool = False):
    """Validate, then build a System using the C++ kernel through its bindings.

    Raises ValueError on any rule failure, ImportError if starpivot_native has
    not been built. This function deliberately constructs nothing itself --
    building the System is the kernel's job, not Python's.
    """
    import starpivot_native as sp

    with open(path, "r", encoding="utf-8") as fh:
        doc = json.load(fh)

    rep = validate(doc, strict=strict)
    if not rep.ok:
        raise ValueError(str(rep))

    units = doc.get("units", {}) or {}
    G = 1.0 if units.get("length") == "natural" else sp.G_AU_MSUN_YR

    integ = doc.get("integrator", {}) or {}
    sys_ = sp.System()
    sys_.G = G
    sys_.softening = float(integ.get("softening", 0.0))
    for b in doc["bodies"]:
        sys_.add_body(
            sp.Body(
                b["id"],
                float(b["mass"]),
                sp.Vec3(*[float(c) for c in b["position"]]),
                sp.Vec3(*[float(c) for c in b["velocity"]]),
            )
        )
    return sys_, doc


def load_file(path: str, strict: bool = False):
    return load(path, strict=strict)
