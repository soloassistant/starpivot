// starpivot/src/bodyprops.cpp -- see bodyprops.hpp for the model and its limits.

#include "starpivot/bodyprops.hpp"

#include <cmath>

namespace starpivot {

double sphere_volume_cm3(double radius_km) {
    const double rc = (radius_km > 0.0) ? radius_km * kKmToCm : 0.0;
    const double rc3 = rc * rc * rc;
    return (4.0 / 3.0) * 3.14159265358979323846 * rc3;
}

double density_g_cm3(double mass_msun, double radius_km) {
    if (!(mass_msun > 0.0) || !(radius_km > 0.0)) return 0.0;  // undefined
    return mass_msun * kMsunGram / sphere_volume_cm3(radius_km);
}

double mass_msun_from_radius_density(double radius_km, double density_g_cm3) {
    if (!(density_g_cm3 > 0.0) || !(radius_km > 0.0)) return 0.0;
    return density_g_cm3 * sphere_volume_cm3(radius_km) / kMsunGram;
}

double radius_km_from_mass_density(double mass_msun, double density_g_cm3) {
    if (!(mass_msun > 0.0) || !(density_g_cm3 > 0.0)) return 0.0;
    // R = (3 M / (4 pi rho))^(1/3); guard the round-off that can push the
    // inside of the cube root slightly negative near a zero density.
    const double v = (3.0 * mass_msun * kMsunGram) /
                     (4.0 * 3.14159265358979323846 * density_g_cm3);
    return (v > 0.0) ? std::cbrt(v) * 1.0e-5 : 0.0;
}

}  // namespace starpivot
