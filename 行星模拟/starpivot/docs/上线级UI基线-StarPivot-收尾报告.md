# StarPivot 上线级 UI 基线 · 收尾报告

- 基线：[上线级UI基线-StarPivot.md](上线级UI基线-StarPivot.md)（审查对象 `main` @ `02edaec`）
- 收尾对象：`main` @ `87fd11b`（PR #8 合并后）
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

每笔的「改坏必红」证据：

- **#3**：删掉 `kids.html` 的一行 footer → 检查退出码 1（`ALL_PAGES=false`）；恢复 → 退出码 0（`ALL_PAGES=true`）。
- **#5**：删 `cwin` 的 `min="1"` → 红；把 `Math.max(1,+win)` 改成 `Math.max(0,+win)` → 红；恢复 → 绿；`_check_orbit.js` n=20 fail=0。
- **#6**：CDP 实测初始 2 行 → 弹确认「删除天体「A」…」→ 取消仍 2 行 → 确认变 1 行；变异把确认改成 `if (false)` → 弹窗 0 次、取消后 1 行 → 红。
- **#7**：kids 失败后「再试一次」可见，点击后同步回到「正在算……」并收起；universe 错误条点「重试」后 `#compute` disabled；删 `display=''` / 把监听改 `if(false)` 均红。
- **#8**：移除两处 `min-width` 后真 Chrome 实测 `<44px` 控件 7 个（红）；恢复后 0 个（绿）。

## 二、未修（有客观判据，但实测否决或超出单笔范围）

**U-01 `/universe` 慢网首屏**：唯一实际尝试是 zstd 压缩。Chrome headless、400kbps/50ms、禁缓存、5 轮中位数、同一设备与同一 worktree：

| 方案 | FCP 中位数 | load 中位数 | `universe.html` 传输字节 |
|---|---:|---:|---:|
| gzip（现状） | 451 ms | 2897 ms | 135,011 B |
| zstd level 19 | 701 ms | 2342 ms | 107,505 B |
| zstd level 9 | 740 ms | 2363 ms | 121,182 B |

主指标 load 降约 555 ms，但副指标 FCP 升 250–289 ms；上升来自浏览器 zstd 解码/缓冲，不属于「缓存或延后命中」例外。按规则**回滚 `tools/webapp.py`**（`git checkout --` 恢复，工作区干净），未提交、未留下这次改动。基线里写的结构性拆分（把非首屏脚本拆成延迟脚本，预估省 9–15KB gzip）本轮未做：单笔会超 300 行，且必须自带前后实测，属独立 PR。

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
- **触控热区**：390×844 + `hasTouch` 下，四页 110 个可点控件全部 ≥44×44（复选框按外层 label 计）。

## 五、门禁真实尾行（head `87fd11b`）

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

未整跑 `_verify_all.ps1`：它的 `$R` 硬编码到另一份工作树，且 C/D 层需要 zig 编译内核（约 3.5 分钟）后才成立；本轮改动只在 `viewer/*.html`，C++ 与内核未动。D/E 层依赖内核二进制的探针在本机因 `build/bin/starpivot.exe` 缺失（`/api/health` 返回 `status:"no-exe"`）无法成立，与基线记录的环境故障一致，不当作回归。

## 六、未覆盖与风险

- 真实读屏软件、真实 4G/弱网（本地是 curl 限速与 Chrome 网络模拟）、真机触摸（本地是 `hasTouch` 模拟）、320/768/1440 全视口视觉回归均未做。
- `/universe` 慢网仍为 2.61 s（门槛 2.5 s），未修；这是本报告唯一残留的 P1 性能缺口。
