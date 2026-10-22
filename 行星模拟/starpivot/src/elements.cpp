// starpivot/src/elements.cpp -- osculating elements and conserved quantities.

#include "starpivot/elements.hpp"

#include <cmath>
#include <cstddef>

#include "starpivot/constants.hpp"

namespace starpivot {

OrbitalElements compute_elements(const Body& central, const Body& orbiting, double G) {
    const Vec3 r = orbiting.position - central.position;
    const Vec3 v = orbiting.velocity - central.velocity;

    const double mu = G * (central.mass + orbiting.mass);
    const double rn = r.norm();
    const double vn2 = v.norm_sq();

    // vis-viva:  eps = v^2/2 - mu/r = -mu/(2a)
    const double eps = 0.5 * vn2 - mu / rn;

    OrbitalElements out;
    out.bound = (eps < 0.0);
    out.semi_major_axis = (eps != 0.0) ? (-mu / (2.0 * eps)) : 0.0;

    // e vector = ((v^2 - mu/r) r - (r.v) v) / mu
    const Vec3 evec = (r * (vn2 - mu / rn) - v * r.dot(v)) * (1.0 / mu);
    out.eccentricity = evec.norm();

    const Vec3 h = r.cross(v);
    const double hn = h.norm();
    out.inclination = (hn > 0.0) ? std::acos(std::fmin(1.0, std::fmax(-1.0, h.z / hn)))
                                 : 0.0;

    if (out.bound && out.semi_major_axis > 0.0) {
        out.period = kTwoPi * std::sqrt(
            out.semi_major_axis * out.semi_major_axis * out.semi_major_axis / mu);
    }
    return out;
}

double total_energy(const System& sys) {
    const double eps2 = sys.softening * sys.softening;
    double kinetic = 0.0;
    double potential = 0.0;

    for (const Body& b : sys.bodies) {
        kinetic += 0.5 * b.mass * b.velocity.norm_sq();
    }
    const std::size_t n = sys.bodies.size();
    for (std::size_t i = 0; i < n; ++i) {
        for (std::size_t k = i + 1; k < n; ++k) {
            const Vec3 d = sys.bodies[i].position - sys.bodies[k].position;
            potential -= sys.G * sys.bodies[i].mass * sys.bodies[k].mass /
                         std::sqrt(d.norm_sq() + eps2);
        }
    }
    return kinetic + potential;
}

Vec3 total_momentum(const System& sys) {
    Vec3 p;
    for (const Body& b : sys.bodies) {
        p += b.velocity * b.mass;
    }
    return p;
}

Vec3 center_of_mass(const System& sys) {
    Vec3 com;
    double m_total = 0.0;
    for (const Body& b : sys.bodies) {
        com += b.position * b.mass;
        m_total += b.mass;
    }
    return (m_total > 0.0) ? com * (1.0 / m_total) : Vec3{};
}

void to_barycentric(System& sys) {
    Vec3 com;
    Vec3 mom;
    double m_total = 0.0;
    for (const Body& b : sys.bodies) {
        com += b.position * b.mass;
        mom += b.velocity * b.mass;
        m_total += b.mass;
    }
    if (m_total <= 0.0) return;
    const Vec3 vcom = mom * (1.0 / m_total);
    const Vec3 rcom = com * (1.0 / m_total);
    for (Body& b : sys.bodies) {
        b.position -= rcom;
        b.velocity -= vcom;
    }
}

}  // namespace starpivot
