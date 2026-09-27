// starpivot — collision handling for N-body systems: detection, perfect
// accretion (merge) and collisional fragmentation (debris generation).
//
// Why this exists
// ---------------
// "Add bodies and watch them collide" is the natural next question once a user
// can add planets. Real planetary accretion is a research field (it needs an
// equation of state, impact-angle statistics, tidal disruption criteria, and
// a rubble-pile model). What this module provides is the *conservative
// skeleton* every such model is built on, stated honestly:
//
//   * detection      -- geometric: spheres of radius r_i, r_j overlap.
//   * merge          -- perfect (completely inelastic) accretion: mass adds,
//                      momentum is conserved exactly, kinetic energy is LOST.
//                      Nothing is invented; this is the textbook sticky-sphere
//                      limit and it is what the unit tests gate on.
//   * fragmentation  -- parameterised: the impactor pair merges and the
//                      survivor breaks into N equal-mass pieces on a ring of
//                      the parent's radius, each getting the parent velocity
//                      plus a dispersion kick. Mass and momentum are conserved
//                      exactly; the dispersion speed is a *model parameter*
//                      (not a derived physical quantity).
//                      The GEOMETRY of the debris cloud is a second model
//                      parameter: with `spray = 0` the ring plane is arbitrary
//                      and the kicks are isotropic (a symmetric puff that
//                      expands in place); with `spray > 0` the ring plane is
//                      perpendicular to the impactor's approach direction, the
//                      ring centre is displaced downrange, and the kicks carry
//                      an axial shear, so the debris leaves as a directed
//                      splash that stretches into a streak along the impact
//                      axis. The scaling is a *stated* parameter, not a
//                      cratering law.
//                      NOTE: biasing merely the KICK DIRECTIONS into a cone
//                      does NOT work and was measured to do the opposite —
//                      because the kicks are de-meaned to conserve momentum
//                      exactly, narrowing a cone subtracts more of the common
//                      part, leaving the transverse part dominant (at spray=1
//                      every kick collapses to zero and the dispersion
//                      disappears). The directed look therefore has to come
//                      from geometry, not from the velocity distribution.
//
// What is explicitly NOT claimed: no equation of state, no cratering or
// ejecta mass law, no tidal (Roche) disruption, no strength regime, no
// hit-and-run outcomes. The CLI and the viewer say so in their notes.
//
// Units: everything follows the System (AU / Msun / yr for the nbody surface;
// G=1, m=1 for figure-8). Radii are in the same length unit as positions;
// the table below is published in km and converted by the caller.

#ifndef STARPIVOT_COLLISION_HPP
#define STARPIVOT_COLLISION_HPP

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "starpivot/system.hpp"

namespace starpivot {

enum class CollisionMode {
    kOff = 0,       // bodies pass through each other (point masses)
    kMerge = 1,     // perfect accretion: sticky spheres
    kFragment = 2,  // impact -> merge -> break into N debris pieces
};

/// One recorded event. Energies are the *total system* energy computed with
/// the same function the integrator diagnostics use, so the loss/gain is
/// checkable rather than asserted.
struct CollisionEvent {
    int kind = 0;            // 0 = merge, 1 = fragment
    double t = 0.0;          // simulation time (System::time unit, years for nbody)
    std::string id_a, id_b;  // participants (for fragment: id_b = "")
    double distance = 0.0;   // separation at detection [length unit]
    double relative_speed = 0.0;
    double mass_before = 0.0;
    double mass_after = 0.0;
    double energy_before = 0.0;
    double energy_after = 0.0;
    double energy_delta = 0.0;  // after - before (merge: negative; fragment: >= 0)
    int fragments = 0;          // number of pieces created (fragment only)
    /// Radius of the debris ring actually used, i.e. AFTER the no-self-overlap
    /// enlargement inside fragment_body(). Reported rather than assumed: the
    /// caller needs it to size the immunity period (it is no longer the same
    /// number it passed in), and a probe can check the ring really is wide
    /// enough for the pieces not to touch. 0 for merge events.
    double ring_radius = 0.0;
    /// Direction of the debris jet, in the same frame as the positions: the
    /// unit vector along which the impactor was closing on the parent at the
    /// moment of contact (v_impactor - v_parent). Zero vector for merge events
    /// and for isotropic fragmentation (spray = 0) -- it is echoed so a caller
    /// can show what was actually used instead of re-deriving it.
    Vec3 spray_dir;
    /// Cone bias actually applied, 0 (isotropic) .. 1 (straight down the axis).
    /// A model parameter, reported rather than assumed.
    double spray = 0.0;
    std::string detail;
};

/// Configuration. `radii` is per body, aligned with sys.bodies at the time of
/// the call (the caller keeps it in sync after every event).
struct CollisionSetup {
    CollisionMode mode = CollisionMode::kOff;
    std::vector<double> radii;   // per body, length unit of the system
    int fragments = 4;           // pieces created per fragment event
    double dispersion = 0.0;     // fragment kick speed [length/time unit]
    double spread = 0.0;         // fragment ring radius [length unit]
    std::uint64_t seed = 20240925;  // deterministic RNG (reproducibility)

    // Modelling switch, OFF by default and reported in the output: bodies above
    // `star_mass_threshold` (the star) are treated as a background gravity
    // source and are excluded from collision detection. Real radii are tiny,
    // so demos inflate them by 1e2-1e5; without this switch a 3000x Sun
    // (~14 AU) would swallow the inner planets and no planet-planet collision
    // could ever be seen. Physics note: a star DOES swallow things — this is a
    // usability switch, stated in the CLI note, not a physical claim.
    bool stars_collide = false;
    double star_mass_threshold = 0.05;  // Msun

    // Debris immunity. Freshly created fragments start inside each other's
    // (inflated) radius, so without a grace period they immediately re-collide,
    // re-fragment, and the system explodes in an endless cascade. Two bodies
    // are ignored as a PAIR while both are younger than `immunity`.
    //   `birth[k]` = creation time of body k (0 for the original bodies)
    //   typical setting: immunity = debris_ring_radius / dispersion_speed
    std::vector<double> birth;   // aligned with sys.bodies, time units
    double immunity = 0.0;

    /// Relative speed above which an impact fragments instead of just
    /// accreting, in [length/time]. This is the classic accretion-vs-
    /// fragmentation regime split: slow collisions accrete, fast ones shatter.
    /// Without it, fragment mode re-shatters the debris on every re-collision
    /// and the system turns into an endless debris fountain.
    /// 0 = always fragment (every collision shatters).
    double fragment_min_speed = 0.0;

    /// Hard cap on the **live** body count: fragmentation is skipped (leaving a
    /// plain merge) once the system reaches it, so a debris cascade can never
    /// make the O(N^2) step unbounded.
    /// Note this does NOT bound the output size: a caller that keeps a registry
    /// of every body ever created (starpivot_cli does — rows are only marked
    /// dead, never removed) must cap that too, or a cascade will still grow the
    /// per-frame arrays without limit. Measured once: 64 live bodies but 14735
    /// registry rows, 165 s and unrenderable frames.
    int max_bodies = 64;

    /// Debris-splash scaling handed to fragment_body (0 = the original
    /// isotropic puff in an arbitrary plane; > 0 = ring plane perpendicular to
    /// the impactor's approach direction + downrange displacement + axial
    /// shear). A model parameter; echoed per event as `spray` + `spray_axis`.
    double spray = 0.0;
};

/// Find the first overlapping pair (|r_i - r_j| <= r_i + r_j). Bodies with
/// non-positive radius are treated as point masses and never collide.
/// Returns false when nothing overlaps.
bool find_collision(const System& sys, const CollisionSetup& setup,
                    std::size_t& i, std::size_t& j, double& distance);

/// Perfect accretion: merge body j into body i.
///   M = m_i + m_j,  r = (m_i r_i + m_j r_j)/M,  v = (m_i v_i + m_j v_j)/M
/// Mass and momentum are conserved to round-off; kinetic energy decreases.
/// Body j is removed. Radii are NOT resized here — the caller must call
/// `merge_radius` (below) or maintain its own list.
bool merge_bodies(System& sys, std::size_t i, std::size_t j,
                  CollisionEvent* ev = nullptr);

/// Radius of the merged sphere: equal-density addition, r = (r_i^3 + r_j^3)^(1/3).
/// (Mass adds, so volume adds — this keeps bulk density invariant.)
double merged_radius(double r_i, double r_j);

/// Break body i into `n` equal-mass pieces placed on a ring of radius `spread`
/// around the parent position. Momentum is conserved exactly (the dispersion
/// kicks are generated then de-meaned); kinetic energy increases by the
/// dispersion term. Body i is replaced by the pieces and the system gains
/// n-1 bodies. Deterministic for a given seed.
///
/// `spray_dir` / `spray` orient the debris into a directed splash:
///   spray <= 0 or spray_dir == nullptr -> the original behaviour, bit for bit
///                                         (arbitrary ring plane, isotropic
///                                         de-meaned kicks)
///   spray  > 0                          -> ring plane perpendicular to
///                                         `spray_dir`, ring centre displaced
///                                         downrange by 0.35*ring*spray, and
///                                         an axial shear `±spray` on the kicks
/// Both the in-plane radial kicks and the axial shear are constructed to sum to
/// exactly zero over the pieces, so total momentum is the parent's to round-off
/// with or without the de-meaning pass. The downrange displacement is applied
/// equally to every piece, so the no-self-overlap geometry is unchanged.
bool fragment_body(System& sys, std::size_t i, int n, double dispersion,
                   double spread, std::uint64_t seed,
                   CollisionEvent* ev = nullptr,
                   const Vec3* spray_dir = nullptr, double spray = 0.0);

/// Physical radius [km] for the bodies the nbody surface knows by name
/// (Sun + planets + Pluto). Returns 0 with *ok=false when unknown.
double known_radius_km(const std::string& name, bool* ok = nullptr);

}  // namespace starpivot

#endif  // STARPIVOT_COLLISION_HPP
