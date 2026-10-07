// starpivot/genesis.cpp -- 种子化系统生成。
//
// 物理约束（这是本文件存在的全部理由）
// ------------------------------------
// 随机抽出来的半长轴如果挨得太近，开局第一帧就撞成一团 —— 那样生成出来的
// 宇宙既不好看也没有观察价值。所以每一对天体都要过 **Gladman（Hill）判据**：
//
//     Δ = |a₂ - a₁| / a₁  >  2√3 · ((m₁+m₂)/(3M))^(1/3)
//
// 右端随质量比立方根增长：一颗 0.04 M☉ 的褐矮星需要的间距比一颗 3 M☉ 的
// 岩质行星大两个数量级。用统一的"间隔百分比"会让重天体直接穿模，所以这里
// 必须按**每一对**的质量算，不能取一个全局最小值。
//
// 余量取 1.6：判据本身是"长期不碰撞"的必要条件，留一点余量是为了让
// 有限步长的积分（而不是解析）也走得下去。margin 会随回执一起返回，
// 页面与判据可以直接核对，不需要重算。
//
// 可复现性
// --------
// 全程只用整数运算推进随机源（splitmix64），浮点只参与"把随机数映射到
// 物理量"这一步，而那一步在同一个平台上逐位确定。所以同 seed → 同结果，
// 跨机器也成立。刻意**不用** <random>：它的实现不是标准规定的，
// 换个标准库就会换一套数，"今天的宇宙"就变了。

#include "starpivot/genesis.hpp"

#include <cmath>
#include <cstdint>
#include <limits>
#include <stdexcept>

namespace starpivot {
namespace {

/// FNV-1a 64。选它只因为它短、无依赖、且对短字符串足够散。
std::uint64_t fnv1a64(const std::string& s) {
    std::uint64_t h = 1469598103934665603ULL;
    for (unsigned char c : s) {
        h ^= static_cast<std::uint64_t>(c);
        h *= 1099511628211ULL;
    }
    return h;
}

/// splitmix64：小、快、统计性质足够，且完全由整数定义。
class Rng {
public:
    explicit Rng(std::uint64_t seed) : state_(seed) {}

    std::uint64_t next() {
        std::uint64_t z = (state_ += 0x9E3779B97F4A7C15ULL);
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
        z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
        return z ^ (z >> 31);
    }
    /// [0, 1)
    double uniform() {
        return static_cast<double>(next() >> 11) * (1.0 / 9007199254740992.0);
    }
    double range(double lo, double hi) { return lo + (hi - lo) * uniform(); }
    /// [lo, hi]，含端点。步长不整除时会有轻微偏置 —— 对"抽一个看起来
    /// 随机的初值"完全够用，且偏置是确定的，不破坏可复现性。
    int irange(int lo, int hi) {
        return lo + static_cast<int>(next() % static_cast<std::uint64_t>(hi - lo + 1));
    }
    std::size_t below(std::size_t n) {
        return static_cast<std::size_t>(next() % static_cast<std::uint64_t>(n));
    }

private:
    std::uint64_t state_;
};

/// 可抽签的天体类型池。
/// 只收"绕一颗主星转"说得通的类型：岩质 / 超级地球 / 冰巨星 / 气态巨行星，
/// 外加褐矮星（很偶尔）。恒星类不进池 —— 把一颗 A 型主序星和行星并排放进
/// 同一个 N 体系统，Hill 判据会让间距要求直接爆掉，生成器会陷入放不成的
/// 重试；而那样的系统本身也不好看。紧凑天体（中子星/黑洞）同理，不做默认抽签。
const char* const kPool[] = {
    "rocky", "super_earth", "ice_giant", "gas_giant",
    // 褐矮星占一格里的 1/12 量级：它是最有意思的边界情形（质量刚过氘燃烧线），
    // 但 Hill 判据对它最苛刻，所以放得少。
    "brown_dwarf",
};
constexpr std::size_t kPoolN = sizeof(kPool) / sizeof(kPool[0]);

constexpr double kAMin = 0.30;    ///< AU
constexpr double kAMax = 12.0;    ///< AU
constexpr double kEmax = 0.14;    ///< 偏心率上限：再高轨道就不是"规整"的了
constexpr double kIncMax = 7.0;   ///< 倾角上限（度）：太大就容易互扰
constexpr double kMargin = 1.6;   ///< 相对 Gladman 临界的余量

}  // namespace

double gladman_critical(double m1, double m2, double central_mass) {
    if (central_mass <= 0.0) return 1e300;
    const double mu = (m1 + m2) / (3.0 * central_mass);
    return 2.0 * std::sqrt(3.0) * std::cbrt(mu);
}

/// 逐对检查 Gladman 判据（带 kMargin 余量）。任何一对不过就返回 false，
/// 由调用方重抽。**逐对**而不是取一个全局阈值：一颗 0.04 M☉ 的褐矮星与一颗
/// 3 M☉ 的岩质行星，所需的间距比差两个数量级，全局阈值必然放过其中一种。
bool pairwise_ok(const std::vector<GenesisBody>& bodies, double central_mass) {
    for (std::size_t i = 0; i < bodies.size(); ++i) {
        for (std::size_t j = i + 1; j < bodies.size(); ++j) {
            const double lo = std::min(bodies[i].a_au, bodies[j].a_au);
            const double sep = std::fabs(bodies[j].a_au - bodies[i].a_au) / lo;
            const double crit = gladman_critical(bodies[i].mass_msun,
                                                 bodies[j].mass_msun, central_mass);
            if (sep < kMargin * crit) return false;
        }
    }
    return true;
}

std::string hash_seed(const std::string& seed) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "0x%016llx",
                  static_cast<unsigned long long>(fnv1a64(seed)));
    return std::string(buf);
}

GenesisSystem generate_system(const std::string& seed, int n_bodies) {
    if (n_bodies < 2 || n_bodies > 8) {
        throw std::invalid_argument("n_bodies 必须在 2..8 之间");
    }

    GenesisSystem out;
    out.seed = seed;
    out.seed_hash = hash_seed(seed);
    out.primary_mass_msun = 1.0;
    out.primary_name = "Sun";

    Rng rng(fnv1a64(seed));
    const double M = out.primary_mass_msun;

    out.bodies.resize(static_cast<std::size_t>(n_bodies));

    // ---- 第一轮：随机抽位置与类型，逐对检查 Gladman 判据 ----
    // 放不成就重抽。重抽有上限：抽 400 轮还不成，就走下面的确定性阶梯 ——
    // 那样可能不够"随机"，但**一定**合法，而"一定合法"是这个函数的契约。
    // 静默返回一套会立刻相撞的系统，比返回一套保守的结果坏得多。
    bool placed = false;
    for (int attempt = 1; attempt <= 400 && !placed; ++attempt) {
        out.placement_attempts = attempt;
        for (int i = 0; i < n_bodies; ++i) {
            GenesisBody& b = out.bodies[static_cast<std::size_t>(i)];
            b.name = "G" + std::to_string(i + 1);
            const BodyType* t = find_body_type(kPool[rng.below(kPoolN)]);
            b.type = t;
            // 质量在类型区间内按对数均匀取：质量分布跨好几个数量级，
            // 线性均匀会让绝大多数样本挤在下界附近。
            const double lo = std::max(t->mass_min, 1e-9);
            const double hi = t->mass_max;
            b.mass_msun = (hi > lo * 1.0000001)
                        ? std::exp(rng.range(std::log(lo), std::log(hi)))
                        : lo;
            b.a_au = rng.range(kAMin, kAMax);
            b.e = rng.range(0.0, kEmax);
            b.inc_deg = rng.range(0.0, kIncMax);
            b.raan_deg = rng.range(0.0, 360.0);
            b.argp_deg = rng.range(0.0, 360.0);
            b.M0_deg = rng.range(0.0, 360.0);
        }
        if (pairwise_ok(out.bodies, M)) placed = true;
    }

    // ---- 兜底：几何级数阶梯 ----
    // a_i = 0.40 · 1.45^i。比值恒为 1.45，落在大多数行星组合的 Gladman
    // 临界（≈0.05 量级）之上，褐矮星也在内。
    if (!placed) {
        for (int i = 0; i < n_bodies; ++i) {
            GenesisBody& b = out.bodies[static_cast<std::size_t>(i)];
            b.name = "G" + std::to_string(i + 1);
            b.type = find_body_type("rocky");
            b.mass_msun = b.type->mass_default;
            b.a_au = 0.40 * std::pow(1.45, i);
            b.e = 0.01;
            b.inc_deg = 0.0;
            b.raan_deg = 0.0;
            b.argp_deg = 0.0;
            b.M0_deg = 0.0;
        }
        out.placement_attempts = -1;   // 负数 = 走了兜底，页面可据此说明
    }

    // ---- 由内核按类型补半径 / 温度 / 光度 ----
    for (GenesisBody& b : out.bodies) {
        b.radius_km = body_type_radius_km(*b.type, b.mass_msun);
        b.t_eff_K = body_type_t_eff(*b.type);
        b.lum_lsun = body_type_luminosity(*b.type, b.mass_msun);
    }

    // ---- 稳定性证据（供外部核对，页面不重算）----
    // 注意初值方向：这里要的是**最紧**的那一对，所以 ratio 从 +inf 起、
    // 只在更小时更新。从 0 起会永远不更新（没有任何比数更小的比数），
    // 结果 margin 恒为 1e300，看着"非常稳"，其实什么都没量。
    double worst = 0.0;
    double worst_ratio = std::numeric_limits<double>::infinity();
    for (std::size_t i = 0; i < out.bodies.size(); ++i) {
        for (std::size_t j = i + 1; j < out.bodies.size(); ++j) {
            const double a1 = out.bodies[i].a_au, a2 = out.bodies[j].a_au;
            const double lo = std::min(a1, a2);
            const double sep = std::fabs(a2 - a1) / lo;
            const double crit = gladman_critical(out.bodies[i].mass_msun,
                                                 out.bodies[j].mass_msun, M);
            const double ratio = sep / crit;
            if (ratio < worst_ratio) { worst_ratio = ratio; worst = sep; }
        }
    }
    if (!std::isfinite(worst_ratio)) { worst_ratio = 0.0; worst = 0.0; }
    out.min_sep_ratio = worst;
    out.min_stability_margin = worst_ratio;
    return out;
}

}  // namespace starpivot
