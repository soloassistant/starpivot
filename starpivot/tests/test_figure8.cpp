// Baseline 3: the Figure-8 three-body choreography.
//
// Three equal masses chase each other along a single closed curve
// (Chenciner & Montgomery 2000). After exactly one period every body must
// return to its own starting state. This is a genuinely non-trivial check: the
// orbit is periodic but not stable, so a wrong force law, a wrong jerk, or a
// mis-ordered Hermite stage all show up immediately.

#include <cmath>
#include <vector>

#include <gtest/gtest.h>

#include "starpivot/hermite.hpp"
#include "starpivot/leapfrog.hpp"
#include "tests/fixtures.hpp"

namespace starpivot {
namespace {

double closure_error(const System& initial, const System& evolved) {
    double worst = 0.0;
    for (std::size_t i = 0; i < initial.size(); ++i) {
        const double dp = (evolved.bodies[i].position - initial.bodies[i].position).norm();
        const double dv = (evolved.bodies[i].velocity - initial.bodies[i].velocity).norm();
        worst = std::max(worst, std::max(dp, dv));
    }
    return worst;
}

}  // namespace

TEST(Figure8, HermiteClosesTheOrbitAfterOnePeriod) {
    System sys = test::figure8();
    const System initial = sys;

    const double T = test::kFigure8Period;
    const double dt = T / 20000.0;

    Hermite4 integ(sys);
    const std::size_t steps = integ.run(dt, T);
    EXPECT_EQ(steps, 20000u);

    const double err = closure_error(initial, sys);
    EXPECT_LT(err, 1e-6) << "closure error after one period: " << err;
}

TEST(Figure8, TotalEnergyIsConserved) {
    System sys = test::figure8();
    const double T = test::kFigure8Period;

    Hermite4 integ(sys);
    integ.run(T / 20000.0, T);

    EXPECT_LT(integ.last_energy_error(), 1e-9)
        << "|dE/E| = " << integ.last_energy_error();
}

TEST(Figure8, StaysBoundOverTenPeriods) {
    // Ten periods is past the point where an inaccurate scheme has visibly
    // fallen off the periodic orbit. We do not demand 1e-6 here -- the orbit is
    // unstable, so error grows -- only that the system stays recognisably on
    // the figure-eight and remains bound.
    System sys = test::figure8();
    const System initial = sys;
    const double T = test::kFigure8Period;

    Hermite4 integ(sys);
    integ.run(T / 20000.0, 10.0 * T);

    // Each body must remain within a few lengths of the origin: bound.
    for (const Body& b : sys.bodies) {
        EXPECT_LT(b.position.norm(), 5.0) << "body " << b.id << " escaped";
    }

    // ...and the configuration must still be recognisable: no body has
    // collapsed onto another.
    for (std::size_t i = 0; i < sys.size(); ++i) {
        for (std::size_t k = i + 1; k < sys.size(); ++k) {
            const double d = (sys.bodies[i].position - sys.bodies[k].position).norm();
            EXPECT_GT(d, 0.1) << "bodies " << i << "," << k << " too close: " << d;
        }
    }

    // Energy still bounded even though the trajectory has diverged.
    EXPECT_LT(integ.last_energy_error(), 1e-7)
        << "|dE/E| after 10 periods = " << integ.last_energy_error();
}

TEST(Figure8, LeapfrogClosesLoosely) {
    // Second order, so the tolerance is far looser; this test exists to confirm
    // the symplectic path produces the same qualitative orbit.
    System sys = test::figure8();
    const System initial = sys;
    const double T = test::kFigure8Period;

    Leapfrog2 integ(sys);
    integ.run(T / 20000.0, T);

    const double err = closure_error(initial, sys);
    EXPECT_LT(err, 1e-2) << "leapfrog closure error: " << err;
}

}  // namespace starpivot
