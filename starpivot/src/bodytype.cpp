#include "starpivot/bodytype.hpp"

#include <cmath>

#include "starpivot/bio.hpp"   // stellar_luminosity：主序质光关系只此一份，不在这里重写

namespace starpivot {

namespace {

// ---- 物理常数（只在这里出现一次）----
constexpr double kG_SI = 6.67430e-11;        // m^3 kg^-1 s^-2
constexpr double kC_SI = 2.99792458e8;       // m/s
constexpr double kMsun_kg = 1.98847e30;      // kg
constexpr double kRsun_km = 696340.0;        // km
constexpr double kRearth_km = 6371.0;        // km
constexpr double kMjup_km = 69911.0;         // km
constexpr double kDay_per_yr = 365.25;

// 地球 / 木星 / 海王星质量（M☉）。与 CLI 里 kEarthMassMsun 必须一致 ——
// 那边的判据会逐位比对。
constexpr double kEarthMassMsun = 3.003489e-6;
constexpr double kJupiterMassMsun = 9.547919e-4;
constexpr double kNeptuneMassMsun = 5.151389e-5;

// 口径说明（每种类型都引用其中的一条，避免同一句话抄十几遍）
// 主序型的 T / L / R 三个量各有出处。原先把它们拆成三条常量，结果 T 与 R 那两条
// 定义了却没人引用（被 -Wunused-const-variable 报出来）—— 那不只是死代码，而是
// **出处不完整**：页面上显示的口径只说清了 L 怎么来，没说 T 和 R。合成一条写全。
const char* kSrcMS = "T 取 MK 分类（摩根-基南系统）的典型有效温度；"
                     "L 由主序经验质光关系 L ∝ M^3.5 给出（可靠区间约 0.43~2 Msun，区间外是外推）；"
                     "半径由斯特藩-玻尔兹曼从 T 与 L 推出：R = Rsun·sqrt(L/Lsun)/(T/Tsun)^2";
const char* kSrcObs = "光度取该光度级的观测典型值；半径由斯特藩-玻尔兹曼推出";
const char* kSrcDeg = "半径由零温简并近似 R ∝ M^(-1/3)；光度由 T 与 R 经斯特藩-玻尔兹曼推出";
const char* kSrcNS = "半径是观测典型值（10~14 km 取 12），物态方程至今未定，没有可用公式";

// 表按分类维度分组排列。顺序不影响正确性。
//
// 每条只写到 note 为止，最后一个字段 var（光变）**刻意省略**：Variability 的成员都带
// 默认初始化（on = false、period/amplitude 为 0），省略恰好等于"稳定恒星"，语义正确。
// 但 -Wmissing-field-initializers 会为每条报一次（39 条），这类噪音会淹掉真正危险的
// 漏字段警告（漏掉一个 double 会被静默清零）。所以这里只关掉这一个警告，且限定在表内。
// 用 __clang__ 包住：换 GCC 编时这两行是空操作，不会引入 unknown-pragma 噪音。
#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wmissing-field-initializers"
#endif
const BodyType kTypes[] = {
// ============================ 1. 按光谱型（主序带） ============================
// key           中文名        英文名           代表        组                    交叉              半径模型                  光度模型              min      max     def     T_eff   L☉    光   r_ref   m_ref   p     出处     注意事项
{"O_V", "O 型主序星", "O-type main sequence", "参宿一", TypeGroup::kSpectral, "光度级 V（主序）/ 演化阶段：主序",
 RadiusModel::kStefanBoltzmann, LumModel::kMassToThe35, 16.0, 90.0, 30.0, 40000.0, 0.0, true,
 0, 1, 0, kSrcMS, "最热最亮最稀有的一类。紫外辐射极强，寿命只有几百万年。"},
{"B_V", "B 型主序星", "B-type main sequence", "角宿一", TypeGroup::kSpectral, "光度级 V（主序）",
 RadiusModel::kStefanBoltzmann, LumModel::kMassToThe35, 2.1, 16.0, 8.0, 20000.0, 0.0, true,
 0, 1, 0, kSrcMS, "蓝白色。质光关系在这个质量段已经是外推，误差会明显变大。"},
{"A_V", "A 型主序星", "A-type main sequence", "织女星", TypeGroup::kSpectral, "光度级 V（主序）",
 RadiusModel::kStefanBoltzmann, LumModel::kMassToThe35, 1.4, 2.1, 1.8, 9000.0, 0.0, true,
 0, 1, 0, kSrcMS, "白色。氢的吸收线最强，肉眼看上去仍是白里偏蓝。"},
{"F_V", "F 型主序星", "F-type main sequence", "南河三", TypeGroup::kSpectral, "光度级 V（主序）",
 RadiusModel::kStefanBoltzmann, LumModel::kMassToThe35, 1.04, 1.4, 1.2, 6800.0, 0.0, true,
 0, 1, 0, kSrcMS, "黄白色。可居带比太阳的稍远一点。"},
{"G_V", "G 型主序星（太阳）", "G-type main sequence", "太阳", TypeGroup::kSpectral, "光度级 V（主序）/ 演化阶段：主序",
 RadiusModel::kStefanBoltzmann, LumModel::kMassToThe35, 0.8, 1.04, 1.0, 5778.0, 1.0, true,
 0, 1, 0, kSrcMS, "太阳所在的一格。L=1、T=5778 K 处半径恰好 1 Rsun —— 这是整套口径的锚点。"},
{"K_V", "K 型主序星（橙矮星）", "K-type main sequence", "天鹅座61", TypeGroup::kSpectral, "光度级 V（主序）",
 RadiusModel::kStefanBoltzmann, LumModel::kMassToThe35, 0.45, 0.8, 0.6, 4500.0, 0.0, true,
 0, 1, 0, kSrcMS, "橙色。寿命比太阳长得多，被当作寻找生命的重点目标。"},
{"M_V", "M 型主序星（红矮星）", "M-type main sequence", "比邻星", TypeGroup::kSpectral, "光度级 V（主序）",
 RadiusModel::kStefanBoltzmann, LumModel::kMassToThe35, 0.08, 0.45, 0.2, 3200.0, 0.0, true,
 0, 1, 0, kSrcMS, "宇宙里最常见的恒星，但极暗 —— 它的可居带离自己很近。"
 "质光关系 L∝M^3.5 只在约 0.43~2 Msun 可靠，0.43 Msun 以下这一段它偏**暗**："
 "TRAPPIST-1（0.0898 Msun）实测 5.5e-4 Lsun，本关系只给 2.2e-4；"
 "比邻星（0.122 Msun）实测 1.7e-3，本关系只给 6.4e-4 —— 低质量端会低 2~3 倍。"
 "要按真实个体算，请直接给这颗星的观测 T 与 L。"},
{"WR", "沃尔夫-拉叶星", "Wolf-Rayet star", "WR 104", TypeGroup::kSpectral, "演化阶段：大质量恒星晚期（氦燃烧、强星风）",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 10.0, 25.0, 15.0, 60000.0, 3.0e5, true,
 0, 1, 0, kSrcObs, "表面温度极高、星风强烈，外层已被吹走 —— 所以它虽然极亮，半径却只有几个 Rsun。"},
{"carbon", "碳星", "carbon star", "R Leporis", TypeGroup::kSpectral, "光度级 III（巨星）/ 特殊：富碳",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 1.5, 4.0, 2.0, 3000.0, 5000.0, true,
 0, 1, 0, kSrcObs, "大气里碳多于氧，看上去深红。本模型只体现「冷而亮」，不区分化学丰度。"},

// ============================ 2. 按光度与大小 ============================
{"sd", "亚矮星（VI）", "subdwarf", "Kapteyn 星", TypeGroup::kLuminosity, "光谱型：多为 K / 演化阶段：老年贫金属",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 0.5, 1.0, 0.7, 4800.0, 0.2, true,
 0, 1, 0, kSrcObs, "比同光谱型的主序星暗一档 —— 它们更小，且通常重元素贫乏（与「贫金属星」高度重合）。"},
{"subgiant", "亚巨星（IV）", "subgiant", "南河三", TypeGroup::kLuminosity, "演化阶段：主序刚结束",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 0.8, 3.0, 1.3, 5000.0, 5.0, true,
 0, 1, 0, kSrcObs, "核心氢烧完、还没膨胀成巨星的中间站。"},
{"G_III", "G 型巨星", "G-type giant", "北河三", TypeGroup::kLuminosity, "演化阶段：红巨星支",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 1.0, 4.0, 1.5, 5200.0, 60.0, true,
 0, 1, 0, kSrcObs, "同温度下比主序星亮几十倍 → 半径大几十倍。这一步差距全靠 T 与 L 推出来。"},
{"K_III", "K 型巨星", "K-type giant", "大角星", TypeGroup::kLuminosity, "演化阶段：红巨星支",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 1.0, 4.0, 1.2, 4300.0, 130.0, true,
 0, 1, 0, kSrcObs, "典型的橙巨星。它的光度与质量**没有**单值关系 —— 一颗 1 Msun 的星也可能这么亮。"},
{"M_III", "M 型红巨星", "M-type red giant", "毕宿五", TypeGroup::kLuminosity, "光谱型：M / 演化阶段：氢壳燃烧",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 1.0, 8.0, 1.5, 3400.0, 400.0, true,
 0, 1, 0, kSrcObs, "表面又冷又红，却比太阳亮几百倍 —— 大小补上去了。"},
{"B_II", "B 型亮巨星", "B-type bright giant", "天津四", TypeGroup::kLuminosity, "光谱型：B",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 10.0, 20.0, 14.0, 17000.0, 1.0e5, true,
 0, 1, 0, kSrcObs, "亮巨星是主序与超巨星之间的过渡档。"},
{"K_II", "K 型亮巨星", "K-type bright giant", "心宿二 A", TypeGroup::kLuminosity, "光谱型：K",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 5.0, 15.0, 10.0, 4200.0, 2.0e4, true,
 0, 1, 0, kSrcObs, "同温度下比 K 巨星又亮两个量级。"},
{"O_I", "O 型超巨星", "O-type supergiant", "参宿二", TypeGroup::kLuminosity, "光谱型：O",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 20.0, 60.0, 40.0, 35000.0, 1.0e6, true,
 0, 1, 0, kSrcObs, "百万倍太阳光度。寿命只有几百万年，活不到行星演化出生命。"},
{"B_I", "B 型超巨星", "B-type supergiant", "参宿七", TypeGroup::kLuminosity, "光谱型：B",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 15.0, 25.0, 21.0, 12000.0, 1.2e5, true,
 0, 1, 0, kSrcObs, "蓝超巨星，直径几十个 Rsun。"},
{"A_I", "A 型超巨星", "A-type supergiant", "天津四", TypeGroup::kLuminosity, "光谱型：A",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 10.0, 20.0, 15.0, 9000.0, 5.0e4, true,
 0, 1, 0, kSrcObs, "就是织女星那一档温度，但亮了三个量级。"},
{"G_I", "G 型超巨星", "G-type supergiant", "天津一", TypeGroup::kLuminosity, "光谱型：G",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 10.0, 25.0, 15.0, 5500.0, 1.0e4, true,
 0, 1, 0, kSrcObs, "黄超巨星，造父变星的所在区域（见「特殊性质」里的经典造父变星）。"},
{"K_I", "K 型超巨星", "K-type supergiant", "参宿四近旁", TypeGroup::kLuminosity, "光谱型：K",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 10.0, 25.0, 15.0, 4000.0, 6.0e4, true,
 0, 1, 0, kSrcObs, "橙超巨星。半径已达数百 Rsun —— 若放在太阳的位置，会吞掉地球轨道内侧。"},
{"M_I", "M 型红超巨星", "M-type red supergiant", "参宿四", TypeGroup::kLuminosity, "光谱型：M / 演化阶段：晚期",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 10.0, 25.0, 15.0, 3500.0, 1.0e5, true,
 0, 1, 0, kSrcObs, "人类已知体积最大的恒星都在这一档：冷但极大，半径可达上千 Rsun。"},
{"M_0", "M 型红特超巨星", "M-type hypergiant", "盾牌座 UY", TypeGroup::kLuminosity, "光谱型：M / 极端",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 15.0, 30.0, 25.0, 3300.0, 3.0e5, true,
 0, 1, 0, kSrcObs, "光度极高、寿命极短，半径以千 Rsun 计 —— 但它的质量流失率也让半径一直在缩。"},
{"B_0", "B 型蓝特超巨星", "B-type hypergiant", "天秤座 BP", TypeGroup::kLuminosity, "光谱型：B / 极端",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 20.0, 50.0, 30.0, 15000.0, 1.0e6, true,
 0, 1, 0, kSrcObs, "百万倍太阳光度，是恒星亮度的上限附近。"},

// ============================ 3. 按演化阶段 ============================
{"pre_main", "原恒星（T Tauri）", "pre-main-sequence", "金牛座 T", TypeGroup::kEvolution, "光谱型：多为 K/M",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 0.1, 3.0, 1.0, 4000.0, 2.0, true,
 0, 1, 0, kSrcObs, "还在引力收缩、尚未点火：温度不高但体积很大（几个 Rsun），"
 "所以在 H-R 图上落在主序的右上方 —— 与巨星同区域但成因完全不同。"},
{"white_dwarf", "白矮星", "white dwarf", "天狼星 B", TypeGroup::kEvolution, "光致度级：VII（简并）",
 RadiusModel::kDegenerate, LumModel::kFromRadiusAndT, 0.17, 1.4, 0.6, 10000.0, 0.0, true,
 0.0127 * kRsun_km, 0.6, -1.0 / 3.0, kSrcDeg,
 "低质量恒星死亡后的遗骸：**越重越小**（简并压支撑）。它仍然发光（约 1e-3 Lsun 量级），"
 "所以本模型把它当真正的光源处理 —— 只是极其暗淡。"},
{"neutron_star", "中子星", "neutron star", "蟹状星云脉冲星", TypeGroup::kEvolution, "特殊性质：脉冲星 / 磁星都是它的子类",
 RadiusModel::kFixed, LumModel::kNone, 1.1, 2.5, 1.4, 0.0, 0.0, false,
 12.0, 1.4, 0.0, kSrcNS,
 "超新星爆发后的遗骸，直径只有二十几公里，密度是核物质量级。"
 "它的热辐射在 X 射线波段、对行星的辐照度可忽略，所以本模型把光度记 0（这是取舍，不是「它不发光」）。"},
{"black_hole", "黑洞", "black hole", "天鹅座 X-1", TypeGroup::kEvolution, "特殊性质：恒星级黑洞",
 RadiusModel::kSchwarzschild, LumModel::kNone, 0.5, 1.0e4, 10.0, 0.0, 0.0, false,
 0.0, 1.0, 1.0, "史瓦西半径 R = 2GM/c^2（真公式，可用 SI 单位独立复算）",
 "半径是史瓦西半径，也是全项目里唯一一个半径与质量成正比的天体。"
 "它当然不发光；而且霍金辐射的温度远低于宇宙微波背景，实际是净吸收。"},

// ============================ 4. 按特殊性质 ============================
{"cepheid", "经典造父变星", "classical Cepheid", "仙王座 δ", TypeGroup::kSpecial, "光度级 I（超巨星）/ 光谱型 F~K",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 4.0, 10.0, 6.0, 6000.0, 3000.0, true,
 0, 1, 0, kSrcObs, "亮度随时间变化，周期与光度有著名的周光关系 —— 所以它被用来量宇宙距离。"
 "本模型让光度按正弦脉动（真实光变曲线不是正弦，这是编排）。",
 {true, 10.0, 0.8, "经典造父"}},
{"rr_lyrae", "天琴座 RR 型变星", "RR Lyrae variable", "天琴座 RR", TypeGroup::kSpecial, "光度级 II/III（水平分支）",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 0.6, 0.9, 0.7, 6500.0, 50.0, true,
 0, 1, 0, kSrcObs, "周期不到一天的短周期脉动变星，是球状星团的「标准烛光」。",
 {true, 0.5, 1.0, "天琴座 RR"}},
{"mira", "米拉变星（蒭藁型）", "Mira variable", "米拉（鲸鱼座 ο）", TypeGroup::kSpecial, "光度级 III / 光谱型 M",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 1.0, 3.0, 1.2, 3000.0, 3000.0, true,
 0, 1, 0, kSrcObs, "长周期脉动巨星，亮度变化的幅度能达到六个星等（上千倍）—— "
 "它是本表里光变最剧烈的一类，行星的辐照度会跟着大幅振荡。",
 {true, 300.0, 6.0, "米拉型"}},
{"pulsar", "脉冲星", "pulsar", "PSR B1919+21", TypeGroup::kSpecial, "演化阶段：中子星 / 快速自转",
 RadiusModel::kFixed, LumModel::kNone, 1.1, 2.5, 1.4, 0.0, 0.0, false,
 12.0, 1.4, 0.0, kSrcNS,
 "快速自转、发出周期信号的中子星。自转周期与射电束**不参与**力学与演化计算，"
 "本模型只把它当中子星处理，并把「它是什么」如实标出来。"},
{"magnetar", "磁星", "magnetar", "SGR 1806-20", TypeGroup::kSpecial, "演化阶段：中子星 / 极强磁场",
 RadiusModel::kFixed, LumModel::kNone, 1.1, 2.5, 1.4, 0.0, 0.0, false,
 12.0, 1.4, 0.0, kSrcNS,
 "磁场强度可达 1e14~1e15 高斯的中子星。磁场同样不参与本模型的力学与演化计算。"},
{"metal_poor", "贫金属星（第二星族）", "metal-poor star", "HE 1523-0901", TypeGroup::kSpecial, "光谱型：多为 K/G",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 0.7, 0.9, 0.8, 5000.0, 0.5, true,
 0, 1, 0, kSrcObs,
 "几乎不含重元素的古老恒星，银河系晕里最常见。**金属丰度在本模型里不影响力学与演化** —— "
 "它只是一个标签，用来把「这是一颗很老的星」这件事记录下来。"},
{"brown_dwarf", "褐矮星", "brown dwarf", "Luhman 16", TypeGroup::kSpecial, "介于行星与恒星之间（失败恒星）",
 RadiusModel::kStefanBoltzmann, LumModel::kFixedL, 3e-3, 8e-2, 4.0e-2, 1500.0, 1.0e-4, true,
 0, 1, 0, kSrcObs,
 "点不着氢（质量不足 0.08 Msun）、但比行星重得多。它靠氘聚变与余热发光，"
 "亮度比按主序质光关系外推低得多 —— 所以这里用观测典型值 1e-4 Lsun，而不是 M^3.5。"},
{"rocky", "岩质行星", "rocky planet", "地球", TypeGroup::kSpecial, "不是恒星（基准天体）",
 RadiusModel::kDegenerate, LumModel::kNone, 1e-9, 1e-4, kEarthMassMsun, 0.0, 0.0, false,
 kRearth_km, kEarthMassMsun, 0.28, "经验拟合：小质量岩质行星 R ∝ M^0.28",
 "地球这一档。列在表里是为了让「给恒星旁边放一颗地球」这件事不用切表。"},
{"super_earth", "超级地球", "super-Earth", "开普勒-442b", TypeGroup::kSpecial, "不是恒星",
 RadiusModel::kDegenerate, LumModel::kNone, 1e-5, 6e-5, 3.0e-5, 0.0, 0.0, false,
 kRearth_km, kEarthMassMsun, 0.28, "经验拟合：与岩质行星同一条 R ∝ M^0.28",
 "比地球重几倍。半径仍按同一条经验关系外推。"},
{"ice_giant", "冰巨星", "ice giant", "海王星", TypeGroup::kSpecial, "不是恒星",
 RadiusModel::kDegenerate, LumModel::kNone, 3e-5, 2e-4, kNeptuneMassMsun, 0.0, 0.0, false,
 24622.0, kNeptuneMassMsun, 0.05, "近似常数：观测上 0.3~10 倍木星质量之间半径几乎不变",
 "海王星这一档。半径几乎不随质量变，这是观测事实，不是巧合。"},
{"gas_giant", "气态巨行星", "gas giant", "木星", TypeGroup::kSpecial, "不是恒星",
 RadiusModel::kDegenerate, LumModel::kNone, 1e-4, 3e-3, kJupiterMassMsun, 0.0, 0.0, false,
 kMjup_km, kJupiterMassMsun, 0.05, "近似常数：同上",
 "木星这一档。加大质量不会让它明显变大，只会更致密。"},
};
#if defined(__clang__)
#pragma clang diagnostic pop
#endif

constexpr int kTypeCount = static_cast<int>(sizeof(kTypes) / sizeof(kTypes[0]));

/// 太阳系行星表里那些名字 → 类型。只用于把内置行星接进类型体系，
/// 让"谁在发光"这件事对内置天体也走同一条判断。
struct KnownName { const char* name; const char* key; };
const KnownName kKnown[] = {
    {"Sun", "G_V"},
    {"Mercury", "rocky"}, {"Venus", "rocky"}, {"Earth", "rocky"}, {"Mars", "rocky"},
    {"Jupiter", "gas_giant"}, {"Saturn", "gas_giant"},
    {"Uranus", "ice_giant"}, {"Neptune", "ice_giant"},
    {"Pluto", "rocky"},
};

}  // namespace

const BodyType* body_types(int* count) {
    if (count) *count = kTypeCount;
    return kTypes;
}

const BodyType* find_body_type(const std::string& key) {
    for (const auto& t : kTypes)
        if (key == t.key) return &t;
    return nullptr;
}

std::string body_type_keys_joined() {
    std::string s;
    for (int i = 0; i < kTypeCount; ++i) {
        if (i) s += ", ";
        s += kTypes[i].key;
    }
    return s;
}

double sb_radius_km(double t_eff_K, double lum_lsun) {
    if (!(lum_lsun > 0.0) || !(t_eff_K > 0.0)) return 0.0;
    const double ratio = t_eff_K / kSunT_eff_K;
    return kRsun_km * std::sqrt(lum_lsun) / (ratio * ratio);
}

double lum_from_radius_t_eff(double radius_km, double t_eff_K) {
    if (!(radius_km > 0.0) || !(t_eff_K > 0.0)) return 0.0;
    const double r_sun = radius_km / kRsun_km;
    const double ratio = t_eff_K / kSunT_eff_K;
    return r_sun * r_sun * ratio * ratio * ratio * ratio;
}

double body_type_radius_km(const BodyType& t, double mass_msun) {
    if (!(mass_msun > 0.0)) return 0.0;
    switch (t.radius_model) {
        case RadiusModel::kStefanBoltzmann: {
            // R = Rsun · sqrt(L/Lsun) / (T/Tsun)^2 —— 斯特藩-玻尔兹曼的真公式。
            // L 只在**这个分支里**才去求：白矮星是 "半径→光度" 方向，
            // 若在这里无条件先算 L，就会 radius → luminosity → radius 无限递归。
            return sb_radius_km(t.t_eff_K, body_type_luminosity(t, mass_msun));
        }
        case RadiusModel::kDegenerate: {
            if (!(t.m_ref_msun > 0.0) || !(t.r_ref_km > 0.0)) return 0.0;
            return t.r_ref_km * std::pow(mass_msun / t.m_ref_msun, t.p);
        }
        case RadiusModel::kFixed:
            return t.r_ref_km;
        case RadiusModel::kSchwarzschild:
        default: {
            const double m_kg = mass_msun * kMsun_kg;
            return 2.0 * kG_SI * m_kg / (kC_SI * kC_SI) / 1000.0;
        }
    }
}

double body_type_luminosity(const BodyType& t, double mass_msun) {
    switch (t.lum_model) {
        case LumModel::kMassToThe35:
            return stellar_luminosity(mass_msun);
        case LumModel::kFixedL:
            return t.lum_lsun;
        case LumModel::kFromRadiusAndT:
            // L = (R/Rsun)^2 · (T/Tsun)^4：白矮星的半径由简并关系定，光度反过来推。
            // 这里的半径必须走"不依赖光度"的那条路（kDegenerate / kFixed），
            // 否则和 kStefanBoltzmann 互相调用就成了死循环。
            return lum_from_radius_t_eff(body_type_radius_km(t, mass_msun), t.t_eff_K);
        case LumModel::kNone:
        default:
            return 0.0;
    }
}

double body_type_t_eff(const BodyType& t) {
    return t.emits_light ? t.t_eff_K : 0.0;
}

const BodyType* known_body_type(const std::string& name) {
    for (const auto& k : kKnown)
        if (name == k.name) return find_body_type(k.key);
    return nullptr;
}

bool body_emits_light(double mass_msun, const BodyType* type) {
    if (type) return type->emits_light;
    // 没声明类型：只能按质量判。氢燃烧下限约 0.08 M☉。
    return mass_msun >= kHydrogenBurningLimit_Msun;
}

double variability_factor(const BodyType& t, double t_years, double phase) {
    if (!t.var.on || !(t.var.period_days > 0.0)) return 1.0;
    // 星等是对数尺度，所以振幅要**乘**不要加：factor = 10^(0.4·Δm·sin/2)。
    // 这样峰值/谷值之比恰好是 10^(0.4Δm)（星等振幅的定义），
    // 而且永远为正 —— 用 1 + A·sin 的话，米拉那种 6 个星等的振幅会算出负光度。
    const double period_yr = t.var.period_days / kDay_per_yr;
    const double s = std::sin(2.0 * 3.14159265358979323846 * (t_years / period_yr) + phase);
    return std::pow(10.0, 0.4 * t.var.amplitude_mag * s / 2.0);
}

}  // namespace starpivot
