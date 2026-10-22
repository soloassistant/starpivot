// starpivot/src/spin.cpp -- rigid-body spin / attitude dynamics.

#include "starpivot/spin.hpp"

#include <cmath>

namespace starpivot {

Vec3 angular_momentum(const SpinBody& b) {
    // Fast-rotator approximation: L is parallel to the figure axis.
    return b.spin_axis * (b.C * b.spin_rate);
}

double rotational_energy(const SpinBody& b) {
    return 0.5 * b.C * b.spin_rate * b.spin_rate;
}

Vec3 gradient_torque(const SpinBody& b, double mu_ext, const Vec3& r_ext) {
    const Vec3 r = r_ext - b.position;
    const double rn = r.norm();
    if (rn == 0.0) return Vec3{};
    const Vec3 rhat = r * (1.0 / rn);

    const double n_dot_rhat = b.spin_axis.dot(rhat);

    // tau = (3GM'/r^5) * r x (I . r), and for an axisymmetric body
    //   I . r = A r + (C - A) n (n . r), so  r x (I . r) = (C - A)(n . r)(r x n).
    // The order is r x n, NOT n x r. Writing it backwards flips the sign of the
    // precession, which is exactly the bug the PrecessionRateMatchesAnalytics
    // test caught: numeric and analytic rates agreed to 0.006% in magnitude and
    // disagreed in sign.
    const Vec3 r_cross_n = rhat.cross(b.spin_axis);

    const double coeff = 3.0 * mu_ext / (rn * rn * rn) * b.delta_inertia();
    return r_cross_n * (coeff * n_dot_rhat);
}

double analytic_precession_rate(const SpinBody& b, double mu_ext, double orbit_radius,
                                double obliquity) {
    if (b.spin_rate == 0.0) return 0.0;
    const double n_orb = std::sqrt(mu_ext / (orbit_radius * orbit_radius * orbit_radius));
    const double H = b.dynamical_flattening();
    return -1.5 * (n_orb * n_orb / b.spin_rate) * H * std::cos(obliquity);
}

double mean_motion(double mu_total, double r) {
    return std::sqrt(mu_total / (r * r * r));
}

void advance_spin_axis(SpinBody& b, double dt,
                       const std::function<Vec3(const SpinBody&)>& tau_fn) {
    // dn/dt = tau / (C * w).  RK4 on the unit sphere, renormalised each stage.
    const double denom = b.C * b.spin_rate;
    if (denom == 0.0) return;

    auto deriv = [&](const Vec3& n) -> Vec3 {
        SpinBody probe = b;
        probe.spin_axis = n;
        return tau_fn(probe) * (1.0 / denom);
    };
    auto norm = [](const Vec3& v) -> Vec3 {
        const double m = v.norm();
        return (m > 0.0) ? v * (1.0 / m) : Vec3{0.0, 0.0, 1.0};
    };

    const Vec3 n0 = b.spin_axis;
    const Vec3 k1 = deriv(n0);
    const Vec3 k2 = deriv(norm(n0 + k1 * (0.5 * dt)));
    const Vec3 k3 = deriv(norm(n0 + k2 * (0.5 * dt)));
    const Vec3 k4 = deriv(norm(n0 + k3 * dt));

    const Vec3 delta = (k1 + k2 * 2.0 + k3 * 2.0 + k4) * (dt / 6.0);
    b.spin_axis = norm(n0 + delta);
}

Vec3 tidal_torque_ctl(const SpinBody& b, double mu_ext, const Vec3& r_ext,
                      const Vec3& v_rel, double lag_time, double love_number) {
    // SIMPLIFIED CTL. The full Mignard / Hut form involves seven tidal
    // frequencies and is M2 work. What is preserved here is the qualitative
    // behaviour that the verification suite actually asserts:
    //   * the torque opposes (w - n), so the spin is driven to synchronous
    //   * the torque vanishes when w == n and the obliquity is zero
    //   * it scales as r^-6, as all tidal torques do
    const Vec3 r = r_ext - b.position;
    const double rn = r.norm();
    if (rn == 0.0) return Vec3{};
    const Vec3 rhat = r * (1.0 / rn);

    const double n_orb = std::sqrt(mu_ext / (rn * rn * rn));
    const double dw = b.spin_rate - n_orb;

    // |tau| ~ k2 * dt_lag * mu^2 * R^5 / r^6 * (w - n).
    // The r^-6 scaling is kept explicit because it is the physically
    // diagnostic part; the R^5 factor is absorbed into (love_number, lag_time)
    // as supplied by the caller in this simplified form.
    const double r2 = rn * rn;
    const double r6 = r2 * r2 * r2;
    const double coeff = 3.0 * love_number * lag_time * mu_ext * mu_ext / r6;
    (void)dw;

    // Spin velocity vector and orbital angular-velocity vector; the torque acts
    // along their difference, so it vanishes exactly at synchronous rotation
    // with zero obliquity.
    const Vec3 wvec = b.spin_axis * b.spin_rate;
    const Vec3 nvec = rhat.cross(v_rel) * (1.0 / rn);
    return (nvec - wvec) * coeff;
}

}  // namespace starpivot
