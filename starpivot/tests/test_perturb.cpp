// Tests for the perturbation module.
//
// The two tests that matter most here are the ones that catch errors a human
// reviewer would not notice:
//
//   1. ZonalGravity equals the numerical gradient of the zonal potential.
//      A flipped sign in J3 or a wrong Legendre derivative is invisible in
//      the output (the orbit still looks like an orbit) but is caught
//      immediately by differentiating the potential it claims to come from.
//
//   2. The numerically integrated nodal regression and apsidal precession
//      match the closed-form J2 secular rates. This pins the *physical* sign
//      convention, not just internal consistency: the node must drift
//      westward for a prograde orbit.

#include "starpivot/perturb.hpp"

#include <cmath>
#include <cstdio>

#include <gtest/gtest.h>

namespace starpivot {
namespace {

// M_PI is not guaranteed by the standard without a feature macro; defining it
// locally keeps the test portable across MSVC / clang / gcc at strict C++17.
constexpr double kPi = 3.14159265358979323846;

// ---------------------------------------------------------------------------
// Minimal helpers, local to the test so the library API stays clean.
// ---------------------------------------------------------------------------

struct State {
    Vec3 r;
    Vec3 v;
};

Vec3 acceleration(const Vec3& r, double mu, double j2, double j3, double j4) {
    const double rn = r.norm();
    Vec3 a = r * (-mu / (rn * rn * rn));
    a += zonal_gravity(r, Vec3(0, 0, 1), mu, kRadiusEarthKm, j2, j3, j4);
    return a;
}

void rk4_step(State& s, double dt, double mu, double j2, double j3, double j4) {
    const Vec3 k1r = s.v;
    const Vec3 k1v = acceleration(s.r, mu, j2, j3, j4);

    const Vec3 r2 = s.r + k1r * (dt * 0.5);
    const Vec3 v2 = s.v + k1v * (dt * 0.5);
    const Vec3 k2r = v2;
    const Vec3 k2v = acceleration(r2, mu, j2, j3, j4);

    const Vec3 r3 = s.r + k2r * (dt * 0.5);
    const Vec3 v3 = s.v + k2v * (dt * 0.5);
    const Vec3 k3r = v3;
    const Vec3 k3v = acceleration(r3, mu, j2, j3, j4);

    const Vec3 r4 = s.r + k3r * dt;
    const Vec3 v4 = s.v + k3v * dt;
    const Vec3 k4r = v4;
    const Vec3 k4v = acceleration(r4, mu, j2, j3, j4);

    s.r += (k1r + k2r * 2.0 + k3r * 2.0 + k4r) * (dt / 6.0);
    s.v += (k1v + k2v * 2.0 + k3v * 2.0 + k4v) * (dt / 6.0);
}

struct Elements {
    double a = 0.0;
    double e = 0.0;
    double inc = 0.0;
    double raan = 0.0;
    double argp = 0.0;
};

Elements elements_of(const Vec3& r, const Vec3& v, double mu) {
    const double rn = r.norm();
    const double vn = v.norm();
    Elements el{};
    el.a = 1.0 / (2.0 / rn - vn * vn / mu);

    const Vec3 h = r.cross(v);
    const Vec3 zhat(0, 0, 1);
    const Vec3 nvec = zhat.cross(h);
    const double hn = h.norm();
    el.inc = std::acos(h.z / hn);
    el.raan = std::atan2(h.x, -h.y);

    const double rv = r.dot(v);
    const Vec3 evec = r * (vn * vn - mu / rn) - v * rv;
    const Vec3 ehat = evec * (1.0 / evec.norm());
    el.e = evec.norm() / mu;

    const Vec3 nhat = nvec * (1.0 / nvec.norm());
    const Vec3 hhat = h * (1.0 / hn);
    el.argp = std::atan2(ehat.dot(hhat.cross(nhat)), ehat.dot(nhat));
    return el;
}

/// State vector from Keplerian elements (angles in radians, a in km).
State state_from_elements(double a, double e, double inc, double raan, double argp,
                          double true_anom, double mu) {
    const double p = a * (1.0 - e * e);
    const double r_mag = p / (1.0 + e * std::cos(true_anom));
    const Vec3 r_pf(std::cos(true_anom), std::sin(true_anom), 0.0);
    const Vec3 v_pf(-std::sin(true_anom), e + std::cos(true_anom), 0.0);

    const double h = std::sqrt(mu * p);
    const Vec3 r0 = r_pf * r_mag;
    const Vec3 v0 = v_pf * (h / p);

    const double cO = std::cos(raan), sO = std::sin(raan);
    const double ci = std::cos(inc), si = std::sin(inc);
    const double cw = std::cos(argp), sw = std::sin(argp);

    // Perifocal -> ECI rotation: R3(-raan) R1(-inc) R3(-argp)
    const double m11 = cO * cw - sO * sw * ci;
    const double m12 = -cO * sw - sO * cw * ci;
    const double m21 = sO * cw + cO * sw * ci;
    const double m22 = -sO * sw + cO * cw * ci;
    const double m31 = sw * si;
    const double m32 = cw * si;

    State s{};
    s.r = Vec3(m11 * r0.x + m12 * r0.y, m21 * r0.x + m22 * r0.y, m31 * r0.x + m32 * r0.y);
    s.v = Vec3(m11 * v0.x + m12 * v0.y, m21 * v0.x + m22 * v0.y, m31 * v0.x + m32 * v0.y);
    return s;
}

/// Average the osculating RAAN / argp over one orbit to suppress the J2
/// short-period oscillation, which otherwise contaminates a two-point
/// finite-difference estimate of the secular rate.
struct Averaged {
    double raan;
    double argp;
    double a;
    double e;
    double inc;
};

Averaged average_over_orbit(State s, double mu, double period_s, int samples) {
    const double dt = period_s / samples;
    double sum_raan_x = 0.0, sum_raan_y = 0.0;
    double sum_argp_x = 0.0, sum_argp_y = 0.0;
    double sum_a = 0.0, sum_e = 0.0, sum_inc = 0.0;
    for (int i = 0; i < samples; ++i) {
        const Elements el = elements_of(s.r, s.v, mu);
        sum_raan_x += std::cos(el.raan);
        sum_raan_y += std::sin(el.raan);
        sum_argp_x += std::cos(el.argp);
        sum_argp_y += std::sin(el.argp);
        sum_a += el.a;
        sum_e += el.e;
        sum_inc += el.inc;
        rk4_step(s, dt, mu, kJ2, 0.0, 0.0);
    }
    Averaged out{};
    out.raan = std::atan2(sum_raan_y, sum_raan_x);
    out.argp = std::atan2(sum_argp_y, sum_argp_x);
    out.a = sum_a / samples;
    out.e = sum_e / samples;
    out.inc = sum_inc / samples;
    return out;
}

}  // namespace

// ---------------------------------------------------------------------------
// 1. Analytic gradient vs numerical gradient of the potential
// ---------------------------------------------------------------------------

TEST(Perturb, ZonalGravityMatchesGradientOfPotential) {
    const Vec3 zhat(0, 0, 1);
    // A handful of representative points, including high latitude where the
    // J3 asymmetry is strongest and the equator where J2 changes sign.
    const Vec3 probes[] = {
        Vec3(7000.0, 0.0, 0.0),
        Vec3(0.0, 7000.0, 3000.0),
        Vec3(4200.0, -1300.0, 5200.0),
        Vec3(1000.0, 2000.0, 6600.0),   // near the pole
        Vec3(-5500.0, 2500.0, -900.0),  // southern hemisphere
        Vec3(26560.0, 0.0, 100.0),      // GEO-like
    };

    for (const Vec3& r : probes) {
        const Vec3 analytic =
            zonal_gravity(r, zhat, kMuEarth, kRadiusEarthKm, kJ2, kJ3, kJ4);

        const double h = 0.05;  // km
        Vec3 fd{};
        const double* rp = &r.x;
        double* fp = &fd.x;
        for (int axis = 0; axis < 3; ++axis) {
            Vec3 rp2 = r;
            Vec3 rm2 = r;
            // Modify component `axis`.
            Vec3 plus = r, minus = r;
            if (axis == 0) { plus.x += h; minus.x -= h; }
            if (axis == 1) { plus.y += h; minus.y -= h; }
            if (axis == 2) { plus.z += h; minus.z -= h; }
            (void)rp2; (void)rm2; (void)rp; (void)fp;
            const double vp = zonal_potential(plus, zhat, kMuEarth, kRadiusEarthKm, kJ2, kJ3, kJ4);
            const double vm = zonal_potential(minus, zhat, kMuEarth, kRadiusEarthKm, kJ2, kJ3, kJ4);
            const double d = (vp - vm) / (2.0 * h);
            if (axis == 0) fd.x = d;
            if (axis == 1) fd.y = d;
            if (axis == 2) fd.z = d;
        }

        const double scale = analytic.norm();
        ASSERT_GT(scale, 0.0) << "degenerate probe point";
        const double err = (analytic - fd).norm() / scale;
        EXPECT_LT(err, 1e-6) << "at r = (" << r.x << "," << r.y << "," << r.z
                             << ") analytic=[" << analytic.x << "," << analytic.y
                             << "," << analytic.z << "] fd=[" << fd.x << ","
                             << fd.y << "," << fd.z << "]";
    }
}

// ---------------------------------------------------------------------------
// 2 & 3. Secular rates against the closed-form J2 expressions
// ---------------------------------------------------------------------------

TEST(Perturb, NodalRegressionMatchesJ2Theory) {
    const double a = 7000.0;
    const double e = 0.01;
    const double inc = 45.0 * kPi / 180.0;

    State s = state_from_elements(a, e, inc, 0.0, 0.0, 0.0, kMuEarth);
    const double n = mean_motion_from_axis(a);
    const double period = 2.0 * kPi / n;

    const double dt = 10.0;
    const int samples_per_orbit = static_cast<int>(period / dt);

    // Orbit-average at the start.
    const Averaged start = average_over_orbit(s, kMuEarth, period, samples_per_orbit);

    // Integrate 20 days, then orbit-average again.
    const int steps = static_cast<int>(20.0 * 86400.0 / dt);
    for (int i = 0; i < steps; ++i) rk4_step(s, dt, kMuEarth, kJ2, 0.0, 0.0);

    const Averaged end = average_over_orbit(s, kMuEarth, period, samples_per_orbit);

    const double elapsed = 20.0 * 86400.0;
    double d_raan = end.raan - start.raan;
    // Unwrap: the node regresses by ~5 deg/day, i.e. ~100 deg over 20 days.
    while (d_raan > kPi) d_raan -= 2.0 * kPi;
    while (d_raan < -kPi) d_raan += 2.0 * kPi;

    const double measured = d_raan / elapsed;
    const double theory = j2_node_rate(a, e, inc);

    // The node must regress (westward) for a prograde orbit.
    EXPECT_LT(measured, 0.0) << "prograde orbit must have retrograde node drift";
    const double rel = std::fabs((measured - theory) / theory);
    EXPECT_LT(rel, 0.02) << "measured " << measured << " rad/s vs theory " << theory
                         << " rad/s (rel " << rel << ")";
}

TEST(Perturb, ApsidalPrecessionMatchesJ2Theory) {
    const double a = 7000.0;
    const double e = 0.01;
    const double inc = 45.0 * kPi / 180.0;

    State s = state_from_elements(a, e, inc, 0.0, 0.0, 0.0, kMuEarth);
    const double n = mean_motion_from_axis(a);
    const double period = 2.0 * kPi / n;
    const double dt = 10.0;
    const int samples_per_orbit = static_cast<int>(period / dt);

    const Averaged start = average_over_orbit(s, kMuEarth, period, samples_per_orbit);
    const int steps = static_cast<int>(20.0 * 86400.0 / dt);
    for (int i = 0; i < steps; ++i) rk4_step(s, dt, kMuEarth, kJ2, 0.0, 0.0);
    const Averaged end = average_over_orbit(s, kMuEarth, period, samples_per_orbit);

    const double elapsed = 20.0 * 86400.0;
    double d_argp = end.argp - start.argp;
    while (d_argp > kPi) d_argp -= 2.0 * kPi;
    while (d_argp < -kPi) d_argp += 2.0 * kPi;

    const double measured = d_argp / elapsed;
    const double theory = j2_apsis_rate(a, e, inc);

    // At i = 45 deg, 5cos^2 i - 1 = 1.5 > 0 so the apsis advances.
    EXPECT_GT(measured, 0.0);
    const double rel = std::fabs((measured - theory) / theory);
    EXPECT_LT(rel, 0.02) << "measured " << measured << " vs theory " << theory;
}

TEST(Perturb, CriticalInclinationFreezesTheApsis) {
    // The critical inclination solves 5 cos^2 i - 1 = 0 -> i = 63.4349 deg.
    const double inc = std::acos(1.0 / std::sqrt(5.0));
    const double a = 7000.0;
    const double e = 0.01;

    const double theory = j2_apsis_rate(a, e, inc);
    EXPECT_NEAR(theory, 0.0, 1e-12) << "analytic apsidal rate must vanish";

    // And the integrated orbit must agree: |d(argp)| over 20 days stays at the
    // level of the short-period oscillation, not of the secular drift.
    State s = state_from_elements(a, e, inc, 0.0, 0.0, 0.0, kMuEarth);
    const double n = mean_motion_from_axis(a);
    const double period = 2.0 * kPi / n;
    const double dt = 10.0;
    const int per_orbit = static_cast<int>(period / dt);
    const Averaged start = average_over_orbit(s, kMuEarth, period, per_orbit);
    const int steps = static_cast<int>(20.0 * 86400.0 / dt);
    for (int i = 0; i < steps; ++i) rk4_step(s, dt, kMuEarth, kJ2, 0.0, 0.0);
    const Averaged end = average_over_orbit(s, kMuEarth, period, per_orbit);

    double d = end.argp - start.argp;
    while (d > kPi) d -= 2.0 * kPi;
    while (d < -kPi) d += 2.0 * kPi;
    // Compare against what the rate would have been at 45 deg (~1.9 rad).
    EXPECT_LT(std::fabs(d), 0.02) << "apsis must not drift at the critical inclination";
}

TEST(Perturb, J2DoesNotChangeEnergyOrSemiMajorAxisOnAverage) {
    // J2 is conservative, so the orbit-averaged a and e must be constant even
    // though both oscillate within an orbit. This is a cheap way to detect a
    // non-physical (non-conservative) gravity implementation.
    const double a = 7000.0, e = 0.02, inc = 60.0 * kPi / 180.0;
    State s = state_from_elements(a, e, inc, 0.0, 0.0, 0.0, kMuEarth);
    const double n = mean_motion_from_axis(a);
    const double period = 2.0 * kPi / n;
    const double dt = 10.0;
    const int per_orbit = static_cast<int>(period / dt);

    const Averaged start = average_over_orbit(s, kMuEarth, period, per_orbit);
    const int steps = static_cast<int>(30.0 * 86400.0 / dt);
    for (int i = 0; i < steps; ++i) rk4_step(s, dt, kMuEarth, kJ2, 0.0, 0.0);
    const Averaged end = average_over_orbit(s, kMuEarth, period, per_orbit);

    EXPECT_NEAR(end.a, start.a, 1.0) << "orbit-averaged a must not drift under J2";
    EXPECT_NEAR(end.e, start.e, 1e-3);
    EXPECT_NEAR(end.inc, start.inc, 1e-4);
}

// ---------------------------------------------------------------------------
// 4. Atmosphere and drag
// ---------------------------------------------------------------------------

TEST(Perturb, AtmosphereModelIsContinuousAtLayerBoundaries) {
    // The earlier version of this model tabulated rho0 and H independently and
    // had a factor-of-2.4 upward jump at 200 km. This test exists so that class
    // of bug cannot come back.
    // The topmost anchor (1000 km) is excluded: above it the model is defined
    // to return zero because the exponential fit has no validity there, and
    // that cutoff is asserted separately rather than treated as a jump.
    const double anchors[] = {25.0, 50.0, 100.0, 150.0, 200.0, 300.0, 400.0,
                              500.0, 600.0, 700.0, 800.0, 900.0};
    const double eps = 1e-6;
    for (double h : anchors) {
        const double below = atmosphere_density(h - eps);
        const double above = atmosphere_density(h + eps);
        EXPECT_NEAR(below, above, below * 1e-4)
            << "density discontinuity at " << h << " km: " << below << " vs " << above;
    }
    EXPECT_GT(atmosphere_density(1000.0), 0.0);
    EXPECT_EQ(atmosphere_density(1000.001), 0.0) << "deliberate model cutoff";
}

TEST(Perturb, AtmosphereDensityIsMonotoneAndPhysical) {
    double prev = 1e300;
    for (double alt = 0.0; alt <= 900.0; alt += 25.0) {
        const double rho = atmosphere_density(alt);
        EXPECT_GT(rho, 0.0) << "at " << alt << " km";
        EXPECT_LT(rho, prev) << "density must decrease with altitude at " << alt;
        prev = rho;
    }
    EXPECT_GT(atmosphere_density(1000.0), 0.0);
    EXPECT_EQ(atmosphere_density(1500.0), 0.0) << "no model above 1000 km";

    // Sanity magnitudes against the US Standard Atmosphere.
    EXPECT_NEAR(atmosphere_density(0.0), 1.225, 0.01);
    // At 400 km the accepted value is ~1e-12 kg/m^3 within a factor of a few.
    const double r400 = atmosphere_density(400.0);
    EXPECT_GT(r400, 1e-13);
    EXPECT_LT(r400, 1e-11);
}

TEST(Perturb, DragDecaysTheOrbitAndCircularisesIt) {
    const double a0 = 6800.0;
    const double e0 = 0.01;
    const double inc = 51.6 * kPi / 180.0;  // ISS-like
    const Spacecraft sc{};                    // 1000 kg, 10 m^2, Cd 2.2
    const double omega = 7.292115e-5;

    State s = state_from_elements(a0, e0, inc, 0.0, 0.0, 0.0, kMuEarth);

    auto acc = [&](const Vec3& r, const Vec3& v) {
        Vec3 a = r * (-kMuEarth / std::pow(r.norm(), 3));
        a += zonal_gravity_earth(r);
        a += drag_acceleration(r, v, Vec3(0, 0, 1), sc, omega);
        return a;
    };

    // 30 days at 30 s steps.
    const double dt = 30.0;
    const int steps = static_cast<int>(30.0 * 86400.0 / dt);
    for (int i = 0; i < steps; ++i) {
        const Vec3 k1r = s.v, k1v = acc(s.r, s.v);
        const Vec3 k2r = s.v + k1v * (dt * 0.5);
        const Vec3 k2v = acc(s.r + k1r * (dt * 0.5), s.v + k1v * (dt * 0.5));
        const Vec3 k3r = s.v + k2v * (dt * 0.5);
        const Vec3 k3v = acc(s.r + k2r * (dt * 0.5), s.v + k2v * (dt * 0.5));
        const Vec3 k4r = s.v + k3v * dt;
        const Vec3 k4v = acc(s.r + k3r * dt, s.v + k3v * dt);
        s.r += (k1r + k2r * 2.0 + k3r * 2.0 + k4r) * (dt / 6.0);
        s.v += (k1v + k2v * 2.0 + k3v * 2.0 + k4v) * (dt / 6.0);
    }

    const Elements el = elements_of(s.r, s.v, kMuEarth);
    EXPECT_LT(el.a, a0) << "drag must lower the semi-major axis";
    // At ~420 km altitude with A/m = 0.01 m^2/kg the decay is metres per day,
    // so over 30 days we expect a drop of order 0.1-10 km, not 1000 km.
    EXPECT_GT(el.a, a0 - 500.0) << "decay must be physically plausible, not runaway";
    EXPECT_LE(el.e, e0 + 1e-6) << "drag reduces eccentricity";
}

// ---------------------------------------------------------------------------
// 5. Shadow and SRP
// ---------------------------------------------------------------------------

TEST(Perturb, ShadowFunctionDetectsEclipse) {
    const Vec3 r_sun(kAuKm, 0.0, 0.0);

    // Noon: satellite between Earth and Sun -> lit.
    EXPECT_DOUBLE_EQ(shadow_factor(Vec3(7000.0, 0.0, 0.0), r_sun), 1.0);
    // Midnight: satellite on the far side, inside the shadow cylinder.
    EXPECT_DOUBLE_EQ(shadow_factor(Vec3(-7000.0, 0.0, 0.0), r_sun), 0.0);
    // Off axis by more than one Earth radius -> still lit.
    EXPECT_DOUBLE_EQ(shadow_factor(Vec3(-7000.0, 7000.0, 0.0), r_sun), 1.0);
}

TEST(Perturb, SrpMagnitudeIsPhysical) {
    const Spacecraft sc{};  // A/m = 0.01 m^2/kg, Cr = 1.3
    const Vec3 r(7000.0, 0.0, 0.0);
    const Vec3 r_sun(kAuKm, 0.0, 0.0);
    const Vec3 a = srp_acceleration(r, r_sun, sc);
    const double mag = a.norm();
    // a = P Cr (A/m) ~ 4.56e-6 * 1.3 * 0.01 = 5.9e-8 m/s^2 = 5.9e-11 km/s^2.
    EXPECT_NEAR(mag, 5.93e-11, 5e-12) << "SRP acceleration magnitude";
    // SRP pushes away from the Sun.
    EXPECT_LT(a.x, 0.0);
}

}  // namespace starpivot
