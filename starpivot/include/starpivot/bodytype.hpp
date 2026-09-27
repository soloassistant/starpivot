// starpivot/bodytype.hpp -- 天体类型目录：类型 → (质量范围, 有效温度, 光度, 半径)。
//
// 为什么这件事必须在内核里做，不能放在页面：
//   "黑洞的半径是多少" 是一个物理问题，答案要用 G 和 c 去算；
//   "红超巨星的半径是多少" 要用斯特藩-玻尔兹曼公式从 T 和 L 推。
//   页面一旦自己算，就同时抄了常数和公式，而抄写迟早与内核走散。
//   所以这里定义类型，页面只负责显示，并把口径说明原样转述给玩家。
//
// ---- 恒星分类的四个维度（本表按它们分组）----
//   1. 光谱型   表面温度：O B A F G K M（热→冷），另有沃尔夫-拉叶星、碳星等特殊型
//   2. 光度级   同温度下大小不同 → 罗马数字：VI 亚矮星 / V 主序（矮星）/ IV 亚巨星 /
//               III 巨星 / II 亮巨星 / I 超巨星 / 0 特超巨星
//   3. 演化阶段 原恒星 → 主序 → 红巨星 → 白矮星 / 中子星 / 黑洞
//   4. 特殊性质 变星（造父 / RR 天琴 / 米拉）、脉冲星、磁星、贫金属星、双星…
//
// 四个维度**互相交叉**：一颗"红巨星"同时是 M 型（光谱）、III 级（光度）、晚期（演化）。
// 所以每个类型还带一个 also_in 字段，标明它在别的维度里算什么 —— 页面拿它显示交叉分类。
//
// ---- 半径怎么来：两个方向，都是真公式 ----
//   加热型（绝大多数恒星）：T 与 L 是类型的身份，半径由斯特藩-玻尔兹曼推出
//                            R = Rsun · sqrt(L/Lsun) / (T/Tsun)^2
//   自撑型（白矮星）：半径由简并压决定 R ∝ M^(-1/3)，光度反而由 T 与 R 推出
//   固定型（中子星）：半径是观测典型值，没有可用公式（物态方程至今未定）
//   黑洞：史瓦西半径 R = 2GM/c^2
// 指数与典型值都逐条标注出处（p_source / note），页面照抄，不自己组织语言。

#ifndef STARPIVOT_BODYTYPE_HPP
#define STARPIVOT_BODYTYPE_HPP

#include <cstddef>
#include <string>

namespace starpivot {

/// 分类维度。页面按它给类型分组显示。
enum class TypeGroup {
    kSpectral,    ///< 1. 光谱型（表面温度）
    kLuminosity,  ///< 2. 光度与大小
    kEvolution,   ///< 3. 演化阶段
    kSpecial,     ///< 4. 特殊性质
};

/// 半径从哪来。
enum class RadiusModel {
    /// 斯特藩-玻尔兹曼：R = Rsun·sqrt(L/Lsun)/(T/Tsun)^2 —— 真公式，可用 SI 独立复算。
    kStefanBoltzmann,
    /// 简并压支撑：R = R_ref·(M/M_ref)^p，白矮星 p = -1/3（越重越小）。
    kDegenerate,
    /// 观测典型值，几乎不随质量变（中子星）。
    kFixed,
    /// 史瓦西半径 R = 2GM/c^2（真公式）。
    kSchwarzschild,
};

/// 光度从哪来。
enum class LumModel {
    /// 主序经验质光关系 L/Lsun = M^3.5（只在约 0.43~2 Msun 内可靠，区间外是外推）。
    kMassToThe35,
    /// 观测典型值（巨星/超巨星的光度由演化状态决定，与质量没有单值关系）。
    kFixedL,
    /// 由半径与温度反推：L = (R/Rsun)^2 · (T/Tsun)^4（白矮星走这条）。
    kFromRadiusAndT,
    /// 恒为 0（黑洞 / 中子星：它们的辐射与本模型关心的问题无关）。
    kNone,
};

/// 光变（变星）。不设置时是稳定恒星。
/// 强调：真实光变曲线**不是正弦**，这里用正弦是有意简化的编排，页面上会如实标注。
struct Variability {
    bool on = false;
    double period_days = 0.0;    ///< 周期（天），观测典型值
    double amplitude_mag = 0.0;  ///< 峰值到峰值的星等振幅（mag）
    const char* kind = "";       ///< 变星类别（造父 / RR 天琴 / 米拉…）
};

struct BodyType {
    const char* key;         ///< CLI / JSON 用的键名
    const char* name_zh;     ///< 中文名（页面直接显示，不自己翻译）
    const char* name_en;
    const char* example;     ///< 代表天体（"太阳""参宿四"…）
    TypeGroup group;
    const char* also_in;     ///< 它在别的维度里算什么（交叉分类，页面直接显示）
    RadiusModel radius_model;
    LumModel lum_model;
    double mass_min;         ///< 质量下限 (M☉)
    double mass_max;         ///< 质量上限 (M☉)
    double mass_default;     ///< 默认质量 (M☉)
    double t_eff_K;          ///< 有效温度（光谱型的典型值）
    double lum_lsun;         ///< 光度典型值 (L☉)；lum_model = kFixedL 时用它
    bool emits_light;        ///< 是否自己发光（决定它能不能照亮别人）
    double r_ref_km;         ///< kDegenerate / kFixed 用的锚点半径 (km)
    double m_ref_msun;       ///< 锚点质量 (M☉)
    double p;                ///< kDegenerate 的指数
    const char* source;      ///< 温度/半径的口径出处
    const char* note;        ///< 这个类型整体要注意什么
    Variability var;         ///< 光变（默认没有）
};

/// 类型表（静态存储）。*count 收到表长。
const BodyType* body_types(int* count);

/// 按键名查。找不到返回 nullptr（调用方负责决定这是不是一个错误）。
const BodyType* find_body_type(const std::string& key);

/// 类型是否认得（用于 CLI 参数校验时报出可用键名）。
std::string body_type_keys_joined();

/// 按类型算半径 (km)。质量只影响 kDegenerate 与黑洞。
double body_type_radius_km(const BodyType& t, double mass_msun);

/// 按类型算光度 (L☉)。
double body_type_luminosity(const BodyType& t, double mass_msun);

/// 按类型算有效温度 (K)。非恒星返回 0。
double body_type_t_eff(const BodyType& t);

/// 斯特藩-玻尔兹曼半径：R = Rsun·√(L/Lsun)/(T/Tsun)²。
///
/// 抽出来是为了**只有一份实现**：类型表的 kStefanBoltzmann 半径模型，与
/// 「观测覆盖了一颗具体恒星的 T 与 L 之后重新推半径」走的是同一个公式。
/// 本仓库反复踩过的坑就是同一个公式抄两遍、然后慢慢走散。
/// T<=0 或 L<=0 时返回 0（无定义），不返回 inf/NaN（NaN 进了 JSON 会毒掉整个载荷）。
double sb_radius_km(double t_eff_K, double lum_lsun);

/// 由半径与温度反推光度：L = (R/Rsun)²·(T/Tsun)⁴。与 sb_radius_km 互逆。
///
/// 这是**观测上最常走的方向**：多数恒星的 L 不是直接测出来的，而是测到 R 与 T 之后
/// 用这个式子推出来的。所以"给 L"与"给 R+T 由内核推 L"两种用法都要支持，
/// 且推出来的 L 在 JSON 里要如实标成推导值，不能说成观测值。
double lum_from_radius_t_eff(double radius_km, double t_eff_K);

/// 已知名称（太阳系行星表里的那些）→ 类型键。认不出来返回 nullptr。
const BodyType* known_body_type(const std::string& name);

/// 氢燃烧下限 (M☉)：低于它不会点火成恒星。
/// 用在"没有声明类型"的自定义天体的兜底判断上 —— 这时只能靠质量。
constexpr double kHydrogenBurningLimit_Msun = 0.08;

/// 一个天体是否自己发光。
/// 声明了类型就听类型的；没声明类型就按氢燃烧下限判。
bool body_emits_light(double mass_msun, const BodyType* type);

/// 变星星等在时刻 t（年）的亮度倍数：1 + A·sin(2π t/P + φ)。
/// 没有光变时恰好返回 1.0。振幅由峰值星等振幅换算：A = 10^(0.4·Δm/2) − 1。
double variability_factor(const BodyType& t, double t_years, double phase);

/// 太阳有效温度 (K)：斯特藩-玻尔兹曼公式里的锚点，与 bio 层的 278.6 同一支（T_sun = 5778）。
constexpr double kSunT_eff_K = 5778.0;

}  // namespace starpivot

#endif  // STARPIVOT_BODYTYPE_HPP
