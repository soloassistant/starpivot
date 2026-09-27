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


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------- helpers
    def _send(self, code: int, body: str, ctype: str = "application/json; charset=utf-8") -> None:
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _json_error(self, code: int, msg: str) -> None:
        self._send(code, json.dumps({"error": msg}, ensure_ascii=False))

    def _read_body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > 1_000_000:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:  # noqa: BLE001
            return {}

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
        self._send(200, p.read_text(encoding="utf-8"), ctype)

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
        self._send(200, p.read_text(encoding="utf-8"))

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
        if self.path == "/api/conj":
            return self.api_cli("conj")
        if self.path == "/api/verify-tle":
            return self.api_cli("verify-tle")
        if self.path == "/api/groundtrack":
            return self.api_groundtrack()
        if self.path == "/api/nbody":
            return self.api_nbody()
        return self._json_error(404, f"unknown api: {self.path}")

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
