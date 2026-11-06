# StarPivot 上线级 UI 基线审查

- 审查对象：`main` @ `02edaec`（四页：`/`、`/kids`、`/orbit`、`/universe`）
- 审查日期：2026-11-05
- 方法：本地 webapp（`tools/webapp.py`）+ Node 静态判据 + Playwright 实际打开四页；体积用本地字节、Python `gzip.compress(level=6)`、`curl --compressed` 三种口径交叉核对。
- 说明：本机缺 `build/bin/starpivot.exe`，`/api/nbody` 的 500 属环境故障；审查正是利用它观察真实失败态。

## 一、首屏实测（U-01）

| 页面 | 首屏文件 | 原始 | gzip | `curl --compressed` | 400kbps 实测 |
|---|---|---:|---:|---:|---:|
| `/` | `home.html` + health + favicon | 43,992 B | 18,107 B | 18,070 B | 0.36 s（按 18KB 估算） |
| `/kids` | `kids.html` + health + favicon | 66,711 B | 25,632 B | 25,546 B | 0.51 s（估算） |
| `/orbit` | `index.html` + `world.js` + health + favicon | 82,147 B | 30,545 B | 30,485 B | 0.61 s（估算） |
| `/universe` | `universe.html` + dataset + health + favicon | 354,613 B | 134,615 B | 134,124 B | **2.61 s（curl 50KB/s 实测）** |

- 体积门槛 ≤300KB：四页全部通过（最大 `/universe` 134.6KB）。
- 慢网 ≤2.5s：`/universe` 在 400kbps 下 **2.61s**，超 0.11s；其余三页远低于门槛。curl 对小文件有缓冲，小文件的时间只作估算。
- `_check_orbit.js`：n=20 / fail=0；`build-world-land.mjs --check`：OK（`world.js` 差分编码未被本次改动）。
- 首屏请求：`/` 为 `/`、`/api/health`、`/favicon.svg`；`/kids` 同构；`/orbit` 为 `/orbit`、`/world.js`、`/api/health`、`/favicon.svg`；`/universe` 多一个 `/api/dataset/real_exoplanets`。四页均无外部 CDN/字体请求。

## 二、U-01 ~ U-11 逐条对表

| 编号 | 实测 | 结论 | 级别 | 证据 / 修法 |
|---|---|---|---|---|
| U-01 首屏性能 | 见上表 | 体积通过；`/universe` 慢网超 0.11s | P1（universe）/ 其余通过 | `universe.html` 354,613 B 单文件，gzip 134,615 B；把「挑战/类型表」等非首屏逻辑拆成延迟脚本可减约 9–15KB gzip |
| U-02 图片 | 全站仅 `favicon.svg`（1,472 B），无 `<img>`、无 `background-image`、无外部图标库；破图 0 | 通过 | — | 无新增图片需求；后续若加图，用 SVG/WebP 并写 `width/height` |
| U-03 无障碍 | 6 个 canvas 均有 `role="img"` + 非空 `aria-label`；正文 token 对比度全部 ≥4.5:1（实测最低 4.68）；`:focus-visible` 四页均有；触摸设备 `min-height:44px` 四页均有 | 基本通过 | P2 | 未做真实读屏/全键盘 walk-through（**未测**）；canvas 的 `aria-label` 是静态描述，建议把当前场景/结果摘要同步进去 |
| U-04 双语 | 四页正文均为中文；英文仅专有名词/单位（ISS、TLE、NASA、AU、N-body） | 通过（中文单语，无英文 UI 文案） | — | 无需改动；若未来出海再抽 i18n |
| U-05 状态完整 | `/api/nbody` 500 时：`/kids` 的 `#ptip` 显示「没能算出来：找不到 …starpivot.exe —— 请先编译（这一页需要一个在跑的服务…）」；`/universe` 正文显示「这次重算失败了…内核说：找不到 …exe」，均非白屏；无重试按钮（重算需改控件再触发）；demo.js 失败有占位与重试 | 有提示、无显式重试 | P1 | 给两页加「重试」按钮并统一措辞；`/kids` 的「直接双击打开文件是不行的」在服务已启动但内核缺失时会造成误判 |
| U-06 危险操作 | `/universe` 删除观测行（L1285）、删除方案（L2509/L2579）**无二次确认**，点击即从 localStorage 状态移除；`resetview` 只重置视角，非破坏性 | 部分不达标 | P1 | 删除方案加 `confirm` 或「撤销」toast；观测行删除同理；约 20 行 |
| U-07 主题 | 无明暗切换；`/`、`/kids`、`/orbit` 为浅色，`/universe` 为深色（页面注释称为刻意设计）；无 `prefers-color-scheme` 分支 | 不达标（可接受的设计取舍） | P2 | 若要支持系统主题，需把四页 token 收进 `base.css` 后用 `[data-theme]` 切换；当前不改避免破坏 `universe` 深空视觉 |
| U-08 输入边界 | `/kids` 两个 range 有 min/max；`/universe` 多数 number 有 min/max；`/orbit` 碰撞参数 `cwin`/`cstep`/`cthr`（L342–344）**无 min/max**，负数/0 会直接发给内核 | 部分不达标 | P1 | 给三个输入补 `min`（窗口≥1、步长>0、阈值≥0）并在提交前 clamp；约 12 行 |
| U-09 隐私 | 无 analytics、无错误上报、无第三方脚本/CDN；`localStorage` 仅存本页自己的会话状态（`STORE_KEY`/`CH_BEST_KEY`），不含 PII | 通过 | — | 保持；未来若接统计需先补隐私说明 |
| U-10 一致性 | 四页各自内联 `:root`，**同一套 48 个 token 名 ×4**；home 与 index 的 19 个颜色值逐字相同，kids 交换 accent/accent2 并换暖底，universe 换深空调色板；内联 CSS 合计 89.4KB（home 24,737 / kids 16,456 / index 18,315 / universe 29,862） | 不达标（重复度高、易漂移） | P1 | 抽 `viewer/base.css`：48 token 名 + reset/body + card/table/badge/note/footer/focus/coarse 规则。预估 base.css 约 180–220 行、约 8KB 原始 / 2.5–3KB gzip；四页各删 6–8KB。回归风险：级联顺序（base 必须在页面内联之前）、kids/universe 主题覆盖需放在 base 之后、页面专属 margin 需保留 |
| U-11 合规触点 | Natural Earth 仅在 `home.html` 数据表（L438–439，文字「Natural Earth 110m / public domain」）和 `index.html` 图例（L299）出现，**无来源链接、无署名说明**；kids/universe 无；无隐私政策/使用条款入口 | 不达标 | **P0（署名）/ P1（隐私条款页）** | P0：四页 footer 增加「陆地数据：Natural Earth 1:110m（公有领域）」+ 官方 terms 链接 + 一句「不收集个人数据、无第三方跟踪」；约 24 行 |

## 三、重点勘察

### 1）`/api/nbody` 500 的真实表现

- `/kids`：`fetchT()` 有 15s/60s 超时（`AbortController`），500 会走 `catch`，把 `period` 置 `—` 并在 `#ptip`（`aria-live="polite"`）写出原因；不白屏、不丢已有画面。缺「重试」按钮。
- `/universe`：`compute()` 失败会在状态区写出「这次重算失败了…内核说：<错误>」，保留已有场景；同样缺重试按钮。
- 两页 console 仍有 1 条浏览器级 `500` resource error（无法被页面 JS 消除），与基线一致；不影响可读性，但上线监控需把它计为「后端不可用」而非前端报错。
- 结论：**不是白屏，属于「有提示但缺重试」**，P1 而非 P0。

### 2）四页设计令牌重复程度与 `base.css` 可行性

- token 名 48 个 ×4 页，完全同名；home/index 颜色值完全相同（浅色技术版），kids 仅换 `accent`/`accent2`/暖底，universe 换深空 19 色。
- 重复的不只是 token：`box-sizing`/body、`.card`、`h2/h3`、`table`/`th/td`、`.badge`、`.note`/`.warnbox`/`.okbox`、`footer`、`:focus-visible`、`pointer:coarse` 44px 规则在四页各写一遍。
- 收益：`base.css` 约 8KB 原始 / 2.5–3KB gzip，四个页面共享缓存后重复访问每页少 6–8KB；代码层面去掉约 3,000 行重复声明（按 diff 计远超单笔 300 行上限）。
- 回归风险：① `base.css` 必须 `<link>` 在每页 `<style>` 之前，否则页面覆盖失效；② `universe` 深色、`kids` 暖色必须在 base 之后覆盖；③ `.entry`/`.mapcard`/`.challengebox` 等页面专属布局不能进 base。
- 建议拆成两笔：先「token + reset + focus + coarse」一笔（约 120 行新增 + 4 个 link + 每页删 30–40 行，≤300），再「组件层」一笔。**本轮不做**（P1）。

## 四、P0 清单与修复

| ID | 问题 | 修法 | 预估 |
|---|---|---|---|
| P0-1 | Natural Earth 署名不完整且仅 2/4 页可见、无来源链接；无隐私说明入口 | 四页 footer 统一加一行合规说明：Natural Earth 1:110m（公有领域）+ 官方 terms 链接 + 不收集个人数据/无第三方跟踪 | 实测 +7 行 |

P0 修复 PR：https://github.com/soloassistant/starpivot/pull/3（`fix/sp-legal-footer`，base `main`，未合并）。
变异结果：删掉 `kids.html` 一行 → `ALL_PAGES=false`（exit=1）；恢复 → `ALL_PAGES=true`（exit=0）。

P1 待办（本轮不修）：U-01 universe 慢网 2.61s；U-05 重试按钮；U-06 删除确认；U-08 orbit 输入边界；U-10 `base.css`；U-11 独立隐私/条款页。

## 五、未测项

- 真实读屏软件（NVDA/VoiceOver）与全键盘 Tab 顺序；仅做了 DOM/ARIA 静态检查。
- 线上实际网络（4G/弱网）耗时；本地用 `curl --limit-rate 50k` 模拟 400kbps。
- 真机触摸热区；仅核对 CSS `pointer:coarse` 规则。
- 各页在不同视口（320/768/1440）下的视觉回归；本轮只测桌面默认视口。
