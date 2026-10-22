// starpivot — collision handling. See collision.hpp for what is modelled and,
// more importantly, what is NOT (no EOS, no tidal disruption, no hit-and-run).

#include "starpivot/collision.hpp"

#include <algorithm>
#include <cmath>
#include <string>

#include "starpivot/elements.hpp"  // total_energy

namespace starpivot {
namespace {

/// Deterministic 64-bit LCG: fragment outcomes must be reproducible, and a
/// std::mt19937 seeded the same way is fine too but this keeps the module
/// dependency-free and byte-stable across platforms.
struct Rng {
    std::uint64_t s;
    explicit Rng(std::uint64_t seed) : s(seed ? seed : 1) {}
    double uniform() {  // [0, 1)
        s = s * 6364136223846793005ull + 1442695040888963407ull;
        return static_cast<double>((s >> 11) & 0xFFFFFFFFFFFFFull) /
               static_cast<double>(1ull << 52);
    }
    double uniform_signed() { return 2.0 * uniform() - 1.0; }
};

}  // namespace

bool find_collision(const System& sys, const CollisionSetup& setup,
                    std::size_t& i, std::size_t& j, double& distance) {
    const std::size_t n = sys.size();
    if (setup.radii.size() != n) return false;
    auto excluded = [&](std::size_t k) {
        return !setup.stars_collide &&
               sys.bodies[k].mass >= setup.star_mass_threshold;
    };
    // Both bodies still inside the debris grace period -> let them separate
    // first. (One young + one old body is a real impact, keep it.)
    auto young = [&](std::size_t k) {
        return setup.immunity > 0.0 && k < setup.birth.size() &&
               (sys.time - setup.birth[k]) < setup.immunity;
    };
    for (std::size_t a = 0; a < n; ++a) {
        if (!(setup.radii[a] > 0.0)) continue;
        if (excluded(a)) continue;
        for (std::size_t b = a + 1; b < n; ++b) {
            if (!(setup.radii[b] > 0.0)) continue;
            if (excluded(b)) continue;
            if (young(a) && young(b)) continue;
            const double d = (sys.bodies[a].position - sys.bodies[b].position).norm();
            if (d <= setup.radii[a] + setup.radii[b]) {
                i = a; j = b; distance = d;
                return true;
            }
        }
    }
    return false;
}

double merged_radius(double r_i, double r_j) {
    const double v = r_i * r_i * r_i + r_j * r_j * r_j;
    return (v > 0.0) ? std::cbrt(v) : 0.0;
}

bool merge_bodies(System& sys, std::size_t i, std::size_t j,
                  CollisionEvent* ev) {
    if (i >= sys.size() || j >= sys.size() || i == j) return false;
    Body& a = sys.bodies[i];
    Body& b = sys.bodies[j];

    const double M = a.mass + b.mass;
    if (!(M > 0.0)) return false;  // two massless test particles cannot merge

    if (ev) {
        ev->kind = 0;
        ev->t = sys.time;
        ev->id_a = a.id;
        ev->id_b = b.id;
        ev->distance = (a.position - b.position).norm();
        ev->relative_speed = (a.velocity - b.velocity).norm();
        ev->mass_before = M;
        ev->mass_after = M;
        ev->energy_before = total_energy(sys);
        ev->detail = "perfect accretion (completely inelastic, sticky spheres)";
    }

    const Vec3 p = a.mass * a.velocity + b.mass * b.velocity;  // momentum
    const Vec3 r_com = (a.mass * a.position + b.mass * b.position) / M;
    a.mass = M;
    a.position = r_com;
    a.velocity = p / M;
    sys.bodies.erase(sys.bodies.begin() + static_cast<long>(j));

    if (ev) {
        ev->energy_after = total_energy(sys);
        ev->energy_delta = ev->energy_after - ev->energy_before;
    }
    return true;
}

bool fragment_body(System& sys, std::size_t i, int n, double dispersion,
                   double spread, std::uint64_t seed, CollisionEvent* ev,
                   const Vec3* spray_dir, double spray) {
    if (i >= sys.size() || n < 2) return false;
    Body parent = sys.bodies[i];
    if (!(parent.mass > 0.0)) return false;

    // 锥形喷流：只有"给了方向、且系数为正、且方向是真方向"才启用。
    // 方向长度太小（两颗正对着撞、相对速度方向的数值噪声）时退回各向同性，
    // 否则会拿一个任意方向去定向，而那是在编物理。
    Vec3 cone_axis(0.0, 0.0, 0.0);
    double cone = 0.0;
    if (spray_dir) {
        const double L = spray_dir->norm();
        if (L > 1e-12 && spray > 0.0) {
            cone_axis = *spray_dir / L;
            cone = (spray > 1.0) ? 1.0 : spray;
        }
    }

    if (ev) {
        ev->kind = 1;
        ev->t = sys.time;
        ev->id_a = parent.id;
        ev->mass_before = parent.mass;
        ev->mass_after = parent.mass;
        ev->energy_before = total_energy(sys);
        ev->fragments = n;
        ev->spray_dir = cone_axis;
        ev->spray = cone;
        ev->detail = cone > 0.0
            ? "parameterised fragmentation: equal-mass debris ring in the plane "
              "perpendicular to the impactor's approach direction, displaced "
              "downrange, with an axial-shear dispersion (momentum-conserving; "
              "not an impact physics model)"
            : "parameterised fragmentation: equal-mass debris ring, "
              "momentum-conserving dispersion (not an impact physics model)";
    }

    // Generate n dispersion kicks, then de-mean them so the total momentum of
    // the debris cloud equals the parent's momentum exactly.
    //
    // ⚠ 这里**故意不是**"把各向同性的方向往锥里压"。那是最先写的版本，实测
    // （复刻同样的采样与去均值，n=4）结果是：
    //     spray   平均|沿轴|   平均|横向|
    //      0.0      0.196      0.802
    //      0.6      0.038      0.401
    //      1.0      0.000      0.000     ← 整个踢归零，色散彻底消失
    // 因为等质量碎块的动量必须等于母体动量，去均值会把"共同的那一份"整块减掉：
    // 锥越窄，被减掉的比例越大，剩下的几乎全是**横向**的 —— 做出的是"越来越小的
    // 侧向气团"，正好与"喷流"相反。
    //
    // 真正让"溅射成束"看得见的东西是**几何**，不是速度：
    //   ① 碎屑环所在的平面垂直于撞击来向  → 迎面炸开一张"溅射盘"，一眼看出
    //      碎屑是从哪个方向被打出来的（原来环平面与来向完全无关，是随便挑的）；
    //   ② 环心沿来向平移一点             → 碎屑整体被"抛向前方"，不是原地铺开。
    //      位置不影响动量，所以这一步是免费的；
    //   ③ 速度上加一份**沿轴的剪切**（沿轴的两个方向成对抵消）→ 碎屑云在飞行中
    //      沿来向被拉长成一条"束"，而不是一个滚圆的球。
    // ①②③ 全部是模型参数（`spray` 缩放②③），不是撞击动力学；动量仍然精确守恒
    // （见下面两个 Σ 恒为 0 的构造）。
    Rng rng(seed);
    std::vector<Vec3> kick(static_cast<std::size_t>(n));
    Vec3 sum;
    // 面内两条基：spray>0 时"环面"与"面内径向"共用它们，所以在这里算一次。
    Vec3 pe1, pe2;
    if (cone > 0.0) {
        const double kPi = 3.14159265358979323846;
        // 与来向正交的一组基（任取一条与轴不平行的参考向量）
        const Vec3 ref = (std::fabs(cone_axis.x) < 0.9) ? Vec3(1, 0, 0) : Vec3(0, 1, 0);
        pe1 = cone_axis.cross(ref);
        const double n1 = pe1.norm();
        pe1 = (n1 > 1e-12) ? pe1 / n1 : Vec3(1, 0, 0);
        pe2 = cone_axis.cross(pe1);
        for (int k = 0; k < n; ++k) {
            const double ang = 2.0 * kPi * k / n;
            // 面内径向（一条从环心朝外的单位向量）：Σ_k (e1 cos + e2 sin) 恒为 0
            const Vec3 radial = pe1 * std::cos(ang) + pe2 * std::sin(ang);
            // 沿轴剪切：s_k 从 -1 线性到 +1，Σ_k s_k 恒为 0（n>=2）。
            // 系数 3 是量出来的：面内径向的单位向量**整条都在面内**，所以横向展宽
            // 就是 dispersion 本身（RMS = 1.0），而不是 1/√2。于是
            //     轴向/横向 = K · spray · RMS(s_k)，n=4 时 RMS(s_k)=0.745。
            // K=2 只给出 1.19 —— 那几乎看不出"束"；K=3 给出 1.79(spray=.8)/2.24(spray=1)。
            const double s_k = (n > 1) ? (2.0 * k / (n - 1) - 1.0) : 0.0;
            // ⚠ 这里**不乘 dispersion**：下面统一的去均值那一步会乘一次，
            // 在这里也乘就会变成 dispersion²（写第一版时真的这么错了）。
            kick[static_cast<std::size_t>(k)] =
                radial + cone_axis * (cone * 3.0 * s_k);
            sum = sum + kick[static_cast<std::size_t>(k)];
        }
    } else {
        for (int k = 0; k < n; ++k) {
            // Uniform on the sphere by rejection (cheap, n is small).
            double x, y, z, r2;
            do {
                x = rng.uniform_signed(); y = rng.uniform_signed(); z = rng.uniform_signed();
                r2 = x * x + y * y + z * z;
            } while (r2 > 1.0 || r2 < 1e-12);
            const double inv = 1.0 / std::sqrt(r2);
            kick[static_cast<std::size_t>(k)] = Vec3(x, y, z) * inv;
            sum = sum + kick[static_cast<std::size_t>(k)];
        }
    }
    const Vec3 mean = sum / static_cast<double>(n);
    for (int k = 0; k < n; ++k)
        kick[static_cast<std::size_t>(k)] =
            (kick[static_cast<std::size_t>(k)] - mean) * dispersion;

    // 碎块环的半径：必须让相邻两块"生下来就是分开的"。
    // 参数化碎屑模型把 n 块放在半径 spread 的环上，每块半径 piece_r = spread/cbrt(n)，
    // 相邻两块间距 = 2*ring*sin(pi/n)。相切条件是间距 == 2*piece_r，而碰撞判定用的是
    // `d <= r_a + r_b`（相切也算撞上），所以 ring 必须**严格大于** piece_r/sin(pi/n)。
    //
    // 不这么做会怎样（实测）：色散速度为 0 时（用户把滑杆拖到 0 是合法的），
    // n>=6 的碎块彼此出生即重叠 → 下一步立刻判成相撞 → 再碎 → 再撞，
    // 3 年里滚出 14672 次碰撞、14735 行登记、跑 165 秒。免疫期救不了它：
    // 免疫期只把重撞推迟，到期后仍然重叠。真正的解法是让它们出生时不重叠。
    //
    // 代价要说清楚：这是**几何**上的让步，不是物理。n 越大碎屑环被撑得越开
    // （相对"母体半径"而言），所以它依旧只是参数化模型，不是撞击动力学。
    // 换来的是：--fragments 从 4 调到 12 不再改变"碎完会不会立刻二次碰撞"这件事。
    const double piece_r = spread / std::cbrt(static_cast<double>(n));
    const double touching = piece_r / std::sin(3.14159265358979323846 / n);
    // 1.02 = 留一点余量：相切恰好等于判定阈值，数值上差一点点就会判成撞上。
    const double ring = (spread > touching * 1.02) ? spread : touching * 1.02;
    if (ev) ev->ring_radius = ring;

    std::vector<Body> pieces;
    pieces.reserve(static_cast<std::size_t>(n));
    const double m = parent.mass / static_cast<double>(n);
    // Debris-of-debris would otherwise grow names like "A#1#4#1#2#..." forever.
    const std::string base = (parent.id.size() >= 18)
        ? ("D" + std::to_string(seed % 100000)) : parent.id;
    if (cone > 0.0) {
        // 定向溅射：环面**垂直于来向**（从撞击点的视角看是一张"溅射盘"，
        // 一眼能看出碎屑是朝哪边被打出来的），环心再沿来向平移一点，
        // 于是碎屑整体被"抛向前方"而不是原地铺开。
        // 平移量对**所有**碎块相同，所以两两间距与原来完全一样 —— "出生即不重叠"
        // 那条几何保证原封不动。位置也不进动量，所以这一步不影响任何守恒量。
        const Vec3 w = cone_axis;
        const Vec3 centre = parent.position +
                            w * (ring * 0.35 * cone);   // 0.35 = 模型系数
        for (int k = 0; k < n; ++k) {
            const double ang = 2.0 * 3.14159265358979323846 * k / n;
            const Vec3 off = pe1 * (ring * std::cos(ang)) + pe2 * (ring * std::sin(ang));
            pieces.emplace_back(base + "#" + std::to_string(k + 1), m,
                                centre + off,
                                parent.velocity + kick[static_cast<std::size_t>(k)]);
        }
    } else {
        // spray = 0：保持原来的确定性平面，逐位不变（库的默认行为，单测钉的就是它）。
        const Vec3 axis = (std::fabs(parent.position.x) > 1e-12 ||
                           std::fabs(parent.position.y) > 1e-12)
                              ? Vec3(0, 0, 1) : Vec3(0, 1, 0);
        Vec3 u = axis.cross(parent.position);
        if (u.norm() < 1e-12) u = Vec3(1, 0, 0);
        u = u * (1.0 / u.norm());
        const Vec3 w = axis * 1.0;
        for (int k = 0; k < n; ++k) {
            const double ang = 2.0 * 3.14159265358979323846 * k / n;
            const Vec3 off = u * (ring * std::cos(ang)) + w * (ring * std::sin(ang));
            pieces.emplace_back(base + "#" + std::to_string(k + 1), m,
                                parent.position + off,
                                parent.velocity + kick[static_cast<std::size_t>(k)]);
        }
    }

    sys.bodies.erase(sys.bodies.begin() + static_cast<long>(i));
    sys.bodies.insert(sys.bodies.end(), pieces.begin(), pieces.end());

    if (ev) {
        ev->energy_after = total_energy(sys);
        ev->energy_delta = ev->energy_after - ev->energy_before;
    }
    return true;
}

double known_radius_km(const std::string& name, bool* ok) {
    static const struct { const char* k; double r; } kTable[] = {
        {"Sun", 696340.0},   {"Mercury", 2439.7}, {"Venus", 6051.8},
        {"Earth", 6371.0},   {"Mars", 3389.5},    {"Jupiter", 69911.0},
        {"Saturn", 58232.0}, {"Uranus", 25362.0}, {"Neptune", 24622.0},
        {"Pluto", 1188.3},
    };
    for (const auto& e : kTable) {
        if (name == e.k) { if (ok) *ok = true; return e.r; }
    }
    if (ok) *ok = false;
    return 0.0;
}

}  // namespace starpivot
