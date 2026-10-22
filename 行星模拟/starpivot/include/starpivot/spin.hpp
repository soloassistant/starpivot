// starpivot/spin.hpp -- rigid-body spin / attitude dynamics.
//
// This module is the reason the product can call itself a *planetary attitude*
// platform. Everything in gravity.cpp/hermite.cpp is TRANSLATIONAL motion --
// centre-of-mass orbits. Obliquity, precession, nutation and spin-orbit
// resonance are ROTATIONAL and live here.
//
// Scope of this first version (honest about its limits):
//   * axisymmetric bodies only (A = B < C); triaxial comes with the full
//     Euler-equation solver in M2
//   * "fast rotator" approximation: the spin axis follows the angular momentum
//     vector. Valid when the spin period is orders of magnitude shorter than the
//     precession period -- Earth: 1 day vs 25772 yr, so the error is ~1e-7.
//   * torque sources: gravitational gradient from point masses (J2 / C-A), and
//     tidal dissipation in the CTL and CPL parameterisations.
//
// What is NOT here yet: triaxial free precession, Chandler wobble, core-mantle
// coupling, planetary nutations beyond the forced terms, and thermal tides.

#ifndef STARPIVOT_SPIN_HPP
#define STARPIVOT_SPIN_HPP

#include <functional>
#include <string>

#include "starpivot/vec3.hpp"

namespace starpivot {

/// An axisymmetric spinning body.
///
/// `spin_axis` is the unit vector along the figure axis (the C axis) expressed
/// in the inertial frame. `spin_rate` is the magnitude of the angular velocity
/// about it, in rad per unit time.
struct SpinBody {
    std::string id;
    double mass = 0.0;
    double A = 0.0;          // equatorial principal moment
    double C = 0.0;          // polar principal moment (C > A)
    Vec3 spin_axis{0.0, 0.0, 1.0};
    double spin_rate = 0.0;  // rad / time
    Vec3 position;           // inertial-frame position of the centre of mass

    /// (C - A), the quantity the gradient torque scales with.
    double delta_inertia() const { return C - A; }
    /// Dynamical flattening (C - A) / C, i.e. the "H" of precession theory.
    double dynamical_flattening() const { return (C != 0.0) ? (C - A) / C : 0.0; }
};

/// Angular momentum L = A * w_perp + C * w_axial.
/// Under the fast-rotator approximation used here, L is parallel to the figure
/// axis and |L| = C * spin_rate.
Vec3 angular_momentum(const SpinBody& b);

/// Rotational kinetic energy.
double rotational_energy(const SpinBody& b);

/// Gravitational-gradient torque on an axisymmetric body from an external point
/// mass of gravitational parameter `mu` located at `r_ext` (inertial frame).
///
///   tau = (3 mu / r^3) * (C - A) * (n . rhat) * (rhat x n)
///
/// with n the figure axis and rhat the unit vector from the body to the
/// perturber. The order of the cross product is rhat x n (from r x (I.r));
/// reversing it flips the direction of precession. This is the torque that
/// produces axial precession, retrograde for a prograde rotator.
Vec3 gradient_torque(const SpinBody& b, double mu_ext, const Vec3& r_ext);

/// Analytic precession rate of the spin axis for a single circular-orbit
/// perturber, in rad per unit time. Used as the reference for verification.
///
///   psidot = -(3/2) * (n_orb^2 / w) * ((C - A) / C) * cos(obliquity)
///
/// Sign convention: negative means retrograde, as the Earth's is.
double analytic_precession_rate(const SpinBody& b, double mu_ext, double orbit_radius,
                                double obliquity);

/// Advance the spin axis under a supplied torque, using RK4 on dL/dt = tau.
/// `dt` is the step; `tau_fn` is called with the current body and returns the
/// inertial-frame torque.
void advance_spin_axis(SpinBody& b, double dt,
                       const std::function<Vec3(const SpinBody&)>& tau_fn);

/// Tidal torque, constant-time-lag (CTL) model.
///
/// Drives the spin rate toward the orbital mean motion and damps obliquity.
/// Returns the torque vector; `lag_time` is the constant time lag.
Vec3 tidal_torque_ctl(const SpinBody& b, double mu_ext, const Vec3& r_ext,
                      const Vec3& v_rel, double lag_time, double love_number);

/// Equilibrium (synchronous) spin rate for a circular orbit of radius r.
double mean_motion(double mu_total, double r);

}  // namespace starpivot

#endif  // STARPIVOT_SPIN_HPP
