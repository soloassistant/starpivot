// Baseline 4: Lagrange point stability.
//
// This is the most physical of the four baselines because it tests a qualitative
// prediction, not just a conserved number:
//
//   L4/L5 are linearly stable when mu = m2/(m1+m2) < 0.03852 (Routh criterion).
//   For the Sun-Earth system mu = 3.0e-6, far below that, so a Trojan placed at
//   L4 must librate around the point and stay there.
//
//   L1/L2/L3 are always unstable. A body placed at L1 must drift away.
//
// A kernel that gets the sign of a force, the jerk, or the integration order
// wrong will typically fail one of these two while still conserving energy --
// which is exactly why both halves of the pair are asserted.

#include <cmath>

#include <gtest/gtest.h>

#include "starpivot/constants.hpp"
#include "starpivot/elements.hpp"
#include "starpivot/hermite.hpp"
#include "tests/fixtures.hpp"

namespace starpivot {
namespace {

/// Distance from where a corotating point should be after time t, given the
/// rigid rotation of the primaries at angular rate omega about the barycentre.
double corotation_deviation(const System& sys, const Vec3& start, double t, double a = 1.0) {
    const double G = units::G_AU_MSUN_YR;
    const double omega = std::sqrt(G * (mass::SUN + mass::EARTH) / (a * a * a));
    const double theta = omega * t;
    const double c = std::cos(theta);
    const double s = std::sin(theta);
    const Vec3 expected(start.x * c - start.y * s, start.x * s + start.y * c, start.z);
    return (sys.bodies.back().position - expected).norm();
}

}  // namespace

TEST(Lagrange, L4IsStableOverOneCentury) {
    const Vec3 l4 = test::sun_earth_l4(1.0);
    System sys = test::lagrange_system(l4);

    Hermite4 integ(sys);
    integ.run(1.0e-3, 100.0);

    // 100 years is an integer number of Earth orbits, so a perfectly corotating
    // body returns to its starting point. Allow 1e-3 AU for libration.
    const double dev = corotation_deviation(sys, l4, 100.0);
    EXPECT_LT(dev, 1e-3) << "L4 deviation after 100 yr: " << dev << " AU";

    // The Trojan must also remain bound to the Sun.
    const OrbitalElements el = compute_elements(sys.bodies[0], sys.bodies.back(), sys.G);
    EXPECT_TRUE(el.bound) << "Trojan became unbound";
    EXPECT_NEAR(el.semi_major_axis, 1.0, 1e-3) << "Trojan drifted off the Earth orbit";
}

TEST(Lagrange, L4TrojanStaysNearTheEarthOrbitRadius) {
    const Vec3 l4 = test::sun_earth_l4(1.0);
    System sys = test::lagrange_system(l4);

    Hermite4 integ(sys);
    // Sample every 10 yr; the radius must never wander far from 1 AU.
    for (int i = 0; i < 10; ++i) {
        integ.run(1.0e-3, 10.0 * (i + 1));
        const double r = sys.bodies.back().position.norm();
        EXPECT_NEAR(r, 1.0, 2e-3) << "at t = " << 10.0 * (i + 1) << " yr, r = " << r;
    }
}

TEST(Lagrange, L1IsUnstable) {
    // Place the test body at the collinear L1 point with the corotating
    // velocity. Linear theory says it must depart exponentially.
    const double l1 = test::sun_earth_l1(1.0);
    ASSERT_GT(l1, 0.98);
    ASSERT_LT(l1, 0.9999);

    const Vec3 start(l1, 0.0, 0.0);
    System sys = test::lagrange_system(start);

    Hermite4 integ(sys);
    integ.run(1.0e-3, 100.0);

    const double dev = corotation_deviation(sys, start, 100.0);
    EXPECT_GT(dev, 1e-4) << "L1 failed to go unstable, deviation " << dev;
}

TEST(Lagrange, L4IsFarMoreStableThanL1) {
    // The discriminating test: same integration, same duration, two points that
    // theory says must behave oppositely. A correct kernel separates them by
    // orders of magnitude.
    const Vec3 l4 = test::sun_earth_l4(1.0);
    System s4 = test::lagrange_system(l4);
    Hermite4 h4(s4);
    h4.run(1.0e-3, 100.0);
    const double dev4 = corotation_deviation(s4, l4, 100.0);

    const Vec3 l1(test::sun_earth_l1(1.0), 0.0, 0.0);
    System s1 = test::lagrange_system(l1);
    Hermite4 h1(s1);
    h1.run(1.0e-3, 100.0);
    const double dev1 = corotation_deviation(s1, l1, 100.0);

    EXPECT_LT(dev4, dev1 / 10.0) << "L4 deviation " << dev4 << " vs L1 " << dev1;
}

}  // namespace starpivot
