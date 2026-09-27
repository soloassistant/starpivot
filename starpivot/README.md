# starpivot — 行星与轨道动力学内核

N 体引力、Hermite 4 阶积分器、辛积分器、轨道根数、行星自转/岁差/潮汐、时间尺度、
带谐重力/大气阻力/太阳光压。**C++17，标准库，零第三方数值依赖。**

## 语言分工（硬性）

| 层 | 语言 | 内容 |
|---|---|---|
| **物理内核** | **C++17** | `src/gravity.cpp`、`hermite.cpp`、`leapfrog.cpp`、`elements.cpp`、`spin.cpp`、`time.cpp`、`perturb.cpp`、`sgp4.cpp`（SGP4/SDP4 双精度传播器） |
| Python | 仅三种角色 | pybind11 绑定、pytest 测试、`.xsys` 场景生成/校验 |

Python 不参与任何数值积分。核心循环用 Python 写即视为不合格——性能不可达，也无法进 CUDA/渲染层。
没有 Eigen / GSL / numpy / scipy，内核只用 `<cmath>`、`<vector>`、`<string>`。

## 两条单位线（混用即 bug）

| 子系统 | 单位 |
|---|---|
| N 体内核（AU 体系） | AU / M☉ / yr |
| 摄动、时间、CLI | km / kg / s，角度内部用弧度、接口用度 |

## 命令行

```bash
starpivot propagate --a 7078 --e 0.001 --inc 98.2 --hours 24 --step 30
starpivot j2 --a 7078 --inc 98.2
starpivot elements --r 7000,0,0 --v 0,7.546,1.0
starpivot verify-tle --self-test          # 跑 Vallado 附录 D 全 6 官方向量
starpivot verify-tle --line1 "1 ..." --line2 "2 ..." --tsince 0,120   # 真实 TLE
starpivot conj --line1 "1 ..." --line2 "2 ..." --line3 "1 ..." --line4 "2 ..." --threshold-km 1   # 碰撞预警：最近接近
starpivot groundtrack --line1 "1 ..." --line2 "2 ..." --minutes 180          # 星下点地面轨迹（可双星）
starpivot nbody --scenario solar --years 50 --samples 200    # 太阳系九行星 N 体模拟
starpivot nbody --scenario figure8 --samples 400             # 三体 figure-8 周期解
starpivot nbody --scenario custom --solar none --body "A,1,0,0,0,0,0,0.5" \
                --body "B,1,0,180,0,0,180,0.5"               # 没有太阳的纯二体宇宙
starpivot nbody --scenario solar --set "Jupiter,mass_msun=9.547919e-3"  # 改星体质量/半径/密度
starpivot about
```

输出全部是 JSON，`viewer/index.html` 直接消费（离线可跑，内嵌 Natural Earth 陆地边界）。
CLI 报告的是**周期平均后的长期漂移**，不是单点密切差——后者在近圆轨道上会被
短周期振荡（a 约 ±19 km、ω 数十度）淹没。

## verify-tle：SGP4/SDP4 双精度传播器（已实现并验证）

`verify-tle` 把 NORAD TLE 解析 + SGP4/SDP4 传播接到 CLI，**没在没对上官方向量前出货**：
近地轨道（周期 < 225 min）走 SGP4，深空（含 24h 共振）走 SDP4 深空积分器。
实现遵循 Hoots & Roehrich《Spacetrack Report #3》并采用 Vallado et al. AIAA 2006-6753 Rev 1 的修正。

```bash
# 1) 自检：Vallado 附录 D 全 6 官方向量（3 近地 + 3 深空）
starpivot verify-tle --self-test
#   => all_passed: true，最大位置误差 < 1e-6 km、最大速度误差 < 1e-9 km/s

# 2) 真实 TLE：从标准输入或 --line1/--line2 喂两行，--tsince 可逗号分隔多个时刻
echo "1 25544U 98067A   26267.14191496  .00009634  00000+0  18116-3 0  9999
2 25544  51.6318 170.3464 0004691 174.6338 185.4701 15.49258637587098" | \
  starpivot verify-tle --tsince 0,120,240,360
#   => classification: near-earth，轨道高度≈423 km、周期≈92.95 min（与现网一致）
```

输出 JSON 含 `classification`、`input`（satnum / intl_designator / epoch_utc / bstar / ecco / inc / raan / argp / mo / no_kozai / period_min / isimp）和
`states`（每个 tsince 的 r_km / v_kms / r_mag / v_mag）。深空模式会自动把 `tsince` 升序传播（SDP4 共振积分器要求 tsince 单调递增），但按用户输入顺序回显。

## conj：碰撞预警（最近接近筛选）

`conj` 是 TLE 生态的第一个下游应用：给定两个 TLE，分别用已验证的 SGP4/SDP4 传播，
在 A 星历为基准的时长窗口内扫描相对距离，找出**最近接近时刻（TCA）与最近距离**，
并做粗筛告警。这是碰撞预警（conjunction assessment）的核心一步——TLE 之所以要做，
就是为了进这条工作流。

```bash
# 真实两颗星：从标准输入喂 4 行（A1 A2 B1 B2），或 --line1..--line4 分别指定
echo "1 25544U 98067A   26267.14191496  .00009634  00000+0  18116-3 0  9999
2 25544  51.6318 170.3464 0004691 174.6338 185.4701 15.49258637587098
1 26407U 00040A   26267.25377767 -.00000003  00000+0  00000+0 0  9992
2 26407  54.8367 211.2307 0117723 304.0216 229.1692  2.00558441191930" | \
  starpivot conj --window-min 1440 --step-min 1 --threshold-km 1
#   => tca_utc、miss_distance_km、rel_speed_kms、alert（miss < 阈值时为 true）
```

实现要点：窗口以**主对象（A）历元**为基准（分钟）；从对象 B 历元到 A 历元存在偏移时，
用 `tsince_b = tca + (epoch_a_jd − epoch_b_jd) × 1440` 折算，保证两颗星各自在自己的历元系里传播。
搜索用「粗扫 + 两轮细化」（每轮重初始化传播器，满足 SDP4 共振积分器对 tsince 单调递增的要求），
无需解析导数即可把 TCA 定位到亚秒级。输出 JSON 含 `object_a/b`（含 regime 分类）、
`result`（tca_utc / miss_distance_km / rel_speed_kms / 两星在 TCA 的状态）与可选 `alert`。
**注意**：此处只做几何最近距离，**不含协方差**——正式告警必须叠加硬球半径 + 协方差椭圆门槛，
否则不能据此发布碰撞预警。

### 真实数据工具：`tools/find_close_approaches.py`

从 Celestrak 拉指定星座组的**真实 TLE**，按轨道根数（含**公共历元相位折算**——两星历元差
29 min 在 LEO 就是 ~106° 相位差，不折算则"根数接近"完全不等于"物理接近"）初筛候选对，
再逐对调用真实 `conj` 传播，输出最近真实接近对排行与可直接复制的命令：

```bash
python tools/find_close_approaches.py --groups starlink --top 25 --threshold-km 50
# 也可 --groups iridium,globalstar,orbcomm（默认）；--exe 可指定 starpivot 路径
```

实测（2026-09-25，Starlink 组 10687 颗、按历元取最新 1500 颗初筛 25 对）：真实最近对为
**NORAD 66842 × 66826**（2025-280 同批发射、同面同壳层），24h 内最近 **105.8 km**、
相对速度仅 **0.115 km/s**——两颗真实在轨 Starlink 前后跟随。Python 侧只做数据抓取与
根数初筛（与 `xsys_gen.py` 同类的合法用途），所有轨道计算委托给 C++ 内核。

### 网页试用：`tools/webapp.py`

```bash
python tools/webapp.py --port 8765    # 然后打开 http://localhost:8765
```

单端口本地试用服务：serve `viewer/` 静态页，并提供 `/api/conj`、`/api/verify-tle`、
`/api/find-close` 三个接口——**纯转发层**，把请求原样交给 C++ CLI 或
`find_close_approaches.py`，服务端零数值逻辑。页面含「碰撞预警」面板：
输入两份 TLE → 运行 conj → 展示 miss / TCA / 相对速度 / 告警判定 / TCA 时刻双星状态（TEME）；
也可一键从真实编目（Iridium / Globalstar / Orbcomm 或 Starlink）筛出当前最近的真实接近对，
点击排行行即载入该对。页面打开即做健康检查，直接双击 HTML（file://）会提示先启动服务。

### 地图：星下点地面轨迹（`groundtrack` + conj 内置轨迹）

`groundtrack` 把已验证的 SGP4/SDP4 输出经 GMST 地球自转转为星下点经纬度：

```bash
starpivot groundtrack --line1 "1 ..." --line2 "2 ..." --minutes 180 --step-min 1
# 两份 TLE（--line3/--line4 或 stdin 4 行）→ 双轨迹输出，同一 UTC 窗口对齐，可直接叠画
```

- 星下点为**球面地球**（忽略扁率，纬度偏差最大约 21 km / 0.19°）——够画轨迹与态势图，
  不够做天线指向；JSON `note` 与页面图例均如实声明。
- 验证口径（`test_groundtrack`，4 测试）：纬度硬界限 |lat| ≤ 倾角 + 0.05°；ISS 相邻升交点
  经度西退 ≈ −23.6°/圈（地球自转 −23.3° + RAAN 回归 −0.3°；丢 GMST 项或符号写反立刻爆）；
  星下点 (lat, lon, alt) 重建 ECEF 闭合 < 1e-6 km；GPS（SDP4 深空）轨迹 tsince 单调递增。
- 网页：`index.html` 碰撞预警面板运行 conj 后自动显示 **TCA ±90 min 双星地面轨迹地图**
  （Natural Earth 陆地边界 + 红/蓝轨迹 + TCA 位置五角星标记）——数据全部来自 CLI 的
  `ground_track` / `subpoint_a` / `subpoint_b` 字段，页面只画。
- `POST /api/groundtrack`：转发 CLI，页面/脚本可直接取星下点序列。

## nbody：N 体宇宙模拟（辛积分 + 网页动画）

`nbody` 把已验证的 N 体内核（`Leapfrog2` KDK 辛积分器）接到 CLI，附网页交互动画：

```bash
# 太阳系：九行星 J2000 日心平根数（Standish/JPL 近似）→ 状态矢量，随一次辛积分演化
starpivot nbody --scenario solar --years 50 --samples 200
#   => 每颗行星始终停留在各自的近日点-远日点带内（物理界限检查）

# figure-8 三体周期解（Chenciner–Montgomery）：等质量三星走 8 字
starpivot nbody --scenario figure8 --samples 400
#   => 一个周期 T=6.32591398 后闭合 |Δp| ≈ 1.1e-4 AU，能量漂移 ≈ 3.3e-15

# 自定义宇宙：太阳 + 你给的行星（日心开普勒根数；--body 可重复，最多 16 个）
starpivot nbody --scenario custom --body "PlanetX,30,0.3,25,80,200,10,1e-5"
# 叠加到真实太阳系（如 Planet Nine / 恒星伴星；大质量伴星会使质心显著偏移，属真实物理）
starpivot nbody --scenario solar --body "PlanetNine,400,0.2,18,90,150,200,1.517e-5"
#   --body 格式: name,a_AU,e,inc_deg,raan_deg,argp_deg,M0_deg,mass_Msun
#   质量可为 0（试验粒子）；e 必须 [0,1)；custom 场景 dt 自动取 min(0.001, 最短周期/200)
```

### 太阳系可以选：加 / 只加太阳 / 完全不加（`--solar`）

`--scenario custom` 默认同时摆上太阳和八大行星（+冥王星）作背景，用 `--solar` 可以三选一：

| `--solar` | 场里有什么 | 适合 |
|---|---|---|
| `full`（默认） | 太阳 + 八大行星 + 冥王星 + 我的天体 | 在真实太阳系上加一颗未知行星 |
| `sun` | 只有太阳 + 我的天体 | 我要一颗干净的中心星，不要行星噪声 |
| `none` | **只有我的天体** | 自己搭一个没有太阳的宇宙 |

```bash
# 只放太阳：行星表不生效，天体绕太阳走
starpivot nbody --scenario custom --solar sun --body "X,1,0,0,0,0,0,1e-6"

# 完全不放太阳系：两颗等质量恒星互为引力源，绕共同质心转（周期 1.000000 yr）
starpivot nbody --scenario custom --solar none \
  --body "StarA,1,0,0,0,0,0,0.5" --body "StarB,1,0,180,0,0,180,0.5"
#   => 实测一个周期后回到出发点偏差 4.1e-5 AU，动量漂移 2.7e-20
```

**`none` 是真实的多体设置，不是"少了太阳的太阳系"，务必知道它的含义**：自定义天体的
初值仍按日心开普勒根数铺在椭圆上，但 `--solar none` 时原点**没有引力源**，之后天体只
互相吸引。质量 negligible 时表现为直线飞散（默认 A/B 在 5 年内间距 0.63 → 24.8 AU，
能量漂移 2.9e-11，积分本身没问题）。想看到束缚轨道，把某个天体的质量调到 ~1 M☉ 当
中心星即可——实测那样轨道仍是一个闭合开普勒椭圆（一个周期后偏差 7.3e-5 AU）。
`--solar none` 且不给任何 `--body` 会直接报错，因为那样系统里没有任何引力源。

输出 JSON：`bodies`（含质量；自定义天体额外回显 `ic_heliocentric` 根数）、`frames`
（采样时刻 + 各体位置）、`diagnostics`（`energy0/energy1/energy_drift/momentum_drift`）。
**辛积分器的能量误差是有界振荡而非累积漂移**——诊断数字给出的是端点差，页面 verdict
面板可直接读到内核实测值。

自定义行星（`--body`，网页端在 universe.html 选「自定义」即可编辑）：

- 初值是与行星同一套的日心开普勒根数（`elem_to_state`，μ = G×(1+m)），随后整体质心化——
  大质量伴星（恒星伴星、行星九号）会让内行星整体绕质心摆动，这是真实物理不是 bug。
- 内核校验：a>0、e∈[0,1)、质量≥0（0 = 试验粒子，此时 e0=0，能量漂移退化为绝对差）。
- 物理界限检查：新增天体全程停留在 a(1−e) ~ a(1+e) 的近日点-远日点带内（custom/solar
  场景实测通过，如 a=1 e=0.02 的 Earth2 十年保持 0.980~1.02 AU）。

物理要点：

- AU / M☉ / yr 单位线，`G = 4π²`；行星 μ = G×(1+m_planet)（Standish 近似含质量修正）。
- Kepler 根数 → 状态矢量：Newton 迭代解开普勒方程 `M = E − e·sinE`，近焦平面速度
  `vx' = −√(μa)·sinE/r`、`vy' = +√(μa)·√(1−e²)·cosE/r`，再 3-1-3 欧拉旋转到黄道系。
- **`vy'` 的 cosE 因子不可丢**：丢掉后能量仍守恒（位置对、速度错），轨道却整体跑飞
  （金星 50 年跑到 2.5 AU）——守恒量检查发现不了，必须用近日点-远日点带检查。

### 网页动画：`viewer/universe.html`

启动 `tools/webapp.py` 后打开 http://localhost:8765/universe.html（首页 header 也有入口）。
太阳系 / figure-8 / **自定义（行星编辑器 + 太阳系三档开关）**一键切换；
自定义场景里「太阳系」下拉可以选 **full / sun / none**，切到 `none` 时页面会如实提示
"没有中心天体"——不替用户假装那还是个太阳系。年数、帧数、播放速度可调。

画布：**自适应窗口（≈72vh）、滚轮缩放（以光标为不动点）、拖拽平移、双击复位、⛶ 一键全屏**。
投影是正交的，带 **yaw（绕黄道轴）** 与倾角两个自由度：**点击任意星体，视角会自动转到它
自己那条轨道平面的正对面**——内核在 JSON 的 `ic_heliocentric` 里回显 `inc_deg / raan_deg`，
页面按 `yaw = −Ω, pitch = −i` 反解相机角（数学上已验证视线轴与轨道法向平行，叉积相对误差
< 1e-12），再点一次同一个星体切回黄道俯视，拖倾角滑杆则手动接管。
绘制全轨迹（暗）+ 已走过轨迹（亮）、太阳径向渐变光晕、逐体标签与星空背景。
`POST /api/nbody` 纯转发 CLI，页面只做绘制——「页面只绘制、内核才算数」。

**演化的可视化**：已走过的轨迹按**当时的演化阶**分段着色（换阶即换色，段与段之间接上不留断口），
所以"演化"是沿着路径发生的、看得见的；`stage ≥ 1` 的天体加一道阶色外圈，
`stage ≥ 6` 再加一层柔光。图例里给出 9 级色阶（阶名直接用内核回显的 `stage_names`，
页面不自己抄一份）。下方「每颗星体的演化」面板逐帧显示每颗星的判定、`S / T_eq / T_surf`、
当前阶、进度条与"达到该阶的时刻"——**这些数全部来自内核，页面一处物理常量都不参与运算**
（有判据专门检查：把页面脚本里的字符串剥掉后，不该再出现 278.6 / 273 / 373 / 3.5 / 0.306）。
面板底部把两层口径（哪层是真公式、哪层是编排）与本次生效的常量一并写出，常量取的是内核回显值。

### 四种算法同场对比 + 能量误差曲线（对标 orbit-lab / Gravity / orbitme）

参照的四个同类项目里，**三个都把"换积分器看能量曲线"当核心卖点**
（orbit-lab 三套同场对比 + 实时误差曲线；Gravity 有 Kepler↔N-body 开关 + 实时能量漂移；
orbitme 有 Symplectic Euler↔RK4）。我们内核里本来就有两个积分器（`Leapfrog2` 辛、
`Hermite4` 四阶非辛）但只用了蛙跳，于是把它们都接了出来，再加上两个：

```bash
starpivot nbody --scenario solar --years 50 --integrator leapfrog   # 默认
starpivot nbody --scenario solar --years 50 --integrator hermite
starpivot nbody --scenario solar --years 50 --integrator euler
starpivot nbody --scenario solar --years 50 --integrator kepler
```

响应里回显逐帧的 `energy_series`（相对能量误差），页面直接画成曲线。
**下面这四个数字都是实测的，不是照着教科书说的**：

| | 50 年（dt=0.001）能量误差峰值 | 200 年 → 20000 年（dt=0.01） |
|---|---|---|
| 蛙跳（辛 · 2 阶） | 3.39e-7 | 2.77e-5 → **2.86e-5**（几乎不变 = 有界） |
| Hermite4（非辛 · 4 阶） | **1.04e-10**（单步最准） | 1.35e-5 → 7.87e-4（**涨 58 倍** = 漂移） |
| 半隐式欧拉（辛 · 1 阶） | 3.75e-5 | — |
| 开普勒解析（不积分） | 3.89e-4（最大，见下） | — |

两个结论都不是"想当然"能得到的，而是判据逼出来的：

1. **50 年这个跨度上，非辛的 Hermite4 反而比蛙跳准两个量级。**
   第一版判据写的是"非辛就会更差"，被实测直接推翻。把跨度拉到 20000 年，
   蛙跳的峰值几乎不动、Hermite4 涨了 58 倍并反超 —— **交叉点确实存在，但要跑到它才看得见**。
   这一条现在就是页面上第 6 步导览讲的事："单步精度和长期稳定性是两件事"。
2. **开普勒解析的曲线不贴底，而且误差最大。** 因为它不做积分、只按每个天体自己的椭圆摆位，
   等于"假设没有互相扰动"—— 全系统的总能量本来就不守恒。**它与 N 体结果的差就是扰动本身**：
   太阳系 50 年后地球的位置差 7.07e-3 AU。这条曲线讲的是另一件事，页面上分开标注。

解析模式本身是精确的（判据用 SI 独立复算过）：逐帧都在椭圆 `r = a(1-e²)/(1+e·cosν)` 上；
用开普勒第三定律算出 T 后跑 10 个整周期，回到出发点偏差 **0.00e+0 AU**。

### 导览（第一次打开自动进）

参照 `qunabu/Gravity` 的 43 步导览做法（先讲"为什么"，再放开自由探索），做了 12 步 ——
但**只写这个引擎真能演示的东西**：我们的内核没有磁场、潮汐、洛希极限这些模型，
所以不写那几步，宁可少也不演假的。每一步都有 deep link：

```
#step-welcome           欢迎 · 这页能干什么（唯一不动场景的一步）
#step-what-is-gravity   引力是什么（两颗恒星互相绕）
#step-why-no-fall       为什么地球不会掉进太阳（轨道 = 一直掉但掉过头）
#step-figure8           三个天体也能有稳定轨道
#step-methods           怎么算这个问题：四种算法
#step-drift             数值方法为什么会漂（切到欧拉，看曲线往上爬）
#step-higher-order      阶数高 ≠ 长期更好（切到 Hermite4）
#step-kepler            解析轨道 vs 真实扰动
#step-collide           撞上会发生什么（切到撞击场景，看事件时间线）
#step-types             想放什么就放什么（类型调色板 + H-R 图）
#step-life              哪一颗上可能有生命（演化面板）
#step-share             把它带走（分享链接 + 等价 CLI 命令）
```

**第 1 步（欢迎页）刻意不改任何状态。** 第一版不是这样：导览在第一次打开时自动进入，
第 1 步就把场景换成双星系统 —— 结果是新用户看到的"开机画面"不是太阳系，而是被导览劫持的
双星，而且顺手把这个场景写进了他的存档。现在第 1 步只讲不动作，从第 2 步起才换场景，
用户自己按下一步来触发。这个改动是回归判据逼出来的（5 个页面判据同时挂掉，指向同一处）。

导览里的"换算法"是**真的换算法**（会重新调内核），不是只换文字 —— 判据专门钉了这一点。
第一次打开（没有存档）自动开；之后不打扰，只在工具行留一个「▶ 开始导览」。
deep link 直接把网址发给别人就能落在同一步。

### 另外三个从参照项目拿来的东西

- **导出 CSV**（来自 `timetravel0/SolarSystem` 的 telemetry 导出）：每行一帧、每颗天体三列坐标，
  外加逐帧能量误差。
- **预设「地月系统」**：用 `--primary` 把地球当参考系，月球 a=0.00257 AU、e=0.0549、i=5.145°
  都是真实值，算出来的周期 ≈ 27.3 天。
- **预设「轨道共振 1:2:4」**：半长轴比 1 : 2^(2/3) : 4^(2/3) ⇒ 周期比正好 1:2:4（拉普拉斯共振）。

### 恒星分类的四个维度（39 个可放类型）

天文学上恒星有四种常见分类方式，内核把它们都做进了类型表（`starpivot catalog` 终端可查）：

| 维度 | 内容 | 本表里的类型 |
|---|---|---|
| 1 按光谱型（表面温度） | O B A F G K M（热→冷）+ 特殊型 | `O_V` `B_V` `A_V` `F_V` `G_V` `K_V` `M_V` `WR`（沃尔夫-拉叶星）`carbon`（碳星） |
| 2 按光度与大小 | 光度级 VI~0 | `sd`(亚矮星) `subgiant`(亚巨星) `G_III` `K_III` `M_III`(红巨星) `B_II` `K_II`(亮巨星) `O_I`…`M_I`(超巨星) `M_0`(红特超巨星) `B_0`(蓝特超巨星) |
| 3 按演化阶段 | 一生各阶段 | `pre_main`(原恒星) `white_dwarf` `neutron_star` `black_hole` |
| 4 按特殊性质 | 变星 / 致密天体 / 古老恒星 | `cepheid` `rr_lyrae` `mira` `pulsar` `magnetar` `metal_poor`，另有行星类作对照 |

**四个维度是交叉的**（红巨星同时是 M 型、III 级、晚期），所以每个类型都带一个 `also_in` 字段，
标明它在别的维度里算什么 —— 页面直接显示这句话。

**半径不再靠查表，而是用真公式推**：类型给出有效温度 `T` 与光度 `L`，半径由
斯特藩–玻尔兹曼 `R = R☉·√(L/L☉)/(T/T☉)²` 得出（判据用 SI 单位独立复算）。效果是自洽的：

| 类型 | 本模型半径 | 真实天体 |
|---|---|---|
| `G_V`（太阳） | 1.0000 R☉ | 1.0000 R☉（整套口径的锚点） |
| `M_V`（0.2 M☉ 红矮星） | 0.195 R☉ | 比邻星 0.154 R☉ |
| `K_III`（大角星） | 20.6 R☉ | ~25 R☉ |
| `B_I`（参宿七） | 78 R☉ | ~78 R☉ |
| `M_I`（参宿四） | 862 R☉ | 760–1000 R☉ |
| `M_0`（盾牌座 UY） | 1679 R☉ | ~1708 R☉（差 1.7%） |
| `white_dwarf`（天狼星 B） | 0.0127 R☉ | 0.0127 R☉ |
| `black_hole`（10 M☉） | 29.53 km | 史瓦西半径 2GM/c² |

四条半径路径各有出处：**斯特藩–玻尔兹曼**（绝大多数恒星）、**简并关系** R ∝ M^(-1/3)
（白矮星，越重越小）、**观测典型值**（中子星 / 脉冲星 / 磁星，物态方程至今未定）、
**史瓦西半径**（黑洞）。每条都写在类型的 `radius_formula` 与 `source` 里。

### 变星：光度真的随时间变，行星跟着一起变

`cepheid`（造父变星）、`rr_lyrae`（天琴座 RR 型）、`mira`（米拉型）带光变参数
（周期 + 星等振幅），内核让**光度按时间脉动**，辐照度求和那一层直接用 `L(t)`：

- 因子用**乘性**形式 `10^(0.4·Δm·sin/2)`（星等是对数尺度，而且这样永远为正 ——
  用 `1 + A·sin` 的话，米拉那种 6 个星等的振幅会算出**负光度**）；
- 峰值/谷值之比恰好是 `10^(0.4Δm)`（判据核过）；
- 行星的 `S(t)` 逐帧与 `L(t)/r(t)²` 独立复算一致（最大偏差 < 1e-3）；
- 内核回显**逐帧光度序列**，页面据此让那颗星在画面上真的变亮变暗，
  H-R 图上的点也跟着上下移动；
- 真实光变曲线**不是正弦**，这一点在类型表和页面上都如实标注为编排。

### H-R 图（赫罗图）

页面按内核回显的 `(T_eff, L)` 把每颗发光天体画成赫罗图上的一个点，横轴是光谱型
（按天文惯例**从热到冷**，左 O → 右 M），纵轴是光度（对数）。图上标出主序带、
巨星支、超巨星带、白矮星区四个**教科书示意区域**（不是内核算出来的边界，页面上写明了）。
放一颗红超巨星上去，你会看到它落在主序带的右上角 —— 这正是"同温度下更亮 = 更大"。

### 天体类型：想放什么就放什么（含黑洞）

页面上「放什么？」那一排按钮来自内核的类型表（`starpivot catalog` 也能直接在终端查）：

```
岩质行星 · 超级地球 · 冰巨星 · 气态巨行星 · 褐矮星 · 红矮星 · 类太阳恒星 ·
大质量恒星 · 白矮星 · 中子星 · 黑洞
```

**为什么这件事必须在核心里**：`黑洞的半径是多少` 是一个物理问题，答案要用 G 和 c 去算。
页面一旦自己算，就同时抄了一份常数和一份公式，而抄写迟早与内核走散。所以：

- 类型的**半径模型只有三种**，每种都写明了是"真公式"还是"经验拟合"（`p_source` 字段）：
  幂律 `R = R_ref·(M/M_ref)^p`、主序分段 `R/R☉ = M^0.8 (M≤1) / M^0.57 (M>1)`、
  以及黑洞的**史瓦西半径 `R = 2GM/c²`**（真公式，判据用 SI 单位独立复算，11 个类型逐个核过）。
- 类型还决定**是否发光**：黑洞 / 中子星 / 白矮星 / 行星都是 0，红矮星按 `L = M^3.5` 很暗，
  褐矮星按同一条关系外推（这对它其实是高估，已标注）。
- **类型名是承诺**：`--body X,1,0,0,0,0,0,red_dwarf:10` 会被拒绝 ——
  10 M☉ 的红矮星不存在，内核不会悄悄按蓝巨星给你算。
- 没声明类型的天体按**氢燃烧下限 0.08 M☉**兜底判断发光（老写法行为不变）。

命令行写法：第 8 字段可以是数字，也可以是 `类型:质量`：

```bash
starpivot nbody --scenario custom --solar sun --years 6 --samples 600 \
  --body "RD,0.5,0,0,0,0,0,red_dwarf:0.2" \
  --body "BH,2.0,0,0,0,0,0,black_hole:10"
```

### 根数绕谁转：`--primary`（换了一颗更轻的恒星就必须用）

自定义天体的开普勒根数一直有一个**隐含约定**：绕原点、并假定原点处有一颗 **1 M☉** 的星
（内置行星表也用这个约定）。用户可以放 0.2 M☉ 的红矮星之后，这个约定就会给出**错的初速**：

```
不给 --primary：红矮星 0.2 M☉ @1 AU + 行星 @0.05 AU
  → 行星从 0.95 AU 飞到 41.7 AU（两年内被甩掉）
  → 原因：行星的初速是按 1 M☉ 算的，而真正拉它的是 0.2 M☉，差了 sqrt(5) = 2.24 倍

给 --primary RD：
  → 行星 0.0500 AU → 0.0500 AU → 0.0500 AU（两年里一步没跑掉），红矮星自己静止在原点
```

```bash
starpivot nbody --scenario custom --solar none --years 2 --samples 40 --primary RD \
  --body "RD,1.0,0,0,0,0,0,red_dwarf:0.2" \
  --body "P,0.05,0,0,0,0,0,rocky"
```

语义（显式，不含糊，并且全部回显在 JSON 里）：

- `NAME` 被放在**原点、初速为零** —— 它是这个系统的参考系；
- 它自己的 `a/e/i/Ω/ω/M0` **不再被使用**，JSON 里 `primary_fields_ignored: true` 如实标出
  （不偷偷忽略用户给的参数）；
- 其余天体 `mu = G·(m_NAME + m_self)`，位置/速度即相对状态；
- 不指定 `--primary` 时**行为逐位不变**（仍是绕原点 1 M☉ 的老约定，并回显
  `elements_reference` 说明这一点）；
- 名字打错 / 只有一个天体 / 用在非 custom 场景，都会被拒绝并说明原因。

页面上不用手写这个参数：**放下第一颗恒星时，页面自动把背景太阳系收起并把它设为参考系**，
而且把这两件事写在提示里（想改回来，背景选择器就在旁边）。
只有列表里**恰好一颗**发光天体时才这么做 —— 有两颗（比如双星）就不猜，猜错比不猜更糟。

### 谁在照亮谁：从"唯一主星"改成多光源求和

第一版取"质量最大者"当唯一光源。等天体能声明类型之后，这个近似就站不住了：
一颗 10 M☉ 的黑洞比太阳重十倍，却一个光子都不发。现在是

```
S_i = Σ_j L_j / r_ij²      （对所有发光天体 j ≠ i 求和）
```

于是**双星是两盏灯一起照**（实测与"只算最亮一颗"差 21%），figure8 三体也有定义
（不再是 `primary_tied` 那种"没有定义"），而黑洞照不亮任何人。
`primary` 仍然回显，但语义已改成**最亮的那一个**（不再是"最重的"），
并且多了 `primary_basis` 把这句话写进 JSON，免得读取方沿用过时语义。

### 两个界面：普通人 / 教授

同一份数据、同一套内核、**同一份 payload** —— 切换只改 `body` 上的一个类名，不碰任何计算。
判据钉住了这一点：来回切模式不会重新下发 payload。

| | 普通人（默认） | 教授 |
|---|---|---|
| 加天体 | 点类型 → 点画面；每颗只有**两个旋钮**（离恒星多远 / 轨道有多扁） | 9 列表格：a · e · i · Ω · ω · M0 · 质量 · 半径 |
| 术语 | "多重 / 多大 / 离恒星多远 / 阳光强度 / 有没有可能有生命" | "质量 / 半径 / 到主星距离 / 辐照度 S / 判定" |
| 温度 | 只给地表温 | T_eq 与 T_surf 分列 |
| 碰撞参数 | 只留"关 / 合并 / 碎裂" | 碎裂数、色散速度、碎裂阈值、恒星参与 |
| 其他 | —— | 能量/动量漂移、分层口径长文、导出 CLI 命令 |

两套编辑器**写的是同一份 `customBodies`**，所以不存在"简单模式改了、教授模式看不到"。
模式与选中的类型都随会话记住。

> 注：自动生成的天体名是纯 ASCII（`black_hole` → `BH3`）。
> 天体名会走进 CLI 的 argv，而 **Windows 的 argv 不是一条可靠的 Unicode 通道** ——
> 实测把「黑洞3」传过去会让整条请求的连接被断开（网关的 `text=True` 解码崩溃，
> 已改成 `encoding="utf-8", errors="replace"`，不会再打死连接）。
> 中文类型名照旧显示（取内核回显的 `type_name`），只是 id 保持 ASCII。

### 画布上的直接操作

- **点画面放行星**：打开「✛ 点画面放行星」后，在空白处点一下就在那个位置放一颗。
  位置是**把屏幕坐标反解回黄道面**得到的（投影是仿射的，直接反解，纯几何）：
  `a` 取解出的半径、`e=0`、`M0` 就是那个方位角，所以它一出生就停在你点的位置。
  放置模式下画面上会画出 **1/2/5/10/20 AU 的距离标尺**（斜视时自然是椭圆）。
  俯仰接近 ±90°（正侧视、黄道面退化成一条线）时**明确拒绝并说明原因**，不瞎放。
- **选中信息卡**：点任意天体，给出质量（含"几个地球"）、半径、密度、到主星距离、
  `S / T_eq / T_surf`、演化判定、阶与达到时刻、出生/消亡 —— 全部取自内核回显。
- **键盘**：空格播放/暂停、← → 逐帧、Shift+←/→ 跳首尾；**焦点在输入框里时不接管**
  （否则没法用键盘改数字）。
- **⟲ 倒放**：与正放对称循环（倒到头从末尾接上），方向会随会话记住。

### 导出：一行等价的 CLI 命令

「⧉ 复制等价 CLI 命令」把当前屏幕上的设定拼成**同一份 payload** 的命令行：

```
starpivot nbody --scenario custom --solar full --years 50 --samples 2000 \
  --body A,1,0.2,0,0,0,0,3.003489e-6,6371 …
```

在终端跑它会得到与画面**完全相同**的 JSON（判据不是"命令看起来对"，而是真跑一遍再与页面那一次的
响应逐点比对：末帧每个坐标的最差偏差 0.00e+0 AU）。这一条同类产品基本没有 ——
他们是"画面就是这个产品"，我们是"页面只是内核的前端"。另外「⤓ 导出 PNG」导出画布
（拿不到有效 PNG 数据时**如实报失败**，不谎报"已导出"）。

### 错误提示的人话

内核的错是给机器看的（`--body e must be in [0,1)`），页面会补一句为什么：
`e` 到 1 就变成抛物线、超过 1 是双曲线，**这两种轨道不再闭合**，那颗星一去不回。
同理还有步数超限（"内核不是做不到，是会跑很久"）等 11 条，每条都对应内核真会说的一句话。

### 一键开局与玩法层（对标同类产品之后加的）

页面上「预设宇宙」有 10 个一键开局，每个都真跑通（判据逐个验证）：
太阳系九星 / 8 字三体 / 类地行星 / 热木星 / 紧凑六行星（仿 Kepler-11）/ 彗星掠日 /
双星系统 / 地月系统 / 轨道共振 1:2:4 / 行星撞地球。最后一个会顺手把碰撞模式切成「撞击碎裂」——
否则默认是「关（质点互相穿过）」，一个叫「撞地球」的预设什么都不撞。

「稳定性挑战」给了这个沙盒一个目标和分数（**玩法层，规则是编排的**，页面上这么写）：
在给定范围里加天体，决定失稳的只有两条，都从内核输出里读 ——
① 内核报了合并/碎裂且参与者是你放的天体；② 你放的天体到主星超过 5 AU
（**几何代理，不是真正的逃逸判据** —— 页面不算能量）。分数 = Σ(质量 ÷ 地球质量) × 存活年数，
地球质量取内核回显的 `earth_mass_msun`（与行星表里那颗 Earth 用的是同一个常量）。

**画质是内核标定的，不是页面拍的**：内核用自己 t=0 的状态按 vis-viva 算出最短环绕周期，
回显 `sampling.min_period_years / points_per_orbit_min / suggested_samples / suggested_years / points_per_orbit_ok`。
页面把"最内圈每圈几个采样点"显示出来，不够用时给一个「改成 N 年 / M 帧」的按钮；
帧间插值（默认开）只是把两个内核采样点连起来画，**不产生任何新的物理量**。

**分享链接**把会话快照编码进 URL 的 hash（`#s=…`，和本地存档是同一份快照，都不含内核结果）。
对方打开后在自己那台机器上现场重算。打开别人的链接**不会冲掉你自己的存档** ——
直到你改动任何一项设定（播放、拖时间轴只算浏览，不写入）。

### 时间与步长参数的范围校验

`--years` 必须 > 0、`--dt` 必须 > 0，步数超过 5e7（约 40 秒）直接拒绝并说明怎么调。
这几条以前一条都没有，实测后果：`--years abc` 抛未捕获异常**进程 abort**；
`--years -5` 静默按 50 年跑；`--dt 0` 返回 `status:"ok"` 却给回空 `frames`（页面收到就崩）；
`--years 1e6` 不拒绝，要算十几分钟而网关 180 秒就超时。

### 会话持久化：每次进去都接着上一次退出

关掉页面再打开，会回到你上次离开时的样子。存的是**你的选择**，不是计算结果：

| 存 | 不存 |
|---|---|
| 场景、太阳系档位（full/sun/none） | 轨道（`frames`） |
| 积分年数、输出帧数、播放速度 | 诊断量（能量/动量漂移） |
| 行星表的每一行（a/e/i/Ω/ω/M0/质量/半径） | 事件时间线（`events`） |
| 碰撞设置（模式/半径放大/碎块数/色散/阈值/恒星参与） | 演化逐帧量（`bio.*` 的任何数值） |
| 演化三旋钮（阶梯年数 / albedo / 温室增温） | 内核回显的任何常量 |
| 视角（yaw/俯仰/缩放/平移/选中的星体） | |
| 播放位置（停在那一帧）与播放/暂停 | |

重开时**整份轨道与演化数值现场重新调用内核算一遍**，所以不存在「缓存了用旧参数算出来的过期轨道」。
这一点在页面上是写明的，不是藏在实现里。

实现要点：快照落在 `localStorage['starpivot.universe.session']`，带 `schema` 与 `saved_at`；
控件改动后 250 ms 合并写一次，播放中按 ~2 s 节流写，`pagehide` / 切后台时立刻补写一次。
三条防线：

- **版本不认就丢**（`schema !== 1` 直接当第一次打开），不静默迁移、不猜旧格式；
- **读回来的一律当不可信输入**过一遍（`a: "oops"` → 默认 1、`cam.sel: 999` → 无效即丢弃、
  名字里的引号逗号清掉——否则会破坏内核 `--set` 的解析）；
- **存储不可用就降级并说明**（隐私模式或被策略禁用时页面写明"不会被保存"），不装作已保存。

页面底部常驻一行状态：首次打开说"已按默认状态开始"，恢复时说"已接着上一次退出继续（多久之前）"
并注明数值是现算的；旁边一个「清除并回到默认」按钮。

顺带修掉两个诚实性/正确性问题：

1. **播放其实一直是坏的**：`render()` 里 `fi = Math.min(frameF, …)` 没取整，而 `frameF` 是
   按真实时间推进的连续小数，`data.frames[0.64]` 取到 `undefined`，下一句 `.t` 抛异常，
   异常发生在 `tick()` 里 → 链式 `requestAnimationFrame` 断掉 → **画面定格在第一帧**。
   前几轮只有「JSON 对不对」的判据，没有「页面跑起来会不会炸」的判据，所以一直没暴露。
   现在索引统一过 `frameIndex()`（取整 + 钳制 + NaN 兜底）。
2. **温室旋钮谎报"被改写"**：页面无条件下发 `greenhouse`，内核 `defaults_used` 因此恒为 false，
   分层说明一路写着"被本次请求改写"。改成只有真拖过才下发，回显才敢写"未改动，用的是内核默认"。

## 碰撞 / 碎裂 / 重聚（`--collide`）

在 N 体内核上加了一层碰撞处理，让"自己加星体"能演化出撞击、碎裂成碎屑、碎屑再吸积的完整链条：

```bash
# 完美吸积：撞上就并成一个（质量相加、动量守恒、动能减少）
starpivot nbody --scenario custom --collide merge --radius-scale 150 \
  --body "A,1.0,0.2,0,0,0,0,3.0e-6,6371" --body "B,1.0,0.2,0,0,180,135,3.0e-6,6371"

# 撞击碎裂：高速撞碎成 4 块碎屑，碎屑低速再撞只吸积（重聚）——真正的增生/碎裂两机制
starpivot nbody --scenario custom --collide fragment --radius-scale 450 \
  --fragments 4 --dispersion-kms 0.3 --frag-min-speed-kms 3 \
  --body "A,1.0,0.2,0,0,0,0,3.0e-6,6371" --body "B,1.0,0.2,0,0,180,135,3.0e-6,6371"
# 实测：t=0.798 yr 以 12 km/s 撞击 → 碎成 4 块 → t=1.18 yr 碎块以 ~1 km/s 重聚 →
#       最终存活 Sun + A#1 + A#4，动量漂移 8.2e-19（碰撞严格守恒动量）
```

建模口径（**明确不做假**，CLI `note` 与页面均写明）：

- **检测**：几何判据，两球半径相交；内置行星物理半径（地球 6371 km…）。真实半径下碰撞概率近乎为零
  （地球 4.3e-5 AU），`--radius-scale` 是**演示开关不是物理**；默认**恒星不参与碰撞**（`--star-collide` 可开），
  否则放大后的太阳（2000× ≈ 9 AU）会先把内行星全吞掉。
- **合并（完美吸积）**：教科书粘性球极限——质量相加、动量严格守恒、动能必然减少。
- **碎裂（参数化）**：等质量碎屑环 + 去均值色散速度；动量与质量严格守恒，色散速度是**模型参数**
  （`--dispersion-kms`）。**不含**状态方程、撞击成坑/抛射质量律、潮汐（洛希）破坏判据、掠撞逃逸分支。
- **低速吸积 / 高速碎裂**：`--frag-min-speed-kms` 给出两机制分界——没有它，碎屑每次重撞都会再碎一次，
  变成无限碎屑喷泉（实测会级联到 563 次事件）。碎屑另有"免疫期"（环半径/色散速度）与 64 体上限兜底。
- **输出**：`events` 数组（时刻、类型、参与者、间距、相对速度、ΔE、碎块数）；`bodies` 自带
  `radius_km` / `born_at` / `died_at` / `merged_into`，网页据此画生死轨迹与事件时间线。

## 生物演化：位置决定这颗星能走到哪一步（`--no-bio` 可关）

每颗星体按**它自己到主星的实时距离**算辐照度，再算温度；温度决定这轮阶梯能不能推进。
驱动量是真的，阶梯是编排的——这两层在代码、JSON 与页面上都分开标注。

```bash
# 默认就带演化层；50 年积分、默认 100 年阶梯时地球走到第 4 级「大气富氧」
starpivot nbody --scenario solar --years 50

# 只想看轨道、不要演化输出
starpivot nbody --scenario solar --no-bio

# 给火星 100 K 温室：它就从"冻结"跨进液态水窗口，开始演化
starpivot nbody --scenario solar --greenhouse 100 --bio-years 100
```

**第 1 层（物理，真公式）**——可在教材里逐条核对：

| 量 | 公式 | 地球处 |
|---|---|---|
| 辐照度 | `S = (L/L☉) / r_AU²` | 1 |
| 恒星光度 | `L/L☉ = M^3.5`（主序带，约 0.43–2 M☉ 内可靠） | 1 |
| 平衡温度 | `T_eq = 278.6·((1−A)·S)^(1/4)`，A = bond albedo | 254.3 K |
| 近地表温 | `T_surf = T_eq + ΔT`，ΔT 默认 33 K | 287.3 K |
| 液态水窗口 | `273 K < T_surf < 373 K`（水的冰点与沸点，1 atm） | ✔ |

**第 2 层（编排，不是生物学）**：9 级阶梯（死寂岩石 → 有机分子累积 → 原核生命 →
光合作用 → 大气富氧 → 真核/多细胞 → 动物群 → 智慧 → 工业文明）、每级进度、
以及"多快长到下一级"（速率沿温度高斯衰减，峰 288 K、半宽 28 K；
`--bio-years` 是走完全条阶梯所需年数）。**真实演化以 Myr–Gyr 计，这里没有可用公式。**

太阳系按本模型跑出来的结果（`--bio-years 100`，50 年积分）：

| 天体 | S | T_eq | T_surf | 判定 | 50 年进度 |
|---|---|---|---|---|---|
| 水星 | 6.67 | 408.7 K | 441.7 K | **灭菌**（过沸点） | 0 |
| 金星 | 1.91 | 299.0 K | 332.0 K | 演化中 | 4.2% |
| 地球 | 1.00 | 254.3 K | 287.3 K | **演化中**（最优点） | 50.0%（第 4 级） |
| 火星 | 0.43 | 206.0 K | 239.0 K | **冻结**（低于冰点） | 0 |
| 木星…冥王星 | ≤0.037 | ≤111 K | ≤145 K | **冻结** | 0 |

已知局限（CLI 的 `bio.caveats` 与页面都写明，不只报数字）：

- **ΔT 是经验常数，不是定律**。没有它，地球自己的 `T_eq = 254 K` 就在冰点以下，
  模型会判"地球不可能有液态水"——那是真的，也正是大气在做的事。代价是金星被严重低估
  （本模型 `T_surf ≈ 332 K`，真实地表 737 K，失控温室）。
- **`T_eq` 不含温室**，`L = M^3.5` 在 0.43–2 M☉ 外是外推。
- 三体那种**等质量系统没有主控星**，"谁照亮谁"在物理上没有定义；内核按"质量最大者、
  同质量取索引最小者"定，并回显 `primary_tied: true`，页面据此警告不要当结论。

物理判据（`tests/test_bio.cpp` + 独立复算 `_probe_bio.py`，40 余条全过）：

- 地球锚点 `T_eq = 254.28 K`（教科书 255 K），系数 278.6 可由 SI 常量现算出来（残差 0.1%，
  来自 `T_sun` 取 5778 还是 5772）。
- **距离方向**：`T_eq ∝ 1/√r`，0.5 AU → 4 AU 差 `√8 = 2.828` 倍。这一条是回归判据——
  公式曾误写成 `((1−A)/S)^(1/4)`，在 S = 1（地球）处与正确式同值，只有别的轨道才暴露
  （4 AU 处乘法 127 K / 除法 509 K，方向相反）。
- 冰点/沸点两侧的行为分开验：过沸点**归零**，低于冰点**停滞但不回退**（甩出去再回来，
  已经长出来的东西不消失）。
- `progress` 钳在 [0,1] 且绝不溢出；退化输入（r=0、L=0、质量 0、albedo ≥ 1、负温室）
  一律有限值，不产生 NaN/inf。

## 构建

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release   # CMake >= 3.20
cmake --build build
ctest --test-dir build --output-on-failure       # GoogleTest 1.14
```

### 没有系统编译工具链时怎么办（本机实测可行的替代路径）

这台机器上 zig / MSVC / g++ / clang++ / cmake **一个都没有**，而且 ziglang.org、github.com
都连不上——连 GoogleTest 的 FetchContent 也拉不动。但**腾讯 pypi 镜像上有 `ziglang` 轮子**，
它是一个自带 clang 前端与 libc++ 的完整工具链，装完就能编译这个纯标准库的 C++17 工程：

```bash
# 1) 下载（约 94 MB，sha256 可在镜像的 simple 索引页核对）
curl -L -C - -o ziglang.whl \
  https://mirrors.cloud.tencent.com/pypi/packages/b9/6b/8ab0853a312108b4089747486366b824b5da89773cb56f661f9994de17db/ziglang-0.15.2-py3-none-win_amd64.whl

# 2) 解包。注意两点，否则会「看起来解开了、其实不能用」：
#    * Expand-Archive 不接受 .whl 扩展名（改名为 .zip 或用 tar）
#    * 必须整棵 ziglang/ 目录都出来（含 lib/std、lib/libcxx），只留 zig.exe 会报
#      "unable to find zig installation directory"
tar -xf ziglang.whl -C /d/tmp/zig            # bsdtar 能直接吃 zip

# 3) 编译。必须把缓存目录指到可写位置，否则 zig 会以
#    "failed to delete ... AccessDenied" 之类警告静默失败（退出码 1、产物为空）
export ZIG_GLOBAL_CACHE_DIR=/d/tmp/zigcache
export ZIG_LOCAL_CACHE_DIR=/d/tmp/ziglocal

ZIG=/d/tmp/zig/ziglang/zig.exe
$ZIG c++ -std=c++17 -O2 -ffp-contract=off -I include -o build/bin/starpivot.exe \
  src/*.cpp tools/starpivot_cli.cpp
```

GoogleTest 的测试套件仍然需要网络，所以另外提供了一份**不依赖 GoogleTest 的独立自检**
（`tests/_bio_selftest.cpp`，判据与 `test_bio.cpp` 同源、载体不同）：

```bash
$ZIG c++ -std=c++17 -O2 -I include -o build/_bio_selftest.exe \
  tests/_bio_selftest.cpp src/bio.cpp && ./build/_bio_selftest.exe   # 53 passed, 0 failed
```

### 审查记录

- [docs/review-2026-09-25-benchmark.md](docs/review-2026-09-25-benchmark.md) —— 对标 25 个同类产品
  （Universe Sandbox / Super Planet Crash / NASA Eyes / Kerbal / TerraGenesis / WorldBox /
  SpaceEngine / Children of a Dead Earth …），归纳出 10 条"吸引力机制"、逐条落到改动，
  并以用户视角重走一遍。**结论：他们的共同点是把「按下按钮→看见结果」压到零，
  并给你一个「想再来一次」的理由；我们之前两样都缺。** 附本轮抓出的两个真缺陷。
- [docs/review-2026-09-25-gameplay.md](docs/review-2026-09-25-gameplay.md) —— 把页面当游戏/模拟器
  审查一遍：报告两项 P0（内核拒绝时页面继续展示旧结果、`frames: []` 让页面冻死，均已修并钉住判据）、
  五项 P1（默认采样混叠把圆画成多边形、六个控件改了不重算且无提示、`--years` 零校验、
  16 上下限静默、`index.html` 主视图是打包样本未声明）与五项玩法缺失，
  每条都带复现命令与实测数字。

### 全量判据入口

```powershell
powershell -ExecutionPolicy Bypass -File ..\_verify_all.ps1
```

四层，层层不可互相替代：**A 静态判据**（printf 说明符/实参个数、页面与内核字段名对齐）→
**B 独立复算**（用 SI 单位从第一性原理重推物理，不是复刻内核写法）→
**C 真代码单测**（直接调 `bio.cpp`，验"代码有没有抄错"）→
**D 端到端**（真内核 JSON / 网关链路 / 真 HTTP）。C、D 层缺席时脚本会显式报 SKIP，
**不允许把"没跑"当成"通过"**。

产物：

- 静态库 `libstarpivot-physics.a`（GNU/Clang）或 `starpivot-physics.lib`（MSVC）
- 测试可执行文件 `starpivot-tests`
- 命令行 `starpivot`

Python 绑定（可选）：

```bash
cmake -S . -B build -DSTARPIVOT_BUILD_PYTHON=ON
cmake --build build
pytest bindings/python/tests/ -v
```

无 CMake 也能跑基线（只需一个 C++17 编译器）：

```bash
c++ -std=c++17 -O2 -I include \
    src/gravity.cpp src/hermite.cpp src/leapfrog.cpp src/elements.cpp \
    tools/verify_baselines.cpp -o verify_baselines
./verify_baselines
```

## 验证基线（本机实测，非目标值）

单位 AU / M☉ / 年，`G = 4π²`。

```
Baseline 1  two-body Kepler, 100 yr, dt = T/1000
  fixture a = 1 AU             0.000e+00   (target < 1e-12)
  fixture e = 0                0.000e+00   (target < 1e-12)
  fixture momentum = 0         0.000e+00   (target < 1e-15)
  a relative error             3.409e-11   (target < 1e-9)
  eccentricity drift           2.900e-14   (target < 1e-8)
  |dE/E|                       3.409e-11   (target < 1e-9)

Baseline 2  energy conservation, 5 bodies, Jupiter x10, 1000 yr
  |dE/E|                       1.060e-10   (target < 1e-8)
  momentum drift               6.237e-15   (target < 1e-12)

Baseline 3  Figure-8 three-body, one period
  closure error                4.102e-08   (target < 1e-6)
  |dE/E|                       1.201e-13   (target < 1e-9)

Baseline 4  Lagrange points, Sun-Earth, 100 yr
  L4 deviation                 8.361e-09 AU (target < 1e-3)
  L1 deviation                 6.921e-03 AU (unstable, as required)
  L4 vs L1 separation          ratio 8.3e+05
```

GoogleTest 套件：**56 tests, 56 passed**（11 个：gravity_consistency / two_body / energy_conservation / figure8 / lagrange / spin / perturb / sgp4 / conjunction / groundtrack / collision）。其中 `sgp4` 套件覆盖 6 官方向量位置/速度残差、TLE 解析（含 legacy 空国际标识符）与真实在轨样本（ISS 25544、GPS BIIR-5 26407）；`conjunction` 套件覆盖同星零距自洽、步长收敛（分辨率无关）、异历元偏移一致；`groundtrack` 套件覆盖纬度硬界限、ISS 升交点西退 −23.6°/圈、星下点重建闭合、SDP4 深空轨迹单调；`collision` 套件覆盖检测阈值恰为半径和、合并严格守恒质量/动量且必然损失动能（解析值 −1.0）、碎裂守恒且色散正交于动量、同种子可复现、恒星默认排除。

## 两条选型结论（都是实测出来的，不是教科书抄的）

**1. Hermite 4 阶不是辛积分器。** 在规则轨道上跑 100 个周期，2 阶辛积分器在两个守恒量上都赢它：

| 量 | Hermite4 | Leapfrog2 |
|---|---|---|
| \|dE/E\| | 3.4e-11 | **2.7e-14** |
| 半长轴误差 | 3.4e-11 | **2.7e-17** |

辛方法守恒一个邻近的"影子哈密顿量"，误差在固定带内振荡而不累积。Hermite 的高阶买的是**单步精度**，在**一个轨道周期内**位置误差远小于 Leapfrog。

选型规则：中短期、有近距遭遇、需自适应步长 → Hermite4；1e6–1e9 年长期演化 → 辛积分（leapfrog 或 Wisdom-Holman）。两个都要留。

**2. 稳定性测试比守恒量测试更能抓 bug。** 二体基线只检查 e 的**变化量**，因此"初始就是椭圆、且太阳与地球同向运动"的错误初始条件也能通过。是拉格朗日基线把它抓出来的：修复前 L4 偏离 1.30e-02 AU，修复后 8.36e-09 AU，差 6 个数量级。所以基线 1 现在强制断言 `e0 == 0`、`p == 0`。

## 目录

```
include/starpivot/   头文件（Vec3 / System / gravity / hermite / leapfrog / elements / constants / time / perturb / sgp4 / conjunction / groundtrack / collision）
src/                 内核实现，C++17（含 sgp4.cpp SGP4/SDP4 双精度传播器、conjunction.cpp 最近接近筛选、groundtrack.cpp 星下点、collision.cpp 碰撞/吸积/碎裂）
tests/               GoogleTest 物理验证（4 基线 + 力场一致性 + SGP4 官方向量与真实 TLE + 碰撞预警）
  test_sgp4.cpp       Vallado 附录 D 6 向量 + 真实在轨样本 + TLE 解析
  test_conjunction.cpp  同星零距 / 步长收敛 / 异历元偏移一致
  test_groundtrack.cpp  纬度界限 / 升交点西退 / 星下点重建闭合 / SDP4 单调
  test_collision.cpp    检测阈值=半径和 / 合并守恒动量且损失动能 / 碎裂守恒 / 种子可复现
tools/
  verify_baselines.cpp   零依赖基线报告器
  starpivot_cli.cpp      CLI（propagate / j2 / elements / verify-tle / conj / nbody / about）
  find_close_approaches.py  真实 TLE 近距对筛选（数据抓取+根数初筛，传播委托 C++ conj）
  xsys_gen.py            .xsys 场景生成（Python 合法用途）
  xsys_validate.py       .xsys v1.0 校验器（Python 合法用途）
bindings/python/     pybind11 绑定 + pytest
docs/
  M1-revised.md      M1 清单与对原方案的评审
  go-public.md       对外能力清单与"判据先于实现"验证记录
  evidence/          论证用脚本（非内核）
```

## 关于 `.xsys`

JSON 线格式（每语言都有解析器）。校验器返回**带修复建议**的人类可读错误，用户不必读规范就能改对自己的文件：

```
xsys error [rule 02] at integrator.t_end
  t_end must be an integer multiple of dt
    got: t_end=100.0, dt=0.003 (remainder: 1.0e-03, nearest step count: 33333)
  hint: try dt = 0.00300003, 0.00299997, 0.00300009
```

未知字段默认**警告并忽略**（前向兼容），`validate(..., strict=True)` 才拒绝——否则老版本读不了新版本的文件，与"格式向后兼容"冲突。
