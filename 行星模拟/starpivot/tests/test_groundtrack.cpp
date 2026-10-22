// Verification of the ground-track (sub-satellite point) module.
//
// The propagator underneath is Vallado-validated (< 1e-6 km); the *only* new
// code here is the TEME -> lat/lon conversion, i.e. GMST rotation + two
// trig inverses. The tests gate on externally checkable physics, not on
// re-running the same trig:
//   1. Latitude bound      -> |lat| can never exceed the orbital inclination
//      (geometrically impossible; a conversion bug that mixes up axes or
//      frames blows straight through this).
//   2. Nodal regression    -> longitude at successive ascending equator
//      crossings must decrease by (earth rotation + RAAN regression) per
//      revolution, ~ -23.5 deg/rev for ISS. Textbook-observable, sensitive to
//      the GMST term being dropped or sign-flipped (dropping GMST gives 0;
//      keeping rotation but forgetting the orbit's RAAN drift gives -23.2 —
//      the tolerance catches sign errors, not magnitude nuances).
//   3. Round-trip closure  -> rebuilding the ECEF position from the reported
//      (lat, lon, alt) must reproduce the rotated TEME vector to 1e-6 km.
//   4. Deep-space path     -> a GPS (SDP4) track must also come out with
//      |lat| bounded by its inclination, proving the ascending-tsince policy
//      works for the stateful deep-space integrator.

#include "starpivot/groundtrack.hpp"
#include "starpivot/sgp4.hpp"
#include "starpivot/time.hpp"

#include <cmath>
#include <string>
#include <vector>

#include <gtest/gtest.h>

namespace starpivot {
namespace {

const char* kIssL1 = "1 25544U 98067A   26267.14191496  .00009634  00000+0  18116-3 0  9999";
const char* kIssL2 = "2 25544  51.6318 170.3464 0004691 174.6338 185.4701 15.49258637587098";
const char* kGpsL1 = "1 26407U 00040A   26267.25377767 -.00000003  00000+0  00000+0 0  9992";
const char* kGpsL2 = "2 26407  54.8367 211.2307 0117723 304.0216 229.1692  2.00558441191930";

Tle parse_tle_or_die(const char* l1, const char* l2) {
    Tle t{};
    std::string err;
    EXPECT_TRUE(parse_tle(l1, l2, t, &err)) << err;
    return t;
}

TEST(GroundTrack, LatitudeBoundedByInclination) {
    Tle iss = parse_tle_or_die(kIssL1, kIssL2);
    std::vector<GroundSample> tr;
    Sgp4Error e = Sgp4Error::kOk;
    // Two full ISS revolutions, half-minute sampling.
    ASSERT_TRUE(ground_track(iss, 0.0, 185.0, 0.5, tr, &e));
    ASSERT_FALSE(tr.empty());

    const double incl_deg = iss.inclo * 180.0 / 3.14159265358979323846;
    for (const GroundSample& s : tr) {
        // Geometric hard bound + 0.05 deg slack for perturbations; spherical-
        // Earth geocentric latitude is itself bounded by the inclination.
        EXPECT_LE(std::fabs(s.lat_deg), incl_deg + 0.05) << "t=" << s.t_min;
        EXPECT_GE(s.alt_km, 300.0) << "ISS altitude sanity, t=" << s.t_min;
        EXPECT_LE(s.alt_km, 600.0) << "t=" << s.t_min;
    }
}

TEST(GroundTrack, WestwardNodalRegressionPerRevolution) {
    Tle iss = parse_tle_or_die(kIssL1, kIssL2);
    std::vector<GroundSample> tr;
    Sgp4Error e = Sgp4Error::kOk;
    ASSERT_TRUE(ground_track(iss, 0.0, 200.0, 0.25, tr, &e));

    // Ascending equator crossings: latitude goes negative -> >= 0.
    std::vector<double> cross_lon;
    for (std::size_t i = 1; i < tr.size(); ++i) {
        if (tr[i - 1].lat_deg < 0.0 && tr[i].lat_deg >= 0.0) {
            // Linear interpolation of the crossing longitude.
            const double w = -tr[i - 1].lat_deg / (tr[i].lat_deg - tr[i - 1].lat_deg);
            double lon = tr[i - 1].lon_deg +
                         w * (tr[i].lon_deg - tr[i - 1].lon_deg);
            if (lon > 180.0) lon -= 360.0;
            if (lon <= -180.0) lon += 360.0;
            cross_lon.push_back(lon);
        }
    }
    ASSERT_GE(cross_lon.size(), 2u)
        << "200 min must contain at least two ISS ascending crossings";

    // ISS: T = 92.95 min. Earth turns -360 * T/1436.07 = -23.27 deg per rev;
    // RAAN regresses about -4.95 deg/day = -0.32 deg per rev. Total ~ -23.6.
    // A missing GMST term gives ~0; a flipped sign gives +23.6: both fail.
    for (std::size_t i = 1; i < cross_lon.size(); ++i) {
        double d = cross_lon[i] - cross_lon[i - 1];
        if (d > 180.0) d -= 360.0;
        if (d < -180.0) d += 360.0;
        EXPECT_NEAR(d, -23.6, 1.0) << "crossing pair " << i;
    }
}

TEST(GroundTrack, SubpointRoundTripCloses) {
    Tle iss = parse_tle_or_die(kIssL1, kIssL2);
    Sgp4 s;
    ASSERT_TRUE(sgp4_init(s, iss));
    const double tsince[] = {0.0, 37.5, 92.95, 150.0};
    for (double t : tsince) {
        Vec3 r, v;
        Sgp4Error e = Sgp4Error::kOk;
        ASSERT_TRUE(sgp4_propagate(s, t, r, v, &e));
        const double jd_ut1 = iss.epoch_jd + t / 1440.0;
        const Subpoint sp = subpoint_from_teme(r, jd_ut1);

        // Rebuild the Earth-fixed vector from (lat, lon, alt) and compare with
        // the TEME position rotated by -GMST. Closes asin/atan2 + GMST exactly.
        const double theta = gmst_from_jd_ut1(jd_ut1);
        const double rr = r.norm();
        const double la = sp.lat_deg * 3.14159265358979323846 / 180.0;
        const double lo = sp.lon_deg * 3.14159265358979323846 / 180.0 + theta;
        const Vec3 rebuilt(rr * std::cos(la) * std::cos(lo),
                           rr * std::cos(la) * std::sin(lo),
                           rr * std::sin(la));
        EXPECT_LT((r - rebuilt).norm(), 1e-6) << "t=" << t;
    }
}

TEST(GroundTrack, DeepSpaceTrackAscendsTsince) {
    Tle gps = parse_tle_or_die(kGpsL1, kGpsL2);
    std::vector<GroundSample> tr;
    Sgp4Error e = Sgp4Error::kOk;
    // 300 min of a GPS (SDP4 deep-space) ground track.
    ASSERT_TRUE(ground_track(gps, 0.0, 300.0, 1.0, tr, &e));
    ASSERT_FALSE(tr.empty());

    const double incl_deg = gps.inclo * 180.0 / 3.14159265358979323846;
    double prev_t = -1e30;
    for (const GroundSample& s : tr) {
        EXPECT_LE(std::fabs(s.lat_deg), incl_deg + 0.05) << "t=" << s.t_min;
        EXPECT_GT(s.alt_km, 15000.0) << "GPS altitude sanity, t=" << s.t_min;
        EXPECT_LT(s.alt_km, 26000.0) << "t=" << s.t_min;
        EXPECT_GT(s.t_min, prev_t) << "samples must ascend (SDP4 policy)";
        prev_t = s.t_min;
    }
}

}  // namespace
}  // namespace starpivot
