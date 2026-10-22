#!/usr/bin/env python3
"""webapp.py — starpivot 本地试用服务（单端口）.

职责边界（重要）:
  这是一个**薄转发层**。它只做两件事：1) serve viewer/ 静态页；2) 把浏览器请求
  原样转交给已验证的 C++ CLI（starpivot conj / verify-tle）或
  tools/find_close_approaches.py。**本文件不做任何数值计算** —— 页面上出现的
  每一个数都来自 starpivot CLI 的 JSON 输出。

用法:
    python tools/webapp.py [--port 8765]
然后浏览器打开 http://localhost:8765
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
VIEWER = ROOT / "viewer"


# 内核二进制**按平台选**，不再写死 `.exe`。
# 理由不是洁癖：发布出去的服务跑在 Linux 沙箱里，写死 `.exe` 的结果是
# "页面打得开、一点算就报找不到内核" —— 这种失败在本地永远复现不出来，
# 所以只能靠这里选对，并且在健康检查里如实回报（exists=false，不假装）。
#
# `kernel/` 那一支是**给发布用的**，放的位置是被逼的：发布时 `build/` 属于
# "构建产物"会被排除在压缩包外，所以编好的 Linux 内核不能放在 build/ 下面，
# 否则本地测得好好的，上传之后沙箱里根本没有这个文件。
def _pick_exe() -> Path:
    b = ROOT / "build"
    order = ([b / "bin" / "starpivot.exe", ROOT / "kernel" / "linux-x86_64" / "starpivot",
              b / "linux" / "starpivot", b / "bin" / "starpivot"]
             if os.name == "nt" else
             [ROOT / "kernel" / "linux-x86_64" / "starpivot", b / "linux" / "starpivot",
              b / "bin" / "starpivot", b / "bin" / "starpivot.exe"])
    for c in order:
        if c.is_file():
            return c
    return order[0]


EXE = _pick_exe()


def _ensure_executable(p: Path) -> None:
    """上传后常常丢掉可执行位（压缩/解包不保留 mode），那会变成
    `Permission denied` —— 一个从报错本身完全看不出原因、但在沙箱里必现的故障。
    所以启动时补一次；补不上也不静默：健康检查会如实报 exists/exec。"""
    if os.name == "nt" or not p.is_file():
        return
    try:
        if not os.access(p, os.X_OK):
            p.chmod(p.stat().st_mode | 0o111)
            log(f"内核缺少可执行位，已补上: {p}")
    except OSError as e:
        log(f"警告: 补可执行位失败（{e}）—— 计算会报 Permission denied")


FIND_TOOL = ROOT / "tools" / "find_close_approaches.py"

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}

# 静态资源的缓存策略。
# 原来这里对**一切**响应都回 `Cache-Control: no-store`，后果是：
#   1) 边缘 CDN 完全没有可存的东西（实测每一次都是 `Eo-Cache-Status: MISS`）；
#   2) 每次回访都要重下整份页面 —— universe.html 一个文件 264KB。
# 页面与数据文件只在发布时变，所以给一个短 TTL + ETag 是安全的：
# 5 分钟内由边缘直接吐（不再回源），超过 5 分钟用 ETag 条件请求拿 304（几百字节）。
# 想更保守就把 300 调小或改成 0；只要 ETag 在，条件请求这条路就一直有效。
STATIC_CACHE = "public, max-age=300, must-revalidate"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------- helpers
    # 小于这个体积的响应压了不划算：gzip 头和查表都要钱，省下的几十字节没人感觉得到。
    GZIP_MIN = 512
    # 这些后缀本身已经是压缩格式，再压一遍只是白烧 CPU。
    NO_GZIP_EXT = {".png", ".ico", ".jpg", ".jpeg", ".webp", ".gz", ".zip",
                   ".woff", ".woff2", ".mp4", ".webm"}

    def _accepts_gzip(self) -> bool:
        return "gzip" in (self.headers.get("Accept-Encoding") or "").lower()
    # 本次响应带的 ETag 不用存在 self 上：条件请求的判断只在这一处发生，
    # 把它当参数传比留一份可变状态清楚，也不会在并发连接之间串味。
    def _etag_matches(self, etag: str) -> bool:
        """If-None-Match 命中当前这份资源吗（比较时忽略 W/ 前缀与两端空白）。"""
        raw = self.headers.get("If-None-Match") or ""
        if not raw or not etag:
            return False
        for cand in raw.split(","):
            cand = cand.strip()
            if cand == "*":
                return True
            if cand.startswith("W/"):
                cand = cand[2:].strip()
            if cand == etag:
                return True
        return False

    def _send(self, code: int, body: str,
              ctype: str = "application/json; charset=utf-8",
              *, cache: str = "no-store", etag: str | None = None,
              compressible: bool = True) -> None:
        raw = body.encode("utf-8")
        # 条件请求：客户端手里这份已经是最新版，一个字节都不用再发。
        # 这条是"缓存真的生效"的前提 —— 只给 max-age 而不做条件请求，
        # 过期之后仍然要把整份文件重传一遍（270KB 的 universe.html 就是这个代价）。
        # If-None-Match 按 RFC 可以是逗号分隔的列表，也可以是 `*`，
        # 所以不能只做整串相等 —— 那样代理改写过的头会静默退化成永远 200。
        if etag and self._etag_matches(etag):
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        data = raw
        encoding = ""
        # 边缘与网关都不压缩（实测带 `Accept-Encoding: gzip, deflate, br` 仍回 264KB 原文），
        # 而这些响应里 HTML 与 JSON 的压缩率很高：universe.html -63%、
        # 一次 1.53MB 的 nbody 回执 -72%。gzip 在标准库里，不引任何依赖。
        if compressible and len(raw) >= self.GZIP_MIN and self._accepts_gzip():
            data = gzip.compress(raw, 6)   # 实测 level 9 相比 6 只多省 0.1%，不值那份 CPU
            encoding = "gzip"
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        if encoding:
            self.send_header("Content-Encoding", encoding)
        if etag:
            self.send_header("ETag", etag)
        # Vary 不能省：同一份资源对"支持 gzip"与"不支持 gzip"的客户端是两个不同的字节流，
        # 中间任何一层缓存都必须按这个头分开存，否则会给不支持压缩的客户端
        # 发一份它解不开的响应 —— 那是个只在特定客户端上出现的坏，且很难查。
        if compressible:
            self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        self.wfile.write(data)

    def _json_error(self, code: int, msg: str) -> None:
        self._send(code, json.dumps({"error": msg}, ensure_ascii=False))

    def _drain_body(self) -> dict:
        """把请求体从 socket 上完整读掉并解析。

        为什么要"完整读掉"而不只是"能解析就解析"：这是 HTTP/1.1 keep-alive。
        处理器若没把 Content-Length 那么多字节从 rfile 读干净，剩下的字节就留在
        连接缓冲里；下一个请求到达时，服务器会拿这段残留当**请求行**去解析 ——
        实测踩到过：页面对还不存在的 /api/lagrange 发 POST，旧网关 404 且不读 body，
        于是 `{...}POST /api/nbody` 变成"方法名"，回 501，后续真请求全被这条假
        请求顶掉（表现是重算 200ms 秒回一张 HTML 错误页，前端当成内核拒绝）。
        所以哪怕是 404 / 未知路由，也必须把 body 消费掉。
        """
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        # 分块读完，read() 一次拿 n 字节在 keep-alive 下也可靠，但分块对异常
        # Content-Length 更宽容（对方少发也不至于把连接卡死）。
        remaining = n
        buf = bytearray()
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 65536))
            if not chunk:
                break
            buf += chunk
            remaining -= len(chunk)
        if n > 1_000_000:
            return {}          # 太大了不解析，但上面已经消费干净，连接不受污染
        try:
            parsed = json.loads(bytes(buf).decode("utf-8"))
            return parsed if isinstance(parsed, dict) else {}
        except Exception:  # noqa: BLE001
            return {}

    def _read_body(self) -> dict:
        """返回（并缓存）本次请求体。

        do_POST 在最前面已经排空过一次，这里只负责把结果交出去；懒初始化是为了
        万一某条路径没经过 do_POST 顶部也不至于 AttributeError。
        """
        if not hasattr(self, "_body"):
            self._body = self._drain_body()
        return self._body

    # ------------------------------------------------------------- static
    # 具名路由 vs 直接给文件：这是**信息结构**的区别，不是美观问题。
    # 首页不叫 index.html，是因为"首页"和"轨道递推工具页"是两件事 ——
    # 首页讲"这是什么 / 数据从哪来 / 怎么验"，工具页负责干活。
    # 早先 `/` 直接指向 index.html，等于让工具页兼任首页：第一次来的人
    # 落地就在一堆轨道参数里，而这页要说的那三句话没人说。
    # 直接给文件名也仍然有效（`/index.html` 等照旧），所以老链接不会断。
    ROUTES = {
        "/": "home.html",          # 首页
        "/orbit": "index.html",    # 工具页一：轨道递推 / 星下点 / 碰撞预警
        "/universe": "universe.html",  # 工具页二：N 体宇宙沙盒
        "/kids": "kids.html",      # 给小朋友的一页（正文不许出现术语，见 _check_kids.js）
    }

    def _static(self, path: str) -> None:
        if path in self.ROUTES:
            p = VIEWER / self.ROUTES[path]
        else:
            p = (VIEWER / path.lstrip("/")).resolve()
            # 目录穿越防护：只允许 viewer/ 内的文件
            if not str(p).startswith(str(VIEWER.resolve())):
                return self._json_error(403, "forbidden")
        if not p.is_file():
            return self._json_error(404, f"not found: {path}")
        ctype = MIME.get(p.suffix, "application/octet-stream")
        st = p.stat()
        # ETag 取 mtime+size：够用，且不用为了算哈希把 270KB 的页面读两遍。
        # 依据未压缩内容算，所以与是否压缩无关 —— 换句话说客户端拿到的 ETag
        # 在开不开 gzip 两种情况下是同一个，不会因为压缩方式变化而全部失效。
        etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
        self._send(200, p.read_text(encoding="utf-8"), ctype,
                   cache=STATIC_CACHE, etag=etag,
                   compressible=p.suffix.lower() not in self.NO_GZIP_EXT)

    # ------------------------------------------------------------- APIs
    def _run_cli(self, argv: list[str], timeout: float) -> tuple[int, str, str]:
        if not EXE.is_file():
            raise FileNotFoundError(
                f"找不到 {EXE} —— 请先编译（cmake --build build）或重新构建")
        r = subprocess.run(argv, capture_output=True, encoding="utf-8",
                           errors="replace", timeout=timeout)
        return r.returncode, r.stdout, r.stderr

    def api_cli(self, cmd: str) -> None:
        body = self._read_body()
        try:
            if cmd == "conj":
                argv = [str(EXE), "conj",
                        "--line1", body["line1"], "--line2", body["line2"],
                        "--line3", body["line3"], "--line4", body["line4"],
                        "--window-min", str(body.get("window_min", 1440.0)),
                        "--step-min", str(body.get("step_min", 1.0))]
                if body.get("threshold_km") is not None:
                    argv += ["--threshold-km", str(body["threshold_km"])]
                out = self._run_cli(argv, timeout=120.0)
            elif cmd == "verify-tle":
                tsince = body.get("tsince") or [0, 120, 240, 360]
                argv = [str(EXE), "verify-tle",
                        "--line1", body["line1"], "--line2", body["line2"],
                        "--tsince", ",".join(str(t) for t in tsince)]
                out = self._run_cli(argv, timeout=60.0)
            else:
                return self._json_error(404, f"unknown api: {cmd}")
        except FileNotFoundError as e:
            return self._json_error(500, str(e))
        except subprocess.TimeoutExpired:
            return self._json_error(504, "CLI 超时")
        code, stdout, stderr = out
        if code != 0 or not stdout.strip():
            return self._json_error(400, stderr.strip() or "CLI 运行失败")
        # CLI 输出本来就是 JSON：原样转发
        try:
            json.loads(stdout)
        except Exception:  # noqa: BLE001
            return self._json_error(500, "CLI 输出不是合法 JSON")
        self._send(200, stdout)

    def api_find_close(self, qs: dict) -> None:
        groups = qs.get("groups", ["iridium,globalstar,orbcomm"])[0]
        top = qs.get("top", ["15"])[0]
        cap = qs.get("cap", ["1500"])[0]
        window = qs.get("window_min", ["1440"])[0]
        step = qs.get("step_min", ["1"])[0]
        if not FIND_TOOL.is_file():
            return self._json_error(500, f"找不到 {FIND_TOOL}")
        argv = [sys.executable, str(FIND_TOOL), "--json",
                # 显式把内核路径传下去，别让这个工具用自己的默认值：
                # 它的默认值曾经写死成 `build/bin/starpivot.exe`，在 Linux 沙箱里不存在 ——
                # 现象是"页面和主计算全正常，只有碰撞预警报找不到内核"。
                # 只坏一个功能的故障最难在本地发现，所以路径只由网关这一处决定。
                "--exe", str(EXE),
                "--groups", groups, "--top", top, "--cap", cap,
                "--window-min", window, "--step-min", step,
                "--retries", "3", "--timeout", "20"]
        try:
            r = subprocess.run(argv, capture_output=True, encoding="utf-8", errors="replace", timeout=420)
        except subprocess.TimeoutExpired:
            return self._json_error(504, "真实编目筛选超时（网络较慢时属正常，可重试或换小组）")
        if r.returncode != 0:
            return self._json_error(502, r.stderr.strip()[-400:] or "筛选失败")
        try:
            js = json.loads(r.stdout)
        except Exception:  # noqa: BLE001
            return self._json_error(502, "筛选工具输出不是合法 JSON")
        self._send(200, json.dumps(js, ensure_ascii=False))

    # ------------------------------------------------------------- data
    # 真实数据只读转发。为什么单开一个口子、而不放宽 _static 的目录限制：
    # 静态栏只该服务 viewer/，数据文件是另一类东西 —— 显式列白名单，
    # "页面能读到哪些数据"这件事才看得见，而不是"viewer 目录能不能穿越"的副产物。
    # 这里同样不做任何计算：文件是什么就发什么，每个数都有 data/PROVENANCE.md 可查。
    DATASETS = ("real_exoplanets", "real_stars")

    def api_dataset(self, name: str) -> None:
        if name not in self.DATASETS:
            return self._json_error(404, f"unknown dataset: {name}")
        p = ROOT / "data" / f"{name}.json"
        if not p.is_file():
            return self._json_error(500, f"找不到数据文件 {p}")
        # 数据文件是磁盘上的静态文件，只在发布时变 —— 和 viewer/ 用同一套缓存语义。
        # 这一条收益不小：universe.html 打开时就要拉这两个文件，原来每次都是 no-store。
        st = p.stat()
        etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
        self._send(200, p.read_text(encoding="utf-8"),
                   cache=STATIC_CACHE, etag=etag)

    # ------------------------------------------------------------- verbs
    def do_GET(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        if u.path == "/api/find-close":
            return self.api_find_close(parse_qs(u.query))
        if u.path.startswith("/api/dataset/"):
            return self.api_dataset(u.path[len("/api/dataset/"):].strip("/"))
        if u.path == "/api/health":
            # 健康检查要能回答"**为什么**算不了"，不能只回一个 ok/no-exe。
            # 部署到远端时，这几个字段就是唯一能远程诊断的证据：文件在不在、
            # 有没有可执行位、跑起来是哪个平台的内核。少了它们，线上报错只能靠猜。
            ok = EXE.is_file()
            return self._send(200, json.dumps(
                {"status": "ok" if ok else "no-exe", "exe": str(EXE), "exists": ok,
                 "exec": (os.access(EXE, os.X_OK) if os.name != "nt" else True),
                 "platform": os.name, "size": (EXE.stat().st_size if ok else 0)}))
        return self._static(u.path)

    def do_POST(self) -> None:  # noqa: N802
        # 先把请求体消费掉，再决定路由。这是 keep-alive 的硬要求：
        # 任何一条走到 404 / 未知 api 的路径，若没读 body，残留字节会被下一个
        # 请求当请求行解析（见 _drain_body 的说明）。所以这里无条件先排空，
        # 各 handler 里再用 _read_body() 取缓存，保证"只读一次"。
        self._body = self._drain_body()
        if self.path == "/api/conj":
            return self.api_cli("conj")
        if self.path == "/api/verify-tle":
            return self.api_cli("verify-tle")
        if self.path == "/api/groundtrack":
            return self.api_groundtrack()
        if self.path == "/api/nbody":
            return self.api_nbody()
        if self.path == "/api/lagrange":
            return self.api_lagrange()
        if self.path == "/api/genesis":
            return self.api_genesis()
        return self._json_error(404, f"unknown api: {self.path}")

    def api_lagrange(self) -> None:
        """拉格朗日点：转发 starpivot lagrange。

        五个点的坐标、到两星的距离、稳定性判据与解的残差全部由内核算，
        网关只拼 argv、只转发 JSON —— 与 api_nbody 同一套做法，本层不做计算。

        a_au 的缺省是内核的缺省（1.0），回执里 a_source 会写 "default"。
        网关**不**替它猜一个间距：没有初值时从质量反推间距是求解问题，
        默默代一个值会让用户以为那是算出来的。
        """
        body = self._read_body()
        primary = str(body.get("primary") or "Sun")
        secondary = str(body.get("secondary") or "Earth")
        if not EXE.is_file():
            return self._json_error(500, f"找不到 {EXE} —— 请先编译")
        argv = [str(EXE), "lagrange", "--primary", primary, "--secondary", secondary]
        for key, flag in (("mass_primary", "--mass-primary"),
                          ("mass_secondary", "--mass-secondary"),
                          ("a_au", "--a-au")):
            v = body.get(key)
            if v is not None:
                try:
                    argv += [flag, f"{float(v):.12g}"]
                except (TypeError, ValueError):
                    return self._json_error(400, f"{key} 不是数字: {v!r}")
        try:
            r = subprocess.run(argv, capture_output=True, encoding="utf-8",
                               errors="replace", timeout=60)
        except subprocess.TimeoutExpired:
            return self._json_error(504, "lagrange 超时")
        if r.returncode != 0 or not r.stdout.strip():
            return self._json_error(400, r.stderr.strip() or "lagrange 运行失败")
        try:
            json.loads(r.stdout)
        except Exception:  # noqa: BLE001
            return self._json_error(500, "lagrange 输出不是合法 JSON")
        self._send(200, r.stdout)

    def api_genesis(self) -> None:
        """随机宇宙：转发 starpivot genesis。

        种子走 `--seed-hex`，不是 `--seed`。原因是一个**实测到**的坑：Windows 上
        argv 是按 ANSI 代码页从宽字符命令行转出来的，非 ASCII 的种子会在到达
        main() 之前被改写 —— 传"中文种子"，回执里的 seed 不是逐字相同。
        那会让"同一种子 = 同一个宇宙"这条承诺在中文种子上悄悄失效。
        所以这里把种子的 UTF-8 字节编成十六进制再传，内核解码后哈希。
        回执里的 seed_source 会写 "hex"，一眼看得出走的哪条路。
        """
        body = self._read_body()
        seed = body.get("seed")
        if seed is None or not isinstance(seed, str) or not seed:
            return self._json_error(400, "需要非空字符串 seed")
        n_bodies = body.get("bodies", 4)
        try:
            n = int(n_bodies)
        except (TypeError, ValueError):
            return self._json_error(400, f"bodies 不是整数: {n_bodies!r}")
        if not 2 <= n <= 8:
            return self._json_error(400, "bodies 必须在 2..8 之间")
        if not EXE.is_file():
            return self._json_error(500, f"找不到 {EXE} —— 请先编译")
        argv = [str(EXE), "genesis", "--seed-hex", seed.encode("utf-8").hex(),
                "--bodies", str(n)]
        try:
            r = subprocess.run(argv, capture_output=True, encoding="utf-8",
                               errors="replace", timeout=60)
        except subprocess.TimeoutExpired:
            return self._json_error(504, "genesis 超时")
        if r.returncode != 0 or not r.stdout.strip():
            return self._json_error(400, r.stderr.strip() or "genesis 运行失败")
        try:
            json.loads(r.stdout)
        except Exception:  # noqa: BLE001
            return self._json_error(500, "genesis 输出不是合法 JSON")
        self._send(200, r.stdout)

    def api_groundtrack(self) -> None:
        """星下点地面轨迹：转发 starpivot groundtrack（经纬度全部由内核算）。"""
        body = self._read_body()
        if not body.get("line1") or not body.get("line2"):
            return self._json_error(400, "需要 line1/line2（对象 A 的两行 TLE）")
        if not EXE.is_file():
            return self._json_error(500, f"找不到 {EXE} —— 请先编译")
        argv = [str(EXE), "groundtrack",
                "--line1", body["line1"], "--line2", body["line2"],
                "--minutes", str(body.get("minutes", 180.0)),
                "--offset-min", str(body.get("offset_min", 0.0)),
                "--step-min", str(body.get("step_min", 1.0))]
        if body.get("line3") and body.get("line4"):
            argv += ["--line3", body["line3"], "--line4", body["line4"]]
        try:
            r = subprocess.run(argv, capture_output=True, encoding="utf-8", errors="replace", timeout=60)
        except subprocess.TimeoutExpired:
            return self._json_error(504, "groundtrack 超时")
        if r.returncode != 0 or not r.stdout.strip():
            return self._json_error(400, r.stderr.strip() or "groundtrack 运行失败")
        try:
            json.loads(r.stdout)
        except Exception:  # noqa: BLE001
            return self._json_error(500, "groundtrack 输出不是合法 JSON")
        self._send(200, r.stdout)

    def api_nbody(self) -> None:
        """宇宙模拟：转发给 starpivot nbody（辛积分在 C++ 内核，页面只绘制）。"""
        body = self._read_body()
        scenario = body.get("scenario", "solar")
        if scenario not in ("solar", "figure8", "custom"):
            return self._json_error(400, "scenario must be solar, figure8 or custom")
        # 太阳系是否入场的三档，仅 custom 场景有效（内核校验，这里先挡一遍非法值）
        solar = body.get("solar", "full")
        if solar not in ("full", "sun", "none"):
            return self._json_error(400, "solar must be full, sun or none")
        if not EXE.is_file():
            return self._json_error(500, f"找不到 {EXE} —— 请先编译")
        argv = [str(EXE), "nbody", "--scenario", scenario]
        # 积分器：四种之一，内核自己校验
        integ = str(body.get("integrator") or "leapfrog")
        if integ not in ("leapfrog", "hermite", "euler", "kepler"):
            return self._json_error(400, f"integrator 不合法: {integ}")
        if integ != "leapfrog":
            argv += ["--integrator", integ]
        if scenario == "custom" and solar != "full":
            argv += ["--solar", solar]
        # 自定义行星：name,a,e,inc,raan,argp,M0,mass|type:mass[,radius_km][,teff_K=..,lum_lsun=..]
        # 有 type 时把第 8 字段写成 "类型:质量"，半径交给内核按类型算
        # （黑洞半径要用 G 和 c，页面和网关都不该自己算）；并且**不带**半径字段，
        # 否则会覆盖内核算出来的值。
        #
        # radius_given：页面有时拿得到**这一颗**天体的真实半径（真实系外行星观测、
        # 预设里写死的半径）。声明了类型的天体默认半径由内核推（页面编辑器那一格
        # 显示的就是"派生"），但"观测到的半径"比"模型推的半径"更该被尊重 —— 所以
        # 由页面显式说一句"这个数是我给的观测值"，网关才把它下发。
        # 没有这个标记时一律不下发：页面默认填的 6371 不该顶掉一颗红矮星的真实半径。
        #
        # teff_K / lum_lsun：这一颗星**自己**的观测有效温度与光度。类型表给的是
        # "某一类星"的代表值，真实个体必须用观测值，否则会明显偏（TRAPPIST-1 的
        # L∝M^3.5 只给 2.2e-4 L☉，实测 5.5e-4 —— 差 2.5 倍，会把一颗宜居行星
        # 如实显示成"冻结"）。只在页面真的有观测值时才下发；内核回显里带
        # t_eff_src / luminosity_src，页面据此如实标注"观测值"还是"模型值"。
        for b in body.get("bodies", []) or []:
            try:
                mass = float(b.get("mass", 0))
                tkey = str(b.get("type") or "").strip()
                mass_field = f"{tkey}:{mass:.10g}" if tkey else f"{mass:.10g}"
                fields = [
                    str(b["name"]), str(float(b["a"])), str(float(b["e"])),
                    str(float(b.get("inc", 0))), str(float(b.get("raan", 0))),
                    str(float(b.get("argp", 0))), str(float(b.get("M0", 0))),
                    mass_field]
                if b.get("radius_km") is not None and (not tkey or b.get("radius_given")):
                    fields.append(str(float(b["radius_km"])))
                for key in ("teff_K", "lum_lsun"):
                    v = b.get(key)
                    if v is not None:
                        fields.append(f"{key}={float(v):.10g}")
                spec = ",".join(fields)
            except (KeyError, TypeError, ValueError):
                return self._json_error(400, f"自定义行星字段不合法: {b}")
            argv += ["--body", spec]
        # 根数的参考系：自定义天体的轨道相对哪一颗解释（内核会校验名字存在）。
        if body.get("primary"):
            argv += ["--primary", str(body["primary"])]
        if body.get("years"):
            argv += ["--years", str(body["years"])]
        if body.get("samples"):
            argv += ["--samples", str(body["samples"])]
        # 碰撞/碎裂（开关与建模参数都交给内核校验）
        collide = body.get("collide", "off")
        if collide in ("merge", "fragment"):
            argv += ["--collide", collide,
                     "--radius-scale", str(float(body.get("radius_scale", 1.0)))]
            if collide == "fragment":
                argv += ["--fragments", str(int(body.get("fragments", 4))),
                         "--dispersion-kms", str(float(body.get("dispersion_kms", 1.0))),
                         "--frag-min-speed-kms",
                         str(float(body.get("frag_min_speed_kms", 0.5)))]
                # 成束系数：页面上那个「喷流成束 0–1」控件下发的键就是 `spray`。
                #
                # ⚠ 这一路**曾经漏掉**，而且漏得完全没有症状：页面有控件、内核有 --spray，
                #   唯独中间这一层不转发 → 那个控件是**死的**。默认路径看起来一切正常，
                #   因为页面的默认值 0.6 与内核的默认值 0.6 **刚好相等**，逐字都对，
                #   所有判据（含"页面默认 == 内核回显"那一条）全绿 —— 只有把控件改成
                #   别的值才露馅。同一时刻页面显示的"等价命令"里明明写着 `--spray 0.33`，
                #   也就是说那句"等价"当时是**不成立**的。
                #   缺测按缺失处理：没给这个键就一个参数都不传，让内核用自己的默认值。
                if body.get("spray") is not None:
                    argv += ["--spray", str(float(body["spray"]))]
        if body.get("star_collide"):
            argv += ["--star-collide"]
        # 生物演化：默认开（页面默认就要看到）。关掉时只传 --no-bio，
        # 三个旋钮一个都不传 —— 让内核用自己那份默认值，页面对默认值不做镜像，
        # 否则"页面写的 100"和"内核写的 100"迟早会走散。
        if body.get("bio") is False:
            argv += ["--no-bio"]
        else:
            if body.get("bio_years") is not None:
                argv += ["--bio-years", str(float(body["bio_years"]))]
            if body.get("albedo") is not None:
                argv += ["--albedo", str(float(body["albedo"]))]
            if body.get("greenhouse") is not None:
                argv += ["--greenhouse", str(float(body["greenhouse"]))]
        try:
            r = subprocess.run(argv, capture_output=True, encoding="utf-8", errors="replace", timeout=180)
        except subprocess.TimeoutExpired:
            return self._json_error(504, "nbody 积分超时")
        if r.returncode != 0 or not r.stdout.strip():
            return self._json_error(400, r.stderr.strip() or "nbody 运行失败")
        try:
            json.loads(r.stdout)
        except Exception:  # noqa: BLE001
            return self._json_error(500, "nbody 输出不是合法 JSON")
        self._send(200, r.stdout)


def main() -> int:
    ap = argparse.ArgumentParser(description="starpivot 本地试用服务")
    # `PORT` 是发布平台的约定：沙箱只给一个端口，而且是**通过环境变量**给的，
    # 服务必须听它、并且绑 0.0.0.0（否则反代连不进来）。
    # 没有 PORT 时一切照旧（8765 / 127.0.0.1），本地开发的行为一个字都没变。
    env_port = os.environ.get("PORT")
    ap.add_argument("--port", type=int, default=int(env_port) if env_port else 8765)
    ap.add_argument("--host", default="0.0.0.0" if env_port else "127.0.0.1",
                    help="绑定地址；有 PORT 时默认 0.0.0.0（平台要求），否则 127.0.0.1")
    args = ap.parse_args()
    _ensure_executable(EXE)
    if not EXE.is_file():
        log(f"警告: 未找到内核 {EXE}，页面可打开但所有计算都会报错。请先编译。")
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    log(f"starpivot 服务已启动: http://{args.host}:{args.port}")
    log(f"静态目录: {VIEWER} | 内核: {EXE}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
