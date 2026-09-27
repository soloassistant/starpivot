#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""核对 _runall.sh 与 _verify_all.ps1 的探针清单：集合与顺序都必须逐条一致。

为什么值得单独一个工具：两份清单是**各自内联**的，改一处忘了改另一处不会报错 ——
只会让"本地跑绿、正式入口却没有这一条"这种事安静发生。这个脚本 30 秒就能发现。
"""
import re, sys, os

R = os.path.dirname(os.path.abspath(__file__))
sh = open(os.path.join(R, '_runall.sh'), encoding='utf-8').read()
ps = open(os.path.join(R, '_verify_all.ps1'), encoding='utf-8-sig').read()

# bash: `run <kind> <file> '<label>'` —— 注意**不能锚在行首**：
# 有几条写在 `if ...; then run py ...` 的同一行里，锚行首会漏掉（本工具第一版就这么漏了 1 条）。
# 另有 E 段的 `for pair in "file|label" ...` 循环，要单独解析。
sh_items = [(m.group(1), m.group(2)) for m in re.finditer(
    r"\brun\s+(?:node|py|soft|pysoft)\s+(\S+)\s+'([^']*)'", sh, re.M)]
# ⚠ 这里必须允许 `\"` 转义：E 段的循环写在一对双引号里，标签内部的引号是 `\"`，
#   用 [^"]* 会在第一个转义引号处断开，把标签截断 → 报出一条**假的**标签不一致（本工具踩过）。
sh_items += [(m.group(1), m.group(2).replace('\\"', '"')) for m in re.finditer(
    r'"(\S+\.(?:js|py))\|((?:\\.|[^"\\])*)"', sh)]
# powershell: RunNode|RunPy|RunNodeSoft|RunPySoft '<file>' '<label>'
ps_items = [(m.group(1), m.group(2)) for m in re.finditer(
    r"\bRun(?:Node|Py)(?:Soft)?\s+'([^']+)'\s+'([^']*)'", ps, re.M)]

sf = [f for f, _ in sh_items]
pf = [f for f, _ in ps_items]

print('_runall.sh       探针条数:', len(sh_items))
print('_verify_all.ps1  探针条数:', len(ps_items))
print()
bad = 0
only_sh = [x for x in sf if x not in pf]
only_ps = [x for x in pf if x not in sf]
print('集合相同 :', sorted(sf) == sorted(pf))
print('  只在 sh  :', only_sh or '（无）')
print('  只在 ps1 :', only_ps or '（无）')
if only_sh or only_ps: bad = 1
same_order = (sf == pf)
print('顺序相同 :', same_order)
if not same_order:
    for i, (a, b) in enumerate(zip(sf, pf)):
        if a != b:
            print('  第一处不同 @%d: sh=%s  ps1=%s' % (i, a, b)); break
    bad = 1
# 标签文案也要一致，否则 diff 两份清单时看不出谁改了
lab_bad = [(a, b) for a, b in zip(sh_items, ps_items) if a[0] == b[0] and a[1] != b[1]]
print('标签文案相同 :', not lab_bad)
for a, b in lab_bad[:5]:
    print('  %s:\n    sh =%s\n    ps1=%s' % (a[0], a[1], b[1]))
if lab_bad: bad = 1
print()
print('C5 在 sh 里:', [f for f in sf if 'xplat' in f])
print('C5 在 ps1 里:', [f for f in pf if 'xplat' in f])
sys.exit(bad)
