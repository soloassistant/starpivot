# StarPivot · 星枢

一个**真在算**的天体力学工具站：C++17 内核负责全部物理，Python 薄网关只做转发，
浏览器只负责把内核回显的值画出来。

> **一条贯穿全仓的硬规矩：页面一个数都不算。**
> 页面上看到的每个数字都来自内核的 JSON 回显；页面不参与数值积分、不做单位换算、不补默认值。
> 这条规矩也是全部判据的立足点 —— 一旦页面开始"帮内核算一点"，判据立刻失效。

- 线上实例：<https://starpivot-universe.app.workbuddy.host/>
- 内核自述（更详细）：[`starpivot/README.md`](starpivot/README.md)
- 设计与验收文档：[`starpivot/docs/`](starpivot/docs)

## 组成

| 层 | 内容 | 位置 |
| --- | --- | --- |
| **物理内核** | 引力 N 体、四种积分器（leapfrog / hermite 等）、碰撞与碎裂、级联、定向溅射、演化层（生命形态）、轨道根数、SGP4/SDP4、带谐重力 / 大气阻力 / 太阳光压、自转与岁差 | `starpivot/src` · `starpivot/include` |
| **命令行** | `nbody` · `propagate` · `elements` · `j2` · `conj` · `groundtrack` · `verify-tle` · `about` | `starpivot/tools/starpivot_cli.cpp` |
| **网关** | 纯标准库 Python，只做 argv 转发与 JSON 透传 | `starpivot/tools/webapp.py` |
| **前端** | 首页 / 轨道递推页 / N 体沙盒 / 小朋友页（四页共用一套设计令牌） | `starpivot/viewer` |
| **判据** | 五层（A 静态 / B 独立复算 / C 真代码单测 / D 端到端 / E 页面级），30+ 个探针 | 仓库根 `_probe_*.js` · `_check*.js` · `_runall.sh` · `_verify_all.ps1` |
| **数据** | 公开目录数据的落地副本，逐项标注观测 / 标定 / 模型参数 | `starpivot/data`（出处见 `PROVENANCE.md`） |

## 快速开始

### 1. 构建内核

需要 CMake ≥ 3.16 与支持 C++17 的编译器（`STARPIVOT_BUILD_PYTHON=ON` 才需要 pybind11）：

```bash
cd starpivot
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
```

产物 `starpivot/build/bin/starpivot`（Windows 上是 `starpivot.exe`）。
**零第三方数值依赖** —— 只用 `<cmath>`、`<vector>` 等标准库；没有 Eigen / GSL / numpy。

### 2. 起网关

Python 标准库即可，不需要装任何包：

```bash
python starpivot/tools/webapp.py --port 8765
# 打开 http://127.0.0.1:8765/
```

网关按 `PORT` 环境变量监听：有 `PORT` 时绑 `0.0.0.0`（部署平台约定），否则 `127.0.0.1:8765`。
`starpivot/requirements.txt` 是空的依赖清单，存在的唯一理由是告诉部署平台"这是个 Python 应用"
（否则会被当成纯静态站，`/api/*` 全部 404）。

### 3. 跑一次判据

```bash
./_verify_all.ps1        # PowerShell（正式入口）
bash _runall.sh          # bash 镜像，同一套探针
```

判据只认两样东西：**汇总退出码**，以及**每个探针自己落盘的 `n=… fail=…`**。
两份清单的探针集合与顺序必须逐条一致（由 A0 判据盯着），改一处就要改另一处。

## 判据是怎么设计的

- **断言只读内核回显，或独立复算** —— 不读源码猜、不按理论想当然。
- **负样本走被测项同一个函数**，且必须"可能通过"；改判据要过**变异测试**（证明它真抓得住）。
- **容差按最坏情况推导**（例如输出用 `%.6g` → 取 `1e-5`）。
- **缺测按缺失处理，不补零**；没验证过的显式说成未验证 —— 安静跳过视为假绿。
- 内核探针在本环境走**录制/回放**：先真跑一遍落盘原始输出，再带录制重跑断言；录制绑内核的体积与
  sha1，内核一重建整份录制作废。

## 诚实边界

- 行星环，以及撞击瞬间的喷流 / 冲击环 / 闪光属于**显示层**：位置与时刻来自内核事件，
  但环的宽窄倾角、淡出快慢由页面决定 —— 界面上写明了这一点，不让它冒充仿真输出。
- 球的大小按真实半径做**对数压缩**（约 2.2–13 px），不是一比一，图例里写着。
- 真实系统预设里的 `inc` / `raan` / `argp` / `M0` 一律取 0，那是**模型假设**，不是观测值。
- 恒星有效温度与热改正未接入内核，因此恒星温度、光度与 H-R 图上的真实恒星**不显示** —— 这是
  缺口，不是"暂时没画"。

## 许可

本仓库目前**没有**许可证文件，默认即"保留所有权利"。若要在别的项目里使用其中的代码，
请先开 issue 说明用途。
