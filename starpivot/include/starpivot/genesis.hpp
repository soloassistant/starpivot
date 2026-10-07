// starpivot/genesis.hpp -- 由一个种子字符串生成一套物理上合法的天体系统。
//
// 为什么必须在核心里
// ----------------
// 「随机生成一个星系」听起来像随机数，但**随机数是页面算不出来的那个数**。
// 本项目的硬规矩是页面上出现的每一个数都来自内核回显；一旦让页面抽签生成
// 半长轴与偏心率，这条规矩就破了 —— 而且是那种用户看不出来的破：
// 页面照样能画，判据里"页面不算物理"那条却再也拦不住任何东西。
// 所以随机源、类型抽签、Hill 稳定性检查全在 C++ 里，页面只负责把回执
// 塞进既有的 nbody payload。
//
// 可复现是硬性质
// --------------
// 同一个 seed 字符串必须**逐位**复现同一套系统（不是"差不多"）。这让
// 「今天的宇宙」可以被分享、被比拼、被判据比对。实现上 seed 先经
// FNV-1a 64 哈希，再用 splitmix64 推进 —— 两个都是纯整数运算，
// 跨平台跨编译器逐位一致，不依赖浮点或 <random> 的实现细节。

#ifndef STARPIVOT_GENESIS_HPP
#define STARPIVOT_GENESIS_HPP

#include <cstddef>
#include <string>
#include <vector>

#include "starpivot/bodytype.hpp"

namespace starpivot {

struct GenesisBody {
    std::string name;          ///< 纯 ASCII：名字要过 CLI 的 argv，
                               ///< 而 Windows 的 argv 不是可靠的 Unicode 通道
    const BodyType* type = nullptr;
    double mass_msun = 0.0;
    double a_au = 0.0;
    double e = 0.0;
    double inc_deg = 0.0;
    double raan_deg = 0.0;
    double argp_deg = 0.0;
    double M0_deg = 0.0;
    double radius_km = 0.0;     ///< 内核按类型算
    double t_eff_K = 0.0;       ///< 非恒星为 0
    double lum_lsun = 0.0;      ///< 非发光体为 0
};

struct GenesisSystem {
    std::string seed;
    std::string seed_hash;      ///< 十六进制，形如 0x9f2c...
    double primary_mass_msun = 1.0;  ///< 中心天体质量（目前恒为太阳）
    std::string primary_name = "Sun";
    std::vector<GenesisBody> bodies;
    /// 稳定性证据（供页面与判据核对，页面不得自己重算）：
    /// 实际用到的最紧一对的间距比，与它相对 Gladman 临界值的余量。
    double min_sep_ratio = 0.0;      ///< min |a2-a1|/a1
    double min_stability_margin = 0.0;///< min_sep_ratio / gladman_critical，>1 才稳
    int placement_attempts = 0;      ///< 实际用了几轮才放成（诊断用）
};

/// seed 字符串 → 16 位十六进制哈希（带 0x 前缀）。
std::string hash_seed(const std::string& seed);

/// 生成一套系统。
/// @param n_bodies 天体数，钳到 [2, 8]。抛 std::invalid_argument 只在
///                 n_bodies 明显非法时；区间内一律夹取。
GenesisSystem generate_system(const std::string& seed, int n_bodies);

/// Gladman 临界间距比：Δ_crit = 2√3·((m₁+m₂)/(3M))^(1/3)。
double gladman_critical(double m1, double m2, double central_mass);

}  // namespace starpivot

#endif  // STARPIVOT_GENESIS_HPP
