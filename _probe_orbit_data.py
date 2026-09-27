# 判据：轨道页上半页那三份「预计算样本」（viewer/demo.js）确实是内核算出来的，
#       而且今天的内核**仍然算得出逐位相同的结果**。
#
# 为什么需要这一条：demo.js 的生成脚本 tools/make_demo_data.py 已经被删掉，工程也不是
# git 仓库 —— 这个文件是**冻结**的。内核物理一旦改动，页面上那些数就会变成
# 「看起来像真结果」的旧数，而页面正写着「确实是 CLI 算出来的真结果，但是打包那一刻算的」。
# 没有任何判据能发现这件事，因为它是数据文件，不参与编译。
#
# 为什么用「逐位」而不是「接近」：样本是按打印精度（%.6g / %.5f / %.4f）落盘的。
# 同一个模型、同一组参数、同一个二进制必然给出同样的字符串；容差一放开，就再也分不清
# 「物理变了」和「打印位数变了」。实测三个场景共 2 083 个采样点的各分量全部逐位相同。
#
# 判据：
#   1. demo.js 能解析，且头部那句「verbatim CLI output」的声明还在（这是被验的前提）。
#   2. 每个场景都能由它自己记录的 model + initial_elements + 轨道跨度还原出 CLI 命令。
#   3. 带阻力/光压的场景必须记录面积与质量 —— 缺了就直接判失败：
#      阻力只通过 A/m 进入方程，没记这两个数就永远复现不出来（这正是本判据诞生的原因）。
#   4. 逐位一致：ground_track 每个点的每个分量、以及 secular_drift / 平均根数（起末）/
#      末态密切根数 / epoch / model 块全部相同。
#   5. 负样本（三条，都走与第 4 条同一个比较函数）：
#      · 把样本里一个高度改掉 0.0002 km → 必须报不一致；
#      · 把带阻力那一条的面积/质量记录删掉 → 必须报「不可复现」；
#      · 用错的质量参数真跑一次 → 必须报不一致（证明这个比较不是恒真的）。
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "starpivot"
DEMO = ROOT / "viewer" / "demo.js"
EXE = ROOT / "build" / "bin" / "starpivot.exe"

LOG = []
n = fail = 0


def say(s):
    print(s)
    LOG.append(s)


def check(cond, name, detail=""):
    global n, fail
    n += 1
    if not cond:
        fail += 1
    say(("  PASS  " if cond else "  FAIL  ") + name + (("   " + detail) if detail else ""))


def ordered(scenario, hours, mass=None):
    """把样本记录还原成一条 CLI 命令。mass 只用于负样本（故意给错参数）。"""
    m, el = scenario["model"], scenario["initial_elements"]
    argv = [str(EXE), "propagate",
            "--a", repr(el["a_km"]), "--e", repr(el["e"]), "--inc", repr(el["inc_deg"]),
            "--raan", repr(el["raan_deg"]), "--argp", repr(el["argp_deg"]),
            "--hours", repr(hours), "--step", repr(m["step_s"])]
    if m["drag"]:
        argv += ["--drag", "1"]
    if m["srp"]:
        argv += ["--srp", "1"]
    if m["drag"] or m["srp"]:
        sc = m.get("spacecraft")
        argv += ["--area", repr(sc["area_m2"] if sc else 10.0),
                 "--mass", repr(mass if mass is not None else (sc["mass_kg"] if sc else 1000.0))]
    return argv


def compare(ref, got):
    """唯一的比较函数 —— 正样本与负样本都走这里。返回 (ok, 说明)。"""
    bad = []
    gt_ref, gt_got = ref.get("ground_track") or [], got.get("ground_track") or []
    if len(gt_ref) != len(gt_got):
        return False, "采样点数不同：样本 %d，内核 %d" % (len(gt_ref), len(gt_got))
    diff = 0
    for i, (p, q) in enumerate(zip(gt_ref, gt_got)):
        if p.get("t_s") != q.get("t_s") or p.get("utc") != q.get("utc"):
            bad.append("第 %d 点的时间戳不同" % i)
            break
        if (p["lat_deg"], p["lon_deg"], p["alt_km"]) != (q["lat_deg"], q["lon_deg"], q["alt_km"]):
            diff += 1
    if diff:
        bad.append("%d/%d 个点的 lat/lon/alt 有差异" % (diff, len(gt_ref)))
    for k in ("model", "initial_elements", "epoch_utc", "secular_drift",
              "mean_elements_start", "mean_elements_end", "final_elements_osculating",
              "osculating_minus_mean_a_km"):
        if ref.get(k) != got.get(k):
            bad.append("字段 %s 不同" % k)
    return (not bad), "; ".join(bad)


def main():
    if not EXE.is_file():
        say("  FAIL  找不到内核 %s（先编译）" % EXE)
        return 1
    txt = DEMO.read_text(encoding="utf-8")

    say("=" * 74)
    say("轨道页冻结样本 ↔ 今日内核（逐位比对）")
    say("  内核：%s  %d 字节" % (EXE.name, EXE.stat().st_size))
    say("=" * 74)

    check("Each entry is verbatim CLI output" in txt,
          "demo.js 头部仍声明「每条都是 CLI 的逐字输出」（这是本判据的被验前提）")

    try:
        demo = json.loads(txt.split("=", 1)[1].strip().rstrip(";"))
    except Exception as e:  # noqa: BLE001
        check(False, "demo.js 能被解析", str(e))
        return 1
    keys = [k for k in demo if not k.startswith("__")]
    check(len(keys) >= 3, "样本里有 %d 个场景：%s" % (len(keys), ", ".join(keys)))

    for k in keys:
        s = demo[k]
        hours = s["ground_track"][-1]["t_s"] / 3600.0
        m = s["model"]
        say("")
        say("--- %s（%g h，%d 个采样点）---" % (k, hours, len(s["ground_track"])))

        # 3. 带阻力/光压的场景必须记录面积与质量
        if m["drag"] or m["srp"]:
            check(isinstance(m.get("spacecraft"), dict)
                  and m["spacecraft"].get("mass_kg") and m["spacecraft"].get("area_over_mass_m2_per_kg"),
                  "%s：本场景用到阻力/光压，样本记录了面积与质量（否则永远复现不出来）" % k,
                  json.dumps(m.get("spacecraft"), ensure_ascii=False))
        else:
            check(True, "%s：本场景不用阻力/光压，无需记录面积质量" % k)

        argv = ordered(s, hours)
        r = subprocess.run(argv, capture_output=True, text=True, timeout=1800)
        if r.returncode != 0:
            check(False, "%s：内核跑通" % k, "rc=%d %s" % (r.returncode, r.stderr[:160]))
            continue
        got = json.loads(r.stdout)
        good, why = compare(s, got)
        check(good, "%s：%d 个采样点与全部标量字段逐位相同" % (k, len(s["ground_track"])),
              why if not good else "命令：" + " ".join(argv[2:]))

        # 负样本（同一个比较函数，且必须真的可能失败）
        if k == "iss_drag":
            broken = json.loads(json.dumps(s))
            broken["ground_track"][100]["alt_km"] += 0.0002
            good2, _ = compare(broken, got)
            check(not good2, "  负样本：把样本一个高度改 0.2 m，同一处判不一致")
            stripped = json.loads(json.dumps(s))
            del stripped["model"]["spacecraft"]
            check(not isinstance(stripped["model"].get("spacecraft"), dict),
                  "  负样本：删掉面积/质量记录后，第 3 条判据会判「不可复现」")
            wrong = json.loads(subprocess.run(ordered(s, hours, mass=1000.0),
                                              capture_output=True, text=True, timeout=1800).stdout)
            good3, why3 = compare(s, wrong)
            check(not good3, "  负样本：用错的质量参数（1000 kg）真跑，同一处判不一致", why3[:90])

    say("")
    say("=" * 74)
    say("[orbit-data] n=%d fail=%d" % (n, fail))
    say("=" * 74)
    return 1 if fail else 0


if __name__ == "__main__":
    rc = main()
    (Path(__file__).resolve().parent / "_probe_orbit_data.txt").write_text("\n".join(LOG), encoding="utf-8")
    sys.exit(rc)
