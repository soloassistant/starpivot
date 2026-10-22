// starpivot/lagrange.cpp -- CR3BP 五个拉格朗日点的求解。
//
// 实现选择：二分法，不写死五次多项式的系数。
// 理由：那三个共线点的方程展开成多项式时系数极易写错（L1 与 L2 的镜像
// 关系、μ 的符号），而写错之后症状是"解出来了但是个错的数"——不崩、不报错、
// 判据里若没独立复算就永远发现不了。二分只需要"区间两端异号 + 区间内连续"，
// 这两条在下面每个区间上都直接给出来，可以一眼核对。
//
// 数值上有一处必须讲究：L1 离次星只有 (μ/3)^(1/3) 个单位，μ=3e-6 时约 0.01，
// 而次星在归一化系里的坐标是 1-μ ≈ 0.999997。于是
//     x + μ
// 是在两个几乎相等的数上做加减，灾难性抵消会把有效位吃掉一大半。
// 所以 L1/L2 一律**改用相对次星的偏移 y = x - (1-μ)** 来求，
// y 是 O(0.01) 的量，全程不涉及抵消。L3 在 x ≈ -1 处，本身条件良好。

#include "starpivot/lagrange.hpp"

#include <cmath>

namespace starpivot {
namespace {

/// 归一化旋转系里有效势 Ω = ½(x²+y²) + (1-μ)/r₁ + μ/r₂ 的 x 方向偏导。
/// 主星在 x = -μ，次星在 x = 1-μ。共线点 y = 0，所以只需这一支。
double dOmega_dx(double x, double mu) {
    const double r1 = std::fabs(x + mu);
    const double r2 = std::fabs(x - 1.0 + mu);
    return x - (1.0 - mu) * (x + mu) / (r1 * r1 * r1)
             -        mu  * (x - 1.0 + mu) / (r2 * r2 * r2);
}

/// 同上，但自变量是**相对次星的偏移** y = x - (1-μ)，且用 x = 1-μ+y 展开。
/// 这样 (1+y) 与 y 都是 O(1) 与 O(0.01) 的良态量，没有抵消。
double dOmega_dx_from_secondary(double y, double mu) {
    const double r1 = std::fabs(1.0 + y);
    const double r2 = std::fabs(y);
    return (1.0 - mu + y) - (1.0 - mu) * (1.0 + y) / (r1 * r1 * r1)
                          -        mu  * y        / (r2 * r2 * r2);
}

/// 二分。区间两端必须异号（调用处保证）。200 轮足够把 1 个单位宽的区间
/// 收到双精度极限（1e-60 早已小于 ulp），再多只是空转。
double bisect(double lo, double hi, double mu, bool from_secondary) {
    const auto f = [mu, from_secondary](double t) {
        return from_secondary ? dOmega_dx_from_secondary(t, mu)
                              : dOmega_dx(t, mu);
    };
    double flo = f(lo);
    for (int it = 0; it < 200; ++it) {
        const double mid = 0.5 * (lo + hi);
        const double fmid = f(mid);
        // 端点零是合法解（虽然本文件的三个区间都不含精确零点），不能当收敛判据。
        if (fmid == 0.0) return mid;
        if ((fmid < 0.0) == (flo < 0.0)) { lo = mid; flo = fmid; }
        else { hi = mid; }
    }
    return 0.5 * (lo + hi);
}

/// 由归一化坐标（主星在 -μ、次星在 1-μ）搬到惯性系（主星在原点、次星在 (a,0,0)）。
/// 做法是整体平移 μ·a：次星随之落到 x = a，L4/L5 于是正好是 (a/2, ±√3a/2)。
Vec3 to_inertial(double x_norm, double y_norm, double mu, double a) {
    return Vec3(a * (x_norm + mu), a * y_norm, 0.0);
}

}  // namespace

double routh_limit_value() {
    // μ_crit = ½(1 - √(23/27))。写成闭式而不是记 0.03852：判据里要拿它
    // 当阈值用，截断值会在 μ 恰好靠近它时给出相反的结论。
    return 0.5 * (1.0 - std::sqrt(23.0 / 27.0));
}

LagrangeSolution solve_lagrange(double m1, double m2, double a) {
    LagrangeSolution sol;
    sol.a = a;
    const double mtot = m1 + m2;
    sol.mu = (mtot > 0.0) ? (m2 / mtot) : 0.0;
    sol.routh_limit = routh_limit_value();
    // Lagrange 定理：三角点线性稳定 ⟺ μ < μ_crit。共线点恒不稳定。
    sol.triangular_stable = (sol.mu < sol.routh_limit);
    sol.collinear_stable = false;

    const double mu = sol.mu;
    // 三个区间的异号性（函数连续、单调，故各只有一个根）：
    //   L1  y ∈ (-1+1e-6, -1e-12)：左端 r₁→0 使 f→-1e12；右端 r₂→0 使 f→+∞
    //   L2  y ∈ (+1e-12, +1)    ：左端 r₂→0 使 f→-∞；右端 f≈1.75>0
    //   L3  x ∈ (-2, -μ-1e-12)  ：左端 f≈-1.75<0；右端 r₁→0 使 f→+∞
    const double eps = 1e-12;
    const double y_l1 = bisect(-1.0 + 1e-6, -eps, mu, /*from_secondary=*/true);
    const double y_l2 = bisect(eps, 1.0, mu, /*from_secondary=*/true);
    const double x_l3 = bisect(-2.0, -mu - eps, mu, /*from_secondary=*/false);

    const double sqrt3_2 = std::sqrt(3.0) / 2.0;
    const double x_l4 = 0.5 - mu;
    const double y_l45 = sqrt3_2;

    // 说明文字在内核里生成，页面只许原文转述。L4/L5 那两句刻意写成
    // "满足…才稳定"：只说"稳定"会让页面顺口写成"这里安全"，而它在
    // μ 超标时并不安全 —— 前面那 400 次重抽里碰到的褐矮星就是这种情形。
    const char* note_tri_stable =
        "在两个天体连成的等边三角形第三个顶点上。质量比满足 Routh 判据时，"
        "放这里的天体只会绕着它来回摆（蜓行），不会漂走 —— 这是五个点里唯二"
        "稳定的，但稳定有条件：质量比超标就会失稳。";
    const char* note_tri_unstable =
        "几何位置与 L4/L5 相同（同为等边三角形的顶点），但当前质量比超出了 "
        "Routh 判据，所以放这里的天体不会停住。这是同一个位置的两种结局，"
        "差别只在质量比。";
    const char* note_collinear =
        "在两星连线上。线性不稳定：任何一点点扰动（甚至数值误差）都会让它"
        "指数级离开，所以真实航天器需要周期性维持。";

    struct Raw { const char* key; const char* name_zh; const char* note;
                 double x; double y; bool stable; };
    const Raw raw[5] = {
        {"L1", "内侧拉格朗日点", note_collinear, 1.0 - mu + y_l1, 0.0, false},
        {"L2", "外侧拉格朗日点", note_collinear, 1.0 - mu + y_l2, 0.0, false},
        {"L3", "对侧拉格朗日点", note_collinear, x_l3,             0.0, false},
        {"L4", "前导拉格朗日点", sol.triangular_stable ? note_tri_stable
                                                     : note_tri_unstable,
         x_l4,  y_l45, sol.triangular_stable},
        {"L5", "后随拉格朗日点", sol.triangular_stable ? note_tri_stable
                                                     : note_tri_unstable,
         x_l4, -y_l45, sol.triangular_stable},
    };

    sol.points.reserve(5);
    for (const Raw& r : raw) {
        LagrangePoint p;
        p.key = r.key;
        p.name_zh = r.name_zh;
        p.note_zh = r.note;
        p.pos = to_inertial(r.x, r.y, mu, a);
        p.stable = r.stable;
        // 到主星/次星的距离。共线点在一条直线上，用 x 就够；
        // 三角点不在，所以真的算欧氏距离 —— 这里不能图省事写 |x|。
        p.from_primary = p.pos.norm();
        p.from_secondary = (p.pos - Vec3(a, 0.0, 0.0)).norm();
        // 残差 = |∇Ω|。共线点 ∂Ω/∂y ≡ 0，三角点两项都算。
        const double r1 = std::sqrt((r.x + mu) * (r.x + mu) + r.y * r.y);
        const double r2 = std::sqrt((r.x - 1.0 + mu) * (r.x - 1.0 + mu) + r.y * r.y);
        const double gx = r.x - (1.0 - mu) * (r.x + mu) / (r1 * r1 * r1)
                             -        mu  * (r.x - 1.0 + mu) / (r2 * r2 * r2);
        const double gy = r.y - (1.0 - mu) * r.y / (r1 * r1 * r1)
                             -        mu  * r.y / (r2 * r2 * r2);
        p.residual = std::sqrt(gx * gx + gy * gy);
        sol.points.push_back(p);
    }
    return sol;
}

}  // namespace starpivot
