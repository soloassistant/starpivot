// starpivot — conjunction assessment (close-approach screening).
//
// Why this exists
// ---------------
// SGP4/SDP4 was implemented because a TLE is the *only* entry point into the
// space-situational-awareness workflow: every catalogue, every collision
// warning, every pass schedule is expressed in TLEs. The first thing a real
// operator does with two TLEs is ask "do these two objects come close?" This
// module answers that question: given two TLEs, find the time of closest
// approach (TCA) and the miss distance over a look-ahead window.
//
// What this computes
// -------------------
// Both objects are propagated with the (already Vallado-validated) SGP4/SDP4
// propagator. The relative range |r_a(t) - r_b(t)| is sampled over the window
// and minimised. Because the propagator is pre-validated to < 1e-6 km against
// the official Appendix-D vectors, any miss distance this module reports
// inherits that fidelity; the *only* new code here is the minimum-search, and
// that is what the unit test checks (the reported TCA/miss must agree with an
// independent brute-force dense scan to < 1e-3 km).
//
// Time handling
// -------------
// The window [t_start_min, t_end_min] is measured in minutes from the *primary*
// object's (object a) epoch. Object b lives at a different epoch, so at primary
// time t its time-since-epoch is
//     tsince_b = t + (epoch_a_jd - epoch_b_jd) * 1440.0   [minutes]
// All reported times (tca_min, tca_utc) are in the primary object's epoch frame.
//
// Units and conventions
// ---------------------
//   output position      km, TEME frame
//   output velocity      km/s, TEME frame
//   miss distance         km (straight-line separation at TCA)
//   relative speed        km/s (|v_a - v_b| at TCA)
//   tca_utc               ISO-8601 UTC instant of closest approach

#ifndef STARPIVOT_CONJUNCTION_HPP
#define STARPIVOT_CONJUNCTION_HPP

#include "starpivot/sgp4.hpp"  // Tle, Sgp4, Sgp4Error
#include "starpivot/vec3.hpp"

namespace starpivot {

struct ConjunctionResult {
    bool found = false;            // false only if both propagators failed
    double tca_min = 0.0;          // minutes from primary (a) epoch at closest approach
    double tca_utc_jd = 0.0;       // Julian Date (UTC) of closest approach
    double miss_distance_km = 0.0; // |r_a - r_b| at TCA
    double rel_speed_kms = 0.0;    // |v_a - v_b| at TCA

    Vec3 pos_a_km, vel_a_kms;      // primary state at TCA
    Vec3 pos_b_km, vel_b_kms;      // secondary state at TCA

    double tsince_b_min = 0.0;     // time-since-epoch of object b at TCA
    double window_min = 0.0;       // look-ahead window actually searched
    double step_min = 0.0;         // coarse sampling step used
};

/// Find the minimum separation between two objects over [t_start_min, t_end_min]
/// (minutes from object a's epoch). A coarse scan at `step_min` is followed by
/// two refinement passes (each subdividing the surrounding interval) so the TCA
/// is resolved to well under a second without analytic derivatives. Both
/// propagators are re-initialised for every pass, which keeps the deep-space
/// (SDP4) resonance integrator strictly monotonic in tsince.
///
/// Returns false if either propagator hits a model-failure error (e.g. decay);
/// `out.found` is then false and `error` (if given) carries the code.
bool find_conjunction(const Tle& a, const Tle& b,
                      double t_start_min, double t_end_min, double step_min,
                      ConjunctionResult& out, Sgp4Error* error = nullptr);

}  // namespace starpivot

#endif  // STARPIVOT_CONJUNCTION_HPP
