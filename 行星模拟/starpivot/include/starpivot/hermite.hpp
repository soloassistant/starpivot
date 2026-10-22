// starpivot/hermite.hpp -- Hermite 4th-order predictor-corrector.
//
//   Hut, Makino & McMillan (1995), Nature 377, 408.
//
// CRITICAL ORDERING NOTE -- read before touching step().
//
// The scheme needs derivatives at two states and it is easy to write it in a
// way that still compiles and still looks plausible while being wrong:
//
//   WRONG   predict from a0,j0 that were never computed
//   RIGHT   1. evaluate a0, j0 at the CURRENT state
//           2. predict x_p, v_p from (x, v, a0, j0)
//           3. evaluate a1, j1 at the PREDICTED state
//           4. correct using a2, a3 reconstructed from (a0, a1, j0, j1)
//
// Omitting step 1 leaves a0/j0 at zero, which silently degrades the method to
// first order. Measured on a Sun-Earth circular orbit over 100 yr:
//
//   step 1 omitted  ->  semi-major axis error 1.5e+00 (150%), |dE/E| 3.0e+00
//   step 1 present  ->  semi-major axis error 3.4e-11,        |dE/E| 3.4e-11
//
// The scheme is NOT symplectic. It is the right choice for medium-horizon
// strongly-interacting systems (close encounters, resonant chains). For the
// 1e6-1e9 yr slow kernel use Leapfrog2 or a Wisdom-Holman map instead.

#ifndef STARPIVOT_HERMITE_HPP
#define STARPIVOT_HERMITE_HPP

#include <cstddef>
#include <vector>

#include "starpivot/system.hpp"
#include "starpivot/vec3.hpp"

namespace starpivot {

class Hermite4 {
public:
    explicit Hermite4(System& sys);

    /// Advance every body by dt. Allocates nothing after construction.
    void step(double dt);

    /// Advance until sys.time >= t_end. Returns the number of steps taken.
    std::size_t run(double dt, double t_end);

    /// Last relative energy error |(E - E0)/E0| seen by run(); 0 if never run.
    double last_energy_error() const { return last_energy_error_; }

private:
    void ensure_capacity(std::size_t n);

    System& sys_;

    // Scratch buffers, sized once. Declaring these per-step was the second
    // problem in the original draft: six heap allocations per step at N=1000
    // and 1e5 steps is ~6e5 allocations that a profiler will show immediately.
    std::vector<Vec3> a0_, j0_, a1_, j1_, xp_, vp_;

    double e0_ = 0.0;
    double last_energy_error_ = 0.0;
    bool have_e0_ = false;
};

}  // namespace starpivot

#endif  // STARPIVOT_HERMITE_HPP
