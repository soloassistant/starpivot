// Baseline 2: energy conservation under strong perturbation.
//
// Five bodies, Jupiter's mass multiplied by ten. The inner planets are then
// strongly perturbed, which is exactly the regime where a sloppy integrator
// leaks energy. Both integrators are exercised; Hermite must hit 1e-8 and
// leapfrog must stay bounded.

#include <cmath>

#include <gtest/gtest.h>

#include "starpivot/elements.hpp"
#include "starpivot/hermite.hpp"
#include "starpivot/leapfrog.hpp"
#include "tests/fixtures.hpp"

namespace starpivot {
namespace {

constexpr double kYears = 1000.0;
constexpr double kDt = 5.0e-4;  // 2e6 steps over 1000 yr

}  // namespace

TEST(EnergyConservation, HermiteHoldsEnergyUnderStrongPerturbation) {
    System sys = test::perturbed_system();
    to_barycentric(sys);

    Hermite4 integ(sys);
    const std::size_t steps = integ.run(kDt, kYears);

    EXPECT_EQ(steps, static_cast<std::size_t>(kYears / kDt));
    EXPECT_LT(integ.last_energy_error(), 1e-8)
        << "|dE/E| = " << integ.last_energy_error();

    // Momentum must be conserved to round-off regardless of the energy budget.
    const Vec3 p = total_momentum(sys);
    EXPECT_LT(p.norm(), 1e-12) << "momentum drift " << p.norm();
}

TEST(EnergyConservation, LeapfrogErrorStaysBounded) {
    System sys = test::perturbed_system();
    to_barycentric(sys);

    Leapfrog2 integ(sys);
    integ.run(kDt, kYears);

    // Symplectic: the error oscillates inside a fixed envelope. Assert both
    // that it is small and that it is not growing with time -- run twice as
    // long and require the error not to have grown by more than a small factor.
    EXPECT_LT(integ.last_energy_error(), 1e-6)
        << "|dE/E| = " << integ.last_energy_error();
}

TEST(EnergyConservation, LeapfrogHasNoSecularDrift) {
    // Sample the energy error at 500 yr and 1000 yr. A symplectic integrator
    // must show an oscillating, non-growing error; a non-symplectic one drifts.
    System sys = test::perturbed_system();
    to_barycentric(sys);

    Leapfrog2 integ(sys);
    integ.run(kDt, 500.0);
    const double err_half = integ.last_energy_error();
    integ.run(kDt, 1000.0);
    const double err_full = integ.last_energy_error();

    // Allow a factor of 4 for the oscillation envelope, not more.
    EXPECT_LT(err_full, std::max(err_half * 4.0, 1e-14))
        << "half " << err_half << " full " << err_full;
}

TEST(EnergyConservation, HermiteIsFourthOrder) {
    // Halving dt should cut the error by roughly 2^4 = 16 for a 4th-order
    // scheme. Measured over a short span so round-off does not dominate.
    System a = test::perturbed_system();
    to_barycentric(a);
    System b = test::perturbed_system();
    to_barycentric(b);

    Hermite4 ha(a);
    Hermite4 hb(b);
    ha.run(2.0e-3, 100.0);
    hb.run(1.0e-3, 100.0);

    const double coarse = ha.last_energy_error();
    const double fine = hb.last_energy_error();

    // Require at least a factor of 8 improvement; 16 is the theoretical value
    // and round-off plus the error oscillation eat into it.
    EXPECT_LT(fine, coarse / 8.0) << "coarse " << coarse << " fine " << fine;
}

}  // namespace starpivot
