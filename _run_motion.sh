#!/usr/bin/env bash
# 本轮（运动动画视觉）判据自验脚本。
# ⚠ 本机 HTTP_PROXY 会把 127.0.0.1 也接走，所以先清掉。
# ⚠ STARPIVOT_REPLAY 漏了 → _probe_tools.js 里那 6 条"退出码 null"是假失败。
unset http_proxy HTTP_PROXY https_proxy HTTPS_PROXY
export no_proxy='*' NO_PROXY='*'
export NODE_PATH='C:\Users\geral\.workbuddy\binaries\node\workspace\node_modules'
export STARPIVOT_REPLAY='C:/Users/geral/WorkBuddy/2026-09-24-16-11-48/_replay.json'
NODE='C:\Users\geral\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'
cd 'C:/Users/geral/WorkBuddy/2026-09-24-16-11-48'

"$NODE" --version
curl -s --noproxy '*' -o /dev/null -w 'health=%{http_code}\n' http://127.0.0.1:8765/api/health

for f in _check_bio_page _check_home _check_kids _check_orbit _check_session \
         _probe_tools _probe_play_modes _probe_quality _probe_nav _probe_tour _probe_dualmode; do
  t0=$(date +%s)
  "$NODE" "$f.js" > "_run_$f.log" 2>&1
  rc=$?
  t1=$(date +%s)
  echo "=== $f rc=$rc  $((t1-t0))s  $(stat -c '%y' "$f.txt" 2>/dev/null | cut -c1-19)"
  tail -3 "$f.txt" 2>/dev/null | grep -E 'n=|fail=' | tail -1
  grep -c 'FAIL' "$f.txt" 2>/dev/null | sed 's/^/  FAIL行数=/'
done
