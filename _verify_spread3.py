import json, urllib.request
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
A = {"id":"A","name":"A","mass":3e-6,"radius_km":6371,"a":1.0,"e":0.2,"argp":0.0,"M0":0.0}
B = {"id":"B","name":"B","mass":3e-6,"radius_km":6371,"a":1.0,"e":0.2,"argp":180.0,"M0":135.0}
def run(spray, years=3, samples=2000):
    p = {"scenario":"custom","solar":"sun","years":years,"samples":samples,
         "collide":"fragment","radius_scale":450,"spray":spray,"bodies":[A,B]}
    req = urllib.request.Request("http://127.0.0.1:8765/api/nbody",
        data=json.dumps(p).encode(), headers={"Content-Type":"application/json"})
    d = json.load(op.open(req, timeout=180))
    frag = d.get("fragmentation") or {}
    return len(d.get("events") or []), frag.get("spray")
for s in (0.0, 0.33, 0.6, 0.9):
    n, echo = run(s)
    print(f"spray={s} -> fragmentation.spray={echo}  事件数={n}")
