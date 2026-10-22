#!/usr/bin/env python3
"""find_close_approaches.py — 在真实编目数据里筛出最近的真实接近对.

用法（示例见文件底部）:
    python tools/find_close_approaches.py                       # 默认组，找最近的真实接近
    python tools/find_close_approaches.py --groups starlink     # 只看 Starlink
    python tools/find_close_approaches.py --top 40 --threshold-km 100
    python tools/find_close_approaches.py --exe path/to/starpivot.exe

做什么:
  1. 从 Celestrak 拉取指定 GROUP 的真实 TLE（带重试，容错网络抖动）。
  2. 用轨道根数（倾角/RAAN/平近点角/偏心率/平运动）做轻量初筛，挑出根数最接近的
     top-N 候选对 —— 这一步只是数据过滤，不含任何数值积分。
  3. 对每个候选对调用已验证的 C++ `starpivot conj`（SGP4/SDP4，对上 Vallado
     AIAA-2006-6753 附录 D），取真实传播出的最近距离，排序输出。

语言纪律: 本脚本属于 tools/ 里的 Python 合法用途（数据抓取与场景筛选，
与 xsys_gen.py / xsys_validate.py 同类），所有轨道计算都委托给 C++ 内核，
Python 侧不做任何传播/积分。
"""
from __future__ import annotations

import argparse
import itertools
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

# ---------------------------------------------------------------------------
# 内核定位：默认相对本脚本找，可 --exe 覆盖。
# **默认值按平台给**（Windows 是 `starpivot.exe`，类 Unix 无后缀）：
# 写死 `.exe` 的后果是"本地好好的，发布到 Linux 沙箱后只有碰撞预警这一块
# 报「找不到内核」" —— 页面和其它计算全正常，只坏一个功能，
# 这种故障在本地永远复现不出来（实测就是这么被抓到的）。
# 网关（webapp.py）**总是显式传 --exe**，所以这一支只在"单独跑这个工具"时用到。
# ---------------------------------------------------------------------------
def _default_exe() -> Path:
    root = Path(__file__).resolve().parent.parent
    b = root / "build"
    order = ([b / "bin" / "starpivot.exe", root / "kernel" / "linux-x86_64" / "starpivot"]
             if os.name == "nt" else
             [root / "kernel" / "linux-x86_64" / "starpivot", b / "bin" / "starpivot"])
    for c in order:
        if c.is_file():
            return c
    return order[0]


DEFAULT_EXE = _default_exe()

DEFAULT_GROUPS = ["iridium", "globalstar", "orbcomm"]  # 小而同轨，网络友好
CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php?GROUP={g}&FORMAT=tle"


def log(msg: str) -> None:
    """进度信息走 stderr，正式结果走 stdout（便于管道消费）。"""
    print(msg, file=sys.stderr, flush=True)


def fetch_group(group: str, timeout: float, retries: int) -> list[dict]:
    """拉取一个 GROUP 的 TLE，返回解析后的卫星列表。失败抛最后一次异常。"""
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(
                CELESTRAK.format(g=group),
                headers={"User-Agent": "starpivot-find-close-approaches/1.0"},
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8")
            return parse_tles(raw)
        except Exception as e:  # noqa: BLE001 — 网络层任何异常都值得重试
            last = e
            if attempt < retries:
                wait = 2.0 * attempt
                log(f"  [{group}] 第 {attempt} 次拉取失败（{e}），{wait:.0f}s 后重试…")
                time.sleep(wait)
    raise last  # type: ignore[misc]


def parse_tles(raw: str) -> list[dict]:
    """按 TLE 定长列解析。坏行跳过，不让一颗脏数据毁掉整批。"""
    sats: list[dict] = []
    lines = [ln.rstrip() for ln in raw.splitlines() if ln.strip()]
    # 兼容两种格式：纯 1/2 成对（FORMAT=tle），或 name/1/2 三行（名字行不以
    # "1 "/"2 " 开头，自然被跳过）——所以逐行扫描比步长 2 的成对假设更稳。
    for i in range(0, len(lines) - 1):
        l1, l2 = lines[i], lines[i + 1]
        if not (l1.startswith("1 ") and l2.startswith("2 ")):
            continue
        try:
            epoch_day = float(l1[18:32])                # yyddd.fraction（UTC）
            sats.append(
                dict(
                    satnum=int(l1[2:7]),
                    l1=l1,
                    l2=l2,
                    epoch_day=epoch_day,
                    incl=float(l2[8:16]),
                    raan=float(l2[17:25]),
                    ecc=float("0." + l2[26:33].strip()),
                    ma=float(l2[43:51]),
                    mm=float(l2[52:63]),            # 平运动 rev/day（TLE 定 colum）
                )
            )
        except ValueError:
            continue
    return sats


def _ma_at_ref(sat: dict, ref_day: float) -> float:
    """把平近点角外推到公共参考历元（忽略 J2 长期漂移，筛选足够）。

    TLE 的 mm 是 rev/day：deg/min = mm × 360 / 1440 = mm / 4。
    两颗星历元相差 29 min、mm≈14.6 rev/day 时相位差就达 ~106°——
    不做这一步，"根数接近"完全不等于"物理接近"。
    """
    n_deg_per_min = sat["mm"] / 4.0
    dt_min = (ref_day - sat["epoch_day"]) * 1440.0
    return (sat["ma"] + n_deg_per_min * dt_min) % 360.0


def element_metric(a: dict, b: dict) -> float:
    """根数距离（无量纲，只用于排序，不是物理量）。

    三层主导项：
      1. 高度差（由平运动相对差折算）——决定两星是否同壳层；
      2. 公共历元下的平近点角差——决定沿-track 相位是否真的接近；
      3. 倾角 / RAAN 差——决定面间距离。
    """
    d_mm_rel = abs(a["mm"] - b["mm"]) / max(a["mm"], 1e-9)
    ref_day = max(a["epoch_day"], b["epoch_day"])
    ma_a = _ma_at_ref(a, ref_day)
    ma_b = _ma_at_ref(b, ref_day)
    d_ma = min(abs(ma_a - ma_b), 360.0 - abs(ma_a - ma_b))
    d_inc = min(abs(a["incl"] - b["incl"]), 360.0 - abs(a["incl"] - b["incl"]))
    d_raan = min(abs(a["raan"] - b["raan"]), 360.0 - abs(a["raan"] - b["raan"]))
    d_ecc = abs(a["ecc"] - b["ecc"]) * 100.0
    return d_mm_rel * 1000.0 + d_ma + d_inc + d_raan + d_ecc


def run_conj(exe: Path, a: dict, b: dict, window: float, step: float,
             threshold: float | None) -> dict | None:
    """调用 C++ conj 取真实最近距离。解析失败/传播失败返回 None。"""
    cmd = [str(exe), "conj",
           "--line1", a["l1"], "--line2", a["l2"],
           "--line3", b["l1"], "--line4", b["l2"],
           "--window-min", str(window), "--step-min", str(step)]
    if threshold is not None:
        cmd += ["--threshold-km", str(threshold)]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=120).stdout
        js = json.loads(out)
        r = js["result"]
        return {"miss": r["miss_distance_km"], "tca": r["tca_utc"],
                "vrel": r["rel_speed_kms"], "alert": r.get("alert")}
    except Exception:  # noqa: BLE001 — 单对失败不拖垮整体
        return None


def main() -> int:
    ap = argparse.ArgumentParser(
        description="在真实编目 TLE 里筛出最近的真实接近对（调用 C++ starpivot conj 传播）")
    ap.add_argument("--groups", default=",".join(DEFAULT_GROUPS),
                    help=f"逗号分隔的 Celestrak GROUP（默认 {','.join(DEFAULT_GROUPS)}）")
    ap.add_argument("--top", type=int, default=25,
                    help="按根数初筛保留的候选对数量（默认 25）")
    ap.add_argument("--window-min", type=float, default=1440.0,
                    help="conj 前瞻窗口分钟数（默认 1440 = 24h）")
    ap.add_argument("--step-min", type=float, default=1.0,
                    help="conj 粗扫步长分钟（默认 1.0）")
    ap.add_argument("--cap", type=int, default=1500,
                    help="星数超过该值时只保留最新上传的 N 颗（默认 1500；"
                         "新发射批次往往还聚在一起，最可能出现真实近距）")
    ap.add_argument("--threshold-km", type=float, default=None,
                    help="给最优对加告警阈值（可选）")
    ap.add_argument("--exe", default=str(DEFAULT_EXE),
                    help="starpivot 可执行文件路径（默认自动探测 build/bin/starpivot.exe）")
    ap.add_argument("--timeout", type=float, default=20.0,
                    help="每次网络请求超时秒数（默认 20）")
    ap.add_argument("--retries", type=int, default=3,
                    help="每组拉取重试次数（默认 3）")
    ap.add_argument("--json", action="store_true",
                    help="以 JSON 输出排行（供 webapp.py 消费；进度日志仍在 stderr）")
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    exe = Path(args.exe)
    if not exe.exists():
        log(f"错误: 找不到 starpivot 可执行文件: {exe}")
        log("请先编译（cmake --build build）或用 --exe 指定路径。")
        return 2

    groups = [g.strip() for g in args.groups.split(",") if g.strip()]
    all_sats: list[dict] = []
    for g in groups:
        try:
            sats = fetch_group(g, args.timeout, args.retries)
            log(f"已拉取 {g}: {len(sats)} 颗")
            all_sats += sats
        except Exception as e:  # noqa: BLE001
            log(f"跳过 {g}（网络/解析失败: {e}）")

    if len(all_sats) < 2:
        log("可用卫星不足 2 颗，无法配对。请检查网络或换 --groups。")
        return 1

    if len(all_sats) > args.cap:
        all_sats.sort(key=lambda s: s["epoch_day"], reverse=True)
        all_sats = all_sats[: args.cap]
        log(f"星数过多，按历元保留最新 {args.cap} 颗做筛选")

    log(f"共 {len(all_sats)} 颗，开始根数初筛…")
    pairs = sorted(
        ((element_metric(a, b), a, b) for a, b in itertools.combinations(all_sats, 2)),
        key=lambda x: x[0],
    )[: args.top]

    log(f"对 {len(pairs)} 个候选对跑真实 conj 传播…")
    results = []
    for i, (_, a, b) in enumerate(pairs, 1):
        r = run_conj(exe, a, b, args.window_min, args.step_min, None)
        if r:
            results.append({"a": a, "b": b, **r})
            log(f"  [{i}/{len(pairs)}] sat{a['satnum']} × sat{b['satnum']}: "
                f"miss={r['miss']:.2f} km")
        else:
            log(f"  [{i}/{len(pairs)}] sat{a['satnum']} × sat{b['satnum']}: 传播失败，跳过")

    if not results:
        log("所有候选对传播均失败。")
        return 1

    results.sort(key=lambda r: r["miss"])

    if args.json:
        # 机器可读输出：只含数据，不含告警（前端拿 miss 与自己的阈值比较即可，
        # 避免为每对重复跑一次 conj）。
        pairs = [{
            "satnum_a": r["a"]["satnum"], "l1_a": r["a"]["l1"], "l2_a": r["a"]["l2"],
            "satnum_b": r["b"]["satnum"], "l1_b": r["b"]["l1"], "l2_b": r["b"]["l2"],
            "miss_km": r["miss"], "tca_utc": r["tca"], "rel_speed_kms": r["vrel"],
        } for r in results[:10]]
        print(json.dumps({"pairs": pairs}, ensure_ascii=False))
        return 0

    print("\n=== 真实接近对排行（miss 升序） ===")
    print(f"{'排名':>4}  {'satA':>7} {'satB':>7}  {'miss_km':>12}  "
          f"{'vrel_kms':>9}  TCA(UTC)")
    for rank, r in enumerate(results[:10], 1):
        print(f"{rank:>4}  {r['a']['satnum']:>7} {r['b']['satnum']:>7}  "
              f"{r['miss']:>12.3f}  {r['vrel']:>9.4f}  {r['tca']}")

    best = results[0]
    a, b = best["a"], best["b"]
    print("\n=== 最优对（可直接复制运行） ===")
    print(f"{a['l1']}\n{a['l2']}\n{b['l1']}\n{b['l2']}")
    cmd = (f'starpivot conj --line1 "{a["l1"]}" --line2 "{a["l2"]}" '
           f'--line3 "{b["l1"]}" --line4 "{b["l2"]}" '
           f'--window-min {args.window_min:g} --step-min {args.step_min:g}')
    if args.threshold_km is not None:
        cmd += f" --threshold-km {args.threshold_km:g}"
    print(f"\n{cmd}\n")
    print(f"miss = {best['miss']:.4f} km   TCA = {best['tca']}   "
          f"vrel = {best['vrel']:.5f} km/s")
    if args.threshold_km is not None:
        r2 = run_conj(exe, a, b, args.window_min, args.step_min, args.threshold_km)
        if r2:
            print(f"threshold = {args.threshold_km:g} km → alert = {r2['alert']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
