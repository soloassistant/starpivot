// starpivot — non-spherical gravity, atmospheric drag and solar radiation
// pressure for Earth-orbiting spacecraft.
//
// Why this module exists
// ----------------------
// The N-body kernel treats planets as point masses. For a LEO satellite that
// approximation is wrong by kilometres per day: Earth's oblateness (J2) alone
// rotates the orbital plane by ~5 deg/day at 500 km, and drag removes tens of
// metres of altitude per day. A propagator that claims operational relevance
// without these terms is not a propagator, it is a Keplerian drawing.
//
// Units: kilometres, kilograms, seconds (NOT the AU/Msun/yr system used by the
// N-body kernel). Mixing the two is a bug; convert explicitly at the boundary.
//
// Models implemented, with their honest accuracy floor:
//   J2, J3, J4   full non-spherical gravity to degree 4 (zonal only).
//                Neglected: all tesseral/sectoral terms (the 20x20 field),
//                which contribute metres to tens of metres.
//   Drag         US Standard Atmosphere exponential fit, cannonball Cd,
//                co-rotating atmosphere. Neglected: density variability from
//                solar/EUV activity, which is a factor-of-2 effect at 500 km
//                across the solar cycle. This is the dominant error source for
//                LEO and no amount of integrator accuracy fixes it.
//   SRP          Cannonball with a conical (cylindrical) shadow model.
//                Neglected: Earth's penumbra, albedo, thermal re-radiation.

#ifndef STARPIVOT_PERTURB_HPP
#define STARPIVOT_PERTURB_HPP

#include "starpivot/vec3.hpp"

namespace starpivot {

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Earth gravitational parameter [km^3/s^2] (EGM96).
constexpr double kMuEarth = 398600.4418;

/// Earth equatorial radius [km] (EGM96).
constexpr double kRadiusEarthKm = 6378.1363;

/// Zonal harmonics. J2 dominates by three orders of magnitude.
constexpr double kJ2 = 1.0826269e-3;
constexpr double kJ3 = -2.5327e-6;
constexpr double kJ4 = -1.6196e-6;

/// Solar radiation pressure at 1 AU [N/m^2] -> expressed in km-kg-s as
/// [km * kg / (s^2 * m^2)] is awkward; we carry it as N/m^2 and let the caller
/// supply area in m^2 with mass in kg, converting the result to km/s^2.
constexpr double kSolarPressureNm2 = 4.5605e-6;

/// One astronomical unit [km].
constexpr double kAuKm = 1.495978707e8;

// ---------------------------------------------------------------------------
// Spacecraft physical description
// ---------------------------------------------------------------------------

struct Spacecraft {
    double mass_kg = 1000.0;       // dry mass [kg]
    double area_m2 = 10.0;         // cross-sectional area [m^2]
    double cd = 2.2;               // drag coefficient, dimensionless
    double cr = 1.3;               // reflectivity coefficient, dimensionless
};

/// Area-to-mass ratio [m^2/kg].
double area_to_mass(const Spacecraft& sc);

// ---------------------------------------------------------------------------
// Non-spherical gravity
// ---------------------------------------------------------------------------

/// Disturbing potential of the zonal harmonics [km^2/s^2]:
///   dV = -(mu/r) * sum_n Jn (Re/r)^n Pn(sin(lat)),  n = 2,3,4
/// with sin(lat) = (r . zhat) / |r|.
///
/// Exposed because it is the *definition* the acceleration is derived from,
/// and because the test suite differentiates it numerically to prove the
/// analytic gradient below has the right signs. Getting a J3 sign wrong is
/// easy and silent; differentiating the potential catches it immediately.
double zonal_potential(const Vec3& r, const Vec3& zhat, double mu, double re,
                       double j2, double j3, double j4);

/// Analytic gradient d/dr of zonal_potential, i.e. the perturbing
/// acceleration [km/s^2] from J2..J4. `zhat` is the rotation axis (unit).
///
/// Derived form (Pn' = dPn/ds, s = sin(lat)):
///   a = -(mu/r^2) sum_n Jn (Re/r)^n [ (-(n+1) Pn - s Pn') rhat + Pn' zhat ]
///
/// The J2 part reduces to the familiar
///   a = -(3/2) J2 (mu/r^2) (Re/r)^2 [ (1 - 5 s^2) rhat + 2 s zhat ]
/// which produces retrograde nodal regression for prograde orbits; that sign
/// is pinned down against the analytic secular rate in the tests, not just
/// against the derivation.
Vec3 zonal_gravity(const Vec3& r, const Vec3& zhat, double mu, double re,
                   double j2, double j3, double j4);

/// Convenience overload using the EGM96 Earth defaults and the IERS pole
/// (taken as +z; callers needing sub-km accuracy over decades must supply the
/// actual precessing pole via starpivot::spin).
Vec3 zonal_gravity_earth(const Vec3& r);

// ---------------------------------------------------------------------------
// Atmospheric density
// ---------------------------------------------------------------------------

/// Exponential-fit density [kg/m^3] at altitude `alt_km` [km].
///
/// Base altitudes/densities/scale heights follow the US Standard Atmosphere
/// 1976 tabulation as fitted by Vallado (Table 8-4). Returns 0 above 1000 km,
/// where the model is meaningless.
///
/// Honest caveat: the real thermosphere varies by a factor of ~2 at 500 km
/// between solar minimum and maximum. This function returns the *mean* and
/// carries no solar-activity input, so drag-driven lifetime estimates are
/// accurate to roughly a factor of two. Treat them as planning numbers, not
/// as predictions.
double atmosphere_density(double alt_km);

// ---------------------------------------------------------------------------
// Drag
// ---------------------------------------------------------------------------

/// Atmospheric drag acceleration [km/s^2].
///
/// `v_inertial` is the inertial velocity [km/s]. The atmosphere is assumed to
/// co-rotate with the Earth at `omega_earth` [rad/s] about `zhat`, which is
/// what makes drag do net work and circularise the orbit.
Vec3 drag_acceleration(const Vec3& r, const Vec3& v_inertial, const Vec3& zhat,
                       const Spacecraft& sc, double omega_earth);

// ---------------------------------------------------------------------------
// Solar radiation pressure
// ---------------------------------------------------------------------------

/// Fraction of the spacecraft illuminated by the Sun, 1 = full sun.
/// Conical shadow model: Earth casts a cylinder of radius Re anti-sunward.
/// Does not model the penumbra, so the eclipse transition is a step.
double shadow_factor(const Vec3& r, const Vec3& r_sun);

/// Solar radiation pressure acceleration [km/s^2]. `r_sun` is the Sun's
/// geocentric position [km]. Returns zero in eclipse.
Vec3 srp_acceleration(const Vec3& r, const Vec3& r_sun, const Spacecraft& sc);

// ---------------------------------------------------------------------------
// Analytic secular rates (used as independent test oracles)
// ---------------------------------------------------------------------------

/// J2 secular nodal regression [rad/s]:
///   dRAAN/dt = -1.5 n J2 (Re/a)^2 cos(i) / (1-e^2)^2
/// Negative for prograde orbits (i < 90 deg): the node drifts westward.
double j2_node_rate(double a_km, double e, double inc_rad);

/// J2 secular apsidal precession [rad/s]:
///   dargp/dt = 0.75 n J2 (Re/a)^2 (5 cos^2 i - 1) / (1-e^2)^2
/// Zero at the critical inclination 63.43 deg (and 116.57 deg).
double j2_apsis_rate(double a_km, double e, double inc_rad);

/// Mean motion [rad/s] from semi-major axis [km].
double mean_motion_from_axis(double a_km, double mu = kMuEarth);

}  // namespace starpivot

#endif  // STARPIVOT_PERTURB_HPP
