// starpivot/tests/fixtures.hpp -- reference systems shared by the test suite.

#ifndef STARPIVOT_TESTS_FIXTURES_HPP
#define STARPIVOT_TESTS_FIXTURES_HPP

#include <cmath>

#include "starpivot/constants.hpp"
#include "starpivot/system.hpp"

namespace starpivot {
namespace test {

/// Sun + Earth on a circular orbit at `a` AU, in the barycentric frame.
/// Units AU / Msun / yr, so G = 4 pi^2 and the period is a^1.5 years.
inline System two_body_circular(double a = 1.0) {
    const double G = units::G_AU_MSUN_YR;
    const double M = mass::SUN;
    const double m = mass::EARTH;
    const double n = std::sqrt(G * (M + m) / (a * a * a));  // mean motion

    const double xe = a * M / (M + m);
    const double xs = -a * m / (M + m);

    // Both bodies orbit the barycentre in OPPOSITE directions. Writing the Sun's
    // velocity as (0, -n*xs, 0) instead of (0, n*xs, 0) puts the two bodies in
    // co-moving rotation: total momentum becomes 3.8e-5 instead of 0 and the
    // "circular" orbit comes out at e = 1.2e-5. The two-body baseline still
    // passes because it only checks how e CHANGES, not that it starts at zero --
    // which is exactly why the Lagrange baseline is kept: it is sensitive to the
    // initial state, not just to its invariance.
    System sys;
    sys.G = G;
    sys.bodies.push_back(Body("sun", M, Vec3(xs, 0.0, 0.0), Vec3(0.0, n * xs, 0.0)));
    sys.bodies.push_back(Body("earth", m, Vec3(xe, 0.0, 0.0), Vec3(0.0, n * xe, 0.0)));
    return sys;
}

/// Mean motion of the two-body fixture (rad/yr).
inline double two_body_mean_motion(double a = 1.0) {
    const double G = units::G_AU_MSUN_YR;
    return std::sqrt(G * (mass::SUN + mass::EARTH) / (a * a * a));
}

/// Sun + four planets, Jupiter mass x10, to force strong mutual perturbation.
/// All orbits start circular and coplanar, phased apart.
inline System perturbed_system() {
    const double G = units::G_AU_MSUN_YR;
    System sys;
    sys.G = G;
    sys.bodies.push_back(Body("sun", mass::SUN, Vec3(), Vec3()));

    struct Spec {
        const char* id;
        double m;
        double a;
        double phase;
    };
    const Spec specs[] = {
        {"p1", 1e-6, 0.40, 0.0},
        {"p2", 2e-6, 0.70, 1.1},
        {"p3", 1e-5, 1.50, 2.4},
        {"jup", mass::JUPITER * 10.0, 5.20, 4.0},
    };
    for (const Spec& s : specs) {
        const double n = std::sqrt(G * (mass::SUN + s.m) / (s.a * s.a * s.a));
        const double x = s.a * std::cos(s.phase);
        const double y = s.a * std::sin(s.phase);
        const double v = n * s.a;
        sys.bodies.push_back(Body(s.id, s.m, Vec3(x, y, 0.0),
                                  Vec3(-v * std::sin(s.phase), v * std::cos(s.phase), 0.0)));
    }
    return sys;
}

/// Equal-mass three-body Figure-8 choreography (Chenciner & Montgomery 2000).
/// G = 1, m = 1, period = 6.32591398.
inline System figure8() {
    const double x1 = 0.97000436;
    const double y1 = -0.24308753;
    const double vx3 = -0.93240737;
    const double vy3 = -0.86473146;
    const double vx1 = -vx3 / 2.0;
    const double vy1 = -vy3 / 2.0;

    System sys;
    sys.G = 1.0;
    sys.bodies.push_back(Body("b1", 1.0, Vec3(x1, y1, 0.0), Vec3(vx1, vy1, 0.0)));
    sys.bodies.push_back(Body("b2", 1.0, Vec3(-x1, -y1, 0.0), Vec3(vx1, vy1, 0.0)));
    sys.bodies.push_back(Body("b3", 1.0, Vec3(0.0, 0.0, 0.0), Vec3(vx3, vy3, 0.0)));
    return sys;
}

inline constexpr double kFigure8Period = 6.32591398;

/// Sun + Earth + a massless-ish Trojan at the L4 point of the Sun-Earth system.
///
/// L4 sits at the third vertex of the equilateral triangle whose other two
/// vertices are the two primaries. With mu = m2/(m1+m2) = 3e-6, far below the
/// Routh criterion 0.03852, L4 is linearly stable: a body placed there should
/// librate (tadpole orbit) rather than escape.
inline Vec3 sun_earth_l4(double a = 1.0) {
    const double M = mass::SUN;
    const double m = mass::EARTH;
    const double xs = -a * m / (M + m);  // Sun position, barycentre at origin
    // third vertex of the equilateral triangle, measured from the Sun
    return Vec3(xs + a * 0.5, a * std::sqrt(3.0) / 2.0, 0.0);
}

/// Rigid rotation velocity for a point corotating with the Sun-Earth pair.
inline Vec3 corotating_velocity(const Vec3& r, double a = 1.0) {
    const double G = units::G_AU_MSUN_YR;
    const double omega = std::sqrt(G * (mass::SUN + mass::EARTH) / (a * a * a));
    return Vec3(-omega * r.y, omega * r.x, 0.0);
}

/// Sun + Earth + test particle placed at `pos` with the corotating velocity.
/// The Trojan mass is tiny so it perturbs the primaries negligibly.
inline System lagrange_system(const Vec3& pos, double a = 1.0, double trojan_mass = 1e-14) {
    System sys = two_body_circular(a);
    sys.bodies.push_back(Body("trojan", trojan_mass, pos, corotating_velocity(pos, a)));
    return sys;
}

/// Collinear L1 point of the Sun-Earth system, on the Sun-Earth line, inside
/// Earth's orbit. Solved from the quintic by a few Newton iterations from the
/// Hill-radius approximation. L1 is linearly UNSTABLE, which the test asserts.
inline double sun_earth_l1(double a = 1.0) {
    const double mu = mass::EARTH / (mass::SUN + mass::EARTH);
    // Hill-radius seed: gamma = (mu/3)^(1/3), distance from Earth toward the Sun
    double gamma = std::cbrt(mu / 3.0);
    for (int it = 0; it < 80; ++it) {
        // f(g) for the L1 distance from the secondary, in units of a
        const double g2 = gamma * gamma;
        const double g3 = g2 * gamma;
        const double g4 = g3 * gamma;
        const double g5 = g4 * gamma;
        // standard L1 polynomial (mu small, distance measured from secondary)
        const double f = g5 - (3.0 - mu) * g4 + (3.0 - 2.0 * mu) * g3 - mu * g2 +
                         2.0 * mu * gamma - mu;
        const double df = 5.0 * g4 - 4.0 * (3.0 - mu) * g3 + 3.0 * (3.0 - 2.0 * mu) * g2 -
                          2.0 * mu * gamma + 2.0 * mu;
        if (df == 0.0) break;
        const double step = f / df;
        gamma -= step;
        if (std::fabs(step) < 1e-15) break;
    }
    return a - gamma * a;  // measured from the Sun, along +x toward Earth
}

}  // namespace test
}  // namespace starpivot

#endif  // STARPIVOT_TESTS_FIXTURES_HPP
