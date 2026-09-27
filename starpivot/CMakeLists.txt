cmake_minimum_required(VERSION 3.20)

project(starpivot
        VERSION 1.0.0
        DESCRIPTION "Planetary dynamics kernel: N-body gravity, Hermite and symplectic integrators"
        LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

option(STARPIVOT_BUILD_TESTS  "Build the physics verification test suite" ON)
option(STARPIVOT_BUILD_PYTHON "Build the pybind11 bindings (requires pybind11)" OFF)
option(STARPIVOT_ENABLE_NATIVE "Enable -march=native (do NOT enable for release binaries)" OFF)

# ---------------------------------------------------------------------------
# The kernel. Standard library only: no Eigen, no GSL, no BLAS.
# Produces libstarpivot-physics.a (GNU/Clang) or starpivot-physics.lib (MSVC).
# ---------------------------------------------------------------------------
add_library(starpivot-physics STATIC
  src/gravity.cpp
  src/hermite.cpp
  src/leapfrog.cpp
  src/elements.cpp
  src/spin.cpp
  src/time.cpp
  src/perturb.cpp
  src/sgp4.cpp
  src/conjunction.cpp
  src/groundtrack.cpp
  src/collision.cpp
  src/bodyprops.cpp
  src/bio.cpp
)

target_include_directories(starpivot-physics
  PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
         $<INSTALL_INTERFACE:include>
)

set_target_properties(starpivot-physics PROPERTIES
  OUTPUT_NAME starpivot-physics
  POSITION_INDEPENDENT_CODE ON
)

if(STARPIVOT_ENABLE_NATIVE)
  target_compile_options(starpivot-physics PRIVATE -march=native)
endif()

if(MSVC)
  target_compile_options(starpivot-physics PRIVATE /O2 /fp:precise)
else()
  # -ffp-contract=off keeps the compiler from fusing a*b+c into FMA, which would
  # make results differ between optimisation levels and break bit-reproducibility.
  target_compile_options(starpivot-physics PRIVATE -O2 -ffp-contract=off)
endif()

# ---------------------------------------------------------------------------
# Physics verification suite (GoogleTest >= 1.12)
# ---------------------------------------------------------------------------
if(STARPIVOT_BUILD_TESTS)
  enable_testing()

  include(FetchContent)
  FetchContent_Declare(
    googletest
    GIT_REPOSITORY https://github.com/google/googletest.git
    GIT_TAG        v1.14.0          # >= 1.12 as required
  )
  # Keep Windows runtime consistent with the kernel.
  set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
  FetchContent_MakeAvailable(googletest)

  add_executable(starpivot-tests
    tests/test_gravity_consistency.cpp
    tests/test_two_body.cpp
    tests/test_energy_conservation.cpp
    tests/test_figure8.cpp
    tests/test_lagrange.cpp
    tests/test_spin.cpp
    tests/test_perturb.cpp
    tests/test_sgp4.cpp
    tests/test_conjunction.cpp
    tests/test_groundtrack.cpp
    tests/test_collision.cpp
    tests/test_bodyprops.cpp
    tests/test_bio.cpp
  )

  target_link_libraries(starpivot-tests
    PRIVATE starpivot-physics GTest::gtest GTest::gtest_main
  )

  include(GoogleTest)
  gtest_discover_tests(starpivot-tests)
endif()

# ---------------------------------------------------------------------------
# Command line interface. This is the product surface: everything a user can
# do with the kernel without writing C++.
# ---------------------------------------------------------------------------
add_executable(starpivot
  tools/starpivot_cli.cpp
)
target_link_libraries(starpivot PRIVATE starpivot-physics)
if(MSVC)
  target_compile_options(starpivot PRIVATE /O2 /fp:precise)
else()
  target_compile_options(starpivot PRIVATE -O2 -ffp-contract=off)
endif()

install(TARGETS starpivot RUNTIME DESTINATION bin)

# ---------------------------------------------------------------------------
# Python bindings. Python is a consumer of the kernel, never the kernel itself.
# ---------------------------------------------------------------------------
if(STARPIVOT_BUILD_PYTHON)
  find_package(Python COMPONENTS Interpreter Development REQUIRED)
  find_package(pybind11 REQUIRED)

  pybind11_add_module(starpivot_native bindings/python/starpivot_bindings.cpp)
  target_link_libraries(starpivot_native PRIVATE starpivot-physics)
endif()
