// Verification of the collision module (detection / merge / fragmentation).
//
// These tests gate on conservation laws and on externally checkable physics,
// never on re-running the same formula forward:
//
//   1. Detection threshold   -> the pair is detected exactly when the
//      separation is <= r_i + r_j (not <, not with a fudge factor).
//   2. Merge conserves mass and momentum to round-off. Momentum is the
//      physically load-bearing one: a merge that "looks right" but drifts
//      momentum silently teleports the system's centre of mass.
//   3. Merge LOSES energy. Perfect accretion is completely inelastic; if the
//      merge ever increased total energy the model would be unphysical
//      (it would be an explosion). This is the test that catches a sign error
//      or a vis-viva mistake in the merged velocity.
//   4. Fragmentation conserves mass and momentum exactly, and the debris
//      cloud's kinetic energy exceeds the parent's by the dispersion term
//      (zero-mean kicks => sum |v_k|^2 = n * dispersion^2 in the mean).
//   5. Reproducibility: the same seed gives the same debris state bit for bit.
//   6. Directed splash (spray > 0): aiming the debris at the impactor's
//      approach direction must not cost a single conservation law, and the
//      "streak along the impact axis" claim must be measurable rather than
//      asserted -- so the anisotropy is compared against the spray = 0 case.
//
// NOT claimed (see collision.hpp): no equation of state, no tidal disruption,
// no ejecta mass law. The dispersion speed is a model parameter, not physics.

#include "starpivot/collision.hpp"
#include "starpivot/elements.hpp"

#include <cmath>
#include <string>
#include <vector>

#include <gtest/gtest.h>

namespace starpivot {
namespace {

constexpr double kKmPerAu = 1.495978707e8;

System two_bodies(const Vec3& ra, const Vec3& va, const Vec3& rb, const Vec3& vb,
                  double ma = 1.0, double mb = 1.0) {
    System s;
    s.G = 4.0 * 3.14159265358979323846 * 3.14159265358979323846;  // AU/Msun/yr
    s.bodies.emplace_back("a", ma, ra, va);
    s.bodies.emplace_back("b", mb, rb, vb);
    return s;
}

Vec3 momentum(const System& s) {
    Vec3 p;
    for (const Body& b : s.bodies) p = p + b.velocity * b.mass;
    return p;
}

double mass_sum(const System& s) {
    double m = 0.0;
    for (const Body& b : s.bodies) m += b.mass;
    return m;
}

TEST(Collision, DetectsOverlapExactlyAtRadiusSum) {
    // Planet-mass bodies: above CollisionSetup::star_mass_threshold a body is
    // treated as a star and skipped by default (see StarsExcludedByDefault).
    System s = two_bodies(Vec3(0, 0, 0), Vec3(), Vec3(1.0, 0, 0), Vec3(),
                          1e-6, 1e-6);
    CollisionSetup cs;
    cs.radii = {0.3, 0.3};           // sum = 0.6, separation 1.0 -> no overlap

    std::size_t i = 0, j = 0; double d = -1;
    EXPECT_FALSE(find_collision(s, cs, i, j, d));

    cs.radii = {0.5, 0.5};           // sum = 1.0 == separation -> overlap (<=)
    ASSERT_TRUE(find_collision(s, cs, i, j, d));
    EXPECT_EQ(i, 0u); EXPECT_EQ(j, 1u);
    EXPECT_NEAR(d, 1.0, 1e-15);

    s.bodies[1].position = Vec3(0.9, 0, 0);
    ASSERT_TRUE(find_collision(s, cs, i, j, d));
    EXPECT_NEAR(d, 0.9, 1e-15);
}

TEST(Collision, StarsExcludedFromDetectionUnlessSwitchIsOn) {
    // A Sun-mass body overlapping a planet is NOT a collision by default: real
    // simulations inflate radii by 1e2-1e5, and a 3000x Sun (~14 AU) would
    // otherwise swallow the inner planets before anything else can happen.
    // This is a usability switch, so it must be off by default AND reported.
    System s = two_bodies(Vec3(0, 0, 0), Vec3(), Vec3(0.01, 0, 0), Vec3(),
                          1.0, 1e-6);
    CollisionSetup cs;
    cs.radii = {0.5, 0.5};
    std::size_t i = 0, j = 0; double d = -1;
    EXPECT_FALSE(find_collision(s, cs, i, j, d)) << "star excluded by default";

    cs.stars_collide = true;
    ASSERT_TRUE(find_collision(s, cs, i, j, d)) << "switch must re-enable it";
    EXPECT_NEAR(d, 0.01, 1e-15);
}

TEST(Collision, MergeConservesMassAndMomentum) {
    // Two unequal masses on a crossing course, deliberately asymmetric.
    System s = two_bodies(Vec3(0, 0, 0), Vec3(0.1, 0.2, -0.05),
                          Vec3(0.4, 0, 0), Vec3(-0.3, 0.05, 0.2),
                          3.0, 1.0);
    const double m0 = mass_sum(s);
    const Vec3 p0 = momentum(s);

    CollisionEvent ev{};
    ASSERT_TRUE(merge_bodies(s, 0, 1, &ev));
    ASSERT_EQ(s.size(), 1u);

    EXPECT_NEAR(mass_sum(s), m0, 1e-15) << "mass must add";
    EXPECT_NEAR((momentum(s) - p0).norm(), 0.0, 1e-14) << "momentum must be conserved";
    EXPECT_NEAR(s.bodies[0].mass, 4.0, 1e-15);
    // Centre of mass position, mass-weighted.
    const Vec3 com = (Vec3(0, 0, 0) * 3.0 + Vec3(0.4, 0, 0) * 1.0) / 4.0;
    EXPECT_LT((s.bodies[0].position - com).norm(), 1e-15);
    EXPECT_NEAR(ev.relative_speed, (Vec3(0.1, 0.2, -0.05) - Vec3(-0.3, 0.05, 0.2)).norm(),
                1e-14);
}

TEST(Collision, PerfectAccretionAlwaysLosesEnergy) {
    // Head-on collision: the classic completely-inelastic case, where the
    // kinetic-energy loss is maximal and analytically known.
    //
    // G = 0 ON PURPOSE. With gravity on, merging two bodies also destroys their
    // mutual potential-energy term, and for a pair 0.5 AU apart that term
    // (-G m1 m2 / r ~ -79) swamps the kinetic loss (-1) — the total-energy
    // change then says nothing about the merge model. Setting G = 0 isolates
    // what merge_bodies actually claims: it dissipates the COM-frame relative
    // kinetic energy, exactly.
    System s = two_bodies(Vec3(0, 0, 0), Vec3(1.0, 0, 0),
                          Vec3(0.5, 0, 0), Vec3(-1.0, 0, 0), 1.0, 1.0);
    s.G = 0.0;
    const double e_before = total_energy(s);
    CollisionEvent ev{};
    ASSERT_TRUE(merge_bodies(s, 0, 1, &ev));

    EXPECT_LT(ev.energy_delta, 0.0) << "perfect accretion must lose energy";
    // Two equal masses at +/- 1 length/time: merged body is at rest in the
    // centre-of-mass frame, so ALL relative kinetic energy is dissipated.
    EXPECT_NEAR(s.bodies[0].velocity.norm(), 0.0, 1e-15);
    // Energy drop = pre-merge kinetic energy in the COM frame:
    //   0.5 * mu * |dv|^2, mu = m1*m2/(m1+m2) = 0.5, |dv| = 2  ->  1.0
    EXPECT_NEAR(ev.energy_delta, -1.0, 1e-12);
    EXPECT_NEAR(total_energy(s), e_before + ev.energy_delta, 1e-12);
}

TEST(Collision, FragmentationConservesMassAndMomentum) {
    // G = 0 again: with self-gravity on, a debris cloud at 1e-4 AU spacing has
    // a binding energy of ~-2.6e6, which dwarfs the dispersion energy. The
    // model's claim is about momentum + kinetic energy, so test that cleanly.
    System s;
    s.G = 0.0;
    s.bodies.emplace_back("parent", 4.0, Vec3(1.0, 0.0, 0.0), Vec3(0.0, 3.0, 0.0));
    const double m0 = mass_sum(s);
    const Vec3 p0 = momentum(s);
    const double e0 = total_energy(s);
    const double disp = 0.05, m = 4.0;

    CollisionEvent ev{};
    ASSERT_TRUE(fragment_body(s, 0, 6, disp, 1e-4, 12345, &ev));
    ASSERT_EQ(s.size(), 6u);

    EXPECT_NEAR(mass_sum(s), m0, 1e-15) << "debris mass must sum to the parent";
    EXPECT_NEAR((momentum(s) - p0).norm(), 0.0, 1e-14)
        << "debris momentum must equal the parent's (kicks are de-meaned)";
    for (const Body& b : s.bodies) EXPECT_NEAR(b.mass, m / 6.0, 1e-15);
    EXPECT_GT(ev.energy_delta, 0.0) << "dispersion adds kinetic energy";
    // The added energy is 0.5 (m/n) sum |kick_k|^2 with de-meaned unit kicks
    // scaled by `dispersion`, i.e. ~0.5 * m * dispersion^2 (within a factor 2).
    EXPECT_LT(ev.energy_delta, 0.5 * m * disp * disp * 2.0);
    EXPECT_NEAR(total_energy(s) - e0, ev.energy_delta, 1e-12);

    // Every fragment sits on the debris ring: at most `spread` from the parent
    // position, and none of them coincides with it (which would blow up the
    // un-softened force kernel).
    for (const Body& b : s.bodies) {
        const double d = (b.position - Vec3(1.0, 0.0, 0.0)).norm();
        EXPECT_LE(d, 1e-4 + 1e-15);
        EXPECT_GT(d, 1e-9);
    }
}

TEST(Collision, FragmentationConservesMomentumWithSelfGravity) {
    // Same operation with gravity ON: conservation laws must still hold
    // exactly (this is the case the simulation actually runs), while the
    // energy bookkeeping now legitimately includes the debris binding energy.
    System s;
    s.G = 39.47841760435743;
    s.bodies.emplace_back("Sun", 1.0, Vec3(), Vec3());
    s.bodies.emplace_back("parent", 1e-3, Vec3(1.0, 0.0, 0.0), Vec3(0.0, 6.2832, 0.0));
    const double m0 = mass_sum(s);
    const Vec3 p0 = momentum(s);

    CollisionEvent ev{};
    ASSERT_TRUE(fragment_body(s, 1, 5, 0.02, 1e-5, 4242, &ev));
    ASSERT_EQ(s.size(), 6u);
    EXPECT_NEAR(mass_sum(s), m0, 1e-15);
    EXPECT_NEAR((momentum(s) - p0).norm(), 0.0, 1e-14);
    EXPECT_NEAR(total_energy(s), ev.energy_after, 1e-12)
        << "event energy must be the recomputed system energy";
}

TEST(Collision, DirectedSplashKeepsConservationAndStretchesAlongTheAxis) {
    // 两颗天体近心点方向相反 → 撞击来向就是 +x。母体放在原点、初速为零，
    // 这样"沿轴的展宽"与"面内的展宽"是直接可比的，不用先把母体运动扣掉。
    const Vec3 approach(1.0, 0.0, 0.0);

    auto build = [&](double spray) {
        System s;
        s.G = 0.0;
        s.bodies.emplace_back("parent", 4.0, Vec3(0, 0, 0), Vec3(0, 0, 0));
        return s;
    };
    const double disp = 0.05;

    // ---- 负样本那一半：spray = 0 必须还是"原来那个" ----
    // 原来的确定性平面（母体在原点时 axis=(0,1,0)、u=(1,0,0)）让所有碎块都落在
    // z = 0 这张平面上。这条不成立就说明"库的默认行为被改掉了"。
    {
        System s = build(0.0);
        CollisionEvent ev{};
        ASSERT_TRUE(fragment_body(s, 0, 6, disp, 1e-4, 999, &ev, &approach, 0.0));
        for (const Body& b : s.bodies)
            EXPECT_NEAR(b.position.z, 0.0, 1e-15)
                << "spray=0 必须保持原来的碎屑环平面（库的默认行为）";
    }

    // ---- 被测项：spray = 0.8 ----
    System s = build(0.8);
    const double m0 = mass_sum(s);
    const Vec3 p0 = momentum(s);
    CollisionEvent ev{};
    ASSERT_TRUE(fragment_body(s, 0, 6, disp, 1e-4, 999, &ev, &approach, 0.8));
    ASSERT_EQ(s.size(), 6u);

    // 守恒律一条都不许丢 —— 而且这里**刻意先不依赖去均值**：面内径向与沿轴剪切
    // 都是按"和恒为零"构造的，所以动量精确是构造出来的，不是修出来的。
    EXPECT_NEAR(mass_sum(s), m0, 1e-15) << "质量必须精确守恒";
    EXPECT_NEAR((momentum(s) - p0).norm(), 0.0, 1e-14)
        << "定向溅射不许花掉动量守恒";

    // 几何：环面垂直于来向 → 所有碎块有同一个 x（环心沿 +x 平移过），
    // 而 y / z 在半径 ring 上散开。这正是"从哪里被打出来的"看得出来的一半。
    const double x0 = s.bodies[0].position.x;
    EXPECT_GT(x0, 0.0) << "环心应当被沿来向抛向前方";
    double xy_extent = 0.0;
    for (const Body& b : s.bodies) {
        EXPECT_NEAR(b.position.x, x0, 1e-15) << "环面必须垂直于来向";
        xy_extent = std::max(xy_extent, std::hypot(b.position.y, b.position.z));
    }
    EXPECT_GT(xy_extent, 0.0) << "碎块应在垂直于来向的面上摊开";

    // "成束"必须是量出来的：沿轴的速度 RMS 要明显大于横向。
    // 若把轴向系数改回 1，这条会红（横向 1/√2 大于轴向 1）—— 这就是它的用处。
    double v_ax = 0.0, v_tr = 0.0;
    for (const Body& b : s.bodies) {
        const Vec3 v = b.velocity - Vec3(0, 0, 0);
        v_ax += v.x * v.x;
        v_tr += v.y * v.y + v.z * v.z;
    }
    v_ax = std::sqrt(v_ax / 6.0);
    v_tr = std::sqrt(v_tr / 6.0);
    EXPECT_GT(v_ax, 1.25 * v_tr)
        << "沿撞击来向的速度展宽必须大于横向（否则是扁盘不是束）: "
        << v_ax << " vs " << v_tr;
}

TEST(Collision, FragmentationIsDeterministicForASeed) {
    const int n = 5;
    std::vector<Vec3> v1, v2;
    for (int run = 0; run < 2; ++run) {
        System s;
        s.G = 39.47841760435743;
        s.bodies.emplace_back("p", 2.0, Vec3(0, 0, 0), Vec3(0, 0, 0));
        ASSERT_TRUE(fragment_body(s, 0, n, 0.1, 1e-3, 777u));
        std::vector<Vec3>& out = (run == 0) ? v1 : v2;
        for (const Body& b : s.bodies) out.push_back(b.velocity);
    }
    ASSERT_EQ(v1.size(), v2.size());
    for (std::size_t k = 0; k < v1.size(); ++k)
        EXPECT_LT((v1[k] - v2[k]).norm(), 1e-18) << "same seed must reproduce debris";
}

TEST(Collision, KnownRadiiCoverTheSolarSystem) {
    bool ok = false;
    EXPECT_NEAR(known_radius_km("Earth", &ok), 6371.0, 1e-9);
    EXPECT_TRUE(ok);
    EXPECT_NEAR(known_radius_km("Jupiter", &ok), 69911.0, 1e-9);
    EXPECT_TRUE(ok);
    ok = true;
    EXPECT_EQ(known_radius_km("PlanetX", &ok), 0.0);
    EXPECT_FALSE(ok);
    // Merging two Earths must give a sphere of the same bulk density:
    // r = (2)^(1/3) * r_earth.
    const double r = merged_radius(6371.0, 6371.0);
    EXPECT_NEAR(r, 6371.0 * std::cbrt(2.0), 1e-9);
}

}  // namespace
}  // namespace starpivot
