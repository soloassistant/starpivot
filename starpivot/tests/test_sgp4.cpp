// Verification of SGP4/SDP4 against the official test vectors.
//
// Every number below is transcribed verbatim from
//   Vallado, Crawford, Hujsak & Kelso, "Revisiting Spacetrack Report #3",
//   AIAA 2006-6753 Rev 1, Appendix D
// (https://celestrak.org/publications/AIAA/2006-6753/AIAA-2006-6753-Rev1.pdf)
// extracted programmatically from the PDF, not recalled from memory.
// The same data is archived in docs/sgp4-vectors.md.
//
// These tests are the gate on claiming TLE support at all. They are not
// regression tests for our own output: if this implementation drifts by even a
// metre from the published values, the product must stop advertising TLE
// propagation, because downstream conjunction assessments would inherit an
// error that is invisible at the call site.

#include "starpivot/sgp4.hpp"

#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include <gtest/gtest.h>

namespace starpivot {
namespace {

struct Expectation {
    double tsince;
    double r[3];
    double v[3];
};

struct Case {
    const char* name;
    const char* line1;
    const char* line2;
    bool deep_space;
    std::vector<Expectation> expected;
};

// ---------------------------------------------------------------------------
// The official vectors.
// ---------------------------------------------------------------------------

const Case kCases[] = {
    // --- near earth, the original STR#3 SGP4 worked example ---
    {"88888",
     "1 88888U          80275.98708465  .00073094  13844-3  66816-4 0    87",
     "2 88888  72.8435 115.9689 0086731  52.6988 110.5714 16.05824518  1058",
     false,
     {
         {0.0, {2328.96975262, -5995.22051338, 1719.97297192},
          {2.912073281, -0.983417956, -7.090816210}},
         {120.0, {1020.69234558, 2286.56260634, -6191.55565927},
          {-3.746543902, 6.467532721, 1.827985678}},
         {240.0, {-3226.54349155, 3503.70977525, 4532.80979343},
          {1.000992116, -5.788042888, 5.162585826}},
         {360.0, {2456.10706533, -6071.93855503, 1222.89768554},
          {2.679390040, -0.448290811, -7.228792155}},
     }},

    // --- near earth, e = 0.0000884: exercises the numerical-precision branch ---
    {"28057",
     "1 28057U 03049A   06177.78615833  .00000060  00000-0  35940-4 0  1836",
     "2 28057  98.4283 247.6961 0000884  88.1964 271.9322 14.35478080140550",
     false,
     {
         {0.0, {-2715.28237486, -6619.26436889, -0.01341443},
          {-1.008587273, 0.422782003, 7.385272942}},
         {120.0, {-1816.87920942, -1835.78762132, 6661.07926465},
          {2.325140071, 6.655669329, 2.463394512}},
         {240.0, {1483.17364291, 5395.21248786, 4448.65907172},
          {2.560540387, 4.039025766, -5.736648561}},
         {360.0, {2801.25607157, 5455.03931333, -3692.12865695},
          {-0.595095864, -3.951923117, -6.298799125}},
         {480.0, {411.09332812, -1728.99769152, -6935.45548810},
          {-2.935970964, -6.684085058, 1.492800886}},
     }},

    // --- deep space, the original STR#3 SDP4 worked example ---
    {"11801",
     "1 11801U          80230.29629788  .01431103  00000-0  14311-1      13",
     "2 11801  46.7916 230.4354 7318036  47.4722  10.4117  2.28537848    13",
     true,
     {
         {0.0, {7473.37102491, 428.94748312, 5828.74846783},
          {5.107155391, 6.444680305, -0.186133297}},
         {360.0, {-3305.22148694, 32410.84323331, -24697.16974954},
          {-1.301137319, -1.151315600, -0.283335823}},
         {720.0, {14271.29083858, 24110.44309009, -4725.76320143},
          {-0.320504528, 2.679841539, -2.084054355}},
         {1080.0, {-9990.05800009, 22717.34212448, -23616.88515553},
          {-1.016674392, -2.290267981, 0.728923337}},
     }},

    // --- deep space, geosynchronous: exercises the synchronous resonance
    //     integrator (irez == 1) ---
    {"14128",
     "1 14128U 83058A   06176.02844893 -.00000158  00000-0  10000-3 0  9627",
     "2 14128  11.4384  35.2134 0011562  26.4582 333.5652  0.98870114 46093",
     true,
     {
         {0.0, {34747.57932696, 24502.37114079, -1.32832986},
          {-1.731642662, 2.452772615, 0.608510081}},
         {120.0, {18263.33439094, 38159.96004751, 4186.18304085},
          {-2.744396611, 1.255583260, 0.528558932}},
         {240.0, {-3023.38840703, 41783.13186459, 7273.03412906},
          {-3.035574793, -0.271656544, 0.309645251}},
         {360.0, {-23516.34391907, 34424.42065671, 8448.49867693},
          {-2.529120477, -1.726186020, 0.009582303}},
     }},

    // --- deep space, perigee 135 km: exercises the s4 / qzms24 low-perigee
    //     branch ---
    {"28623",
     "1 28623U 05006B   06177.81079184  .00637644  69054-6  96390-3 0  6000",
     "2 28623  28.5200 114.9834 6249053 170.2550 212.8965  3.79477162 12753",
     true,
     {
         {0.0, {-11665.70902324, 24943.61433357, 25.80543633},
          {-1.596228621, -1.476127961, 1.126059754}},
         {120.0, {-11645.35454950, 979.37668356, 5517.89500058},
          {3.407743502, -5.183094988, -0.492983277}},
         {240.0, {5619.19252274, 19651.44862280, -7261.38496765},
          {-2.013634213, 3.106842861, 0.284235517}},
         {360.0, {-9708.68629714, 26306.14553149, -1204.29478856},
          {-1.824164290, -0.931909596, 1.113419052}},
     }},

    // --- deep space, e = 0.9728: exercises the Kepler solver at the extreme ---
    {"23333",
     "1 23333U 94071A   94305.49999999 -.00172956  26967-3  10000-3 0    15",
     "2 23333  28.7490  2.3720 9728298  30.4360  1.3500  0.07309491    70",
     true,
     {
         {0.0, {-9301.24542292, 3326.10200382, 2318.36441127},
          {-8.729303005, -0.828225037, -0.122314827}},
         {120.0, {-44672.91239680, -6213.11996581, -1738.80131727},
          {-3.719475070, -1.336673022, -0.621888261}},
     }},
};

// ---------------------------------------------------------------------------
// Parsing must survive the quirks of real TLEs.
// ---------------------------------------------------------------------------

TEST(Sgp4, ParsesTleWithAndWithoutInternationalDesignator) {
    Tle a{}, b{};
    std::string err;
    // 88888 has a blank designator field, so a fixed column index would fail.
    ASSERT_TRUE(parse_tle("1 88888U          80275.98708465  .00073094  13844-3  66816-4 0    87",
                          "2 88888  72.8435 115.9689 0086731  52.6988 110.5714 16.05824518  1058",
                          a, &err)) << err;
    EXPECT_EQ(a.satnum, 88888);
    EXPECT_EQ(a.intl_designator, "")
        << "legacy objects with a blank designator field must parse as empty";
    EXPECT_NEAR(a.ndot, 0.00073094 * 2.0 * 3.14159265358979324 / (1440.0 * 1440.0), 1e-20);
    EXPECT_NEAR(a.bstar, 0.66816e-4, 1e-12);
    EXPECT_NEAR(a.nddot, 0.13844e-3 * 2.0 * 3.14159265358979324 / (1440.0 * 1440.0 * 1440.0), 1e-25);
    EXPECT_NEAR(a.ecco, 0.0086731, 1e-12);

    ASSERT_TRUE(parse_tle("1 28057U 03049A   06177.78615833  .00000060  00000-0  35940-4 0  1836",
                          "2 28057  98.4283 247.6961 0000884  88.1964 271.9322 14.35478080140550",
                          b, &err)) << err;
    EXPECT_EQ(b.satnum, 28057);
    EXPECT_EQ(b.intl_designator, "03049A");
    // Epoch 06177.78615833 -> 2006, day 177.786...
    EXPECT_EQ(b.epoch_year, 6);
    // epoch_day stores the raw TLE YYDDD.frac = 06*1000 + 177.78615833.
    EXPECT_NEAR(b.epoch_day, 6177.78615833, 1e-8);
    EXPECT_NEAR(b.ecco, 0.0000884, 1e-12);
    EXPECT_NEAR(b.bstar, 0.35940e-4, 1e-12);
}

TEST(Sgp4, RejectsMalformedInput) {
    Tle t{};
    std::string err;
    EXPECT_FALSE(parse_tle("not a tle", "2 88888  72.8435 115.9689 0086731  52.6988 110.5714 16.05 1058", t, &err));
    EXPECT_FALSE(parse_tle("1 88888U          80275.98708465  .00073094  13844-3  66816-4 0    87",
                           "garbage", t, &err));
}

// ---------------------------------------------------------------------------
// The acceptance gate: every official vector, both regimes.
// ---------------------------------------------------------------------------

TEST(Sgp4, MatchesOfficialNearEarthVectors) {
    // 1 mm in position, 1 micrometre per second in velocity. The published
    // values carry ~11 significant digits, so anything beyond this is our bug.
    const double kPosTolKm = 1e-6;
    const double kVelTolKmS = 1e-9;

    for (const Case& c : kCases) {
        if (c.deep_space) continue;
        Tle tle{};
        std::string err;
        ASSERT_TRUE(parse_tle(c.line1, c.line2, tle, &err)) << c.name << ": " << err;

        Sgp4 s;
        ASSERT_TRUE(sgp4_init(s, tle));
        EXPECT_EQ(s.method, 'n') << c.name << " should be classified near-earth";

        for (const Expectation& e : c.expected) {
            Vec3 r{}, v{};
            Sgp4Error code = Sgp4Error::kOk;
            ASSERT_TRUE(sgp4_propagate(s, e.tsince, r, v, &code))
                << c.name << " tsince=" << e.tsince << ": " << sgp4_error_string(code);

            const Vec3 dr(r.x - e.r[0], r.y - e.r[1], r.z - e.r[2]);
            const Vec3 dv(v.x - e.v[0], v.y - e.v[1], v.z - e.v[2]);

            if (dr.norm() > kPosTolKm || dv.norm() > kVelTolKmS) {
                std::printf("[%s] tsince=%.1f  dr=%.6g km  dv=%.6g km/s\n", c.name,
                            e.tsince, dr.norm(), dv.norm());
                std::printf("    got r=(%.8f, %.8f, %.8f) v=(%.9f, %.9f, %.9f)\n", r.x, r.y, r.z,
                            v.x, v.y, v.z);
                std::printf("    exp r=(%.8f, %.8f, %.8f) v=(%.9f, %.9f, %.9f)\n", e.r[0], e.r[1],
                            e.r[2], e.v[0], e.v[1], e.v[2]);
            }
            EXPECT_LT(dr.norm(), kPosTolKm) << c.name << " tsince=" << e.tsince;
            EXPECT_LT(dv.norm(), kVelTolKmS) << c.name << " tsince=" << e.tsince;
        }
    }
}

TEST(Sgp4, MatchesOfficialDeepSpaceVectors) {
    const double kPosTolKm = 1e-6;
    const double kVelTolKmS = 1e-9;

    for (const Case& c : kCases) {
        if (!c.deep_space) continue;
        Tle tle{};
        std::string err;
        ASSERT_TRUE(parse_tle(c.line1, c.line2, tle, &err)) << c.name << ": " << err;

        Sgp4 s;
        ASSERT_TRUE(sgp4_init(s, tle));
        EXPECT_EQ(s.method, 'd') << c.name << " should be classified deep-space";

        // Requests must be issued in increasing tsince: the resonance
        // integrator carries state between calls.
        for (const Expectation& e : c.expected) {
            Vec3 r{}, v{};
            Sgp4Error code = Sgp4Error::kOk;
            ASSERT_TRUE(sgp4_propagate(s, e.tsince, r, v, &code))
                << c.name << " tsince=" << e.tsince << ": " << sgp4_error_string(code);

            const Vec3 dr(r.x - e.r[0], r.y - e.r[1], r.z - e.r[2]);
            const Vec3 dv(v.x - e.v[0], v.y - e.v[1], v.z - e.v[2]);

            if (dr.norm() > kPosTolKm || dv.norm() > kVelTolKmS) {
                std::printf("[%s] tsince=%.1f  dr=%.6g km  dv=%.6g km/s\n", c.name,
                            e.tsince, dr.norm(), dv.norm());
                std::printf("    got r=(%.8f, %.8f, %.8f) v=(%.9f, %.9f, %.9f)\n", r.x, r.y, r.z,
                            v.x, v.y, v.z);
                std::printf("    exp r=(%.8f, %.8f, %.8f) v=(%.9f, %.9f, %.9f)\n", e.r[0], e.r[1],
                            e.r[2], e.v[0], e.v[1], e.v[2]);
            }
            EXPECT_LT(dr.norm(), kPosTolKm) << c.name << " tsince=" << e.tsince;
            EXPECT_LT(dv.norm(), kVelTolKmS) << c.name << " tsince=" << e.tsince;
        }
    }
}

// ---------------------------------------------------------------------------
// Physical sanity independent of the reference values.
// ---------------------------------------------------------------------------

TEST(Sgp4, PropagatedOrbitHasConsistentEnergy) {
    // A propagator can match vectors at four epochs and still be wrong in
    // between. This checks the whole arc: the specific orbital energy of the
    // SGP4 output must be consistent with the osculating a it implies, which
    // catches sign and unit errors that a sparse table would miss.
    Tle tle{};
    ASSERT_TRUE(parse_tle("1 28057U 03049A   06177.78615833  .00000060  00000-0  35940-4 0  1836",
                          "2 28057  98.4283 247.6961 0000884  88.1964 271.9322 14.35478080140550",
                          tle));
    Sgp4 s;
    ASSERT_TRUE(sgp4_init(s, tle));

    const double mu_wgs72 = 398600.8;
    for (double t = -1440.0; t <= 1440.0; t += 120.0) {
        Vec3 r{}, v{};
        Sgp4Error code = Sgp4Error::kOk;
        // The resonance integrator restarts on a sign change, which is fine
        // for a non-resonant LEO like this one.
        ASSERT_TRUE(sgp4_propagate(s, t, r, v, &code)) << "t=" << t;

        const double rn = r.norm();
        const double energy = v.norm_sq() / 2.0 - mu_wgs72 / rn;
        const double a = -mu_wgs72 / (2.0 * energy);
        // a must be near 7078 km for this object, and definitely bounded.
        EXPECT_GT(a, 6000.0) << "t=" << t;
        EXPECT_LT(a, 8000.0) << "t=" << t;
        EXPECT_GT(rn, 6378.135) << "position must stay above the surface, t=" << t;
    }
}

TEST(Sgp4, UsesWgs72ConstantsNotModernGeopotential) {
    // SGP4 is defined against WGS72. This assertion exists so that nobody
    // "modernises" the constants and silently loses agreement with every
    // catalogue on Earth.
    Sgp4 s;
    EXPECT_NEAR(s.xke, 0.0743669161331734132, 1e-15);
    EXPECT_NEAR(s.j2, 0.001082616, 1e-12);
    EXPECT_NEAR(s.radiusearthkm, 6378.135, 1e-9);
    EXPECT_NEAR(s.j3, -0.00000253881, 1e-15);
    EXPECT_NEAR(s.j4, -0.00000165597, 1e-15);
}

}  // namespace
}  // namespace starpivot
