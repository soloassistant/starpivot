// starpivot — ground track implementation. See groundtrack.hpp for the
// rationale, accuracy statement and conventions.

#include "starpivot/groundtrack.hpp"

#include <cmath>

#include "starpivot/time.hpp"

namespace starpivot {

namespace {
constexpr double kDegPerRad = 180.0 / 3.14159265358979323846;

/// WGS72 equatorial radius [km] — the same constant SGP4 is defined against.
constexpr double kWGS72Re = 6378.135;

/// Wrap an angle in degrees to (-180, 180].
double wrap_lon_deg(double lon) {
    while (lon <= -180.0) lon += 360.0;
    while (lon > 180.0) lon -= 360.0;
    return lon;
}
}  // namespace

Subpoint subpoint_from_teme(const Vec3& r_km, double jd_ut1) {
    const double r = r_km.norm();
    const double theta = gmst_from_jd_ut1(jd_ut1);

    Subpoint sp;
    sp.lat_deg = std::asin(r_km.z / r) * kDegPerRad;
    // TEME right ascension minus Greenwich sidereal angle = east longitude.
    sp.lon_deg = wrap_lon_deg((std::atan2(r_km.y, r_km.x) - theta) * kDegPerRad);
    sp.alt_km = r - kWGS72Re;
    return sp;
}

bool ground_track(const Tle& tle, double t_start_min, double t_end_min,
                  double step_min, std::vector<GroundSample>& out,
                  Sgp4Error* error) {
    out.clear();
    if (step_min <= 0.0 || t_end_min < t_start_min) {
        if (error) *error = Sgp4Error::kOk;  // caller misuse, not a model error
        return false;
    }

    Sgp4 s;
    if (!sgp4_init(s, tle)) {
        if (error) *error = Sgp4Error::kMeanMotionNonPositive;
        return false;
    }

    // Ascending tsince only: the SDP4 resonance integrator carries state
    // between calls and requires monotonic propagation.
    const long n = static_cast<long>(
        std::floor((t_end_min - t_start_min) / step_min + 1e-9));
    out.reserve(static_cast<std::size_t>(n) + 1);
    for (long k = 0; k <= n; ++k) {
        const double t = t_start_min + k * step_min;
        Vec3 r, v;
        if (!sgp4_propagate(s, t, r, v, error)) {
            out.clear();
            return false;
        }
        // UT1 = UTC + DUT1 (DUT1 defaults to 0 without an IERS bulletin,
        // < 0.9 s of Earth rotation, well under a pixel on any map).
        const double jd_ut1 = tle.epoch_jd + t / 1440.0 +
                              ut1_minus_utc(tle.epoch_jd + t / 1440.0) / kSecondsPerDay;
        const Subpoint sp = subpoint_from_teme(r, jd_ut1);
        out.push_back({t, sp.lat_deg, sp.lon_deg, sp.alt_km});
    }
    return true;
}

}  // namespace starpivot
