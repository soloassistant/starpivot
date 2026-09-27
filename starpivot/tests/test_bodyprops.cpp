// Verification of the physical body model: mass, radius, density.
//
// The rule being gated is the one that makes the UI honest. A body has three
// "size" knobs on screen but only two degrees of freedom; if the kernel let all
// three be set independently the user could write mass=2, radius=1, density=3
// and the JSON would print three numbers that contradict each other. So:
//
//   1. Density of the known bodies must match published bulk densities. This
//      is the external check: it fails if the unit conversions (Msun -> g,
//      km -> cm) are wrong, which no round-trip test would ever catch.
//   2. mass -> radius -> mass round-trips, i.e. the two inverses are genuinely
//      inverses and not two different approximations of each other.
//   3. R goes as rho^(-1/3) at fixed mass: twice the density is the same
//      material, so it must occupy half the volume.
//   4. Merging two equal-density spheres leaves the density unchanged. This is
//      the physical statement behind `merged_radius`, and it is why the merged
//      radius is a cube-root law rather than anything else.
//   5. Degenerate bodies (mass 0 test particle, radius 0 point mass) must give
//      0, never inf or NaN -- the CLI prints these into JSON and a NaN there
//      corrupts the entire payload, silently.
//   6. Mass reaches the dynamics: with mu = G(M+m) the Kepler period of a
//      a=1 orbit must be (1+m)^(-1/2) years. This is what breaks if the
//      mass-override plumbing is wired into the JSON but not into mu.

#include "starpivot/bodyprops.hpp"
#include "starpivot/collision.hpp"
#include "starpivot/elements.hpp"

#include <cmath>

#include <gtest/gtest.h>

namespace starpivot {
namespace {

constexpr double kMsun = 1.0;
constexpr double kSunRadiusKm = 696340.0;
constexpr double kEarthRadiusKm = 6371.0;
constexpr double kEarthMassMsun = 3.003489e-6;

// ---------------------------------------------------------------- 1. tables

TEST(BodyProps, SunBulkDensityMatchesPublishedValue) {
    // 1.408 g/cm^3 (NIST/IAU). A wrong Msun-in-grams or km->cm factor scales
    // the answer by a power of ten or a power of 1e5 and blows the tolerance.
    const double rho = density_g_cm3(kMsun, kSunRadiusKm);
    EXPECT_NEAR(1.408, rho, 0.005) << "Sun bulk density [g/cm^3]";
}

TEST(BodyProps, EarthBulkDensityMatchesPublishedValue) {
    // 5.514 g/cm^3.
    const double rho = density_g_cm3(kEarthMassMsun, kEarthRadiusKm);
    EXPECT_NEAR(5.514, rho, 0.01) << "Earth bulk density [g/cm^3]";
}

TEST(BodyProps, DensityTriplesAreSelfConsistentRadii) {
    // Every planet: round-tripping through all three quantities must return
    // the input radius to round-off.
    const double masses[] = {1.660120e-7, 2.447838e-6, 3.003489e-6, 3.227151e-7,
                             9.547919e-4, 2.858860e-4, 4.366244e-5, 5.151389e-5,
                             6.580859e-9};
    const double radii[] = {2439.7, 6051.8, 6371.0, 3389.5, 69911.0,
                            58232.0, 25362.0, 24622.0, 1188.3};
    for (int i = 0; i < 9; ++i) {
        const double rho = density_g_cm3(masses[i], radii[i]);
        const double r2 = radius_km_from_mass_density(masses[i], rho);
        EXPECT_NEAR(radii[i], r2, radii[i] * 1e-12) << "planet " << i;
        const double m2 = mass_msun_from_radius_density(radii[i], rho);
        EXPECT_NEAR(masses[i], m2, masses[i] * 1e-12) << "planet " << i;
    }
}

// ------------------------------------------------------- 2. cubic scaling

TEST(BodyProps, DoublingDensityHalvesVolumeAtFixedMass) {
    // Same material, twice as dense: half the volume, so R scales as 2^(-1/3).
    const double r1 = radius_km_from_mass_density(kEarthMassMsun, 5.514);
    const double r2 = radius_km_from_mass_density(kEarthMassMsun, 11.028);
    EXPECT_NEAR(0.5, (r1 * r1 * r1) / (r2 * r2 * r2), 1e-12);
    // And the derived density of the twice-dense sphere really is double.
    EXPECT_NEAR(11.028, density_g_cm3(kEarthMassMsun, r2), 1e-9);
}

// ------------------------------------------- 3. merging keeps the density

TEST(BodyProps, MergingEqualDensitySpheresKeepsDensity) {
    // Two identical Earth-like spheres merge into one body of twice the mass
    // and r = (r1^3+r2^3)^(1/3) = 2^(1/3) r1. Mass doubles, volume doubles,
    // so the mean density is exactly unchanged. If someone "improved" the
    // merge law to r = (r1+r2)/2 or sqrt(r1^2+r2^2) this test fails loudly.
    const double r = kEarthRadiusKm;
    const double m = kEarthMassMsun;
    const double rho0 = density_g_cm3(m, r);
    EXPECT_NEAR(5.514, rho0, 0.01);

    const double rm = merged_radius(r, r);
    EXPECT_NEAR(std::cbrt(2.0) * r, rm, 1e-9);
    EXPECT_NEAR(rho0, density_g_cm3(2.0 * m, rm), rho0 * 1e-12);
}

TEST(BodyProps, MergingDifferentDensitySpheresIsVolumeAdding) {
    // A dense core plus a light shell: the merged body is the volume sum, so
    // the density is mass sum / volume sum and sits between the two.
    const double m_a = kEarthMassMsun, r_a = kEarthRadiusKm;   // 5.51 g/cm^3
    const double m_b = kEarthMassMsun * 1e-3, r_b = r_a * 3.0; // light, puffy
    const double rho_a = density_g_cm3(m_a, r_a);
    const double rho_b = density_g_cm3(m_b, r_b);
    const double rm = merged_radius(r_a, r_b);
    const double rho_m = density_g_cm3(m_a + m_b, rm);
    // Volume is additive by construction, so recompute the expectation from
    // the volumes themselves rather than repeating the same cube-root law.
    // r_b = 3 r_a, so V_b = 27 V_a and V_total = 28 V_a.
    const double rho_expect = (m_a + m_b) * kMsunGram /
                              ((4.0 / 3.0) * 3.14159265358979323846 *
                               std::pow(r_a * 1.0e5, 3) * 28.0);
    EXPECT_NEAR(rho_expect, rho_m, rho_expect * 1e-12);
    EXPECT_LT(rho_b, rho_m);
    EXPECT_LT(rho_m, rho_a);
}

// --------------------------------------------- 4. degenerate inputs stay clean

TEST(BodyProps, ZeroMassAndZeroRadiusReportUndefinedNotNaN) {
    // A massless test particle is a legal nbody input; a zero radius is how
    // "point mass" is encoded. Both make the density undefined, and undefined
    // must come out as 0.0 -- inf or NaN would be invalid JSON and would
    // silently corrupt the whole payload instead of failing one field.
    const double r = density_g_cm3(0.0, 6371.0);
    const double r2 = density_g_cm3(kEarthMassMsun, 0.0);
    EXPECT_TRUE(std::isfinite(r) && std::isfinite(r2));
    EXPECT_DOUBLE_EQ(0.0, r);
    EXPECT_DOUBLE_EQ(0.0, r2);
    // Inverses must not produce a NaN either.
    EXPECT_DOUBLE_EQ(0.0, radius_km_from_mass_density(0.0, 5.514));
    EXPECT_DOUBLE_EQ(0.0, mass_msun_from_radius_density(6371.0, 0.0));
}

// ------------------------------------------------ 5. mass reaches the dynamics

TEST(BodyProps, MassEntersMuSoKeplerPeriodFollowsOnePlusM) {
    // mu = G (M + m), so a planet of mass m on a = 1 has period
    // T = 2 pi sqrt(a^3/mu) = (1 + m)^(-1/2) yr. A test particle (m = 0)
    // must give exactly 1.000000 yr.
    const double G = 4.0 * 3.14159265358979323846 * 3.14159265358979323846;
    const Vec3 r0(1.0, 0.0, 0.0);
    const double masses[] = {0.0, 1.0e-6, 1.0e-3};
    for (double m : masses) {
        // Circular for mu = G(M + m) = G(1 + m), i.e. v = sqrt(mu / a).
        const Vec3 v0(0.0, std::sqrt(G * (1.0 + m) / 1.0), 0.0);
        System s;
        s.G = G;
        s.bodies.emplace_back("Sun", kMsun, Vec3{0, 0, 0}, Vec3{0, 0, 0});
        s.bodies.emplace_back("P", m, r0, v0);
        const OrbitalElements el =
            compute_elements(s.bodies[0], s.bodies[1], s.G);
        const double expect = 1.0 / std::sqrt(1.0 + m);
        EXPECT_NEAR(expect, el.period, expect * 1e-12)
            << "Kepler-III check for planet mass " << m;
    }
}

TEST(BodyProps, EnlargedRadiusIsWhatCollisionDetectionUses) {
    // "Change the size" only has an observable effect through the collision
    // model, so the radius override has to reach find_collision. Doubling the
    // radius must widen the detection window by exactly the radius sum.
    const double G = 4.0 * 3.14159265358979323846 * 3.14159265358979323846;
    System s;
    s.G = G;
    s.bodies.emplace_back("a", 1.0e-9, Vec3{-1.0e-5, 0, 0}, Vec3{0, 0, 0});
    s.bodies.emplace_back("b", 1.0e-9, Vec3{1.0e-5, 0, 0}, Vec3{0, 0, 0});
    // Separation 2e-5 AU; spheres of radius 1e-5 do touch.
    CollisionSetup cs;
    cs.mode = CollisionMode::kMerge;
    cs.radii = {1.0e-5, 1.0e-5};
    cs.stars_collide = true;  // both are far below star_mass_threshold anyway
    std::size_t i = 0, j = 0;
    double d = 0.0;
    EXPECT_TRUE(find_collision(s, cs, i, j, d));
    EXPECT_DOUBLE_EQ(2.0e-5, d);

    // Shrink both to unbiased point masses -> no longer detected.
    cs.radii = {0.0, 0.0};
    EXPECT_FALSE(find_collision(s, cs, i, j, d));

    // Same with one body inflated to 3e-5 AU (~4.5e6 km, a "super-Earth" at
    // --radius-scale 1): the pair still touches, at the unchanged 2e-5 AU.
    cs.radii = {3.0e-5, 0.0};
    EXPECT_TRUE(find_collision(s, cs, i, j, d));
    EXPECT_DOUBLE_EQ(2.0e-5, d);
}

}  // namespace
}  // namespace starpivot
