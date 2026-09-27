// starpivot — ground track (sub-satellite point) computation.
//
// Why this exists
// ---------------
// A ground track is the first picture an operator draws from a TLE: where the
// satellite is over the Earth, where the two objects in a conjunction are at
// TCA, whether the pass is over the target region. The SGP4/SDP4 propagator
// outputs TEME positions; converting those to a map requires one extra
// ingredient — Earth rotation (GMST) — and nothing else.
//
// What this computes
// ------------------
//   subpoint(r_teme, jd_ut1):
//     theta = GMST(jd_ut1)                 [IAU 1982, already validated in time.cpp]
//     lon   = atan2(y, x) - theta          wrapped to (-180, 180]
//     lat   = asin(z / |r|)                geocentric latitude
//     alt   = |r| - Re                     spherical-Earth altitude
//
// Accuracy statement (honest, not decorative): this is a *spherical* Earth
// sub-satellite point. Ignoring the 21 km equatorial bulge shifts latitude by
// up to 0.19 deg (~21 km) versus true geodetic latitude — plenty for drawing
// tracks and situational awareness on a map, NOT for antenna pointing or
// footprint geometry. The CLI note says the same thing.
//
// Units: input position km (TEME), time in minutes from the TLE epoch /
// Julian dates in days; output degrees and km.

#ifndef STARPIVOT_GROUNDTRACK_HPP
#define STARPIVOT_GROUNDTRACK_HPP

#include <vector>

#include "starpivot/sgp4.hpp"  // Tle, Sgp4Error
#include "starpivot/vec3.hpp"

namespace starpivot {

/// One sample of a ground track. `t_min` is minutes from the TLE's own epoch.
struct GroundSample {
    double t_min = 0.0;
    double lat_deg = 0.0;
    double lon_deg = 0.0;
    double alt_km = 0.0;
};

/// Sub-satellite point of a TEME position at a given UT1 Julian date.
/// Geocentric latitude / east longitude (degrees) and spherical-Earth
/// altitude (km above the WGS72 equatorial radius).
struct Subpoint {
    double lat_deg = 0.0;
    double lon_deg = 0.0;
    double alt_km = 0.0;
};

Subpoint subpoint_from_teme(const Vec3& r_km, double jd_ut1);

/// Sample the ground track over [t_start_min, t_end_min] (minutes from the
/// TLE's own epoch) at `step_min`. Samples are emitted in ascending tsince,
/// which is exactly what the SDP4 deep-space integrator requires, so this
/// works unchanged for both regimes.
///
/// Returns false with the propagator error code on model failure (e.g. decay).
bool ground_track(const Tle& tle, double t_start_min, double t_end_min,
                  double step_min, std::vector<GroundSample>& out,
                  Sgp4Error* error = nullptr);

}  // namespace starpivot

#endif  // STARPIVOT_GROUNDTRACK_HPP
