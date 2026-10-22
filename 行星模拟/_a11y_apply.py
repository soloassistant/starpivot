#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把前端审查报告的建议 1-4 落到四个页面上。

纪律：每处替换都声明"预期命中 1 次"。命中 0 = 原文和记忆不符（静默跳过会让报告变成假绿），
命中 >1 = 我挑的锚点不够唯一、可能改错地方。两种情况都直接失败退出，不继续写盘。
"""
import sys, io, os

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'starpivot', 'viewer')

# (文件, 旧串, 新串, 预期命中次数)
EDITS = [
    # ---------------- A. label 补 for：index.html（8） ----------------
    ('index.html', '<label>场景</label>', '<label for="scenario">场景</label>', 1),
    ('index.html', '<label>回放</label>', '<label for="slider">回放</label>', 1),
    ('index.html', '<label>对象 A（TLE 两行）</label>', '<label for="tleA">对象 A（TLE 两行）</label>', 1),
    ('index.html', '<label>对象 B（TLE 两行）</label>', '<label for="tleB">对象 B（TLE 两行）</label>', 1),
    ('index.html', '<label>窗口（分钟）</label>', '<label for="cwin">窗口（分钟）</label>', 1),
    ('index.html', '<label>步长（分钟）</label>', '<label for="cstep">步长（分钟）</label>', 1),
    ('index.html', '<label>告警阈值（km）</label>', '<label for="cthr">告警阈值（km）</label>', 1),
    ('index.html', '<label>真实编目</label>', '<label for="cgroups">真实编目</label>', 1),

    # ---------------- A. label 补 for：universe.html（18 静态 + 1 改 span + 2 段 JS） ----------------
    ('universe.html', '<label>时间 <span id="tlabel"',
     '<label for="scrub">时间 <span id="tlabel"', 1),
    ('universe.html', '<label>播放速度（帧/秒）</label>', '<label for="speed">播放速度（帧/秒）</label>', 1),
    ('universe.html', '<label>场景</label>', '<label for="scenario">场景</label>', 1),
    ('universe.html', '<label>积分年数</label>', '<label for="years">积分年数</label>', 1),
    # 「时长」后面是那颗「永久」勾选框，它是这组里唯一的控件
    ('universe.html', '<label>时长</label>', '<label for="perpetual">时长</label>', 1),
    ('universe.html', '<label>输出帧数</label>', '<label for="samples">输出帧数</label>', 1),
    ('universe.html', '<label>计算方法 <span class="plainterm" id="integplain"></span></label>',
     '<label for="integ">计算方法 <span class="plainterm" id="integplain"></span></label>', 1),
    ('universe.html', '<label>碰撞模式</label>', '<label for="collide">碰撞模式</label>', 1),
    ('universe.html', '<label>半径放大 ×</label>', '<label for="rscale">半径放大 ×</label>', 1),
    ('universe.html', '<label>碎块数</label>', '<label for="nfrag">碎块数</label>', 1),
    ('universe.html', '<label>色散速度 km/s</label>', '<label for="disp">色散速度 km/s</label>', 1),
    ('universe.html', '<label>碎裂阈值 km/s</label>', '<label for="fmin">碎裂阈值 km/s</label>', 1),
    ('universe.html', '<label>喷流成束 0–1</label>', '<label for="spray">喷流成束 0–1</label>', 1),
    ('universe.html', '<label>走完 9 级阶梯所需年数</label>', '<label for="bioyears">走完 9 级阶梯所需年数</label>', 1),
    ('universe.html', '<label>bond albedo（地球 0.306）</label>', '<label for="albedo">bond albedo（地球 0.306）</label>', 1),
    ('universe.html', '<label>温室增温 K <span id="ghlabel" class="stat"></span></label>',
     '<label for="greenhouse">温室增温 K <span id="ghlabel" class="stat"></span></label>', 1),
    ('universe.html', '<label>俯仰（0=正俯视）</label>', '<label for="tilt">俯仰（0=正俯视）</label>', 1),
    ('universe.html', '<label>缩放</label>', '<label for="zoom">缩放</label>', 1),
    # 「逐帧」后面是四个按钮；<button> 不属于 labelable 元素，for 指不过去。
    # 改成 span + 一个专用类，把 label 原本那条 CSS 原样搬过来，视觉不变。
    ('universe.html', '<div><label>逐帧</label>', '<div><span class="grouplabel">逐帧</span>', 1),

    # JS 动态生成的两个滑块：顺手给 input 一个随下标唯一的 id，才挂得上 for
    ('universe.html',
     "'<div><label>离恒星多远 <span class=\"plainterm\">a（AU）</span></label>'",
     "'<div><label for=\"ba' + i + '\">离恒星多远 <span class=\"plainterm\">a（AU）</span></label>'", 1),
    ('universe.html',
     "+ '<input type=\"range\" data-i=\"' + i + '\" data-k=\"a\" min=\"0.05\" max=\"40\" step=\"0.01\"'",
     "+ '<input id=\"ba' + i + '\" type=\"range\" data-i=\"' + i + '\" data-k=\"a\" min=\"0.05\" max=\"40\" step=\"0.01\"'", 1),
    ('universe.html',
     "'<div><label>轨道有多扁 <span class=\"plainterm\">e（0 = 正圆）</span></label>'",
     "'<div><label for=\"be' + i + '\">轨道有多扁 <span class=\"plainterm\">e（0 = 正圆）</span></label>'", 1),
    ('universe.html',
     "+ '<input type=\"range\" data-i=\"' + i + '\" data-k=\"e\" min=\"0\" max=\"0.95\" step=\"0.005\"'",
     "+ '<input id=\"be' + i + '\" type=\"range\" data-i=\"' + i + '\" data-k=\"e\" min=\"0\" max=\"0.95\" step=\"0.005\"'", 1),

    # ---------------- A. label 补 for：kids.html（2） ----------------
    ('kids.html', '<label>离恒星多远：<span class="val" id="vdist">2</span> 步</label>',
     '<label for="dist">离恒星多远：<span class="val" id="vdist">2</span> 步</label>', 1),
    ('kids.html', '<label>它的路有多扁：<span class="val" id="vecc">0.0</span></label>',
     '<label for="ecc">它的路有多扁：<span class="val" id="vecc">0.0</span></label>', 1),

    # ---------------- B. canvas 可访问名（7） ----------------
    # 刻意只加属性、不在 <canvas> 里放 fallback 文本：_check_kids 是按"去掉 <details> 的整份
    # HTML 文本"扫术语黑名单的（属性文本也在扫描范围里），_check_home 有首屏 420 汉字上限。
    ('index.html', '<canvas id="map" width="1120" height="560">',
     '<canvas id="map" role="img" aria-label="地面轨迹图：卫星星下点画在等距圆柱投影的世界地图上" width="1120" height="560">', 1),
    ('index.html', '<canvas id="alt" width="540" height="220">',
     '<canvas id="alt" role="img" aria-label="高度剖面图：轨道高度随时间的变化" width="540" height="220">', 1),
    ('index.html', '<canvas id="cmap" width="1120" height="520">',
     '<canvas id="cmap" role="img" aria-label="最近接近前后各 90 分钟的两条地面轨迹" width="1120" height="520">', 1),
    ('universe.html', '<canvas id="view">',
     '<canvas id="view" role="img" aria-label="宇宙模拟主画面：天体在黄道面上的位置与轨道">', 1),
    ('universe.html', '<canvas id="ecv" width="1120" height="260" style="background:#0a0f1e;cursor:default">',
     '<canvas id="ecv" role="img" aria-label="能量误差曲线：积分过程里总能量的相对漂移" width="1120" height="260" style="background:#0a0f1e;cursor:default">', 1),
    ('universe.html', '<canvas id="hr" width="1120" height="520" style="background:#0a0f1e;cursor:default">',
     '<canvas id="hr" role="img" aria-label="赫罗图：恒星的光度对表面温度" width="1120" height="520" style="background:#0a0f1e;cursor:default">', 1),
    ('kids.html', '<canvas id="sky" width="720" height="520">',
     '<canvas id="sky" role="img" aria-label="实验画面：中间那个黄点是恒星，在它旁边点一下就放一颗行星" width="720" height="520">', 1),

    # ---------------- C. 标题跳级：保留原标签，只改 aria-level ----------------
    # 为什么不动标签名：home.html 里 h2 是 16.5px、h3 是 15px，把 h3 换成 h2 会真的改字号。
    ('home.html', '<h3>是</h3>', '<h3 aria-level="2">是</h3>', 1),
    ('home.html', '<h3>不是</h3>', '<h3 aria-level="2">不是</h3>', 1),
    ('home.html', '<h3>四类怎么分', '<h3 aria-level="2">四类怎么分', 1),
    ('home.html', '<h3>① 判据：五层，全绿</h3>', '<h3 aria-level="2">① 判据：五层，全绿</h3>', 1),
    ('home.html', '<h3>② 几个具体的数', '<h3 aria-level="2">② 几个具体的数', 1),
    ('home.html', '<h3>③ 等价命令行', '<h3 aria-level="2">③ 等价命令行', 1),
    ('universe.html', "'<h4><i class=\"dot\"", "'<h4 aria-level=\"3\"><i class=\"dot\"", 1),

    # ---------------- D. 状态文本：只给低频的加 ----------------
    # 反面例子：#statline / #tlabel 每帧都在变，挂 live region 会一直念，反而更难用，所以不加。
    ('universe.html', '<div id="errbar" class="warnbox" style="display:none;margin-bottom:12px">',
     '<div id="errbar" class="warnbox" role="status" style="display:none;margin-bottom:12px">', 1),
    ('universe.html', '<div id="selbody" class="stat" style="font-size:12.5px">',
     '<div id="selbody" class="stat" aria-live="polite" style="font-size:12.5px">', 1),
    ('universe.html', '<div class="note" id="sharenote" style="display:none;margin-top:6px">',
     '<div class="note" id="sharenote" aria-live="polite" style="display:none;margin-top:6px">', 1),
    ('universe.html', '<div id="challengebox" class="note" style="margin-top:8px">',
     '<div id="challengebox" class="note" aria-live="polite" style="margin-top:8px">', 1),
    ('universe.html', '<span class="stat" id="tourcount" style="font-weight:400">',
     '<span class="stat" id="tourcount" aria-live="polite" style="font-weight:400">', 1),
    ('universe.html', '<div class="note" id="presetnote" style="margin-top:8px">',
     '<div class="note" id="presetnote" aria-live="polite" style="margin-top:8px">', 1),
    ('universe.html', '<div class="note" id="typenote" style="margin-top:8px">',
     '<div class="note" id="typenote" aria-live="polite" style="margin-top:8px">', 1),
    ('universe.html', '<div class="note" id="dirtyhint" style="display:none;margin-top:6px">',
     '<div class="note" id="dirtyhint" aria-live="polite" style="display:none;margin-top:6px">', 1),
    ('universe.html', '<span id="solarhint" class="stat" style="font-size:12px;color:#f5c6a5">',
     '<span id="solarhint" class="stat" aria-live="polite" style="font-size:12px;color:#f5c6a5">', 1),
    ('universe.html', '<div class="note" id="bionote" style="margin-top:6px">',
     '<div class="note" id="bionote" aria-live="polite" style="margin-top:6px">', 1),
    ('universe.html', '<div class="note" id="qrow" style="margin-top:8px">',
     '<div class="note" id="qrow" aria-live="polite" style="margin-top:8px">', 1),
    ('index.html', '<div class="note" id="mapnote">', '<div class="note" id="mapnote" aria-live="polite">', 1),
    ('index.html', '<div id="cstatus" class="note">', '<div id="cstatus" class="note" aria-live="polite">', 1),
    ('index.html', '<div id="verdict" style="margin-top:12px">',
     '<div id="verdict" aria-live="polite" style="margin-top:12px">', 1),
    ('kids.html', '<div class="tip" id="tip">', '<div class="tip" id="tip" aria-live="polite">', 1),
    ('kids.html', '<div class="tip" id="ptip">', '<div class="tip" id="ptip" aria-live="polite">', 1),
    ('kids.html', '<div class="tip" id="coltip">', '<div class="tip" id="coltip" aria-live="polite">', 1),

    # ---------------- 配套：给「逐帧」那处新类补一条 CSS（把原 label 的样式原样搬过来） ----------------
    ('universe.html',
     '  label{font-size:var(--fs-sm);color:var(--ink2);display:block;margin-bottom:var(--sp-1)}',
     '  label{font-size:var(--fs-sm);color:var(--ink2);display:block;margin-bottom:var(--sp-1)}\n'
     '  /* 一组按钮的说明文字用这个：它不是任何控件的 <label>，但长得要和 label 一样 */\n'
     '  .grouplabel{font-size:var(--fs-sm);color:var(--ink2);display:block;margin-bottom:var(--sp-1)}', 1),
]


def main():
    cache = {}
    results = []
    for fn, old, new, want in EDITS:
        if fn not in cache:
            with io.open(os.path.join(BASE, fn), encoding='utf-8') as f:
                cache[fn] = f.read()
        s = cache[fn]
        n = s.count(old)
        if n != want:
            print('[FAIL] %s 命中 %d 次（预期 %d）: %s' % (fn, n, want, old[:70]))
            return 2
        cache[fn] = s.replace(old, new)
        results.append((fn, old[:50]))

    for fn, s in cache.items():
        with io.open(os.path.join(BASE, fn), 'w', encoding='utf-8', newline='') as f:
            f.write(s)

    print('已写入 %d 个文件，共 %d 处替换：' % (len(cache), len(EDITS)))
    for fn in sorted(cache):
        c = sum(1 for r in results if r[0] == fn)
        print('  %-16s %2d 处  %d 字节' % (fn, c, len(cache[fn].encode('utf-8'))))
    return 0


if __name__ == '__main__':
    sys.exit(main())
