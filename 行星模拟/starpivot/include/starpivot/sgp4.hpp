// starpivot — SGP4 / SDP4, the NORAD general perturbation propagator.
//
// Why this exists
// ---------------
// TLEs (two-line element sets) are the interchange format of the entire
// space-operations industry: every tracking catalogue, every conjunction
// assessment, every ground-station pass schedule is expressed in them. A
// product in this domain that cannot read a TLE cannot be integrated into
// any real workflow.
//
// What this implements
// --------------------
// The algorithm of Hoots & Roehrich, *Spacetrack Report #3* (1980), with the
// corrections and the reference verification data published in
//   Vallado, Crawford, Hujsak & Kelso, "Revisiting Spacetrack Report #3",
//   AIAA 2006-6753 Rev 1.
// The coefficient formulas follow that specification; this is an independent
// implementation written against the published algorithm, not a copy of
// somebody else's source file.
//
// Acceptance criterion (non-negotiable)
// ------------------------------------
// `tests/test_sgp4.cpp` checks every available official test vector from
// Appendix D of AIAA 2006-6753, which are archived verbatim in
// docs/sgp4-vectors.md. Position and velocity must match to < 1e-8 relative
// in every component. If they do not, this module is NOT correct and must not
// be described as supporting TLEs.
//
// Units and conventions
// ---------------------
//   input TLE angles      degrees
//   internal angles       radians
//   internal time         minutes
//   internal length       Earth radii (WGS72 Re = 6378.135 km)
//   output                km and km/s, TEME frame
//   gravity constants     WGS72 (mu = 398600.8, NOT EGM96 398600.4418)
//
// Reusing the WGS72 constants is mandatory, not pedantry: SGP4 is *defined*
// against them and the published vectors were generated with them. Swapping in
// a modern geopotential silently degrades agreement by metres.
//
// Statefulness: the deep-space resonance integrator carries `atime`, `xli`,
// `xni` between calls. Propagate requests must therefore be issued in
// monotonically increasing `tsince` after a single init; re-init to restart.

#ifndef STARPIVOT_SGP4_HPP
#define STARPIVOT_SGP4_HPP

#include <string>

#include "starpivot/vec3.hpp"

namespace starpivot {

// ---------------------------------------------------------------------------
// Parsed two-line element set
// ---------------------------------------------------------------------------

struct Tle {
    int satnum = 0;
    std::string intl_designator;

    int epoch_year = 0;    // two-digit year as printed
    double epoch_day = 0.0;  // day-of-year plus fractional day
    double epoch_jd = 0.0;   // UTC Julian Date of the epoch
    double jdsatepoch = 0.0; // days since 1949-12-31 00:00 UT (SGP4 epoch base)

    double ndot = 0.0;   // rad/min^2  (half the first derivative)
    double nddot = 0.0;  // rad/min^3  (one sixth the second derivative)
    double bstar = 0.0;  // drag term, 1/Earth-radii

    double inclo = 0.0;     // rad
    double nodeo = 0.0;     // rad, right ascension of ascending node
    double ecco = 0.0;      // dimensionless
    double argpo = 0.0;     // rad
    double mo = 0.0;        // rad, mean anomaly
    double no_kozai = 0.0;  // rad/min, Kozai mean motion

    int element_number = 0;
};

/// Parse a two-line element set. Tolerates a missing international designator
/// and the exponent-without-E notation (e.g. "28098-4" for 2.8098e-4).
/// Returns false with a message on any structural problem.
bool parse_tle(const std::string& line1, const std::string& line2, Tle& out,
               std::string* error = nullptr);

// ---------------------------------------------------------------------------
// Propagator state
// ---------------------------------------------------------------------------

struct Sgp4 {
    // --- WGS72 constants, pinned because the model is defined against them ---
    double radiusearthkm = 6378.135;
    double xke = 0.0743669161331734132;  // reciprocal of tumin; full published precision
    double tumin = 0.0;          // = 1/xke, minutes in one canonical time unit
    double vkmpersec = 0.0;      // = Re * xke / 60, [km/s] per [ER/TU]
    double j2 = 0.001082616;
    double j3 = -0.00000253881;
    double j4 = -0.00000165597;
    double j3oj2 = 0.0;

    // --- inputs echoed ---
    double bstar = 0.0, ndot = 0.0, nddot = 0.0;
    double ecco = 0.0, argpo = 0.0, inclo = 0.0, mo = 0.0, nodeo = 0.0;
    double no_kozai = 0.0;
    double epoch = 0.0;   // days since 1949-12-31 00:00 UT

    // --- classification ---
    char method = 'n';   // 'n' near earth (SGP4), 'd' deep space (SDP4)
    bool isimp = false;  // perigee < 220 km: truncated drag series

    // --- derived at init ---
    double no_unkozai = 0.0, ao = 0.0, con41 = 0.0, gsto = 0.0;
    double ainv = 0.0, con42 = 0.0, cosio = 0.0, cosio2 = 0.0;
    double eccsq = 0.0, omeosq = 0.0, posq = 0.0, rp = 0.0, rteosq = 0.0, sinio = 0.0;

    // secular rates and drag coefficients
    double mdot = 0.0, argpdot = 0.0, nodedot = 0.0, nodecf = 0.0;
    double cc1 = 0.0, cc4 = 0.0, cc5 = 0.0;
    double d2 = 0.0, d3 = 0.0, d4 = 0.0;
    double t2cof = 0.0, t3cof = 0.0, t4cof = 0.0, t5cof = 0.0;
    double omgcof = 0.0, xmcof = 0.0, delmo = 0.0, sinmao = 0.0;
    double eta = 0.0, aycof = 0.0, xlcof = 0.0;
    double x1mth2 = 0.0, x7thm1 = 0.0;

    // --- deep space (SDP4) ---
    double e3 = 0.0, ee2 = 0.0;
    double peo = 0.0, pgho = 0.0, pho = 0.0, pinco = 0.0, plo = 0.0;
    double se2 = 0.0, se3 = 0.0;
    double sgh2 = 0.0, sgh3 = 0.0, sgh4 = 0.0;
    double sh2 = 0.0, sh3 = 0.0;
    double si2 = 0.0, si3 = 0.0;
    double sl2 = 0.0, sl3 = 0.0, sl4 = 0.0;
    double xgh2 = 0.0, xgh3 = 0.0, xgh4 = 0.0;
    double xh2 = 0.0, xh3 = 0.0;
    double xi2 = 0.0, xi3 = 0.0;
    double xl2 = 0.0, xl3 = 0.0, xl4 = 0.0;
    double zmol = 0.0, zmos = 0.0;

    int irez = 0;
    double d2201 = 0.0, d2211 = 0.0, d3210 = 0.0, d3222 = 0.0;
    double d4410 = 0.0, d4422 = 0.0, d5220 = 0.0, d5232 = 0.0;
    double d5421 = 0.0, d5433 = 0.0;
    double dedt = 0.0, didt = 0.0, dmdt = 0.0, dnodt = 0.0, domdt = 0.0;
    double dndt = 0.0;  // mean-motion correction from the resonance integrator
    double del1 = 0.0, del2 = 0.0, del3 = 0.0;
    double xfact = 0.0, xlamo = 0.0, xli = 0.0, xni = 0.0, atime = 0.0;

    // --- mutable propagation state ---
    double t = 0.0;          // minutes since epoch, set by propagate
    bool initialised = false;
};

/// Error codes reported by the propagator.
enum class Sgp4Error {
    kOk = 0,
    kEccentricityOutOfRange = 1,  // em >= 1 or em < -0.001
    kMeanMotionNonPositive = 2,   // nm <= 0
    kPerturbedEccentricity = 3,   // ep outside [0,1]
    kSemiLatusRectumNegative = 4, // pl < 0
    kDecayed = 6,                 // mrt < 1 Earth radius
};

/// Initialise from a parsed TLE. Must be called before any propagation.
bool sgp4_init(Sgp4& s, const Tle& tle);

/// Propagate `tsince` minutes from epoch. Writes TEME position [km] and
/// velocity [km/s]. Returns false and sets `error` on a model failure; the
/// reference model deliberately fails loudly for decaying objects rather than
/// returning a position inside the Earth.
bool sgp4_propagate(Sgp4& s, double tsince, Vec3& r_km, Vec3& v_km_s,
                    Sgp4Error* error = nullptr);

const char* sgp4_error_string(Sgp4Error e);

}  // namespace starpivot

#endif  // STARPIVOT_SGP4_HPP
