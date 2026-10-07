# 对标契约 —— 钢铁雄心4 / 无尽的拉格朗日 / 星际猎人

本文件是**契约**，不是设计随笔。并行实现时以它为准；实现与本文件不一致时，
先改本文件再改代码（否则判据与实现会对不上，且没人知道哪个是权威）。

日期：2026-10-05

## 0. 不可动的硬约束

1. **页面一个数都不算**。凡是要显示的数值，必须来自 C++ 内核 JSON 回显。
   页面只做「读字段 + 翻成人话 + 画」。这条压倒下面所有玩法需求。
2. **零外部依赖**、四页共用 48 个同名设计令牌且**不得改 `:root` 值**。
3. `prefers-reduced-motion: reduce` 兜底不能少。
4. 无障碍：canvas 需 `role="img"` + `aria-label`；`aria-live` 只给低频状态文本，
   **不得**给每帧变化的元素；标题层级用 `aria-level`。
5. 并行 writer 的文件集必须互不重叠。

## 1. 为什么只新增两个内核模块

复核结论（推翻了一开始「五项都要新内核」的估计）：

| 玩法 | 内核代价 | 理由 |
|---|---|---|
| 预测轨道 / 计划模式 | **零** | 短程 nbody 预演：同样的 payload + 更短 `years`/更少 `samples`，轨迹点全部是内核回显 |
| 时间压缩档位 | **零** | `samples` 已是旋钮，只是缺「跨度」这层语义 |
| 协议任务链 | **零** | 判定全部读现有回显（`diagnostics.energy_drift`、事件表、轨道根数比值） |
| 方案保存与分享 | **零** | 复用现有 share-hash 机制，只是从「存回去」升级成「可命名、可传播的方案」 |
| 引力锚点 L1–L5 | **需要** | 求解器目前只活在 `tests/fixtures.hpp`，要提升成内核 API |
| 随机宇宙种子 | **需要** | 随机数必须在核心里，页面生成元素就违反硬约束 1 |

## 2. 新内核模块 A：`lagrange`

**来源**：`tests/fixtures.hpp` 里的 `sun_earth_l1()`（五次方程 + Newton 迭代，
Hill 半径做种子）与 `sun_earth_l4()`（等边三角形第三顶点）。两者已被
`tests/test_lagrange.cpp`（4 个 TEST）与 `tools/verify_baselines.cpp` Baseline 4 验过。
**动作**：提升为 `include/starpivot/lagrange.hpp` + `src/lagrange.cpp`，
补 L2/L3（共线）与 L5，并给出 Routh 判据。

### CLI

```
starpivot lagrange --primary <name> --secondary <name> \
                   [--mass-primary <msun>] [--mass-secondary <msun>] [--a-au <a>]
```

`--a-au` 缺省时，从 primary/secondary 各自的质量与互引推出**引力束缚下的间距**
不可靠（需要初值），所以**必须显式给 `--a-au`**，缺省 1.0 AU 并在输出里
标明 `a_source: "given" | "default"`。

### JSON 契约

```json
{
  "status": "ok",
  "command": "lagrange",
  "primary": "Sun", "secondary": "Earth",
  "a_au": 1.0, "a_km": 149597870.7,
  "a_source": "given",
  "mu": 3.003e-06,
  "routh_limit": 0.0385208,
  "triangular_stable": true,
  "collinear_stable": false,
  "points": [
    {
      "key": "L1", "name_zh": "内侧拉格朗日点",
      "note_zh": "在两星连线上。线性不稳定：任何一点点扰动（甚至数值误差）都会让它指数级离开，所以真实航天器需要周期性维持。",
      "stable": false,
      "pos_au": [0.990029597372, 0.0, 0.0],
      "pos_km": [148106319.7, 0.0, 0.0],
      "from_primary_au": 0.990029597372,
      "from_secondary_au": 0.00997040262785,
      "residual": 5.586e-16
    }
  ]
}
```

**⚠ 报告参考系**：内核在**主星位于原点**的惯性系下返回坐标（次星在 (a,0,0)）。
求解在重心系里做（L1 距主星 0.990029597372 a），重心系到本参考系的平移是 **+μ·a**。
对日-地而言 μ·a = 3.0e-6 a，**大于 `%.6g` 的量化步长** —— 漏掉这次平移会让每个坐标
偏 3e-6，比任何有意义的容差都大。判据里必须显式做这次平移，不能假设内核的参考系。

上面这些数字是**实际输出**（日-地，a = 1 AU），不是估值。
（本文件早期版本写的 `pos_au: 0.9900051` 是 Hill 半径近似值，是**错的** ——
`tests/fixtures.hpp` 的五次方程解与内核的二分解独立吻合到 1e-16。真值是
0.990029597372 a，距地球 0.0099704 a ≈ 1.49e6 km。已按实测更正。）

`points` 恒为 5 条，顺序 L1,L2,L3,L4,L5。`L1/L2/L3` 沿主星→次星连线；
`L4/L5` 在等边三角形的另两个顶点，`pos_au` 已在共转参考系下展开到惯性系
（主星在 +x，次星在 a 处，L4 在 (a/2, +√3a/2)，L5 在 (a/2, −√3a/2)）。

`stable` 的含义要写进 note：**L4/L5 的稳定是有条件的**（Routh 判据
`mu < 0.0385208`），`triangular_stable` 就是这个条件的回显；
L1/L2/L3 恒为 false，页面不得把 L4 的稳定说成「绝对安全」。

### 网关

`POST /api/lagrange`，body `{primary, secondary, mass_primary, mass_secondary, a_au}`，
网关只拼 argv、只转发 JSON（与 `api_nbody` 同一套做法）。

## 3. 新内核模块 B：`genesis`

### CLI

```
starpivot genesis --seed <string> --seed-hex <hex> [--bodies 2..8]
```

`--seed` 与 `--seed-hex` 二选一。**网关走的是 `--seed-hex`**：Windows 上 argv
按 ANSI 代码页从宽字符命令行转换，非 ASCII 会在到达 `main()` 之前被改写
（实测中文种子的回显不逐字相同）。网关把 UTF-8 字节编成十六进制传、内核解码
后哈希，就完全绕开了 argv 的编码转换。

`--seed` 传非 ASCII 时内核仍会返回，但回执里 `seed_utf8` 为 `false`、非法字节
被替换成 U+FFFD。目的是**保证回执永远是合法 UTF-8** —— 否则按 UTF-8 解码的一方
会直接抛异常，"种子不支持中文"会变成"接口报了个看不懂的错"。

`--bodies` 缺省 4，越界**明确报错**（rc=1）而不夹取。`--seed` 缺失或为空
**明确报错**（rc=1）—— 不静默生成一套"默认宇宙"，那比报错坏得多
（用户以为是自己点到的种子，实际拿到的是别人的）。

### JSON 契约

```json
{
  "status": "ok", "command": "genesis",
  "seed": "2026-10-05",
  "seed_hash": "0xf339e2423dbf19bb",
  "seed_source": "hex",
  "seed_utf8": true,
  "primary_name": "Sun", "primary_mass_msun": 1,
  "placement_attempts": 3,
  "stability": {
    "min_sep_ratio": 0.6450317529,
    "min_margin": 3.367820667,
    "criterion": "gladman",
    "note": "min_margin 为最紧的一对实际间距比除以 Gladman 临界值，大于 1 才认定稳定"
  },
  "bodies": [
    { "name":"G1","type":"ice_giant","type_name":"冰巨星",
      "mass_msun":0.0001805120355,"a_au":2.176216837,"e":0.01016194589,
      "inc_deg":3.7714494,"raan_deg":13.685163,"argp_deg":99.19316,
      "M0_deg":261.77475,"radius_km":26215.15427,"t_eff_K":0,"lum_lsun":0 }
  ]
}
```

`placement_attempts` 为负数表示随机重抽没成功、走了确定性兜底阶梯
（`a_i = 0.40 · 1.45^i`）。页面可据此如实说明"这一局不是随机的"。

页面拿到的 `bodies` 字段名与 `/api/nbody` 的自定义行星**完全一致**，
所以可以直接塞回现有 payload 走 nbody —— 不新增第二条计算通路。

生成器必须保证物理合法：半长轴避开彼此的 Hill 半径（否则一开局就碰撞），
偏心率 < 1，质量取自内核类型表（不自造质量）。

## 4. 前端新增（全部零内核）

### 4.1 协议任务链（对标 天梯行动 / 剧本 / 协议）

对标三家在这一点上完全一致：把「看」变成「要做出来」。

- 新增 `#protocols` 卡片，列出一组可勾选目标。
- 每个目标 = `{id, title, 目标条件(读现有回显), 达成判定, 难度}`。
- 判定一律读 `data.diagnostics.energy_drift`、事件表、根数比值，**不新算**。
- 达成状态持久化到现有 session（不新增存储机制）。
- 负样本要求：把判定换成空指路，判据必须判不通过（沿用 `_probe_play_modes.js` 的做法）。

### 4.2 时间压缩档位

- 现有 `#speed` 是播放帧率（2–120）。**不删它**。
- 新增「跨度」选择：1 年 / 10 年 / 100 年 / 1000 年，映射到 `years` + `samples`。
- 跨度切换要真的重下发 payload 并重算（判据要验这一点）。
- 页面上必须写清「跨度」与「播放速度」是两件事。

### 4.3 方案保存与分享

- 现有 share-hash 机制升级：可命名、可收藏、可再载入。
- 方案 = 初值 + 积分器 + 参数 + 跨度。载入后逐项还原。
- 不得冲掉对方自己的会话（沿用现有 share 逻辑的既有行为）。

### 4.4 引力锚点战略图

- 新增 canvas `#anchorv`，`role="img"` + `aria-label`。
- 五个点全部来自 `/api/lagrange` 的回显；页面只按坐标画。
- 与现有选中光晕、事件表闪烁共用同一套 `tWin` 与帧号。
- 点击锚点 → 显示内核给的 note 与稳定性判据（不自己解释）。

### 4.5 预测轨道 / 计划模式

- 拖动天体或改参数 → **松手前**发一次短程 `/api/nbody` 预演 → 画幽灵轨迹。
- 幽灵轨迹的点 100% 来自那次预演回执，页面不做插值/外推。
- 「确认执行」才真正改；「放弃」清掉幽灵。
- 预演请求必须可取消（`AbortController`，与现有 `fetchT` 的 `opts.signal` 串联）。

### 4.6 随机宇宙种子

- 输入任意字符串 → `POST /api/genesis` → 拿回 `bodies` → 塞进现有 payload。
- 页面上标明「今天的种子」由内核按日期字符串生成，**页面不自己算日期种子**。

## 5. 判据（先红后绿）

新增探针，全部放仓库根，与既有 `_*` 命名一致：

| 探针 | 覆盖 |
|---|---|
| `_probe_protocols.js` | 任务链、达成判定、持久化、负样本 |
| `_probe_timescale.js` | 跨度档位、真的重算、跨度≠帧率的说明 |
| `_probe_anchors.js` | 五点齐全、来自回显、稳定性文案不夸大、画布有 aria |
| `_probe_predict.js` | 幽灵轨迹来自预演回执、确认/放弃、可取消 |
| `_probe_seeded.js` | 同 seed 逐位复现、异 seed 不同、生成物物理合法 |
| `_probe_scheme.js` | 命名/收藏/再载入、不冲掉自己会话 |

另加内核侧判据：`_probe_lagrange_kernel.py`（独立 Python 复算 L1–L5，
不调内核自己那套公式）与 `_probe_genesis_kernel.py`（同 seed 复现 + 物理合法性）。

## 6. 回归红线

既有 22 条判据（8 条 A 层静态 + 14 条 jsdom）必须**一条不掉**。
新增功能不得让任何既有判据变红。若某条判据本身写错了要改，
必须在报告里单独列出「改了哪条判据、为什么」。
