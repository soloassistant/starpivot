// starpivot — conjunction assessment (close-approach screening).
// See include/starpivot/conjunction.hpp for the rationale and conventions.

#include "starpivot/conjunction.hpp"

#include <algorithm>
#include <cmath>

namespace starpivot {

namespace {

// One ascending scan of [t0, t1] at step `dt`, tracking the minimum relative
// range. Both propagators are re-initialised at the start of the pass so the
// deep-space (SDP4) resonance integrator is always fed strictly increasing
// tsince. The states at the argmin are captured inline, which is valid because
// the scan is monotonic: at the argmin the propagators have been advanced to
// exactly that t.
struct Scan {
    double t_at_min = 0.0;
    double range_at_min = 1e300;
    Vec3 ra, va, rb, vb;
    bool ok = true;
    Sgp4Error code = Sgp4Error::kOk;
};

Scan scan_once(const Tle& a, const Tle& b, double t0, double t1, double dt) {
    Scan s;
    Sgp4 sa, sb;
    if (!sgp4_init(sa, a) || !sgp4_init(sb, b)) {
        s.ok = false;
        return s;
    }
    // Minutes by which object b's epoch lags/leads object a's.
    const double delta = (a.epoch_jd - b.epoch_jd) * 1440.0;
    const int n = static_cast<int>(std::ceil((t1 - t0) / dt));
    for (int i = 0; i <= n; ++i) {
        double t = (i == n) ? t1 : t0 + i * dt;
        if (t < t0) t = t0;
        if (t > t1) t = t1;

        Vec3 ra, va, rb, vb;
        Sgp4Error ea = Sgp4Error::kOk, eb = Sgp4Error::kOk;
        if (!sgp4_propagate(sa, t, ra, va, &ea) ||
            !sgp4_propagate(sb, t + delta, rb, vb, &eb)) {
            // One sample failed (e.g. decay at window edge). Keep scanning if a
            // good minimum already exists; remember the failure for reporting.
            s.ok = false;
            s.code = (ea != Sgp4Error::kOk) ? ea : eb;
            continue;
        }
        const double rng = (ra - rb).norm();
        if (rng < s.range_at_min) {
            s.range_at_min = rng;
            s.t_at_min = t;
            s.ra = ra; s.va = va; s.rb = rb; s.vb = vb;
        }
    }
    return s;
}

}  // namespace

bool find_conjunction(const Tle& a, const Tle& b, double t_start_min,
                      double t_end_min, double step_min, ConjunctionResult& out,
                      Sgp4Error* error) {
    out = ConjunctionResult{};
    if (t_end_min < t_start_min) std::swap(t_end_min, t_start_min);
    if (step_min <= 0.0) step_min = 1.0;
    out.window_min = t_end_min - t_start_min;
    out.step_min = step_min;

    // Pass 1: coarse scan at the user step.
    Scan coarse = scan_once(a, b, t_start_min, t_end_min, step_min);
    if (!coarse.ok && coarse.range_at_min >= 1e300) {
        if (error) *error = coarse.code;
        out.found = false;
        return false;
    }

    // Pass 2: refine within +/- one coarse step, 100 substeps.
    const double half1 = step_min;
    const double lo1 = std::max(t_start_min, coarse.t_at_min - half1);
    const double hi1 = std::min(t_end_min, coarse.t_at_min + half1);
    Scan fine = scan_once(a, b, lo1, hi1, step_min / 100.0);

    // Pass 3: refine further, 100 substeps again.
    const double half2 = step_min / 100.0;
    const double lo2 = std::max(t_start_min, fine.t_at_min - half2);
    const double hi2 = std::min(t_end_min, fine.t_at_min + half2);
    Scan finer = scan_once(a, b, lo2, hi2, step_min / 10000.0);

    const Scan& best = (finer.range_at_min < fine.range_at_min) ? finer : fine;

    out.found = true;
    out.tca_min = best.t_at_min;
    out.tca_utc_jd = a.epoch_jd + best.t_at_min / 1440.0;
    out.miss_distance_km = best.range_at_min;
    out.rel_speed_kms = (best.va - best.vb).norm();
    out.pos_a_km = best.ra;
    out.vel_a_kms = best.va;
    out.pos_b_km = best.rb;
    out.vel_b_kms = best.vb;
    out.tsince_b_min = best.t_at_min + (a.epoch_jd - b.epoch_jd) * 1440.0;
    if (error) *error = Sgp4Error::kOk;
    return true;
}

}  // namespace starpivot
