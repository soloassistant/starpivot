// Throughput benchmark for the O(N^2) force kernel.
//
// Exists to keep performance claims honest. The design note asserted
// "1000 bodies, 1e5 steps, single thread, < 2 s". That requires
// 4.995e10 pair-interactions in 2 s, i.e. 2.5e10 pairs/s, or 40 picoseconds
// per pair -- less than a single square root. Measuring the actual rate and
// extrapolating is the only way to catch that class of claim.

#include <chrono>
#include <cmath>
#include <cstdio>
#include <random>
#include <string>

#include "starpivot/hermite.hpp"
#include "starpivot/system.hpp"

using namespace starpivot;

int main(int argc, char** argv) {
    const std::size_t n = (argc > 1) ? std::stoul(argv[1]) : 200;
    const std::size_t steps = (argc > 2) ? std::stoul(argv[2]) : 2000;

    System sys;
    sys.G = 1.0;
    sys.softening = 1e-3;
    sys.bodies.reserve(n);

    std::mt19937 rng(20260924);
    std::uniform_real_distribution<double> pos(-1.0, 1.0);
    std::uniform_real_distribution<double> vel(-0.1, 0.1);
    for (std::size_t i = 0; i < n; ++i) {
        sys.bodies.push_back(Body("b" + std::to_string(i), 1.0 / static_cast<double>(n),
                                  Vec3(pos(rng), pos(rng), pos(rng)),
                                  Vec3(vel(rng), vel(rng), vel(rng))));
    }

    Hermite4 integ(sys);
    // Warm up so the first-touch page faults and any lazy init are not measured.
    integ.step(1e-6);

    const auto t0 = std::chrono::steady_clock::now();
    for (std::size_t s = 0; s < steps; ++s) {
        integ.step(1e-6);
    }
    const auto t1 = std::chrono::steady_clock::now();

    const double seconds = std::chrono::duration<double>(t1 - t0).count();
    const double pairs_per_step = static_cast<double>(n * (n - 1) / 2);
    const double total_pairs = pairs_per_step * static_cast<double>(steps);
    const double rate = total_pairs / seconds;

    std::printf("N = %zu, steps = %zu\n", n, steps);
    std::printf("  wall time            %.3f s\n", seconds);
    std::printf("  pair-interactions    %.4e\n", total_pairs);
    std::printf("  throughput           %.4e pairs/s\n", rate);
    std::printf("  per pair             %.2f ns\n", seconds / total_pairs * 1e9);

    // Extrapolate to the design note's claim.
    const double claim_n = 1000.0;
    const double claim_steps = 1e5;
    const double claim_pairs = claim_n * (claim_n - 1.0) / 2.0 * claim_steps;
    std::printf("\nextrapolation to N=1000, 1e5 steps (%.4e pair-interactions):\n",
                claim_pairs);
    std::printf("  estimated wall time  %.1f s  (%.2f min)\n", claim_pairs / rate,
                claim_pairs / rate / 60.0);
    std::printf("  claimed              2.0 s\n");
    std::printf("  shortfall factor     %.0fx\n", (claim_pairs / rate) / 2.0);
    return 0;
}
