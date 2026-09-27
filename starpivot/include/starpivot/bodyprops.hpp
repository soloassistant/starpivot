// starpivot/bodyprops.hpp -- physical body model: mass, radius, density.
//
// Why this exists
// ---------------
// Once a user can edit a body's "size" and "mass", the tempting model is three
// independent knobs. It is not: for a uniform sphere
//
//     rho = M / (4/3 * pi * R^3)
//
// so exactly TWO of {M, R, rho} are free and the third is derived. Making all
// three editable independently would let the user set mass=2, radius=1,
// density=3 and get a body that violates its own definition -- a silent
// contradiction. This module makes the dependency explicit and puts the
// derivation in the kernel, so the CLI and the viewer cannot disagree.
//
// Unit conventions (all conversions happen here, once):
//   mass    Msun      1.98892e33 g
//   radius  km
//   density g/cm^3    the quantity a human reads off a table
//
// Degenerate inputs are a real case, not an error condition: a test particle
// has mass 0 and a collision model may use radius 0 (point mass). Both make
// the density undefined. The functions below return 0.0 for "undefined"
// rather than inf/NaN, because inf and NaN are not representable in JSON and
// would silently poison the whole payload. Callers that care can re-derive.
//
// What is NOT claimed: this is a bulk (mean) density of a uniform sphere.
// No internal structure, no central compact core + envelope, no
// pressure/temperature/EOS, no mass-radius relation for degenerate matter.
// A mass of 10 Msun squeezed into 1 km is accepted at face value -- the number
// is reported, the physics of what it would actually be (a black hole) is not
// modelled and not claimed.

#ifndef STARPIVOT_BODYPROPS_HPP
#define STARPIVOT_BODYPROPS_HPP

namespace starpivot {

/// IAU nominal solar mass in grams.
constexpr double kMsunGram = 1.98892e33;
/// km -> cm.
constexpr double kKmToCm = 1.0e5;

/// Volume of a uniform sphere [cm^3] from its radius [km].
double sphere_volume_cm3(double radius_km);

/// Mean bulk density [g/cm^3]. Returns 0.0 (undefined) when mass <= 0 or
/// radius <= 0 -- a massless test particle and a point mass have no density.
double density_g_cm3(double mass_msun, double radius_km);

/// Mass [Msun] that a uniform sphere of radius [km] and density [g/cm^3]
/// must have. Returns 0.0 when the density is not positive or the radius is 0.
double mass_msun_from_radius_density(double radius_km, double density_g_cm3);

/// Radius [km] of a uniform sphere of mass [Msun] and density [g/cm^3].
/// Returns 0.0 when the mass is not positive or the density is not positive.
double radius_km_from_mass_density(double mass_msun, double density_g_cm3);

}  // namespace starpivot

#endif  // STARPIVOT_BODYPROPS_HPP
