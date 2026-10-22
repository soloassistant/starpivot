# ⚠ 已被 _probe_xplat_spray.py 取代（2026-09-27，日志 §22 T2）。
# 这是当初那份"散证据脚本"：只打印，不做断言、不落盘、没有退出码语义。
# 正式判据版 = _probe_xplat_spray.py（18 项、落盘 _probe_xplat_spray.txt、
# rc=2 表示环境缺席、并且多了"内核回显 == 请求值"那几条 —— 回显才能回答
# "网关吞没吞这个键"）。它已进 A0/C5 的两份清单。
# **留在这里只为留档**（本仓不是 git 仓库，删了就没了）。要跑就用新那只。
#
# 跨平台逐帧比对（带非默认 spray）：本地(Windows exe+已修网关) vs 线上(Linux musl ELF+已修网关)
# 这是共享记忆 §8 里"等再发布一次之后跑才有意义"的那条 —— 现在条件齐了。
import json, urllib.request, math, sys
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
A = {"id":"A","name":"A","mass":3e-6,"radius_km":6371,"a":1.0,"e":0.2,"argp":0.0,"M0":0.0}
B = {"id":"B","name":"B","mass":3e-6,"radius_km":6371,"a":1.0,"e":0.2,"argp":180.0,"M0":135.0}
def fetch(base, spray, years=3, samples=1000):
    p = {"scenario":"custom","solar":"sun","years":years,"samples":samples,
         "collide":"fragment","radius_scale":450,"spray":spray,"bodies":[A,B]}
    req = urllib.request.Request(base+"/api/nbody",
        data=json.dumps(p).encode(), headers={"Content-Type":"application/json"})
    return json.load(op.open(req, timeout=300))

LOC, ONL = "http://127.0.0.1:8765", "https://starpivot-universe.app.workbuddy.host"
def reldiff(a, b):
    d = abs(a-b); s = max(abs(a), abs(b))
    return 0.0 if d == 0 else (d/s if s > 0 else d)

def cmp_num(path, a, b, worst):
    r = reldiff(a, b)
    if r > worst[0]: worst[:] = [r, path, a, b]

def cmp_frame(fi, fa, fb, worst, stats):
    cmp_num(f"f{fi}.t", fa["t"], fb["t"], worst)
    stats["frames"] += 1
    # 位置 p：逐天体逐分量
    pa, pb = fa["p"], fb["p"]
    assert len(pa) == len(pb), f"帧{fi} 天体数不一致 {len(pa)} vs {len(pb)}"
    for bi in range(len(pa)):
        va, vb = pa[bi], pb[bi]
        assert len(va) == len(vb)
        for ci in range(len(va)):
            cmp_num(f"f{fi}.b{bi}.p[{ci}]", va[ci], vb[ci], worst)
        stats["bodies"] += 1
    # 其余同名数值字段（v / m 等，内核给了什么比什么）
    for k in fa:
        if k in ("t","p") or k not in fb: continue
        xa, xb = fa[k], fb[k]
        if isinstance(xa, list) and isinstance(xb, list) and xa and isinstance(xa[0], (int,float)):
            for ci,(u,v_) in enumerate(zip(xa,xb)): cmp_num(f"f{fi}.{k}[{ci}]", u, v_, worst)

overall = [0.0, "", None, None]
for spray in (0.0, 0.33, 0.9):
    la, oa = fetch(LOC, spray), fetch(ONL, spray)
    fra, fro = la["frames"], oa["frames"]
    ev_a = [ (e.get("t"), e.get("type")) for e in (la.get("events") or []) ]
    ev_b = [ (e.get("t"), e.get("type")) for e in (oa.get("events") or []) ]
    print(f"spray={spray}: 帧数 本地{len(fra)}/线上{len(fro)}  事件 本地{len(ev_a)}/线上{len(ev_b)}")
    assert len(fra) == len(fro), "帧数不一致!"
    assert ev_a == ev_b, f"事件序列不一致!\n 本地={ev_a}\n 线上={ev_b}"
    st = {"frames":0,"bodies":0}
    worst = [0.0, "", None, None]
    for fi,(fa,fb) in enumerate(zip(fra,fro)):
        cmp_frame(fi, fa, fb, worst, st)
    print(f"  比对 {st['frames']} 帧 / {st['bodies']} 天体位置，最大相对差 {worst[0]:.6e}"
          + (f" @ {worst[1]} (本地 {worst[2]} vs 线上 {worst[3]})" if worst[0]>0 else " （逐位一致）"))
    if worst[0] > overall[0]: overall = worst[:]
print("=== 总最大相对差:", f"{overall[0]:.6e}", overall[1] if overall[0]>0 else "（全逐位一致）")
