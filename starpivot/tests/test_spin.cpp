// Spin / attitude verification.
//
// The translational kernel cannot produce an obliquity, so nothing in
// tests/test_two_body.cpp would notice if this module were entirely wrong.
// These tests exist to make the "attitude" in "planetary attitude platform"
// mean something.
//
// The strongest check here is PrecessionRateMatchesAnalytics: integrate the
// spin axis under the real, time-varying solar torque and compare the measured
// precession rate against the closed-form rate of precession theory. Two
// independent derivations of the same number, one numeric and one analytic.

#include <cmath>

#include <gtest/gtest.h>

#include "starpivot/constants.hpp"
#include "starpivot/elements.hpp"
#include "starpivot/spin.hpp"
#include "starpivot/vec3.hpp"

namespace starpivot {
namespace {

constexpr double kObliquityDeg = 23.44;
constexpr double kEarthRadiusAU = 4.2635e-5;  // 6371 km in AU

SpinBody make_earth() {
    const double M = mass::EARTH;
    const double R2 = kEarthRadiusAU * kEarthRadiusAU;
    SpinBody b;
    b.id = "earth";
    b.mass = M;
    b.C = 0.3308 * M * R2;
    b.A = 0.3297 * M * R2;
    b.spin_rate = kTwoPi * 365.25;  // one rotation per sidereal-ish day, per yr
    b.position = Vec3{};
    const double eps = kObliquityDeg * kPi / 180.0;
    b.spin_axis = Vec3(std::sin(eps), 0.0, std::cos(eps));
    return b;
}

/// Mean obliquity of the axis to the Z axis, in degrees.
double obliquity_deg(const Vec3& n) {
    return std::acos(std::fmin(1.0, std::fmax(-1.0, n.z))) * 180.0 / kPi;
}

/// Azimuth of the axis around Z, in radians.
double azimuth(const Vec3& n) {
    return std::atan2(n.y, n.x);
}

}  // namespace

TEST(Spin, TorqueFreeAxisIsStationary) {
    // With no external perturber the spin axis must not move, and both
    // invariants of free rotation must be preserved.
    SpinBody b = make_earth();
    const Vec3 n0 = b.spin_axis;
    const Vec3 L0 = angular_momentum(b);
    const double T0 = rotational_energy(b);

    for (int i = 0; i < 10000; ++i) {
        advance_spin_axis(b, 0.001, [](const SpinBody&) { return Vec3{}; });
    }

    EXPECT_LT((b.spin_axis - n0).norm(), 1e-14);
    EXPECT_LT((angular_momentum(b) - L0).norm() / L0.norm(), 1e-14);
    EXPECT_LT(std::fabs(rotational_energy(b) - T0) / T0, 1e-14);
}

TEST(Spin, ObliquityIsPreservedUnderPurePrecession) {
    // Precession sweeps the axis around the ecliptic pole at CONSTANT
    // obliquity. If the torque were wrong this would show up as a drift in
    // obliquity, which is the single most diagnostic failure mode.
    SpinBody b = make_earth();
    const double mu_sun = units::G_AU_MSUN_YR;
    const double n_orb = kTwoPi;  // 1 yr period at 1 AU
    const double eps0 = obliquity_deg(b.spin_axis);

    // Integrate for 200 yr with the perturber moving on its orbit.
    const double dt = 2.0e-4;
    const int steps = static_cast<int>(200.0 / dt);
    double t = 0.0;
    for (int i = 0; i < steps; ++i) {
        const Vec3 r_sun(std::cos(n_orb * t), std::sin(n_orb * t), 0.0);
        advance_spin_axis(b, dt, [&](const SpinBody& s) {
            return gradient_torque(s, mu_sun, r_sun);
        });
        t += dt;
    }

    const double eps1 = obliquity_deg(b.spin_axis);
    EXPECT_NEAR(eps1, eps0, 1e-3) << "obliquity drifted: " << eps0 << " -> " << eps1;
}

TEST(Spin, PrecessionRateMatchesAnalytics) {
    // THE key test: numeric integration of the real time-varying torque versus
    // the closed-form precession rate.
    SpinBody b = make_earth();
    const double mu_sun = units::G_AU_MSUN_YR;
    const double n_orb = kTwoPi;
    const double eps = kObliquityDeg * kPi / 180.0;

    const double expected =
        analytic_precession_rate(b, mu_sun, 1.0, eps);

    const double dt = 2.0e-4;
    const double years = 200.0;
    const int steps = static_cast<int>(years / dt);
    double t = 0.0;

    // Unwrap the azimuth so the total swept angle is measured, not just the
    // principal value.
    double prev = azimuth(b.spin_axis);
    double total = 0.0;

    for (int i = 0; i < steps; ++i) {
        const Vec3 r_sun(std::cos(n_orb * t), std::sin(n_orb * t), 0.0);
        advance_spin_axis(b, dt, [&](const SpinBody& s) {
            return gradient_torque(s, mu_sun, r_sun);
        });
        t += dt;

        const double cur = azimuth(b.spin_axis);
        double d = cur - prev;
        while (d > kPi) d -= kTwoPi;
        while (d < -kPi) d += kTwoPi;
        total += d;
        prev = cur;
    }

    const double measured = total / years;

    EXPECT_LT(std::fabs(measured - expected) / std::fabs(expected), 5e-3)
        << "measured psidot " << measured << " vs analytic " << expected;
    // Sign: precession must be retrograde.
    EXPECT_LT(measured, 0.0) << "precession came out prograde";
    EXPECT_LT(expected, 0.0);
}

TEST(Spin, PrecessionPeriodIsInTheRightBallpark) {
    // Solar torque alone gives a precession period near 8e4 yr. The observed
    // value (25772 yr) is shorter because the Moon contributes about twice as
    // much again. This test pins the solar-only number and documents why it is
    // not compared against the IAU figure.
    SpinBody b = make_earth();
    const double eps = kObliquityDeg * kPi / 180.0;
    const double psidot = analytic_precession_rate(b, units::G_AU_MSUN_YR, 1.0, eps);
    const double period = kTwoPi / std::fabs(psidot);

    EXPECT_GT(period, 5.0e4);
    EXPECT_LT(period, 1.2e5);

    // Sanity anchor against reality: adding a lunar-like perturber should pull
    // the period down toward the observed 25772 yr, not away from it.
    SpinBody b2 = b;
    const double mu_moon = units::G_AU_MSUN_YR * 0.0123;  // Moon/Sun torque ratio
    const double psidot_with_moon =
        psidot + analytic_precession_rate(b2, mu_moon, 1.0, eps);
    const double period_with_moon = kTwoPi / std::fabs(psidot_with_moon);
    EXPECT_LT(period_with_moon, period) << "adding the Moon must shorten the period";
    EXPECT_GT(period_with_moon, 1.0e4);
}

TEST(Spin, TidalTorqueDrivesTowardSynchronousRotation) {
    // Qualitative but real: the torque must oppose (w - n), pushing the spin
    // toward the mean motion, and must vanish at synchronous rotation.
    SpinBody b = make_earth();
    const double mu = units::G_AU_MSUN_YR;
    const double r = 1.0;
    const Vec3 r_ext(1.0, 0.0, 0.0);
    const double n_orb = mean_motion(mu, r);
    const Vec3 v_rel(0.0, n_orb * r, 0.0);

    // Super-synchronous spin: torque must be negative along the spin axis.
    b.spin_rate = n_orb * 3.0;
    const Vec3 tau_fast = tidal_torque_ctl(b, mu, r_ext, v_rel, 1e-3, 0.3);
    EXPECT_LT(tau_fast.dot(b.spin_axis), 0.0) << "fast rotator not spun down";

    // Sub-synchronous spin: torque must be positive.
    b.spin_rate = n_orb * 0.3;
    const Vec3 tau_slow = tidal_torque_ctl(b, mu, r_ext, v_rel, 1e-3, 0.3);
    EXPECT_GT(tau_slow.dot(b.spin_axis), 0.0) << "slow rotator not spun up";

    // At synchronous rotation with zero obliquity the torque vanishes.
    b.spin_rate = n_orb;
    b.spin_axis = Vec3(0.0, 0.0, 1.0);
    const Vec3 tau_sync = tidal_torque_ctl(b, mu, r_ext, v_rel, 1e-3, 0.3);
    EXPECT_LT(tau_sync.norm(), 1e-18) << "torque at synchronism: " << tau_sync.norm();
}

TEST(Spin, DynamicalFlatteningOfEarthIsPhysical) {
    SpinBody b = make_earth();
    // Earth's dynamical flattening (C-A)/C is 0.0032738.
    EXPECT_NEAR(b.dynamical_flattening(), 3.2738e-3, 1e-4);
    EXPECT_GT(b.C, b.A);
}

}  // namespace starpivot
