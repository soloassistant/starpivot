// starpivot command line interface.
//
// This is the product surface: everything a user can do with the kernel
// without writing C++. It emits JSON on stdout so that the web viewer, a
// notebook, or another service can consume the same output the terminal shows.
//
// Design rules:
//   * Every numeric result is printed with enough digits to be checkable.
//   * Units are always in the key name (km, deg, s, rad_per_s). Silent unit
//     changes are how orbital software loses spacecraft.
//   * A model that is not implemented says so explicitly rather than
//     returning a plausible-looking number. Once a propagator is wired in, the
//     command reports real output and the numbers are checkable against the
//     published reference vectors. `verify-tle` is now that real path (SGP4
//     for near-earth, SDP4 for deep-space), verified against Vallado Appendix D.

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "starpivot/perturb.hpp"
#include "starpivot/sgp4.hpp"
#include "starpivot/conjunction.hpp"
#include "starpivot/groundtrack.hpp"
#include "starpivot/collision.hpp"
#include "starpivot/bodyprops.hpp"
#include "starpivot/gravity.hpp"
#include "starpivot/hermite.hpp"
#include "starpivot/leapfrog.hpp"
#include "starpivot/time.hpp"
#include "starpivot/bio.hpp"
#include "starpivot/bodytype.hpp"
#include "starpivot/constants.hpp"
#include "starpivot/lagrange.hpp"
#include "starpivot/genesis.hpp"
#include "starpivot/vec3.hpp"
#include "starpivot/system.hpp"
#include "starpivot/gravity.hpp"
#include "starpivot/leapfrog.hpp"
#include "starpivot/elements.hpp"
#include "starpivot/constants.hpp"

#include <algorithm>

namespace {

using starpivot::LagrangeSolution;
using starpivot::LagrangePoint;
using starpivot::solve_lagrange;
using starpivot::GenesisSystem;
using starpivot::GenesisBody;
using starpivot::generate_system;
namespace mass = starpivot::mass;

/// 把字符串安全地放进 JSON：转义引号/反斜杠/控制字符，并保证输出是合法 UTF-8。
/// 定义在 cmd_genesis 之前，但 cmd_lagrange 更早就要用它，所以这里先声明。
static std::string json_safe(const std::string& s, bool* wellformed = nullptr);

using starpivot::Vec3;
using starpivot::Tle;
using starpivot::Sgp4;
using starpivot::Sgp4Error;
using starpivot::parse_tle;
using starpivot::sgp4_init;
using starpivot::sgp4_propagate;
using starpivot::sgp4_error_string;
using starpivot::iso_from_jd;
using starpivot::find_conjunction;
using starpivot::ConjunctionResult;
using starpivot::ground_track;
using starpivot::subpoint_from_teme;
using starpivot::GroundSample;
using starpivot::Subpoint;
using starpivot::CollisionMode;
using starpivot::CollisionSetup;
using starpivot::CollisionEvent;
using starpivot::find_collision;
using starpivot::merge_bodies;
using starpivot::fragment_body;
using starpivot::merged_radius;
using starpivot::known_radius_km;
using starpivot::BodyType;
using starpivot::RadiusModel;
using starpivot::LumModel;
using starpivot::TypeGroup;
using starpivot::Variability;
using starpivot::find_body_type;
using starpivot::known_body_type;
using starpivot::body_types;
using starpivot::body_type_keys_joined;
using starpivot::body_type_radius_km;
using starpivot::body_type_luminosity;
using starpivot::body_type_t_eff;
using starpivot::body_emits_light;
using starpivot::sb_radius_km;
using starpivot::lum_from_radius_t_eff;
using starpivot::kHydrogenBurningLimit_Msun;
using starpivot::kSunT_eff_K;
using starpivot::density_g_cm3;
using starpivot::radius_km_from_mass_density;
using starpivot::mass_msun_from_radius_density;
using starpivot::Body;
using starpivot::System;
using starpivot::Leapfrog2;
using starpivot::total_energy;
using starpivot::total_momentum;
using starpivot::to_barycentric;
using starpivot::units::G_AU_MSUN_YR;

constexpr double kPi = 3.14159265358979323846;
// 太阳系行星表里"地球"那一项用的质量（M☉）。单独提出来当唯一出处：
// 页面要做"相当于几个地球"的换算，用的必须是同一个数 —— 两边各写一遍迟早走散
// （第一版就是回显里写 3.0034896149e-6、表里写 3.003489e-6，第 7 位已经不一样了）。
constexpr double kEarthMassMsun = 3.003489e-6;
constexpr double kDeg = kPi / 180.0;

void die(const std::string& msg) {
    std::fprintf(stderr, "starpivot: %s\n", msg.c_str());
    std::exit(2);
}

double arg_double(const std::string& name, const std::string& value) {
    try {
        return std::stod(value);
    } catch (...) {
        die("option " + name + " expects a number, got '" + value + "'");
    }
    return 0.0;
}

// ---------------------------------------------------------------------------
// Keplerian <-> Cartesian in km / km per second
// ---------------------------------------------------------------------------

struct State {
    Vec3 r;
    Vec3 v;
};

State from_elements(double a, double e, double inc_deg, double raan_deg,
                    double argp_deg, double nu_deg, double mu) {
    const double inc = inc_deg * kDeg;
    const double raan = raan_deg * kDeg;
    const double argp = argp_deg * kDeg;
    const double nu = nu_deg * kDeg;

    const double p = a * (1.0 - e * e);
    const double rmag = p / (1.0 + e * std::cos(nu));
    const Vec3 rpf(std::cos(nu), std::sin(nu), 0.0);
    const Vec3 vpf(-std::sin(nu), e + std::cos(nu), 0.0);
    const double h = std::sqrt(mu * p);
    const Vec3 r0 = rpf * rmag;
    const Vec3 v0 = vpf * (h / p);

    const double cO = std::cos(raan), sO = std::sin(raan);
    const double ci = std::cos(inc), si = std::sin(inc);
    const double cw = std::cos(argp), sw = std::sin(argp);
    const double m11 = cO * cw - sO * sw * ci, m12 = -cO * sw - sO * cw * ci;
    const double m21 = sO * cw + cO * sw * ci, m22 = -sO * sw + cO * cw * ci;
    const double m31 = sw * si, m32 = cw * si;

    State s{};
    s.r = Vec3(m11 * r0.x + m12 * r0.y, m21 * r0.x + m22 * r0.y, m31 * r0.x + m32 * r0.y);
    s.v = Vec3(m11 * v0.x + m12 * v0.y, m21 * v0.x + m22 * v0.y, m31 * v0.x + m32 * v0.y);
    return s;
}

struct Elements {
    double a, e, inc_deg, raan_deg, argp_deg, period_s;
};

Elements to_elements(const Vec3& r, const Vec3& v, double mu) {
    const double rn = r.norm(), vn = v.norm();
    Elements el{};
    el.a = 1.0 / (2.0 / rn - vn * vn / mu);
    const Vec3 h = r.cross(v);
    const Vec3 nvec = Vec3(0, 0, 1).cross(h);
    const double hn = h.norm();
    el.inc_deg = std::acos(h.z / hn) / kDeg;
    el.raan_deg = std::atan2(h.x, -h.y) / kDeg;
    const double rv = r.dot(v);
    const Vec3 evec = r * (vn * vn - mu / rn) - v * rv;
    el.e = evec.norm() / mu;
    const Vec3 ehat = evec * (1.0 / evec.norm());
    const Vec3 nhat = nvec * (1.0 / nvec.norm());
    const Vec3 hhat = h * (1.0 / hn);
    el.argp_deg = std::atan2(ehat.dot(hhat.cross(nhat)), ehat.dot(nhat)) / kDeg;
    el.period_s = (el.a > 0.0) ? 2.0 * kPi * std::sqrt(el.a * el.a * el.a / mu) : 0.0;
    if (el.raan_deg < 0.0) el.raan_deg += 360.0;
    if (el.argp_deg < 0.0) el.argp_deg += 360.0;
    return el;
}

// ---------------------------------------------------------------------------
// Force model and integrator (RK4, fixed step -- adequate for a CLI demo;
// the library's Hermite4 is the adaptive production path)
// ---------------------------------------------------------------------------

struct Options {
    double mu = starpivot::kMuEarth;
    bool j2 = true;
    bool drag = false;
    bool srp = false;
    starpivot::Spacecraft sc{};
    Vec3 r_sun{starpivot::kAuKm, 0.0, 0.0};
};

Vec3 acceleration(const Vec3& r, const Vec3& v, const Options& o) {
    const double rn = r.norm();
    Vec3 a = r * (-o.mu / (rn * rn * rn));
    if (o.j2) a += starpivot::zonal_gravity_earth(r);
    if (o.drag) a += starpivot::drag_acceleration(r, v, Vec3(0, 0, 1), o.sc, 7.292115e-5);
    if (o.srp) a += starpivot::srp_acceleration(r, o.r_sun, o.sc);
    return a;
}

void rk4(State& s, double dt, const Options& o) {
    const Vec3 k1r = s.v, k1v = acceleration(s.r, s.v, o);
    const Vec3 k2r = s.v + k1v * (dt * 0.5);
    const Vec3 k2v = acceleration(s.r + k1r * (dt * 0.5), s.v + k1v * (dt * 0.5), o);
    const Vec3 k3r = s.v + k2v * (dt * 0.5);
    const Vec3 k3v = acceleration(s.r + k2r * (dt * 0.5), s.v + k2v * (dt * 0.5), o);
    const Vec3 k4r = s.v + k3v * dt;
    const Vec3 k4v = acceleration(s.r + k3r * dt, s.v + k3v * dt, o);
    s.r += (k1r + k2r * 2.0 + k3r * 2.0 + k4r) * (dt / 6.0);
    s.v += (k1v + k2v * 2.0 + k3v * 2.0 + k4v) * (dt / 6.0);
}

/// Geodetic-ish sub-satellite point. Uses a spherical Earth: the flattening
/// correction is up to ~21 km in latitude, which matters for targeting but not
/// for a ground-track plot. Stated rather than hidden.
struct Geo {
    double lat_deg;
    double lon_deg;
    double alt_km;
};

Geo to_geo(const Vec3& r_eci, double gmst_rad) {
    const double cg = std::cos(gmst_rad), sg = std::sin(gmst_rad);
    // ECI -> ECEF: rotate by -GMST about z.
    const double x = cg * r_eci.x + sg * r_eci.y;
    const double y = -sg * r_eci.x + cg * r_eci.y;
    const double z = r_eci.z;
    const double rn = std::sqrt(x * x + y * y + z * z);
    Geo g{};
    g.lat_deg = std::asin(z / rn) / kDeg;
    double lon = std::atan2(y, x) / kDeg;
    while (lon > 180.0) lon -= 360.0;
    while (lon < -180.0) lon += 360.0;
    g.lon_deg = lon;
    g.alt_km = rn - starpivot::kRadiusEarthKm;
    return g;
}

/// Orbit-averaged elements.
///
/// Reporting the difference of two *instantaneous* osculating states is
/// misleading and cost us a wrong reading during development: on a
/// near-circular LEO the J2 short-period oscillation of a is ~19 km and of
/// argp tens of degrees, both far larger than the secular drift over a few
/// hours. Sampling one instant at each end therefore reports the oscillation,
/// not the drift. Averaging over one revolution removes the short-period
/// terms and leaves the secular change, which is what the user actually asked
/// for. Angles are averaged as unit vectors so the 0/360 wrap cannot corrupt
/// the mean.
Elements orbit_average(State s, const Options& o, double period_s) {
    const int n = 240;
    const double dt = period_s / n;
    double sa = 0.0, se = 0.0, si = 0.0;
    double cx = 0.0, cy = 0.0, px = 0.0, py = 0.0;
    for (int i = 0; i < n; ++i) {
        const Elements el = to_elements(s.r, s.v, o.mu);
        sa += el.a;
        se += el.e;
        si += el.inc_deg;
        cx += std::cos(el.raan_deg * kDeg);
        cy += std::sin(el.raan_deg * kDeg);
        px += std::cos(el.argp_deg * kDeg);
        py += std::sin(el.argp_deg * kDeg);
        rk4(s, dt, o);
    }
    Elements out{};
    out.a = sa / n;
    out.e = se / n;
    out.inc_deg = si / n;
    double raan = std::atan2(cy, cx) / kDeg;
    double argp = std::atan2(py, px) / kDeg;
    if (raan < 0.0) raan += 360.0;
    if (argp < 0.0) argp += 360.0;
    out.raan_deg = raan;
    out.argp_deg = argp;
    out.period_s = period_s;
    return out;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

int cmd_propagate(const std::vector<std::string>& args) {
    double a = 7000.0, e = 0.001, inc = 51.6, raan = 0.0, argp = 0.0, nu = 0.0;
    double hours = 24.0, dt = 60.0;
    double jd0 = 2460000.5;  // 2023-02-25 00:00 UTC, arbitrary but explicit
    Options o{};

    for (std::size_t i = 0; i + 1 < args.size(); i += 2) {
        const std::string& k = args[i];
        const std::string& v = args[i + 1];
        if (k == "--a") a = arg_double(k, v);
        else if (k == "--e") e = arg_double(k, v);
        else if (k == "--inc") inc = arg_double(k, v);
        else if (k == "--raan") raan = arg_double(k, v);
        else if (k == "--argp") argp = arg_double(k, v);
        else if (k == "--nu") nu = arg_double(k, v);
        else if (k == "--hours") hours = arg_double(k, v);
        else if (k == "--step") dt = arg_double(k, v);
        else if (k == "--epoch-jd") jd0 = arg_double(k, v);
        else if (k == "--drag") o.drag = (v == "1" || v == "true" || v == "on");
        else if (k == "--srp") o.srp = (v == "1" || v == "true" || v == "on");
        else if (k == "--no-j2") o.j2 = !(v == "1" || v == "true" || v == "on");
        else if (k == "--area") o.sc.area_m2 = arg_double(k, v);
        else if (k == "--mass") o.sc.mass_kg = arg_double(k, v);
        else die("unknown option " + k);
    }

    State s = from_elements(a, e, inc, raan, argp, nu, o.mu);
    const Elements el0 = to_elements(s.r, s.v, o.mu);

    std::printf("{\n");
    std::printf("  \"model\": {\n");
    std::printf("    \"integrator\": \"rk4-fixed\",\n");
    std::printf("    \"step_s\": %.6g,\n", dt);
    std::printf("    \"gravity\": \"%s\",\n", o.j2 ? "point-mass + J2+J3+J4" : "point-mass");
    std::printf("    \"drag\": %s,\n", o.drag ? "true" : "false");
    std::printf("    \"srp\": %s,\n", o.srp ? "true" : "false");
    // Spacecraft properties are echoed whenever they actually enter the physics
    // (drag and SRP both act through A/m * cd/cr). Without them the output is not
    // self-describing: viewer/demo.js holds a drag sample whose generating command
    // could not be recovered from the file at all, and with the generator script
    // gone the only way back was to fit a scalar against the 641 recorded points.
    if (o.drag || o.srp) {
        std::printf("    \"spacecraft\": {\"area_m2\": %.10g, \"mass_kg\": %.10g, "
                    "\"cd\": %.6g, \"cr\": %.6g",
                    o.sc.area_m2, o.sc.mass_kg, o.sc.cd, o.sc.cr);
        // A/m is the quantity that matters; with mass <= 0 it is undefined, and an
        // undefined value is reported by omitting the key rather than by writing a 0.
        if (o.sc.mass_kg > 0.0)
            std::printf(", \"area_over_mass_m2_per_kg\": %.6g", o.sc.area_m2 / o.sc.mass_kg);
        std::printf("},\n");
    }
    std::printf("    \"earth_model\": \"spherical for ground track (max ~21 km lat error)\"\n");
    std::printf("  },\n");
    std::printf("  \"initial_elements\": {\"a_km\": %.10g, \"e\": %.10g, \"inc_deg\": %.8g, "
                "\"raan_deg\": %.8g, \"argp_deg\": %.8g, \"period_s\": %.8g},\n",
                el0.a, el0.e, el0.inc_deg, el0.raan_deg, el0.argp_deg, el0.period_s);
    std::printf("  \"epoch_utc\": \"%s\",\n", starpivot::iso_from_jd(jd0).c_str());
    std::printf("  \"ground_track\": [\n");

    const int steps = static_cast<int>(hours * 3600.0 / dt);
    const int out_every = std::max(1, steps / 600);  // cap the payload
    bool first = true;
    for (int i = 0; i <= steps; ++i) {
        if (i % out_every == 0) {
            const double t = i * dt;
            const double jd = jd0 + t / 86400.0;
            const double gmst = starpivot::gmst_from_jd_ut1(jd);
            const Geo g = to_geo(s.r, gmst);
            if (!first) std::printf(",\n");
            first = false;
            std::printf("    {\"t_s\": %.6g, \"lat_deg\": %.5f, \"lon_deg\": %.5f, "
                        "\"alt_km\": %.4f, \"utc\": \"%s\"}",
                        t, g.lat_deg, g.lon_deg, g.alt_km,
                        starpivot::iso_from_jd(jd).c_str());
        }
        if (i < steps) rk4(s, dt, o);
    }
    std::printf("\n  ],\n");

    // Mean (orbit-averaged) elements: the secular change the user wants. The
    // instantaneous osculating difference is also printed so the size of the
    // short-period oscillation is visible rather than hidden.
    const double period = el0.period_s;
    State s_end = s;
    const Elements mean0 = orbit_average(from_elements(a, e, inc, raan, argp, nu, o.mu), o, period);
    const Elements mean1 = orbit_average(s_end, o, period);

    const Elements el1 = to_elements(s.r, s.v, o.mu);
    std::printf("  \"final_elements_osculating\": {\"a_km\": %.10g, \"e\": %.10g, "
                "\"inc_deg\": %.8g, \"raan_deg\": %.8g, \"argp_deg\": %.8g},\n",
                el1.a, el1.e, el1.inc_deg, el1.raan_deg, el1.argp_deg);

    double d_raan = mean1.raan_deg - mean0.raan_deg;
    while (d_raan > 180.0) d_raan -= 360.0;
    while (d_raan < -180.0) d_raan += 360.0;
    double d_argp = mean1.argp_deg - mean0.argp_deg;
    while (d_argp > 180.0) d_argp -= 360.0;
    while (d_argp < -180.0) d_argp += 360.0;

    std::printf("  \"mean_elements_start\": {\"a_km\": %.10g, \"e\": %.10g, \"inc_deg\": %.8g, "
                "\"raan_deg\": %.8g, \"argp_deg\": %.8g},\n",
                mean0.a, mean0.e, mean0.inc_deg, mean0.raan_deg, mean0.argp_deg);
    std::printf("  \"mean_elements_end\": {\"a_km\": %.10g, \"e\": %.10g, \"inc_deg\": %.8g, "
                "\"raan_deg\": %.8g, \"argp_deg\": %.8g},\n",
                mean1.a, mean1.e, mean1.inc_deg, mean1.raan_deg, mean1.argp_deg);
    std::printf("  \"secular_drift\": {\"da_km\": %.6g, \"de\": %.6g, \"di_deg\": %.6g, "
                "\"draan_deg\": %.6g, \"dargp_deg\": %.6g, \"draan_deg_per_day\": %.6g},\n",
                mean1.a - mean0.a, mean1.e - mean0.e, mean1.inc_deg - mean0.inc_deg,
                d_raan, d_argp, d_raan / (hours / 24.0));
    std::printf("  \"osculating_minus_mean_a_km\": %.6g,\n", el1.a - mean1.a);
    std::printf("  \"caveat\": \"secular_drift is orbit-averaged and is the physically "
                "meaningful change; the osculating final state differs from it by the "
                "short-period oscillation, which on a near-circular LEO reaches ~19 km "
                "in a and tens of degrees in argp\"\n");
    std::printf("}\n");
    return 0;
}

int cmd_j2(const std::vector<std::string>& args) {
    double a = 7000.0, e = 0.001, inc = 51.6;
    for (std::size_t i = 0; i + 1 < args.size(); i += 2) {
        const std::string& k = args[i];
        const std::string& v = args[i + 1];
        if (k == "--a") a = arg_double(k, v);
        else if (k == "--e") e = arg_double(k, v);
        else if (k == "--inc") inc = arg_double(k, v);
        else die("unknown option " + k);
    }
    const double i_rad = inc * kDeg;
    const double node = starpivot::j2_node_rate(a, e, i_rad);
    const double apsis = starpivot::j2_apsis_rate(a, e, i_rad);
    const double n = starpivot::mean_motion_from_axis(a);

    std::printf("{\n");
    std::printf("  \"a_km\": %.10g, \"e\": %.10g, \"inc_deg\": %.8g,\n", a, e, inc);
    std::printf("  \"mean_motion_rad_s\": %.12g,\n", n);
    std::printf("  \"period_s\": %.8g,\n", 2.0 * kPi / n);
    std::printf("  \"node_rate_rad_s\": %.12g,\n", node);
    std::printf("  \"node_rate_deg_day\": %.8g,\n", node / kPi * 180.0 * 86400.0);
    std::printf("  \"apsis_rate_rad_s\": %.12g,\n", apsis);
    std::printf("  \"apsis_rate_deg_day\": %.8g,\n", apsis / kPi * 180.0 * 86400.0);
    // Sun-synchronous condition: node must advance at ~0.9856 deg/day.
    const double required = 0.9856;
    std::printf("  \"sun_synchronous\": {\n");
    std::printf("    \"required_node_rate_deg_day\": %.6g,\n", required);
    std::printf("    \"actual_node_rate_deg_day\": %.6g,\n", node / kPi * 180.0 * 86400.0);
    const double sso_err = std::fabs(node / kPi * 180.0 * 86400.0 - required);
    std::printf("    \"abs_error_deg_day\": %.6g,\n", sso_err);
    std::printf("    \"is_sso_within_0p05\": %s\n", sso_err < 0.05 ? "true" : "false");
    std::printf("  },\n");
    std::printf("  \"note\": \"secular rates only; the osculating elements additionally "
                "oscillate with amplitude ~1e-3 rad within each orbit\"\n");
    std::printf("}\n");
    return 0;
}

int cmd_elements(const std::vector<std::string>& args) {
    double rx = 7000.0, ry = 0.0, rz = 0.0, vx = 0.0, vy = 7.5, vz = 1.0;
    for (std::size_t i = 0; i + 1 < args.size(); i += 2) {
        const std::string& k = args[i];
        const std::string& v = args[i + 1];
        if (k == "--r") {
            // Comma-separated.
            const std::string vv = v;
            std::size_t p1 = vv.find(',');
            std::size_t p2 = vv.rfind(',');
            rx = std::stod(vv.substr(0, p1));
            ry = std::stod(vv.substr(p1 + 1, p2 - p1 - 1));
            rz = std::stod(vv.substr(p2 + 1));
        } else if (k == "--v") {
            const std::string vv = v;
            std::size_t p1 = vv.find(',');
            std::size_t p2 = vv.rfind(',');
            vx = std::stod(vv.substr(0, p1));
            vy = std::stod(vv.substr(p1 + 1, p2 - p1 - 1));
            vz = std::stod(vv.substr(p2 + 1));
        } else die("unknown option " + k);
    }
    const Elements el = to_elements(Vec3(rx, ry, rz), Vec3(vx, vy, vz), starpivot::kMuEarth);
    std::printf("{\n");
    std::printf("  \"a_km\": %.10g,\n", el.a);
    std::printf("  \"e\": %.10g,\n", el.e);
    std::printf("  \"inc_deg\": %.8g,\n", el.inc_deg);
    std::printf("  \"raan_deg\": %.8g,\n", el.raan_deg);
    std::printf("  \"argp_deg\": %.8g,\n", el.argp_deg);
    std::printf("  \"period_s\": %.8g,\n", el.period_s);
    std::printf("  \"mu_km3_s2\": %.12g\n", starpivot::kMuEarth);
    std::printf("}\n");
    return 0;
}

// A string is a tsince token if it parses as a (possibly signed, possibly
// decimal) number. Used to slurp the variadic --tsince list without a sentinel.
bool is_number(const std::string& s) {
    if (s.empty()) return false;
    std::size_t i = 0;
    if (s[0] == '+' || s[0] == '-') ++i;
    if (i >= s.size()) return false;
    bool digit = false, dot = false;
    for (; i < s.size(); ++i) {
        if (s[i] == '.') {
            if (dot) return false;
            dot = true;
        } else if (std::isdigit(static_cast<unsigned char>(s[i]))) {
            digit = true;
        } else {
            return false;
        }
    }
    return digit;
}

// Official verification vectors: Vallado et al., AIAA 2006-6753 Rev 1, App D.
struct VExp {
    double t, r0, r1, r2, v0, v1, v2;
};
struct VCase {
    const char* name;
    const char* l1;
    const char* l2;
    bool deep;
    const VExp* pts;
    std::size_t n;
};

static const VExp k88888[] = {
    {0.0, 2328.96975262, -5995.22051338, 1719.97297192, 2.912073281, -0.983417956, -7.090816210},
    {120.0, 1020.69234558, 2286.56260634, -6191.55565927, -3.746543902, 6.467532721, 1.827985678},
    {240.0, -3226.54349155, 3503.70977525, 4532.80979343, 1.000992116, -5.788042888, 5.162585826},
    {360.0, 2456.10706533, -6071.93855503, 1222.89768554, 2.679390040, -0.448290811, -7.228792155},
};
static const VExp k28057[] = {
    {0.0, -2715.28237486, -6619.26436889, -0.01341443, -1.008587273, 0.422782003, 7.385272942},
    {120.0, -1816.87920942, -1835.78762132, 6661.07926465, 2.325140071, 6.655669329, 2.463394512},
    {240.0, 1483.17364291, 5395.21248786, 4448.65907172, 2.560540387, 4.039025766, -5.736648561},
    {360.0, 2801.25607157, 5455.03931333, -3692.12865695, -0.595095864, -3.951923117, -6.298799125},
    {480.0, 411.09332812, -1728.99769152, -6935.45548810, -2.935970964, -6.684085058, 1.492800886},
};
static const VExp k11801[] = {
    {0.0, 7473.37102491, 428.94748312, 5828.74846783, 5.107155391, 6.444680305, -0.186133297},
    {360.0, -3305.22148694, 32410.84323331, -24697.16974954, -1.301137319, -1.151315600, -0.283335823},
    {720.0, 14271.29083858, 24110.44309009, -4725.76320143, -0.320504528, 2.679841539, -2.084054355},
    {1080.0, -9990.05800009, 22717.34212448, -23616.88515553, -1.016674392, -2.290267981, 0.728923337},
};
static const VExp k14128[] = {
    {0.0, 34747.57932696, 24502.37114079, -1.32832986, -1.731642662, 2.452772615, 0.608510081},
    {120.0, 18263.33439094, 38159.96004751, 4186.18304085, -2.744396611, 1.255583260, 0.528558932},
    {240.0, -3023.38840703, 41783.13186459, 7273.03412906, -3.035574793, -0.271656544, 0.309645251},
    {360.0, -23516.34391907, 34424.42065671, 8448.49867693, -2.529120477, -1.726186020, 0.009582303},
};
static const VExp k28623[] = {
    {0.0, -11665.70902324, 24943.61433357, 25.80543633, -1.596228621, -1.476127961, 1.126059754},
    {120.0, -11645.35454950, 979.37668356, 5517.89500058, 3.407743502, -5.183094988, -0.492983277},
    {240.0, 5619.19252274, 19651.44862280, -7261.38496765, -2.013634213, 3.106842861, 0.284235517},
    {360.0, -9708.68629714, 26306.14553149, -1204.29478856, -1.824164290, -0.931909596, 1.113419052},
};
static const VExp k23333[] = {
    {0.0, -9301.24542292, 3326.10200382, 2318.36441127, -8.729303005, -0.828225037, -0.122314827},
    {120.0, -44672.91239680, -6213.11996581, -1738.80131727, -3.719475070, -1.336673022, -0.621888261},
};
static const VCase kVectors[] = {
    {"88888", "1 88888U          80275.98708465  .00073094  13844-3  66816-4 0    87",
     "2 88888  72.8435 115.9689 0086731  52.6988 110.5714 16.05824518  1058", false, k88888,
     sizeof(k88888) / sizeof(k88888[0])},
    {"28057", "1 28057U 03049A   06177.78615833  .00000060  00000-0  35940-4 0  1836",
     "2 28057  98.4283 247.6961 0000884  88.1964 271.9322 14.35478080140550", false, k28057,
     sizeof(k28057) / sizeof(k28057[0])},
    {"11801", "1 11801U          80230.29629788  .01431103  00000-0  14311-1      13",
     "2 11801  46.7916 230.4354 7318036  47.4722  10.4117  2.28537848    13", true, k11801,
     sizeof(k11801) / sizeof(k11801[0])},
    {"14128", "1 14128U 83058A   06176.02844893 -.00000158  00000-0  10000-3 0  9627",
     "2 14128  11.4384  35.2134 0011562  26.4582 333.5652  0.98870114 46093", true, k14128,
     sizeof(k14128) / sizeof(k14128[0])},
    {"28623", "1 28623U 05006B   06177.81079184  .00637644  69054-6  96390-3 0  6000",
     "2 28623  28.5200 114.9834 6249053 170.2550 212.8965  3.79477162 12753", true, k28623,
     sizeof(k28623) / sizeof(k28623[0])},
    {"23333", "1 23333U 94071A   94305.49999999 -.00172956  26967-3  10000-3 0    15",
     "2 23333  28.7490  2.3720 9728298  30.4360  1.3500  0.07309491    70", true, k23333,
     sizeof(k23333) / sizeof(k23333[0])},
};

int run_sgp4_self_test() {
    const double kPosTol = 1e-6, kVelTol = 1e-9;
    bool all_ok = true;

    std::printf("{\n");
    std::printf("  \"status\": \"ok\",\n");
    std::printf("  \"command\": \"verify-tle --self-test\",\n");
    std::printf("  \"reference\": \"Vallado et al., AIAA 2006-6753 Rev 1, Appendix D\",\n");
    std::printf("  \"tolerance_km\": %.0e,\n", kPosTol);
    std::printf("  \"tolerance_kms\": %.0e,\n", kVelTol);
    std::printf("  \"cases\": [\n");

    bool first_case = true;
    for (const VCase& c : kVectors) {
        Tle tle{};
        std::string err;
        if (!parse_tle(c.l1, c.l2, tle, &err)) {
            if (!first_case) std::printf(",\n");
            first_case = false;
            std::printf("    {\"name\": \"%s\", \"error\": \"parse failed: %s\"}", c.name, err.c_str());
            all_ok = false;
            continue;
        }
        Sgp4 s;
        if (!sgp4_init(s, tle)) {
            if (!first_case) std::printf(",\n");
            first_case = false;
            std::printf("    {\"name\": \"%s\", \"error\": \"init failed\"}", c.name);
            all_ok = false;
            continue;
        }

        double max_pos = 0.0, max_vel = 0.0;
        for (std::size_t i = 0; i < c.n; ++i) {
            Vec3 r{}, v{};
            Sgp4Error code = Sgp4Error::kOk;
            if (!sgp4_propagate(s, c.pts[i].t, r, v, &code)) {
                if (!first_case) std::printf(",\n");
                first_case = false;
                std::printf("    {\"name\": \"%s\", \"error\": \"propagate failed: %s\"}", c.name,
                            sgp4_error_string(code));
                all_ok = false;
                continue;
            }
            const double dr = std::sqrt(
                (r.x - c.pts[i].r0) * (r.x - c.pts[i].r0) +
                (r.y - c.pts[i].r1) * (r.y - c.pts[i].r1) +
                (r.z - c.pts[i].r2) * (r.z - c.pts[i].r2));
            const double dv = std::sqrt(
                (v.x - c.pts[i].v0) * (v.x - c.pts[i].v0) +
                (v.y - c.pts[i].v1) * (v.y - c.pts[i].v1) +
                (v.z - c.pts[i].v2) * (v.z - c.pts[i].v2));
            max_pos = std::max(max_pos, dr);
            max_vel = std::max(max_vel, dv);
        }
        const bool passed = max_pos <= kPosTol && max_vel <= kVelTol;
        all_ok = all_ok && passed;
        if (!first_case) std::printf(",\n");
        first_case = false;
        std::printf("    {\"name\": \"%s\", \"regime\": \"%s\", "
                    "\"max_pos_err_km\": %.3e, \"max_vel_err_kms\": %.3e, \"passed\": %s}",
                    c.name, c.deep ? "deep-space (SDP4)" : "near-earth (SGP4)",
                    max_pos, max_vel, passed ? "true" : "false");
    }
    std::printf("\n  ],\n");
    std::printf("  \"all_passed\": %s\n", all_ok ? "true" : "false");
    std::printf("}\n");
    return all_ok ? 0 : 1;
}

int cmd_verify_tle(const std::vector<std::string>& args) {
    bool self_test = false;
    std::string line1, line2;
    std::vector<double> tsince;

    for (std::size_t i = 0; i < args.size(); ++i) {
        const std::string& k = args[i];
        if (k == "--self-test") {
            self_test = true;
        } else if (k == "--line1" && i + 1 < args.size()) {
            line1 = args[++i];
        } else if (k == "--line2" && i + 1 < args.size()) {
            line2 = args[++i];
        } else if (k == "--tsince") {
            if (i + 1 >= args.size()) die("--tsince needs at least one value");
            // Accept either comma-separated ("0,120,240,360") or space-separated
            // ("0 120 240 360") values, or a mix. A single token is split on
            // commas first, then on whitespace, so "--tsince 0,120,240,360"
            // and "--tsince 0 120 240 360" both work.
            std::string val = args[++i];
            std::stringstream ss(val);
            std::string part;
            while (std::getline(ss, part, ',')) {
                std::stringstream inner(part);
                std::string num;
                while (inner >> num) tsince.push_back(std::stod(num));
            }
            // Slurp any further space-separated number tokens as well.
            while (i + 1 < args.size() && is_number(args[i + 1])) {
                tsince.push_back(std::stod(args[++i]));
            }
        } else {
            die("unknown option " + k);
        }
    }

    if (self_test) return run_sgp4_self_test();

    if (line1.empty() || line2.empty()) {
        std::string l;
        if (!std::getline(std::cin, line1) || !std::getline(std::cin, line2) ||
            line1.empty() || line2.empty()) {
            std::fprintf(stderr,
                "starpivot: verify-tle needs --line1/--line2 or two TLE lines on stdin\n");
            return 2;
        }
    }
    if (tsince.empty()) tsince = {0.0, 120.0, 240.0, 360.0};

    Tle tle{};
    std::string err;
    if (!parse_tle(line1, line2, tle, &err)) {
        std::fprintf(stderr, "starpivot: TLE parse failed: %s\n", err.c_str());
        return 2;
    }
    Sgp4 s;
    if (!sgp4_init(s, tle)) {
        std::fprintf(stderr, "starpivot: SGP4 init failed for satnum %d\n", tle.satnum);
        return 2;
    }

    // Deep-space carries resonance-integrator state between calls, so the
    // requests must be issued in ascending tsince. Reorder a copy but keep the
    // user's requested order for output.
    std::vector<std::pair<std::size_t, double>> order;
    for (std::size_t i = 0; i < tsince.size(); ++i) order.emplace_back(i, tsince[i]);
    std::stable_sort(order.begin(), order.end(),
                     [](const auto& a, const auto& b) { return a.second < b.second; });

    std::vector<Vec3> R(tsince.size()), V(tsince.size());
    bool ok = true;
    std::string fail_reason;
    for (const auto& kv : order) {
        Sgp4Error code = Sgp4Error::kOk;
        if (!sgp4_propagate(s, kv.second, R[kv.first], V[kv.first], &code)) {
            ok = false;
            fail_reason = sgp4_error_string(code);
        }
    }

    const double period_min = (s.no_kozai > 0.0) ? (2.0 * kPi / s.no_kozai) : 0.0;
    std::printf("{\n");
    std::printf("  \"status\": \"ok\",\n");
    std::printf("  \"command\": \"verify-tle\",\n");
    std::printf("  \"frame\": \"TEME\",\n");
    std::printf("  \"classification\": \"%s\",\n",
                s.method == 'd' ? "deep-space (SDP4)" : "near-earth (SGP4)");
    std::printf("  \"input\": {\n");
    std::printf("    \"satnum\": %d,\n", tle.satnum);
    std::printf("    \"intl_designator\": \"%s\",\n", tle.intl_designator.c_str());
    std::printf("    \"epoch_utc\": \"%s\",\n", iso_from_jd(tle.epoch_jd).c_str());
    std::printf("    \"bstar\": %.6e,\n", tle.bstar);
    std::printf("    \"eccentricity\": %.10g,\n", tle.ecco);
    std::printf("    \"inclination_deg\": %.6f,\n", tle.inclo / kDeg);
    std::printf("    \"raan_deg\": %.6f,\n", tle.nodeo / kDeg);
    std::printf("    \"argp_deg\": %.6f,\n", tle.argpo / kDeg);
    std::printf("    \"mean_anomaly_deg\": %.6f,\n", tle.mo / kDeg);
    std::printf("    \"mean_motion_rad_min\": %.12g,\n", tle.no_kozai);
    std::printf("    \"period_min\": %.6f,\n", period_min);
    std::printf("    \"isimp\": %s\n", s.isimp ? "true" : "false");
    std::printf("  },\n");
    std::printf("  \"states\": [\n");
    bool first = true;
    for (std::size_t i = 0; i < tsince.size(); ++i) {
        const Vec3& r = R[i];
        const Vec3& v = V[i];
        if (!first) std::printf(",\n");
        first = false;
        std::printf("    {\"tsince_min\": %.6g, \"r_km\": [%.8f, %.8f, %.8f], "
                    "\"v_kms\": [%.10f, %.10f, %.10f], \"r_mag_km\": %.6f, \"v_mag_kms\": %.8f}",
                    tsince[i], r.x, r.y, r.z, v.x, v.y, v.z, r.norm(), v.norm());
    }
    std::printf("\n  ],\n");
    std::printf("  \"note\": \"SGP4/SDP4 propagation verified against Vallado "
                "AIAA 2006-6753 Rev 1 Appendix D vectors to <1e-6 km / 1e-9 km/s. "
                "Output is in the TEME frame; convert to TEME-of-date before comparing "
                "against an inertial catalogue.\"\n");
    if (!ok) {
        std::printf("  \"propagation_failed\": true,\n");
        std::printf("  \"failure_reason\": \"%s\"\n", fail_reason.c_str());
    }
    std::printf("}\n");
    return ok ? 0 : 1;
}

int run_conj_self_test() {
    // Sanity: the same object propagated against itself must be a true
    // zero-miss conjunction. This exercises find_conjunction's search +
    // the epoch-delta path (delta == 0 here) without needing a reference CDM.
    const char* l1 = "1 25544U 98067A   26267.14191496  .00009634  00000+0  18116-3 0  9999";
    const char* l2 = "2 25544  51.6318 170.3464 0004691 174.6338 185.4701 15.49258637587098";
    Tle t{};
    std::string err;
    if (!parse_tle(l1, l2, t, &err)) {
        std::fprintf(stderr, "starpivot: self-test TLE parse failed: %s\n", err.c_str());
        return 1;
    }
    ConjunctionResult res{};
    Sgp4Error e = Sgp4Error::kOk;
    bool ok = find_conjunction(t, t, 0.0, 1440.0, 5.0, res, &e);
    bool passed = ok && res.found && res.miss_distance_km < 1e-3;
    std::printf("{\n");
    std::printf("  \"status\": \"ok\",\n");
    std::printf("  \"command\": \"conj --self-test\",\n");
    std::printf("  \"reference\": \"same-object identity check (must be a true zero-miss conjunction)\",\n");
    std::printf("  \"tolerance_km\": 1e-03,\n");
    std::printf("  \"miss_distance_km\": %.6e,\n", res.miss_distance_km);
    std::printf("  \"all_passed\": %s\n", passed ? "true" : "false");
    std::printf("}\n");
    return passed ? 0 : 1;
}

int cmd_conj(const std::vector<std::string>& args) {
    bool self_test = false;
    std::string a1, a2, b1, b2;
    double window_min = 1440.0;   // 24 h look-ahead, measured from object A's epoch
    double step_min = 1.0;
    double threshold_km = 0.0;
    bool has_threshold = false;
    double track_min = 90.0;      // ground-track half-window around TCA (0 = off)

    for (std::size_t i = 0; i < args.size(); ++i) {
        const std::string& k = args[i];
        if (k == "--self-test") {
            self_test = true;
        } else if (k == "--line1" && i + 1 < args.size()) {
            a1 = args[++i];
        } else if (k == "--line2" && i + 1 < args.size()) {
            a2 = args[++i];
        } else if (k == "--line3" && i + 1 < args.size()) {
            b1 = args[++i];
        } else if (k == "--line4" && i + 1 < args.size()) {
            b2 = args[++i];
        } else if (k == "--window-min" && i + 1 < args.size()) {
            window_min = std::stod(args[++i]);
        } else if (k == "--step-min" && i + 1 < args.size()) {
            step_min = std::stod(args[++i]);
        } else if (k == "--threshold-km" && i + 1 < args.size()) {
            threshold_km = std::stod(args[++i]);
            has_threshold = true;
        } else if (k == "--track-min" && i + 1 < args.size()) {
            track_min = std::stod(args[++i]);
        } else {
            die("unknown option " + k);
        }
    }

    if (self_test) return run_conj_self_test();

    if (a1.empty() || a2.empty() || b1.empty() || b2.empty()) {
        // Read four TLE lines from stdin: A line1, A line2, B line1, B line2.
        std::vector<std::string> lines;
        std::string l;
        while (lines.size() < 4 && std::getline(std::cin, l)) {
            if (!l.empty()) lines.push_back(l);
        }
        if (lines.size() < 4) {
            std::fprintf(stderr,
                "starpivot: conj needs --line1/--line2/--line3/--line4 "
                "or four TLE lines on stdin\n");
            return 2;
        }
        a1 = lines[0]; a2 = lines[1]; b1 = lines[2]; b2 = lines[3];
    }

    Tle tle_a{}, tle_b{};
    std::string err;
    if (!parse_tle(a1, a2, tle_a, &err)) {
        std::fprintf(stderr, "starpivot: TLE A parse failed: %s\n", err.c_str());
        return 2;
    }
    if (!parse_tle(b1, b2, tle_b, &err)) {
        std::fprintf(stderr, "starpivot: TLE B parse failed: %s\n", err.c_str());
        return 2;
    }

    ConjunctionResult res{};
    Sgp4Error code = Sgp4Error::kOk;
    if (!find_conjunction(tle_a, tle_b, 0.0, window_min, step_min, res, &code)) {
        std::fprintf(stderr, "starpivot: conjunction failed: %s\n",
                     sgp4_error_string(code));
        return 2;
    }

    Sgp4 sa, sb;
    sgp4_init(sa, tle_a);
    sgp4_init(sb, tle_b);
    const char* regime_a = (sa.method == 'd') ? "deep-space (SDP4)" : "near-earth (SGP4)";
    const char* regime_b = (sb.method == 'd') ? "deep-space (SDP4)" : "near-earth (SGP4)";

    const bool alert = has_threshold && res.miss_distance_km < threshold_km;

    // ---- Ground tracks around TCA (kernel-computed subpoints; the viewer
    // only draws). Window [tca-track_min, tca+track_min] in object A's epoch
    // frame; object B's samples are shifted by the epoch delta like everywhere
    // else. Degrades gracefully: a track failure never invalidates the
    // conjunction result itself.
    std::vector<GroundSample> track_a, track_b;
    bool have_tracks = false;
    if (track_min > 0.0) {
        const double t0 = res.tca_min - track_min;
        const double t1 = res.tca_min + track_min;
        Sgp4Error terr = Sgp4Error::kOk;
        const double delta_min = (tle_a.epoch_jd - tle_b.epoch_jd) * 1440.0;
        if (ground_track(tle_a, t0, t1, 1.0, track_a, &terr) &&
            ground_track(tle_b, t0 + delta_min, t1 + delta_min, 1.0,
                         track_b, &terr)) {
            have_tracks = true;
        }
    }
    // Sub-satellite points of both objects exactly at TCA.
    const Subpoint sub_a = subpoint_from_teme(
        res.pos_a_km, tle_a.epoch_jd + res.tca_min / 1440.0);
    const Subpoint sub_b = subpoint_from_teme(
        res.pos_b_km, tle_b.epoch_jd + res.tsince_b_min / 1440.0);

    std::printf("{\n");
    std::printf("  \"status\": \"ok\",\n");
    std::printf("  \"command\": \"conj\",\n");
    std::printf("  \"frame\": \"TEME\",\n");
    std::printf("  \"window_min\": %.6g,\n", window_min);
    std::printf("  \"object_a\": {\"satnum\": %d, \"intl_designator\": \"%s\", "
                "\"epoch_utc\": \"%s\", \"regime\": \"%s\"},\n",
                tle_a.satnum, tle_a.intl_designator.c_str(),
                iso_from_jd(tle_a.epoch_jd).c_str(), regime_a);
    std::printf("  \"object_b\": {\"satnum\": %d, \"intl_designator\": \"%s\", "
                "\"epoch_utc\": \"%s\", \"regime\": \"%s\"},\n",
                tle_b.satnum, tle_b.intl_designator.c_str(),
                iso_from_jd(tle_b.epoch_jd).c_str(), regime_b);
    std::printf("  \"result\": {\n");
    std::printf("    \"tca_utc\": \"%s\",\n", iso_from_jd(res.tca_utc_jd).c_str());
    std::printf("    \"tca_min_from_a_epoch\": %.6g,\n", res.tca_min);
    std::printf("    \"tsince_b_min\": %.6g,\n", res.tsince_b_min);
    std::printf("    \"miss_distance_km\": %.6f,\n", res.miss_distance_km);
    std::printf("    \"rel_speed_kms\": %.8f,\n", res.rel_speed_kms);
    if (has_threshold) {
        std::printf("    \"threshold_km\": %.6g,\n", threshold_km);
        std::printf("    \"alert\": %s,\n", alert ? "true" : "false");
    }
    std::printf("    \"pos_a_km\": [%.8f, %.8f, %.8f],\n",
                res.pos_a_km.x, res.pos_a_km.y, res.pos_a_km.z);
    std::printf("    \"vel_a_kms\": [%.10f, %.10f, %.10f],\n",
                res.vel_a_kms.x, res.vel_a_kms.y, res.vel_a_kms.z);
    std::printf("    \"pos_b_km\": [%.8f, %.8f, %.8f],\n",
                res.pos_b_km.x, res.pos_b_km.y, res.pos_b_km.z);
    std::printf("    \"vel_b_kms\": [%.10f, %.10f, %.10f],\n",
                res.vel_b_kms.x, res.vel_b_kms.y, res.vel_b_kms.z);
    std::printf("    \"subpoint_a\": {\"lat_deg\": %.5f, \"lon_deg\": %.5f, \"alt_km\": %.3f},\n",
                sub_a.lat_deg, sub_a.lon_deg, sub_a.alt_km);
    std::printf("    \"subpoint_b\": {\"lat_deg\": %.5f, \"lon_deg\": %.5f, \"alt_km\": %.3f},\n",
                sub_b.lat_deg, sub_b.lon_deg, sub_b.alt_km);
    if (have_tracks) {
        std::printf("    \"ground_track\": {\n");
        std::printf("      \"window_min\": %.6g, \"step_min\": 1,\n", 2.0 * track_min);
        std::printf("      \"frame\": \"t in minutes from object A epoch, subpoints are "
                    "spherical-Earth geocentric\",\n");
        std::printf("      \"a\": [");
        for (std::size_t i = 0; i < track_a.size(); ++i)
            std::printf("%s[%.4f,%.5f,%.5f,%.3f]", i ? "," : "",
                        track_a[i].t_min, track_a[i].lat_deg,
                        track_a[i].lon_deg, track_a[i].alt_km);
        std::printf("],\n");
        std::printf("      \"b\": [");
        for (std::size_t i = 0; i < track_b.size(); ++i)
            std::printf("%s[%.4f,%.5f,%.5f,%.3f]", i ? "," : "",
                        res.tca_min - track_min + static_cast<double>(i),  // anchor frame
                        track_b[i].lat_deg, track_b[i].lon_deg, track_b[i].alt_km);
        std::printf("]\n");
        std::printf("    }\n");
    } else {
        std::printf("    \"ground_track\": null\n");
    }
    std::printf("  },\n");
    std::printf("  \"note\": \"Conjunction screening built on the Vallado-validated SGP4/SDP4 "
                "propagator (position <1e-6 km vs Appendix D). Miss distance is the straight-line "
                "TEME separation at TCA; compare against a combined hard-body + covariance threshold "
                "before raising any alert. No covariance is modelled here. Sub-satellite points and "
                "ground tracks are spherical-Earth geocentric (up to ~21 km latitude bias vs "
                "geodetic) — for map display, not antenna pointing.\"\n");
    std::printf("}\n");
    return 0;
}

// ---------------------------------------------------------------------------
// groundtrack：星下点 / 地面轨迹——SGP4 TEME 位置经 GMST 旋转转为经纬度
// ---------------------------------------------------------------------------

// 所有轨道与坐标计算在本内核完成（SGP4 传播 + GMST 地球自转）；页面只负责画图。
int cmd_groundtrack(const std::vector<std::string>& args) {
    std::string a1, a2, b1, b2;
    double minutes = 180.0;    // window length in minutes
    double offset_min = 0.0;   // window start, minutes from object A's epoch
    double step_min = 1.0;

    for (std::size_t i = 0; i < args.size(); ++i) {
        const std::string& k = args[i];
        if (k == "--line1" && i + 1 < args.size()) {
            a1 = args[++i];
        } else if (k == "--line2" && i + 1 < args.size()) {
            a2 = args[++i];
        } else if (k == "--line3" && i + 1 < args.size()) {
            b1 = args[++i];
        } else if (k == "--line4" && i + 1 < args.size()) {
            b2 = args[++i];
        } else if (k == "--minutes" && i + 1 < args.size()) {
            minutes = std::stod(args[++i]);
        } else if (k == "--offset-min" && i + 1 < args.size()) {
            offset_min = std::stod(args[++i]);
        } else if (k == "--step-min" && i + 1 < args.size()) {
            step_min = std::stod(args[++i]);
        } else {
            die("unknown option " + k);
        }
    }

    if (a1.empty() || a2.empty()) {
        // stdin: 2 lines = one object, 4 lines = two objects.
        std::vector<std::string> lines;
        std::string l;
        while (std::getline(std::cin, l)) {
            if (!l.empty()) lines.push_back(l);
        }
        if (lines.size() >= 4) {
            b1 = lines[2]; b2 = lines[3];
        }
        if (lines.size() >= 2) {
            a1 = lines[0]; a2 = lines[1];
        }
        if (lines.size() < 2) {
            std::fprintf(stderr,
                "starpivot: groundtrack needs --line1/--line2 or TLE lines on stdin\n");
            return 2;
        }
    }

    Tle tle_a{}, tle_b{};
    std::string err;
    if (!parse_tle(a1, a2, tle_a, &err)) {
        std::fprintf(stderr, "starpivot: TLE A parse failed: %s\n", err.c_str());
        return 2;
    }
    const bool two = !b1.empty() && !b2.empty();
    if (two && !parse_tle(b1, b2, tle_b, &err)) {
        std::fprintf(stderr, "starpivot: TLE B parse failed: %s\n", err.c_str());
        return 2;
    }

    // Both tracks cover the SAME UTC window [offset, offset+minutes] measured
    // from object A's epoch; object B's samples are shifted by the epoch delta
    // (the same convention as conj), so the two tracks are directly comparable.
    std::vector<GroundSample> tr_a, tr_b;
    Sgp4Error e = Sgp4Error::kOk;
    if (!ground_track(tle_a, offset_min, offset_min + minutes, step_min, tr_a, &e)) {
        std::fprintf(stderr, "starpivot: groundtrack A failed: %s\n",
                     sgp4_error_string(e));
        return 2;
    }
    const double delta_min =
        two ? (tle_a.epoch_jd - tle_b.epoch_jd) * 1440.0 : 0.0;
    if (two && !ground_track(tle_b, offset_min + delta_min,
                             offset_min + minutes + delta_min, step_min,
                             tr_b, &e)) {
        std::fprintf(stderr, "starpivot: groundtrack B failed: %s\n",
                     sgp4_error_string(e));
        return 2;
    }

    auto print_sat = [&](const Tle& tle, const std::vector<GroundSample>& tr,
                         double tsince_offset, bool last) {
        std::printf("    {\"satnum\": %d, \"epoch_utc\": \"%s\", "
                    "\"tsince_offset_min\": %.6g, \"samples\": [",
                    tle.satnum, iso_from_jd(tle.epoch_jd).c_str(), tsince_offset);
        for (std::size_t i = 0; i < tr.size(); ++i)
            std::printf("%s[%.4f,%.5f,%.5f,%.3f]", i ? "," : "",
                        tr[i].t_min - tsince_offset,  // anchor-frame minutes
                        tr[i].lat_deg, tr[i].lon_deg, tr[i].alt_km);
        std::printf("]}%s\n", last ? "" : ",");
    };

    std::printf("{\n");
    std::printf("  \"status\": \"ok\",\n");
    std::printf("  \"command\": \"groundtrack\",\n");
    std::printf("  \"frame\": \"subpoints: spherical-Earth geocentric lat/lon (east+), "
                "t in minutes from object A epoch\",\n");
    std::printf("  \"anchor\": {\"satnum\": %d, \"offset_min\": %.6g, "
                "\"minutes\": %.6g, \"step_min\": %.6g, \"epoch_delta_min\": %.6g},\n",
                tle_a.satnum, offset_min, minutes, step_min, delta_min);
    std::printf("  \"satellites\": [\n");
    print_sat(tle_a, tr_a, 0.0, !two);
    if (two) print_sat(tle_b, tr_b, delta_min, true);
    std::printf("  ],\n");
    std::printf("  \"note\": \"Spherical-Earth sub-satellite point: up to ~21 km latitude "
                "bias vs geodetic (Earth oblateness ignored) — for map display, not "
                "antenna pointing. Positions from the Vallado-validated SGP4/SDP4.\"\n");
    std::printf("}\n");
    return 0;
}

// ---------------------------------------------------------------------------
// nbody：宇宙模拟——N 体辛积分（AU/M☉/yr，G=4π²）
// ---------------------------------------------------------------------------

// Kepler 根数 → 惯性系状态矢量（黄道坐标系）。μ 由调用方给（G×中心+环绕质量）。
void elem_to_state(double mu, double a, double e,
                   double i_rad, double Om_rad, double w_rad, double M_rad,
                   Vec3& r, Vec3& v) {
    double E = M_rad;  // Newton 迭代解开普勒方程 M = E - e sinE
    for (int it = 0; it < 80; ++it) {
        double f = E - e * std::sin(E) - M_rad;
        double fp = 1.0 - e * std::cos(E);
        double d = f / fp;
        E -= d;
        if (std::fabs(d) < 1e-15) break;
    }
    const double ce = std::cos(E), se = std::sin(E);
    const double sq = std::sqrt(1.0 - e * e);
    const double xp = a * (ce - e);                    // 近焦平面坐标
    const double yp = a * sq * se;
    const double k = std::sqrt(mu * a);
    const double rPeri = a * (1.0 - e * ce);           // r = a(1 - e cosE)
    // 近焦平面速度：vx' = -sqrt(mu a) sinE / r, vy' = sqrt(mu a) sqrt(1-e^2) cosE / r
    // （vy' 的 cosE 因子不可丢——丢了速度模长偏大 ~26%，轨道会整体外扩）
    const double vxp = -k * se / rPeri;
    const double vyp = k * sq * ce / rPeri;

    const double cO = std::cos(Om_rad), sO = std::sin(Om_rad);
    const double ci = std::cos(i_rad), si = std::sin(i_rad);
    const double cw = std::cos(w_rad), sw = std::sin(w_rad);
    r.x = (cO * cw - sO * sw * ci) * xp + (-cO * sw - sO * cw * ci) * yp;
    r.y = (sO * cw + cO * sw * ci) * xp + (-sO * sw + cO * cw * ci) * yp;
    r.z = (sw * si) * xp + (cw * si) * yp;
    v.x = (cO * cw - sO * sw * ci) * vxp + (-cO * sw - sO * cw * ci) * vyp;
    v.y = (sO * cw + cO * sw * ci) * vxp + (-sO * sw + cO * cw * ci) * vyp;
    v.z = (sw * si) * vxp + (cw * si) * vyp;
}

// 用户自定义天体：日心开普勒根数（角度度、a AU、质量 M☉）+ 物理半径（km，用于碰撞）。
struct CustomBodyIC {
    std::string name;
    double a, e, inc, raan, argp, M0, m;
    double radius_km = 1000.0;   // 默认 1000 km（小行星量级），JSON 会回显
    // 下面两个放在末尾，是为了不打乱上面那 9 个位置的聚合初始化
    // （内置行星表那两处用的是 CustomBodyIC{name, a, e, ..., radius_km}，
    //   把新字段插在中间会让 p.m 落到 std::string 上，编译直接报错 —— 踩过）。
    std::string type_key;        // 天体类型键名（空 = 没声明类型）
    bool radius_given = false;   // 显式给了半径就不再用类型推
    // ---- 观测覆盖：把"一颗具体的星"从"某一类星"里分出来 ----
    // 类型表给的是**代表值**。真实个体要用观测量，否则会明显偏：TRAPPIST-1 的
    // M8V 质量 0.0898 M☉ 落在质光关系的外推段，L∝M^3.5 只给 2.2e-4 L☉，
    // 而它实测约 5.5e-4 L☉（差 2.5 倍）。这个偏差不是"显示得不好看"：
    // 辐照度 S = L/r² 直接决定行星是否落在可居带 —— 用错的光度，
    // 页面会把本该宜居的行星如实显示成"冻结"，而这恰恰是它最不该出错的地方。
    // 两项都可单独给。半径若未显式给，由 (T,L) 走斯特藩-玻尔兹曼推。
    bool has_t_eff = false;
    double t_eff_K = 0.0;
    bool has_lum = false;
    double lum_lsun = 0.0;
};

// ---------------------------------------------------------------------------
// 一个天体最终生效的恒星属性：发光、有效温度、光度，以及每一项的来源。
//
// 为什么要有这两个函数：同一套优先级（观测覆盖 > 类型模型 > 质光关系兜底）原本要在
// 半径、发光判定、JSON 回显三处各写一遍 —— 那就是三条迟早会走散的规则。
// 收成一处之后，"页面显示的数"与"算辐照度 S=L/r² 用的数"在构造上就是同一个。
//
// src 取值会被原样回显给页面，页面据此如实标注每个数是"观测给的"还是"模型推的"：
//   "given"                       调用方显式给了（真实个体的观测值）
//   "derived_from_radius_and_t_eff"  观测给了 T 和 R、没给 L —— L 由这两个观测值定出来
//   "type_grid"                   类型表里的代表值（某一类星，不是某一颗星）
//   "mass_luminosity_relation"    没有类型、按质光关系兜底
//   "none"                        这个天体不发光
// ---------------------------------------------------------------------------
struct StellarProps {
    double t_eff_K = 0.0;
    double lum_lsun = 0.0;
    const char* t_eff_src = "none";
    const char* lum_src = "none";
};

StellarProps resolve_stellar(const BodyType* t, double mass_msun,
                             bool has_t_eff, double t_eff_K,
                             bool has_lum, double lum_lsun,
                             double radius_km, bool radius_given) {
    StellarProps s;
    if (has_lum) {
        s.lum_lsun = lum_lsun; s.lum_src = "given";
    } else if (has_t_eff && radius_given) {
        // 观测给了这一颗星的 T 和 R，却没给 L。这时 L **不是**独立观测量，
        // 而是由这两个观测量按斯特藩-玻尔兹曼定出来的：L = (R/Rsun)²(T/Tsun)⁴。
        //
        // 这一支必须排在类型表之前：类型表给的是"这一类星"的代表光度，而
        // (R, T) 是"这一颗星"的观测值 —— 用它去乘类型表的数，等于把观测值扔掉。
        // 真实数据表里恰好只有 (st_mass, st_rad, st_teff) 三样，没有 L，
        // 所以这条分支是"数据 → 内核"这段路能不能走通的关键。
        s.lum_lsun = lum_from_radius_t_eff(radius_km, t_eff_K);
        s.lum_src = "derived_from_radius_and_t_eff";
    } else if (t) {
        s.lum_lsun = body_type_luminosity(*t, mass_msun); s.lum_src = "type_grid";
    } else if (body_emits_light(mass_msun, nullptr)) {
        s.lum_lsun = starpivot::stellar_luminosity(mass_msun);
        s.lum_src = "mass_luminosity_relation";
    }
    if (has_t_eff) {
        s.t_eff_K = t_eff_K; s.t_eff_src = "given";
    } else if (t) {
        s.t_eff_K = body_type_t_eff(*t);
        s.t_eff_src = t->emits_light ? "type_grid" : "none";
    }
    if (!std::isfinite(s.t_eff_K) || s.t_eff_K < 0.0) s.t_eff_K = 0.0;
    if (!std::isfinite(s.lum_lsun) || s.lum_lsun < 0.0) s.lum_lsun = 0.0;
    return s;
}

/// 半径由类型（或观测覆盖）决定时的取值。t 为空返回 0 —— 调用方保留原半径。
///
/// 三种情形：
///   1. 类型走斯特藩-玻尔兹曼，且 T/L 被观测覆盖过 → 用**观测的** T 与 L 重推半径
///      （否则会拿类型表的代表 T/L 去推一颗真实个体的半径：内部自相矛盾。
///       TRAPPIST-1 会被推成 0.048 Rsun，而实测 0.119 Rsun。）
///   2. 其他类型 → 按类型自己的半径模型
///   3. 没有类型 → 0，调用方保留原半径（内置行星半径来自已知表，不能被顶掉）
double stellar_radius_for(const BodyType* t, double mass_msun,
                          bool has_t_eff, double t_eff_K,
                          bool has_lum, double lum_lsun) {
    if (!t) return 0.0;
    if (t->radius_model == RadiusModel::kStefanBoltzmann && (has_t_eff || has_lum)) {
        const double T = has_t_eff ? t_eff_K : t->t_eff_K;
        const double L = has_lum ? lum_lsun : body_type_luminosity(*t, mass_msun);
        return sb_radius_km(T, L);
    }
    return body_type_radius_km(*t, mass_msun);
}

// "--body name,a_AU,e,inc_deg,raan_deg,argp_deg,M0_deg,mass_Msun|类型:质量[,radius_km]"
//
// 第 8 字段两种写法：
//   9.5479e-4        直接给质量 (M☉) —— 老写法，行为不变
//   gas_giant:1      给"类型:质量" —— 半径由内核按类型的半径模型算出来
//                    （黑洞半径要用 G 和 c，这件事只能内核做）
// 如果同时显式给了第 9 字段半径，则显式半径优先，但类型仍然保留
// （它决定"是否发光"和页面显示），JSON 里两个都回显，不隐瞒。
CustomBodyIC parse_custom_body(const std::string& spec) {
    std::vector<std::string> f;
    std::string cur;
    for (char ch : spec) {
        if (ch == ',') { f.push_back(cur); cur.clear(); } else cur.push_back(ch);
    }
    f.push_back(cur);
    if (f.size() < 8)
        die("--body expects name,a_AU,e,inc_deg,raan_deg,argp_deg,M0_deg,"
            "mass_Msun|type:mass[,radius_km][,teff_K=..,lum_lsun=..]");
    CustomBodyIC b;
    b.name = f[0];
    try {
        b.a = std::stod(f[1]); b.e = std::stod(f[2]); b.inc = std::stod(f[3]);
        b.raan = std::stod(f[4]); b.argp = std::stod(f[5]);
        b.M0 = std::stod(f[6]);
    } catch (...) {
        die("--body has a non-numeric field: " + spec);
    }
    // 第 8 字段：可选的 "类型:质量"
    const std::size_t colon = f[7].find(':');
    if (colon != std::string::npos) {
        b.type_key = f[7].substr(0, colon);
        const BodyType* t = find_body_type(b.type_key);
        if (!t)
            die("--body unknown type \"" + b.type_key + "\" (available: "
                + body_type_keys_joined() + ")");
        try {
            b.m = std::stod(f[7].substr(colon + 1));
        } catch (...) {
            die("--body type spec needs a mass, e.g. " + b.type_key + ":3 (got \"" + f[7] + "\")");
        }
        // 质量必须落在该类型的范围内，否则"类型"这个名字就是假的 —— 用户说
        // "加个红矮星"，我们不该悄悄按 10 M☉ 给他一颗蓝巨星。
        if (b.m < t->mass_min || b.m > t->mass_max) {
            char buf[320];
            std::snprintf(buf, sizeof buf,
                          "%s mass must be in [%.6g, %.6g] M☉ (got %.6g). "
                          "Ranges are per-type on purpose: a %.6g M☉ \"%s\" would not be one.",
                          b.type_key.c_str(), t->mass_min, t->mass_max, b.m,
                          b.m, t->name_zh);
            die(buf);
        }
        b.radius_km = body_type_radius_km(*t, b.m);
    } else if (find_body_type(f[7])) {
        // 写的是类型名但忘了跟质量（如 "red_dwarf" 而不是 "red_dwarf:0.2"）。
        // 报"非数字质量"技术上没错，但对用户等于没说清 —— 他一眼看过去会觉得
        // 自己写的类型名是合法的，错在别处。
        die("--body type \"" + f[7] + "\" needs a mass, e.g. "
            + f[7] + ":3 (a mass is required: the same type spans a wide range)");
    } else {
        try {
            b.m = std::stod(f[7]);
        } catch (...) {
            die("--body has a non-numeric mass: " + spec
                + " (use a number in Msun, or type:mass — see: starpivot catalog)");
        }
    }
    // 第 9 个字段要么是半径，要么（写成 key=value 时）已经是可选项的开始。
    // 不做这个区分的话，"... ,mass,teff_K=2566" 会被当成"半径=teff_K=2566"，
    // 报出来的错是"半径不是数字"—— 完全指错了方向。
    std::size_t extra_from = f.size();
    if (f.size() >= 9) {
        if (f[8].find('=') == std::string::npos) {
            try {
                b.radius_km = std::stod(f[8]);
            } catch (...) {
                die("--body has a non-numeric radius: " + spec);
            }
            b.radius_given = true;
            extra_from = 9;
        } else {
            extra_from = 8;
        }
    }
    // 可选项：key=value，顺序无关，可只给一个。
    for (std::size_t k = extra_from; k < f.size(); ++k) {
        const std::size_t eq = f[k].find('=');
        if (eq == std::string::npos)
            die("--body extra field must be key=value (got \"" + f[k]
                + "\"); known keys: teff_K, lum_lsun");
        const std::string key = f[k].substr(0, eq);
        const std::string val = f[k].substr(eq + 1);
        double v = 0.0;
        try {
            v = std::stod(val);
        } catch (...) {
            die("--body " + key + " must be numeric (got \"" + val + "\")");
        }
        if (!(v > 0.0) || !std::isfinite(v))
            die("--body " + key + " must be a positive finite number (got \"" + val + "\")");
        if (key == "teff_K" || key == "t_eff_K" || key == "teff") {
            b.has_t_eff = true;
            b.t_eff_K = v;
        } else if (key == "lum_lsun" || key == "lum" || key == "luminosity_Lsun") {
            b.has_lum = true;
            b.lum_lsun = v;
        } else {
            die("--body unknown extra key \"" + key + "\" (known: teff_K, lum_lsun)");
        }
    }
    // 观测覆盖只对"自己发光"的天体有意义。给一颗岩石行星设亮度，等于把它当成了星；
    // 与其安静忽略（页面就会显示一个不生效的数），不如直接报错。
    if (b.has_t_eff || b.has_lum) {
        const BodyType* ot = b.type_key.empty() ? known_body_type(b.name)
                                                : find_body_type(b.type_key);
        if (!body_emits_light(b.m, ot))
            die("--body teff_K / lum_lsun only apply to a body that emits light — "
                "\"" + b.name + "\" does not (" +
                (ot ? ("type \"" + std::string(ot->key) + "\" does not emit light")
                    : ("mass is below the hydrogen burning limit "
                       + std::to_string(kHydrogenBurningLimit_Msun) + " M☉")) + ")");
    }
    // 没显式给半径、又覆盖了 T/L：半径必须用**观测的** T 与 L 重推。
    // 否则会拿类型表的代表 T/L 推出一颗"真实个体"的半径 —— 一个自相矛盾的中间态
    // （比如 TRAPPIST-1 会被推成 0.048 Rsun，而实测是 0.119）。
    if (!b.radius_given && (b.has_t_eff || b.has_lum)) {
        const BodyType* ot = b.type_key.empty() ? known_body_type(b.name)
                                                : find_body_type(b.type_key);
        const double r = stellar_radius_for(ot, b.m, b.has_t_eff, b.t_eff_K,
                                            b.has_lum, b.lum_lsun);
        if (r > 0.0) b.radius_km = r;
    }
    if (b.name.empty()) die("--body name must be non-empty");
    if (!(b.a > 0.0)) die("--body a_AU must be > 0 (name " + b.name + ")");
    if (!(b.e >= 0.0 && b.e < 1.0)) die("--body e must be in [0,1) (name " + b.name + ")");
    if (b.m < 0.0) die("--body mass must be >= 0 (name " + b.name + ")");
    if (b.radius_km < 0.0) die("--body radius_km must be >= 0 (name " + b.name + ")");
    return b;
}


// ---------------------------------------------------------------------------
// --set：改星体属性（质量 / 半径 / 密度）
//
// 三选二：均匀球只有 {质量, 半径, 密度} 里两个是自由的，第三个由
// ρ = M / (4/3 π R³) 派生。所以这里**不能**三个都指定——指定了就违背
// 定义，输出会自相矛盾。给两个 → 第三个现算；只给密度 → 保留原质量、
// 现算半径（网页端「编辑密度」就是这一个分支）。
// 语法：--set "Earth,density=13.0"   /  --set "Sun,radius_km=50,mass_msun=1"
// ---------------------------------------------------------------------------

struct BodyOverride {
    std::string name;
    bool mass_given = false, radius_given = false, density_given = false;
    double mass = 0.0, radius = 0.0, density = 0.0;
};

BodyOverride parse_body_override(const std::string& spec) {
    std::vector<std::string> f;
    std::string cur;
    for (char ch : spec) {
        if (ch == ',') { f.push_back(cur); cur.clear(); } else cur.push_back(ch);
    }
    f.push_back(cur);
    if (f.size() < 2) die("--set expects Name,mass_msun=..[,radius_km=..|density=..]");
    BodyOverride o;
    o.name = f[0];
    if (o.name.empty()) die("--set name must be non-empty: " + spec);
    for (std::size_t k = 1; k < f.size(); ++k) {
        const std::string& kv = f[k];
        const std::size_t eq = kv.find('=');
        if (eq == std::string::npos || eq == 0 || eq + 1 == kv.size())
            die("--set field must be key=value: " + kv + " (in " + spec + ")");
        const std::string key = kv.substr(0, eq);
        const std::string val = kv.substr(eq + 1);
        double num = 0.0;
        try {
            num = std::stod(val);
        } catch (...) {
            die("--set field '" + key + "' expects a number, got '" + val + "'");
        }
        if (!std::isfinite(num)) die("--set field '" + key + "' must be finite");
        if (key == "mass_msun" || key == "mass") {
            if (o.mass_given) die("--set repeats mass_msun: " + spec);
            o.mass_given = true; o.mass = num;
        } else if (key == "radius_km" || key == "radius") {
            if (o.radius_given) die("--set repeats radius_km: " + spec);
            o.radius_given = true; o.radius = num;
        } else if (key == "density" || key == "rho" || key == "density_g_cm3") {
            if (o.density_given) die("--set repeats density: " + spec);
            o.density_given = true; o.density = num;
        } else {
            die("--set unknown field '" + key + "' (use mass_msun, radius_km, density)");
        }
    }
    const bool any = o.mass_given || o.radius_given || o.density_given;
    if (!any) die("--set needs at least one of mass_msun / radius_km / density: " + spec);
    // 两个都给、第三个就没得算；这里绝不允许"三个都给"——那是自相矛盾的输入。
    const int given = (o.mass_given ? 1 : 0) + (o.radius_given ? 1 : 0) +
                      (o.density_given ? 1 : 0);
    if (given == 3) die("--set may specify at most two of mass_msun / radius_km / "
                        "density: the third is derived by rho = M / (4/3 pi R^3)");
    return o;
}

// 数值参数一律从这里进：内核的定位是"明确拒绝，而不是返回一个看起来对的数"，
// 所以非法输入必须自己把话说清楚，而不是崩给用户看（`--years abc` 曾经因
// std::stod 抛出而 std::terminate → 0xC0000409）。
//
// **这里刻意不用异常**（曾经是 try/catch + 一个显式的 `throw std::invalid_argument`）。
// 理由是编译目标的硬约束，不是风格：`wasm32-wasi` 没有 C++ 异常运行时，
// 只要代码里出现 `throw`，链接就会死在 `undefined symbol: __cxa_throw` 上，
// 而 `-fwasm-exceptions` 在本机让编译器直接内部错误崩溃（详见 PRD §0.5 的实测表）。
// 而 `-fno-exceptions` 是能把 libc++ 内联出来的 `__cxa_*`（分配失败等）一并去掉的标准做法 ——
// 用它就必须先没有 `throw`。语义不变：`strtod` 直接告诉我们"转了几个字符"，
// 没转 / 没吃完 / 不是有限数，三者都走同一条 die()，与原来的 catch 分支完全一致。
static double num_arg(const std::string& flag, const std::string& v) {
    const char* b = v.c_str();
    char* end = nullptr;
    const double x = std::strtod(b, &end);
    if (end == b || static_cast<std::size_t>(end - b) != v.size() || !std::isfinite(x))
        die(flag + " expects a finite number (got \"" + v + "\")");
    return x;
}

// 类型表 JSON（定义在后面，catalog 与 nbody 共用一份）
static void print_body_types_array(const char* key);

// 积分器。参照几个同类项目（orbit-lab 做三套同场对比、orbitme 两套、
// Gravity 做"解析 vs 数值"）之后加的：把这四种摆在一起，能量误差曲线自己会说话。
//
//   leapfrog  二阶辛（kick-drift-kick）。能量误差有界振荡、不漂移 —— 长跨度就用它。
//   hermite   四阶 Hermite。单步更准，但不是辛的，长期会缓慢漂移。
//   euler     一阶半隐式欧拉。辛，但精度最差：能量被持续注入，轨道螺旋外扩。
//   kepler    解析二体：完全不做积分，直接由每个天体自己的根数在时刻 t 求位置。
//             它代表"如果没有互相扰动、只有中心天体的理想轨道"，
//             与数值结果之差就是**扰动本身** —— 这是最直观的一组对比。
enum class Integrator { kLeapfrog, kHermite, kEuler, kKepler };

// 一阶半隐式（辛）欧拉：先更新速度，再用新速度更新位置。
// 写成先位置后速度（显式欧拉）会持续注入能量、轨道直接飞掉；半隐式的能量误差有界。
void step_symplectic_euler(starpivot::System& sys, double dt) {
    std::vector<Vec3> a(sys.bodies.size());
    starpivot::compute_acceleration(sys.bodies, a, sys.G, sys.softening * sys.softening);
    const std::size_t n = sys.bodies.size();
    for (std::size_t i = 0; i < n; ++i) sys.bodies[i].velocity += a[i] * dt;
    for (std::size_t i = 0; i < n; ++i) sys.bodies[i].position += sys.bodies[i].velocity * dt;
    sys.time += dt;
}

int cmd_nbody(const std::vector<std::string>& args) {
    std::string scenario = "solar";
    // 自定义宇宙里要不要摆太阳系。三个档：
    //   full —— 太阳 + 八大行星 + 我加的天体（默认，与 --scenario custom 的旧行为一致）
    //   sun  —— 只放太阳，行星空着，天体自己绕太阳
    //   none —— 一个都不放，只有我加的天体；它们互为彼此的引力源
    // "none" 是合法的：两个有质量的天体在没有中心天体的情况下会绕共同质心转，
    // 那是一个真二体（或真多体）系统，不是"少了太阳的太阳系"。
    std::string solar_mode = "full";
    // --primary NAME：把这些自定义天体的开普勒根数解释为"绕 NAME 这个天体"。
    //
    // 为什么需要它：自定义根数一直是按"绕原点、原点处有一颗 1 M☉ 的星"构造初速的
    // （历史约定，内置行星表也用它）。等用户可以放 0.2 M☉ 的红矮星之后，这个约定就
    // 会给出错的初速 —— 实测：0.05 AU 处的一颗行星在 0.2 M☉ 红矮星旁边会从
    // 0.95 AU 飞到 41.7 AU（速度是按 1 M☉ 算的，差了 sqrt(5)=2.24 倍）。
    //
    // 语义（显式，不含糊）：
    //   * NAME 被放在原点、初速为零（它是这个系统的参考系）。
    //   * 它自己的 a/e/i/Ω/ω/M0 **不再被使用**，JSON 里如实回显 primary_fields_ignored。
    //   * 其余天体的 mu = G·(m_NAME + m_self)，位置/速度即相对状态。
    // 不指定 --primary 时行为与以前逐位相同（绕原点 1 M☉）。
    std::string primary_name;
    // 积分器（默认蛙跳：辛、长期能量有界，和以前逐位一致）
    Integrator integ = Integrator::kLeapfrog;
    std::string integ_arg = "leapfrog";
    double years = -1.0;
    double dt = -1.0;
    // "没给"和"给了一个负数"是两件事：以前全靠 `years < 0` 当哨兵，
    // 于是 --years -5 被当成"没给"，静默按默认 50 年跑（用户以为自己改成功了）。
    bool years_given = false, dt_given = false;
    long samples = 400;
    std::vector<CustomBodyIC> custom;
    std::string collide = "off";
    double radius_scale = 1.0;
    long fragments = 4;
    double dispersion_kms = 1.0;
    double frag_min_speed_kms = 0.5;
    // 碎屑喷流的锥形偏置（模型参数，0 = 各向同性四散，1 = 全沿撞击来向）。
    // 默认 0.6：既能一眼看出"朝一个方向溅出去"，又还留着一点发散。
    double spray = 0.6;
    bool star_collide = false;
    std::vector<BodyOverride> overrides;
    // 生物演化。默认开：用户要的就是"每个星体按自己的位置演化"。
    bool bio_on = true;
    starpivot::BioParams biop;        // albedo / greenhouse / full_ladder，默认值都在 hpp 里
    bool bio_defaults_used = true;    // 用户没碰过旋钮时，回显里要标明"用的是默认"

    for (std::size_t i = 0; i < args.size(); ++i) {
        const std::string& k = args[i];
        if (k == "--set" && i + 1 < args.size()) {
            overrides.push_back(parse_body_override(args[++i]));
        } else if (k == "--scenario" && i + 1 < args.size()) {
            scenario = args[++i];
        } else if (k == "--solar" && i + 1 < args.size()) {
            solar_mode = args[++i];
        } else if (k == "--primary" && i + 1 < args.size()) {
            primary_name = args[++i];
        } else if (k == "--integrator" && i + 1 < args.size()) {
            integ_arg = args[++i];
            if (integ_arg == "leapfrog") integ = Integrator::kLeapfrog;
            else if (integ_arg == "hermite") integ = Integrator::kHermite;
            else if (integ_arg == "euler") integ = Integrator::kEuler;
            else if (integ_arg == "kepler") integ = Integrator::kKepler;
            else die("--integrator must be leapfrog, hermite, euler or kepler (got \""
                     + integ_arg + "\")");
        } else if (k == "--years" && i + 1 < args.size()) {
            years = num_arg(k, args[++i]);
            years_given = true;
        } else if (k == "--dt" && i + 1 < args.size()) {
            dt = num_arg(k, args[++i]);
            dt_given = true;
        } else if (k == "--samples" && i + 1 < args.size()) {
            samples = static_cast<long>(num_arg(k, args[++i]));
        } else if (k == "--body" && i + 1 < args.size()) {
            custom.push_back(parse_custom_body(args[++i]));
        } else if (k == "--collide" && i + 1 < args.size()) {
            collide = args[++i];
        } else if (k == "--radius-scale" && i + 1 < args.size()) {
            radius_scale = num_arg(k, args[++i]);
        } else if (k == "--fragments" && i + 1 < args.size()) {
            fragments = static_cast<long>(num_arg(k, args[++i]));
        } else if (k == "--dispersion-kms" && i + 1 < args.size()) {
            dispersion_kms = num_arg(k, args[++i]);
        } else if (k == "--frag-min-speed-kms" && i + 1 < args.size()) {
            frag_min_speed_kms = num_arg(k, args[++i]);
        } else if (k == "--spray" && i + 1 < args.size()) {
            spray = num_arg(k, args[++i]);
        } else if (k == "--star-collide") {
            star_collide = true;
        } else if (k == "--no-bio") {
            bio_on = false;
        } else if (k == "--albedo" && i + 1 < args.size()) {
            biop.albedo = num_arg(k, args[++i]);
            bio_defaults_used = false;
        } else if (k == "--greenhouse" && i + 1 < args.size()) {
            biop.greenhouse_K = num_arg(k, args[++i]);
            bio_defaults_used = false;
        } else if (k == "--bio-years" && i + 1 < args.size()) {
            biop.full_ladder_years = num_arg(k, args[++i]);
            bio_defaults_used = false;
        } else {
            die("unknown option " + k);
        }
    }
    CollisionMode mode = CollisionMode::kOff;
    if (collide == "merge") mode = CollisionMode::kMerge;
    else if (collide == "fragment") mode = CollisionMode::kFragment;
    else if (collide != "off")
        die("--collide must be off, merge or fragment");
    if (scenario == "figure8" && mode != CollisionMode::kOff)
        die("--collide does not apply to the figure8 scenario");
    if (!(radius_scale > 0.0)) die("--radius-scale must be > 0");
    if (fragments < 2 || fragments > 12) die("--fragments must be in [2, 12]");
    if (!(spray >= 0.0 && spray <= 1.0)) die("--spray must be in [0, 1]");
    if (scenario != "solar" && scenario != "figure8" && scenario != "custom")
        die("--scenario must be solar, figure8 or custom");
    if (solar_mode != "full" && solar_mode != "sun" && solar_mode != "none")
        die("--solar must be full, sun or none (got " + solar_mode + ")");
    if (solar_mode != "full" && scenario != "custom")
        die("--solar only applies to --scenario custom (use --scenario custom "
            "with --solar full|sun|none)");
    if (scenario == "figure8" && !custom.empty())
        die("--body does not apply to the figure8 scenario");
    if (scenario == "custom" && custom.empty())
        die("--scenario custom needs at least one --body");
    // --solar none 时只有自定义天体，一个都没有那就不存在任何引力源，直接拒掉，
    // 免得跑出一堆零质量质点的假画面。
    if (scenario == "custom" && solar_mode == "none" && custom.empty())
        die("--solar none needs at least one --body (nothing else is in the system)");
    if (custom.size() > 16) die("at most 16 --body entries");
    // --primary 必须是自定义天体里的一个（不去指太阳系内置天体：那些的根数本来就是日心的，
    // 让它们"绕某个自定义天体"解释只会把两套约定搅在一起）。名字打错时报出可用的名字。
    int primary_ic = -1;
    if (!primary_name.empty()) {
        if (scenario != "custom")
            die("--primary only applies to --scenario custom (got " + scenario + ")");
        for (std::size_t i = 0; i < custom.size(); ++i)
            if (custom[i].name == primary_name) primary_ic = static_cast<int>(i);
        if (primary_ic < 0) {
            std::string avail;
            for (std::size_t i = 0; i < custom.size(); ++i)
                avail += (i ? ", " : "") + custom[i].name;
            die("--primary \"" + primary_name + "\" is not one of the --body names (have: "
                + (avail.empty() ? "none" : avail) + ")");
        }
        if (custom.size() < 2)
            die("--primary needs at least one other --body to orbit it "
                "(a one-body system is just that body at rest)");
    }
    // 有名字就给真实半径，没名字（自定义天体）退回 1000 km，绝不返回 0 ——
    // 半径 0 会被碰撞当成质点， silently 让该天体永远撞不上。
    auto rkm_of = [](const std::string& n) -> double {
        bool ok = false;
        const double r = known_radius_km(n, &ok);
        return ok ? r : 1000.0;
    };
    if (samples < 2 || samples > 4000) die("--samples must be in [2, 4000]");
    if (!(biop.albedo > 0.0) || !(biop.albedo < 1.0))
        die("--albedo must be in (0, 1) (got " + std::to_string(biop.albedo) + ")");
    if (!(biop.greenhouse_K >= 0.0))
        die("--greenhouse must be >= 0 (got " + std::to_string(biop.greenhouse_K) + ")");
    if (!(biop.full_ladder_years > 0.0))
        die("--bio-years must be > 0 (got " + std::to_string(biop.full_ladder_years) + ")");
    // figure8 的等质量初值是那个已知周期解的一部分：改质量会让"8 字"不再是
    // 8 字。半径仍然可以改（只影响碰撞，而 figure8 不开碰撞）。
    for (const auto& o : overrides) {
        if (scenario == "figure8" && o.mass_given)
            die("--set may not change the mass of a figure8 body "
                "(the equal-mass IC is part of the known periodic solution)");
    }

    System sys;
    sys.G = (scenario == "figure8") ? 1.0 : G_AU_MSUN_YR;
    std::vector<std::string> names;
    // 每个有"初始轨道根数"的天体的元素（内置行星 + 自定义行星，按 sys 顺序）。
    // 网页端"点击星体切换到它自己的轨道平面"要用 inc / Ω，所以这里回显出去——
    // 页面不该自己抄一份根数表，容易和内核走散。
    std::vector<CustomBodyIC> root_ic;

    if (scenario == "solar") {
        // J2000 日心黄道平根数（Standish/JPL 近似值）：a AU, e, i, L(平黄经),
        // ϖ(近日点黄经), Ω(升交点)。ω = ϖ - Ω, M0 = L - ϖ。
        // 视觉化用途足够；不是星历表精度，这一点如实标注。
        struct PlanetIC {
            const char* name; double a, e, inc, L, peri, raan, m;
        };
        static const PlanetIC P[] = {
            {"Mercury", 0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593, 1.660120e-7},
            {"Venus",   0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255, 2.447838e-6},
            {"Earth",   1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0, kEarthMassMsun},
            {"Mars",    1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891, 3.227151e-7},
            {"Jupiter", 5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909, 9.547919e-4},
            {"Saturn",  9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448, 2.858860e-4},
            {"Uranus",  19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503, 4.366244e-5},
            {"Neptune", 30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574, 5.151389e-5},
            {"Pluto",   39.48211675, 0.24882730, 17.14001206, 238.92903833, 224.06891629, 110.30393684, 6.580859e-9},
        };
        sys.bodies.emplace_back("Sun", 1.0, Vec3{0, 0, 0}, Vec3{0, 0, 0});
        names.push_back("Sun");
        for (const auto& p : P) {
            Vec3 r, v;
            const double mu = sys.G * (1.0 + p.m);
            elem_to_state(mu, p.a, p.e, p.inc * kDeg,
                          p.raan * kDeg, (p.peri - p.raan) * kDeg,
                          std::fmod(p.L - p.peri, 360.0) * kDeg, r, v);
            sys.bodies.emplace_back(p.name, p.m, r, v);
            names.push_back(p.name);
            // 末尾两个字段显式写出来（{}, false）：内置行星不带类型键、也不显式给半径。
            // 不写它们虽然语义相同（聚合初始化会把剩余字段值初始化），但 -Wextra 会报
            // -Wmissing-field-initializers —— 留着这类噪音，真正的漏字段警告就淹没了。
            root_ic.push_back(CustomBodyIC{p.name, p.a, p.e, p.inc * kDeg,
                                           p.raan * kDeg, (p.peri - p.raan) * kDeg,
                                           std::fmod(p.L - p.peri, 360.0) * kDeg,
                                           p.m, rkm_of(p.name), {}, false});
        }
        // 用户自定义天体：与行星同一套日心开普勒 IC（μ = G×(1+m)），append 在最后。
        for (const auto& c : custom) {
            Vec3 r, v;
            const double mu = sys.G * (1.0 + c.m);
            elem_to_state(mu, c.a, c.e, c.inc * kDeg, c.raan * kDeg,
                          c.argp * kDeg, c.M0 * kDeg, r, v);
            sys.bodies.emplace_back(c.name, c.m, r, v);
            names.push_back(c.name);
            root_ic.push_back(c);
        }
        if (!years_given) years = 50.0;
        if (!dt_given) {
            dt = 0.001;               // Mercury 周期 0.24 yr → 240 步/圈
            for (const auto& c : custom) {  // 贴近太阳的自定天体自动缩步长（≥200 步/圈）
                const double torb = std::pow(c.a, 1.5);
                dt = std::min(dt, torb / 200.0);
            }
        }
    } else if (scenario == "custom") {
        // 自定义宇宙：用户可以自己决定要不要太阳系这块背景。
        // 天体一律用日心开普勒根数 → 状态矢量。
        const bool with_planets = (solar_mode == "full");
        const bool with_sun     = (solar_mode != "none");
        if (with_sun) {
            sys.bodies.emplace_back("Sun", 1.0, Vec3{0, 0, 0}, Vec3{0, 0, 0});
            names.push_back("Sun");
        }
        if (with_planets) {
            // 内置行星表在 solar 分支里就在上面，这里按同一段逻辑重建。
            // 抽成 lambda 会让 solar 分支读起来绕，重复一遍比引入隐式耦合安全。
            struct PlanetIC { const char* name; double a, e, inc, L, peri, raan, m; };
            static const PlanetIC P[] = {
                {"Mercury", 0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593, 1.660120e-7},
                {"Venus",   0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255, 2.447838e-6},
                {"Earth",   1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0, kEarthMassMsun},
                {"Mars",    1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891, 3.227151e-7},
                {"Jupiter", 5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909, 9.547919e-4},
                {"Saturn",  9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448, 2.858860e-4},
                {"Uranus",  19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503, 4.366244e-5},
                {"Neptune", 30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574, 5.151389e-5},
                {"Pluto",   39.48211675, 0.24882730, 17.14001206, 238.92903833, 224.06891629, 110.30393684, 6.580859e-9},
            };
            for (const auto& p : P) {
                Vec3 r, v;
                const double mu = sys.G * (1.0 + p.m);
                elem_to_state(mu, p.a, p.e, p.inc * kDeg,
                              p.raan * kDeg, (p.peri - p.raan) * kDeg,
                              std::fmod(p.L - p.peri, 360.0) * kDeg, r, v);
                sys.bodies.emplace_back(p.name, p.m, r, v);
                names.push_back(p.name);
                root_ic.push_back(CustomBodyIC{p.name, p.a, p.e, p.inc * kDeg,
                                               p.raan * kDeg, (p.peri - p.raan) * kDeg,
                                               std::fmod(p.L - p.peri, 360.0) * kDeg,
                                               p.m, rkm_of(p.name), {}, false});
            }
        }
        double t_min = 1e30;
        // 参考质量：默认仍是"原点一颗 1 M☉"（老约定，逐位不变）；
        // 给了 --primary 就用那颗天体的真实质量。
        const double central_m = (primary_ic >= 0)
            ? custom[static_cast<std::size_t>(primary_ic)].m : 1.0;
        for (std::size_t ci = 0; ci < custom.size(); ++ci) {
            const auto& c = custom[ci];
            Vec3 r, v;
            if (static_cast<int>(ci) == primary_ic) {
                // 参考系本体：放在原点、初速为零。它自己的 a/e/… 不再被使用
                // （这一点必须回显出去，否则用户会以为设了却没生效）。
                r = Vec3{0, 0, 0};
                v = Vec3{0, 0, 0};
            } else {
                const double mu = sys.G * (central_m + c.m);
                elem_to_state(mu, c.a, c.e, c.inc * kDeg, c.raan * kDeg,
                              c.argp * kDeg, c.M0 * kDeg, r, v);
            }
            sys.bodies.emplace_back(c.name, c.m, r, v);
            names.push_back(c.name);
            root_ic.push_back(c);
            t_min = std::min(t_min, std::pow(c.a, 1.5));
        }
        if (!years_given) years = 50.0;
        if (!dt_given) {
            dt = 0.001;
            // 有没有内置行星都会走自定义天体的最内周期约束；少放行星时 0.001 上限
            // 仍然保留，不然 40 AU 的天体会被步长拖得很慢。
            // 周期 ∝ a^1.5 / sqrt(M_total)：换了一颗更轻的中心天体，周期会变长，
            // 步长也得跟着放宽（不然会白算很多步）。默认 central_m = 1 时逐位不变。
            for (const auto& c : custom)
                dt = std::min(dt, std::pow(c.a, 1.5)
                                   / std::sqrt(std::max(1e-12, central_m + c.m)) / 200.0);
        }
    } else {
        // Chenciner–Montgomery figure-8 三体（G=1, m=1）。
        // 初值与 tests/fixtures.hpp::figure8() 逐字一致（该 fixture 经基线验证，
        // 一个整周期闭合 4.1e-8）：v1 = v2 = -v3/2，周期 T = 6.32591398。
        const double x = 0.97000436, y = -0.24308753;
        const Vec3 v3{-0.93240737, -0.86473146, 0.0};
        const Vec3 v1 = v3 * -0.5;
        sys.bodies.emplace_back("A", 1.0, Vec3{x, y, 0}, v1);
        sys.bodies.emplace_back("B", 1.0, Vec3{-x, -y, 0}, v1);
        sys.bodies.emplace_back("C", 1.0, Vec3{0, 0, 0}, v3);
        names = {"A", "B", "C"};
        if (!years_given) years = 6.32591398;  // 一个整周期：动画无缝循环，闭合可检验
        if (!dt_given) dt = 0.0002;
    }

    // ---- 时间与步长的范围校验（到这里 years / dt 都已经解析成实际值）----
    // 之前这三条一条都没有，实测后果：
    //   --years -5  → 静默按 50 年跑（用户以为自己改成功了）
    //   --dt 0      → 返回 status:"ok" 但 frames 为空，页面收到就读 data.frames[0] 崩掉
    //   --years 1e6 → 不拒绝，直接算下去（按实测斜率约十几分钟），网关 180 s 超时
    if (!(years > 0.0)) die("--years must be > 0 (got " + std::to_string(years) + ")");
    if (!(dt > 0.0)) die("--dt must be > 0 (got " + std::to_string(dt) + ")");
    // 步数上限：这不是物理限制，是"别让一次调用把机器占死"的运行限制。
    // 实测太阳系 dt=0.001 时约 1.2e6 步/秒，5e7 步 ≈ 40 秒，留足余量。
    const double steps = years / dt;
    if (steps > 5.0e7) {
        char buf[256];
        std::snprintf(buf, sizeof buf,
                      "--years/--dt would need %.3g steps (limit 5e7, ~40 s). "
                      "Raise --dt or lower --years (years=%.6g, dt=%.6g).",
                      steps, years, dt);
        die(buf);
    }

    // ---- 输出采样标定 ----
    // 轨迹是"把采样点用直线连起来"画出来的，所以采样间隔直接决定圆会不会被画成多边形。
    // 这里用内核自己的 t=0 状态算一次最短环绕周期（不查表、不复用根数表，纯第一性原理），
    // 回显给页面，让页面能如实告诉玩家"最内圈天体每圈只有几个点"，而不是让人自己猜。
    double min_period_years = 0.0;
    {
        std::size_t ip = 0;
        for (std::size_t i = 1; i < sys.bodies.size(); ++i)
            if (sys.bodies[i].mass > sys.bodies[ip].mass) ip = i;
        double best = 0.0;
        for (std::size_t i = 0; i < sys.bodies.size(); ++i) {
            if (i == ip) continue;
            const double mu = sys.G * (sys.bodies[ip].mass + sys.bodies[i].mass);
            if (!(mu > 0.0)) continue;
            const Vec3 d = sys.bodies[i].position - sys.bodies[ip].position;
            const Vec3 w = sys.bodies[i].velocity - sys.bodies[ip].velocity;
            const double r = std::sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
            const double v2 = w.x * w.x + w.y * w.y + w.z * w.z;
            if (!(r > 0.0)) continue;
            const double inv_a = 2.0 / r - v2 / mu;      // vis-viva：1/a
            if (!(inv_a > 0.0)) continue;                // 双曲/抛物线：没有周期
            const double a = 1.0 / inv_a;
            const double period = 2.0 * kPi * std::sqrt(a * a * a / mu);
            if (best == 0.0 || period < best) best = period;
        }
        min_period_years = best;
    }
    // 每圈 60 点：一个圆用 60 段直线连出来，肉眼已经看不出来是多边形。
    // 注意内核输出的是 samples+1 帧（t=0 也算一帧），相邻帧间隔 = years/samples，
    // 所以"每圈点数" = min_period * samples / years —— 分母是 samples，不是 samples-1。
    constexpr double kPointsPerOrbit = 60.0;
    // "够用"的门槛：一个圆用 24 段直线连出来已经看不出棱角。这是显示质量的判据，
    // 不是物理量 —— 但它也不该让页面自己拍，所以一并回显出去。
    // 60 是"理想值"，24 是"够用值"，两者分开，页面才能只在真的不够用时才提示。
    constexpr double kPointsPerOrbitOk = 24.0;
    double suggested_samples_raw = 0.0;
    if (min_period_years > 0.0)
        suggested_samples_raw = years / min_period_years * kPointsPerOrbit;
    const bool samples_capped = suggested_samples_raw > 4000.0;
    long suggested_samples = static_cast<long>(suggested_samples_raw + 0.999);
    if (suggested_samples < 2) suggested_samples = 2;
    if (suggested_samples > 4000) suggested_samples = 4000;
    // 在 4000 的上限内，能撑多少年还保持每圈 60 点 —— 就是给"缩短年数"那条建议用的数。
    const double suggested_years =
        (min_period_years > 0.0) ? 4000.0 * min_period_years / kPointsPerOrbit : 0.0;
    // 本次实际拿到的最内圈点数（页面直接显示这个，不自己算）。
    const double points_per_orbit_min =
        (min_period_years > 0.0 && samples > 0)
            ? min_period_years * static_cast<double>(samples) / years : 0.0;

    // ---- 天体登记表 ----
    // 碰撞会改变天体数量，但帧序列必须保持稳定的索引，否则网页端轨迹会串线。
    // 登记表保存"逻辑天体"：死了的冻结在消亡位置，还没出生的跟随母体位置。
    struct Reg {
        std::string name;
        std::string type_key;   // 声明的天体类型（空 = 没声明，按质量兜底判断发光）
        double mass = 0.0;
        double radius_km = 0.0;
        bool radius_explicit = false;   // 用户显式给过半径（--body 第 9 字段）
        // 观测覆盖（真实个体）：给了就用它，而不是类型表的代表值。
        bool has_t_eff = false;
        double t_eff_K = 0.0;
        bool has_lum = false;
        double lum_lsun = 0.0;
        double born = 0.0;      // 出生时刻（碎块）
        double died = -1.0;     // 消亡时刻（-1 = 存活）
        int merged_into = -1;   // 被谁吞并（登记索引）
        int parent = -1;        // 母体（碎块）
        bool has_ic = false;
    };
    std::vector<Reg> reg;
    std::vector<std::size_t> sys_owner;   // sys 索引 -> 登记索引
    std::vector<Vec3> reg_pos;            // 最近已知位置
    constexpr double kKmPerAu = 1.495978707e8;
    for (std::size_t i = 0; i < sys.size(); ++i) {
        bool ok = false;
        const double rkm = known_radius_km(names[i], &ok);
        Reg r;
        r.name = names[i];
        r.mass = sys.bodies[i].mass;
        r.radius_km = ok ? rkm : 1000.0;
        reg.push_back(r);
        sys_owner.push_back(i);
        reg_pos.push_back(sys.bodies[i].position);
    }
    // root_ic 按 sys.bodies 的顺序记录了"有初始根数"的那些天体（8 大行星 +
    // 自定义行星），而 reg 与 sys.bodies 一一对应，所以这里按名字对齐即可，
    // 不必再维护第二个游标。自定义天体的半径取 --body 第 9 字段（默认 1000 km）。
    std::vector<int> ic_of_reg(reg.size(), -1);   // reg 索引 -> root_ic 索引
    std::size_t ic_cursor = 0;
    for (std::size_t i = 0; i < reg.size() && ic_cursor < root_ic.size(); ++i) {
        if (root_ic[ic_cursor].name != reg[i].name) continue;
        reg[i].radius_km = root_ic[ic_cursor].radius_km;
        reg[i].type_key = root_ic[ic_cursor].type_key;
        reg[i].radius_explicit = root_ic[ic_cursor].radius_given;
        reg[i].has_t_eff = root_ic[ic_cursor].has_t_eff;
        reg[i].t_eff_K = root_ic[ic_cursor].t_eff_K;
        reg[i].has_lum = root_ic[ic_cursor].has_lum;
        reg[i].lum_lsun = root_ic[ic_cursor].lum_lsun;
        reg[i].has_ic = true;
        ic_of_reg[i] = static_cast<int>(ic_cursor);
        ++ic_cursor;
    }

    // ---- 演化状态：每颗"逻辑天体"一份 ----
    // 死了的不再推进（推进只在下面遍历 sys 里的活体时发生），所以它的状态自然
    // 冻结在消亡那一刻，页面照旧读得到 —— 不必为"死人该不该有演化"特设分支。
    std::vector<starpivot::BioState> bio(reg.size());
    // 逐帧的演化轨迹，第 f 帧取各数组的第 f 个元素。颗数 × 帧数 × 6 个数组，
    // 所以每个数都按 4 位有效数字写，够看也不至于把 payload 撑成两倍。
    // 碎块出生晚于第 0 帧，它的数组自然比其他天体短，输出前补齐。
    std::vector<std::vector<int>> stage_of(reg.size());
    std::vector<std::vector<int>> verdict_of(reg.size());
    std::vector<std::vector<double>> prog_of(reg.size());
    std::vector<std::vector<double>> ins_of(reg.size());
    std::vector<std::vector<double>> teq_of(reg.size());
    std::vector<std::vector<double>> tsurf_of(reg.size());
    // 变星的逐帧光度。只在真的出现变星时才记录与输出 —— 稳定的恒星没必要把这个数组撑大。
    std::vector<std::vector<double>> lum_series(reg.size());
    // 逐帧的相对能量误差（一个标量/帧，很便宜）。页面用它画积分器对比曲线。
    std::vector<double> frames_energy;
    // 判定码：0 = 无光照，1 = 冻结，2 = 演化中，3 = 灭菌。
    // 逐帧给，因为偏心轨道上的一颗星完全可能一会儿进窗口一会儿出去。
    auto verdict_code = [](const starpivot::BioState& s) -> int {
        if (!(s.insolation > 0.0)) return 0;
        if (s.t_surf_K >= starpivot::kSterilization_K) return 3;
        return (s.t_surf_K > starpivot::kFreezing_K) ? 2 : 1;
    };

    // ---- 应用 --set 属性覆盖 ----
    // 顺序：先落质量与半径（可能只落其中一个），再由密度补出缺的那个。
    // 只给 density 时保留原质量——这就是网页端"编辑密度"的分支。
    auto apply_override = [&](const BodyOverride& o) {
        int idx = -1;
        for (std::size_t i = 0; i < reg.size(); ++i)
            if (reg[i].name == o.name) { idx = static_cast<int>(i); break; }
        if (idx < 0) {
            std::string avail;
            for (std::size_t i = 0; i < reg.size(); ++i) {
                if (i) avail += ", ";
                avail += reg[i].name;
            }
            die("--set 找不到天体 '" + o.name + "'（本次场景可用：" + avail + "）");
        }
        Reg& r = reg[static_cast<std::size_t>(idx)];
        if (o.mass_given) {
            if (!(o.mass >= 0.0))
                die("--set mass_msun must be >= 0 (name " + o.name + ")");
            r.mass = o.mass;
        }
        if (o.radius_given) {
            if (!(o.radius >= 0.0))
                die("--set radius_km must be >= 0 (name " + o.name + ")");
            r.radius_km = o.radius;
        }
        if (o.density_given) {
            if (!(o.density > 0.0))
                die("--set density must be > 0 (name " + o.name + ")");
            // 密度是从"没被改的那两个"反解第三个：给了密度就至少得有质量或半径。
            if (o.mass_given && o.radius_given) {
                // 两个都给了，密度只是回显——但用户也可能想用密度校验，
                // 这里不算错，只在下面回显时体现。
            } else if (o.mass_given) {
                r.radius_km = radius_km_from_mass_density(r.mass, o.density);
            } else if (o.radius_given) {
                r.mass = mass_msun_from_radius_density(r.radius_km, o.density);
            } else {
                // 只给密度：保留原质量，现算半径。
                r.radius_km = radius_km_from_mass_density(r.mass, o.density);
                if (!(r.radius_km > 0.0))
                    die("--set density cannot be applied: the remaining mass is 0 "
                        "(name " + o.name + ")");
            }
        }
        if (!(r.mass >= 0.0) || !std::isfinite(r.mass))
            die("--set produced an invalid mass (name " + o.name + ")");
        if (!std::isfinite(r.radius_km) || r.radius_km < 0.0)
            die("--set produced an invalid radius (name " + o.name + ")");
    };
    for (const auto& o : overrides) apply_override(o);
    // 声明了类型、又没显式给过半径的天体：--set 改了质量之后，半径要按类型重算。
    // 否则 "black_hole:10" 被 --set 改成 20 M☉ 之后，半径还停在 10 M☉ 的 29.5 km 上 ——
    // 而史瓦西半径与质量成正比，这个坏值会直接进碰撞判定。
    // 顺带把每个天体的 (T_eff, L) 一次算好（resolve_stellar 是唯一入口）：
    // 必须放在 --set 之后，因为改质量会同时改类型推出的半径与光度。
    std::vector<StellarProps> sprops(reg.size());
    for (std::size_t i = 0; i < reg.size(); ++i) {
        const BodyType* t = reg[i].type_key.empty() ? known_body_type(reg[i].name)
                                                    : find_body_type(reg[i].type_key);
        sprops[i] = resolve_stellar(t, reg[i].mass,
                                    reg[i].has_t_eff, reg[i].t_eff_K,
                                    reg[i].has_lum, reg[i].lum_lsun,
                                    reg[i].radius_km, reg[i].radius_explicit);
        // 只有"声明了类型、又没显式给半径"的天体才让类型（或观测覆盖）决定半径。
        // 内置行星的半径来自已知半径表 / 初始根数，不能被类型表的代表值顶掉 ——
        // 这是本条循环一开始就有的约束，加观测覆盖时不能把它放宽。
        if (!reg[i].type_key.empty() && !reg[i].radius_explicit) {
            const double r = stellar_radius_for(t, reg[i].mass,
                                                reg[i].has_t_eff, reg[i].t_eff_K,
                                                reg[i].has_lum, reg[i].lum_lsun);
            if (r > 0.0) reg[i].radius_km = r;
        }
    }
    // 质量改了就把新质量写回 System——动力学用真实质量算力，不是用内置值。
    for (std::size_t i = 0; i < sys.size(); ++i)
        sys.bodies[i].mass = reg[i].mass;

    // ---- 与 reg 一一对应的那些数组，必须先于碰撞处理声明 ----
    // reg 是"登记表"：天体一旦被登记就永远占一行（死了只置 died，不删行），
    // 碎裂时再 push_back 若干行。所以任何按 reg 定容的数组都必须在 reg 增长时同步补长，
    // 而补长这件事只有碰撞处理那段代码知道什么时候发生 —— 因此它们的声明必须排在
    // handle_collisions 之前，否则那个 lambda 根本看不见它们。
    //
    // 这几个数组曾经声明在碰撞处理之后，于是 `--collide fragment` 一发生真实撞击就崩：
    // 碎裂把 reg 撑大了，sprops / lum_of / var_phase / type_of / lum_series 还停在
    // 撞击前的长度上，后面按 reg 索引的循环直接读到 vector 边界之外
    // （Windows 上是 0xC0000005，退出码 3221225477，而且 stderr 一个字都没有）。
    // 注意 merge 模式不会让 reg 变长，所以这个洞只在 fragment 下露出来 ——
    // 也就是说「行星撞地球」这个预设一按就崩，而「撞上就合并」那条路一直好好的。
    std::vector<double> lum_of(reg.size(), 0.0);
    // 光变（变星）。相位按登记下标错开，免得两颗变星同步脉动（那是巧合，不是物理）。
    std::vector<double> var_phase(reg.size(), 0.0);
    std::vector<const BodyType*> type_of(reg.size(), nullptr);

    CollisionSetup csetup;
    csetup.mode = mode;
    csetup.fragments = static_cast<int>(fragments);
    csetup.dispersion = dispersion_kms / 4.740570;   // km/s -> AU/yr
    csetup.fragment_min_speed = frag_min_speed_kms / 4.740570;
    csetup.spray = spray;
    csetup.stars_collide = star_collide;
    std::vector<double> radii;
    std::vector<double> birth(sys.size(), 0.0);   // 与 sys.bodies 对齐的出生时刻
    auto refresh_radii = [&]() {
        radii.assign(sys.size(), 0.0);
        for (std::size_t i = 0; i < sys.size(); ++i)
            radii[i] = reg[sys_owner[i]].radius_km * radius_scale / kKmPerAu;
        csetup.birth = birth;   // 出生时刻表与 sys.bodies 同步
    };
    refresh_radii();
    csetup.birth = birth;
    std::vector<CollisionEvent> events;
    std::uint64_t seed_counter = 987654321;

    // 处理一个积分步内发生的碰撞（每步最多 8 次，防止极端参数下死循环）
    //
    // 登记表（reg）只增不减：母体死了只标 died，不删行。所以它是"输出规模"的那把尺子，
    // 而 max_bodies 量的是"活体数"。碎片级联时两者会差两个数量级（实测 64 活体 /
    // 14735 行），因此这里给登记行数一个自己的硬上限：到顶就退化成纯合并，
    // 与 max_bodies 到顶时的处理方式一致 —— 级联会自己停下来，而不是被拒绝。
    // 取 4×max_bodies：留足"一母体碎成 12 块"这种正常情形的余量，
    // 同时把最坏情况压在 64 活体 / 256 行以内（帧数据 ≈ 256 行，页面画得动）。
    const std::size_t kMaxRegistryRows = 4 * static_cast<std::size_t>(csetup.max_bodies);
    auto handle_collisions = [&]() {
        for (int guard = 0; guard < 8; ++guard) {
            std::size_t i = 0, j = 0;
            double dist = 0.0;
            csetup.radii = radii;
            if (!find_collision(sys, csetup, i, j, dist)) return;
            const std::size_t ri = sys_owner[i], rj = sys_owner[j];

            // 撞击来向：**必须在合并之前取**。merge_bodies 会把 j 从 sys.bodies 里删掉，
            // 那之后"谁从哪个方向撞过来"就永远丢了 —— 而碎屑喷流的方向正是它。
            // 取 v_j - v_i（撞击体相对母体的速度），与 fragment_body 里锥轴的定义一致。
            const Vec3 approach = sys.bodies[j].velocity - sys.bodies[i].velocity;

            CollisionEvent ev0{};
            if (!merge_bodies(sys, i, j, &ev0)) return;
            reg[ri].mass = sys.bodies[i].mass;
            reg[ri].radius_km = merged_radius(reg[ri].radius_km, reg[rj].radius_km);
            reg[rj].died = sys.time;
            reg[rj].merged_into = static_cast<int>(ri);
            reg_pos[rj] = sys.bodies[i].position;   // 冻结在合并点
            sys_owner.erase(sys_owner.begin() + static_cast<long>(j));
            birth.erase(birth.begin() + static_cast<long>(j));
            refresh_radii();
            events.push_back(ev0);

            if (mode != CollisionMode::kFragment) continue;

            // 低速撞击只吸积（重聚），高速撞击才碎裂——这是增生/碎裂两个机制的
            // 经典分界。没有这个阈值，碎屑每次重撞都会再碎一次，变成无限碎屑喷泉。
            if (ev0.relative_speed < csetup.fragment_min_speed) continue;

            // 撞击 → 吸积 → 碎裂成 N 块碎屑（参数化模型，不是撞击物理）。
            // 上限必须卡两样东西，缺一不可：
            //   sys.size() —— 活着的天体数，决定 O(N²) 每步的成本；
            //   reg.size() —— 登记行数，决定**输出**规模（帧里每行一个坐标）。
            // 原来只卡了前者。于是 fmin=0（hpp 里写明的合法取值："每次接触都碎裂"）
            // 时活体被卡在 64，登记行却能涨到 14735 行：3001 帧 × 14735 行 ≈
            // 4400 万个坐标、跑 165 秒、页面根本画不出来。
            // 活着的不多 ≠ 输出不大 —— 这是两件事，得各卡各的。
            const int n = csetup.fragments;
            if (static_cast<int>(sys.size()) + n - 1 > csetup.max_bodies) continue;
            if (reg.size() + static_cast<std::size_t>(n) > kMaxRegistryRows) continue;

            const double spread = reg[ri].radius_km * radius_scale / kKmPerAu;
            CollisionEvent ev1{};
            if (!fragment_body(sys, i, n, csetup.dispersion, spread,
                               seed_counter++, &ev1, &approach, csetup.spray)) continue;
            // 免疫期 = 碎屑环半径 / 色散速度：让碎块先飞散开，否则一出生就
            // 互相重叠 → 立即重聚 → 再碎裂，形成无限级联。
            // 用的是 ev1.ring_radius （碎裂真正使用的那圈），不是这里传进去的那个数：
            // fragment_body 会为了保证"相邻碎块不重叠"把环撑大，环半径若按原值算，
            // 免疫期就会偏小 —— 免疫期算错的后果正是它要防的那件事。
            if (csetup.dispersion > 0.0)
                csetup.immunity = ev1.ring_radius / csetup.dispersion;
            const std::size_t first_new = sys.size() - static_cast<std::size_t>(n);
            reg[ri].died = sys.time;   // 母体被自身碎块取代
            const double piece_r = reg[ri].radius_km / std::cbrt(static_cast<double>(n));
            sys_owner.erase(sys_owner.begin() + static_cast<long>(i));
            birth.erase(birth.begin() + static_cast<long>(i));
            for (int k = 0; k < n; ++k) {
                const std::size_t sk = first_new + static_cast<std::size_t>(k);
                Reg r;
                r.name = sys.bodies[sk].id;
                r.mass = sys.bodies[sk].mass;
                r.radius_km = piece_r;
                r.born = sys.time;
                r.parent = static_cast<int>(ri);
                reg.push_back(r);
                sys_owner.push_back(reg.size() - 1);
                reg_pos.push_back(sys.bodies[sk].position);
                birth.push_back(sys.time);
                // 碎块从零开始演化，出生时刻即"死寂岩石"的到达时刻。
                bio.push_back(starpivot::BioState{});
                bio.back().t_stage = r.born;
                stage_of.push_back({});
                verdict_of.push_back({});
                prog_of.push_back({});
                ins_of.push_back({});
                teq_of.push_back({});
                tsurf_of.push_back({});
                // 剩下的这几个也是按 reg 定容，碎块把 reg 撑大了就必须跟着长。
                // 它们是"死寂岩石"的如实回答，不是占位符：不发光（L=0）、没有类型、
                // 没有有效温度（StellarProps 的缺省值恰好就是这三个"没有"，
                // 所以 JSON 里会回显 luminosity_src="none"、t_eff_src="none"）。
                // 漏掉任何一行，下面按 reg 索引的循环就越界 —— 这个洞修过一次，见上面
                // 那五个数组声明处的注释。
                sprops.push_back(StellarProps{});
                lum_of.push_back(0.0);
                var_phase.push_back(0.0);
                type_of.push_back(nullptr);
                lum_series.push_back({});
            }
            refresh_radii();
            events.push_back(ev1);
        }
    };

    // 帧位置：未出生的碎块跟随母体（沿 parent 链上溯），死亡的天体冻结在原位。
    auto frame_pos = [&](std::size_t r) -> Vec3 {
        for (int guard = 0; guard < 8 && reg[r].born > sys.time + 1e-12 &&
                                         reg[r].parent >= 0; ++guard) {
            r = static_cast<std::size_t>(reg[r].parent);
        }
        return reg_pos[r];
    };

    // ---- 演化：谁是光源 ----
    // 取质量最大者当光源，同质量取索引最小者（确定性）。等质量系统里"该由谁
    // 照亮谁"物理上没有定义，所以回显 primary_tie，让页面能说实话而不是假装。
    // 质量可能在 --set 里被改过，所以这一步放在覆盖全部应用完之后。
    // 第一版这里写错了：primary_reg 只在"索引 0 恰好命中最大值"时才被赋值，
    // 于是给太阳配一颗 2 M☉ 伴星时，光源会被错报成太阳、L 也按太阳算。
    // 现在按"第一次命中最大值"取下标，与"取索引最小者"的约定一致。
    // 第一版：只取质量最大者当唯一光源。既然现在天体可以声明类型（黑洞 / 红矮星 /
    // 褐矮星…），"谁在发光"就不再等于"谁最重" —— 一颗 10 M☉ 的黑洞比太阳重 10 倍，
    // 但它一个光子都不发。所以改成：**所有发光天体的辐照度求和**。
    // 这同时修掉了原来的 primary_tied 死角：双星 / 三体不再是"光源没有定义"，
    // 而是"两个灯一起照"，物理上本来就有定义。
    std::vector<int> light_regs;
    bool any_variable = false;
    for (std::size_t i = 0; i < reg.size(); ++i) {
        const BodyType* t = reg[i].type_key.empty() ? known_body_type(reg[i].name)
                                                    : find_body_type(reg[i].type_key);
        type_of[i] = t;
        if (!body_emits_light(reg[i].mass, t)) continue;
        // 光度走 sprops：观测覆盖 > 类型模型 > 质光关系兜底。这里的 L 就是后面
        // 辐照度 S = L/r² 与可居带判据用的那个 L，与 JSON 回显的是同一个数。
        const double L = sprops[i].lum_lsun;
        if (!(L > 0.0)) continue;
        lum_of[i] = L;
        if (t && t->var.on) { any_variable = true; var_phase[i] = 0.7 * static_cast<double>(i); }
        light_regs.push_back(static_cast<int>(i));
    }
    const int light_count = static_cast<int>(light_regs.size());
    const bool has_light = light_count > 0;
    // primary 仍然回显，但语义变成"最亮的那一个"（不再是"最重的"）。
    // 页面拿它来做"这颗星主要被谁照着"的说明。
    std::size_t primary_reg = 0;
    {
        double best = -1.0;
        for (int i : light_regs)
            if (lum_of[i] > best) { best = lum_of[i]; primary_reg = static_cast<std::size_t>(i); }
    }
    const double primary_L = has_light ? lum_of[primary_reg] : 0.0;
    const double total_L = [&]{ double s = 0.0; for (double v : lum_of) s += v; return s; }();

    // ---- 初值合理性：不许有两个有质量的天体在同一位置 ----
    // 引力是 1/r²，r=0 处没有定义。最容易撞上这一条的方式是
    // 「--primary 把某颗星放在原点」+「--solar full/sun 也把太阳放在原点」——
    // 两个天体同点、质量都非零，第一步就会算出 inf → NaN，
    // 然后整个 JSON 里全是 -nan(ind)（连 JSON 都不合法了，页面直接解析失败）。
    // 宁可在这里明确拒绝并说清怎么改，也不要输出一帧 NaN。
    for (std::size_t i = 0; i < sys.size(); ++i) {
        for (std::size_t j = i + 1; j < sys.size(); ++j) {
            if (!(sys.bodies[i].mass > 0.0) || !(sys.bodies[j].mass > 0.0)) continue;
            const Vec3 d = sys.bodies[i].position - sys.bodies[j].position;
            if (d.norm() == 0.0) {
                die("bodies \"" + names[i] + "\" and \"" + names[j] +
                    "\" start at the same point with non-zero mass: gravity is 1/r^2 and is "
                    "undefined there (the first step would produce NaN). "
                    "A common cause: --primary puts one body at the origin while "
                    "--solar full/sun already puts the Sun there -- use --solar none, "
                    "or drop --primary.");
            }
        }
    }

    // 解析模式没有"积分"可言：天体一律按自己的根数摆位，太阳这类没有根数的留在原点。
    // 所以不能做质心平移（那会把太阳从原点挪走，与根数的参考系不一致）。
    if (integ != Integrator::kKepler) {
        to_barycentric(sys);
    } else if (scenario == "figure8") {
        die("--integrator kepler needs Keplerian elements, but figure8 has none "
            "(its initial conditions are a known periodic solution, not elements)");
    }
    const double e0 = total_energy(sys);
    const Vec3 p0 = total_momentum(sys);

    Leapfrog2 lf(sys);
    starpivot::Hermite4 hm(sys);
    // 解析模式用的中心质量：必须与建 IC 时用的那个完全相同，
    // 否则"解析轨道"与初值不是同一条椭圆，比较就没有意义。
    const double kepler_central_m = (primary_ic >= 0)
        ? custom[static_cast<std::size_t>(primary_ic)].m : 1.0;
    auto integ_step = [&](double h) {
        switch (integ) {
            case Integrator::kHermite: hm.step(h); break;
            case Integrator::kEuler:   step_symplectic_euler(sys, h); break;
            case Integrator::kKepler: {
                sys.time += h;
                for (std::size_t i = 0; i < sys.size(); ++i) {
                    const int ic = ic_of_reg[i];
                    if (ic < 0) continue;          // 没有根数（太阳）→ 留在原点
                    const CustomBodyIC& c = root_ic[static_cast<std::size_t>(ic)];
                    const double mu = sys.G * (kepler_central_m + c.m);
                    const double n = std::sqrt(mu / (c.a * c.a * c.a));   // 平运动 rad/yr
                    Vec3 r, v;
                    elem_to_state(mu, c.a, c.e, c.inc, c.raan, c.argp,
                                  c.M0 + n * sys.time, r, v);
                    sys.bodies[i].position = r;
                    sys.bodies[i].velocity = v;
                }
                break;
            }
            case Integrator::kLeapfrog:
            default: lf.step(h); break;
        }
    };
    const char* integ_key = integ == Integrator::kHermite ? "hermite"
                          : (integ == Integrator::kEuler ? "euler"
                          : (integ == Integrator::kKepler ? "kepler" : "leapfrog"));
    const long total_steps = static_cast<long>(std::ceil(years / dt));
    const long every = std::max<long>(1, total_steps / (samples - 1));

    std::printf("{\n");
    std::printf("  \"status\": \"ok\",\n");
    std::printf("  \"command\": \"nbody\",\n");
    std::printf("  \"scenario\": \"%s\",\n", scenario.c_str());
    // 回显实际生效的太阳系档位：网页端要靠它判断 trace 里哪些是"我加的天体"。
    std::printf("  \"solar\": \"%s\",\n", solar_mode.c_str());
    // 根数的参考系。没有 --primary 时是历史约定：绕原点、原点处假定一颗 1 M☉ 的星。
    // 这个约定必须写在 JSON 里 —— 它是"自定义根数"这句话的全部含义，
    // 而一旦用户放的是 0.2 M☉ 的红矮星，这个约定就会给出错的初速。
    if (primary_ic >= 0) {
        std::printf("  \"primary_frame\": \"%s\",\n", primary_name.c_str());
        std::printf("  \"primary_frame_mass_msun\": %.10g,\n",
                    custom[static_cast<std::size_t>(primary_ic)].m);
        std::printf("  \"primary_fields_ignored\": true,\n");
        std::printf("  \"primary_frame_note\": \"its own a/e/i/raan/argp/M0 are not used: "
                    "it is placed at the origin at rest, and every other body's elements "
                    "are interpreted as orbits around it (mu = G*(m_primary + m_body))\",\n");
    } else {
        std::printf("  \"primary_frame\": \"\",\n");
        std::printf("  \"primary_fields_ignored\": false,\n");
        std::printf("  \"elements_reference\": \"heliocentric convention: the origin is "
                    "assumed to hold 1 Msun (same convention as the built-in planet table)\",\n");
    }
    std::printf("  \"units\": \"AU / Msun / yr (figure8: G=1, m=1), ecliptic J2000 frame\",\n");
    // 回显实际用的积分器，并把它的长期能量行为写清楚 —— 页面要照抄这句话，
    // 不该自己组织语言（否则四种算法会被描述成四种不同的口径）。
    std::printf("  \"integrator\": \"%s\",\n",
        integ == Integrator::kHermite ? "hermite4 (4th order, NOT symplectic)"
      : integ == Integrator::kEuler ? "semi-implicit euler (1st order, symplectic)"
      : integ == Integrator::kKepler ? "analytic two-body (no integration at all)"
                                     : "leapfrog2 (symplectic, kick-drift-kick)");
    std::printf("  \"integrator_key\": \"%s\",\n", integ_key);
    std::printf("  \"integrator_note\": \"%s\",\n",
        integ == Integrator::kHermite
            ? "accurate per step but not symplectic: the energy error drifts over long spans"
      : integ == Integrator::kEuler
            ? "symplectic but only 1st order: it pumps energy in, so orbits spiral outward"
      : integ == Integrator::kKepler
            ? "each body is placed from ITS OWN elements at time t; mutual perturbations are "
              "deliberately absent -- that difference IS the perturbation the N-body mode adds"
            : "energy error oscillates within a bounded envelope instead of drifting");
    std::printf("  \"collide\": \"%s\",\n", collide.c_str());
    std::printf("  \"radius_scale\": %.6g,\n", radius_scale);
    std::printf("  \"dt_years\": %.6g,\n", dt);
    std::printf("  \"years\": %.6g,\n", years);
    std::printf("  \"samples\": %ld,\n", samples);
    // 地球质量（M☉）。页面要把"这个天体有多重"讲成人话（"相当于几个地球"）就必须用到它，
    // 而这种换算常数属于内核的口径，不该由页面自己抄一份 —— 抄了迟早和内核算的走散。
    std::printf("  \"earth_mass_msun\": %.10g,\n", kEarthMassMsun);
    // 输出采样的标定（页面用它来告诉玩家画质够不够，以及"该改成多少"）。
    // min_period_years = 0 表示这个系统里没有任何环绕天体（没有周期可言），
    // 页面必须按"不适用"处理，而不是显示一个 0。
    std::printf("  \"sampling\": {\n");
    std::printf("    \"min_period_years\": %.10g,\n", min_period_years);
    std::printf("    \"points_per_orbit_min\": %.6g,\n", points_per_orbit_min);
    std::printf("    \"points_per_orbit_target\": %.0f,\n", kPointsPerOrbit);
    std::printf("    \"points_per_orbit_ok\": %.0f,\n", kPointsPerOrbitOk);
    std::printf("    \"suggested_samples\": %ld,\n", suggested_samples);
    std::printf("    \"suggested_years\": %.6g,\n", suggested_years);
    std::printf("    \"samples_capped\": %s,\n", samples_capped ? "true" : "false");
    std::printf("    \"method\": \"vis-viva from each body's t=0 state relative to the "
                "most massive body; period = 2*pi*sqrt(a^3/mu)\"\n");
    std::printf("  },\n");
    std::printf("  \"star_collide\": %s,\n", csetup.stars_collide ? "true" : "false");
    // 碎裂模型的那几个**参数**（不是物理量）：页面要把它们显示出来，就必须读这里，
    // 而不是在 HTML 里抄一份 —— 抄一份迟早在某次调参后走散，而走散之后两边都不报错。
    std::printf("  \"fragmentation\": {\"fragments\": %d, \"dispersion_kms\": %.6g, "
                "\"frag_min_speed_kms\": %.6g, \"spray\": %.6g, "
                "\"model\": \"parameterised debris ring; no EOS, no tidal disruption\", "
                "\"spray_note\": \"0 = isotropic puff in an arbitrary plane, >0 = "
                "splash aimed down the impactor's approach direction (ring plane "
                "perpendicular to it + downrange displacement + axial shear); "
                "momentum is exact at every value\"},\n",
                static_cast<int>(fragments), dispersion_kms, frag_min_speed_kms, spray);
    // ---- 天体类型目录 ----
    // 放在同一次响应里而不是另开一个接口：页面拿它与这一份数据是**同一次**回显，
    // 不会出现"目录已更新、数据还是旧的"这种版本错位。约 2KB，不值得为它加一个往返。
    // 与 catalog 共用同一个打印函数（键名仍是 body_types，保持兼容）。
    // 共用的好处很实际：第一版是两处各写一遍，结果 catalog 少了 radius_formula 字段，
    // 两边的字段一开始就对不上 —— 判据一比才发现。
    print_body_types_array("body_types");
    std::printf(",\n");       // 后面还有 insolation_model 等键，逗号不能少
    std::printf("  \"insolation_model\": \"sum over all luminous bodies: "
                "S_i = Sigma_j L_j / r_ij^2 (j != i)\",\n");
    std::printf("  \"light_sources\": [");
    for (std::size_t k = 0; k < light_regs.size(); ++k) {
        const std::size_t li = static_cast<std::size_t>(light_regs[k]);
        const BodyType* t = reg[li].type_key.empty() ? known_body_type(reg[li].name)
                                                     : find_body_type(reg[li].type_key);
        std::printf("%s{\"id\": \"%s\", \"mass_msun\": %.10g, \"luminosity_Lsun\": %.10g, "
                    "\"type\": \"%s\"}",
                    k ? ", " : "", reg[li].name.c_str(), reg[li].mass, lum_of[li],
                    t ? t->key : "");
    }
    std::printf("],\n");
    std::printf("  \"light_source_count\": %d,\n", light_count);
    std::printf("  \"total_luminosity_Lsun\": %.10g,\n", total_L);
    // 属性覆盖（--set）：回显"实际生效的那两个量"，第三个是派生的，不回显。
    std::printf("  \"overrides\": [");
    for (std::size_t i = 0; i < overrides.size(); ++i) {
        const BodyOverride& o = overrides[i];
        std::printf("%s{\"name\": \"%s\"", i ? ", " : "", o.name.c_str());
        if (o.mass_given)  std::printf(", \"mass_msun\": %.10g", o.mass);
        if (o.radius_given) std::printf(", \"radius_km\": %.10g", o.radius);
        if (o.density_given) std::printf(", \"density_g_cm3\": %.10g", o.density);
        std::printf("}");
    }
    std::printf("],\n");
    std::printf("  \"frames\": [\n");

    long next_sample = 0;
    bool first_frame = true;
    bool last_emitted = false;
    long frames_emitted = 0;
    double prev_sample_time = 0.0;
    for (long step = 0; step <= total_steps; ++step) {
        const bool is_last = (step == total_steps);
        if (step == next_sample || (is_last && !last_emitted)) {
            for (std::size_t i = 0; i < sys.size(); ++i)
                reg_pos[sys_owner[i]] = sys.bodies[i].position;
            // 演化只在帧边界推进：和轨迹同一份时间分辨率，帧内不做细分。
            // dt 取"距上一帧的真实间隔"，这样碰撞把消息吃掉一帧也不会漏掉时间。
            const double dt_frame = sys.time - prev_sample_time;
            prev_sample_time = sys.time;
            if (bio_on) {
                // 每个天体的辐照度 = 所有发光天体对它的贡献之和。
                // 自己照不照亮自己？物理上"一个天体被自己表面反射的光加热"是另一回事，
                // 这里跳过 j == 自己，免得出现 r=0 的奇点，也免得把自照当成外照。
                for (std::size_t s = 0; s < sys.size(); ++s) {
                    const std::size_t ri = sys_owner[s];
                    if (!has_light) continue;
                    double S_sum = 0.0;
                    for (int li : light_regs) {
                        if (static_cast<std::size_t>(li) == ri) continue;
                        const std::size_t lj = static_cast<std::size_t>(li);
                        // 变星的光度是时间的函数：脉动直接进辐照度，
                        // 行星的地表温与演化进度会跟着振荡 —— 这是这一层唯一"随时间变的光源"。
                        double L = lum_of[lj];
                        if (type_of[lj] && type_of[lj]->var.on)
                            L *= starpivot::variability_factor(*type_of[lj], sys.time, var_phase[lj]);
                        const Vec3 d = sys.bodies[s].position - frame_pos(lj);
                        S_sum += starpivot::insolation_at(d.norm(), L);
                    }
                    starpivot::step_bio_S(bio[ri], S_sum, dt_frame, biop, sys.time);
                }
                for (std::size_t i = 0; i < reg.size(); ++i) {
                    stage_of[i].push_back(bio[i].stage);
                    verdict_of[i].push_back(verdict_code(bio[i]));
                    prog_of[i].push_back(bio[i].progress);
                    ins_of[i].push_back(bio[i].insolation);
                    teq_of[i].push_back(bio[i].t_eq_K);
                    tsurf_of[i].push_back(bio[i].t_surf_K);
                }
            }
            if (any_variable) {
                for (std::size_t i = 0; i < reg.size(); ++i) {
                    const BodyType* t = type_of[i];
                    double L = lum_of[i];
                    if (t && t->var.on)
                        L *= starpivot::variability_factor(*t, sys.time, var_phase[i]);
                    lum_series[i].push_back(L);
                }
            }
            // 逐帧总能量。页面拿它画"能量误差曲线"：贴底 = 保能量，上扬 = 在偷能量。
            // 解析模式下这条曲线**不贴底**（总能量不守恒，因为解析解只考虑二体）——
            // 那正是它要讲的另一件事，页面按 integrator_key 分开标注。
            frames_energy.push_back(std::abs(e0) > 0.0
                ? std::abs(total_energy(sys) - e0) / std::abs(e0) : 0.0);
            ++frames_emitted;
            if (!first_frame) std::printf(",\n");
            first_frame = false;
            std::printf("    {\"t\": %.6g, \"p\": [", sys.time);
            for (std::size_t i = 0; i < reg.size(); ++i) {
                const Vec3 q = frame_pos(i);
                std::printf("%s[%.6f, %.6f, %.6f]", i ? ", " : "", q.x, q.y, q.z);
            }
            std::printf("]}");
            if (is_last) last_emitted = true;
            next_sample += every;
        }
        if (step < total_steps) {
            integ_step(dt);
            if (mode != CollisionMode::kOff) handle_collisions();
        }
    }
    std::printf("\n  ],\n");

    // 生物演化输出。分两层打标：物理层是真公式，编排层必须写明是编排。
    // 分层声明放在内核产物里、而不是只在 README 里，是因为页面最容易偷懒
    // 直接画个好看的颜色，而不告诉你它画的是编出来的东西。
    if (bio_on) {
        std::printf("  \"bio\": {\n");
        std::printf("    \"layer1_physics\": \"辐照度 S = (L/Lsun)/r^2、恒星光度 M^3.5、"
                    "平衡温度 T_eq = 278.6*((1-A)*S)^(1/4)、以及冰点 273 K / 沸点 373 K "
                    "—— 真公式与水的物性常数，可在教材里逐条核对。\",\n");
        std::printf("    \"layer2_stylized\": \"9 级演化阶梯、每级进度、以及速率沿温度的高斯"
                    "衰减（峰值 288 K、半宽 28 K）与'走完全条阶梯所需年数'都是编排，"
                    "不是生物学。真实演化以 Myr~Gyr 计，此处没有可用公式。\",\n");
        std::printf("    \"caveats\": \"近地表温度是 T_eq 加一个固定温室增温 %.1f K"
                    "（地球实测值），这不是定律而是经验补偿：没有它，地球自己的"
                    "T_eq 254 K 就在冰点以下，模型会判地球不可能有液态水。"
                    "代价是金星被严重低估——本模型给约 %.0f K，真实地表 737 K"
                    "（失控温室）。本模型只回答'如果大气只像地球这样会怎样'。"
                    "恒星光度 M^3.5 只在约 0.43~2 Msun 内可靠，区间外是外推。\",\n",
                    biop.greenhouse_K,
                    starpivot::surface_temp_k(
                        starpivot::equilibrium_temp_k(
                            starpivot::insolation_at(0.723, 1.0), biop.albedo),
                        biop.greenhouse_K));
        // primary 的语义已经改了：现在是**最亮的那个**，不再是"最重的那个"。
        // 页面要照抄这句话，不能让玩家以为"主星 = 最重的"。
        std::printf("    \"primary\": \"%s\",\n", has_light ? reg[primary_reg].name.c_str() : "");
        std::printf("    \"primary_basis\": \"most luminous (not most massive)\",\n");
        std::printf("    \"primary_mass_msun\": %.10g,\n", has_light ? reg[primary_reg].mass : 0.0);
        // primary_tied 保留但恒为 false：它的原意是"最重者并列 ⇒ 唯一光源没有定义"，
        // 而现在是多光源求和，"谁照亮谁"本来就有定义，这个死角不存在了。
        // 字段不删是为了不破坏已经写好的读取方（页面用它做过提示文字）。
        std::printf("    \"primary_tied\": false,\n");
        std::printf("    \"light_source_count\": %d,\n", light_count);
        std::printf("    \"total_luminosity_Lsun\": %.10g,\n", total_L);
        std::printf("    \"luminosity_Lsun\": %.10g,\n", primary_L);
        std::printf("    \"luminosity_model\": \"L/Lsun = M^3.5 (主序带经验关系)\",\n");
        std::printf("    \"albedo\": %.10g, \"greenhouse_K\": %.10g, \"defaults_used\": %s,\n",
                    biop.albedo, biop.greenhouse_K, bio_defaults_used ? "true" : "false");
        std::printf("    \"full_ladder_years\": %.10g,\n", biop.full_ladder_years);
        // 两个硬阈值（水的冰点/沸点，有物理出处）与两个平滑旋钮（高斯峰/半宽，编排）。
        // 页面照抄这份数字，不要自己再抄一套阈值。
        std::printf("    \"freezing_K\": %.1f, \"sterilization_K\": %.1f,\n",
                    starpivot::kFreezing_K, starpivot::kSterilization_K);
        std::printf("    \"rate_peak_K\": %.1f, \"rate_sigma_K\": %.1f,\n",
                    starpivot::kRatePeak_K, starpivot::kRateSigma_K);
        std::printf("    \"frame_count\": %ld,\n", frames_emitted);
        std::printf("    \"verdict_names\": [\"no_light\", \"frozen\", \"evolving\", "
                    "\"sterilized\"],\n");
        std::printf("    \"stage_names\": [");
        for (int s = 0; s < starpivot::kBioStageCount; ++s)
            std::printf("%s\"%s\"", s ? ", " : "", starpivot::bio_stage_name(s));
        std::printf("],\n    \"bodies\": [");
        for (std::size_t i = 0; i < reg.size(); ++i) {
            // 碎块出生晚于第 0 帧、母体在碎裂后不再被推进，两者的数组天然短一截。
            // 用"最后已知值"补齐：演化只进不退，末值就是补位该有的值。
            const std::size_t nf = static_cast<std::size_t>(frames_emitted);
            std::vector<int>& st = stage_of[i];
            std::vector<int>& vd = verdict_of[i];
            std::vector<double>& pg = prog_of[i];
            std::vector<double>& ins = ins_of[i];
            std::vector<double>& teq = teq_of[i];
            std::vector<double>& tsf = tsurf_of[i];
            while (st.size() < nf) st.push_back(st.empty() ? 0 : st.back());
            while (vd.size() < nf) vd.push_back(vd.empty() ? 0 : vd.back());
            while (pg.size() < nf) pg.push_back(pg.empty() ? 0.0 : pg.back());
            while (ins.size() < nf) ins.push_back(ins.empty() ? 0.0 : ins.back());
            while (teq.size() < nf) teq.push_back(teq.empty() ? 0.0 : teq.back());
            while (tsf.size() < nf) tsf.push_back(tsf.empty() ? 0.0 : tsf.back());

            std::printf("%s{\"id\": \"%s\", \"stage\": [", i ? ", " : "", reg[i].name.c_str());
            for (std::size_t f = 0; f < st.size(); ++f)
                std::printf("%s%d", f ? ", " : "", st[f]);
            std::printf("], \"verdict\": [");
            for (std::size_t f = 0; f < vd.size(); ++f)
                std::printf("%s%d", f ? ", " : "", vd[f]);
            std::printf("], \"progress\": [");
            for (std::size_t f = 0; f < pg.size(); ++f)
                std::printf("%s%.4g", f ? ", " : "", pg[f]);
            // 三个物理量用 %.6g：CLI 的设计规则是"每个数字都要能核对"，
            // 4 位有效数字会让"用 S 反算 T_eq"这种交叉验算差到 0.05 K 而对不上。
            // progress 是 [0,1] 的进度，%.4g 已足够且省字节。
            std::printf("], \"insolation\": [");
            for (std::size_t f = 0; f < ins.size(); ++f)
                std::printf("%s%.6g", f ? ", " : "", ins[f]);
            std::printf("], \"t_eq_K\": [");
            for (std::size_t f = 0; f < teq.size(); ++f)
                std::printf("%s%.6g", f ? ", " : "", teq[f]);
            std::printf("], \"t_surf_K\": [");
            for (std::size_t f = 0; f < tsf.size(); ++f)
                std::printf("%s%.6g", f ? ", " : "", tsf[f]);
            // 末值单列出来，页面做表格时不必去索引最后一个元素。
            std::printf("], \"stage_final\": %d, \"stage_name\": \"%s\", "
                        "\"progress_final\": %.6g, \"insolation_final\": %.6g, "
                        "\"t_eq_final\": %.6g, \"t_surf_final\": %.6g, "
                        "\"stage_reached_at_Y\": %.6g}",
                        bio[i].stage, starpivot::bio_stage_name(bio[i].stage),
                        bio[i].progress, bio[i].insolation, bio[i].t_eq_K,
                        bio[i].t_surf_K, bio[i].t_stage);
        }
        std::printf("]\n  },\n");
    }

    // 碰撞事件时间线（按发生顺序）
    std::printf("  \"events\": [");
    for (std::size_t i = 0; i < events.size(); ++i) {
        const CollisionEvent& ev = events[i];
        std::printf("%s{\"t\": %.6g, \"kind\": \"%s\", \"a\": \"%s\", \"b\": \"%s\", "
                    "\"distance_AU\": %.6g, \"rel_speed_AU_per_yr\": %.6g, "
                    "\"mass_before\": %.10g, \"mass_after\": %.10g, "
                    "\"energy_before\": %.6g, \"energy_after\": %.6g, "
                    "\"energy_delta\": %.6g, \"fragments\": %d, \"ring_AU\": %.6g, "
                    // 喷流方向与锥形系数：**回显实际用的那一组**，让页面能如实说出
                    // "碎屑沿来向成束飞出"这件事，而不是自己去猜或自己去算。
                    "\"spray\": %.6g, \"spray_axis\": [%.6g, %.6g, %.6g]}",
                    i ? ", " : "", ev.t, ev.kind ? "fragment" : "merge",
                    ev.id_a.c_str(), ev.id_b.c_str(), ev.distance, ev.relative_speed,
                    ev.mass_before, ev.mass_after, ev.energy_before, ev.energy_after,
                    ev.energy_delta, ev.fragments, ev.ring_radius,
                    ev.spray, ev.spray_dir.x, ev.spray_dir.y, ev.spray_dir.z);
    }
    std::printf("],\n");
    // 能量误差曲线（相对值，逐帧）。放在 frames 之后，页面直接拿来画积分器对比。
    std::printf("  \"energy_series\": [");
    for (std::size_t f = 0; f < frames_energy.size(); ++f)
        std::printf("%s%.6g", f ? ", " : "", frames_energy[f]);
    std::printf("],\n");
    std::printf("  \"event_count\": %zu,\n", events.size());

    // 天体元数据在积分结束后输出：合并/碎裂会改写质量、半径与生死时刻，
    // 只有在事件全部处理完之后这些信息才是最终状态。
    std::printf("  \"bodies\": [");
    for (std::size_t i = 0; i < reg.size(); ++i) {
        // 密度是派生量：只有两个自由度，第三个按 ρ = M/(4/3πR³) 现算。
        // 质量 0（试验粒子）或半径 0（质点）时无定义 —— 记 0，绝不输出 NaN/inf。
        std::printf("%s{\"id\": \"%s\", \"mass_msun\": %.10g, \"radius_km\": %.6g, "
                    "\"density_g_cm3\": %.6g",
                    i ? ", " : "", reg[i].name.c_str(), reg[i].mass, reg[i].radius_km,
                    density_g_cm3(reg[i].mass, reg[i].radius_km));
        if (reg[i].has_ic) {
            // root_ic 只含"有根数"的天体（太阳、figure8 不在其中），
            // 位置由上面的对齐循环登记。
            const CustomBodyIC& c = root_ic[ic_of_reg[i] >= 0 ? ic_of_reg[i] : 0];
            std::printf(", \"ic_heliocentric\": {\"a_AU\": %.6g, \"e\": %.6g, "
                        "\"inc_deg\": %.6g, \"raan_deg\": %.6g, \"argp_deg\": %.6g, "
                        "\"M0_deg\": %.6g}",
                        c.a, c.e, c.inc, c.raan, c.argp, c.M0);
        }
        // 类型与"是否发光"：页面拿这两个字段显示类型名、说明"这颗星照不照亮别人"。
        // 没声明类型的（内置行星按名字认，认不出就空）如实回显 type: ""，
        // 让页面能区分"它就是个行星"和"它没说"。
        {
            const BodyType* t = reg[i].type_key.empty() ? known_body_type(reg[i].name)
                                                        : find_body_type(reg[i].type_key);
            std::printf(", \"type\": \"%s\"", t ? t->key : "");
            std::printf(", \"type_name\": \"%s\"", t ? t->name_zh : "");
            std::printf(", \"emits_light\": %s",
                        body_emits_light(reg[i].mass, t) ? "true" : "false");
            // 光度与有效温度：走 sprops（观测覆盖 > 类型表 > 质光关系兜底）。
            // 同时回显 src —— 页面必须能区分"这一颗星的观测值"和"这一类星的代表值"，
            // 否则真实数据一接进来，页面就分不清自己显示的是哪一种，也就没法如实标注。
            std::printf(", \"luminosity_Lsun\": %.10g", sprops[i].lum_lsun);
            std::printf(", \"luminosity_src\": \"%s\"", sprops[i].lum_src);
            std::printf(", \"t_eff_K\": %.10g", sprops[i].t_eff_K);
            std::printf(", \"t_eff_src\": \"%s\"", sprops[i].t_eff_src);
            if (t) {
                std::printf(", \"type_group\": \"%s\", \"type_also_in\": \"%s\", "
                            "\"type_example\": \"%s\", \"radius_formula\": \"%s\", "
                            "\"lum_formula\": \"%s\"",
                    t->group == TypeGroup::kSpectral ? "spectral"
                      : (t->group == TypeGroup::kLuminosity ? "luminosity"
                      : (t->group == TypeGroup::kEvolution ? "evolution" : "special")),
                    t->also_in, t->example,
                    t->radius_model == RadiusModel::kStefanBoltzmann
                        ? "R = Rsun*sqrt(L/Lsun)/(T/Tsun)^2"
                      : (t->radius_model == RadiusModel::kSchwarzschild ? "R = 2GM/c^2"
                      : (t->radius_model == RadiusModel::kFixed
                         ? "R = const (observed typical)"
                         : "R = Rref*(M/Mref)^p")),
                    t->lum_model == LumModel::kMassToThe35 ? "L/Lsun = M^3.5"
                      : (t->lum_model == LumModel::kFixedL ? "L = observed typical"
                      : (t->lum_model == LumModel::kFromRadiusAndT ? "L = (R/Rsun)^2*(T/Tsun)^4"
                                                                   : "L = 0")));
                if (t->var.on) {
                    std::printf(", \"variability\": {\"on\": true, \"period_days\": %.6g, "
                                "\"amplitude_mag\": %.6g, \"kind\": \"%s\"}",
                                t->var.period_days, t->var.amplitude_mag, t->var.kind);
                    // 逐帧光度序列：页面据此让那颗星在画面上真的变亮变暗。
                    std::printf(", \"lum_series\": [");
                    for (std::size_t f = 0; f < lum_series[i].size(); ++f)
                        std::printf("%s%.6g", f ? ", " : "", lum_series[i][f]);
                    std::printf("]");
                }
            }
        }
        std::printf(", \"born_at\": %.6g", reg[i].born);
        if (reg[i].died >= 0.0) {
            std::printf(", \"died_at\": %.6g", reg[i].died);
            if (reg[i].merged_into >= 0)
                std::printf(", \"merged_into\": \"%s\"",
                            reg[static_cast<std::size_t>(reg[i].merged_into)].name.c_str());
            else
                std::printf(", \"merged_into\": null");
        }
        std::printf("}");
    }
    std::printf("],\n");

    const double e1 = total_energy(sys);
    const Vec3 p1 = total_momentum(sys);
    // 质量为 0 的试验粒子（合法输入）会让 e0 恰为 0——此时退化为绝对差，
    // 否则 0/0 = NaN 会污染 JSON 输出。
    const double e_drift = (e0 != 0.0)
        ? std::fabs((e1 - e0) / e0) : std::fabs(e1 - e0);
    const double p_drift = (p1 - p0).norm();
    std::printf("  \"diagnostics\": {\"energy0\": %.17g, \"energy1\": %.17g, "
                "\"energy_drift\": %.6e, \"momentum_drift\": %.6e,\n",
                e0, e1, e_drift, p_drift);
    std::printf("    \"note\": \"太阳系初值为 J2000 日心平根数（Standish/JPL 近似），"
                "视觉化足够、非星历表精度；figure8 为 Chenciner-Montgomery 初值。"
                "自定义天体为日心开普勒根数（双星伴星等大质量天体在质心修正后仍然自洽）。"
                "辛积分器能量误差有界振荡而非累积。"
                "碰撞为几何检测（半径相交）+ 完美吸积（质量/动量守恒、动能减少）或参数化碎裂"
                "（等质量碎屑环 + 去均值色散速度）；不是撞击物理——无状态方程、无潮汐破坏判据、"
                "无掠撞逃逸分支，因此开启碰撞后 energy_drift 会显著增大，这是模型行为不是积分发散。"
                "--set 改属性只改属性本身，不动初始状态矢量：改太阳质量就能看到"
                "行星速度不变而轨道整体胀缩（或外逃），这是物理而不是 bug；"
                "均匀球的 质量/半径/密度 只有两个自由度，第三个永远由 "
                "ρ = M/(4/3·πR³) 派生，不能独立指定。\"}\n");
    std::printf("}\n");
    return 0;
}

int cmd_about(const std::vector<std::string>&) {
    std::printf("{\n");
    std::printf("  \"product\": \"starpivot\",\n");
    std::printf("  \"version\": \"1.0.0\",\n");
    std::printf("  \"modules\": [\"nbody\", \"hermite4\", \"leapfrog\", \"spin\", "
                "\"time\", \"perturb\", \"tle\"],\n");
    std::printf("  \"units\": {\n");
    std::printf("    \"nbody_kernel\": \"AU / Msun / yr\",\n");
    std::printf("    \"perturb_and_cli\": \"km / kg / s\",\n");
    std::printf("    \"tle\": \"TEME, km / km/s, WGS72 constants\"\n");
    std::printf("  },\n");
    std::printf("  \"sgp4\": {\n");
    std::printf("    \"status\": \"implemented_and_verified\",\n");
    std::printf("    \"reference\": \"Vallado et al., AIAA 2006-6753 Rev 1, Appendix D\",\n");
    std::printf("    \"max_error\": \"< 1e-6 km position, < 1e-9 km/s velocity\"\n");
    std::printf("  },\n");
    std::printf("  \"not_implemented\": [\"orbit determination\", "
                "\"tesseral gravity\", \"space weather driven density\"]\n");
    std::printf("}\n");
    return 0;
}

// 类型表的 JSON 数组打印 —— catalog 与 nbody 共用这一份。
// 两个命令各写一遍的话，页面从哪一处读都可能拿到与前一处不一致的字段（第一版就这么踩过）。
static void print_body_types_array(const char* key) {
    int tn = 0;
    const BodyType* ts = body_types(&tn);
    std::printf("  \"%s\": [", key);
    for (int i = 0; i < tn; ++i) {
        const BodyType& t = ts[i];
        const char* grp = t.group == TypeGroup::kSpectral ? "spectral"
                        : (t.group == TypeGroup::kLuminosity ? "luminosity"
                        : (t.group == TypeGroup::kEvolution ? "evolution" : "special"));
        std::printf("%s{\"key\": \"%s\", \"name_zh\": \"%s\", \"name_en\": \"%s\", "
                    "\"example\": \"%s\", \"group\": \"%s\", \"also_in\": \"%s\", "
                    "\"mass_min\": %.10g, \"mass_max\": %.10g, \"mass_default\": %.10g, "
                    "\"t_eff_K\": %.10g, \"emits_light\": %s, \"radius_model\": \"%s\", "
                    "\"lum_model\": \"%s\", ",
                    i ? ", " : "", t.key, t.name_zh, t.name_en, t.example, grp, t.also_in,
                    t.mass_min, t.mass_max, t.mass_default, t.t_eff_K,
                    t.emits_light ? "true" : "false",
                    t.radius_model == RadiusModel::kSchwarzschild ? "schwarzschild"
                      : (t.radius_model == RadiusModel::kStefanBoltzmann ? "stefan_boltzmann"
                      : (t.radius_model == RadiusModel::kDegenerate ? "degenerate" : "fixed")),
                    t.lum_model == LumModel::kMassToThe35 ? "mass_to_the_35"
                      : (t.lum_model == LumModel::kFixedL ? "fixed"
                      : (t.lum_model == LumModel::kFromRadiusAndT ? "from_radius_and_t" : "none")));
        // radius_formula 与 lum_formula 必须和 nbody 回显里的字段**逐字相同**：
        // 两处各写一份的话，页面拿哪一份都可能与前一份不一致（第一版 catalog 就没有
        // 这个字段，判据一比就发现两边对不上）。
        if (t.radius_model == RadiusModel::kStefanBoltzmann)
            std::printf("\"radius_formula\": \"R = Rsun*sqrt(L/Lsun)/(T/Tsun)^2\", ");
        else if (t.radius_model == RadiusModel::kSchwarzschild)
            std::printf("\"radius_formula\": \"R = 2GM/c^2\", ");
        else if (t.radius_model == RadiusModel::kFixed)
            std::printf("\"radius_formula\": \"R = %.6g km (const)\", ", t.r_ref_km);
        else
            std::printf("\"radius_formula\": \"R = %.6g km * (M/%.6g)^%.4g\", ",
                        t.r_ref_km, t.m_ref_msun, t.p);
        if (t.lum_model == LumModel::kMassToThe35)
            std::printf("\"lum_formula\": \"L/Lsun = M^3.5\", ");
        else if (t.lum_model == LumModel::kFixedL)
            std::printf("\"lum_formula\": \"L = %.6g Lsun (observed typical)\", ", t.lum_lsun);
        else if (t.lum_model == LumModel::kFromRadiusAndT)
            std::printf("\"lum_formula\": \"L = (R/Rsun)^2*(T/Tsun)^4\", ");
        else
            std::printf("\"lum_formula\": \"L = 0 (does not illuminate)\", ");
        std::printf("\"p\": %.6g, \"source\": \"%s\", ", t.p, t.source);
        // 半径：给"锚点半径 + 指数"以及几个代表质量处的实际值，方便人核对量级。
        std::printf("\"radius_at\": {");
        const double probe_m[3] = {t.mass_min, t.mass_default, t.mass_max};
        for (int k = 0; k < 3; ++k)
            std::printf("%s\"%.6g\": %.6g", k ? ", " : "", probe_m[k],
                        body_type_radius_km(t, probe_m[k]));
        std::printf("}, \"variability\": ");
        if (t.var.on)
            std::printf("{\"on\": true, \"period_days\": %.6g, \"amplitude_mag\": %.6g, "
                        "\"kind\": \"%s\", \"model\": \"sinusoidal in log-luminosity "
                        "(magnitudes are logarithmic, so the factor multiplies); real light "
                        "curves are not sinusoidal -- this is stylized\"}",
                        t.var.period_days, t.var.amplitude_mag, t.var.kind);
        else
            std::printf("{\"on\": false}");
        std::printf(", \"note\": \"%s\"}", t.note);
    }
    // 只打到 "]" 为止：后面的逗号由调用方决定 —— catalog 里它是最后一个键（不能有逗号），
    // nbody 里后面还有别的键（必须有逗号）。第一版在这里写死了 \n，nbody 那边就少了逗号，
    // 整个响应成了非法 JSON（页面与判据一起 parse 失败）。
    std::printf("]");
}

// ---------------------------------------------------------------------------
// lagrange：圆型限制性三体问题的五个拉格朗日点
//
// 为什么这个命令存在：求解器原先只被 tests/fixtures.hpp 使用，页面拿不到
// 任何一个 L 点的坐标，于是"拉格朗日点"对用户是个不存在的概念。这里把它
// 变成产品面：内核给坐标、给距离、给稳定性判据、给残差，页面只画与转述。
//
// 关于 --a-au：两星间距**必须显式给**。没有初值时无法从质量反推间距
// （那是求解问题，不是查表），而默默用一个默认值会让用户以为间距是算出来
// 的。所以缺省 1.0，但回执里 a_source 明确写 "default"，不装作是给定的。
// ---------------------------------------------------------------------------
int cmd_lagrange(const std::vector<std::string>& args) {
    std::string primary = "Sun", secondary = "Earth";
    double m1 = mass::SUN, m2 = mass::EARTH, a = 1.0;
    bool a_given = false;

    for (std::size_t i = 0; i < args.size(); ++i) {
        const std::string& k = args[i];
        if (k == "--primary" && i + 1 < args.size()) {
            primary = args[++i];
        } else if (k == "--secondary" && i + 1 < args.size()) {
            secondary = args[++i];
        } else if (k == "--mass-primary" && i + 1 < args.size()) {
            m1 = std::atof(args[++i].c_str());
        } else if (k == "--mass-secondary" && i + 1 < args.size()) {
            m2 = std::atof(args[++i].c_str());
        } else if (k == "--a-au" && i + 1 < args.size()) {
            a = std::atof(args[++i].c_str());
            a_given = true;
        } else {
            std::fprintf(stderr,
                         "starpivot lagrange: unknown option %s\n"
                         "usage: starpivot lagrange --primary <name> --secondary <name> "
                         "[--mass-primary msun] [--mass-secondary msun] [--a-au au]\n",
                         k.c_str());
            return 1;
        }
    }
    if (!(m1 > 0.0) || !(m2 > 0.0) || !(a > 0.0)) {
        std::fprintf(stderr,
                     "starpivot lagrange: masses and separation must be positive "
                     "(got m1=%.6g m2=%.6g a=%.6g)\n", m1, m2, a);
        return 1;
    }

    const LagrangeSolution sol = solve_lagrange(m1, m2, a);
    const double au_km = 149597870.7;

    std::printf("{\n");
    std::printf("  \"status\": \"ok\",\n  \"command\": \"lagrange\",\n");
    std::printf("  \"primary\": \"%s\",\n  \"secondary\": \"%s\",\n",
                json_safe(primary).c_str(), json_safe(secondary).c_str());
    std::printf("  \"mass_primary_msun\": %.10g,\n  \"mass_secondary_msun\": %.10g,\n", m1, m2);
    std::printf("  \"a_au\": %.10g,\n  \"a_km\": %.10g,\n", sol.a, sol.a * au_km);
    std::printf("  \"a_source\": \"%s\",\n", a_given ? "given" : "default");
    std::printf("  \"mu\": %.12g,\n", sol.mu);
    std::printf("  \"routh_limit\": %.12g,\n", sol.routh_limit);
    std::printf("  \"triangular_stable\": %s,\n", sol.triangular_stable ? "true" : "false");
    std::printf("  \"collinear_stable\": %s,\n", sol.collinear_stable ? "true" : "false");
    // 原本这里用的是 \xNN UTF-8 字节转义。**不能用**：C++ 的十六进制转义是
    // 贪婪的 —— \x7a8 会被读成三位十六进制 0x7a8（超出一个 char）而不是
    // \x7a + "8"，于是整个字符串从那里开始就是坏的。要写非 ASCII 就直接写
    // UTF-8 原文，编译器按源文件编码处理。
    std::printf("  \"stability_caveat\": \"L4/L5 的稳定是有条件的：mu < routh_limit；超标就会失稳\",\n");
    std::printf("  \"points\": [\n");
    for (std::size_t i = 0; i < sol.points.size(); ++i) {
        const LagrangePoint& p = sol.points[i];
        std::printf("    {\"key\": \"%s\", \"name_zh\": \"%s\", \"note_zh\": \"%s\", ",
                    p.key, p.name_zh, p.note_zh);
        std::printf("\"stable\": %s, ", p.stable ? "true" : "false");
        std::printf("\"pos_au\": [%.12g, %.12g, %.12g], ", p.pos.x, p.pos.y, p.pos.z);
        std::printf("\"pos_km\": [%.10g, %.10g, %.10g], ",
                    p.pos.x * au_km, p.pos.y * au_km, p.pos.z * au_km);
        std::printf("\"from_primary_au\": %.12g, \"from_secondary_au\": %.12g, ",
                    p.from_primary, p.from_secondary);
        std::printf("\"residual\": %.3e}%s\n", p.residual,
                    (i + 1 < sol.points.size()) ? "," : "");
    }
    std::printf("  ]\n}\n");
    return 0;
}

// ---------------------------------------------------------------------------
// genesis：按种子生成一套物理上合法的系统
//
// 可复现是硬性质：同 seed 必须逐位复现。随机源走 splitmix64（纯整数），
// 刻意不用 <random>——后者不是标准规定的实现，换个标准库就会换一套数，
// "今天的宇宙"会变。回执里同时给出 seed 与它的哈希，便于发现中途的编码损坏。
//
// --seed-hex 是为了绕开一个实测到的坑
// ------------------------------------
// Windows 上 argv 是按 ANSI 代码页从宽字符命令行转出来的，非 ASCII 的种子
// 会在到达 main() **之前**就被改写：实测传"中文种子"，回执里的 seed 不是
// 逐字相同（哈希自然也跟着错）。这不是本模块的 bug，但它会让"同一种子 =
// 同一个宇宙"这条承诺在中文/emoji 种子上悄悄失效。
// 所以加一条 --seed-hex：网关把 seed 的 UTF-8 字节编成十六进制传进来，
// 内核解码后再哈希。修在真正出错的那一层，而不是在回执里写一句"已知会坏"。
// ---------------------------------------------------------------------------

/// 十六进制解码。奇数长度、非法字符都返回 false（调用方报错，不猜）。
static bool hex_decode(const std::string& hex, std::string* out) {
    if (hex.size() % 2 != 0) return false;
    out->clear();
    out->reserve(hex.size() / 2);
    for (std::size_t i = 0; i < hex.size(); i += 2) {
        int hi = -1, lo = -1;
        const char a = hex[i], b = hex[i + 1];
        if (a >= '0' && a <= '9') hi = a - '0';
        else if (a >= 'a' && a <= 'f') hi = a - 'a' + 10;
        else if (a >= 'A' && a <= 'F') hi = a - 'A' + 10;
        if (b >= '0' && b <= '9') lo = b - '0';
        else if (b >= 'a' && b <= 'f') lo = b - 'a' + 10;
        else if (b >= 'A' && b <= 'F') lo = b - 'A' + 10;
        if (hi < 0 || lo < 0) return false;
        out->push_back(static_cast<char>((hi << 4) | lo));
    }
    return true;
}

/// 把字符串安全地放进 JSON：转义引号/反斜杠/控制字符，并保证输出是**合法 UTF-8**。
///
/// 为什么要专门做这件事：argv 里的非 ASCII 字节是按 Windows 的 ANSI 代码页
/// 转过来的，可能根本不是合法 UTF-8（实测中文种子经 cp936 回显时 `星` 变成
/// D0 C7）。stdout 是字节流，一旦回执里混进非法 UTF-8，按 UTF-8 解码它的
/// 一侧会直接抛异常 —— 于是「种子不支持中文」变成「整个接口报了个看不懂的错」。
/// 所以：**非法字节一律替换成 U+FFFD，并同时把 wellformed 报成 false**，
/// 让调用方知道"你传进来的东西在到达我之前已经被改写了"。
/// 可靠的做法是从一开始就用 --seed-hex（网关正是这么做的）。
///
/// @param wellformed 若非空，被置为输入是否本来就是合法 UTF-8。
static std::string json_safe(const std::string& s, bool* wellformed) {
    auto cont = [](unsigned char c) { return (c & 0xC0) == 0x80; };
    std::string out;
    out.reserve(s.size() + 8);
    bool ok = true;
    for (std::size_t i = 0; i < s.size(); ++i) {
        const unsigned char c = static_cast<unsigned char>(s[i]);
        if (c == '"') { out += "\\\""; continue; }
        if (c == '\\') { out += "\\\\"; continue; }
        if (c < 0x20) {
            char buf[8];
            std::snprintf(buf, sizeof(buf), "\\u%04x", c);
            out += buf;
            continue;
        }
        if (c < 0x80) { out.push_back(static_cast<char>(c)); continue; }
        // 多字节序列：先判长度，再逐个校验续字节
        int len = 0;
        if ((c & 0xE0) == 0xC0) len = 2;
        else if ((c & 0xF0) == 0xE0) len = 3;
        else if ((c & 0xF8) == 0xF0) len = 4;
        if (len == 0 || i + static_cast<std::size_t>(len) > s.size()) {
            out += "\xEF\xBF\xBD";   // U+FFFD
            ok = false;
            continue;
        }
        bool seq_ok = true;
        for (int k = 1; k < len; ++k) {
            if (!cont(static_cast<unsigned char>(s[i + k]))) { seq_ok = false; break; }
        }
        if (!seq_ok) {
            out += "\xEF\xBF\xBD";
            ok = false;
            continue;
        }
        out.append(s, i, static_cast<std::size_t>(len));
        i += static_cast<std::size_t>(len) - 1;
    }
    if (wellformed) *wellformed = ok;
    return out;
}

int cmd_genesis(const std::vector<std::string>& args) {
    std::string seed;
    bool have_seed = false;
    std::string seed_source = "arg";
    int n_bodies = 4;

    for (std::size_t i = 0; i < args.size(); ++i) {
        const std::string& k = args[i];
        if (k == "--seed" && i + 1 < args.size()) {
            seed = args[++i];
            have_seed = true;
            seed_source = "arg";
        } else if (k == "--seed-hex" && i + 1 < args.size()) {
            const std::string hex = args[++i];
            if (!hex_decode(hex, &seed)) {
                std::fprintf(stderr,
                             "starpivot genesis: --seed-hex must be an even number "
                             "of hex digits (got %zu)\n", hex.size());
                return 1;
            }
            have_seed = true;
            seed_source = "hex";
        } else if (k == "--bodies" && i + 1 < args.size()) {
            n_bodies = std::atoi(args[++i].c_str());
        } else {
            std::fprintf(stderr,
                         "starpivot genesis: unknown option %s\n"
                         "usage: starpivot genesis (--seed <string> | --seed-hex <hex>) "
                         "[--bodies 2..8]\n",
                         k.c_str());
            return 1;
        }
    }
    if (!have_seed || seed.empty()) {
        // 明确报错，不静默生成一套"默认宇宙"：用户以为是自己点到的种子，
        // 实际上拿到的是别人的，那比报错坏得多。
        std::fprintf(stderr,
                     "starpivot genesis: --seed (or --seed-hex) is required and must "
                     "not be empty (an empty seed would silently hand out the same "
                     "universe to everyone)\n");
        return 1;
    }

    GenesisSystem g;
    try {
        g = generate_system(seed, n_bodies);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "starpivot genesis: %s\n", e.what());
        return 1;
    }

    std::printf("{\n");
    std::printf("  \"status\": \"ok\",\n  \"command\": \"genesis\",\n");
    // seed 走 json_safe：argv 里的非 ASCII 可能是 ANSI 码页字节而不是 UTF-8，
    // 直接印出去会让整个回执变成非法 UTF-8（解码方直接抛异常）。
    // seed_utf8=false 明确告诉调用方"你传的东西在到达内核前已被改写"——
    // 这种情况只有 --seed 会出现；--seed-hex 一定是 true。
    bool seed_utf8 = false;
    const std::string seed_js = json_safe(seed, &seed_utf8);
    std::printf("  \"seed\": \"%s\",\n  \"seed_hash\": \"%s\",\n  \"seed_source\": \"%s\",\n",
                seed_js.c_str(), g.seed_hash.c_str(), seed_source.c_str());
    std::printf("  \"seed_utf8\": %s,\n", seed_utf8 ? "true" : "false");
    std::printf("  \"primary_name\": \"%s\",\n  \"primary_mass_msun\": %.10g,\n",
                g.primary_name.c_str(), g.primary_mass_msun);
    std::printf("  \"placement_attempts\": %d,\n", g.placement_attempts);
    std::printf("  \"stability\": {\"min_sep_ratio\": %.10g, \"min_margin\": %.10g, "
                "\"criterion\": \"gladman\", \"note\": \"min_margin "
                "为最紧的一对实际间距比除以 Gladman 临界值，大于 1 才认定稳定\"},\n",
                g.min_sep_ratio, g.min_stability_margin);
    std::printf("  \"bodies\": [\n");
    for (std::size_t i = 0; i < g.bodies.size(); ++i) {
        const GenesisBody& b = g.bodies[i];
        std::printf("    {\"name\": \"%s\", \"type\": \"%s\", \"type_name\": \"%s\", ",
                    b.name.c_str(), b.type->key, b.type->name_zh);
        std::printf("\"mass_msun\": %.10g, ", b.mass_msun);
        std::printf("\"a_au\": %.10g, \"e\": %.10g, ", b.a_au, b.e);
        std::printf("\"inc_deg\": %.8g, \"raan_deg\": %.8g, ", b.inc_deg, b.raan_deg);
        std::printf("\"argp_deg\": %.8g, \"M0_deg\": %.8g, ", b.argp_deg, b.M0_deg);
        std::printf("\"radius_km\": %.10g, \"t_eff_K\": %.8g, \"lum_lsun\": %.10g}%s\n",
                    b.radius_km, b.t_eff_K, b.lum_lsun,
                    (i + 1 < g.bodies.size()) ? "," : "");
    }
    std::printf("  ]\n}\n");
    return 0;
}

int cmd_catalog(const std::vector<std::string>&) {
    std::printf("{\n");
    std::printf("  \"status\": \"ok\",\n  \"command\": \"catalog\",\n");
    std::printf("  \"groups\": ["
                "{\"key\": \"spectral\", \"name_zh\": \"按光谱型（表面温度）\", "
                "\"detail\": \"O B A F G K M 由热到冷；另有沃尔夫-拉叶星、碳星等特殊型\"},"
                "{\"key\": \"luminosity\", \"name_zh\": \"按光度与大小\", "
                "\"detail\": \"光度级 VI 亚矮星 / V 主序(矮星) / IV 亚巨星 / III 巨星 / "
                "II 亮巨星 / I 超巨星 / 0 特超巨星\"},"
                "{\"key\": \"evolution\", \"name_zh\": \"按演化阶段\", "
                "\"detail\": \"原恒星 → 主序 → 红巨星 → 白矮星 / 中子星 / 黑洞\"},"
                "{\"key\": \"special\", \"name_zh\": \"按特殊性质\", "
                "\"detail\": \"变星（造父/RR天琴/米拉）、脉冲星、磁星、贫金属星，以及「不是恒星」的对照组\"}],\n");
    std::printf("  \"cross_note\": \"四个维度互相交叉：一颗红巨星同时是 M 型（光谱）、"
                "III 级（光度）、晚期（演化）。每个类型的 also_in 字段写明了它在别的维度里算什么。\",\n");
    std::printf("  \"radius_note\": \"绝大多数恒星的半径由斯特藩-玻尔兹曼从 T 与 L 推出"
                "（真公式）；白矮星走简并关系 R ∝ M^(-1/3)；中子星是观测典型值；"
                "黑洞是史瓦西半径。每条类型的 source 字段写明了它的口径。\",\n");
    std::printf("  \"insolation_model\": \"sum over all luminous bodies: "
                "S_i = Sigma_j L_j / r_ij^2 (j != i)\",\n");
    std::printf("  \"light_fallback\": \"a body with no declared type is treated as "
                "luminous iff mass >= %.6g Msun (hydrogen burning limit)\",\n",
                starpivot::kHydrogenBurningLimit_Msun);
    print_body_types_array("types");
    std::printf("\n}\n");     // 它是最后一个键，所以只换行、不加逗号
    return 0;
}

void usage() {
    std::printf(
        "starpivot - planetary and orbital dynamics kernel\n"
        "\n"
        "usage: starpivot <command> [options]\n"
        "\n"
        "commands:\n"
        "  propagate   propagate a Keplerian orbit, emit JSON (ground track + drift)\n"
        "  elements    convert a state vector (km, km/s) to osculating elements\n"
        "  j2          J2 secular rates and the sun-synchronous check\n"
        "  verify-tle  SGP4/SDP4: parse a TLE and propagate to TEME state vectors\n"
        "  conj        conjunction screening: closest approach (TCA + miss) of two TLEs\n"
        "  groundtrack sub-satellite lat/lon track of one or two TLEs (for maps)\n"
        "  lagrange    the five Lagrange points of a circular restricted 3-body system\n"
        "  genesis     generate a physically valid system from a seed string (reproducible)\n"
        "  nbody       universe simulation: N-body integration (solar system / figure-8)\n"
        "  catalog     body types: mass range, radius model, whether it emits light\n"
        "  about       version, modules, unit systems, known gaps\n"
        "\n"
        "propagate options:\n"
        "  --a --e --inc --raan --argp --nu   initial elements (deg for angles)\n"
        "  --hours --step                     span [h] and step [s]\n"
        "  --epoch-jd                         start Julian Date (UTC)\n"
        "  --drag 1|0 --srp 1|0 --no-j2 1|0   force model switches\n"
        "  --area --mass                      spacecraft area [m^2] and mass [kg]\n"
        "\n"
        "verify-tle options:\n"
        "  --line1 --line2   the two TLE lines (quoted); or pipe two lines on stdin\n"
        "  --tsince m,m,...  elapsed minutes from epoch, comma or space separated\n"
        "                    (default 0,120,240,360)\n"
        "  --self-test       re-run the 6 official AIAA-2006-6753 Appendix-D vectors\n"
        "\n"
        "conj options:\n"
        "  --line1 --line2   object A TLE lines (quoted)\n"
        "  --line3 --line4   object B TLE lines (quoted)\n"
        "                    or pipe four TLE lines on stdin (A1 A2 B1 B2)\n"
        "  --window-min N    look-ahead minutes from A's epoch (default 1440 = 24h)\n"
        "  --step-min N      coarse sampling step in minutes (default 1.0)\n"
        "  --threshold-km K  if miss distance < K, set alert: true\n"
        "  --track-min N     half-window of the TCA ground track in minutes\n"
        "                    (default 90; 0 disables the ground_track output)\n"
        "  --self-test       same-object identity check (miss must be ~0)\n"
        "\n"
        "groundtrack options:\n"
        "  --line1 --line2   object A TLE lines (quoted)\n"
        "  --line3 --line4   optional object B TLE lines; or pipe 2 or 4 lines on stdin\n"
        "  --minutes N       window length in minutes from A's epoch (default 180)\n"
        "  --offset-min N    window start, minutes from A's epoch (default 0)\n"
        "  --step-min N      sampling step in minutes (default 1.0)\n"
        "\n"
        "nbody options:\n"
        "  --scenario s      solar (Sun+8 planets+Pluto) / figure8 / custom (Sun+your bodies)\n"
        "  --integrator I    leapfrog (default, symplectic) | hermite (4th order, not\n"
        "                    symplectic) | euler (1st order, pumps energy in) |\n"
        "                    kepler (analytic two-body from each body's own elements, no\n"
        "                    integration -- the gap to N-body IS the perturbation).\n"
        "                    The response carries energy_series so you can plot the drift.\n"
        "  --primary NAME    with --scenario custom only: interpret every other --body's\n"
        "                    elements as orbits around NAME (mu = G*(m_NAME + m_body)).\n"
        "                    NAME itself is placed at the origin at rest and its own\n"
        "                    a/e/i/raan/argp/M0 are not used. Without --primary the old\n"
        "                    convention holds: elements are heliocentric (origin ~ 1 Msun),\n"
        "                    which is wrong if your star is e.g. a 0.2 Msun red dwarf.\n"
        "  --solar m         with --scenario custom only: full (Sun+planets, default) |\n"
        "                    sun (Sun only) | none (no solar system at all)\n"
        "                    'none' is a real N-body setup: your bodies are each other's\n"
        "                    gravity source and orbit their common barycenter.\n"
        "  --body spec       custom body: name,a_AU,e,inc_deg,raan_deg,argp_deg,M0_deg,MASS\n"
        "                    where MASS is either a number in Msun, or 'type:mass' such as\n"
        "                    red_dwarf:0.2 / sun_like:1 / black_hole:10 -- then the radius\n"
        "                    comes from the type's own radius model (run: starpivot catalog)\n"
        "                    optional 9th field overrides the radius explicitly\n"
        "                    after that, key=value fields (any order, both optional):\n"
        "                      teff_K=T     observed effective temperature of THIS star\n"
        "                      lum_lsun=L   observed (or R+T derived) luminosity of THIS star\n"
        "                    These turn 'a type of star' into 'this star'. Needed because the\n"
        "                    type grid is a representative value: TRAPPIST-1 (0.0898 Msun)\n"
        "                    gets L=2.2e-4 Lsun from L=M^3.5, but its measured L is 5.5e-4 --\n"
        "                    and S=L/r^2 is what decides whether a planet is habitable.\n"
        "                    Radius, if not given, is then re-derived as R=Rsun*sqrt(L)/(T/Tsun)^2.\n"
        "                    Give the 9th field AND teff_K (but no lum_lsun) and the luminosity\n"
        "                    is derived from the two observations: L=(R/Rsun)^2*(T/Tsun)^4.\n"
        "                    That is the shape real catalogues come in -- they publish\n"
        "                    (mass, radius, T_eff) and leave L for you to compute.\n"
        "                    JSON echoes t_eff_src / luminosity_src = given |\n"
        "                    derived_from_radius_and_t_eff | type_grid |\n"
        "                    mass_luminosity_relation | none\n"
        "                    (repeatable, heliocentric Kepler IC; works with solar too)\n"
        "  --years N         integration span in years (default: solar/custom 50, figure8 6.5)\n"
        "  --dt N            step in years (default: solar 0.001, figure8 0.0002,\n"
        "                    custom: min(0.001, shortest orbit / 200))\n"
        "  --samples N       output frames (default 400, max 4000)\n"
        "  --set spec        override a body's physical properties:\n"
        "                    Name,mass_msun=M[,radius_km=R]  |  Name,radius_km=R[,mass_msun=M]\n"
        "                    |  Name,density=D[,mass_msun=M]\n"
        "                    Two of {mass, radius, density} only -- the third is derived\n"
        "                    by rho = M / (4/3 pi R^3). Bare 'Name,density=D' keeps the\n"
        "                    current mass and resizes. Matches any body in the scenario\n"
        "                    by name (Sun, Mercury..Neptune, Pluto, your custom bodies).\n"
        "  --collide m       off | merge (perfect accretion) | fragment (impact debris)\n"
        "  --radius-scale S  multiply every physical radius by S (real radii make\n"
        "                    collisions vanishingly rare: Earth is 4.3e-5 AU)\n"
        "  --fragments N     debris pieces per fragment event (default 4, max 12).\n"
        "                    The ring the pieces sit on is widened when N is large\n"
        "                    enough that the parent's radius would make neighbours\n"
        "                    touch -- pieces born overlapping are detected as a\n"
        "                    collision on the very next step. The ring actually used\n"
        "                    is echoed per event as ring_AU.\n"
        "  --dispersion-kms V  debris kick speed in km/s (default 1.0). 0 is legal:\n"
        "                    the pieces then simply keep the parent's velocity.\n"
        "  --frag-min-speed-kms V  relative speed above which an impact shatters\n"
        "                    instead of accreting (default 0.5). 0 = every contact\n"
        "                    shatters; the body count and registry caps still bound\n"
        "                    the cascade, they just make it big rather than endless.\n"
        "  --spray S         debris-splash scaling, 0..1 (default 0.6). 0 = the\n"
        "                    original isotropic puff: the pieces sit on a ring in an\n"
        "                    arbitrary plane and each gets an isotropic de-meaned\n"
        "                    kick, so the cloud expands in place. Above 0 the splash\n"
        "                    is aimed at the IMPACTOR'S APPROACH DIRECTION\n"
        "                    (v_impactor - v_target, sampled before the merge):\n"
        "                      * ring plane perpendicular to that direction\n"
        "                      * ring centre displaced downrange\n"
        "                      * kicks carry an axial shear\n"
        "                    so the debris is thrown forward and stretches into a\n"
        "                    streak along the impact axis. MODEL PARAMETER, not a\n"
        "                    cratering law: no impact angle, no ejecta mass-velocity\n"
        "                    distribution. Momentum is exact at every S (the radial\n"
        "                    kicks and the axial shear each sum to zero).\n"
        "                    NOTE: narrowing the KICK directions into a cone was the\n"
        "                    first attempt and was measured to do the OPPOSITE --\n"
        "                    de-meaning subtracts the common part, so a narrower cone\n"
        "                    leaves mostly transverse motion (at S=1 the dispersion\n"
        "                    vanishes entirely). Aim the geometry, not the velocity.\n"
        "  --albedo A        bond albedo for the equilibrium temperature (default 0.306)\n"
        "  --greenhouse K    greenhouse offset added to T_eq to get the surface temp\n"
        "                    (default 33, Earth's measured value). Without it Earth's own\n"
        "                    T_eq, 254 K, sits below freezing and nothing could evolve.\n"
        "  --bio-years N     years of 'ideal habitability' needed to climb the whole\n"
        "                    9-rung ladder (default 100). STYLIZED - not geological time.\n"
        "  --no-bio          skip the bio layer entirely (positions only)\n"
        "\n"
        "examples:\n"
        "  starpivot propagate --a 7078 --e 0.001 --inc 98.2 --hours 24 --step 60\n"
        "  starpivot j2 --a 7078 --inc 98.2\n"
        "  starpivot elements --r 7000,0,0 --v 0,7.546,1.0\n"
        "  starpivot conj --line1 \"1 ...\" --line2 \"2 ...\" --line3 \"1 ...\" --line4 \"2 ...\" --threshold-km 1\n"
        "\n"
        "  # make Jupiter 10x heavier, keep its radius -> density 10x\n"
        "  starpivot nbody --scenario solar --set \"Jupiter,mass_msun=9.547919e-3\"\n"
        "  # shrink the Sun to a white-dwarf size at unchanged mass -> density explodes\n"
        "  starpivot nbody --scenario solar --set \"Sun,radius_km=7000\"\n"
        "  # asked for a density, let the kernel size it\n"
        "  starpivot nbody --scenario solar --set \"Earth,density=13.0\"\n"
        "  # a two-body universe with no Sun at all: they orbit their common barycenter\n"
        "  starpivot nbody --scenario custom --solar none \\\n"
        "      --body \"StarA,1,0,0,0,0,0,0.5\" --body \"StarB,1,0,180,0,0,180,0.5\"\n"
        "  # only the Sun as the central mass, then add planets on top\n"
        "  starpivot nbody --scenario custom --solar sun --body \"X,1,0,0,0,0,0,1e-6\"\n"
        "  # walk the stylized 9-rung ladder at 5x speed; every body's stage comes\n"
        "  # from its own heliocentric distance (S, T_eq, sterilisation are real physics)\n"
        "  starpivot nbody --scenario solar --years 50 --bio-years 10\n"
        "  starpivot nbody --scenario solar --no-bio     # positions only\n"
        "  # let a Mars-like world keep a thick atmosphere: 273 K of greenhouse puts\n"
        "  # it inside the liquid-water window (T_surf > 273 K). Hothouse Venus instead:\n"
        "  starpivot nbody --scenario solar --greenhouse 200 --bio-years 50\n");
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        usage();
        return 0;
    }
    const std::string cmd = argv[1];
    std::vector<std::string> args;
    for (int i = 2; i < argc; ++i) args.emplace_back(argv[i]);

    if (cmd == "propagate") return cmd_propagate(args);
    if (cmd == "elements") return cmd_elements(args);
    if (cmd == "j2") return cmd_j2(args);
    if (cmd == "verify-tle") return cmd_verify_tle(args);
    if (cmd == "conj") return cmd_conj(args);
    if (cmd == "groundtrack") return cmd_groundtrack(args);
    if (cmd == "nbody") return cmd_nbody(args);
    if (cmd == "lagrange") return cmd_lagrange(args);
    if (cmd == "genesis") return cmd_genesis(args);
    if (cmd == "catalog") return cmd_catalog(args);
    if (cmd == "about") return cmd_about(args);
    if (cmd == "help" || cmd == "--help" || cmd == "-h") {
        usage();
        return 0;
    }
    die("unknown command '" + cmd + "'; try 'starpivot help'");
    return 2;
}
