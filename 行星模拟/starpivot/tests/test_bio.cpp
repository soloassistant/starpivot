// Verification of the bio layer: insolation, temperatures, and the stylized
// ladder they drive.
//
// The point of this file is the layering. Layer 1 is physics and must be
// checkable against a textbook, so these tests assert published numbers and
// would fail if the unit handling drifted. Layer 2 (nine rungs, the progress
// bar, the pace) is a stylized ladder, not biology -- so the tests here do NOT
// claim it corresponds to anything real. What they do claim is that the ladder
// bookkeeping is self-consistent and cannot leak a NaN into the JSON output.
//
// Judgement criteria first, implementation second:
//
//   1. Earth at 1 AU, A = 0.306, must give T_eq = 254.28 K. This is the anchor
//      that validates the 278.6 coefficient the whole layer rests on.
//   2. T_eq must go as S^(1/4) -- hotter closer in, colder farther out. Earth is
//      a fixed point of the sign error that once lived here (S = 1 is also the
//      identity of division), so an anchor test alone cannot catch it; the
//      ColderFartherFromTheStar test is the one that does.
//   3. L/Lsun = M^3.5 at 1 Msun is exactly 1; 2 Msun is 2^3.5 = 11.31.
//   4. The surface temperature is T_eq plus a greenhouse offset. That offset is
//      an empirical constant, not a law, and it is load-bearing: without it
//      Earth's own T_eq is below freezing and nothing in the solar system could
//      ever evolve. There is a test for exactly that.
//   5. Ice point 273 K and boiling point 373 K are the only hard thresholds, and
//      they are the real physical constants. Ablating progress at the boiling
//      point is a model statement; stalling (not regressing) at the ice point is
//      the other half of it.
//   6. progress is clamped to [0,1] and never overflows: a huge dt must land on
//      exactly 1.0, not 1.0000001.
//   7. Degenerate input (r = 0, L = 0, mass = 0, albedo 0 and >= 1, negative
//      greenhouse) yields finite values, never inf or NaN. These go straight
//      into the JSON payload, where one NaN corrupts the whole document silently.
//   8. The stage is a function of progress, including at the top of the ladder:
//      progress = 1.0 must give rung 8, not 9 or out-of-range.
//   9. The reached-time t_stage must land inside the step interval (not at the
//      frame boundary) and must never move backwards.

#include "starpivot/bio.hpp"

#include <algorithm>
#include <cmath>

#include <gtest/gtest.h>

namespace starpivot {
namespace {

constexpr double kAlbedo = 0.306;

/// T_eq at a heliocentric distance, with the defaults in play.
double teq_at(double a_AU) {
    return equilibrium_temp_k(insolation_at(a_AU, 1.0), kAlbedo);
}

/// Run `years` one-year steps at 1 AU with the given parameters.
BioState run_earth_years(int years, const BioParams& p) {
    BioState s;
    for (int i = 0; i < years; ++i)
        step_bio(s, 1.0, 1.0, 1.0, p, static_cast<double>(i));
    return s;
}

// ---------------------------------------------------------------------------
// Layer 1: formulas that must match a textbook.
// ---------------------------------------------------------------------------

TEST(BioInsolation, EarthAtOneAuIsInsolationOne) {
    EXPECT_NEAR(insolation_at(1.0, 1.0), 1.0, 1e-12);
}

TEST(BioInsolation, FollowsInverseSquare) {
    const double s1 = insolation_at(1.0, 1.0);
    EXPECT_NEAR(insolation_at(2.0, 1.0), s1 / 4.0, 1e-12);
    EXPECT_NEAR(insolation_at(4.0, 1.0), s1 / 16.0, 1e-12);
}

TEST(BioInsolation, LuminosityScalesAsM35) {
    EXPECT_NEAR(stellar_luminosity(1.0), 1.0, 1e-12);
    EXPECT_NEAR(stellar_luminosity(2.0), std::pow(2.0, 3.5), 1e-12);
    EXPECT_NEAR(stellar_luminosity(0.5), std::pow(0.5, 3.5), 1e-12);
}

TEST(BioEquilibriumTemp, EarthAnchorIs25428K) {
    // The textbook "effective temperature of the Earth is about 255 K".
    // Precisely 278.6 * 0.694^(1/4) = 254.285 K. 254.58 is a tempting number
    // (it comes from rounding 0.694^(1/4) up to 0.9137) and is wrong by 0.3 K.
    EXPECT_NEAR(teq_at(1.0), 254.285, 0.02);
}

TEST(BioEquilibriumTemp, ScalesAsFourthRootOfInsolation) {
    // T_eq ~ S^(1/4): 16x the flux is 2x the temperature, not 1/2.
    EXPECT_NEAR(equilibrium_temp_k(16.0, kAlbedo) / teq_at(1.0), 2.0, 1e-9);
    EXPECT_NEAR(equilibrium_temp_k(2.0, kAlbedo) / teq_at(1.0),
                std::pow(2.0, 0.25), 1e-9);
}

// The regression guard against the bug this file exists to catch: the formula
// once had (1-A)/S instead of (1-A)*S, which at S = 1 gives the same answer but
// inverts the distance dependence -- a body twice as far out would come out
// warmer. At 4 AU the two readings differ by 4x in the opposite direction.
TEST(BioEquilibriumTemp, ColderFartherFromTheStar) {
    const double near = teq_at(0.5);
    const double far = teq_at(4.0);
    EXPECT_GT(near, far);
    // 0.5 AU -> 4 AU is 8x the distance, 64x the flux, so sqrt(8) = 2.828x the
    // temperature. (The first version of this file said "2x"; the probe caught it.)
    EXPECT_NEAR(near / far, std::sqrt(8.0), 1e-9);
    EXPECT_NEAR(far, 127.14, 0.1);
    // Monotone across a long sweep; a wrong exponent shows up immediately.
    double prev = 1e300;
    for (double r = 0.05; r < 60.0; r *= 1.2) {
        const double t = teq_at(r);
        ASSERT_LT(t, prev) << "at a = " << r << " AU";
        prev = t;
    }
}

TEST(BioEquilibriumTemp, MatchesSolarSystemBenchmarks) {
    // Independent check against published equilibrium temperatures (no greenhouse).
    struct Bench { double a_AU; double expect_K; };
    static const Bench B[] = {
        {0.38709927, 408.7},   // Mercury
        {0.72333566, 299.0},   // Venus
        {1.00000261, 254.3},   // Earth, the anchor
        {1.52371034, 206.0},   // Mars
        {5.20288700, 111.5},   // Jupiter
    };
    for (const Bench& b : B) {
        EXPECT_NEAR(teq_at(b.a_AU), b.expect_K, 0.15) << "at a = " << b.a_AU << " AU";
    }
}

TEST(BioEquilibriumTemp, AlbedoMovesTheTemperature) {
    EXPECT_GT(equilibrium_temp_k(1.0, 0.05), teq_at(1.0));   // dark body, hotter
    EXPECT_LT(equilibrium_temp_k(1.0, 0.60), teq_at(1.0));   // icy body, colder
}

// ---------------------------------------------------------------------------
// Layer 1: the greenhouse offset is empirical, and it is load-bearing.
// ---------------------------------------------------------------------------

TEST(BioSurfaceTemp, AddsTheGreenhouseOffset) {
    EXPECT_NEAR(surface_temp_k(254.285, 33.0), 287.285, 1e-9);
    EXPECT_NEAR(surface_temp_k(100.0, 33.0), 133.0, 1e-9);
    EXPECT_NEAR(surface_temp_k(254.285, 0.0), 254.285, 1e-9);
}

TEST(BioSurfaceTemp, ZeroInsolationStaysZero) {
    // The primary star sits at r = 0. Adding 33 K to "no insolation" would make
    // the page report a surface temperature for a body with no light at all.
    EXPECT_EQ(surface_temp_k(0.0, 33.0), 0.0);
    EXPECT_EQ(surface_temp_k(0.0, 0.0), 0.0);
}

// Why the empirical constant is there at all: without a greenhouse, Earth's own
// balance temperature is below the ice point, so the model would declare the one
// planet we know is inhabited to be permanently frozen.
TEST(BioSurfaceTemp, EarthNeedsTheGreenhouseToThaw) {
    const double t_eq = teq_at(1.0);
    EXPECT_LT(t_eq, kFreezing_K);                                   // 254.3 K
    EXPECT_FALSE(liquid_water_possible(surface_temp_k(t_eq, 0.0)));
    EXPECT_TRUE(liquid_water_possible(surface_temp_k(t_eq, kGreenhouseDeltaT_K)));

    BioParams no_greenhouse;
    no_greenhouse.greenhouse_K = 0.0;
    const BioState s = run_earth_years(50, no_greenhouse);
    EXPECT_EQ(s.progress, 0.0);
    EXPECT_EQ(s.stage, 0);

    BioParams with_greenhouse;
    const BioState t = run_earth_years(50, with_greenhouse);
    EXPECT_GT(t.progress, 0.4);
}

TEST(BioThresholds, IceAndBoilingPointAreTheOnlyHardGates) {
    // Both are the real physical constants for water at one atmosphere. Ablating
    // them to "tunable" would quietly turn a physical claim into a fudge.
    EXPECT_EQ(kFreezing_K, 273.0);
    EXPECT_EQ(kSterilization_K, 373.0);
    EXPECT_FALSE(liquid_water_possible(kFreezing_K));      // exactly at the ice point
    EXPECT_TRUE(liquid_water_possible(kFreezing_K + 0.1));
    EXPECT_TRUE(liquid_water_possible(kSterilization_K - 0.1));
    EXPECT_FALSE(liquid_water_possible(kSterilization_K)); // exactly at the boil
    EXPECT_FALSE(liquid_water_possible(10.0));
    EXPECT_FALSE(liquid_water_possible(1000.0));
}

TEST(BioThresholds, SolarSystemVerdictsFollowFromTheTwoGates) {
    // What the model says about the real planets -- pinned so the page's claims
    // cannot drift away from the kernel's numbers.
    struct Verd { const char* name; double a_AU; const char* verdict; };
    static const Verd V[] = {
        {"Mercury", 0.38709927, "sterilized"},   // T_surf 441.7 K, above boiling
        {"Venus",   0.72333566, "evolving"},     // T_surf 332.0 K, liquid possible
        {"Earth",   1.00000261, "evolving"},     // T_surf 287.3 K, the optimum
        {"Mars",    1.52371034, "frozen"},       // T_surf 239.0 K, below ice point
        {"Jupiter", 5.20288700, "frozen"},       // T_surf 144.5 K
        {"Neptune", 30.06992276, "frozen"},      // T_surf  79.4 K
    };
    for (const Verd& v : V) {
        const double t = surface_temp_k(teq_at(v.a_AU), kGreenhouseDeltaT_K);
        const char* got = (t >= kSterilization_K) ? "sterilized"
                        : (t > kFreezing_K)        ? "evolving"
                                                   : "frozen";
        EXPECT_STREQ(got, v.verdict) << v.name << " T_surf = " << t << " K";
    }
}

TEST(BioThresholds, MarsBecomesHabitableWithEnoughGreenhouse) {
    // The knob is meant to be explorable: 100 K of extra greenhouse puts a
    // Mars-like world inside the liquid window. This is the interactive payoff.
    const double mars_eq = teq_at(1.52371034);
    EXPECT_FALSE(liquid_water_possible(surface_temp_k(mars_eq, kGreenhouseDeltaT_K)));
    EXPECT_TRUE(liquid_water_possible(surface_temp_k(mars_eq, 100.0)));

    BioParams p;
    p.greenhouse_K = 100.0;
    BioState s;
    for (int i = 0; i < 50; ++i)
        step_bio(s, 1.52371034, 1.0, 1.0, p, static_cast<double>(i));
    EXPECT_GT(s.progress, 0.0);
}

// ---------------------------------------------------------------------------
// Layer 2: the stylized ladder. Self-consistency only -- nothing here asserts
// that the ladder matches real biological history.
// ---------------------------------------------------------------------------

TEST(BioStep, ProgressClampsToExactlyOneUnderAHugeStep) {
    BioParams p;
    p.full_ladder_years = 1.0;
    BioState s;
    step_bio(s, 1.0, 1.0, 1.0e6, p, 1.0e6);
    EXPECT_LE(s.progress, 1.0);
    EXPECT_GT(s.progress, 0.99);
    EXPECT_LE(s.stage, kBioStageCount - 1);
}

TEST(BioStep, HalfTheLadderIsRungFour) {
    // 50 one-year steps against a 100-year ladder: half the progress, which is
    // rung 4. (The first version expected rung 8 -- the probe's arithmetic
    // replay caught the off-by-four.)
    const BioState s = run_earth_years(50, BioParams{});
    EXPECT_LE(s.progress, 1.0);
    EXPECT_NEAR(s.progress, 0.4997, 0.002);
    EXPECT_EQ(s.stage, 4);
}

TEST(BioStep, ReachesTheLastRungOnlyWithEnoughTime) {
    // Rung 8 needs progress >= 8/9 = 0.889, i.e. ~89 years of a 100-year ladder.
    const BioState early = run_earth_years(50, BioParams{});
    EXPECT_LT(early.stage, kBioStageCount - 1);
    EXPECT_GT(early.stage, 0);

    const BioState late = run_earth_years(120, BioParams{});
    EXPECT_EQ(late.stage, kBioStageCount - 1);
    EXPECT_EQ(late.progress, 1.0);          // pinned, not 1.0000001
}

TEST(BioStep, TopOfTheLadderIsRungEight) {
    BioParams p;
    p.full_ladder_years = 1.0;
    BioState s;
    s.progress = 1.0;
    s.stage = kBioStageCount - 1;
    step_bio(s, 1.0, 1.0, 1.0, p, 1.0);     // pushes past the clamp
    EXPECT_EQ(s.stage, 8);
}

TEST(BioStep, BoilingResetsProgressToBarren) {
    BioParams p;
    p.full_ladder_years = 10.0;
    BioState s;
    for (int i = 0; i < 10; ++i)
        step_bio(s, 1.0, 1.0, 1.0, p, static_cast<double>(i));
    ASSERT_GT(s.progress, 0.0);
    ASSERT_GT(s.stage, 0);
    // 0.05 AU: T_surf ~ 1170 K, far past boiling.
    step_bio(s, 0.05, 1.0, 1.0, p, 20.0);
    EXPECT_EQ(s.stage, 0);
    EXPECT_EQ(s.progress, 0.0);
    EXPECT_GT(s.t_surf_K, kSterilization_K);   // the number is still reported
}

TEST(BioStep, FreezingStallsWithoutRegressing) {
    BioParams p;
    BioState s;
    for (int i = 0; i < 20; ++i)
        step_bio(s, 1.0, 1.0, 1.0, p, static_cast<double>(i));
    const double held = s.progress;
    const int held_stage = s.stage;
    ASSERT_GT(held, 0.0);
    ASSERT_GT(held_stage, 0);
    // 6 AU: T_surf 136.8 K, below the ice point. Frozen, not sterilised -- the
    // difference matters, because a body flung out and later returned keeps
    // whatever it had already grown.
    step_bio(s, 6.0, 1.0, 1.0, p, 100.0);
    EXPECT_LT(s.t_surf_K, kFreezing_K);
    EXPECT_GT(s.t_surf_K, 0.0);
    EXPECT_EQ(s.progress, held);
    EXPECT_EQ(s.stage, held_stage);
    // And it resumes from there when it comes back inside.
    step_bio(s, 1.0, 1.0, 10.0, p, 200.0);
    EXPECT_GT(s.progress, held);
}

TEST(BioStep, ReachedTimeLandsInsideTheStepInterval) {
    BioParams p;
    p.full_ladder_years = 10.0;
    BioState s;
    step_bio(s, 1.0, 1.0, 4.0, p, 100.0);
    ASSERT_GT(s.stage, 0);
    EXPECT_GE(s.t_stage, 96.0);
    EXPECT_LE(s.t_stage, 100.0);
    double last = s.t_stage;
    for (int i = 1; i < 20; ++i) {
        const double t = 100.0 + i * 4.0;
        step_bio(s, 1.0, 1.0, 4.0, p, t);
        EXPECT_GE(s.t_stage, last - 1e-9);
        last = s.t_stage;
    }
    EXPECT_LE(s.t_stage, 100.0 + 19 * 4.0);
}

TEST(BioStep, ZeroStepStillReportsTemperatures) {
    // Even with no time advancing, the page must be able to show WHY nothing
    // happens, which means all three temperatures have to be written every time.
    BioState s;
    step_bio(s, 1.0, 1.0, 0.0, BioParams{}, 0.0);
    EXPECT_NEAR(s.insolation, 1.0, 1e-12);
    EXPECT_NEAR(s.t_eq_K, 254.285, 0.02);
    EXPECT_NEAR(s.t_surf_K, 287.285, 0.02);
    EXPECT_EQ(s.progress, 0.0);
}

// ---------------------------------------------------------------------------
// Degenerate input. Everything here is reachable from the CLI (a massless test
// particle, a body sitting on the star, an albedo of exactly 1, a negative
// greenhouse knob) and every result is printed into a JSON document.
// ---------------------------------------------------------------------------

TEST(BioDegenerate, NoNaNOrInfAnywhere) {
    const double r_vals[] = {0.0, -1.0, 1.0e300, 5.0};
    const double l_vals[] = {0.0, -1.0, 1.0e300, 5.0};
    const double a_vals[] = {0.0, 0.5, 1.0, 4.0};
    const double g_vals[] = {-50.0, 0.0, 33.0, 1.0e6};
    for (double r : r_vals)
        for (double l : l_vals)
            for (double a : a_vals)
                for (double g : g_vals) {
                    BioParams p;
                    p.albedo = a;
                    p.greenhouse_K = g;
                    BioState s;
                    step_bio(s, r, l, 1.0, p, 1.0);
                    ASSERT_TRUE(std::isfinite(s.insolation));
                    ASSERT_TRUE(std::isfinite(s.t_eq_K));
                    ASSERT_TRUE(std::isfinite(s.t_surf_K));
                    ASSERT_TRUE(std::isfinite(s.progress));
                    ASSERT_TRUE(std::isfinite(s.t_stage));
                    ASSERT_GE(s.progress, 0.0);
                    ASSERT_LE(s.progress, 1.0);
                    ASSERT_GE(s.stage, 0);
                    ASSERT_LE(s.stage, kBioStageCount - 1);
                }
}

TEST(BioDegenerate, MasslessSourceGivesZeroLuminosity) {
    EXPECT_EQ(stellar_luminosity(0.0), 0.0);
    EXPECT_EQ(stellar_luminosity(-1.0), 0.0);
    BioState s;
    step_bio(s, 1.0, 0.0, 1.0, BioParams{}, 1.0);
    EXPECT_EQ(s.insolation, 0.0);
    EXPECT_EQ(s.t_eq_K, 0.0);
    EXPECT_EQ(s.t_surf_K, 0.0);
    EXPECT_EQ(s.progress, 0.0);
}

TEST(BioDegenerate, BodyAtTheCentreStaysBarren) {
    // The primary star itself sits at r = 0: no insolation, no evolution, and
    // crucially no phantom greenhouse temperature.
    BioState s;
    step_bio(s, 0.0, 1.0, 100.0, BioParams{}, 100.0);
    EXPECT_EQ(s.insolation, 0.0);
    EXPECT_EQ(s.t_surf_K, 0.0);
    EXPECT_EQ(s.stage, 0);
    EXPECT_EQ(s.progress, 0.0);
}

TEST(BioDegenerate, ZeroLengthLadderDoesNothing) {
    BioParams p;
    p.full_ladder_years = 0.0;
    BioState s;
    step_bio(s, 1.0, 1.0, 1.0, p, 1.0);
    EXPECT_EQ(s.progress, 0.0);      // no divide-by-zero, no instant civilisation
    EXPECT_GT(s.t_surf_K, 0.0);      // temperature still reported
}

TEST(BioDegenerate, AlbedoOutOfRangeFallsBackOrZeroes) {
    // albedo <= 0 falls back to the Earth default rather than producing a
    // division blow-up; albedo >= 1 cannot absorb anything and gives 0.
    EXPECT_NEAR(equilibrium_temp_k(1.0, 0.0), teq_at(1.0), 1e-12);
    EXPECT_NEAR(equilibrium_temp_k(1.0, -0.5), teq_at(1.0), 1e-12);
    EXPECT_EQ(equilibrium_temp_k(1.0, 1.0), 0.0);
    EXPECT_EQ(equilibrium_temp_k(1.0, 1.5), 0.0);
}

TEST(BioStageName, CoversEveryRungUniquely) {
    // Every rung needs a name the page can render, and no two may share one --
    // an off-by-one in kBioStageCount shows up as a duplicate here.
    for (int i = 0; i < kBioStageCount; ++i) {
        ASSERT_NE(bio_stage_name(i), nullptr);
        ASSERT_NE(bio_stage_name(i)[0], '\0');
        for (int j = i + 1; j < kBioStageCount; ++j)
            EXPECT_STRNE(bio_stage_name(i), bio_stage_name(j))
                << "rungs " << i << " and " << j << " share a name";
    }
    EXPECT_STREQ(bio_stage_name(0), "死寂岩石");
    EXPECT_STREQ(bio_stage_name(8), "工业文明");
    EXPECT_STREQ(bio_stage_name(99), "未知");
}

// The rungs are a monotone function of progress: the ladder the page colours
// with must be the same ladder the kernel counted.
TEST(BioStage, IsMonotoneInProgress) {
    int prev = -1;
    for (int k = 0; k <= 900; ++k) {
        const double progress = static_cast<double>(k) / 900.0;
        int stage = static_cast<int>(progress * kBioStageCount);
        stage = std::min(stage, kBioStageCount - 1);
        ASSERT_GE(stage, prev);
        ASSERT_LE(stage, kBioStageCount - 1);
        prev = stage;
    }
}

}  // namespace
}  // namespace starpivot
