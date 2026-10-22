// Verifies the analytic jerk against a finite-difference da/dt.
//
// If the jerk expression were wrong, Hermite4 would silently degrade to roughly
// second order. This test catches that class of bug at the force-kernel layer,
// before any integrator is involved.

#include <cmath>
#include <vector>

#include <gtest/gtest.h>

#include "starpivot/gravity.hpp"
#include "starpivot/system.hpp"
#include "starpivot/vec3.hpp"
#include "tests/fixtures.hpp"

namespace starpivot {
namespace {

std::vector<Vec3> positions(const System& s) {
    std::vector<Vec3> x;
    x.reserve(s.size());
    for (const Body& b : s.bodies) x.push_back(b.position);
    return x;
}

std::vector<Vec3> velocities(const System& s) {
    std::vector<Vec3> v;
    v.reserve(s.size());
    for (const Body& b : s.bodies) v.push_back(b.velocity);
    return v;
}

}  // namespace

TEST(GravityConsistency, AnalyticJerkMatchesFiniteDifference) {
    System sys = test::perturbed_system();
    const std::size_t n = sys.size();
    const double eps2 = sys.softening * sys.softening;

    std::vector<Vec3> x = positions(sys);
    std::vector<Vec3> v = velocities(sys);

    std::vector<Vec3> a0(n), j0(n);
    compute_acceleration_jerk_at(sys.bodies, x, v, a0, j0, sys.G, eps2);

    // j = da/dt, estimated by displacing along the velocity field
    const double h = 1e-7;
    std::vector<Vec3> xp(n);
    for (std::size_t i = 0; i < n; ++i) xp[i] = x[i] + v[i] * h;

    std::vector<Vec3> ah(n), jh(n);
    compute_acceleration_jerk_at(sys.bodies, xp, v, ah, jh, sys.G, eps2);

    double worst = 0.0;
    for (std::size_t i = 0; i < n; ++i) {
        const Vec3 fd = (ah[i] - a0[i]) * (1.0 / h);
        const double err = (fd - j0[i]).norm();
        const double scale = std::max(1e-30, j0[i].norm());
        worst = std::max(worst, err / scale);
    }

    // 1e-5 is the truncation floor of the difference quotient at h = 1e-7,
    // not slack in the assertion.
    EXPECT_LT(worst, 1e-5) << "analytic jerk disagrees with da/dt by " << worst;
}

TEST(GravityConsistency, NewtonThirdLawMomentumBalance) {
    System sys = test::perturbed_system();
    const std::size_t n = sys.size();
    const double eps2 = sys.softening * sys.softening;

    std::vector<Vec3> a(n);
    compute_acceleration(sys.bodies, a, sys.G, eps2);

    // Sum of m_i * a_i must vanish: internal forces cancel pairwise.
    Vec3 net;
    for (std::size_t i = 0; i < n; ++i) net += a[i] * sys.bodies[i].mass;

    double scale = 0.0;
    for (std::size_t i = 0; i < n; ++i) {
        scale = std::max(scale, (a[i] * sys.bodies[i].mass).norm());
    }
    EXPECT_LT(net.norm() / scale, 1e-14);
}

TEST(GravityConsistency, SymmetricAccelerationMatchesDirectSum) {
    // Cross-check the pairwise-symmetric kernel against a naive O(N^2) loop
    // written independently in the test.
    System sys = test::perturbed_system();
    const std::size_t n = sys.size();
    const double eps2 = sys.softening * sys.softening;

    std::vector<Vec3> a(n);
    compute_acceleration(sys.bodies, a, sys.G, eps2);

    for (std::size_t i = 0; i < n; ++i) {
        Vec3 acc;
        for (std::size_t k = 0; k < n; ++k) {
            if (k == i) continue;
            const Vec3 d = sys.bodies[i].position - sys.bodies[k].position;
            const double r2 = d.norm_sq() + eps2;
            acc -= d * (sys.G * sys.bodies[k].mass / (r2 * std::sqrt(r2)));
        }
        const double err = (acc - a[i]).norm();
        const double scale = std::max(1e-30, acc.norm());
        EXPECT_LT(err / scale, 1e-14) << "body " << i;
    }
}

}  // namespace starpivot
