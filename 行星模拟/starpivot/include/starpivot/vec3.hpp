// starpivot/vec3.hpp -- 3-vector for the physics kernel.
//
// Plain aggregate: no virtuals, no allocation, trivially copyable. The hot
// force loop runs on these, so every operation is constexpr/inline and returns
// by value. Deliberately NOT Eigen or any other third-party library: the
// kernel must build with only the C++17 standard library.

#ifndef STARPIVOT_VEC3_HPP
#define STARPIVOT_VEC3_HPP

#include <cmath>

namespace starpivot {

struct Vec3 {
    double x = 0.0;
    double y = 0.0;
    double z = 0.0;

    constexpr Vec3() = default;
    constexpr Vec3(double x_, double y_, double z_) : x(x_), y(y_), z(z_) {}

    constexpr Vec3 operator+(const Vec3& o) const { return Vec3(x + o.x, y + o.y, z + o.z); }
    constexpr Vec3 operator-(const Vec3& o) const { return Vec3(x - o.x, y - o.y, z - o.z); }
    constexpr Vec3 operator-() const { return Vec3(-x, -y, -z); }

    constexpr Vec3& operator+=(const Vec3& o) {
        x += o.x; y += o.y; z += o.z;
        return *this;
    }
    constexpr Vec3& operator-=(const Vec3& o) {
        x -= o.x; y -= o.y; z -= o.z;
        return *this;
    }
    constexpr Vec3& operator*=(double s) {
        x *= s; y *= s; z *= s;
        return *this;
    }

    constexpr double dot(const Vec3& o) const { return x * o.x + y * o.y + z * o.z; }
    constexpr double norm_sq() const { return x * x + y * y + z * z; }

    constexpr Vec3 cross(const Vec3& o) const {
        return Vec3(y * o.z - z * o.y, z * o.x - x * o.z, x * o.y - y * o.x);
    }

    double norm() const { return std::sqrt(norm_sq()); }
};

constexpr Vec3 operator*(const Vec3& v, double s) { return Vec3(v.x * s, v.y * s, v.z * s); }
constexpr Vec3 operator*(double s, const Vec3& v) { return Vec3(v.x * s, v.y * s, v.z * s); }
constexpr Vec3 operator/(const Vec3& v, double s) { return Vec3(v.x / s, v.y / s, v.z / s); }

}  // namespace starpivot

#endif  // STARPIVOT_VEC3_HPP
