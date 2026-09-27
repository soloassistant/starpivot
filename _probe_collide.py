#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""碰撞（合并 / 碎裂）的判据。

为什么这个探针是 python 而不是 node（本仓库其余 CLI 探针都是 .js）：
    本机 Node 起不了子进程（沙箱下 spawnSync 一律 EBUSY），python 可以。
    别的 CLI 探针靠 `_runner.js` 的录制回放绕过去了，**这一条绕不过去**：
    它要验的恰恰是"这一次运行会不会崩"，录制里没有这个信息。
    所以宿主语言按能力选，不按习惯选 —— 顺便也是一个提醒：
    "探针一律用 js 写"从来不是本项目的规矩，"判据必须真跑"才是。

它存在的直接原因（不是预防性设计，是事后追账）：
    --collide fragment 一旦真的发生撞击就崩 —— Windows 上 0xC0000005
    （退出码 3221225477），**stderr 一个字都没有**，网关只能如实报
    "nbody 运行失败"；而页面上的「行星撞地球」预设正是
    collide=fragment + 半径放大 450×。也就是说那个预设一按就失败，
    而失败的真正原因（段错误）在页面上完全看不出来。

    根因：碎裂会把登记表 reg 撑大，而 sprops / lum_of / var_phase / type_of /
    lum_series 这五个按 reg 定容的数组没有跟着长，后面按 reg 索引的循环
    直接读到 vector 边界之外。merge 模式不会让 reg 变长，所以这个洞
    只在 fragment 下露出来 —— 两条路一条好一条崩，就是这么来的。

第二件事（同一次追账里量出来的）：这条路上原本有两个洞，不是一个。
    ① 碎块环半径小于「相邻两块相切」的距离 → 碎块出生即重叠 → 立刻判成相撞。
       色散速度大的时候看不出来，拖到 0 就露出来。修法：环半径撑到刚好不相切。
    ② 更要紧的那个：登记表 reg 只增不减，而 max_bodies 卡的是**活体数**。
       fmin=0（hpp 里写明的合法取值，页面滑杆也没有下限）时活体被卡在 64，
       登记行却能涨到 14735 行：3001 帧 × 14735 行 ≈ 4400 万个坐标、165 秒、
       页面根本画不出来。修法：给登记行数一个自己的上限（4×max_bodies）。
    两个都修完以后，同一组最坏参数从 165 秒 / 14735 行 变成 1.6 秒 / 255 行。
    一开始我只看到 ①：改完环半径再量，最坏那一组**还是** 165 秒 / 14735 行。
    把这件事记在这里，是因为"改完要再量一遍"比那两个洞本身更值得留下来 ——
    ① 的推导（相切距离）看着完全充分，充分到很容易就此收工。

关于容差：内核的 JSON 用 %.6g 打印浮点，最坏量化相对误差是 0.5e-5/尾数 ≤ 5e-6
    （尾数最接近 1 时最大）。所以凡是拿 JSON 里的数和独立复算比较，容差取 1e-5，
    **不能取 1e-9** —— 这一条在真实系外行星那两个探针里已经栽过一次，
    这里重犯了一遍（把"逐位相同"写在了 %.6g 的字段上）。容差从最坏情况推，
    不从手上这组样本推。
"""
import io
import json
import math
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
EXE = os.path.join(ROOT, "starpivot", "build", "bin", "starpivot.exe")

# ---- 独立复算用的常数（全部不取自内核）----
AU_KM = 1.495978707e8
JSON_REL = 1e-5          # 见文件头"关于容差"

n_ok = 0
fails = []
L = []


def ok(cond, msg):
    global n_ok
    n_ok += 1
    L.append(("  PASS  " if cond else "  FAIL  ") + msg)
    if not cond:
        fails.append(msg)


def run(args, timeout=240):
    """返回 (rc, json, err)。rc 为 None 表示超时。"""
    try:
        r = subprocess.run([EXE] + args, cwd=ROOT, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, None, "超过 %d 秒没返回" % timeout
    err = r.stderr.decode("utf-8", "replace").strip()
    js = None
    try:
        js = json.loads(r.stdout.decode("utf-8", "replace"))
    except Exception:                                               # noqa: BLE001
        pass
    return r.returncode, js, err


def fmt_rc(rc):
    return "超时" if rc is None else "%s (0x%08X)" % (rc, rc & 0xFFFFFFFF)


# 页面「行星撞地球」预设的确切初值：两颗质量相同的 3e-6 M☉ 天体，a=1 AU、e=0.2，
# 近日点相对 180°、平近点角 135° —— 就是"t≈0.8 年会撞上"那组根数。
# 半径 6371 km 是显式给的第 9 个字段（不带类型），与页面下发的写法一致。
INPUT_R_KM = 6371.0
PRESET_BODIES = ["--body", "A,1,0.2,0,0,0,0,3.0000000000e-06,%g" % INPUT_R_KM,
                 "--body", "B,1,0.2,0,0,180,135,3.0000000000e-06,%g" % INPUT_R_KM]
BASE = ["nbody", "--scenario", "custom", "--solar", "sun"] + PRESET_BODIES \
       + ["--years", "3", "--samples", "2000"]

# C3（级联）专用初值：**页面那套** —— 太阳系背景（--solar full）+ 自定义 A/B，20 年。
#
# ⚠ 这里踩过一次坑，值得留在这儿：级联**不是这两颗天体自己的性质**，碎屑得**有东西可撞**。
#   原先 C3 直接拿 BASE（--solar sun，一个行星都没有）去跑页面默认阈值，结果是
#   阈值 0.5 与阈值 3 **两次都只有 2 个事件、都没有两级碎屑** → 正样本红、而
#   **负样本"绿"得毫无意义**（它绿是因为两次什么都没发生）。
#   换成带太阳系的这套之后：阈值 0.5 → 8 事件 / 28 行 / 有 Earth#2#1；阈值 3 → 3 事件 / 16 行 / 0 两级。
BASE_CASCADE = ["nbody", "--scenario", "solar", "--solar", "full"] + PRESET_BODIES \
               + ["--years", "20", "--samples", "2000"]

# 页面预设真实发出的碎裂三参数。
# ⚠ 这里的 `--frag-min-speed-kms 3` 是**本探针自己挑的"安静"阈值**（用来做段错误红线那些用例），
#   **不是页面的默认值** —— 页面 #fmin 早已由 3 改成 0.5（`_probe_collide.py` C3 会
#   从 HTML 里读出它自己的默认值再核对，别再把这个常量当成"页面应该是什么"）。
PRESET_FRAG = ["--fragments", "4", "--dispersion-kms", "0.3", "--frag-min-speed-kms", "3"]
FRAG450 = ["--collide", "fragment", "--radius-scale", "450"] + PRESET_FRAG

SCALE = 450.0
# 碎裂的母体**不是**原来那颗 6371 km 的天体，而是它俩合并之后的那一颗 ——
# 实测事件序列是 merge(B→A) 然后 fragment(A)，所以要按合并后的半径算。
PARENT_R_KM = INPUT_R_KM * 2.0 ** (1.0 / 3.0)      # cbrt(2 r³) = r·2^(1/3)，体积相加
PARENT_M_MSUN = 2.0 * 3.0e-6


def inflated_au(km):
    """碰撞判定用的半径（AU）= 观测半径 × --radius-scale / 1 AU。
    必须用这个而不是 JSON 里的 radius_km：后者是**未放大**的登记半径，
    拿它去比"按放大半径排布"的碎块环间距，会把判据放松十几倍。"""
    return km * SCALE / AU_KM


SPREAD_AU = inflated_au(PARENT_R_KM)   # 原定的环半径 = 母体放大半径

# 登记行数上限：内核里是 4 × max_bodies。C3 与 E 两节都要用它，所以提上来定义一次。
REG_CAP = 4 * 64


def ring_expected(n):
    """独立复算碎块环半径：piece_r = spread/cbrt(n)，环 = max(spread, piece_r/sin(pi/n)×1.02)。"""
    piece_r = SPREAD_AU / (n ** (1.0 / 3.0))
    touching = piece_r / math.sin(math.pi / n)
    return SPREAD_AU if SPREAD_AU > touching * 1.02 else touching * 1.02


def live_rows(js):
    """存活集合：JSON 里没有 died_at 的行。
    B 行在合并时标了 died_at 但 mass 仍留着原值，所以"整张表求和"永远是错的 ——
    这一点我第一次写这个探针时踩了（把 1.000009 当成总质量拿去比 1.000006）。"""
    return [b for b in js["bodies"] if "died_at" not in b]


def born_rows(js):
    return [b for b in js["bodies"] if b["born_at"] > 0]


def rows_of(js, prefix):
    return [b for b in js["bodies"] if b["id"].startswith(prefix)]


def main():
    if not os.path.isfile(EXE):
        print("找不到内核 %s —— C 层要先编译" % EXE)
        return 2

    # ================= A. 段错误红线 =================
    rc, js, err = run(BASE + FRAG450)
    ok(rc == 0, "「行星撞地球」预设真跑一次不崩（退出码 %s）—— 修之前这一段是 0xC0000005，"
                "stderr 一个字都没有" % fmt_rc(rc))
    if rc != 0 or js is None:
        L.append("  [info] 后续判据全部跳过：拿不到这次运行的结果（rc=%s，err=%s）"
                 % (fmt_rc(rc), err[:200]))
        return report()

    ev = js["events"]
    fr = [e for e in ev if e["kind"] == "fragment"]
    ok(len(fr) >= 1, "而且真的发生了碎裂（碎裂事件 %d 个）—— 如果这条不成立，"
                     "上面那条'没崩'就没意义：可能是根本没撞上" % len(fr))
    if not fr:
        return report()

    # ---- 帧数组随碎裂增长：这不是怪癖，是必须的语义 ----
    # 一个天体在它出生之前没有位置，不该被画出来。内核按"那一刻登记表里已有的行"发帧，
    # 于是帧长度分两段（实测 798 帧 3 行 + 2203 帧 7 行）。
    # 页面正是按这个语义读的：它用 born_at/died_at 裁到"这一帧这个天体存在吗"，
    # 存在才去取 p[b]。下面这条等式把这个契约钉住，免得哪天内核改成定长发帧、
    # 帧里的位置却对不上行号，而页面上什么都看不出来。
    sizes = {}
    for f in js["frames"]:
        sizes[len(f["p"])] = sizes.get(len(f["p"]), 0) + 1
    seq = [len(f["p"]) for f in js["frames"]]
    ok(all(seq[i] <= seq[i + 1] for i in range(len(seq) - 1)),
       "帧行数逐帧单调不减 —— 登记表只增不减，所以帧只会变长：%s"
       % " → ".join(str(k) for k in sorted(sizes)))
    ok(seq[-1] == len(js["bodies"]),
       "末帧行数 %d == 登记行数 %d" % (seq[-1], len(js["bodies"])))
    ok(len(sizes) == 1 + len(set(e["t"] for e in fr)),
       "帧长度只有 %d 种（每发生一次碎裂多一种）—— 与 %d 个碎裂时刻对应"
       % (len(sizes), len(set(e["t"] for e in fr))))
    ok(seq[0] == 3, "第一帧就是最初的 3 行（太阳 + 两颗）")
    bad = sum(1 for f in js["frames"] for q in f["p"] if not all(math.isfinite(x) for x in q))
    ok(bad == 0, "全部 %d 帧没有 NaN/Inf —— 修之前这里的下标越界就是段错误发生的地方"
                 % len(js["frames"]))

    rc2, js2, _ = run(BASE + ["--collide", "off"])
    ok(rc2 == 0 and js2 is not None and len(js2["events"]) == 0,
       "对照：同样这组初值在 --collide off 下 %d 个事件 —— 说明「会撞上」是这组初值"
       "本身的性质，不是碰撞判定的误报" % (len(js2["events"]) if js2 else -1))
    m0 = sum(b["mass_msun"] for b in js2["bodies"]) if js2 else 0.0
    rows0 = len(js2["bodies"]) if js2 else 0

    # ---- 登记表 / 存活集 / 事件日志三者必须自洽 ----
    # 这是页面依赖的核心关系：页面画的是登记表里的行，靠 born_at/died_at 决定
    # 某一帧该不该画它；而在意"还剩几个天体"的地方（挑战计分）读的是存活集。
    merges = [e for e in ev if e["kind"] == "merge"]
    live = live_rows(js)
    want_live = rows0 - len(merges) + sum(e["fragments"] - 1 for e in fr)
    ok(len(live) == want_live,
       "存活 %d 个 == 初始 %d − 合并 %d + Σ(碎块−1) %d —— 登记表只增不减，"
       "所以这个数只能从事件日志推" % (len(live), rows0, len(merges),
                                      sum(e["fragments"] - 1 for e in fr)))
    ok(abs(sum(b["mass_msun"] for b in live) - m0) / m0 < 1e-12,
       "存活集的静质量 %.12g M☉ == 碰撞前 %.12g（逐位守恒）—— 注意**不能**对整张"
       "登记表求和：被并入的那一行会把质量重复计一次" % (sum(b["mass_msun"] for b in live), m0))

    # ================= B. merge 的物理 =================
    rc, jm, _ = run(BASE + ["--collide", "merge", "--radius-scale", "450"])
    if rc == 0 and jm:
        em = jm["events"]
        ok(len(em) == 1 and em[0]["kind"] == "merge",
           "merge 模式：恰好 1 个合并事件（%d 个，kind=%s）"
           % (len(em), em[0]["kind"] if em else "-"))
        if len(em) == 1:
            e = em[0]
            ok(abs(e["mass_after"] - e["mass_before"]) < 1e-15,
               "事件里的 mass_before == mass_after（%.10g）—— 完全非弹性、不丢质量"
               % e["mass_before"])
            ok(e["energy_delta"] < 0.0,
               "能量变化 %.6g < 0 —— 完全非弹性碰撞必然损失动能，这是判据不是现象描述"
               % e["energy_delta"])
            ok(len(jm["bodies"]) == rows0, "merge 不新增登记行（仍是 %d 行）" % rows0)
            ok(abs(sum(b["mass_msun"] for b in live_rows(jm)) - m0) / m0 < 1e-12,
               "merge 后存活集质量仍等于碰撞前 %.12g" % m0)
            got_r = rows_of(jm, "A")[0]["radius_km"]
            ok(abs(got_r - PARENT_R_KM) / PARENT_R_KM < JSON_REL,
               "合并半径 %.4f km == cbrt(r1³+r2³) = %.4f km（体积相加，用观测半径独立复算）"
               % (got_r, PARENT_R_KM))
    else:
        ok(False, "merge 用例跑不起来：rc=%s %s" % (fmt_rc(rc), str(_)[:120]))

    # ================= C. fragment 的物理 =================
    first = fr[0]
    pname = first["a"]
    pieces = rows_of(js, pname + "#")
    names = sorted(b["id"] for b in pieces)
    want = [pname + "#" + str(k + 1) for k in range(first["fragments"])]
    ok(len(pieces) == first["fragments"] and names == want,
       "第一次碎裂产出 %d 块，命名齐全且有序（%s）—— 页面靠这个名字区分血缘"
       % (len(pieces), ", ".join(names)))

    # 母体是谁：下面所有期望值都建立在它上面，先钉住它
    parent = rows_of(js, pname)[0]
    ok(abs(parent["radius_km"] - PARENT_R_KM) / PARENT_R_KM < JSON_REL,
       "碎裂母体 %s 半径 %.4f km == cbrt(2×6371³) = %.4f km —— 它是两颗先撞合并出来的"
       "那一颗，不是最初那颗 6371 km（事件序列是 merge → fragment）"
       % (pname, parent["radius_km"], PARENT_R_KM))

    # 碎块本身是否"死寂岩石"：这是本轮修复补长那五个数组时定义的语义
    ok(all(b["emits_light"] is False for b in pieces), "碎块都不发光（emits_light 全 false）")
    ok(all(b["luminosity_Lsun"] == 0 for b in pieces), "碎块光度恰好 0（不是「很小」）")
    ok(all(b["t_eff_K"] == 0 for b in pieces), "碎块没有有效温度（0 K）—— 不该落进 H-R 图")
    ok(all(b["luminosity_src"] == "none" and b["t_eff_src"] == "none" for b in pieces),
       "碎块的来源字段如实写 none —— 是「没有」，不是「从类型表推出来的」")
    ok(all(b["type"] == "" for b in pieces), "碎块没有类型（数据表里也没有「碎块」这一类）")

    # 等分：拿**最小**的那几块比 —— 碎块之间会互撞、会长大，
    # 直接用 pieces[0] 会把"已经吸积过的"那块当成本来大小（第一次就栽在这）。
    n = first["fragments"]
    want_piece_m = PARENT_M_MSUN / n
    want_piece_r = PARENT_R_KM / n ** (1.0 / 3.0)
    got_piece_m = min(b["mass_msun"] for b in pieces)
    got_piece_r = min(b["radius_km"] for b in pieces)
    ok(abs(got_piece_m - want_piece_m) / want_piece_m < JSON_REL,
       "最小的那块质量 %.10g == 母体/%.0f = %.10g（等分）" % (got_piece_m, n, want_piece_m))
    ok(abs(got_piece_r - want_piece_r) / want_piece_r < JSON_REL,
       "最小的那块半径 %.4f km == 母体半径/%.0f^(1/3) = %.4f km" % (got_piece_r, n, want_piece_r))

    # C5：环半径必须严格宽于"相邻两块相切"。这是防级联的不变量，也是本次的第二个修复。
    got_ring = first["ring_AU"]
    want_ring = ring_expected(n)
    ok(abs(got_ring - want_ring) / want_ring < JSON_REL,
       "环半径 %.8g AU == 独立复算 %.8g AU（max(母体放大半径, piece_r/sin(π/n)×1.02)，n=%d）"
       % (got_ring, want_ring, n))
    piece_r_au = inflated_au(want_piece_r)      # 用算出来的、不是已长大的那一块
    gap = 2.0 * got_ring * math.sin(math.pi / n)
    ok(gap > 2.0 * piece_r_au,
       "相邻碎块间距 %.6g AU > 两块放大半径之和 %.6g AU（余量 %.0f%%）—— 出生时就是分开的；"
       "判定用的是 d <= r_a+r_b，相切也算撞，所以必须严格大于"
       % (gap, 2.0 * piece_r_au, (gap / (2.0 * piece_r_au) - 1.0) * 100.0))
    ok(got_ring >= SPREAD_AU * (1 - JSON_REL),
       "环半径不小于母体放大半径 %.6g AU（只撑开，不收缩）" % SPREAD_AU)
    ok(abs(got_ring / SPREAD_AU - 1) < JSON_REL,
       "n=4 时环半径就停在母体放大半径 %.8g AU —— 本来就够宽就不动它："
       "修复不该顺手改掉没问题的行为" % SPREAD_AU)

    # ================= C2. 定向溅射（--spray）=================
    # 需求原话："碎片要成束溅射，不是原地散开"。
    #
    # ⚠ 先说一件**量出来的**事，它决定了这条判据该查什么：
    #   最初的做法是"把各向同性的踢方向压进一个圆锥"，看着天经地义。实测（复刻同样的
    #   采样与去均值，n=4）却是反的：
    #       spray   平均|沿轴|   平均|横向|
    #        0.0      0.196      0.802
    #        0.6      0.038      0.401
    #        1.0      0.000      0.000   ← 整个踢归零，色散彻底消失
    #   因为等质量碎块的动量必须等于母体的，去均值会把"共同的那一份"整块减掉；
    #   锥越窄被减得越多，剩下的几乎全是横向 —— 做出的是"越来越小的侧向气团"。
    #   所以"成束"只能从**几何**来（环面垂直于来向 + 环心沿来向前移 + 沿轴剪切），
    #   不能从速度分布来。下面这一节钉的就是这个结论。
    SPRAY = 0.8

    def frag_frame(j, ev):
        """碎块行下标 + 它们出生后的第一帧下标（拿不到返回 None）。"""
        pid = ev["a"]
        names = [pid + "#" + str(k + 1) for k in range(ev["fragments"])]
        idx = []
        for nm in names:
            hit = [i for i, b in enumerate(j["bodies"]) if b["id"] == nm]
            if not hit:
                return None
            idx.append(hit[0])
        need = max(idx) + 1
        for f, fr_ in enumerate(j["frames"]):
            if len(fr_["p"]) >= need:
                if f + 1 >= len(j["frames"]):
                    return None
                return idx, f
        return None

    def cloud_or_none(j, ev):
        """从**真帧里的位置**量这个碎屑云。全部是几何量，不拿实现公式回代。

        - `cen`  ：云心（谱系里碎块位置的质心）
        - `normal`：环面法线（n=4 时 d[0]⊥d[1]，叉积良定）
        - `radii`：每块到云心的距离
        - `dev`  ：**速度**（逐帧位置差分 / dt，再减去云的平均速度）。
                   母体的轨道速度是共模，不属于"色散"，必须扣掉 ——
                   不扣的话 30 km/s 的轨道速度会把 0.3 km/s 的色散整个淹掉。
        """
        got = frag_frame(j, ev)
        if not got:
            return None
        idx, f0 = got
        f1 = f0 + 1
        dt = j["frames"][f1]["t"] - j["frames"][f0]["t"]
        if not (dt > 0):
            return None
        pts = [j["frames"][f0]["p"][i] for i in idx]
        cen = [sum(p[c] for p in pts) / len(pts) for c in range(3)]
        d = [[p[c] - cen[c] for c in range(3)] for p in pts]
        cr = [d[0][1] * d[1][2] - d[0][2] * d[1][1],
              d[0][2] * d[1][0] - d[0][0] * d[1][2],
              d[0][0] * d[1][1] - d[0][1] * d[1][0]]
        nl = math.sqrt(sum(v * v for v in cr)) or 1e-300
        vs = [[(j["frames"][f1]["p"][i][c] - j["frames"][f0]["p"][i][c]) / dt
               for c in range(3)] for i in idx]
        vc = [sum(v[c] for v in vs) / len(vs) for c in range(3)]
        vs = [[v[c] - vc[c] for c in range(3)] for v in vs]
        return {"cen": cen, "normal": [v / nl for v in cr],
                "radii": [math.sqrt(sum(q * q for q in x)) for x in d],
                "dev": vs, "dt": dt}

    def anisotropy(shape, axis):
        """沿 axis 的速度展宽 / 垂直于 axis 的速度展宽。"""
        n = len(shape["dev"])
        vax = math.sqrt(sum(sum(v[c] * axis[c] for c in range(3)) ** 2
                            for v in shape["dev"]) / n)
        tot2 = sum(sum(c * c for c in v) for v in shape["dev"]) / n
        vtr = math.sqrt(max(tot2 - vax ** 2, 0.0))
        return vax, vtr

    got = {}
    for s in (SPRAY, 0.0):
        rc, j, _ = run(BASE + FRAG450 + ["--spray", repr(s) if s == 0.0 else str(s)])
        fs = [e for e in j["events"] if e["kind"] == "fragment"] if (rc == 0 and j) else []
        ok(rc == 0 and bool(fs), "spray=%g 的定向溅射用例真的碎了一次（rc=%s）"
           % (s, fmt_rc(rc)))
        if fs:
            got[s] = (j, fs[0], cloud_or_none(j, fs[0]))

    if SPRAY in got:
        jsp, e0, shape = got[SPRAY]
        ax = e0["spray_axis"]
        axn = math.sqrt(sum(v * v for v in ax))
        ok(abs(axn - 1.0) < JSON_REL,
           "事件回显的 spray_axis 是单位向量（|a| = %.8g）—— 页面要拿它讲方向，"
           "它自己必须先是可用的" % axn)
        ok(abs(e0["spray"] - SPRAY) < JSON_REL,
           "事件回显 spray = %.6g == 请求的 %.1f（回显的是**实际用的**那一组）"
           % (e0["spray"], SPRAY))
        ok(abs(jsp["fragmentation"]["spray"] - SPRAY) < JSON_REL,
           "顶层 fragmentation 块也回了 spray = %.6g —— 页面显示模型参数时读这里，"
           "不许在 HTML 里抄一份" % jsp["fragmentation"]["spray"])
        ok(shape is not None, "能定位到碎块出生后的头两帧（几何复算的前置）")
        if shape:
            dotn = abs(sum(shape["normal"][c] * ax[c] for c in range(3)))
            ok(dotn > 0.99,
               "碎屑环面**垂直于撞击来向**：面法线与 spray_axis 的夹角余弦 %.6f > 0.99"
               "（法线是拿碎块在真帧里的位置叉积算的，不是拿实现公式回代）" % dotn)
            rmin, rmax = min(shape["radii"]), max(shape["radii"])
            ok(rmax / rmin < 1.02,
               "碎块到环心的距离彼此相等（%.6g..%.6g AU，比值 %.4f）—— 环是环，不是一团"
               % (rmin, rmax, rmax / rmin))
            vax, vtr = anisotropy(shape, ax)
            ok(vax > 1.5 * vtr,
               "碎屑云的速度沿来向的展宽明显大于横向（%.6g vs %.6g km/s，比值 %.2f > 1.5）"
               "—— 这才是「成束」：云在飞行中被沿来向拉长，不是原地滚成一个球"
               % (vax * 4.740570, vtr * 4.740570, vax / vtr if vtr else float("inf")))

    # ---- 负样本：同样的量法用在 spray=0 上，必须**判不出**成束 ----
    ok(0.0 in got, "负样本（spray=0）跑不起来")
    if 0.0 in got:
        jz, ez, shape0 = got[0.0]
        ok(ez["spray_axis"] == [0.0, 0.0, 0.0],
           "负样本：spray=0 时事件回显的 spray_axis 是零向量 —— 「没有方向」要如实说出来，"
           "而不是留一个看起来像方向的方向")
        ok(abs(jz["fragmentation"]["spray"]) < JSON_REL,
           "负样本：顶层 fragmentation 块的 spray 也是 0（%.6g）"
           % jz["fragmentation"]["spray"])
        if shape0:
            # 各向同性时"沿来向"没有定义；这里只是**沿用同一个方向**去量同一个量，
            # 比值必须回到 ~1 —— 这是"上面那条比值不是这套量法恒真"的证据。
            e0ax = got[SPRAY][1]["spray_axis"] if SPRAY in got else [1.0, 0.0, 0.0]
            vax0, vtr0 = anisotropy(shape0, e0ax)
            ok(vax0 <= 1.5 * vtr0,
               "负样本：spray=0 时沿同一方向与横向的展宽相当（%.6g vs %.6g km/s，比值 %.2f）"
               "—— 说明上面那条「成束」是 spray 带来的，不是这套量法恒真"
               % (vax0 * 4.740570, vtr0 * 4.740570, vax0 / vtr0 if vtr0 else float("inf")))
        # ---- 两次运行的**环心之差**：这才是"环心被沿来向前移了"的直接测量 ----
        # 同一组初值、同一次撞击，两次运行之间只有 spray 不同。两者共有的
        # "出生后已走了一步"那部分位移会**相减抵消**，剩下的就是模型里那句
        # "环心沿来向平移 0.35·ring·spray"。用绝对量比的话那一步位移比它大，
        # 根本分不出来（第一版就是这么写的，量出来是负数，差点把对的实现判成错）。
        if SPRAY in got and shape0 is not None and got[SPRAY][2] is not None:
            dc = [got[SPRAY][2]["cen"][c] - shape0["cen"][c] for c in range(3)]
            along = sum(dc[c] * e0ax[c] for c in range(3))
            want_along = 0.35 * got[SPRAY][1]["ring_AU"] * SPRAY
            ok(along > 0.0,
               "两次运行的环心之差沿**来向**为正（%.6g AU）—— 碎屑整体被抛向前方，"
               "不是原地铺开" % along)
            ok(abs(along - want_along) / want_along < 0.05,
               "而它等于 0.35·ring·spray = %.6g AU（实测 %.6g，偏差 %.2f%%）—— "
               "模型里写的那句位移是真的落在地上了"
               % (want_along, along, abs(along - want_along) / want_along * 100.0))
            perp = math.sqrt(max(sum(v * v for v in dc) - along ** 2, 0.0))
            ok(perp < 0.1 * want_along + 1e-9,
               "垂直于来向的分量几乎为 0（%.3g AU）—— 平移是**沿来向**的，"
               "不是随便挪了一下" % perp)

    # ================= C3. 页面默认参数 × 级联 =================
    # 需求原话："碎片要能再撞再碎（级联）"。
    #
    # 级联这件事内核算得出来（碎屑出生后是普通天体，会参与后面的碰撞判定），
    # 但**默认压不出来**：内核 --frag-min-speed-kms 默认 0.5，而页面原先写死 3，
    # 于是"按默认跑"只碎一次。实测同一组初值：阈值 3 → 5 个事件 / 7 行；
    # 阈值 0.5 → 173 个事件 / 235 行（三代碎屑 A#1#1、A#1#1#1…）。
    #
    # 所以这里做两件事，都不拿内核默认值当"页面应该是什么"的依据：
    #   ① 从**页面 HTML 里读出它自己的默认值**（#nfrag / #disp / #fmin / #spray），
    #      按那几个数真跑一次，要求内核回显的 fragmentation 与它们逐个相等 ——
    #      页面显示的那几个数必须就是内核真的用的那几个数，两边不许走散；
    #   ② 要求这次运行**真的发生级联**（出现带两级 # 的名字），而且规模有界。
    html_path = os.path.join(ROOT, "starpivot", "viewer", "universe.html")
    html = io.open(html_path, encoding="utf-8").read()

    def html_default(elem):
        m = re.search(r'id="' + elem + r'"[^>]*\bvalue="([^"]+)"', html)
        return m.group(1) if m else None

    page_nfrag, page_disp = html_default("nfrag"), html_default("disp")
    page_fmin, page_spray = html_default("fmin"), html_default("spray")
    ok(None not in (page_nfrag, page_disp, page_fmin, page_spray),
       "页面四个碎裂参数控件都在且带默认值（碎块 %s / 色散 %s / 阈值 %s / 成束 %s）"
       % (page_nfrag, page_disp, page_fmin, page_spray))
    if None not in (page_nfrag, page_disp, page_fmin, page_spray):
        rc, jp, _ = run(BASE_CASCADE + ["--collide", "fragment", "--radius-scale", "450",
                                       "--fragments", page_nfrag,
                                       "--dispersion-kms", page_disp,
                                       "--frag-min-speed-kms", page_fmin,
                                       "--spray", page_spray])
        ok(rc == 0 and jp is not None,
           "按页面默认的四参数真跑一次：rc=%s" % fmt_rc(rc))
        if rc == 0 and jp:
            fm = jp["fragmentation"]
            for key, want, elem in [("fragments", page_nfrag, "nfrag"),
                                    ("dispersion_kms", page_disp, "disp"),
                                    ("frag_min_speed_kms", page_fmin, "fmin"),
                                    ("spray", page_spray, "spray")]:
                ok(abs(float(fm[key]) - float(want)) < 1e-12,
                   "内核回显的 fragmentation.%s = %.6g == 页面 #%s 的默认值 %s —— "
                   "页面上写的那几个数必须就是内核真的用的那几个数"
                   % (key, float(fm[key]), elem, want))
            # 级联：出现 "X#n#m" 这种两级以上的碎屑名字，说明碎屑参与了后续碰撞。
            two_gen = [b["id"] for b in jp["bodies"] if b["id"].count("#") >= 2]
            ok(len(two_gen) > 0,
               "级联真的发生了：出现 %d 个两级以上的碎屑（例如 %s）—— 碎屑出生后是普通天体，"
               "会参与后面的碰撞判定，所以「再撞再碎」是内核算出来的，不是动画"
               % (len(two_gen), ", ".join(sorted(two_gen)[:3])))
            # ⚠ 先证明这一轮**真的碎过不止一次**：不然「级联发生了」可能只是一次碎裂被数成两级；
            #   更要紧的是——负样本会跟着**空过**。当初用 BASE（--solar sun，没有行星）时，
            #   正负两次都是 2 个事件、都没有两级碎屑，那条负样本于是绿得毫无意义。
            #   所以正样本这一侧也必须钉住「这不是一场空转」。
            frag_evs = [e for e in jp["events"] if e.get("kind") == "fragment"]
            ok(len(frag_evs) >= 2 and len(jp["events"]) >= 4,
               "而且这一轮不是空转：碎裂事件 %d 个（≥2）、碰撞事件共 %d 个（≥4）—— "
               "碎屑真的又撞上了别人，不是「碎一次就没人理」"
               % (len(frag_evs), len(jp["events"])))
            ok(len(jp["bodies"]) <= REG_CAP and len(jp["events"]) < 400,
               "而级联是有界的：登记行 %d ≤ %d、事件 %d —— 上限自己会把它刹住"
               % (len(jp["bodies"]), REG_CAP, len(jp["events"])))
            # 参考质量要取**这一跑自己的**初始总质量：`m0` 是 BASE（--solar sun）那一套算出来的，
            # 拿来跟带太阳系的这一跑比，差的正好是行星那点质量（≈1.3e-3 M☉）—— 那是**换了初值**，
            # 不是"造了质量"。所以先跑一次同初值的 --collide off：没有碰撞 → 登记表就是初始那批，
            # 它的总和就是这一跑的碰撞前总质量。
            rc0, jc0, _ = run(BASE_CASCADE + ["--collide", "off", "--radius-scale", "450"])
            m0c = sum(b["mass_msun"] for b in live_rows(jc0)) if (rc0 == 0 and jc0) else None
            ok(m0c is not None and m0c > m0,
               "取到这一跑自己的参考质量：--collide off 下 %s M☉（> BASE 的 %.12g —— 多出来的就是行星）"
               % (("%.12g" % m0c) if m0c is not None else "没取到", m0))
            if m0c:
                ok(abs(sum(b["mass_msun"] for b in live_rows(jp)) - m0c) / m0c < 1e-12,
                   "级联之后存活集质量仍等于**这一跑**碰撞前 %.12g —— 再碎也不会凭空造质量" % m0c)
            # 负样本：把阈值抬回 3，**同一组初值**就不该再有级联 ——
            # 否则上面那条"级联发生了"可能只是这组初值本来就有的性质，与默认值无关。
            rc, j3, _ = run(BASE_CASCADE + ["--collide", "fragment", "--radius-scale", "450",
                                           "--fragments", page_nfrag,
                                           "--dispersion-kms", page_disp,
                                           "--frag-min-speed-kms", "3", "--spray", page_spray])
            if rc == 0 and j3:
                two3 = [b["id"] for b in j3["bodies"] if b["id"].count("#") >= 2]
                ok(len(two3) == 0,
                   "负样本：同一组初值把阈值抬到 3 → 两级碎屑 0 个（事件 %d 个）—— "
                   "说明级联是阈值 0.5 带来的，不是初值本来就长这样"
                   % len(j3["events"]))
                # 负样本自己也要「不是空过」：这一轮仍必须真发生过碎裂，只是后代没再碎。
                frag3 = [e for e in j3["events"] if e.get("kind") == "fragment"]
                ok(len(frag3) >= 1 and len(j3["events"]) < len(jp["events"]),
                   "负样本也不是在空转：阈值 3 这一轮仍有 %d 次碎裂，但碰撞事件数 %d < 正样本的 %d "
                   "—— 两次跑的都是活的系统，差别来自阈值"
                   % (len(frag3), len(j3["events"]), len(jp["events"])))

    # ================= D. 参数校验 =================
    for extra, why, needle in [
        (["--fragments", "1"], "碎块数 1（碎不出东西）", "fragments"),
        (["--fragments", "13"], "碎块数 13（超上限）", "fragments"),
        (["--radius-scale", "0"], "半径倍率 0", "radius-scale"),
        (["--radius-scale", "-1"], "半径倍率负数", "radius-scale"),
        (["--collide", "tangle"], "不存在的碰撞模式", "collide"),
        (["--spray", "1.5"], "喷流系数 1.5（超上限）", "spray"),
        (["--spray", "-0.2"], "喷流系数负数", "spray"),
    ]:
        base = BASE + ["--collide", "fragment"] if extra[0] != "--collide" else BASE
        rc, _, err = run(base + extra)
        ok(rc == 2 and needle in err, "%s → 退出码 2 并点名参数：%s" % (why, err[:90]))
    rc, _, err = run(["nbody", "--scenario", "figure8", "--no-bio",
                      "--collide", "merge", "--samples", "50"])
    ok(rc == 2 and "figure8" in err,
       "figure8 是纯三体、没有「谁撞谁」的定义 → 拒绝：%s" % err[:90])

    # 阈值语义：把碎裂阈值抬到极高，就该退化成纯合并（0 个碎裂事件）
    rc, jt, _ = run(BASE + ["--collide", "fragment", "--radius-scale", "450",
                            "--fragments", "4", "--dispersion-kms", "0.3",
                            "--frag-min-speed-kms", "1e6"])
    if rc == 0 and jt:
        ok(len(jt["events"]) == 1 and jt["events"][0]["kind"] == "merge",
           "碎裂阈值抬到 1e6 km/s → 只有合并、没有碎裂（%d 个事件，kind=%s）—— "
           "阈值真的是增生/碎裂的分界，不是只为了回显的字段"
           % (len(jt["events"]), jt["events"][0]["kind"] if jt["events"] else "-"))

    # ================= E. 不失控 =================
    # 色散速度与阈值都取 0：碎块没有相对速度、任何接触都碎裂，是最坏的一组参数
    # （hpp 里 fmin=0 是写明的合法取值，页面上的阈值滑杆也没有下限，
    # 所以这组参数是**用户能真按出来的**，不是想象出来的极端值）。
    #
    # 修之前这一组：14672 次事件、14735 行登记、165 秒、帧数据约 4400 万个坐标。
    # 活体数被 max_bodies=64 卡住了，但登记表只增不减 —— 于是"活着的不多"
    # 和"输出不大"成了两件事。现在给了登记行数自己的上限（4×max_bodies=256）。
    for nn, note in [(4, "默认 4 块"), (12, "上限 12 块")]:
        t0 = time.time()
        rc, j0, _ = run(BASE + ["--collide", "fragment", "--radius-scale", "450",
                                "--fragments", str(nn), "--dispersion-kms", "0",
                                "--frag-min-speed-kms", "0"], timeout=180)
        ms = int((time.time() - t0) * 1000)
        if rc != 0 or j0 is None:
            ok(False, "最坏参数（%s）下跑不起来：rc=%s" % (note, fmt_rc(rc)))
            continue
        ne, nr = len(j0["events"]), len(j0["bodies"])
        ok(nr <= REG_CAP and len(j0["frames"][-1]["p"]) == nr,
           "最坏参数（%s）：登记行 %d 行 ≤ 上限 %d，帧也跟着是 %d 行 —— 修之前是 14735 行"
           "（3001 帧 × 14735 行 ≈ 4400 万个坐标，页面根本画不出来）" % (note, nr, REG_CAP, nr))
        ok(ms < 20000, "最坏参数（%s）：%.1f 秒跑完 —— 修之前 165 秒" % (note, ms / 1000.0))
        ok(ne < 400, "最坏参数（%s）：事件 %d 个 —— 修之前 14672 个；登记行有了上限，"
                     "级联就跟着有界，不再自己喂自己" % (note, ne))
        ok(abs(sum(b["mass_msun"] for b in live_rows(j0)) - m0) / m0 < 1e-12,
           "最坏参数（%s）：级联之后存活集质量仍等于碰撞前 %.12g —— 级联没有凭空造质量"
           % (note, m0))

    # n 从 2 到 12 全扫一遍：每个值都必须不崩、都真的碎
    bad = []
    for nn in range(2, 13):
        rc, jn, _ = run(BASE + ["--collide", "fragment", "--radius-scale", "450",
                                "--fragments", str(nn), "--dispersion-kms", "0.3",
                                "--frag-min-speed-kms", "3"])
        if rc != 0 or jn is None:
            bad.append("n=%d rc=%s" % (nn, fmt_rc(rc)))
        elif not any(e["kind"] == "fragment" for e in jn["events"]):
            bad.append("n=%d 没碎" % nn)
    ok(not bad, "碎块数 2..12 逐个真跑：全部不崩且都真的碎裂" + ("；例外 " + ", ".join(bad) if bad else ""))

    return report()


def report():
    tail = ("全部通过：碰撞/碎裂真跑得起来，碎裂是参数化模型而不是崩溃入口。"
            if not fails else "%d 项失败" % len(fails))
    with open(os.path.join(ROOT, "_probe_collide.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n\n[collide] n=%d fail=%d\n%s\n" % (n_ok, len(fails), tail))
    for line in L:
        print(line)
    print("\n[collide] n=%d fail=%d" % (n_ok, len(fails)))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
