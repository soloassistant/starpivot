// starpivot/elements.hpp -- osculating orbital elements and energy diagnostics.

#ifndef STARPIVOT_ELEMENTS_HPP
#define STARPIVOT_ELEMENTS_HPP

#include "starpivot/system.hpp"
#include "starpivot/vec3.hpp"

namespace starpivot {

/// Osculating Keplerian elements of `orbiting` relative to `central`.
struct OrbitalElements {
    double semi_major_axis = 0.0;  // a
    double eccentricity = 0.0;     // e
    double inclination = 0.0;      // radians, w.r.t. the XY plane
    double period = 0.0;           // Keplerian period from a and mu
    bool bound = false;            // false if the pair is unbound (a <= 0)
};

OrbitalElements compute_elements(const Body& central, const Body& orbiting, double G);

/// Total mechanical energy (kinetic + potential) of the whole system.
double total_energy(const System& sys);

/// Total linear momentum. Should stay constant to round-off for any
/// internally-consistent force law; used as a cheap symmetry check.
Vec3 total_momentum(const System& sys);

/// Centre-of-mass position.
Vec3 center_of_mass(const System& sys);

/// Shift to the barycentric frame. Call once after building a system so that
/// diagnostics are not polluted by drift of the whole system.
void to_barycentric(System& sys);

}  // namespace starpivot

#endif  // STARPIVOT_ELEMENTS_HPP
