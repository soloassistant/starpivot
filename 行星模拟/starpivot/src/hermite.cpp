// starpivot/src/hermite.cpp -- Hermite 4th-order predictor-corrector.
//
// See hermite.hpp for why the derivative evaluation order matters. The short
// version: a0/j0 are computed from the CURRENT state *before* prediction. If
// you delete that call the code still compiles and the scheme silently becomes
// first order.

#include "starpivot/hermite.hpp"

#include <cmath>
#include <cstddef>

#include "starpivot/elements.hpp"
#include "starpivot/gravity.hpp"

namespace starpivot {

Hermite4::Hermite4(System& sys) : sys_(sys) {
    ensure_capacity(sys_.size());
    e0_ = total_energy(sys_);
    have_e0_ = true;
}

void Hermite4::ensure_capacity(std::size_t n) {
    a0_.resize(n);
    j0_.resize(n);
    a1_.resize(n);
    j1_.resize(n);
    xp_.resize(n);
    vp_.resize(n);
}

void Hermite4::step(double dt) {
    const std::size_t n = sys_.bodies.size();
    if (a0_.size() != n) {
        ensure_capacity(n);
    }

    const double G = sys_.G;
    const double eps2 = sys_.softening * sys_.softening;
    const double dt2 = dt * dt;
    const double dt3 = dt2 * dt;
    const double dt4 = dt2 * dt2;
    const double dt5 = dt4 * dt;

    // --- 1. derivatives at the current state -------------------------------
    // This is the line the original draft was missing.
    compute_acceleration_jerk(sys_.bodies, a0_, j0_, G, eps2);

    // --- 2. predict --------------------------------------------------------
    for (std::size_t i = 0; i < n; ++i) {
        const Body& b = sys_.bodies[i];
        xp_[i] = b.position + b.velocity * dt + a0_[i] * (0.5 * dt2) + j0_[i] * (dt3 / 6.0);
        vp_[i] = b.velocity + a0_[i] * dt + j0_[i] * (0.5 * dt2);
    }

    // --- 3. derivatives at the predicted state -----------------------------
    compute_acceleration_jerk_at(sys_.bodies, xp_, vp_, a1_, j1_, G, eps2);

    // --- 4. correct --------------------------------------------------------
    // Reconstruct the 2nd and 3rd time derivatives of acceleration from the
    // Hermite interpolation conditions, then integrate the quartic.
    for (std::size_t i = 0; i < n; ++i) {
        Body& b = sys_.bodies[i];
        const Vec3 da = a0_[i] - a1_[i];

        // a2 = (-6 (a0 - a1) - dt (4 j0 + 2 j1)) / dt^2
        const Vec3 a2 = da * (-6.0 / dt2) + j0_[i] * (-4.0 / dt) + j1_[i] * (-2.0 / dt);
        // a3 = (12 (a0 - a1) + 6 dt (j0 + j1)) / dt^3
        const Vec3 a3 = da * (12.0 / dt3) + (j0_[i] + j1_[i]) * (6.0 / dt2);

        b.position = b.position                 // x0
                     + b.velocity * dt          // v0 dt
                     + a0_[i] * (0.5 * dt2)     // a0 dt^2 / 2
                     + j0_[i] * (dt3 / 6.0)     // j0 dt^3 / 6
                     + a2 * (dt4 / 24.0)        // a2 dt^4 / 24
                     + a3 * (dt5 / 120.0);      // a3 dt^5 / 120

        b.velocity = b.velocity                 // v0
                     + a0_[i] * dt              // a0 dt
                     + j0_[i] * (0.5 * dt2)     // j0 dt^2 / 2
                     + a2 * (dt3 / 6.0)         // a2 dt^3 / 6
                     + a3 * (dt4 / 24.0);       // a3 dt^4 / 24
    }

    sys_.time += dt;
}

std::size_t Hermite4::run(double dt, double t_end) {
    if (!have_e0_) {
        e0_ = total_energy(sys_);
        have_e0_ = true;
    }
    // Step count is derived from t_end and dt; callers are required to pass a
    // t_end that is an integer multiple of dt (xsys rule 02 enforces this at
    // the file layer).
    const std::size_t nsteps = static_cast<std::size_t>(std::llround((t_end - sys_.time) / dt));
    for (std::size_t s = 0; s < nsteps; ++s) {
        step(dt);
    }
    const double e1 = total_energy(sys_);
    last_energy_error_ = (e0_ != 0.0) ? std::fabs((e1 - e0_) / e0_) : std::fabs(e1 - e0_);
    return nsteps;
}

}  // namespace starpivot
