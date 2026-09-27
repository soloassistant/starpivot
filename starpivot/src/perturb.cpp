// Non-spherical gravity, drag and SRP. See perturb.hpp for the model list and
// the accuracy floor of each.

#include "starpivot/perturb.hpp"

#include <array>
#include <cmath>

namespace starpivot {
namespace {

// US Standard Atmosphere 1976, mid-latitude mean.
//
// Only the ANCHOR densities are tabulated; the scale height of each segment is
// derived from the ratio of consecutive anchors:
//     H_i = (h_{i+1} - h_i) / ln(rho_i / rho_{i+1})
//
// Why derive rather than tabulate both: a table carrying independent rho0 and
// H columns is only correct if the two happen to agree, and if they do not the
// model has a discontinuous jump at every layer boundary. A first version of
// this file had exactly that bug -- density jumped UP by a factor of 2.4 at
// 200 km, which a monotone test caught immediately. Deriving H from the
// anchors makes continuity true by construction.
struct AtmAnchor {
    double h_km;
    double rho;  // kg/m^3
};

const std::array<AtmAnchor, 14>& atmosphere_anchors() {
    static const std::array<AtmAnchor, 14> a = {{
        {0.0, 1.225},
        {25.0, 3.899e-2},
        {50.0, 1.057e-3},
        {100.0, 5.604e-7},
        {150.0, 2.070e-9},
        {200.0, 2.541e-10},
        {300.0, 1.916e-11},
        {400.0, 2.803e-12},
        {500.0, 6.967e-13},
        {600.0, 1.454e-13},
        {700.0, 3.614e-14},
        {800.0, 1.170e-14},
        {900.0, 5.245e-15},
        {1000.0, 3.019e-15},
    }};
    return a;
}

double scale_height_for(std::size_t i) {
    const auto& a = atmosphere_anchors();
    if (i + 1 >= a.size()) return 100.0;  // unused: no segment above the top
    const double dh = a[i + 1].h_km - a[i].h_km;
    return dh / std::log(a[i].rho / a[i + 1].rho);
}

}  // namespace

double area_to_mass(const Spacecraft& sc) { return sc.area_m2 / sc.mass_kg; }

double mean_motion_from_axis(double a_km, double mu) { return std::sqrt(mu / (a_km * a_km * a_km)); }

// ---------------------------------------------------------------------------
// Zonal gravity
// ---------------------------------------------------------------------------

// Legendre polynomials P2..P4 and their derivatives, in s = sin(lat).
namespace legendre {
double p2(double s) { return 0.5 * (3.0 * s * s - 1.0); }
double dp2(double s) { return 3.0 * s; }
double p3(double s) { return 0.5 * (5.0 * s * s * s - 3.0 * s); }
double dp3(double s) { return 0.5 * (15.0 * s * s - 3.0); }
double p4(double s) { return (35.0 * s * s * s * s - 30.0 * s * s + 3.0) / 8.0; }
double dp4(double s) { return 0.5 * (35.0 * s * s * s - 15.0 * s); }
}  // namespace legendre

double zonal_potential(const Vec3& r, const Vec3& zhat, double mu, double re,
                       double j2, double j3, double j4) {
    const double rn = r.norm();
    if (rn <= 0.0) return 0.0;
    const double s = r.dot(zhat) / rn;

    double sum = 0.0;
    const double q = re / rn;
    sum += j2 * q * q * legendre::p2(s);
    sum += j3 * q * q * q * legendre::p3(s);
    sum += j4 * q * q * q * q * legendre::p4(s);
    return -(mu / rn) * sum;
}

Vec3 zonal_gravity(const Vec3& r, const Vec3& zhat, double mu, double re,
                   double j2, double j3, double j4) {
    const double rn = r.norm();
    if (rn <= 0.0) return Vec3{};

    const Vec3 rhat = r / rn;
    const double s = rhat.dot(zhat);
    const double q = re / rn;
    const double base = -(mu / (rn * rn));

    // a = base * sum_n Jn q^n [ (-(n+1) Pn - s Pn') rhat + Pn' zhat ]
    Vec3 acc{};

    const double c2 = j2 * q * q;
    acc += rhat * (c2 * (-3.0 * legendre::p2(s) - s * legendre::dp2(s)));
    acc += zhat * (c2 * legendre::dp2(s));

    const double c3 = j3 * q * q * q;
    acc += rhat * (c3 * (-4.0 * legendre::p3(s) - s * legendre::dp3(s)));
    acc += zhat * (c3 * legendre::dp3(s));

    const double c4 = j4 * q * q * q * q;
    acc += rhat * (c4 * (-5.0 * legendre::p4(s) - s * legendre::dp4(s)));
    acc += zhat * (c4 * legendre::dp4(s));

    return acc * base;
}

Vec3 zonal_gravity_earth(const Vec3& r) {
    return zonal_gravity(r, Vec3(0.0, 0.0, 1.0), kMuEarth, kRadiusEarthKm, kJ2, kJ3, kJ4);
}

// ---------------------------------------------------------------------------
// Atmosphere
// ---------------------------------------------------------------------------

double atmosphere_density(double alt_km) {
    const auto& a = atmosphere_anchors();
    if (alt_km <= a.front().h_km) return a.front().rho;
    if (alt_km > a.back().h_km) return 0.0;

    // Highest anchor not above alt_km.
    std::size_t k = 0;
    for (std::size_t i = 0; i < a.size(); ++i) {
        if (alt_km >= a[i].h_km) k = i;
    }
    return a[k].rho * std::exp(-(alt_km - a[k].h_km) / scale_height_for(k));
}

// ---------------------------------------------------------------------------
// Drag
// ---------------------------------------------------------------------------

Vec3 drag_acceleration(const Vec3& r, const Vec3& v_inertial, const Vec3& zhat,
                       const Spacecraft& sc, double omega_earth) {
    const double alt = r.norm() - kRadiusEarthKm;
    const double rho = atmosphere_density(alt);
    if (rho <= 0.0) return Vec3{};

    // Atmosphere co-rotates: v_rel = v_inertial - omega x r.
    const Vec3 v_atm = zhat.cross(r) * omega_earth;
    const Vec3 v_rel = v_inertial - v_atm;
    const double vrel = v_rel.norm();
    if (vrel <= 0.0) return Vec3{};

    // a = -0.5 * Cd * (A/m) * rho * |v_rel| * v_rel.
    // rho [kg/m^3] * A [m^2] / m [kg] -> [1/m]; |v|*v [km^2/s^2] must be
    // converted: 1 km^2/s^2 per (1/m) = 1e3 m/s^2 -> km/s^2 needs /1e3... we
    // compute in metres then convert the result to km/s^2.
    const double vrel_ms = vrel * 1e3;
    const double a_ms2 = 0.5 * sc.cd * area_to_mass(sc) * rho * vrel_ms * vrel_ms;
    const double a_kms2 = a_ms2 * 1e-3;
    return v_rel * (-a_kms2 / vrel);
}

// ---------------------------------------------------------------------------
// Solar radiation pressure
// ---------------------------------------------------------------------------

double shadow_factor(const Vec3& r, const Vec3& r_sun) {
    // Conical (cylindrical) shadow: project r onto the anti-sun direction.
    const double rs = r_sun.norm();
    if (rs <= 0.0) return 1.0;
    const Vec3 sun_dir = r_sun / rs;

    // Component of r along the sun direction. If negative, we are on the
    // anti-sun side and may be eclipsed.
    const double along = r.dot(sun_dir);
    if (along > 0.0) return 1.0;

    // Perpendicular distance from the shadow axis.
    const Vec3 perp = r - sun_dir * along;
    if (perp.norm() >= kRadiusEarthKm) return 1.0;
    return 0.0;
}

Vec3 srp_acceleration(const Vec3& r, const Vec3& r_sun, const Spacecraft& sc) {
    const double nu = shadow_factor(r, r_sun);
    if (nu <= 0.0) return Vec3{};

    const Vec3 d = r_sun - r;
    const double dn = d.norm();
    if (dn <= 0.0) return Vec3{};

    // a = P_AU * Cr * (A/m) * (AU/|d|)^2 * unit(r - r_sun)
    //   = P_AU * Cr * (A/m) * AU^2 * (r - r_sun) / |r - r_sun|^3
    //
    // P [N/m^2] * (A/m) [m^2/kg] -> m/s^2; AU^2/d^3 * (r - r_sun) is
    // dimensionless as long as both are in km; 1e-3 converts m/s^2 -> km/s^2.
    const double p_ms2 = kSolarPressureNm2 * sc.cr * area_to_mass(sc);
    const double geom = kAuKm * kAuKm / (dn * dn * dn);  // [1/km]
    // d = r_sun - r, so -d = r - r_sun.
    return d * (-p_ms2 * geom * 1e-3);
}

// ---------------------------------------------------------------------------
// Analytic secular rates
// ---------------------------------------------------------------------------

double j2_node_rate(double a_km, double e, double inc_rad) {
    const double n = mean_motion_from_axis(a_km);
    const double p = kRadiusEarthKm / a_km;
    const double f = 1.0 - e * e;
    return -1.5 * n * kJ2 * p * p * std::cos(inc_rad) / (f * f);
}

double j2_apsis_rate(double a_km, double e, double inc_rad) {
    const double n = mean_motion_from_axis(a_km);
    const double p = kRadiusEarthKm / a_km;
    const double f = 1.0 - e * e;
    const double ci = std::cos(inc_rad);
    return 0.75 * n * kJ2 * p * p * (5.0 * ci * ci - 1.0) / (f * f);
}

}  // namespace starpivot
