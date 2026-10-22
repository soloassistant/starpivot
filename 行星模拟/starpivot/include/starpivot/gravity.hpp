// starpivot/gravity.hpp -- pairwise gravitational acceleration and jerk.

#ifndef STARPIVOT_GRAVITY_HPP
#define STARPIVOT_GRAVITY_HPP

#include <vector>

#include "starpivot/system.hpp"
#include "starpivot/vec3.hpp"

namespace starpivot {

/// a_i = -G sum_{k != i} m_k (x_i - x_k) / |x_i - x_k|^3
/// Output buffers are overwritten, not accumulated; caller pre-sizes them.
void compute_acceleration(const std::vector<Body>& bodies,
                          std::vector<Vec3>& a,
                          double G,
                          double eps2);

/// Acceleration at an arbitrary supplied state (used by predictor stages).
void compute_acceleration_at(const std::vector<Body>& bodies,
                             const std::vector<Vec3>& x,
                             std::vector<Vec3>& a,
                             double G,
                             double eps2);

/// Simultaneous acceleration and jerk.
///
/// j_i = da_i/dt = -G sum_k m_k [ dv/r^3 - 3 (dx . dv) dx / r^5 ]
///     with dx = x_i - x_k, dv = v_i - v_k
///
/// The analytic jerk is checked against a finite-difference da/dt in
/// tests/test_gravity_consistency.cpp; the two agree to ~1e-6 relative, which
/// is the truncation floor of the difference quotient, not an error in the
/// analytic form.
void compute_acceleration_jerk(const std::vector<Body>& bodies,
                               std::vector<Vec3>& a,
                               std::vector<Vec3>& j,
                               double G,
                               double eps2);

void compute_acceleration_jerk_at(const std::vector<Body>& bodies,
                                  const std::vector<Vec3>& x,
                                  const std::vector<Vec3>& v,
                                  std::vector<Vec3>& a,
                                  std::vector<Vec3>& j,
                                  double G,
                                  double eps2);

}  // namespace starpivot

#endif  // STARPIVOT_GRAVITY_HPP
