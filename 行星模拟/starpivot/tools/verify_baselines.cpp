// Standalone baseline reporter.
//
// Compiles with nothing but the C++17 standard library and the kernel, so it
// can be run on a machine without CMake or GoogleTest:
//
//   c++ -std=c++17 -O2 -I include \
//       src/gravity.cpp src/hermite.cpp src/leapfrog.cpp src/elements.cpp \
//       tools/verify_baselines.cpp -o verify_baselines
//
// It prints the four numbers that go on the README. Exit code 0 means every
// baseline passed.

#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "starpivot/constants.hpp"
#include "starpivot/elements.hpp"
#include "starpivot/hermite.hpp"
#include "starpivot/leapfrog.hpp"
#include "starpivot/system.hpp"
#include "starpivot/vec3.hpp"
#include "tests/fixtures.hpp"

using namespace starpivot;

namespace {

int failures = 0;

void check(const char* name, bool ok, const std::string& detail) {
    std::printf("  [%s] %-28s %s\n", ok ? "PASS" : "FAIL", name, detail.c_str());
    if (!ok) ++failures;
}

std::string sci(double v) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.3e", v);
    return std::string(buf);
}

double corotation_deviation(const System& sys, const Vec3& start, double t, double a = 1.0) {
    const double omega = std::sqrt(units::G_AU_MSUN_YR * (mass::SUN + mass::EARTH) / (a * a * a));
    const double theta = omega * t;
    const double c = std::cos(theta);
    const double s = std::sin(theta);
    const Vec3 expected(start.x * c - start.y * s, start.x * s + start.y * c, start.z);
    return (sys.bodies.back().position - expected).norm();
}

}  // namespace

int main() {
    std::printf("\nStarpivot physics baselines (units: AU / Msun / yr)\n");
    std::printf("==============================================================\n\n");

    // ---- Baseline 1: two-body Kepler -------------------------------------
    std::printf("Baseline 1  two-body Kepler, 100 yr, dt = T/1000\n");
    {
        System sys = test::two_body_circular(1.0);
        const double n = test::two_body_mean_motion(1.0);
        const double period = kTwoPi / n;
        const double dt = period / 1000.0;

        const OrbitalElements before =
            compute_elements(sys.bodies[0], sys.bodies[1], sys.G);

        // Guard the fixture: a "circular orbit" that starts at e = 1.2e-5 with
        // net momentum would still pass the drift checks below.
        check("fixture a = 1 AU", std::fabs(before.semi_major_axis - 1.0) < 1e-12,
              sci(std::fabs(before.semi_major_axis - 1.0)) + "  (target < 1e-12)");
        check("fixture e = 0", before.eccentricity < 1e-12,
              sci(before.eccentricity) + "  (target < 1e-12)");
        check("fixture momentum = 0", total_momentum(sys).norm() < 1e-15,
              sci(total_momentum(sys).norm()) + "  (target < 1e-15)");

        Hermite4 integ(sys);
        integ.run(dt, 100.0);
        const OrbitalElements after =
            compute_elements(sys.bodies[0], sys.bodies[1], sys.G);

        const double a_err = std::fabs(after.semi_major_axis - before.semi_major_axis) /
                             before.semi_major_axis;
        const double e_drift = std::fabs(after.eccentricity - before.eccentricity);

        check("a relative error", a_err < 1e-9, sci(a_err) + "  (target < 1e-9)");
        check("eccentricity drift", e_drift < 1e-8, sci(e_drift) + "  (target < 1e-8)");
        check("|dE/E|", integ.last_energy_error() < 1e-9,
              sci(integ.last_energy_error()) + "  (target < 1e-9)");
    }

    // ---- Baseline 2: energy under strong perturbation ---------------------
    std::printf("\nBaseline 2  energy conservation, 5 bodies, Jupiter x10, 1000 yr\n");
    {
        System sys = test::perturbed_system();
        to_barycentric(sys);
        Hermite4 integ(sys);
        integ.run(5.0e-4, 1000.0);

        check("|dE/E|", integ.last_energy_error() < 1e-8,
              sci(integ.last_energy_error()) + "  (target < 1e-8)");

        const Vec3 p = total_momentum(sys);
        check("momentum drift", p.norm() < 1e-12, sci(p.norm()) + "  (target < 1e-12)");
    }

    // ---- Baseline 3: Figure-8 --------------------------------------------
    std::printf("\nBaseline 3  Figure-8 three-body, one period\n");
    {
        System sys = test::figure8();
        const System initial = sys;
        const double T = test::kFigure8Period;
        Hermite4 integ(sys);
        integ.run(T / 20000.0, T);

        double worst = 0.0;
        for (std::size_t i = 0; i < sys.size(); ++i) {
            worst = std::max(
                worst, (sys.bodies[i].position - initial.bodies[i].position).norm());
            worst = std::max(
                worst, (sys.bodies[i].velocity - initial.bodies[i].velocity).norm());
        }
        check("closure error", worst < 1e-6, sci(worst) + "  (target < 1e-6)");
        check("|dE/E|", integ.last_energy_error() < 1e-9,
              sci(integ.last_energy_error()) + "  (target < 1e-9)");
    }

    // ---- Baseline 4: Lagrange points -------------------------------------
    std::printf("\nBaseline 4  Lagrange points, Sun-Earth, 100 yr\n");
    {
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

        std::printf("    L1 distance from Sun = %.6f AU\n", l1.x);
        check("L4 deviation", dev4 < 1e-3, sci(dev4) + " AU  (target < 1e-3)");
        check("L1 unstable", dev1 > 1e-4, sci(dev1) + " AU  (target > 1e-4)");
        check("L4 vs L1 separation", dev4 < dev1 / 10.0,
              "ratio " + sci(dev1 / std::max(dev4, 1e-300)) + "  (target > 10)");
    }

    std::printf("\n==============================================================\n");
    if (failures == 0) {
        std::printf("ALL BASELINES PASSED\n\n");
        return 0;
    }
    std::printf("%d BASELINE(S) FAILED\n\n", failures);
    return 1;
}
