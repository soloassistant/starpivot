// starpivot/lagrange.hpp -- the five Lagrange points of a circular restricted
// three-body system.
//
// 为什么这个模块存在（原先它只活在 tests/fixtures.hpp 里）
// -------------------------------------------------------
// 求解器早就写好了：tests/fixtures.hpp 的 sun_earth_l1() 用 Hill 半径做种子、
// Newton 迭代解五次方程，sun_earth_l4() 直接给等边三角形第三个顶点。
// tests/test_lagrange.cpp 的四个 TEST 与 tools/verify_baselines.cpp 的
// Baseline 4 都在用它，并且它验的是**定性预言**（L4 稳定 / L1 不稳定），
// 所以那套数学本身是可信的。
//
// 但它只能被测试调用 —— 页面拿不到任何一个 L 点的坐标，于是"拉格朗日点"
// 这个概念对用户根本不存在。把它提升成内核 API 的动作在这里。
//
// 物理
// ----
// 圆型限制性三体问题（CR3BP）的平衡点，就是**旋转系里有效势的临界点**：
//
//     Ω(x, y) = ½(x² + y²) + (1-μ)/r₁ + μ/r₂
//     r₁ = |x + μ|        （主星在 x = -μ）
//     r₂ = |x - 1 + μ|    （次星在 x = 1-μ）
//
// 求 ∇Ω = 0：共线三解（L1/L2/L3，y = 0）与三角两解（L4/L5）。
// 本实现不写死那三个五次多项式的系数，而是**直接对 f(x) = ∂Ω/∂x 做二分**——
// 系数写错是这类代码最常见也最难发现的错，而二分只需要"区间两端异号"，
// 正确性一眼可验。每个区间的异号性在 solve_collinear() 的注释里逐条给出。
//
// 稳定性（Lagrange 定理）
// ----------------------
//   L1/L2/L3 恒不稳定，且是**指数发散**。
//   L4/L5 在 μ < (1/2)(1 - √(23/27)) ≈ 0.0385209 时线性稳定 —— Routh 判据。
//   太阳-地球 μ = 3.0e-6，远低于该极限，所以 L4 稳定。
//
// **稳定是有条件的**：μ 超标时 L4/L5 也会失稳。所以本模块把判据本身
// (routh_limit / triangular_stable) 一并回显，调用方（CLI、页面）必须
// 把它讲出来，不能只说"L4 稳定"。

#ifndef STARPIVOT_LAGRANGE_HPP
#define STARPIVOT_LAGRANGE_HPP

#include <vector>

#include "starpivot/vec3.hpp"

namespace starpivot {

struct LagrangePoint {
    const char* key = "";       // "L1" .. "L5"
    const char* name_zh = "";   // 内置中文名，页面直接用，不自己编
    /// 这个点为什么稳/不稳，以及稳的条件是什么。**由内核给出**：
    /// 页面的规矩是只翻译内核给的字符串，不自己组织"为什么"。
    /// 特别地，L4/L5 的稳定是有条件的（见 Routh 判据），那句话必须在这里。
    const char* note_zh = "";
    Vec3 pos;                   // 惯性系坐标，单位与 a 相同（通常 AU）
    bool stable = false;        // 线性稳定；共线三点恒为 false
    double from_primary = 0.0;    // 到主星距离
    double from_secondary = 0.0;  // 到次星距离
    /// 力平衡残差 |∇Ω|（归一化，a=1、n=1）。越小说明这个点解得越准。
    /// 它存在的意义是：让"解出来了"与"解得对"可以被外部独立检查。
    double residual = 0.0;
};

struct LagrangeSolution {
    double a = 0.0;                 // 两星间距（与调用方给的单位一致）
    double mu = 0.0;                // m₂ / (m₁ + m₂)
    double routh_limit = 0.0;       // (1/2)(1 - √(23/27))
    bool triangular_stable = false; // L4/L5 是否线性稳定
    bool collinear_stable = false;  // 恒为 false；显式回显，免得调用方自己假设
    std::vector<LagrangePoint> points;  // 恒为 5 条，顺序 L1..L5
};

/// Routh 判据的临界质量比 μ_crit = (1/2)(1 - √(23/27))。
double routh_limit_value();

/// 解五个拉格朗日点。
/// @param m1 主星质量，@param m2 次星质量（同一单位制）
/// @param a  两星间距（同一单位制）
/// 约定：主星在原点、次星在 (a, 0, 0)，解在**惯性系**下返回。
LagrangeSolution solve_lagrange(double m1, double m2, double a);

}  // namespace starpivot

#endif  // STARPIVOT_LAGRANGE_HPP
