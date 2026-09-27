// starpivot/src/bio.cpp -- 演化阶梯的气候驱动层。
//
// 物理侧几个公式全部可在教材里逐条核对；编排侧的参数集中在几个常量里，
// 方便读者一眼看出"哪些是真的、哪些是我编的"。常量以 bio.hpp 的 constexpr
// 为准，这里不再抄第二遍。

#include "starpivot/bio.hpp"

#include <cmath>

namespace starpivot {

double stellar_luminosity(double mass_msun) {
    // 主序带 L ∝ M^3.5。区间外是外推，调用方有责任知道（见 bio.hpp 注释）。
    if (!(mass_msun > 0.0)) return 0.0;
    const double l = std::pow(mass_msun, 3.5);
    return std::isfinite(l) ? l : 0.0;
}

double insolation_at(double r_AU, double luminosity_Lsun) {
    // 0 质量 / 0 半径 / 落在光源正上方都是合法输入，一律返回 0 ——
    // NaN 或 inf 会顺着 JSON 静默污染整个页面。
    if (!(r_AU > 0.0) || !(luminosity_Lsun > 0.0)) return 0.0;
    const double s = luminosity_Lsun / (r_AU * r_AU);
    if (!(s > 0.0) || !std::isfinite(s)) return 0.0;
    return s;
}

double equilibrium_temp_k(double insolation_S, double albedo) {
    // T_eq = 278.6 · ((1 − A)·S)^(1/4)   —— 注意是乘 S，不是除 S。
    //
    // 推导（值得写下来，因为写成除法时地球处照样对，错误会一路潜伏）：
    //   T_eq = [flux·(1-A) / (4σ)]^(1/4),  flux = L / 4πd²
    // 把 L 用 L☉ 归一、d 用 AU 归一，1 AU 处的系数是
    //   [L☉ / (16πσ·AU²)]^(1/4) = 278.33 K   （用 L☉ = 3.828e26 W）
    // 等价形式 T_sun·sqrt(R_sun / 2d)：5778 K 时给 278.62，5772 K 时给 278.33。
    // 取 278.6 就是取了 T_sun = 5778 K 那一支，与文献里常见的 278.5/278.6 一致；
    // 与 278.33 的差别是 0.1%（_probe_bio.py 里量化过），不掩盖。
    //
    // S=1、A=0.306 时给出 254.3 K，与教科书"地球平衡温度 ≈ 255 K"吻合。
    //
    // 写成除法会得到 T_eq ∝ r^(1/2)——越远越热。S=1 既是不动点也是除法的单位元，
    // 所以锚点校验抓不到它：4 AU 处乘法给 127 K、除法给 509 K。
    // 回归判据是 test_bio.cpp 的 ColderFartherFromTheStar。
    if (!(insolation_S > 0.0)) return 0.0;
    const double a = (albedo > 0.0) ? albedo : kDefaultAlbedo;
    if (!(a < 1.0)) return 0.0;                 // albedo >= 1 会给出负值/无意义
    const double f = (1.0 - a) * insolation_S;
    if (!(f > 0.0) || !std::isfinite(f)) return 0.0;
    const double t = kTeqCoeff_K * std::pow(f, 0.25);
    return std::isfinite(t) ? t : 0.0;
}

double surface_temp_k(double t_eq_K, double greenhouse_K) {
    // 加温室增温。t_eq = 0 表示"没有辐照度"（恒星自己、或零质量光源），
    // 这种退化输入不能再往上加 33 K —— 否则一个没有光照的天体会凭空得到
    // 一个地表温度，页面就会显示"地表 33 K、演化中"。保持 0 才是诚实的。
    if (!(t_eq_K > 0.0)) return 0.0;
    const double g = (greenhouse_K > 0.0) ? greenhouse_K : 0.0;
    const double t = t_eq_K + g;
    return std::isfinite(t) ? t : 0.0;
}

bool liquid_water_possible(double t_surf_K) {
    // 唯一的硬判据。冰点与沸点都是水的物性常数，不是编排出来的刻度。
    return t_surf_K > kFreezing_K && t_surf_K < kSterilization_K;
}

double bio_rate_per_year(double t_surf_K, double full_ladder_years) {
    if (!(full_ladder_years > 0.0)) return 0.0;
    if (!(t_surf_K > 0.0)) return 0.0;
    const double d = (t_surf_K - kRatePeak_K) / kRateSigma_K;
    const double g = std::exp(-d * d);
    if (!(g > 0.0) || !std::isfinite(g)) return 0.0;
    return g / full_ladder_years;
}

void step_bio(BioState& s, double r_AU, double luminosity_Lsun, double dt_years,
              const BioParams& p, double t_now) {
    step_bio_S(s, insolation_at(r_AU, luminosity_Lsun), dt_years, p, t_now);
}

void step_bio_S(BioState& s, double insolation_S, double dt_years,
                const BioParams& p, double t_now) {
    // 无论推进是否发生，三个温度都要写回：页面在停滞/灭菌时也要显示"为什么不动"。
    const double S = insolation_S;
    const double T_eq = equilibrium_temp_k(S, p.albedo);
    const double T_surf = surface_temp_k(T_eq, p.greenhouse_K);
    s.insolation = S;
    s.t_eq_K = T_eq;
    s.t_surf_K = T_surf;
    if (!(dt_years > 0.0) || !std::isfinite(t_now)) return;

    // 沸点：液态水被蒸干，进度归零。生物学上的 restart，不是"暂停"。
    if (T_surf >= kSterilization_K) {
        if (s.progress > 0.0) {
            s.progress = 0.0;
            s.stage = 0;
            s.t_stage = t_now;
        }
        return;
    }
    // 冰点：冻住。冻住不等于倒退 —— 一颗被抛到远日点的行星再回来，
    // 已经长出来的东西不会消失。
    if (!(T_surf > kFreezing_K)) return;

    const double rate = bio_rate_per_year(T_surf, p.full_ladder_years);
    if (!(rate > 0.0)) return;

    const double p_before = s.progress;
    double p_after = p_before + rate * dt_years;
    if (p_after >= 1.0) p_after = 1.0;         // 钳到 1，绝不溢出
    if (p_after <= p_before) return;
    s.progress = p_after;

    const int raw = static_cast<int>(p_after * kBioStageCount);
    const int target = (raw > kBioStageCount - 1) ? kBioStageCount - 1 : raw;
    if (target <= s.stage) return;
    // 到达时刻：线性穿过第 target 级门槛，把时刻定位到帧内而不是整帧归到 t_now。
    // 帧内匀速是假设，但比"整帧归到 t_now"精度高一个量级，代价只是一次除法。
    const double denom = p_after - p_before;
    double frac = 1.0;
    if (denom > 0.0) {
        frac = (static_cast<double>(target) / kBioStageCount - p_before) / denom;
        if (!(frac > 0.0)) frac = 0.0;
        else if (frac > 1.0) frac = 1.0;
    }
    s.t_stage = t_now - dt_years * (1.0 - frac);
    s.stage = target;
}

const char* bio_stage_name(int stage) {
    switch (stage) {
        case 0: return "死寂岩石";
        case 1: return "有机分子累积";
        case 2: return "原核生命";
        case 3: return "光合作用";
        case 4: return "大气富氧";
        case 5: return "真核 / 多细胞";
        case 6: return "动物群";
        case 7: return "智慧";
        case 8: return "工业文明";
        default: return "未知";
    }
}

}  // namespace starpivot
