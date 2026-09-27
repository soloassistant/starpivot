// starpivot/system.hpp -- body and system containers for the physics kernel.

#ifndef STARPIVOT_SYSTEM_HPP
#define STARPIVOT_SYSTEM_HPP

#include <cstddef>
#include <string>
#include <vector>

#include "starpivot/vec3.hpp"

namespace starpivot {

struct Body {
    std::string id;
    double mass = 0.0;
    Vec3 position;
    Vec3 velocity;

    Body() = default;
    Body(std::string id_, double mass_, Vec3 pos, Vec3 vel)
        : id(std::move(id_)), mass(mass_), position(pos), velocity(vel) {}
};

struct System {
    std::vector<Body> bodies;
    double time = 0.0;
    double G = 1.0;
    double softening = 0.0;  // Plummer softening length; 0.0 = pure point mass

    std::size_t size() const { return bodies.size(); }
    void reserve(std::size_t n) { bodies.reserve(n); }
};

}  // namespace starpivot

#endif  // STARPIVOT_SYSTEM_HPP
