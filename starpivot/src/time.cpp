// Time scales, Julian dates and Earth rotation. See include/starpivot/time.hpp
// for the unit conventions and why the time-scale distinction matters.

#include "starpivot/time.hpp"

#include <array>
#include <cmath>
#include <cstdio>
#include <vector>

namespace starpivot {
namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 6.28318530717958647692;
constexpr double kArcsecToRad = kPi / (180.0 * 3600.0);

// Leap-second table: {MJD of the UTC instant the new offset took effect,
// TAI-UTC in seconds after that instant}. Complete through the last IERS
// announcement; intentionally *not* extrapolated past it, because a product
// that guesses leap seconds will silently drift.
struct LeapEntry {
    double mjd;
    double tai_minus_utc;
};

const std::vector<LeapEntry>& leap_table() {
    static const std::vector<LeapEntry> table = {
        {41317.0, 10.0},  // 1972-01-01
        {41499.0, 11.0},  // 1972-07-01
        {41683.0, 12.0},  // 1973-01-01
        {42048.0, 13.0},  // 1974-01-01
        {42413.0, 14.0},  // 1975-01-01
        {42778.0, 15.0},  // 1976-01-01
        {43144.0, 16.0},  // 1977-01-01
        {43509.0, 17.0},  // 1978-01-01
        {43874.0, 18.0},  // 1979-01-01
        {44239.0, 19.0},  // 1980-01-01
        {44786.0, 20.0},  // 1981-07-01
        {45151.0, 21.0},  // 1982-07-01
        {45516.0, 22.0},  // 1983-07-01
        {46247.0, 23.0},  // 1985-07-01
        {47161.0, 24.0},  // 1988-01-01
        {47892.0, 25.0},  // 1990-01-01
        {48257.0, 26.0},  // 1991-01-01
        {48804.0, 27.0},  // 1992-07-01
        {49169.0, 28.0},  // 1993-07-01
        {49534.0, 29.0},  // 1994-07-01
        {50083.0, 30.0},  // 1996-01-01
        {50630.0, 31.0},  // 1997-07-01
        {51179.0, 32.0},  // 1999-01-01
        {53736.0, 33.0},  // 2006-01-01
        {54832.0, 34.0},  // 2009-01-01
        {56109.0, 35.0},  // 2012-07-01
        {57204.0, 36.0},  // 2015-07-01
        {57754.0, 37.0},  // 2017-01-01
    };
    return table;
}

}  // namespace

// ---------------------------------------------------------------------------
// Julian dates
// ---------------------------------------------------------------------------

double julian_date(int year, int month, int day, double hour) {
    // Fliegel-Van Flandern algorithm; valid for all proleptic Gregorian dates.
    int y = year;
    int m = month;
    if (m <= 2) {
        y -= 1;
        m += 12;
    }
    const double d = static_cast<double>(day) + hour / 24.0;
    const long a = y / 100;
    const long b = 2 - a + a / 4;
    const long jdn = static_cast<long>(365.25 * (y + 4716)) +
                     static_cast<long>(30.6001 * (m + 1)) +
                     static_cast<long>(d) + b - 1524;
    return static_cast<double>(jdn) + (d - static_cast<long>(d)) - 0.5;
}

CalendarDate calendar_from_jd(double jd) {
    const double z = std::floor(jd + 0.5);
    const double f = (jd + 0.5) - z;  // fractional day
    long a = static_cast<long>(z);
    if (z >= 2299161.0) {
        const long alpha = static_cast<long>((z - 1867216.25) / 36524.25);
        a = static_cast<long>(z) + 1 + alpha - alpha / 4;
    }
    const long b = a + 1524;
    const long c = static_cast<long>((b - 122.1) / 365.25);
    const long d = static_cast<long>(365.25 * c);
    const long e = static_cast<long>((b - d) / 30.6001);

    const double day_frac = b - d - static_cast<long>(30.6001 * e) + f;
    const int month = static_cast<int>(e < 14 ? e - 1 : e - 13);
    const int year = static_cast<int>(month > 2 ? c - 4716 : c - 4715);

    CalendarDate out{};
    out.year = year;
    out.month = month;
    out.day = static_cast<int>(std::floor(day_frac));
    out.hour = (day_frac - out.day) * 24.0;
    return out;
}

std::string iso_from_jd(double jd) {
    const CalendarDate c = calendar_from_jd(jd);
    const double total_sec = c.hour * 3600.0;
    const int hh = static_cast<int>(std::floor(total_sec / 3600.0));
    const int mm = static_cast<int>(std::floor((total_sec - hh * 3600.0) / 60.0));
    const int ss = static_cast<int>(std::floor(total_sec - hh * 3600.0 - mm * 60.0));
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02dZ", c.year,
                  c.month, c.day, hh, mm, ss);
    return std::string(buf);
}

// ---------------------------------------------------------------------------
// Time scales
// ---------------------------------------------------------------------------

double tai_minus_utc(double jd_utc, bool* ok) {
    const double mjd = jd_utc - 2400000.5;
    const auto& t = leap_table();
    if (ok) *ok = true;
    if (mjd < t.front().mjd) {
        // Before 1972 UTC used a rubber-second scheme; TAI-UTC is not a step
        // function. Refuse rather than return a wrong-but-plausible number.
        if (ok) *ok = false;
        return 0.0;
    }
    if (mjd > t.back().mjd + 365.0) {
        // Past one year beyond the last announcement we cannot know whether a
        // new leap second has been inserted.
        if (ok) *ok = false;
    }
    double val = t.front().tai_minus_utc;
    for (const auto& e : t) {
        if (mjd >= e.mjd) val = e.tai_minus_utc;
    }
    return val;
}

double jd_utc_to_tt(double jd_utc, bool* ok) {
    return jd_utc + (tai_minus_utc(jd_utc, ok) + kTTMinusTAI) / kSecondsPerDay;
}

double jd_tt_to_utc(double jd_tt, bool* ok) {
    // Invert by fixed-point iteration: the offset is a step function so one
    // or two passes converge unless we sit within 40 s of a leap insertion.
    double jd_utc = jd_tt - (kLeapSecondsSince2017 + kTTMinusTAI) / kSecondsPerDay;
    for (int i = 0; i < 4; ++i) {
        const double corrected =
            jd_tt - (tai_minus_utc(jd_utc, ok) + kTTMinusTAI) / kSecondsPerDay;
        if (std::fabs(corrected - jd_utc) < 1e-12) break;
        jd_utc = corrected;
    }
    return jd_utc;
}

double jd_tt_to_tdb(double jd_tt) {
    // Moyer / Vallado eq. 3-50, truncated series; < 2 ms over 1900-2100,
    // which is far below anything else in this library.
    const double t = centuries_since_j2000(jd_tt);
    const double g_deg = 357.528 + 35999.050 * t;  // mean anomaly of the Sun
    const double g = g_deg * kPi / 180.0;
    const double sec = 0.001658 * std::sin(g) + 0.000014 * std::sin(2.0 * g);
    return jd_tt + sec / kSecondsPerDay;
}

double centuries_since_j2000(double jd_tt) { return (jd_tt - kJ2000JD) / 36525.0; }

double ut1_minus_utc(double jd_utc) {
    (void)jd_utc;
    // Requires IERS Bulletin A (DUT1). Without it the honest answer is 0 and
    // an explicit note: |UT1-UTC| is guaranteed < 0.9 s, i.e. < 400 m of
    // Earth-rotation angle.
    return 0.0;
}

// ---------------------------------------------------------------------------
// Earth rotation
// ---------------------------------------------------------------------------

double gmst_from_jd_ut1(double jd_ut1) {
    const double t = (jd_ut1 - kJ2000JD) / 36525.0;
    // IAU 1982 polynomial, seconds of time -> radians.
    double sec = 67310.54841 +
                 (876600.0 * 3600.0 + 8640184.812866) * t +
                 0.093104 * t * t -
                 6.2e-6 * t * t * t;
    // Convert seconds of time to radians: 1 s of time = 15 arcsec.
    const double rad = sec * 15.0 * kArcsecToRad;
    // Wrap into [0, 2pi).
    double out = std::fmod(rad, kTwoPi);
    if (out < 0.0) out += kTwoPi;
    return out;
}

double mean_obliquity(double jd_tt) {
    const double t = centuries_since_j2000(jd_tt);
    const double arcsec =
        84381.448 - 46.8150 * t - 0.00059 * t * t + 0.001813 * t * t * t;
    return arcsec * kArcsecToRad;
}

namespace {
// IAU 1980 nutation, dominant terms. Coefficients are
// {l, lp, F, D, Omega, dpsi_coef(0.0001"), dpsi_t_coef, deps_coef, deps_t_coef}
// with the argument in degrees. Truncating at 20 terms keeps us within about
// 0.5 arcsec (~15 m at the surface), which is the accuracy budget for
// ground-station pointing, not for VLBI.
struct NutTerm {
    int l;      // mean anomaly of the Moon
    int lp;     // mean anomaly of the Sun
    int F;      // L - Omega
    int D;      // mean elongation of the Moon from the Sun
    int Om;     // longitude of the ascending node of the Moon
    double sp;  // dpsi sine coefficient [1e-4 arcsec]
    double spt; // dpsi sine coefficient * T
    double ce;  // deps cosine coefficient [1e-4 arcsec]
    double cet; // deps cosine coefficient * T
};

const std::array<NutTerm, 20>& nut_terms() {
    static const std::array<NutTerm, 20> terms = {{
        {0, 0, 0, 0, 1, -171996.0, -174.2, 92025.0, 8.9},
        {0, 0, 0, 0, 2, 2062.0, 0.2, -895.0, 0.5},
        {-2, 0, 2, 0, 1, 46.0, 0.0, -24.0, 0.0},
        {2, 0, -2, 0, 0, 11.0, 0.0, 0.0, 0.0},
        {-2, 0, 2, 0, 2, -3.0, 0.0, 1.0, 0.0},
        {1, -1, 0, -1, 0, -3.0, 0.0, 0.0, 0.0},
        {0, -2, 2, -2, 1, -2.0, 0.0, 1.0, 0.0},
        {2, 0, 0, -2, 2, 1.0, 0.0, 0.0, 0.0},
        {0, 0, 2, -2, 2, -13187.0, -1.6, 5736.0, -3.1},
        {0, 1, 0, 0, 0, 1426.0, -3.4, 54.0, -0.1},
        {0, 1, 2, -2, 2, -517.0, 1.2, 224.0, -0.6},
        {0, -1, 2, -2, 2, 217.0, -0.5, -95.0, 0.3},
        {0, 0, 2, -2, 1, 129.0, 0.1, -70.0, 0.0},
        {2, 0, 0, -2, 0, 48.0, 0.0, 1.0, 0.0},
        {0, 0, 2, -2, 0, -22.0, 0.0, 0.0, 0.0},
        {0, 2, 0, 0, 0, 17.0, -0.1, 0.0, 0.0},
        {0, 1, 0, 0, 1, -15.0, 0.0, 9.0, 0.0},
        {0, 2, 2, -2, 2, -16.0, 0.1, 7.0, 0.0},
        {0, -1, 0, 0, 1, -12.0, 0.0, 6.0, 0.0},
        {-2, 0, 0, 2, 1, -6.0, 0.0, 3.0, 0.0},
    }};
    return terms;
}
}  // namespace

Nutation nutation_iau1980(double jd_tt) {
    const double t = centuries_since_j2000(jd_tt);
    // Fundamental arguments, degrees.
    const double l = std::fmod(134.96298139 + (1325.0 * 360.0 + 198.8673981) * t +
                                  0.0086972 * t * t + 1.78e-5 * t * t * t,
                              360.0);
    const double lp = std::fmod(357.52772333 + (99.0 * 360.0 + 359.0503400) * t -
                                    0.0001603 * t * t - 3.3e-6 * t * t * t,
                                360.0);
    const double F = std::fmod(93.27191028 + (1342.0 * 360.0 + 82.0175381) * t -
                                   0.0036825 * t * t + 3.1e-6 * t * t * t,
                               360.0);
    const double D = std::fmod(297.85036306 + (1236.0 * 360.0 + 307.1114800) * t -
                                   0.0001875 * t * t + 3.3e-6 * t * t * t,
                               360.0);
    const double Om = std::fmod(125.04452222 - (5.0 * 360.0 + 134.1362608) * t +
                                    0.0020708 * t * t + 2.2e-6 * t * t * t,
                                360.0);

    double dpsi = 0.0;
    double deps = 0.0;
    for (const auto& e : nut_terms()) {
        const double arg = (e.l * l + e.lp * lp + e.F * F + e.D * D + e.Om * Om) *
                           kPi / 180.0;
        dpsi += (e.sp + e.spt * t) * std::sin(arg);
        deps += (e.ce + e.cet * t) * std::cos(arg);
    }
    Nutation out{};
    out.dpsi = dpsi * 1e-4 * kArcsecToRad;
    out.deps = deps * 1e-4 * kArcsecToRad;
    return out;
}

double equation_of_equinoxes(double jd_tt) {
    const Nutation n = nutation_iau1980(jd_tt);
    return n.dpsi * std::cos(mean_obliquity(jd_tt));
}

double gast_from_jd_ut1(double jd_ut1) {
    // GAST = GMST(UT1) + EqEq(TT). UT1 and TT differ by < 70 s, over which the
    // nutation argument drifts negligibly, so evaluating EqEq at TT==UT1 is
    // consistent to < 1e-9 rad.
    const double gmst = gmst_from_jd_ut1(jd_ut1);
    const double eqeq = equation_of_equinoxes(jd_ut1);
    double out = std::fmod(gmst + eqeq, kTwoPi);
    if (out < 0.0) out += kTwoPi;
    return out;
}

}  // namespace starpivot
