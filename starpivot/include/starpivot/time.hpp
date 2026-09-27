// starpivot — time scales, Julian dates and Earth rotation.
//
// Why this module exists
// ----------------------
// Every operational product in this domain (TLE propagation, ground-station
// visibility, sensor tasking) is expressed in a *time scale*, not in "seconds
// since the integrator started". Mixing UTC and TT silently is the single most
// common way to lose kilometres of accuracy:
//
//   UTC  -> has leap seconds, is what wall clocks read
//   UT1  -> tracks actual Earth rotation angle (|UT1-UTC| < 0.9 s)
//   TT   -> Terrestrial Time, uniform, TT = TAI + 32.184 s
//   TAI  -> International Atomic Time, no leap seconds
//   TDB  -> Barycentric Dynamical Time, differs from TT by < 2 ms
//
// For sub-metre work the 69 s TAI-UTC offset and the sub-second UT1-UTC
// (DUT1) both matter. We expose them explicitly rather than hiding them.
//
// Units: this module works in DAYS for Julian dates and SECONDS everywhere
// else. Every function says which.

#ifndef STARPIVOT_TIME_HPP
#define STARPIVOT_TIME_HPP

#include <string>

namespace starpivot {

// ---------------------------------------------------------------------------
// Constants (IERS / IAU)
// ---------------------------------------------------------------------------

/// TT = TAI + 32.184 s exactly (IAU 1991).
constexpr double kTTMinusTAI = 32.184;

/// TAI = UTC + kLeapSeconds(epoch). Value in force since 2017-01-01.
constexpr double kLeapSecondsSince2017 = 37.0;

/// Julian date of the J2000.0 epoch (2000-01-01T12:00:00 TT).
constexpr double kJ2000JD = 2451545.0;

/// Julian date of the standard epoch used by SGP4/TLE: 1949-12-31T00:00 UT.
constexpr double kSGP4EpochJD = 2433281.5;

/// Seconds per day.
constexpr double kSecondsPerDay = 86400.0;

/// Earth rotation rate [rad/s] (IAU 1976 value used by SGP4).
constexpr double kEarthRotationRate = 7.29211510e-5;

/// Earth's gravitational parameter in the WGS72 system used by SGP4
/// [km^3/s^2]. NOTE: this is *not* the same as modern EGM2008 mu; SGP4 is
/// defined against WGS72 and mixing them breaks reproducibility.
constexpr double kMuEarthWGS72 = 398600.8;

// ---------------------------------------------------------------------------
// Julian dates
// ---------------------------------------------------------------------------

/// Convert a calendar date (UTC) to Julian Date. Valid for any proleptic
/// Gregorian date. `hour` is UTC hour of day [0,24).
double julian_date(int year, int month, int day, double hour = 0.0);

/// Inverse of julian_date. Returns {year, month, day, hour_utc}.
struct CalendarDate {
    int year;
    int month;
    int day;
    double hour;  // UTC hours [0,24)
};
CalendarDate calendar_from_jd(double jd);

/// Format a Julian Date as ISO-8601 "YYYY-MM-DDTHH:MM:SSZ".
std::string iso_from_jd(double jd);

// ---------------------------------------------------------------------------
// Time scale conversions
// ---------------------------------------------------------------------------

/// Leap-second count (TAI - UTC) in force at a given UTC Julian Date.
/// Returns 0 and sets *ok=false for dates before the leap-second system
/// started (1972) or past the last announced leap second, where we cannot
/// know the future value.
double tai_minus_utc(double jd_utc, bool* ok = nullptr);

/// Convert TT Julian Date to UTC Julian Date.
double jd_tt_to_utc(double jd_tt, bool* ok = nullptr);

/// Convert UTC Julian Date to TT Julian Date.
double jd_utc_to_tt(double jd_utc, bool* ok = nullptr);

/// Convert TT Julian Date to TDB Julian Date. Good to ~2 ms over 1900-2100;
/// uses the standard truncated series (Moyer / Vallado eq. 3-50).
double jd_tt_to_tdb(double jd_tt);

/// Julian centuries since J2000.0, TT.
double centuries_since_j2000(double jd_tt);

// ---------------------------------------------------------------------------
// Earth rotation
// ---------------------------------------------------------------------------

/// Greenwich Mean Sidereal Time [rad] from UT1 Julian Date.
/// IAU 1982 polynomial (Vallado eq. 3-42); the high-order terms matter at the
/// arcsecond level, which is ~30 m on the ground.
double gmst_from_jd_ut1(double jd_ut1);

/// Greenwich Apparent Sidereal Time [rad] = GMST + equation of the equinoxes.
/// Includes the 106-term nutation series in longitude and obliquity
/// (IAU 1980). Needed when ECI and terrestrial coordinates must agree better
/// than ~1 km.
double gast_from_jd_ut1(double jd_ut1);

/// Equation of the equinoxes [rad].
double equation_of_equinoxes(double jd_tt);

/// Nutation in longitude [rad] and obliquity [rad] (IAU 1980, truncated to the
/// dominant terms). Accuracy ~0.5 arcsec, i.e. ~15 m on the ground.
struct Nutation {
    double dpsi;  // nutation in longitude [rad]
    double deps;  // nutation in obliquity [rad]
};
Nutation nutation_iau1980(double jd_tt);

/// Mean obliquity of the ecliptic [rad] (IAU 1980).
double mean_obliquity(double jd_tt);

/// UT1 - UTC [s]. IERS publishes this as DUT1; without a bulletin we return
/// 0, which is accurate to < 0.9 s (< 400 m of Earth rotation). Callers that
/// need better must pass a tabulated value.
double ut1_minus_utc(double jd_utc);

}  // namespace starpivot

#endif  // STARKPIVOT_TIME_HPP
