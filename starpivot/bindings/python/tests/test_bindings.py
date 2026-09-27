"""pytest suite for the starpivot Python bindings.

These tests are integration tests for the *bindings*, not for the physics. Every
physical assertion here duplicates one that the C++ GoogleTest suite makes with a
much tighter tolerance; the point of running it from Python is to prove that the
bindings faithfully expose the kernel and that a .xsys-generated scenario can be
driven end to end without a C++ compiler in the loop.

Run with:
    pytest bindings/python/tests/ -v
"""

import math

import pytest

starpivot = pytest.importorskip(
    "starpivot_native",
    reason="starpivot_native not built; run cmake -DSTARPIVOT_BUILD_PYTHON=ON",
)

G = starpivot.G_AU_MSUN_YR
M_SUN = starpivot.MASS_SUN
M_EARTH = starpivot.MASS_EARTH


def two_body(a=1.0):
    """Sun + Earth, circular, barycentric. Mirrors tests/fixtures.hpp."""
    n = math.sqrt(G * (M_SUN + M_EARTH) / a**3)
    xe = a * M_SUN / (M_SUN + M_EARTH)
    xs = -a * M_EARTH / (M_SUN + M_EARTH)

    sys_ = starpivot.System()
    sys_.G = G
    sys_.add_body(starpivot.Body("sun", M_SUN, starpivot.Vec3(xs, 0.0, 0.0),
                                 starpivot.Vec3(0.0, n * xs, 0.0)))
    sys_.add_body(starpivot.Body("earth", M_EARTH, starpivot.Vec3(xe, 0.0, 0.0),
                                 starpivot.Vec3(0.0, n * xe, 0.0)))
    return sys_, n


def test_vec3_arithmetic():
    a = starpivot.Vec3(1.0, 2.0, 3.0)
    b = starpivot.Vec3(4.0, 5.0, 6.0)
    assert (a + b).x == pytest.approx(5.0)
    assert (b - a).z == pytest.approx(3.0)
    assert a.dot(b) == pytest.approx(32.0)
    assert a.norm() == pytest.approx(math.sqrt(14.0))
    assert (a * 2.0).y == pytest.approx(4.0)


def test_two_body_fixture_is_circular():
    sys_, _ = two_body()
    el = starpivot.compute_elements(sys_.bodies[0], sys_.bodies[1], G)
    assert el.semi_major_axis == pytest.approx(1.0, abs=1e-12)
    assert el.eccentricity == pytest.approx(0.0, abs=1e-12)
    p = starpivot.total_momentum(sys_)
    assert p.norm() < 1e-15


def test_hermite_conserves_energy_over_a_century():
    sys_, n = two_body()
    period = 2.0 * math.pi / n
    e0 = starpivot.total_energy(sys_)

    integ = starpivot.Hermite4(sys_)
    integ.run(period / 1000.0, 100.0)

    e1 = starpivot.total_energy(sys_)
    assert abs((e1 - e0) / e0) < 1e-9

    el = starpivot.compute_elements(sys_.bodies[0], sys_.bodies[1], G)
    assert el.semi_major_axis == pytest.approx(1.0, rel=1e-9)
    assert el.eccentricity < 1e-8


def test_leapfrog_reproduces_the_same_orbit_qualitatively():
    sys_, n = two_body()
    period = 2.0 * math.pi / n
    integ = starpivot.Leapfrog2(sys_)
    integ.run(period / 1000.0, 100.0)

    el = starpivot.compute_elements(sys_.bodies[0], sys_.bodies[1], G)
    assert el.semi_major_axis == pytest.approx(1.0, rel=1e-5)
    assert integ.last_energy_error < 1e-6


def test_to_barycentric_removes_drift():
    sys_ = starpivot.System()
    sys_.G = G
    sys_.add_body(starpivot.Body("sun", M_SUN, starpivot.Vec3(0.0, 0.0, 0.0),
                                 starpivot.Vec3(0.0, 0.0, 0.0)))
    sys_.add_body(starpivot.Body("earth", M_EARTH, starpivot.Vec3(1.0, 0.0, 0.0),
                                 starpivot.Vec3(0.0, 2.0 * math.pi, 0.0)))
    starpivot.to_barycentric(sys_)
    p = starpivot.total_momentum(sys_)
    assert p.norm() < 1e-12
    com = starpivot.center_of_mass(sys_)
    assert com.norm() < 1e-12


def test_compute_acceleration_points_at_the_central_body():
    sys_ = starpivot.System()
    sys_.G = 1.0
    sys_.add_body(starpivot.Body("c", 1.0, starpivot.Vec3(0.0, 0.0, 0.0),
                                 starpivot.Vec3(0.0, 0.0, 0.0)))
    sys_.add_body(starpivot.Body("p", 1e-9, starpivot.Vec3(1.0, 0.0, 0.0),
                                 starpivot.Vec3(0.0, 0.0, 0.0)))
    a = starpivot.compute_acceleration(sys_.bodies, 1.0, 0.0)
    # The test particle accelerates toward the central body (-x direction).
    assert a[1].x < 0.0
    assert abs(a[1].x + 1.0) < 1e-12
