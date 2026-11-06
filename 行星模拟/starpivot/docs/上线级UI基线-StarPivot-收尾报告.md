# StarPivot 上线级 UI 基线 · 收尾报告

- 基线：[上线级UI基线-StarPivot.md](上线级UI基线-StarPivot.md)（审查对象 `main` @ `02edaec`）
- 收尾对象：`main` @ `3b7face`（PR #11 合并后）
- 日期：2026-11-06
- 说明：用户给的路径 `D:\Agent\行星模拟\starpivot` 不存在；实际仓库为 `WorkBuddy/2026-09-24-16-11-48`，应用在其 `行星模拟/starpivot` 子目录。收尾在独立 worktree `D:\Agent\.tmp-sp-ui-final` 中进行，未直提 `main`。

## 一、已修（按基线条目，逐笔一 PR，均为 merge commit）

| 项 | 内容 | PR | head sha | merge commit | diff |
|---|---|---|---|---|---|
| P0-1 / U-11 署名 | 四页 footer 补 Natural Earth 1:110m（公有领域）+ 来源链接 + 不收集数据说明 | #3 | `a5d41ec` | `22c9262` | 4 files, +7/−0 |
| 基线文档 | 新增本基线（纯文档） | #4 | `029af69` | `e315f64` | 1 file, +71/−0 |
| U-08 输入边界 | orbit 的 `cwin`/`cstep`/`cthr` 补 `min` 并在提交前 clamp | #5 | `aa1d8a8` | `8a08fb5` | 1 file, +20/−9 |
| U-06 危险操作 | 天体删除、卡片删除、方案删除统一二次确认 | #6 | `e0ccfa9` | `b72853a` | 1 file, +20/−1 |
| U-05 状态完整 | kids/universe 失败态补「重试」，并修正 kids「双击打开文件不行」的误导文案 | #7 | `ffa8c6a` | `4820f8e` | 2 files, +19/−3 |
| U-03 触控热区 | coarse 档补 `min-width:44px`（4 个播放按钮、导览关闭、两页返回链接） | #8 | `4d20298` | `87fd11b` | 2 files, +5/−0 |
| 视口 320 裁切/溢出 | home `.grid2`、orbit `#cgroups`、universe 挑战行三处窄屏修复 | #10 | `8a9a347` | `7b9f98b` | 3 files, +6/−3 |
| 收尾报告（一） | 已修/未修/待决策清单、U-01 两次否决、320/768 回归（纯文档） | #11 | `4acb924` | `3b7face` | 1 file, +33/−6 |

每笔的「改坏必红」证据：

- **#3**：删掉 `kids.html` 的一行 footer → 检查退出码 1（`ALL_PAGES=false`）；恢复 → 退出码 0（`ALL_PAGES=true`）。
- **#5**：删 `cwin` 的 `min="1"` → 红；把 `Math.max(1,+win)` 改成 `Math.max(0,+win)` → 红；恢复 → 绿；`_check_orbit.js` n=20 fail=0。
- **#6**：CDP 实测初始 2 行 → 弹确认「删除天体「A」…」→ 取消仍 2 行 → 确认变 1 行；变异把确认改成 `if (false)` → 弹窗 0 次、取消后 1 行 → 红。
- **#7**：kids 失败后「再试一次」可见，点击后同步回到「正在算……」并收起；universe 错误条点「重试」后 `#compute` disabled；删 `display=''` / 把监听改 `if(false)` 均红。
- **#8**：移除两处 `min-width` 后真 Chrome 实测 `<44px` 控件 7 个（红）；恢复后 0 个（绿）。
- **#10**：三处全部撤回后重测（320×568、`isMobile=false`）：`/` 12 个裁切元素回来、`/orbit` 338/320、`/universe` 341/320；恢复后两种 `isMobile` 档位、320/768 两视口四页全部 `0 实例`（`issue_groups=0`）。

## 二、未修（有客观判据，但实测否决或超出单笔范围）

**U-01 `/universe` 慢网首屏**：三次实测都否决，改动均已回滚，未留下。

第一次，zstd 压缩。Chrome headless、400kbps/50ms、禁缓存、5 轮中位数、同一设备与同一 worktree：

| 方案 | FCP 中位数 | load 中位数 | `universe.html` 传输字节 |
|---|---:|---:|---:|
| gzip（现状） | 451 ms | 2897 ms | 135,011 B |
| zstd level 19 | 701 ms | 2342 ms | 107,505 B |
| zstd level 9 | 740 ms | 2363 ms | 121,182 B |

主指标 load 降约 555 ms，但副指标 FCP 升 250–289 ms；上升来自浏览器 zstd 解码/缓冲，不属于「缓存或延后命中」例外。按规则**回滚 `tools/webapp.py`**，未提交。

第二次，延迟脚本拆分（同一口径，5 轮中位数）：先量了各候选区段从 HTML 里删掉后的 gzip 差（level 6）：

| 区段 | 行数 | gzip 实测 |
|---|---:|---:|
| 内联脚本整体 | 840–5654 | 全文件 132,507 B |
| 策略层（协议/方案/锚点/鬼影/随机宇宙） | 2235–2990 | 16.3 KB |
| 协议数据 `PROTOCOLS` | 2268–2431 | 3.4 KB |
| 预设 `PRESETS` | 1893–2018 | 3.5 KB |
| 导览数据 `TOUR` | 2994–3074 | 3.1 KB |
| 挑战 `CHALLENGE` | 2140–2233 | 2.2 KB |
| 报错解释 `ERR_HELP` | 3994–4013 | 1.2 KB（内联时只占 301 B） |

唯一不参与初始化和每帧渲染的是 `ERR_HELP`：把它挪到 `universe-errhelp.js`（1,286 B gzip），HTML 132,507→132,206 B（−301 B），按 50KB/s 理论只省约 6 ms。实测 FCP 692→**709**、load 2597→**2613**（没有降，落在噪声内），按规则回滚（删文件、`git checkout --`），未建 PR。

其余区段都挂在首屏初始化或每帧渲染上，不能在单笔 300 行内安全拆出：`buildProtocols()`（5643/5647 init）、`renderSchemes()`（1730/5648）、`syncSpanFromYears()`（1731/5598/5603）、`schedulePreview()`（5604/5607）、`onDataSettled()`（4214 每次渲染）、`maybeDrawAnchors()`（5286 每次渲染）、`ghostClear()`（5649）。

第三次，首访导览延后到首帧之后（本轮获准动的唯一一条时序）。先量各段主线程占用（同一口径、5 轮 CPU profile，按函数汇总 self time；run1 冷启动含 JIT，单独标注不参与中位数）：

| 函数 | self time（中位数） | 首次执行时刻（相对导航，中位数） |
|---|---:|---:|
| `showTourStep()`（导览真正开卡） | 2.5 ms（run1 首轮 31.6 ms 含 JIT） | 2561 ms |
| `buildProtocols()` | 0.8 ms | 2153 ms |
| `renderSchemes()` | 0.6–0.7 ms（多数轮次未被采样到） | 2154 ms |

基线里导览并不在首屏路径上：首次执行在 2.56 s，比 FCP（656 ms，页内 PerformanceObserver）晚 1.9 s，离 load 只有约 50–100 ms；self time 是 2.5 ms 量级。load 由 132.5 KB gzip 在 50 KB/s 下的传输下限决定（约 2.6 s），挪走 2.5 ms 的 JS 不可能降 110 ms。

改法：只动首访分支（deep link 保持原 300 ms 定时器），`setTimeout(startTour, 400)` → 两帧 `requestAnimationFrame` + `requestIdleCallback({timeout:1500})`，无该 API 时退回 200 ms。行为核验：5 轮冷启动里 `showTourStep()` 都在 2252–2272 ms 执行、`#tourcard` 都显示，首访导览仍会自动开始。

| 指标（5 轮中位数） | 改前 | 改后 | 判据 |
|---|---:|---:|---|
| FCP | 694 ms | 707 ms | 必须不升 → 升 13 ms，不满足 |
| load | 2580 ms | 2621 ms | 必须 ≤ 2500 → 未达标且升 41 ms，不满足 |
| 首访导览启动（首次执行时刻） | 2561 ms | 2258 ms | 必须仍启动 → 满足 |

三条判据两条不满足，按规则回滚（`git restore`、删实验分支、未建 PR）；回滚后确认服务器返回的 `universe.html` 已无 `autoTour`。改后导览反而提前到 2.25 s，落进初始化更密的时段，FCP 与 load 都没降——这也是不能留的原因。

还剩下的两条「真能省 9–15 KB」的路，都会让首屏内容不完整或改变首屏时序，需产品决策：

- 策略层整体（16.3 KB）延迟到 `load` 之后，并在模块到达后重建协议/方案/锚点面板 —— 代价是这些面板在 `load` 前为空，diff 约 1,500 行。
- 把 `PROTOCOLS`/`PRESETS`/`CHALLENGE` 数据外置（约 9.1 KB）—— 代价是首屏协议/预设面板要等第二个请求到达才可用，弱网下会出现空面板。

因此 `/universe` 慢网仍是 **2.58–2.62 s**（门槛 2.5 s），本轮未修；只动时序不可能进 2.5 s，至少要先少传约 4 KB gzip。

## 三、待决策（不做，列出口径）

| 项 | 为什么不做 |
|---|---|
| U-03 真实读屏/NVDA/全键盘 walk-through | 本机无读屏软件，静态 ARIA 检查代替不了真机；属「未测」，不能说通过 |
| U-03 canvas `aria-label` 同步当前场景/结果 | 基线本身标注为「建议」，不是确定缺陷；要同步哪些量、多久更新一次是产品/交互口径 |
| U-07 明暗主题 | 基线认定「可接受的设计取舍」；支持 `prefers-color-scheme` 会改动 universe 深空视觉，需设计决策 |
| U-10 抽 `viewer/base.css` | 去重属维护性重构，diff 远超单笔 300 行；基线已写「本轮不做」，且需拆两笔并各自回归 |
| U-11 P1 独立隐私政策/使用条款页 | 需要法务/产品给出文案与责任口径；P0 署名部分已在 #3 完成 |

## 四、核过、不需要改的项

- **U-02 图片**：全站仅 `favicon.svg`，无 `<img>`、无外链图标，破图 0。
- **U-04 双语**：正文中文单语，英文仅专有名词/单位。
- **U-09 隐私**：无 analytics、无第三方脚本，`localStorage` 不含 PII。
- **对比度**：真 Chrome 渲染后逐处量，`/` 175 处、`/orbit` 53 处、`/universe` 195 处、`/kids` 57 处，低于 WCAG 阈值均为 **0 处**。
- **触控热区**：390×844 + `hasTouch` 下，四页 110 个可点控件全部 ≥44×44（复选框按外层 label 计）；320/768 复测 `small=0`。
- **视口回归 320 / 768**：真 Chrome，320×568 与 768×1024，`isMobile` true/false 两档。改前 320 有 3 组实例（`/` 12 个元素被 `details.card` 裁掉、`/orbit` 338/320、`/universe` 341/320），已在 #10 修复；768 改前就是 0 实例。改后 8 个组合全部 `scrollWidth==innerWidth`、`0 实例`；无 <44px 控件、无被遮挡的可点控件。

## 五、门禁真实尾行（代码 head `7b9f98b`；`3b7face` 只多了报告文档）

- `_check_home.js` → `[home-static] n=36 fail=0`
- `_check_kids.js` → `[kids] n=42 fail=0`
- `_check_session.js` → `[session-static] n=20 fail=0 skip=0`
- `_check_orbit.js` → `[orbit-static] n=20 fail=0`
- `_check.js` / `_check_solar.js` → `全部判据通过`
- `_check_printf.js` → exit=0（通过时无输出）
- `_check_bio_page.js` → exit=0（末行 `PASS 负样本：把"先在下面的行星表里把天体加好"塞回可见文案会被同一处抓到`）
- `_a11y_verify.js` → `自查 86 条，fail=0`
- `_cmp_lists.py` / `_probe_argv.py` / `_probe_solar.py` → `全部判据通过`
- `_probe_bio.py` → `全部通过：内核对写法与 SI 第一性原理一致…`
- `_probe_obsstar.py` → `全部通过：真实观测的宿主（T/L/R + 行星初值）走通了内核…`
- `_probe_realdat.js` → exit=0（通过时无输出）
- `_va_contrast.js` → 四页「低于 WCAG 阈值的 0 处」
- 触摸实测 → `[touch] total=110 small=0`
- 视口回归 → `[viewport] issue_groups=0`（320×568 / 768×1024，`isMobile` 两档）

**为什么没整跑 `_verify_all.ps1`（不是跳过，是三处前置在本机不成立）：**

- 脚本里的 `$R` 硬编码到另一份工作树，指不到本 worktree；
- C/D 层要先 zig 编译内核（约 3.5 分钟）才成立；本轮只改 `viewer/*.html`，C++ 与内核未动；
- D/E 层依赖内核二进制，本机 `build/bin/starpivot.exe` 缺失（`/api/health` 返回 `status:"no-exe"`），这些探针无法成立，与基线记录的环境故障一致，不当作回归。

A/B 层（上面列的这些）已逐条整跑，尾行就是上面这些。

## 六、未覆盖与风险

- 真实读屏软件、真实 4G/弱网（本地是 curl 限速与 Chrome 网络模拟）、真机触摸（本地是 `hasTouch` 模拟）、1440 视口视觉回归均未做（320/768 已完成，见上）。
- `/universe` 慢网仍为 2.58–2.62 s（门槛 2.5 s），未修；这是本报告唯一残留的 P1 性能缺口。它的下限由 132.5 KB gzip 在 400 kbps 下的传输时间决定，不先少传约 4 KB 就进不了 2.5 s。
