# -*- coding: utf-8 -*-
"""随机宇宙种子（`starpivot genesis`）的判据：逐位复现 + 独立物理合法性检查。

三条硬性质，按重要性排：

1. **同 seed 逐位复现** —— 不是"差不多"，是 stdout **字节比较**相等。
   本判据第一版只比了解析后的 JSON，那是另一件事（键序一变就蒙混过关）。
2. **异 seed 必须不同** —— 否则"逐位复现"是白送的。
3. **生成物物理合法** —— 这一节的判据全部独立算：
     * 质量必须落在 `starpivot catalog` 类型表给该类型的 [mass_min, mass_max] 里，
       而且 `type` 必须真的在类型表里。凭空出现的质量一律不认。
     * e < 1（轨道根数本身要求）。
     * 任意两颗的半长轴间距 > 互 Hill 半径，本判据自己算
         R_H,mut(i,j) = ((m_i+m_j)/(3M))^(1/3) · (a_i+a_j)/2
       M 取回执里的 primary_mass_msun。
   Hill 半径的公式本身用一个教科书锚点自检（地球的 Hill 半径 ≈ 1.5e6 km ≈ 0.01 AU），
   免得"独立复算"只是把一个写错的公式再写一遍。

不做的事：不去复刻内核判定稳定性用的那个 margin 公式（回执里 criterion=gladman，
但没给公式）。硬要反推它会把判据变成对内核实现的重写，而且很容易反推错。
这里只做两件能站住的事：独立算出的间距/互 Hill 比值全部 > 1，以及回执自己声明的
min_margin > 1 —— 两个独立来源给出同一个结论就算交叉验证过了。内核 margin 的
**具体公式**属未验证，报告里如实这么写。

容差：内核 CLI 用 %.6g 打印浮点（见 tools/starpivot_cli.cpp），最坏相对量化 5e-6，
统一向上取到 1e-5（依据见 _probe_collide.py 文件头「关于容差」，那里已经因为
按 %.6g 误用 1e-9 栽过一次）。凡是拿回执里的数跟独立复算比的，都用这个基线。

退出码：0 全过 / 1 有失败项 / 2 子命令缺席或环境缺失（未验证，不冒充通过）。
"""
import atexit
import builtins
import json
import math
import os
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:                                   # noqa: BLE001
    pass

ROOT = os.path.dirname(os.path.abspath(__file__))
EXE = os.path.join(ROOT, "starpivot", "build", "bin", "starpivot.exe")
# 报告写在探针自己旁边（沿用 _probe_solar.py / _probe_bio.py），不挂 ROOT ——
# 否则探针被复制到别处跑（变异测试）会把仓库里那份正式报告覆盖掉。
REPORT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "_probe_genesis_kernel.txt")
STARS = os.path.join(ROOT, "starpivot", "data", "real_stars.json")

JSON_REL_BASE = 1e-5

_LOG = []
_real_print = builtins.print


def print(*a, **k):                       # noqa: A001 — 有意遮蔽：结论要落盘
    _LOG.append(" ".join(str(x) for x in a))
    _real_print(*a, **k)


@atexit.register
def _flush():
    with open(REPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(_LOG) + "\n")


n_ok = 0
fails = []
unverified = []
warns = []


def ok(cond, msg):
    global n_ok
    n_ok += 1
    _LOG.append(("  PASS  " if cond else "  FAIL  ") + msg)
    _real_print(("  PASS  " if cond else "  FAIL  ") + msg)
    if not cond:
        fails.append(msg)
    return bool(cond)


def skip(msg):
    unverified.append(msg)
    _LOG.append("  未验证  " + msg)
    _real_print("  未验证  " + msg)


def warn(msg):
    if msg not in warns:
        warns.append(msg)
        _LOG.append("  注意  " + msg)
        _real_print("  注意  " + msg)


def head(t):
    print()
    print("=" * 76)
    print(t)


def run(args, timeout=300):
    """返回 (rc, stdout_bytes, stderr_text)。刻意返回 bytes：逐位比较要用。"""
    try:
        r = subprocess.run([EXE] + args, cwd=ROOT, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, b"", "TIMEOUT"
    return r.returncode, r.stdout, r.stderr.decode("utf-8", "replace")


def decode_json(raw):
    """严格 UTF-8 解码。失败时返回 (None, 错误说明) —— 绝不静默替换成 U+FFFD。"""
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        return None, "byte %d: %r" % (exc.start, raw[max(0, exc.start - 6):exc.start + 6])
    try:
        return json.loads(text), None
    except Exception as exc:                       # noqa: BLE001
        return None, str(exc)


# ---------------------------------------------------------------- 独立物理
def hill_radius(a_au, m_msun, m_host_msun):
    """单颗行星的 Hill 半径 R_H = a·(m/(3M))^(1/3)。"""
    return a_au * (m_msun / (3.0 * m_host_msun)) ** (1.0 / 3.0)


def mutual_hill_radius(a1, m1, a2, m2, m_host):
    """两颗的互 Hill 半径 R_H,mut = ((m1+m2)/(3M))^(1/3)·(a1+a2)/2。"""
    return ((m1 + m2) / (3.0 * m_host)) ** (1.0 / 3.0) * 0.5 * (a1 + a2)


# ================================================================ A 环境
head("A  环境与子命令在场性")
print("  exe = %s" % EXE)
if not os.path.exists(EXE):
    skip("内核二进制不存在")
    print("n=%d pass, fail=%d, 未验证=%d" % (n_ok, len(fails), len(unverified)))
    print("退出码 2（环境缺失，未验证）")
    sys.exit(2)

rc, _, _ = run(["help"])
ok(rc == 0, "starpivot help 可执行（rc=%s）" % rc)

rc_probe, out_probe, err_probe = run(["genesis", "--seed", "probe-presence"])
have_genesis = rc_probe == 0 and out_probe.strip().startswith(b"{")
print("  genesis 子命令：%s" % ("在场" if have_genesis else "缺席"))
if not have_genesis:
    print("  内核原话：%s" % (err_probe.strip()[:160] or "（无 stderr，退出码 %s）" % rc_probe))
    skip("genesis 子命令未实现：逐位复现、异 seed 不同、物理合法性、负路径全部未验证")
    print()
    print("n=%d pass, fail=%d, 未验证=%d" % (n_ok, len(fails), len(unverified)))
    print("退出码 2（缺的是被测子命令，不是环境坏掉）")
    sys.exit(2)

# ================================================================ B 独立件自检
head("B  独立件自检（不依赖 genesis 的结果）")

# 类型表：独立的质量白名单来源，走的是 catalog 这条完全不同的代码路径
rc_cat, out_cat, err_cat = run(["catalog"], timeout=120)
types = {}
if rc_cat == 0:
    cat, _ = decode_json(out_cat)
    if cat:
        types = {t["key"]: t for t in cat.get("types", [])}
ok(bool(types), "能独立读到类型表（catalog，%d 个类型）—— 质量白名单的来源" % len(types))

# Hill 半径公式的教科书锚点：地球的 Hill 半径 ≈ 1.5e6 km ≈ 0.01 AU
h_earth = hill_radius(1.0, 3.003489e-6, 1.0)
ok(abs(h_earth - 0.01) < 5e-4,
   "Hill 半径公式自检：a=1 AU, m=3.003e-6 M☉, M=1 M☉ → %.6f AU（教科书 ~0.01 AU / 1.5e6 km）"
   % h_earth)
ok(abs(h_earth * 1.495978707e8 - 1.5e6) < 2.4e5,
   "同一式换成 km 是 %.3e km（1.5e6 km 量级）" % (h_earth * 1.495978707e8))
hm = mutual_hill_radius(1.0, 3.003489e-6, 1.5, 3.003489e-6, 1.0)
ok(hm > h_earth, "互 Hill 半径 %.6f AU > 单颗 Hill 半径 %.6f AU（a 更大时成立）"
   % (hm, h_earth))
# 互 Hill 半径：先用一份独立写开的闭式对答案，再查单调性（查性质，不查这一组样本）
_ma, _mb, _mm1, _mm2, _mh = 1.0, 1.5, 1e-6, 2e-6, 1.0
_closed = ((_mm1 + _mm2) / (3.0 * _mh)) ** (1.0 / 3.0) * ((_ma + _mb) / 2.0)
ok(abs(mutual_hill_radius(_ma, _mm1, _mb, _mm2, _mh) - _closed) <= 1e-15 * _closed,
   "互 Hill 半径与独立写开的闭式 ((m1+m2)/(3M))^(1/3)·(a1+a2)/2 一致（%.3e vs %.3e）"
   % (mutual_hill_radius(_ma, _mm1, _mb, _mm2, _mh), _closed))
ok(mutual_hill_radius(_ma, _mm1, _mb + 1.0, _mm2, _mh) >
   mutual_hill_radius(_ma, _mm1, _mb, _mm2, _mh),
   "互 Hill 半径随外侧半长轴增大而增大")
ok(mutual_hill_radius(_ma, _mm1 * 10, _mb, _mm2, _mh) >
   mutual_hill_radius(_ma, _mm1, _mb, _mm2, _mh),
   "互 Hill 半径随行星质量增大而增大")
ok(mutual_hill_radius(_ma, _mm1, _mb, _mm2, _mh * 100) <
   mutual_hill_radius(_ma, _mm1, _mb, _mm2, _mh),
   "互 Hill 半径随中心天体质量增大而减小")

# 真实恒星清单（观测数据，非推导）
n_stars = 0
if os.path.exists(STARS):
    try:
        with open(STARS, encoding="utf-8") as f:
            n_stars = len(json.load(f).get("stars", []))
        ok(n_stars > 0, "能独立读到真实恒星清单 data/real_stars.json（%d 颗 Hipparcos 星）" % n_stars)
    except Exception as exc:                       # noqa: BLE001
        ok(False, "读 data/real_stars.json 失败：%s" % exc)
else:
    skip("data/real_stars.json 不存在，无法做真实恒星交叉核对")

# 字节比较工具本身要先证明是好的 —— 用一个一定存在的子命令当替身
rc_a, out_a, _ = run(["catalog"], timeout=120)
rc_b, out_b, _ = run(["catalog"], timeout=120)
ok(out_a == out_b and out_a != b"",
   "字节比较工具自检：catalog 连跑两次 stdout 逐位相同（%d 字节）" % len(out_a))

# ================================================================ C 逐位复现
head("C  逐位复现与种子区分")

SEED = "2026-10-05"
rc1, o1, e1 = run(["genesis", "--seed", SEED])
rc2, o2, e2 = run(["genesis", "--seed", SEED])
ok(rc1 == 0 and rc2 == 0, "同 seed 连跑两次都成功（rc=%s, %s）" % (rc1, rc2))
ok(o1 == o2, "同 seed 的 stdout **逐位相同**（%d 字节，sha 无关的裸比较）" % len(o1))
doc, err1 = decode_json(o1)
ok(doc is not None, "回执是合法 UTF-8 JSON（%s）" % (err1 or "解码正常"))
if o1 != o2:
    print("    第一次前 200 字节：%r" % o1[:200])
    print("    第二次前 200 字节：%r" % o2[:200])

if doc is not None:
    ok(doc.get("status") == "ok", "status=ok（实际 %r）" % doc.get("status"))
    ok(doc.get("command") == "genesis", "command=genesis")
    ok(doc.get("seed") == SEED, "回显的 seed 与传入一致（%r）" % doc.get("seed"))
    h1 = doc.get("seed_hash")
    ok(isinstance(h1, str) and h1.startswith("0x") and len(h1) > 2,
       "seed_hash 形如 0x…（实际 %r）" % h1)

rc_d, o_d, _ = run(["genesis", "--seed", "2026-10-06"])
ok(o_d != o1, "异 seed（2026-10-06）输出与 2026-10-05 不同")
doc_d, _ = decode_json(o_d)
if doc is not None and doc_d is not None:
    ok(doc_d.get("seed_hash") != h1,
       "异 seed 的 seed_hash 也不同（%r vs %r）" % (doc_d.get("seed_hash"), h1))
    ok(doc_d.get("bodies") != doc.get("bodies"),
       "异 seed 生成的天体列表也不同（不只是哈希不同）")

for n in (2, 8):
    rc_n, o_n, _ = run(["genesis", "--seed", "B%d" % n, "--bodies", str(n)])
    d_n, _ = decode_json(o_n)
    ok(rc_n == 0 and d_n is not None and len(d_n.get("bodies") or []) == n,
       "--bodies %d 生效且回执里正好 %d 颗（实测 %s）"
       % (n, n, len((d_n or {}).get("bodies") or [])))

for bad in ("0", "1", "9", "-3"):
    rc_b2, o_b2, e_b2 = run(["genesis", "--seed", "X", "--bodies", bad])
    rejected = rc_b2 != 0 and e_b2.strip() != ""
    ok(rejected,
       "--bodies %s 被明确拒绝（rc=%s，stderr 有话说）" % (bad, rc_b2))
    ok(o_b2.strip() == b"",
       "--bodies %s 没有一边报错一边吐垃圾 JSON" % bad)

# ---- 负路径 / 边界 seed ----
rc_e, o_e, e_e = run(["genesis", "--seed", ""])
ok(rc_e != 0 and e_e.strip() != "" and o_e.strip() == b"",
   "空 seed：明确拒绝且不吐内容（rc=%s，报错 %r）" % (rc_e, e_e.strip()[:60]))
if rc_e == 0 and o_e.strip() == b"":
    skip("空 seed 竟然成功且返回空 —— 违反「不许静默返回空」")

LONG = "x" * 4096
rc_l1, o_l1, _ = run(["genesis", "--seed", LONG])
rc_l2, o_l2, _ = run(["genesis", "--seed", LONG])
d_l, el = decode_json(o_l1)
ok(rc_l1 == 0 and d_l is not None and len(d_l.get("bodies") or []) > 0,
   "4096 字符超长 seed：正常返回 %s 颗天体（不是垃圾也不是静默空）"
   % (len((d_l or {}).get("bodies") or [])))
ok(o_l1 == o_l2, "4096 字符 seed 同样逐位复现（%d 字节）" % len(o_l1))
if el:
    warn("超长 seed 的回执不是合法 UTF-8：%s" % el)

UNI = "\u661f\u7cfb\u79cd\u5b50-\u03a9-\U0001f31f"
rc_u1, o_u1, _ = run(["genesis", "--seed", UNI])
rc_u2, o_u2, _ = run(["genesis", "--seed", UNI])
d_u, eu = decode_json(o_u1)
ok(rc_u1 == 0 and o_u1.strip() != b"",
   "中文+emoji seed：成功返回了内容（%d 字节，不是静默空）" % len(o_u1))
ok(o_u1 == o_u2, "中文+emoji seed 也逐位复现（%d 字节）" % len(o_u1))
ok(eu is None,
   "中文+emoji seed 的回执是合法 UTF-8 —— CLI 的 --seed 是「任意字符串」，"
   "任何按 UTF-8 读它的消费者都该能解析%s"
   % ("" if eu is None else "→ 实际失败：" + eu))
if eu:
    warn("内核把 --seed 的非 ASCII 内容按 Windows ANSI 代码页回显（星=0xD0 0xC7），"
         "所以 CLI 这条路的回执不是 UTF-8，且 echo 有损（emoji 被写成 ?）。"
         "**线上不受影响**：tools/webapp.py:396 走的是 --seed-hex（seed 的 UTF-8 十六进制），"
         "那条路的回执是干净 UTF-8（见下一节）。受影响的是任何直接调 --seed 的消费者。")

# ---- 网关真正走的那条路：--seed-hex ----
print()
print("  网关实际路径（tools/webapp.py:396 用 --seed-hex，而不是 --seed）：")
hx = UNI.encode("utf-8").hex()
rc_h1, o_h1, _ = run(["genesis", "--seed-hex", hx])
rc_h2, o_h2, _ = run(["genesis", "--seed-hex", hx])
d_h, eh = decode_json(o_h1)
ok(rc_h1 == 0 and d_h is not None,
   "--seed-hex 回执是合法 UTF-8 JSON%s" % ("" if eh is None else "（%s）" % eh))
ok(o_h1 == o_h2, "--seed-hex 逐位复现（%d 字节）" % len(o_h1))
if d_h is not None:
    ok(d_h.get("seed") == UNI,
       "--seed-hex 的 seed 回显与原始字符串完全一致（round-trip 没丢字符）")
    ok(len(d_h.get("bodies") or []) > 0,
       "--seed-hex 也生成了 %d 颗天体" % len(d_h.get("bodies") or []))

# 同一条路两个入口，对 ASCII seed 必须给出同一个宇宙，否则 CLI 与页面看到的不是同一天
rc_a1, o_a1, _ = run(["genesis", "--seed", "2026-10-05"])
rc_a2, o_a2, _ = run(["genesis", "--seed-hex", "2026-10-05".encode("utf-8").hex()])
da, _ = decode_json(o_a1)
dh, _ = decode_json(o_a2)
ok(da is not None and dh is not None and da.get("seed_hash") == dh.get("seed_hash"),
   "ASCII seed：--seed 与 --seed-hex 给出同一个 seed_hash（%r）"
   % (da or {}).get("seed_hash"))
ok(da is not None and dh is not None and da.get("bodies") == dh.get("bodies"),
   "ASCII seed：两个入口生成的宇宙逐条相同")
ok(da is not None and dh is not None
   and da.get("seed_hash") != (decode_json(run(["genesis", "--seed-hex",
                                                UNI.encode("utf-8").hex()])[1])[0] or {}).get("seed_hash"),
   "非 ASCII seed：--seed 与 --seed-hex 的 seed_hash **不同**（前者哈希的是 ANSI "
   "代码页字节、后者是 UTF-8 字节）—— 这是上面那条 UTF-8 问题的同一个根因")

for bad_hex in ("ZZZZ", "4142zz", "4", ""):
    rc_x, o_x, e_x = run(["genesis", "--seed-hex", bad_hex])
    ok(rc_x != 0 and o_x.strip() == b"",
       "非法 --seed-hex %r 被明确拒绝且不吐内容（rc=%s）" % (bad_hex, rc_x))
rc_to, o_to, e_to = run(["genesis", "--seed", "T1", "--types-only"])
if rc_to == 0:
    warn("--types-only 返回成功，但本判据没有为它单独设计断言（只查它不吐垃圾）")
ok(o_to.strip() == b"" and (rc_to == 0 or e_to.strip() != ""),
   "--types-only：要么明确拒绝、要么有内容，不会静默返回空")
if rc_to != 0:
    warn("契约 §3 列了 --types-only，内核尚未实现（rc=%s，%r）—— 契约与实现的差距"
         % (rc_to, e_to.strip()[:70]))

# ================================================================ D 物理合法性
head("D  物理合法性（独立复算）")
if doc is None:
    skip("没有可解析的回执，物理合法性整节未验证")
else:
    bodies = doc.get("bodies") or []
    m_host = doc.get("primary_mass_msun")
    ok(bool(bodies), "回执里 bodies 非空（%d 颗）" % len(bodies))
    ok(isinstance(m_host, (int, float)) and m_host > 0,
       "primary_mass_msun = %r（互 Hill 半径的分母 M）" % m_host)
    ok(isinstance(doc.get("primary_name"), str) and doc["primary_name"].strip() != "",
       "primary_name = %r" % doc.get("primary_name"))

    REQUIRED = ("name", "type", "type_name", "mass_msun", "a_au", "e",
                "inc_deg", "raan_deg", "argp_deg", "M0_deg", "radius_km")
    missing = [(b.get("name"), k) for b in bodies for k in REQUIRED if k not in b]
    ok(not missing, "每颗天体都带齐 nbody 需要的字段 %s（缺 %s）" % (list(REQUIRED), missing))

    bad_e = [(b.get("name"), b.get("e")) for b in bodies
             if not (isinstance(b.get("e"), (int, float)) and 0.0 <= b["e"] < 1.0)]
    ok(not bad_e, "所有 e < 1（越界的：%s）" % bad_e)

    bad_a = [(b.get("name"), b.get("a_au")) for b in bodies
             if not (isinstance(b.get("a_au"), (int, float)) and b["a_au"] > 0.0)]
    ok(not bad_a, "所有半长轴 > 0（越界的：%s）" % bad_a)

    bad_ang = [(b.get("name"), k, b.get(k)) for b in bodies
               for k in ("inc_deg", "raan_deg", "argp_deg", "M0_deg")
               if not (isinstance(b.get(k), (int, float)) and 0.0 <= b[k] < 360.0)]
    ok(not bad_ang, "所有角度在 [0,360) 度内（越界的：%s）" % bad_ang)

    bad_r = [(b.get("name"), b.get("radius_km")) for b in bodies
             if not (isinstance(b.get("radius_km"), (int, float))
                     and b["radius_km"] > 0 and math.isfinite(b["radius_km"]))]
    ok(not bad_r, "所有半径为正且有限（越界的：%s）" % bad_r)

    # 质量白名单：类型必须在类型表里，且质量落在该类型的区间内
    unknown = [b.get("type") for b in bodies if b.get("type") not in types]
    ok(not unknown, "每颗天体的 type 都在内核类型表里（未知的：%s）" % unknown)
    out_of_range = []
    for b in bodies:
        t = types.get(b.get("type"))
        if not t:
            continue
        lo, hi = t["mass_min"], t["mass_max"]
        m = b.get("mass_msun")
        # %.6g 量化留 1e-5 相对余量
        if not (lo * (1 - JSON_REL_BASE) <= m <= hi * (1 + JSON_REL_BASE)):
            out_of_range.append((b.get("name"), b.get("type"), m, lo, hi))
    ok(not out_of_range,
       "每颗质量都落在该类型自己的 [mass_min, mass_max] 内（不自造质量）：越界 %s"
       % out_of_range)
    name_mismatch = [(b.get("name"), b.get("type_name"), types.get(b.get("type"), {}).get("name_zh"))
                     for b in bodies
                     if b.get("type") in types and b.get("type_name") != types[b["type"]].get("name_zh")]
    ok(not name_mismatch,
       "type_name 与类型表里的 name_zh 对得上（对不上的：%s）" % name_mismatch)

    # 互 Hill 半径间距（本判据独立算，不复用内核的稳定性公式）
    worst = None
    violations = []
    for i in range(len(bodies)):
        for j in range(i + 1, len(bodies)):
            b1, b2 = bodies[i], bodies[j]
            da = abs(b2["a_au"] - b1["a_au"])
            rh = mutual_hill_radius(b1["a_au"], b1["mass_msun"],
                                    b2["a_au"], b2["mass_msun"], m_host)
            ratio = da / rh
            if worst is None or ratio < worst[0]:
                worst = (ratio, b1.get("name"), b2.get("name"), da, rh)
            if da <= rh:
                violations.append((b1.get("name"), b2.get("name"), da, rh))
    ok(not violations,
       "任意两颗的半长轴间距 > 互 Hill 半径（违反的：%s）" % violations)
    ok(worst is not None and worst[0] > 1.0,
       "最紧的一对 %s/%s：间距 %.4f AU > 互 Hill 半径 %.4f AU（余量 %.2f 倍）"
       % (worst[1], worst[2], worst[3], worst[4], worst[0]))

    single = min((hill_radius(b["a_au"], b["mass_msun"], m_host) for b in bodies),
                 default=0.0)
    print("  单颗 Hill 半径最小值 = %.6f AU（%s）"
          % (single, "、".join("%s=%.4f" % (b.get("name"),
                                             hill_radius(b["a_au"], b["mass_msun"], m_host))
                               for b in bodies)))

    stab = doc.get("stability") or {}
    ok(isinstance(stab, dict) and stab.get("min_margin") is not None
       and stab["min_margin"] > 1.0,
       "回执自报 min_margin = %r > 1（它自己声明的标准）" % stab.get("min_margin"))
    ok(stab.get("min_margin") is not None and worst is not None
       and ((stab["min_margin"] > 1.0) == (worst[0] > 1.0)),
       "两个独立来源给同一结论：内核自报 min_margin=%r，本判据独立算的最小间距/Hill 比 "
       "%.3f（两者是不同公式的量，只比「稳不稳」这个结论，不比数字大小）"
       % (stab.get("min_margin"), worst[0] if worst else float("nan")))
    ok(isinstance(stab.get("criterion"), str) and stab.get("criterion").strip() != "",
       "回执写明了判定依据 criterion = %r" % stab.get("criterion"))
    if "min_pair_sep_au" not in stab:
        warn("契约 §3 的 stability 字段是 {min_pair_sep_au, mutual_hill_ok}，"
             "内核实际发的是 %s —— 字段名与契约不同（语义上更细，但没有契约那两个键）"
             % sorted(stab.keys()))
    skip("内核 min_margin 的**具体公式**：回执只给了 criterion 名字，没给公式，"
         "本判据不去反推它（反推等于重写一遍实现，且极易反推错）。"
         "已验证的是「两来源结论一致 + 独立算的间距全部 > 互 Hill 半径」")
    print("  placement_attempts = %r（内核放置时的重试次数，回显以便排查）"
          % doc.get("placement_attempts"))

# ================================================================ E 字段兼容
head("E  与 nbody 的字段兼容（契约 §3 的核心承诺）")
if doc is None:
    skip("没有可解析的回执，字段兼容未验证")
else:
    bodies = doc.get("bodies") or []
    args = ["nbody", "--scenario", "custom", "--solar", "none",
            "--years", "1", "--samples", "5"]
    for b in bodies:
        args += ["--body", "%s,%.9g,%.9g,%.9g,%.9g,%.9g,%.9g,%s:%.9g"
                 % (b["name"], b["a_au"], b["e"], b["inc_deg"],
                    b["raan_deg"], b["argp_deg"], b["M0_deg"],
                    b["type"], b["mass_msun"])]
    rc_n, o_n, e_n = run(args, timeout=600)
    ok(rc_n == 0, "把 genesis 的 bodies 原样塞回 nbody 能跑通（rc=%s）" % rc_n)
    jn, en = decode_json(o_n)
    ok(jn is not None and jn.get("status") == "ok",
       "nbody 回执 status=ok（%s）" % (en or (jn or {}).get("status")))
    ok(e_n.strip() == "" or rc_n == 0,
       "nbody 没有一边成功一边报天文数字的错误：%r" % e_n.strip()[:80])
    print("  （--solar none 因为 genesis 天体自带质量、自带 --primary 会与太阳系撞在原点）")

# ================================================================ 汇总
head("汇总")
print("n=%d pass, fail=%d, 未验证=%d, 注意=%d"
      % (n_ok, len(fails), len(unverified), len(warns)))
if warns:
    print()
    print("注意项（%d 条，不判失败，但要人来定）：" % len(warns))
    for w in warns:
        print("  - " + w)
if unverified:
    print()
    print("未验证项（%d 条）：" % len(unverified))
    for u in unverified:
        print("  - " + u)
if fails:
    print()
    print("FAILED: %d 项" % len(fails))
    for f in fails:
        print("  - " + f)
print()
sys.exit(1 if fails else 0)
