// starpivot/constants.hpp -- unit conventions and physical constants.
//
// Unit rule: the kernel is unit-agnostic. Callers pick a consistent system and
// pass the matching G. The most common choice (used by every test here) is
//
//     length = AU, mass = solar mass, time = year
//
// which makes G exactly 4*pi^2 because Earth's orbit then has period 1 year at
// a = 1 AU. Keeping G exact in this system removes one source of round-off
// from the verification baselines.

#ifndef STARPIVOT_CONSTANTS_HPP
#define STARPIVOT_CONSTANTS_HPP

#include <cmath>

namespace starpivot {

// M_PI is not required by the C++ standard (MSVC hides it unless
// _USE_MATH_DEFINES is set), so the kernel carries its own.
constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 6.28318530717958647692;

namespace units {

/// AU^3 / (Msun * yr^2). Exact within the AU/Msun/yr convention.
constexpr double G_AU_MSUN_YR = 4.0 * kPi * kPi;

/// SI gravitational constant, for callers working in metres / kg / seconds.
constexpr double G_SI = 6.67430e-11;

}  // namespace units

namespace mass {

constexpr double SUN = 1.0;                 // in Msun by definition
constexpr double EARTH = 3.0034895966e-6;   // Msun
constexpr double JUPITER = 9.547919e-4;     // Msun

}  // namespace mass

/// Days per Julian year, for converting step sizes expressed in days.
constexpr double DAYS_PER_YEAR = 365.25;

}  // namespace starpivot

#endif  // STARPIVOT_CONSTANTS_HPP
