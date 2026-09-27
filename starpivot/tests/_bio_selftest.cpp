// 独立自检：不依赖 GoogleTest，直接跑 bio.cpp 的真代码。
//
// 存在的理由：tests/test_bio.cpp 用 GoogleTest，而 GoogleTest 要靠 CMake 的
// FetchContent 从 github 拉，本机连不上。但"验证必须落在真代码上"这条不能让步 ——
// Python 复算（_probe_bio.py）验的是物理对不对，验不了 bio.cpp 有没有抄错。
// 所以这里把 test_bio.cpp 的判据用一份最小 CHECK 宏重放一遍，能单独编、单独跑。
//
// 编译（zig c++，无需 CMake）：
//   zig c++ -std=c++17 -O2 -I include tests/_bio_selftest.cpp src/bio.cpp -o _bio_selftest.exe
//
// 它与 test_bio.cpp 的关系：判据同源，载体不同。两边都要过。

#include "starpivot/bio.hpp"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>

namespace {

int g_pass = 0;
int g_fail = 0;
std::string g_group;

void group(const char* name) {
    g_group = name;
    std::printf("\n== %s ==\n", name);
}

void check(bool ok, const char* what, const std::string& detail = "") {
    if (ok) {
        ++g_pass;
        std::printf("  PASS  %s%s\n", what, detail.empty() ? "" : ("   " + detail).c_str());
    } else {
        ++g_fail;
        std::printf("  FAIL  %s%s\n", what, detail.empty() ? "" : ("   " + detail).c_str());
    }
}

std::string num(double v) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.6g", v);
    return buf;
}

bool near(double a, double b, double tol) { return std::fabs(a - b) <= tol; }

using namespace starpivot;

constexpr double kAlbedo = 0.306;

double teq_at(double a_AU) {
    return equilibrium_temp_k(insolation_at(a_AU, 1.0), kAlbedo);
}

BioState run_earth_years(int years, const BioParams& p) {
    BioState s;
    for (int i = 0; i < years; ++i)
        step_bio(s, 1.0, 1.0, 1.0, p, static_cast<double>(i));
    return s;
}

}  // namespace

int main() {
    std::printf("starpivot bio selftest (standalone, no GoogleTest)\n");

    // ---- 第 1 层：教材可核对的公式 ----
    group("第 1 层 · 辐照度与光度");
    check(near(insolation_at(1.0, 1.0), 1.0, 1e-12), "1 AU 处地球辐照度 = 1");
    check(near(insolation_at(2.0, 1.0), 0.25, 1e-12), "平方反比：2 AU 处 = 1/4");
    check(near(insolation_at(4.0, 1.0), 0.0625, 1e-12), "平方反比：4 AU 处 = 1/16");
    check(near(stellar_luminosity(1.0), 1.0, 1e-12), "L(1 M☉) = 1");
    check(near(stellar_luminosity(2.0), std::pow(2.0, 3.5), 1e-12), "L(2 M☉) = 2^3.5");

    group("第 1 层 · 平衡温度");
    {
        const double t = teq_at(1.0);
        check(near(t, 254.285, 0.02), "地球锚点 T_eq = 254.285 K", num(t));
        // 系数 278.6 取的是 T_sun = 5778 K 那一支；5772 K 会给 278.33（差 0.1%）。
        const double c5778 = 5778.0 * std::sqrt(6.957e8 / (2.0 * 1.495978707e11));
        check(near(c5778, 278.6, 0.1), "系数 278.6 可由 T_sun·sqrt(R_sun/2d) 复现", num(c5778));
    }
    check(near(equilibrium_temp_k(16.0, kAlbedo) / teq_at(1.0), 2.0, 1e-9),
          "T_eq ∝ S^(1/4)：16 倍通量 → 2 倍温度");
    {
        // 回归判据：公式曾写成 ((1−A)/S)^(1/4)，在 S = 1 处同值，方向却相反。
        const double an = teq_at(0.5), af = teq_at(4.0);
        check(an > af, "越远越冷", num(an) + " K @0.5AU  vs  " + num(af) + " K @4AU");
        check(near(an / af, std::sqrt(8.0), 1e-9),
              "0.5 → 4 AU 是 8 倍距离、64 倍通量 → √8 倍温度", num(an / af));
        check(near(af, 127.14, 0.1), "4 AU 处 127.14 K（除法写法会给 508.6 K）", num(af));
        double prev = 1e300;
        bool mono = true;
        for (double r = 0.05; r < 60.0; r *= 1.2) {
            const double t = teq_at(r);
            if (!(t < prev)) mono = false;
            prev = t;
        }
        check(mono, "沿日心距单调递减");
    }
    {
        struct { double a; double expect; const char* name; } B[] = {
            {0.38709927, 408.7, "水星"}, {0.72333566, 299.0, "金星"},
            {1.00000261, 254.3, "地球"}, {1.52371034, 206.0, "火星"},
            {5.20288700, 111.5, "木星"},
        };
        bool ok = true;
        std::string det;
        for (const auto& b : B) {
            const double got = teq_at(b.a);
            if (!near(got, b.expect, 0.15)) { ok = false; det += std::string(b.name) + "=" + num(got) + " "; }
        }
        check(ok, "五颗行星的 T_eq 对得上公开值", det.empty() ? "水星408.7/金星299.0/地球254.3/火星206.0/木星111.5" : det);
    }
    check(equilibrium_temp_k(1.0, 0.0) == teq_at(1.0), "albedo <= 0 回退到地球默认值");
    check(equilibrium_temp_k(1.0, 1.0) == 0.0 && equilibrium_temp_k(1.0, 1.5) == 0.0,
          "albedo >= 1 返回 0，不给负温度");
    check(equilibrium_temp_k(0.0, kAlbedo) == 0.0, "零辐照度 → 0（不是 NaN）");

    // ---- 第 1 层：温室与两个硬阈值 ----
    group("第 1 层 · 温室增温与液态水窗口");
    check(near(surface_temp_k(254.285, 33.0), 287.285, 1e-9), "T_surf = T_eq + 33 K");
    check(surface_temp_k(0.0, 33.0) == 0.0, "无光照时地表温保持 0（不凭空加温室）");
    check(kFreezing_K == 273.0, "冰点 = 273.0 K（水的物性常数）");
    check(kSterilization_K == 373.0, "沸点 = 373.0 K（水的物性常数）");
    check(!liquid_water_possible(kFreezing_K), "正好在冰点：不算液态水");
    check(liquid_water_possible(kFreezing_K + 0.1), "冰点之上：可以");
    check(liquid_water_possible(kSterilization_K - 0.1), "沸点之下：可以");
    check(!liquid_water_possible(kSterilization_K), "正好在沸点：不算液态水");
    {
        // 没有温室，地球自己的 T_eq 就在冰点以下 —— 这是 ΔT 当常数用的理由。
        const double eq = teq_at(1.0);
        check(eq < kFreezing_K, "地球 T_eq 低于冰点", num(eq) + " K < 273 K");
        check(!liquid_water_possible(surface_temp_k(eq, 0.0)), "无温室 → 地球判为冻结");
        check(liquid_water_possible(surface_temp_k(eq, kGreenhouseDeltaT_K)), "加 33 K → 地球进入窗口");
    }
    {
        struct { const char* name; double a; const char* want; } V[] = {
            {"水星", 0.38709927, "sterilized"}, {"金星", 0.72333566, "evolving"},
            {"地球", 1.00000261, "evolving"},   {"火星", 1.52371034, "frozen"},
            {"木星", 5.20288700, "frozen"},     {"海王星", 30.06992276, "frozen"},
        };
        bool ok = true;
        std::string det;
        for (const auto& v : V) {
            const double t = surface_temp_k(teq_at(v.a), kGreenhouseDeltaT_K);
            const char* got = (t >= kSterilization_K) ? "sterilized"
                            : (t > kFreezing_K) ? "evolving" : "frozen";
            if (std::strcmp(got, v.want) != 0) {
                ok = false;
                det += std::string(v.name) + "=" + got + " ";
            }
        }
        check(ok, "六颗行星的判定与文档一致", det.empty() ? "水星灭菌/金星地球演化/火星以下冻结" : det);
    }
    {
        const double mars_eq = teq_at(1.52371034);
        check(!liquid_water_possible(surface_temp_k(mars_eq, kGreenhouseDeltaT_K)),
              "火星默认冻结");
        check(liquid_water_possible(surface_temp_k(mars_eq, 100.0)),
              "给火星 100 K 温室后进入窗口（可探索的旋钮）");
    }

    // ---- 第 2 层：阶梯记账 ----
    group("第 2 层 · 阶梯记账（编排，只验自洽）");
    {
        BioParams p;                       // 默认 full_ladder_years = 100
        const BioState s = run_earth_years(50, p);
        check(near(s.progress, 0.49967, 0.002), "50 年 / 100 年阶梯 → 进度一半", num(s.progress));
        check(s.stage == 4, "→ 第 4 阶", std::string("stage=") + std::to_string(s.stage));
        const BioState l = run_earth_years(120, p);
        check(l.stage == kBioStageCount - 1, "120 年 → 第 8 阶");
        check(l.progress == 1.0, "progress 恰好钳在 1.0（不是 1.0000001）", num(l.progress));
    }
    {
        BioParams p;
        p.full_ladder_years = 1.0;
        BioState s;
        step_bio(s, 1.0, 1.0, 1e6, p, 1e6);
        check(s.progress == 1.0 && s.stage == 8, "巨步长 → 钳到 1.0 且不溢出",
              num(s.progress) + " stage=" + std::to_string(s.stage));
        step_bio(s, 1.0, 1.0, 1e6, p, 2e6);
        check(s.stage == 8, "已满再推不会造出第 9 阶");
    }
    {
        BioParams p;
        p.full_ladder_years = 10.0;
        BioState s;
        for (int i = 0; i < 10; ++i) step_bio(s, 1.0, 1.0, 1.0, p, static_cast<double>(i));
        const int st_before = s.stage;
        const double pr_before = s.progress;
        step_bio(s, 0.05, 1.0, 1.0, p, 20.0);   // 0.05 AU：T_surf ≈ 1170 K
        check(st_before > 0 && pr_before > 0.9, "灭菌前已经爬到第 8 阶",
              num(pr_before) + " stage=" + std::to_string(st_before));
        check(s.t_surf_K > kSterilization_K, "该处地表温确实超过沸点", num(s.t_surf_K) + " K");
        check(s.stage == 0 && s.progress == 0.0, "过沸点 → 进度归零（灭菌）");
    }
    {
        BioParams p;
        BioState s;
        for (int i = 0; i < 20; ++i) step_bio(s, 1.0, 1.0, 1.0, p, static_cast<double>(i));
        const double held = s.progress;
        const int held_stage = s.stage;
        step_bio(s, 6.0, 1.0, 1.0, p, 100.0);   // 6 AU：T_surf ≈ 137 K
        check(s.t_surf_K < kFreezing_K && s.t_surf_K > 0.0, "6 AU 处低于冰点", num(s.t_surf_K) + " K");
        check(s.progress == held && s.stage == held_stage,
              "低于冰点 → 停滞但不回退（冻住 ≠ 倒退）");
        step_bio(s, 1.0, 1.0, 10.0, p, 200.0);
        check(s.progress > held, "回暖后从原处续上", num(held) + " → " + num(s.progress));
    }
    {
        BioParams p;
        p.full_ladder_years = 10.0;
        BioState s;
        step_bio(s, 1.0, 1.0, 4.0, p, 100.0);
        check(s.stage == 3, "首帧跨到第 3 阶", std::string("stage=") + std::to_string(s.stage));
        check(s.t_stage >= 96.0 && s.t_stage <= 100.0,
              "跨阶时刻落在步内 (96,100]（帧内线性插值）", num(s.t_stage));
        double last = s.t_stage;
        bool mono = true;
        for (int i = 1; i < 20; ++i) {
            step_bio(s, 1.0, 1.0, 4.0, p, 100.0 + i * 4.0);
            if (s.t_stage < last - 1e-9) mono = false;
            last = s.t_stage;
        }
        check(mono, "跨阶时刻单调不减");
    }
    {
        BioState s;
        step_bio(s, 1.0, 1.0, 0.0, BioParams{}, 0.0);
        check(near(s.insolation, 1.0, 1e-12) && near(s.t_eq_K, 254.285, 0.02) &&
              near(s.t_surf_K, 287.285, 0.02),
              "dt = 0 时仍回报三个温度（页面要能解释为什么不动）",
              num(s.insolation) + " / " + num(s.t_eq_K) + " / " + num(s.t_surf_K));
        check(s.progress == 0.0, "dt = 0 时不推进");
    }
    {
        BioParams p;
        p.full_ladder_years = 0.0;
        BioState s;
        step_bio(s, 1.0, 1.0, 1.0, p, 1.0);
        check(s.progress == 0.0 && s.t_surf_K > 0.0,
              "阶梯长度 0 → 不推进、不除零、也不瞬间产生文明");
    }

    // ---- 退化输入 ----
    group("退化输入 · 一律有限值");
    {
        const double R[] = {0.0, -1.0, 1e300, 5.0};
        const double L[] = {0.0, -1.0, 1e300, 5.0};
        const double A[] = {0.0, 0.5, 1.0, 4.0};
        const double G[] = {-50.0, 0.0, 33.0, 1e6};
        bool ok = true;
        std::string det;
        for (double r : R)
            for (double l : L)
                for (double a : A)
                    for (double g : G) {
                        BioParams p;
                        p.albedo = a;
                        p.greenhouse_K = g;
                        BioState s;
                        step_bio(s, r, l, 1.0, p, 1.0);
                        const bool fin = std::isfinite(s.insolation) && std::isfinite(s.t_eq_K) &&
                                         std::isfinite(s.t_surf_K) && std::isfinite(s.progress) &&
                                         std::isfinite(s.t_stage);
                        const bool rng = s.progress >= 0.0 && s.progress <= 1.0 &&
                                         s.stage >= 0 && s.stage <= kBioStageCount - 1;
                        if (!fin || !rng) {
                            ok = false;
                            if (det.empty())
                                det = "r=" + num(r) + " l=" + num(l) + " a=" + num(a) + " g=" + num(g);
                        }
                    }
        check(ok, "4×4×4×4 = 256 组退化输入都不产生 NaN/inf、且落在合法区间", det);
    }
    check(stellar_luminosity(0.0) == 0.0 && stellar_luminosity(-1.0) == 0.0,
          "零/负质量光源 → 光度 0");
    {
        BioState s;
        step_bio(s, 0.0, 1.0, 100.0, BioParams{}, 100.0);
        check(s.insolation == 0.0 && s.t_surf_K == 0.0 && s.stage == 0 && s.progress == 0.0,
              "主星自身（r = 0）→ 无光照、死寂、无 phantom 地表温");
    }
    {
        bool uniq = true;
        for (int i = 0; i < kBioStageCount; ++i) {
            const char* n = bio_stage_name(i);
            if (!n || !n[0]) uniq = false;
            for (int j = i + 1; j < kBioStageCount; ++j)
                if (std::strcmp(n, bio_stage_name(j)) == 0) uniq = false;
        }
        check(uniq, "9 级阶梯名互不重复且非空");
        check(std::strcmp(bio_stage_name(0), "死寂岩石") == 0 &&
              std::strcmp(bio_stage_name(8), "工业文明") == 0 &&
              std::strcmp(bio_stage_name(99), "未知") == 0,
              "阶梯名首/尾/越界取值正确");
    }

    std::printf("\n%d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
