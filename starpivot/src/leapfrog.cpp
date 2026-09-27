// starpivot/src/leapfrog.cpp -- symplectic KDK leapfrog.

#include "starpivot/leapfrog.hpp"

#include <cmath>
#include <cstddef>

#include "starpivot/elements.hpp"
#include "starpivot/gravity.hpp"

namespace starpivot {

Leapfrog2::Leapfrog2(System& sys) : sys_(sys) {
    a_.resize(sys_.size());
    const double eps2 = sys_.softening * sys_.softening;
    compute_acceleration(sys_.bodies, a_, sys_.G, eps2);
    e0_ = total_energy(sys_);
    have_e0_ = true;
}

void Leapfrog2::step(double dt) {
    const std::size_t n = sys_.bodies.size();
    if (a_.size() != n) {
        a_.resize(n);
        const double eps2 = sys_.softening * sys_.softening;
        compute_acceleration(sys_.bodies, a_, sys_.G, eps2);
    }

    const double G = sys_.G;
    const double eps2 = sys_.softening * sys_.softening;
    const double half = 0.5 * dt;

    // half kick with the acceleration carried over from the previous step
    for (std::size_t i = 0; i < n; ++i) {
        sys_.bodies[i].velocity += a_[i] * half;
    }

    // full drift
    for (std::size_t i = 0; i < n; ++i) {
        sys_.bodies[i].position += sys_.bodies[i].velocity * dt;
    }

    // recompute, then close the kick
    compute_acceleration(sys_.bodies, a_, G, eps2);
    for (std::size_t i = 0; i < n; ++i) {
        sys_.bodies[i].velocity += a_[i] * half;
    }

    sys_.time += dt;
}

std::size_t Leapfrog2::run(double dt, double t_end) {
    if (!have_e0_) {
        e0_ = total_energy(sys_);
        have_e0_ = true;
    }
    const std::size_t nsteps = static_cast<std::size_t>(std::llround((t_end - sys_.time) / dt));
    for (std::size_t s = 0; s < nsteps; ++s) {
        step(dt);
    }
    const double e1 = total_energy(sys_);
    last_energy_error_ = (e0_ != 0.0) ? std::fabs((e1 - e0_) / e0_) : std::fabs(e1 - e0_);
    return nsteps;
}

}  // namespace starpivot
