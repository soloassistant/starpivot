#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""C5 跨平台逐帧比对（带非默认 spray）：本地 Windows exe  vs  线上 Linux musl ELF。

为什么需要它
------------
线上跑的是**另一颗二进制**（Linux 静态 ELF），本机构建出来的那颗在沙箱里跑不了
（没有 qemu/wsl）。所以"两颗二进制行为一致"这件事**只能在线上比** —— 本地跑一个、
线上跑一个，同一份命令、同一次请求，逐帧逐分量比。

为什么带 spray
--------------
默认参数下两条路径都会走"确定性平面路径"，于是**一个被吞掉的转发键不会有任何症状**
（网关不转发 spray 时，内核用它的默认 0.6，而页面默认也是 0.6 —— argv 逐字都对）。
这里三个档 **0.0 / 0.33 / 0.9 没有一个等于内核默认的 0.6**，并同时断言**内核回显**
`fragmentation.spray == 请求值` —— 回显是唯一能回答"网关吞没吞"的东西。

退出码
------
0 = 全部比过且一致；1 = 真不一致（或回显对不上）；2 = **环境缺席**：
本地 8765 没起、或线上站不可达 —— 这时**不算失败**，但也**不许当通过**（由软判据记成 SKIP）。
"""
import json, urllib.request, urllib.error, sys, os

R = os.path.dirname(os.path.abspath(__file__))
OUT = []
n = 0; failed = 0

def emit(line):
    OUT.append(line)
    print(line)

def chk(ok, name, detail=''):
    global n, failed
    n += 1
    if not ok: failed += 1
    emit(('  PASS  ' if ok else '  FAIL  ') + name + (('    ' + detail) if detail else ''))

def finish(code):
    emit('')
    emit('[xplat_spray] n=%d fail=%d' % (n, failed))
    with open(os.path.join(R, '_probe_xplat_spray.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(OUT) + '\n')
    sys.exit(code)

op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
LOC = 'http://127.0.0.1:8765'
ONL = 'https://starpivot-universe.app.workbuddy.host'

A = {"id": "A", "name": "A", "mass": 3e-6, "radius_km": 6371, "a": 1.0, "e": 0.2, "argp": 0.0, "M0": 0.0}
B = {"id": "B", "name": "B", "mass": 3e-6, "radius_km": 6371, "a": 1.0, "e": 0.2, "argp": 180.0, "M0": 135.0}

def fetch(base, spray, years=3, samples=1000):
    p = {"scenario": "custom", "solar": "sun", "years": years, "samples": samples,
         "collide": "fragment", "radius_scale": 450, "spray": spray, "bodies": [A, B]}
    req = urllib.request.Request(base + '/api/nbody',
        data=json.dumps(p).encode(), headers={'Content-Type': 'application/json'})
    return json.load(op.open(req, timeout=300))

def reldiff(a, b):
    d = abs(a - b); s = max(abs(a), abs(b))
    return 0.0 if d == 0 else (d / s if s > 0 else d)

# ---- 前置：两端都得在，否则记"环境缺席"（rc=2），不是失败 ----
for label, base in (('本地网关 ' + LOC, LOC), ('线上站 ' + ONL, ONL)):
    try:
        op.open(base + '/api/health', timeout=20).read()
        chk(True, label + ' 可达')
    except Exception as e:
        chk(False, label + ' 可达', '%s —— 拿不到这一端的输出，比对无法进行' % (e,))
        emit('')
        emit('[xplat_spray] 环境缺席：这一端不可达 → 记 SKIP，**不代表通过**')
        emit('[xplat_spray] n=%d fail=%d' % (n, failed))
        with open(os.path.join(R, '_probe_xplat_spray.txt'), 'w', encoding='utf-8') as f:
            f.write('\n'.join(OUT) + '\n')
        sys.exit(2)

overall = [0.0, '', None, None]
for spray in (0.0, 0.33, 0.9):
    try:
        la, oa = fetch(LOC, spray), fetch(ONL, spray)
    except Exception as e:
        chk(False, 'spray=%s 两端都取到结果' % spray, str(e))
        continue
    fra, fro = la['frames'], oa['frames']
    ev_a = [(e.get('t'), e.get('type'), e.get('kind')) for e in (la.get('events') or [])]
    ev_b = [(e.get('t'), e.get('type'), e.get('kind')) for e in (oa.get('events') or [])]

    # 回显：唯一能回答"网关吞没吞这个键"的东西。内核默认是 0.6，这三个档都不等于它。
    e_a = (la.get('fragmentation') or {}).get('spray')
    e_b = (oa.get('fragmentation') or {}).get('spray')
    chk(e_a is not None and abs(e_a - spray) < 1e-12,
        'spray=%s：**本地**内核回显 == 请求值（网关真转发了）' % spray, '回显 %s' % (e_a,))
    chk(e_b is not None and abs(e_b - spray) < 1e-12,
        'spray=%s：**线上**内核回显 == 请求值（线上网关也真转发了）' % spray, '回显 %s' % (e_b,))

    chk(len(fra) == len(fro), 'spray=%s：帧数一致' % spray, '本地 %d / 线上 %d' % (len(fra), len(fro)))
    chk(ev_a == ev_b, 'spray=%s：事件序列一致' % spray,
        '本地 %d / 线上 %d 条' % (len(ev_a), len(ev_b)))

    worst = [0.0, '', None, None]
    if len(fra) == len(fro):
        nb = 0
        for fi, (fa, fb) in enumerate(zip(fra, fro)):
            r = reldiff(fa['t'], fb['t'])
            if r > worst[0]: worst = [r, 'f%d.t' % fi, fa['t'], fb['t']]
            pa, pb = fa['p'], fb['p']
            if len(pa) != len(pb):
                worst = [9.9, 'f%d 天体数不一致 %d vs %d' % (fi, len(pa), len(pb)), None, None]
                break
            for bi in range(len(pa)):
                for ci in range(len(pa[bi])):
                    r = reldiff(pa[bi][ci], pb[bi][ci])
                    if r > worst[0]:
                        worst = [r, 'f%d.b%d.p[%d]' % (fi, bi, ci), pa[bi][ci], pb[bi][ci]]
                nb += 1
    chk(worst[0] == 0.0, 'spray=%s：逐帧逐分量**逐位一致**' % spray,
        ('最大相对差 %.6e @ %s' % (worst[0], worst[1])) if worst[0] > 0 else '（0.000000e+00）')
    if worst[0] > overall[0]: overall = worst[:]

chk(overall[0] == 0.0, '三个 spray 档合起来：本地 Windows exe 与线上 Linux ELF 行为等价',
    '总最大相对差 %.6e' % overall[0] if overall[0] > 0 else '（全逐位一致）')

emit('')
emit('[xplat_spray] 说明：线上那颗是 Linux 静态 ELF，本机跑不了，所以"两颗二进制一致"只能在线上比。')
finish(1 if failed else 0)
