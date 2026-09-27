# ⚠ 已被 _probe_xplat_spray.py 取代（2026-09-27，日志 §22 T2）。
# 这是当初那份"散证据脚本"：只打印**线上**的回显与事件数，不做断言、不落盘、
# 也没有退出码语义 —— 于是它绿不代表任何东西被验证过。
# 正式判据版 = _probe_xplat_spray.py（18 项；同时验本地与线上，逐帧逐分量比）。
# **留在这里只为留档**（本仓不是 git 仓库，删了就没了）。要跑就用新那只。
import json, urllib.request
A = {"id":"A","name":"A","mass":3e-6,"radius_km":6371,"a":1.0,"e":0.2,"argp":0.0,"M0":0.0}
B = {"id":"B","name":"B","mass":3e-6,"radius_km":6371,"a":1.0,"e":0.2,"argp":180.0,"M0":135.0}
def run(spray):
    p = {"scenario":"custom","solar":"sun","years":3,"samples":2000,
         "collide":"fragment","radius_scale":450,"spray":spray,"bodies":[A,B]}
    req = urllib.request.Request("https://starpivot-universe.app.workbuddy.host/api/nbody",
        data=json.dumps(p).encode(), headers={"Content-Type":"application/json"})
    d = json.load(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=300))
    return len(d.get("events") or []), (d.get("fragmentation") or {}).get("spray")
for s in (0.0, 0.33):
    n, echo = run(s)
    print(f"线上 spray={s} -> 回显={echo} 事件数={n}")
