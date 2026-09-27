// pybind11 bindings.
//
// Python is a CONSUMER of the kernel. Every number these functions return is
// produced by C++ in src/. The bindings exist so that .xsys scenario files,
// pytest suites and notebooks can drive the kernel; there is no physics here
// and none may be added here.

#include <pybind11/pybind11.h>
#include <pybind11/stl.h>

#include <string>
#include <vector>

#include "starpivot/constants.hpp"
#include "starpivot/elements.hpp"
#include "starpivot/gravity.hpp"
#include "starpivot/hermite.hpp"
#include "starpivot/leapfrog.hpp"
#include "starpivot/system.hpp"
#include "starpivot/vec3.hpp"

namespace py = pybind11;
using namespace starpivot;

PYBIND11_MODULE(starpivot_native, m) {
    m.doc() = "starpivot physics kernel (C++17); Python bindings only, no math here";

    py::class_<Vec3>(m, "Vec3")
        .def(py::init<>())
        .def(py::init<double, double, double>())
        .def_readwrite("x", &Vec3::x)
        .def_readwrite("y", &Vec3::y)
        .def_readwrite("z", &Vec3::z)
        .def("dot", &Vec3::dot)
        .def("cross", &Vec3::cross)
        .def("norm", &Vec3::norm)
        .def("__add__", [](const Vec3& a, const Vec3& b) { return a + b; })
        .def("__sub__", [](const Vec3& a, const Vec3& b) { return a - b; })
        .def("__mul__", [](const Vec3& a, double s) { return a * s; })
        .def("__rmul__", [](const Vec3& a, double s) { return a * s; })
        .def("__repr__", [](const Vec3& v) {
            return "Vec3(" + std::to_string(v.x) + ", " + std::to_string(v.y) + ", " +
                   std::to_string(v.z) + ")";
        });

    py::class_<Body>(m, "Body")
        .def(py::init<>())
        .def(py::init<std::string, double, Vec3, Vec3>())
        .def_readwrite("id", &Body::id)
        .def_readwrite("mass", &Body::mass)
        .def_readwrite("position", &Body::position)
        .def_readwrite("velocity", &Body::velocity);

    py::class_<System>(m, "System")
        .def(py::init<>())
        .def_readwrite("bodies", &System::bodies)
        .def_readwrite("time", &System::time)
        .def_readwrite("G", &System::G)
        .def_readwrite("softening", &System::softening)
        .def("add_body", [](System& s, const Body& b) { s.bodies.push_back(b); });

    py::class_<OrbitalElements>(m, "OrbitalElements")
        .def_readonly("semi_major_axis", &OrbitalElements::semi_major_axis)
        .def_readonly("eccentricity", &OrbitalElements::eccentricity)
        .def_readonly("inclination", &OrbitalElements::inclination)
        .def_readonly("period", &OrbitalElements::period)
        .def_readonly("bound", &OrbitalElements::bound);

    py::class_<Hermite4>(m, "Hermite4")
        .def(py::init<System&>(), py::keep_alive<1, 2>())
        .def("step", &Hermite4::step)
        .def("run", &Hermite4::run)
        .def_property_readonly("last_energy_error", &Hermite4::last_energy_error);

    py::class_<Leapfrog2>(m, "Leapfrog2")
        .def(py::init<System&>(), py::keep_alive<1, 2>())
        .def("step", &Leapfrog2::step)
        .def("run", &Leapfrog2::run)
        .def_property_readonly("last_energy_error", &Leapfrog2::last_energy_error);

    m.def("compute_elements", &compute_elements);
    m.def("total_energy", &total_energy);
    m.def("total_momentum", &total_momentum);
    m.def("center_of_mass", &center_of_mass);
    m.def("to_barycentric", &to_barycentric);

    m.def("compute_acceleration",
          [](const std::vector<Body>& bodies, double G, double softening) {
              std::vector<Vec3> a(bodies.size());
              compute_acceleration(bodies, a, G, softening * softening);
              return a;
          });

    // Constants, so scenario generators do not hardcode 4*pi^2.
    m.attr("G_AU_MSUN_YR") = units::G_AU_MSUN_YR;
    m.attr("G_SI") = units::G_SI;
    m.attr("MASS_SUN") = mass::SUN;
    m.attr("MASS_EARTH") = mass::EARTH;
    m.attr("MASS_JUPITER") = mass::JUPITER;
}
