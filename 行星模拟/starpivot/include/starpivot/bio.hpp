// starpivot/bio.hpp -- 星体生物演化的气候驱动层。

#ifndef STARPIVOT_BIO_HPP
#define STARPIVOT_BIO_HPP

#include <cstddef>

namespace starpivot {

// ---------------------------------------------------------------------------
// 分层口径（重要，页面必须照抄这条分层）：
//
//   第 1 层  物理，真公式：
//            辐照度   S = (L/Lsun) / r²                    （r 以 AU 计）
//            恒星光度 L/Lsun = M^3.5                        （主序带经验关系）
//            平衡温度 T_eq = 278.6 · ((1 − A)·S)^(1/4)      （A = bond albedo）
//            近地表温 T_surf = T_eq + ΔT，ΔT = 33 K          （地球实测温室）
//            「水能否以液态存在」= 273 K < T_surf < 373 K —— 冰点与沸点，
//            这两个阈值有物理出处，不是编排
//   第 2 层  编排，不是生物学：
//            9 级阶梯、每级进度、以及"多快能长到下一级"（速率形状与 paces 旋钮）。
//            真实生物学没有可用公式，所以这一层只能编排，页面必须标注。
//
// 驱动第 2 层的是第 1 层算出来的 T_surf，所以"每个星体根据自己的位置演化"
// 这句话在物理侧是成立的；被编排的只是盒子的刻度，不是盒子里装的东西。
//
// 几个必须一起说明、不能只报数字的地方：
//
//   * 三项都是"乘"的关系（T_eq ∝ S^(1/4) ∝ 1/√r）。写成 T_eq ∝ ((1−A)/S)^(1/4)
//     是错的，而 S = 1 处两种写法给出同一个值，所以只测地球抓不到它 ——
//     回归判据是 tests/test_bio.cpp 的 ColderFartherFromTheStar。
//   * ΔT = 33 K 是地球实测的温室增温，当常数用。它不是定律，是把"大气"这个
//     模型外的东西折进来的经验补偿。没有它这个模型会说地球（T_eq 254 K）
//     低于冰点、不可能有液态水 —— 那是真的，也正是大气在做的事。
//     代价：金星会被严重低估（本模型 T_surf ≈ 332 K，真实地表 737 K，那是
//     失控温室）。这个模型只回答"如果大气只像地球这样会怎样"。
//   * 恒星光度用 M^3.5 是主序带经验关系，只在约 0.43~2 M☉ 内可靠，区间外是外推。
//   * 系数取 278.6（对应 T_sun = 5778 K）；用 5772 K 得 278.33，差 0.1%。
//     地球锚点因此是 T_eq ≈ 254.3 K，不是 254.6 K。
//   * "谁在照亮谁" = **所有发光天体的辐照度之和** S = Σ_j L_j / r_j²。
//     第一版只取质量最大者当唯一光源，那在"天体可以声明类型"之后就不成立了：
//     一颗 10 M☉ 的黑洞比太阳重十倍，却一个光子都不发；双星则是两盏灯一起照。
//     哪些天体发光由 bodytype.hpp 的类型表决定（没声明类型时按氢燃烧下限 0.08 M☉ 兜底）。
//     figure8 那种等质量三体因此也有定义：三颗星互相照，S 是三项之和。
// ---------------------------------------------------------------------------

/// 编排的演化阶梯（0 = 死寂岩石，8 = 工业文明）。
enum class BioStage {
    kBarren = 0,          ///< 死寂岩石
    kOrganic = 1,         ///< 有机分子累积
    kMicrobial = 2,       ///< 原核生命
    kPhotosynthesis = 3,  ///< 光合作用
    kOxygen = 4,          ///< 大气富氧
    kMulticellular = 5,   ///< 真核 / 多细胞
    kFauna = 6,           ///< 动物群
    kIntelligence = 7,    ///< 智慧
    kIndustrial = 8,      ///< 工业文明
};

constexpr int kBioStageCount = 9;

// ---- 第 1 层：有物理出处的阈值与常数 ----

/// 水的冰点（1 atm）。T_surf 低于此值，液态水不存在，演化停滞。
constexpr double kFreezing_K = 273.0;
/// 水的沸点（1 atm）。T_surf 达到此值，液态水被蒸干，演化进度归零。
constexpr double kSterilization_K = 373.0;
/// 地球实测的温室增温 (K)：地表 288 K 而 T_eq 254 K，差 33 K。
constexpr double kGreenhouseDeltaT_K = 33.0;
/// bond albedo 默认值：地球 0.306。
constexpr double kDefaultAlbedo = 0.306;
/// T_eq = 278.6 · (...)^(1/4) 的系数（T_sun = 5778 K 那一支）。
constexpr double kTeqCoeff_K = 278.6;

// ---- 第 2 层：编排的旋钮（内核算、JSON 回显、单测三处共用这一份，抄两份会走散）----

/// 演化速率的高斯峰位置：地球地表温度 288 K。这是经验上的最优点，不是定律。
constexpr double kRatePeak_K = 288.0;
/// 高斯半宽 (K)。偏离最优点越远越慢，且是**平滑**的 —— 不要在这里再造一个
/// 硬阈值，硬阈值只留给冰点与沸点（那两个有物理出处）。
constexpr double kRateSigma_K = 28.0;

/// 一层天体的演化状态。stage / t_stage 是 progress 的派生量，缓存下来省一次除法。
struct BioState {
    double progress = 0.0;   ///< 阶梯进度 [0,1]
    double t_eq_K = 0.0;     ///< 平衡温度 (K)，不含温室
    double t_surf_K = 0.0;   ///< 近地表温度 (K) = T_eq + ΔT，与冰点/沸点比较用这个
    double insolation = 0.0; ///< 辐照度（地球 = 1）
    double t_stage = 0.0;    ///< 达到当前 stage 的时刻（年）
    int stage = 0;           ///< 0..8
};

/// 演化模型的参数。集中在一处，是为了让"哪些是物理、哪些是旋钮"一眼可见。
struct BioParams {
    double albedo = kDefaultAlbedo;              ///< bond albedo（物理输入）
    double greenhouse_K = kGreenhouseDeltaT_K;   ///< 温室增温（经验常数，可调）
    /// 走完全条 9 级阶梯所需的"可居年"（编排旋钮）。
    /// 默认 100 让页面默认的 50 年积分刚好走到阶梯中段 —— 动画里能看到推进，
    /// 而不是一开场就顶格或一动不动。
    double full_ladder_years = 100.0;
};

/// 主序带质量-光度关系 L/Lsun = M^3.5。质量 <= 0 返回 0，绝不产生 inf/NaN。
double stellar_luminosity(double mass_msun);

/// 辐照度（地球 = 1）：S = (L/Lsun) / r²。r <= 0 或 L <= 0 返回 0。
double insolation_at(double r_AU, double luminosity_Lsun);

/// 平衡温度 (K)：T_eq = 278.6 · ((1 − A)·S)^(1/4)。S <= 0 返回 0。
/// 注意这是**平衡**温度，不含温室效应 —— 地球表面 288 K 而 T_eq 只有 254 K。
double equilibrium_temp_k(double insolation_S, double albedo);

/// 近地表温度 (K) = T_eq + greenhouse。这才是能和冰点/沸点比较的量。
double surface_temp_k(double t_eq_K, double greenhouse_K);

/// 液态水是否可能存在：冰点 < T_surf < 沸点。这是唯一的硬判据，两个阈值都有出处。
bool liquid_water_possible(double t_surf_K);

/// 演化速率（进度 / 年）：以 T_surf = 288 K（地球）为峰值向两侧高斯衰减，
/// 半宽 σ = 28 K。smooth —— 冰点与沸点之外不再有第二个硬门槛。
/// full_ladder_years 是"理想条件下走完整条 9 级阶梯所需的可居年"。
/// 这是编排层的旋钮，不是地质年代 —— 真实演化以 Myr~Gyr 计。
double bio_rate_per_year(double t_surf_K, double full_ladder_years);

/// 推进演化一步。会就地更新 s.insolation / s.t_eq_K / s.t_surf_K /
/// s.progress / s.stage / s.t_stage。
/// 高于沸点：progress 归零（灭菌，生物学上的 restart）。
/// 低于冰点：停滞，进度**不回退**（冻住不等于倒退）。
/// t_now 是本次推进对应的时刻（年），用来写 s.t_stage —— 内核持有时间轴，
/// 不把"何时到达"留给页面去猜。跨级时刻按帧内线性插值定位，不是整帧归到 t_now。
void step_bio(BioState& s, double r_AU, double luminosity_Lsun, double dt_years,
              const BioParams& p, double t_now);

/// 同 step_bio，但辐照度由调用方直接给。
/// 为什么需要这个入口：一个天体可能同时被**多个**光源照（双星、三星、
/// 或者边上还有一颗红矮星），这时 S 是各光源贡献之和 Σ L_j / r_j²，
/// 单光源的 r/L 形式表达不了。step_bio 就是 r_AU/L 算完 S 再调它。
void step_bio_S(BioState& s, double insolation_S, double dt_years,
                const BioParams& p, double t_now);

/// 阶梯名称（页面图例直接用，不要自己抄一份）。
const char* bio_stage_name(int stage);

}  // namespace starpivot

#endif  // STARPIVOT_BIO_HPP
