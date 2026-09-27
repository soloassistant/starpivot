// starpivot/leapfrog.hpp -- 2nd-order symplectic leapfrog (kick-drift-kick).
//
// Symplectic and time-reversible. This is the slow-kernel building block: the
// energy error oscillates within a bounded envelope instead of drifting, which
// is what makes 1e6-1e9 yr integrations meaningful. Hermite4 is more accurate
// per step but is NOT symplectic and will drift over those horizons.
//
// One force evaluation per step: the acceleration computed at the end of a step
// is reused as the half-kick at the start of the next one.

#ifndef STARPIVOT_LEAPFROG_HPP
#define STARPIVOT_LEAPFROG_HPP

#include <cstddef>
#include <vector>

#include "starpivot/system.hpp"
#include "starpivot/vec3.hpp"

namespace starpivot {

class Leapfrog2 {
public:
    explicit Leapfrog2(System& sys);

    void step(double dt);
    std::size_t run(double dt, double t_end);

    double last_energy_error() const { return last_energy_error_; }

private:
    System& sys_;
    std::vector<Vec3> a_;
    double e0_ = 0.0;
    double last_energy_error_ = 0.0;
    bool have_e0_ = false;
};

}  // namespace starpivot

#endif  // STARPIVOT_LEAPFROG_HPP
