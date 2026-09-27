// Baseline 1: two-body Kepler orbit.
//
// A circular Sun-Earth orbit must stay circular. The semi-major axis and the
// eccentricity are both invariants of the exact two-body problem, so any drift
// is purely integrator error.

#include <cmath>

#include <gtest/gtest.h>

#include "starpivot/constants.hpp"
#include "starpivot/elements.hpp"
#include "starpivot/hermite.hpp"
#include "starpivot/leapfrog.hpp"
#include "tests/fixtures.hpp"

namespace starpivot {
namespace {

constexpr double kYears = 100.0;
constexpr double kStepsPerOrbit = 1000;

}  // namespace

TEST(TwoBody, HermitePreservesSemiMajorAxisAndEccentricity) {
    System sys = test::two_body_circular(1.0);
    const double n = test::two_body_mean_motion(1.0);
    const double period = kTwoPi / n;
    const double dt = period / kStepsPerOrbit;

    const OrbitalElements before = compute_elements(sys.bodies[0], sys.bodies[1], sys.G);

    // Guard the fixture itself. Without this the test would happily confirm
    // that an ellipse stays an ellipse and call it "a circular orbit".
    ASSERT_NEAR(before.semi_major_axis, 1.0, 1e-12) << "fixture a is not 1 AU";
    ASSERT_LT(before.eccentricity, 1e-12) << "fixture is not circular";
    ASSERT_LT(total_momentum(sys).norm(), 1e-15) << "fixture carries net momentum";

    Hermite4 integ(sys);
    const std::size_t steps = integ.run(dt, kYears);

    const OrbitalElements after = compute_elements(sys.bodies[0], sys.bodies[1], sys.G);

    const double a_err = std::fabs(after.semi_major_axis - before.semi_major_axis) /
                         before.semi_major_axis;
    const double e_drift = std::fabs(after.eccentricity - before.eccentricity);

    EXPECT_EQ(steps, static_cast<std::size_t>(kYears / dt));
    EXPECT_LT(a_err, 1e-9) << "semi-major axis error " << a_err;
    EXPECT_LT(e_drift, 1e-8) << "eccentricity drift " << e_drift;
    EXPECT_LT(after.eccentricity, 1e-8) << "orbit did not stay circular";
    EXPECT_LT(integ.last_energy_error(), 1e-9) << "|dE/E| " << integ.last_energy_error();

    // Kepler's third law must still hold on the osculating elements.
    const double mu = sys.G * (sys.bodies[0].mass + sys.bodies[1].mass);
    const double expected_period =
        kTwoPi * std::sqrt(after.semi_major_axis * after.semi_major_axis *
                           after.semi_major_axis / mu);
    EXPECT_NEAR(after.period, expected_period, expected_period * 1e-12);
    EXPECT_NEAR(after.period, period, period * 1e-9);
}

TEST(TwoBody, LeapfrogIsSymplecticAndBounded) {
    // Leapfrog is only 2nd order, so it is less accurate per step than Hermite,
    // but its energy error must stay bounded rather than drift. Run ten times
    // longer than the Hermite case and require the error to stay in a band.
    System sys = test::two_body_circular(1.0);
    const double n = test::two_body_mean_motion(1.0);
    const double dt = (kTwoPi / n) / kStepsPerOrbit;

    Leapfrog2 integ(sys);
    integ.run(dt, kYears * 10.0);

    const OrbitalElements after = compute_elements(sys.bodies[0], sys.bodies[1], sys.G);
    const double a_err = std::fabs(after.semi_major_axis - 1.0) / 1.0;

    EXPECT_LT(a_err, 1e-6) << "leapfrog semi-major axis error " << a_err;
    EXPECT_LT(integ.last_energy_error(), 1e-6)
        << "leapfrog |dE/E| " << integ.last_energy_error();
}

// Compare TRAJECTORY accuracy, not energy error.
//
// An earlier version of this test asserted Hermite's energy error was smaller
// than leapfrog's. It failed, and the failure is physically correct:
//
//     Hermite4   |dE/E| = 3.4e-11
//     Leapfrog2  |dE/E| = 2.7e-14
//
// Leapfrog wins on energy for a regular two-body orbit because it is symplectic:
// it conserves a nearby "shadow" Hamiltonian exactly, so the energy error
// oscillates in a tiny band instead of accumulating. Hermite is 4th order but
// not symplectic, so its energy drifts slowly.
//
// The next hypothesis was that Hermite at least wins on position. It does not,
// not over 100 orbits: leapfrog's semi-major axis error is 2.7e-17 against
// Hermite's 3.4e-11. Both are conserved quantities of this orbit, and a
// symplectic method bounds both.
//
// What Hermite actually buys is per-step accuracy, which shows up over a SHORT
// horizon and in systems with close encounters. That is the next test.
TEST(TwoBody, HermiteIsMoreAccurateOverOneOrbit) {
    const double n = test::two_body_mean_motion(1.0);
    const double period = kTwoPi / n;
    const double dt = period / kStepsPerOrbit;

    System s1 = test::two_body_circular(1.0);
    const Vec3 start = s1.bodies[1].position;
    Hermite4 h(s1);
    h.run(dt, period);
    const double err_h = (s1.bodies[1].position - start).norm();

    System s2 = test::two_body_circular(1.0);
    Leapfrog2 l(s2);
    l.run(dt, period);
    const double err_l = (s2.bodies[1].position - start).norm();

    EXPECT_LT(err_h, err_l * 1e-3)
        << "hermite position error " << err_h << " vs leapfrog " << err_l;
}

TEST(TwoBody, SymplecticWinsOnConservedQuantitiesOverLongHorizons) {
    // The selection rule this kernel is built around, stated as a test:
    // over 100 orbits the 2nd-order symplectic scheme beats the 4th-order
    // non-symplectic one on BOTH conserved quantities of the orbit.
    //
    //     |dE/E|            hermite 3.4e-11  vs  leapfrog 2.7e-14
    //     semi-major axis   hermite 3.4e-11  vs  leapfrog 2.7e-17
    //
    // So: Hermite4 for medium horizons, close encounters and adaptive stepping;
    // a symplectic map for 1e6-1e9 yr secular evolution. Shipping only one of
    // them would be a design error.
    const double n = test::two_body_mean_motion(1.0);
    const double dt = (kTwoPi / n) / kStepsPerOrbit;

    System s1 = test::two_body_circular(1.0);
    Hermite4 h(s1);
    h.run(dt, kYears);
    const double a_err_h =
        std::fabs(compute_elements(s1.bodies[0], s1.bodies[1], s1.G).semi_major_axis - 1.0);

    System s2 = test::two_body_circular(1.0);
    Leapfrog2 l(s2);
    l.run(dt, kYears);
    const double a_err_l =
        std::fabs(compute_elements(s2.bodies[0], s2.bodies[1], s2.G).semi_major_axis - 1.0);

    EXPECT_LT(l.last_energy_error(), h.last_energy_error())
        << "energy: leapfrog " << l.last_energy_error() << " vs hermite "
        << h.last_energy_error();
    EXPECT_LT(a_err_l, a_err_h)
        << "semi-major axis: leapfrog " << a_err_l << " vs hermite " << a_err_h;
}

}  // namespace starpivot
