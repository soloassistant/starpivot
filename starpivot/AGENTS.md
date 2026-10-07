# AGENTS.md — StarPivot（星枢）

天体力学工具站：C++17 物理内核 + Python 薄网关 + 零依赖静态前端。
线上：<https://starpivot-universe.app.workbuddy.host/>

## 硬规矩（改动前必读，违反即判据作废）

1. **页面一个数都不算。** 页面上每个数字都来自内核 JSON 回显；页面不做数值积分、不做单位换算、不补默认值。
   一旦页面开始"帮内核算一点"，全部判据立刻失效。
2. **网关只做 argv 转发与 JSON 透传。** `tools/webapp.py` 不含任何物理量计算。
3. **零外部依赖。** `viewer/` 四页不允许出现 CDN、框架、UI 库、字体外链。理由有二：
   离线可用，以及判据要用 jsdom 加载页面。引入外链会同时破坏这两条。
4. **四页共用同一套设计令牌**（令牌名、字号阶梯、间距刻度、圆角、阴影逐字相同）。
   改一个令牌要四页一起改；只有明暗与语义色按页面性格取值。
5. **判据只认两样东西**：汇总退出码，以及每个探针自己落盘的 `n=… fail=…`。
   `_runall.sh` 与 `_verify_all.ps1` 的探针集合与顺序必须逐条一致（由 A0 判据盯着）。
6. **缺测按缺失处理，不补零。** 没验证过的要显式写成"未验证"；安静跳过视为假绿。
7. **负样本必须走被测项同一个函数**，且要"可能通过"；改判据要过变异测试。
8. **容差按最坏情况推导**（输出用 `%.6g` → 取 `1e-5`）。

## 目录

| 路径 | 是什么 |
| --- | --- |
| `src/` `include/` | 物理内核：N 体、四种积分器、碰撞碎裂、SGP4/SDP4、阻力/光压 |
| `tools/starpivot_cli.cpp` | 命令行：`nbody` `propagate` `elements` `j2` `conj` `groundtrack` `verify-tle` `about` |
| `tools/webapp.py` | 网关：纯标准库 HTTP 服务，只转发与透传 |
| `viewer/` | 四页前端 + `world.js`（Natural Earth 110m 陆地）+ `demo.js`（冻结样本） |
| `data/` | 公开目录数据的落地副本，逐项标注观测/标定/模型参数（见 `PROVENANCE.md`） |
| `docs/` | PRD 与历次审查报告 |

## 改完必跑

```bash
# 构建（改过内核才需要）
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j

# 起网关（改过前端或网关才需要）
python tools/webapp.py --port 8765

# 静态判据：改过 viewer/ 必跑，改了前端判据也要跑
node ../_check_home.js && node ../_check_kids.js && node ../_check_bio_page.js
node ../_a11y_verify.js && node ../_a11y_verify_dyn.js
```

前端四页内联脚本改过字符串拼接后，**必须**逐页过 `node --check` —— 引号错一处整页就崩。

## 已知易踩的坑

- **死控件**：中间某层漏转发一个参数，页面控件就是死的，而默认值恰好相等时**所有判据全绿**。
  历史案例见 `tools/webapp.py` 里 `--spray` 的注释。改转发链后要把参数改成非默认值实测一次。
- **声明位置**：本项目已两次因变量声明顺序导致 TDZ 抛错、整段脚本停死。
  初始化代码里 `savedSession` 必须在导览逻辑之前声明。
- **rAF 链**：异常发生在 `tick` 里会断掉链式 `requestAnimationFrame`，整页冻死且无报错。
- **内核探针走录制/回放**，录制绑内核的 `size + sha1`；内核一重建，整份录制作废（宁可作废，勿拿旧输出喂新内核）。
- **`requirements.txt` 是空清单**，唯一作用是告诉部署平台"这是 Python 应用"，否则会被当纯静态站、`/api/*` 全 404。

## 许可

仓库无许可证文件，默认"保留所有权利"。
