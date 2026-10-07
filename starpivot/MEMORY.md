# MEMORY.md — StarPivot 项目记忆

只记"文档里查不到、且下次会再踩"的东西。已写进 `AGENTS.md` 的硬规矩不重复。

## 环境（本机）

- **真解释器不在 PATH 上**。`python` 指向 Windows 商店占位程序
  （`C:\Users\geral\AppData\Local\Microsoft\WindowsApps\python.exe`），执行后**没有任何输出也不报错**。
  实际可用的是 uv 装的：`C:\Users\geral\AppData\Roaming\uv\python\cpython-3.12-windows-x86_64-none\python.exe`。
  起网关要写全路径，否则会"启动成功但什么都没有"。
- **8765 端口上可能跑着几天前的旧进程**。本轮实测：占用者启动于 10/01，而源码可能是之后改的。
  → 改完 `tools/webapp.py` 必须重启该进程才生效；验证前先确认进程启动时间。
  需要干净对照时，另起一个端口（如 `--port 8799`）跑当前源码。
  勘误（2026-10-05）：「旧进程 ⇒ 提供的 HTML 也是旧的」**不成立**。
  实测老网关以文本模式读文件，universal.html 的 CRLF 被归一成 LF，字节数差 4562，
  看着像内容不一致；把服务端副本还原成 CRLF 后 SHA256 与磁盘**完全相同**。
  → 怀疑静态资源过期前，先比哈希并把换行符算进去，别直接下结论。
- **jsdom / playwright-core 早就装好了，别再折腾 npm**。
  位置固定在 `_verify_all.ps1` 开头那行 `$env:NODE_PATH`：
  `C:\Users\geral\.workbuddy\binaries\node\workspace\node_modules`
  （jsdom 30.1.1、playwright-core 1.63.0）。仓库根**没有** `package.json`，也不需要。
  本机的 `npm` 在 PowerShell 下被执行策略拦下（`npm.ps1` → PSSecurityException），
  想绕就得用 `npm.cmd` —— 但既然依赖本来就在，这一步可以整个跳过。

## 测试工装（这条让我误判过两次）

- **PowerShell 传 JSON 给 curl 会被剥掉双引号**。
  `--data-raw '{"scenario":"figure8"}'` 实际发出去的是 `{scenario:figure8}`（18 字节），
  JSON 无效 → 网关 `_read_body()` 的 `except` 吞掉 → 返回 `{}` → 网关用默认值跑默认场景。
  现象极具误导性：**看起来像"网关忽略请求体"**。
- 正确做法：payload 写进文件，用 `--data-binary "@C:\path\p.json"`。
- 识别信号：响应里的 `Content-Length` 比你以为的 body 长度小 → 引号被吃了。

## 线上部署现状（2026-10-05 实测）

- 后端**行为正确**：`scenario=figure8` 返回 figure8；非法 `scenario` 正确返回 400；
  `samples=10`→52KB / `samples=2000`→1.53MB，参数确实生效。
- 冷启动明显：空闲后首个请求 4.2–5.4s，`/api/dataset/*` 首次 20.5s。
  热连接（keep-alive 复用）`/api/health` 只要 0.34–0.61s。
- **一次 `/api/nbody` 往返实测 23,190 ms**（`_probe_dualmode.txt` 第 33 行自己记的）。
  → 在内置浏览器里目视验收 universe 页时，等待窗口要 **> 30 秒**，8 秒或 15 秒都是无意义的。
  这条坑的识别特征很明确：`#statline`/`#tlabel`/`#verdict`/`#enote` 四个 DOM 同时为空、
  能量误差曲线画布空白，但**行星已经在画布上画出来了**。
  这不是回归，是首次内核计算没回来 —— `data === null` 时 `render()`（4259–4271 行写
  tlabel/statline 并调 `maybeDrawEnergy()`）和 `verdict()` 都不会跑，`buildPalette()`
  （2238 行）等的是同一个响应里的 `bodyTypes`。
  判据侧佐证：`_probe_tour.js` 43/43 通过且「全程无脚本异常」，明确断言能量曲线画出了
  纵轴刻度 1e-6~1e-3、`|E−E₀|/|E₀|` 标签和「当前 t =」游标，内核回了 2001 个能量点。
  → 遇到"面板全空"先数秒再看；真有回归的话 `_probe_tour.js` 会红。
- 边缘 CDN 目前**对所有响应都不缓存**（`Eo-Cache-Status: MISS`），因为网关对一切回 `Cache-Control: no-store`。
- 边缘**不做压缩**：即使带 `Accept-Encoding: gzip, deflate, br`，`universe.html` 仍回 264,185 字节原文。
- 实测 gzip-6 收益：`universe.html` -63%、`home.html` -60%、1.53MB 计算响应 -72%（level 9 无额外收益）。

## 前端

- `viewer/universe.html` 是最大的一页（本地 270KB），默认参数 `years=50` `samples=2000`，
  一次 `POST /api/nbody` 回来 1.53MB JSON。
- 三页的 `fetch()` **都没有超时**：`home.html`（健康检查）、`universe.html`（`compute()`）、
  `kids.html`（`run()`）都是裸 `await fetch(...)`，没有 `AbortController`。
  冷启动或后端慢时，界面会无限停在"正在问内核……" / "积分中……"，既不报错也不超时。
- 2026-09-28 的 a11y 审查建议 1–4 **已落地**（`docs/review-2026-09-28-frontend-a11y.md` §6，
  共 65 处改动）。`viewer/README.md` 末尾曾写"尚未动手改"，是过期描述，已更正。

## 判据

- 仓库根的 12 只页面级探针里，只有 4 只（home/kids/orbit/realpage）认 `STARPIVOT_BASE` 环境变量，
  其余硬编码 `http://localhost:8765`，**无法直接打线上**。
- `_probe_firstpaint.js` 是回放类，录制绑本地 Windows exe 的 `size + sha1`；
  线上是 Linux 静态 ELF（8776712 B），**回放不适用**，线上性能判据属未验证。
- home / kids 两只探针**只在 stdout 打 `n=… fail=…`，结果文件里没有汇总行**，
  收集轮按"从文件读汇总"会读不到。
- **本机没装 jsdom，仓库根也没有 `package.json`**。18 个脚本依赖 jsdom
  （`_a11y_verify*` / `_probe_*` / `_runner`），当前全部跑不起来（`MODULE_NOT_FOUND`）。
  不跑 jsdom 的那批（`_check_home` / `_check_kids` / `_check_bio_page` / `_check_orbit`
  / `_check_session` / `_cmp_lists`）是好的，改完前端先跑这批。

## 内置浏览器里看这个站会得到假象（2026-10-05 踩到）

用 FilePanel 内置浏览器打开 `universe.html`，会看到按钮长期停在"积分中…"、
画布只有背景星空、`#statline` 与 `#errbar` 都空、控制台零报错 ——
看起来像核心功能挂了。**这不是站点缺陷。**

网关 stderr 里的实据：

```
"POST /api/nbody HTTP/1.1" 200 -          ← 内核算完了，200 也记下来了
...
webapp.py", line 165, in _send → self.wfile.write(data)
ConnectionAbortedError: [WinError 10053] 你的主机中的软件中止了一个已建立的连接
```

即**客户端在收大响应（1.5MB，gzip 后 441KB）时主动断开**。小响应
（`/api/health`、kids 那 1.5 万字符的 payload）都能正常完成。
curl 与 Node 走同一接口从不失败。FilePanel 面板不可见时全部标签被视为后台，
渲染进程被冻结/回收，取消在途请求 —— 与现象完全吻合。

**判据**：在内置浏览器里看到"永远算不完"，先看网关 stderr 有没有
`WinError 10053`。有就是浏览器侧的假象，别去改前端的渲染或错误处理。
另外这套环境里 network / console 诊断经常返回 0 条（`lastSequence: 0`），
不能拿"没报错"当"没问题"的证据。

