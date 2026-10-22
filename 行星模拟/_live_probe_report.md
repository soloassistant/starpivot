# 日志 §22 · T1（P0）页面级探针打线上 —— 结果报告

- 目标：把 **E 层（页面级）判据**从 `http://localhost:8765` 挪到**线上站**跑一次，补上"发布完了但没人验收"的空档。
- 线上站：`https://starpivot-universe.app.workbuddy.host`
- 本轮 `STARPIVOT_BASE=https://starpivot-universe.app.workbuddy.host`
- 运行窗口：`2026-09-27 21:59:27 → 22:00:28`（顺序执行，无并行）
- 本地基线快照（跑前拷贝，未移动）：`_live_baseline/`
- 角色边界：只读 + 只新增文件；未改任何探针 / 页面 / 判据 / 内核；未发布；未跑 `_runall.sh` / `_verify_all.ps1` / 任何编译。

---

## ① 分类结果

**先分类，再跑。** 全仓探针只读**一个**环境变量：`process.env.STARPIVOT_BASE`，出现 4 次（home / kids / orbit / realpage）。其余候选把 BASE **硬编码**成 `http://localhost:8765`，且**没有任何 argv 或间接覆盖机制**（已核 `process.argv` / `process.env` 全仓）。在不修改脚本的前提下，硬编码的那批**无法指向线上**。

| 探针 | 认 `STARPIVOT_BASE`? | 是否需本地文件/内核 | 判定 |
|---|---|---|---|
| `_probe_home.js` | ✅（`_probe_home.js:15`） | 否（纯 fetch + jsdom） | **打线上** |
| `_probe_kids.js` | ✅（`_probe_kids.js:18`） | 否（纯 fetch + jsdom） | **打线上** |
| `_probe_orbit.js` | ✅（`_probe_orbit.js:24`） | 否（纯 fetch + jsdom） | **打线上** |
| `_probe_realpage.js` | ✅（`_probe_realpage.js:31`） | **是**（读本地 `universe.html` + `real_exoplanets.json`） | **打线上（E 节打线上；A–D 用本地 checkout）** |
| `_probe_dualmode.js` | ❌ 硬编码 | 否 | skip |
| `_probe_play_modes.js` | ❌ 硬编码 | 否 | skip |
| `_probe_tour.js` | ❌ 硬编码 | 否 | skip |
| `_probe_nav.js` | ❌ 硬编码 | 否 | skip |
| `_probe_errbar.js` | ❌ 硬编码 | 否 | skip |
| `_probe_quality.js` | ❌ 硬编码 | 否 | skip |
| `_probe_session.js` | ❌ 硬编码 | **是**（读本地 HTML 文件） | skip |
| `_probe_firstpaint.js` | ❌ 硬编码 | **是**（起本地 Windows exe，回放类） | skip |

### skip 原因（逐条）

1. **硬编码 `localhost:8765`、纯页面级（6 只）**：`dualmode / play_modes / tour / nav / errbar / quality`。
   它们**全程只依赖 HTTP + 页面自身**（`nodeFetch(BASE + '/universe.html')` + jsdom，无 `fs.readFileSync`），本质**可以**打线上 —— 唯一障碍是 `const BASE = 'http://localhost:8765'` 写死，且不认 `STARPIVOT_BASE`。
   **本轮判定 skip**：要指向线上必须改脚本，而任务明令"不要修改任何探针脚本"。强行跑只会去打本地 8765（本地网关当前确实活着，返回 200），**得不到任何关于线上的新信息**。
2. **`_probe_session.js`**：除硬编码外，还在 `_probe_session.js:11` 读了**本地 HTML 文件**（`fs.readFileSync(HTML_PATH)`）→ 两条理由同时成立。
3. **`_probe_firstpaint.js`**：写死 `localhost:8765`，且 `require('./_runner')` 后用 `R.spawn(EXE,…)` 起**本地 Windows exe**（`starpivot/build/bin/starpivot.exe`）。**回放类内核探针，对线上不适用**，数字坐实：
   - `_replay.json` 指纹：`exe_size=1065472`、`exe_sha1=94def73b463c7ffe…`（= 本地 Windows exe）；
   - 线上内核：`/workspace/kernel/linux-x86_64/starpivot`，`size=8776712`，`platform=posix`（Linux 静态 ELF，`_probe_linuxbin.txt` 亦确认静态链接）。
   - `_runner.js` 的 `exeOk()` 按 **size + sha1** 校验，二进制不同 → **整份录制作废**（该文件的注释也明说"拿旧内核的输出去喂新内核的断言会悄悄通过"，所以宁可作废）。**故直接 skip，不硬跑。**

> 关于任务里的第 2 步：`grep -l STARPIVOT_REPLAY _probe_*.js` **空手而归**（0 命中）。原因：`STARPIVOT_REPLAY` 是在共享的 `_runner.js` 里读的，**不在**任何 `_probe_*.js` 里。回放类探针的真正签名是 `require('./_runner')` / 使用本地 `starpivot.exe`；本批 12 只里只有 `_probe_firstpaint.js` 命中。

---

## ② 逐只实际结果（文件名 + `n=/fail=` + mtime + 退出码）

权威信号 = ① 退出码；② 探针自己落盘文件的 `n=… fail=…` **且 mtime 落在本轮（21:59–22:00）**。

| 探针 | 退出码 | 结果文件 mtime（本轮） | 文件内 `n=/fail=` | 备注 |
|---|---|---|---|---|
| `_probe_home.js` | **0** | `_probe_home.txt` → 2026-09-27 21:59:38 | **文件内无汇总行**；明细 18 PASS / 0 FAIL | 汇总行 `[home-e2e] n=18 fail=0` 只在 stdout（见 `_live_home.out`） |
| `_probe_kids.js` | **0** | `_probe_kids.txt` → 2026-09-27 22:00:07 | **文件内无汇总行**；明细 32 PASS / 0 FAIL | 汇总行 `[kids-e2e] n=32 fail=0` 只在 stdout（见 `_live_kids.out`） |
| `_probe_orbit.js` | **0** | `_probe_orbit.txt` → 2026-09-27 22:00:17 | `[orbit-probe] n=31 fail=0` | 文件内即含汇总行 |
| `_probe_realpage.js` | **0** | `_probe_realpage.txt` → 2026-09-27 22:00:26 | `[realpage] n=50 fail=0` | E 节真跑了线上网关（见下） |

运行日志（含每只起止时刻 + 落盘 mtime）：`_live_run.log`。
原始 stdout：`_live_home.out` / `_live_kids.out` / `_live_orbit.out` / `_live_realpage.out`。

`realpage` 的 E 节确实打到了线上（非 skip）：输出含 `网关…回显与数据文件全部对上`、`5 个真实系统 + 对照组` 全过，且逐系统打印了观测 L vs 模型 L（例：`Proxima Cen：观测 L=0.001262 vs 模型 L=0.0006361（差 1.98 倍）`）。即：**线上网关转发的 `/api/dataset/real_exoplanets` 与本地磁盘那份逐字段一致，且线上内核回显与本地数据文件全部对上。**

---

## ③ 本地基线 vs 线上（逐只对照）

本地基线取自 `_live_baseline/`（跑前拷贝）：

| 探针 | 本地基线 | 线上 | 一致性 |
|---|---|---|---|
| home | 18 PASS / 0 FAIL（mtime 19:48:11） | 18 PASS / 0 FAIL（21:59:38） | ✅ 计数一致 |
| kids | 32 PASS / 0 FAIL（19:48:39） | 32 PASS / 0 FAIL（22:00:07） | ✅ 计数一致，**逐字节相同** |
| orbit | `n=31 fail=0`（19:48:49） | `n=31 fail=0`（22:00:17） | ✅ 计数一致 |
| realpage | `n=50 fail=0`（19:47:30） | `n=50 fail=0`（22:00:26） | ✅ 计数一致 |

**结论：无"本地绿、线上红"。** 四只全部线上绿。

逐字节 diff 只出现 3 处差异，**全部是"正确地反映了目标不同"，不是缺陷**：

1. `_probe_home.txt` 第 5–6 行：
   - 本地 `平台来自…回显（nt）` / `字节数…（1065472）`
   - 线上 `平台来自…回显（posix）` / `字节数…（8776712）`
   → 这正是探针**如实把 `/api/health` 回显写进页面**的证明：本地网关跑 Windows exe（`nt`，1065472 B），线上跑 Linux 静态 exe（`posix`，8776712 B）。**这是预期的、也是判据本身要抓的那件事。**
2. `_probe_orbit.txt` 第 1 行抬头打印了 BASE（`https://…` vs `http://localhost:8765`）—— 仅抬头文案。
3. `_probe_realpage.txt` 第 42 行 `PASS 本地服务在跑（…）` 打印了 BASE —— 断言通过，只是**文案仍写"本地服务"，此时指的是线上**（措辞问题，非判据失败）。

---

## ④ 没能验证的东西（明确列为"未验证"）

1. **7 只硬编码探针在线上完全未验证**：`dualmode / play_modes / tour / nav / errbar / quality / session`。
   它们在线上是**一次都没跑过**，不是"通过"、也不是"失败" —— 是**未验证**。当前线上只被 4 只判据看过（home / kids / orbit / realpage）。
   ⚠ 因此**不能**说"线上页面级判据全绿"：线上站点里 `universe.html` 的双模式、玩法、导览、导航、错误条、质量、会话这 7 类页面行为，**证据为零**。
2. **`_probe_firstpaint.js` 的性能判据在线上未验证**：它的录制绑本地 Windows exe，线上 Linux exe 二进制不同 → 无法回放，线上首帧/各段耗时**未测**。
3. **线上内核本体未被任何"内核级"判据验证**：本批 4 只只做页面级 + 少量 `/api/health`、`/api/dataset`、`/api/nbody` 链路；内核的数值正确性、类型表、辛性等**不在本轮范围内**（且回放类探针对线上不适用）。
4. **未做任何写操作/发布/改动**：本轮**没有**触达发布、上传、配置等任何在线写路径（除下述 POST，见 ⑤）。

---

## ⑤ 异常 / 不确定项（如实报告，未顺手修）

1. **home / kids 的结果文件里没有 `n=/fail=` 汇总行**。
   两只探针只在 `process.on('exit')` 里把**断言明细**（`LOG`）落盘，`[home-e2e] n=…` / `[kids-e2e] n=…` 只 `console.log` 到 stdout。
   影响：按本仓硬纪律"从结果文件读 `n=/fail=`"，这两只**读不到**。我改用 ① 退出码（均 0）+ ② 逐行数 PASS/FAIL（各 18/0、32/0）作为替代证据，并附 stdout 汇总行。**这是探针落盘写法差异，不是线上缺陷**；但会让"只看文件"的收集轮对这两只判据得不到自报项数 —— 值得钉一条。
2. **任务给的 `grep -l STARPIVOT_REPLAY _probe_*.js` 是空操作**（0 命中），因为该变量在 `_runner.js` 里读。若照此 grep 做分类，会漏判 `_probe_firstpaint.js` 为回放类。见 ① 的说明。
3. **任务给的代理端口与实际不符**：实测 `HTTP_PROXY/HTTPS_PROXY = http://127.0.0.1:64375`（**不是** 50340）。
   连通性实测（结论入档）：
   - `curl`（带代理）→ 200；`curl --noproxy '*'` → 200（**两者皆通**）；
   - node `fetch`（带代理 env）→ 200；node `fetch`（清空代理 env）→ 200；
   - node `https` 模块（清空代理 env）→ 200。
   → **本机未复现"代理把 127.0.0.1 也接走导致 502"**；也**未复现"node fetch 不通"**（node `fetch` 实测**能**打到线上，与任务描述相反）。本轮为稳妥起见，探针以**清空代理变量**的方式运行（已证可用）。
4. **本轮存在对线上的 POST（需明示）**：home / kids / orbit / realpage 加载页面时，页面脚本会对 `POST /api/nbody` 发起计算请求（这正是浏览器打开页面时本来就会发的）。
   已核网关源码 `starpivot/tools/webapp.py:278 api_nbody()`：它只是起 CLI 算完返回 JSON，**无任何持久化/状态写入**（非"写操作"）。但任务边界写的是"只读 GET"，**此处与字面要求有出入，特此点明**，请确认这是否可接受。
5. **realpage 的 A–D 节其实验对象是本地 checkout**（`starpivot/viewer/universe.html`、`starpivot/data/real_exoplanets.json`），只有 E 节打线上。
   含义：它证明的是"**线上网关/内核 与 本地这份 checkout** 对得上账"。若本地 checkout 与线上部署的页面/数据本就有差异，本探针**无法单独**区分是"线上错"还是"本地新/旧"。其全绿**不能**解读为"线上页面代码本身被验过"。
6. 未见 NUL 字节、未见 CR 字节、`orbit`/`realpage` 结果文件各只有**一条**汇总行（无重复汇总行）。`_runall.txt` 未用作判据（遵纪律）。

---

## 附：本轮新增文件

- `_live_baseline/` —— 跑前的本地 `_probe_*.txt` 快照（**拷贝**，未移动原件）。
- `_live_probe_report.md` —— 本报告。
- `_live_run.log`、`_live_{home,kids,orbit,realpage}.out` —— 本轮运行日志与 stdout。
- 被**覆盖**的判据文件（属探针固有行为，非我所"改"）：`_probe_home.txt`、`_probe_kids.txt`、`_probe_orbit.txt`、`_probe_realpage.txt`（mtime 已落在本轮，见 ②）。
