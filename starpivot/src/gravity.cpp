// starpivot/src/gravity.cpp -- pairwise gravitational acceleration and jerk.
//
// O(N^2) direct summation. One sqrt and two divides per pair. This is the
// single hottest loop in the kernel; everything else is O(N) bookkeeping.
//
// The two entry points (current state vs. supplied state) share one
// implementation through a templated accessor, so there is exactly one copy of
// the force law to keep correct.

#include "starpivot/gravity.hpp"

#include <cstddef>

namespace starpivot {
namespace {

// Core kernel. getx(i)/getv(i) return Vec3 by const reference; the compiler
// inlines both instantiations so the templating costs nothing at runtime.
template <typename XGet>
void accel_impl(const std::vector<Body>& bodies,
                XGet getx,
                std::vector<Vec3>& a,
                double G,
                double eps2) {
    const std::size_t n = bodies.size();
    for (std::size_t i = 0; i < n; ++i) {
        a[i] = Vec3{};
    }
    for (std::size_t i = 0; i < n; ++i) {
        const Vec3 xi = getx(i);
        for (std::size_t k = i + 1; k < n; ++k) {
            const Vec3 dx = xi - getx(k);
            const double r2 = dx.norm_sq() + eps2;
            const double inv_r = 1.0 / std::sqrt(r2);
            const double inv_r3 = inv_r * inv_r * inv_r;
            const Vec3 f = dx * inv_r3;
            a[i] -= f * bodies[k].mass;
            a[k] += f * bodies[i].mass;
        }
    }
    if (G != 1.0) {
        for (std::size_t i = 0; i < n; ++i) {
            a[i] *= G;
        }
    }
}

template <typename XGet, typename VGet>
void accel_jerk_impl(const std::vector<Body>& bodies,
                     XGet getx,
                     VGet getv,
                     std::vector<Vec3>& a,
                     std::vector<Vec3>& j,
                     double G,
                     double eps2) {
    const std::size_t n = bodies.size();
    for (std::size_t i = 0; i < n; ++i) {
        a[i] = Vec3{};
        j[i] = Vec3{};
    }
    for (std::size_t i = 0; i < n; ++i) {
        const Vec3 xi = getx(i);
        const Vec3 vi = getv(i);
        for (std::size_t k = i + 1; k < n; ++k) {
            const Vec3 dx = xi - getx(k);
            const Vec3 dv = vi - getv(k);
            const double r2 = dx.norm_sq() + eps2;

            const double inv_r = 1.0 / std::sqrt(r2);
            const double inv_r3 = inv_r * inv_r * inv_r;
            const double inv_r5 = inv_r3 * inv_r * inv_r;

            // acceleration bracket  dx / r^3
            const Vec3 fb = dx * inv_r3;
            a[i] -= fb * bodies[k].mass;
            a[k] += fb * bodies[i].mass;

            // jerk bracket  dv/r^3 - 3 (dx.dv) dx / r^5
            const double dxdv = dx.dot(dv);
            const Vec3 jb = dv * inv_r3 - dx * (3.0 * dxdv * inv_r5);
            j[i] -= jb * bodies[k].mass;
            j[k] += jb * bodies[i].mass;
        }
    }
    if (G != 1.0) {
        for (std::size_t i = 0; i < n; ++i) {
            a[i] *= G;
            j[i] *= G;
        }
    }
}

}  // namespace

void compute_acceleration(const std::vector<Body>& bodies,
                          std::vector<Vec3>& a,
                          double G,
                          double eps2) {
    accel_impl(
        bodies, [&bodies](std::size_t i) -> const Vec3& { return bodies[i].position; },
        a, G, eps2);
}

void compute_acceleration_at(const std::vector<Body>& bodies,
                             const std::vector<Vec3>& x,
                             std::vector<Vec3>& a,
                             double G,
                             double eps2) {
    accel_impl(bodies, [&x](std::size_t i) -> const Vec3& { return x[i]; }, a, G, eps2);
}

void compute_acceleration_jerk(const std::vector<Body>& bodies,
                               std::vector<Vec3>& a,
                               std::vector<Vec3>& j,
                               double G,
                               double eps2) {
    accel_jerk_impl(
        bodies, [&bodies](std::size_t i) -> const Vec3& { return bodies[i].position; },
        [&bodies](std::size_t i) -> const Vec3& { return bodies[i].velocity; }, a, j, G,
        eps2);
}

void compute_acceleration_jerk_at(const std::vector<Body>& bodies,
                                  const std::vector<Vec3>& x,
                                  const std::vector<Vec3>& v,
                                  std::vector<Vec3>& a,
                                  std::vector<Vec3>& j,
                                  double G,
                                  double eps2) {
    accel_jerk_impl(bodies, [&x](std::size_t i) -> const Vec3& { return x[i]; },
                    [&v](std::size_t i) -> const Vec3& { return v[i]; }, a, j, G, eps2);
}

}  // namespace starpivot
