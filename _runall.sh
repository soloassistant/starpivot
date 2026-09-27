#!/usr/bin/env bash
# 临时跑法：本会话里 PowerShell 工具**无法执行 .ps1**（& script.ps1 静默不执行、
# Invoke-Expression 被安全策略拦下），所以照 _verify_all.ps1 的顺序用 bash 走一遍。
# 这不是替换品：_verify_all.ps1 仍是正式入口，本文件用完即删。
set -u
export PATH="/c/Users/geral/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Users/geral/.workbuddy/binaries/PortableGit/versions/1.2.0/bin:/c/Windows/System32:$PATH"
# NODE_PATH 必须在这里设，**不能**等到 E 层再设。
# 理由是一条真踩过的坑：D0 要把内核命令录下来，而它收集的探针里有 jsdom 探针
# （_probe_tools.js）。NODE_PATH 一旦缺席，那个探针在 require('jsdom') 处直接 rc=1，
# 于是 D0 的收集循环第一轮就 break、一条命令都没收，而外层只看"探针退出码不是 2"，
# 静静地把 tools 放过去 —— 直到 E 层回放时才发现"这条命令没录到"，报成一个
# 看起来毫不相关的 FAIL。设早一行就没事，所以设早一行。
export NODE_PATH='C:\Users\geral\.workbuddy\binaries\node\workspace\node_modules'
NODE="C:/Users/geral/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
PY="C:/Users/geral/.workbuddy/binaries/python/versions/3.13.12/python.exe"
ZIG="D:/tmp/zigdl/zig/ziglang/zig.exe"
R="C:/Users/geral/WorkBuddy/2026-09-24-16-11-48"
P="$R/starpivot"

# ---- T4：并发写坏，一处收口 ----
# 症状踩过三次（日志里出现 NUL 字节 / 两条汇总行 / 整段丢失），而每次只能靠
# "单跑复现不了"来排除 —— 因为两轮全量同时在往同一个 _runall.txt 里追加。
# 更隐蔽的是：**探针自己也写固定文件名的 .txt**（如 _probe_tools.txt），
# 并发时两轮互相覆盖结果，于是这一轮读到的是**另一轮**的数字 —— 那是假绿/假红，
# 不是格式问题。所以两件事一起做，缺一不可：
#   ① 进程锁：mkdir 是原子的。拿不到锁 = 已有一轮在跑 → **本轮直接不跑**（rc=2）。
#      绝不"照样跑"：跑出来的数字互相污染，比不跑更坏。陈旧锁（>4 小时）自动接管，
#      免得崩过一次之后永远起不来。
#   ② 每轮写**自己的**文件（_runall_<时间>_<pid>.txt），全文只追加到它；
#      跑完再整份 cp 到 _runall.txt。于是 _runall.txt 只可能收到**完整**的一份，
#      永远不会出现交错的行。历史也不丢 —— 每轮那份都留着。
LOCK="$R/_runall.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +240 2>/dev/null)" ]; then
    echo "  [warn] 发现陈旧锁（超过 4 小时），接管：$LOCK"
    rm -rf "$LOCK"
    mkdir "$LOCK" 2>/dev/null || { echo "[FAIL] 接管锁失败，本轮不跑"; exit 2; }
  else
    echo "[STOP] 另一轮全量正在跑（锁在 $LOCK），**本轮不跑**。"
    echo "       并发跑会互相覆盖探针的结果文件（它们写固定文件名），跑出来的数字不可信。"
    echo "       等它结束；或确认它已死掉后删掉那个锁目录再跑。"
    exit 2
  fi
fi
trap 'rm -rf "$LOCK"' EXIT INT TERM
RUNSTAMP=$(date +%Y%m%d-%H%M%S)
OUT="$R/_runall_${RUNSTAMP}_$$.txt"
: > "$OUT"
fail=0; skip=0
say(){ echo "$*" | tee -a "$OUT"; }
run(){ # run <node|py|soft|pysoft> <file> <label>
  local kind="$1" f="$2" label="$3" rc
  case "$kind" in
    node)   "$NODE" "$R/$f" >/dev/null 2>&1; rc=$? ;;
    py)     "$PY"   "$R/$f" >/dev/null 2>&1; rc=$? ;;
    soft)   "$NODE" "$R/$f" >/dev/null 2>&1; rc=$? ;;
    pysoft) "$PY"   "$R/$f" >/dev/null 2>&1; rc=$? ;;
  esac
  if [ "$rc" -eq 0 ]; then say "  [OK]   $label"
  elif { [ "$kind" = soft ] || [ "$kind" = pysoft ]; } && [ "$rc" -eq 2 ]; then
    say "  [SKIP] $label —— 探针自报：环境缺席（详见它的 .txt）"; skip=$((skip+1))
  else say "  [FAIL] $label （退出码 $rc）"; fail=$((fail+1)); fi
}
sec(){ say ""; say "=== $1 ==="; }

sec "A. 静态判据（不需编译）"
# A0 先跑：它验的是**判据套件自己**有没有走散。两份清单是各自内联的，改一处忘了改另一处
# 不会报错 —— 只会让"本地跑绿、正式入口却没有这一条"安静地发生。所以把它钉成判据。
run py _cmp_lists.py        'A0 两份清单（ps1/sh）的探针集合/顺序/标签逐条一致（改一处必须改另一处）'
run node _check_printf.js   'CLI 全部 printf 的说明符/实参个数一致（含检查器自检）'
run node _check_bio_page.js '页面脚本语法 / id 齐全 / 页面与内核字段名对齐 / 页面不算物理'
run node _check_home.js     '首页：数据来源 / 四类标注 / 诚实边界 / 等价命令 + 路由可达'
run node _check_kids.js     '小朋友页：正文无术语（密度<0.5%）/ 术语挪进折叠区 / 路由可达'
run node _check_session.js  '会话持久化：快照不含内核结果 / 版本不认即丢 / 降级与落盘触发 / 负样本自检'
run node _check.js          'A4 点星体算出的 (yaw,pitch) 真的正对该星轨道平面'
run node _check_solar.js    'A5 太阳系三档：UI 档位 → 真正下发的 payload.solar/primary（含参考系自动判断）'
run node _check_orbit.js    'A6 轨道页：诚实披露 / 页面不算物理 / demo 字段对齐（含"周期"假数回归）'

sec "B. 独立复算（不需编译）"
run py _probe_bio.py       '用 SI 单位从第一性原理重推演化层物理'
run py _probe_argv.py      'webapp 转发给内核的 argv（含 bio 四字段）'
run py _probe_solar.py     'B4 --solar none/sun/full 的物理：独立 Python 复算 + webapp 转发路径'
run node _probe_realdat.js 'B3 真实数据：开普勒三定律互校 + 视差->绝对星等（外部锚点）'
run py _probe_obsstar.py   'B5 真实系外行星：观测 (T,R) → 内核推 L → 行星温度（含反例与负路径）'

sec "C. 真代码单测（需要编译）"
export ZIG_GLOBAL_CACHE_DIR='D:\tmp\zigcache'
export ZIG_LOCAL_CACHE_DIR='D:\tmp\ziglocal'
mkdir -p /d/tmp/zigcache /d/tmp/ziglocal 2>/dev/null
st="$P/build/_bio_selftest.exe"
if "$ZIG" c++ -std=c++17 -O2 -ffp-contract=off -I"$P/include" -o "$st" "$P/tests/_bio_selftest.cpp" "$P/src/bio.cpp" >"$R/_c_build.txt" 2>&1; then
  say "  [OK]   bio 独立自检程序 编译成功（$(stat -c%s "$st" 2>/dev/null) 字节）"
  if "$st" >/dev/null 2>&1; then say "  [OK]   bio 自检 53 项全过（跑的是真 bio.cpp）"
  else say "  [FAIL] bio 自检有失败项"; fail=$((fail+1)); fi
else
  say "  [FAIL] bio 独立自检程序 编译失败（见 _c_build.txt）"; fail=$((fail+1))
fi
srcs=$(ls "$P"/src/*.cpp | tr '\n' ' ')
if "$ZIG" c++ -std=c++17 -O2 -ffp-contract=off -I"$P/include" -o "$P/build/bin/starpivot.exe" $srcs "$P/tools/starpivot_cli.cpp" >"$R/_c_build2.txt" 2>&1; then
  say "  [OK]   内核 + CLI 编译成功（$(stat -c%s "$P/build/bin/starpivot.exe") 字节）"

  # ---- 同时编 Linux 版：线上跑的就是它 ----
  # 本地判据用 Windows 的 .exe，线上用 Linux 的 —— **两颗二进制、同一份源码**。
  # 只编一颗，另一颗就会安静地过期：页面照常打开、照样出数，
  # 只是行为和文档/判据描述的不是同一个东西。所以两颗必须一起编，
  # 编完再由 _probe_linuxbin.py 把"不比源码旧"钉成判据。
  # 目标选 musl 是为了**静态**（沙箱里没有我们的 libc）。
  # 首次全量约 3 分半 —— 早期把它误判成"挂住、疑为联网失败"，见 PRD §4.2。
  mkdir -p "$P/kernel/linux-x86_64"
  if "$ZIG" c++ -target x86_64-linux-musl -std=c++17 -O2 -ffp-contract=off -I"$P/include" \
       -o "$P/kernel/linux-x86_64/starpivot" $srcs "$P/tools/starpivot_cli.cpp" \
       >"$R/_c_build_linux.txt" 2>&1; then
    chmod +x "$P/kernel/linux-x86_64/starpivot"
    say "  [OK]   Linux 内核（静态 musl）编译成功（$(stat -c%s "$P/kernel/linux-x86_64/starpivot") 字节）"
  else
    say "  [FAIL] Linux 内核编译失败（见 _c_build_linux.txt）"; fail=$((fail+1))
  fi
  run py _probe_linuxbin.py 'C4 Linux 内核产物：静态 x86-64 ELF，且不比源码旧'
  # C5：线上跑的是**另一颗二进制**（Linux 静态 ELF），本机跑不了它（没有 qemu/wsl），
  # 所以"两颗二进制行为一致"这件事**只能在线上比** —— 本地跑一个、线上跑一个，同一条命令逐帧比。
  # 三个档 0.0 / 0.33 / 0.9 **都不等于内核默认的 0.6**，并且断言内核**回显**的
  # fragmentation.spray == 请求值 —— 回显是唯一能回答"网关吞没吞这个键"的东西
  # （默认参数下，被吞掉的转发键与转发成功的 argv 逐字相同，判据恒真）。
  # 软判据：任一端不可达 → 探针自报 rc=2 → SKIP。**不是失败，但也不许当通过。**
  run pysoft _probe_xplat_spray.py 'C5 跨平台逐帧比对（3 个 spray 档）：本地 exe 与线上 Linux ELF 逐位一致'

  sec "D. 端到端（需要编译）"

  # ---- D0 预热：把内核命令录下来 ----
  # 本机 Node 起不了子进程（spawnSync 一律 EBUSY，连 cmd /c echo 都是），
  # 所以「Node 探针直接执行内核」这条路由不通。办法是两段式：
  #   探针第 1 遍只报「我要哪些命令」→ _plan_*.json，退出码 2；
  #   python _record.py 用 subprocess 真跑一遍 → _replay.json；
  #   探针第 2 遍带 STARPIVOT_REPLAY 再跑，断言在**真输出**上执行。
  # 循环是因为第一遍可能在第一条缺数据处就中断，多跑几轮直到命令清单不再增长。
  # 录制绑定二进制的体积：内核一改（C 层重建）整份录制作废，不会拿旧内核的输出去喂新断言。
  live0=$(netstat -ano 2>/dev/null | grep -c '127.0.0.1:8765.*LISTENING')
  WARM=(_probe_timearg.js _probe_bodytypes.js _probe_primary.js _probe_integrators.js)
  if [ "${live0:-0}" -gt 0 ]; then WARM+=(_probe_tools.js _probe_firstpaint.js); fi
  rm -f "$R"/_plan__*.json "$R"/_replay.json
  for f in "${WARM[@]}"; do
    pf="$R/_plan_${f%.js}.json"
    rm -f "$pf"
    rc=2
    for _round in 1 2 3 4 5 6 7 8; do
      "$NODE" "$R/$f" >/dev/null 2>&1; rc=$?
      [ "$rc" -ne 2 ] && break
      "$PY" "$R/_record.py" >/dev/null 2>&1 || break
      # 录完必须立刻让**下一轮**读得到，否则 table() 永远为空、每轮都把同样的
      # 命令再"缺"一遍：循环必然跑满 8 轮且永远不收敛，退出码恒为 2。
      # 而"恒为 2"最坏的地方不是慢，是它把 rc=1（探针在收集时就真崩了）
      # 淹没成了一件不值得看的事 —— 见下面那段说明。
      export STARPIVOT_REPLAY="$R/_replay.json"
    done
    # 收集轮的退出码必须当场判读，不能只 break。
    # 真踩过的坑：_probe_tools.js 是 jsdom 探针，而 NODE_PATH 当时写在 E 层（本段之后），
    # 于是它在 require('jsdom') 处 rc=1 —— 一条命令都没收到。当时的代码只 break 不吭声，
    # 这个缺口要一直等到 E 层回放时才以「某条命令没录到」的面目报出来：报错的位置
    # 与真实原因隔了一整层，看着毫不相关。所以判据是"有没有计划文件"：
    if [ ! -f "$pf" ] && [ "$rc" -eq 1 ]; then
      say "  [FAIL] D0 收集 $f 时探针真崩了（rc=1，且没有计划文件）—— 它要的命令一条都没录到"
      fail=$((fail+1))
    elif [ ! -f "$pf" ] && [ "$rc" -eq 2 ]; then
      say "  [FAIL] D0 收集 $f：跑了 8 轮仍一条命令都没收到（rc=2）"
      fail=$((fail+1))
    elif [ "$rc" -eq 1 ]; then
      # 命令收齐了，但探针本身有失败项 —— 不在这一层判死（会重复计数），
      # 它自己的那一层（D1c…/E）随后会如实报出来。
      say "  [info] D0 已收全 $f 要的命令；该探针自身有失败项，见它自己那一层"
    fi
  done
  if [ -f "$R/_replay.json" ]; then
    export STARPIVOT_REPLAY="$R/_replay.json"
    say "  [OK]   内核命令录制完成（$(stat -c%s "$R/_replay.json") 字节）—— 以下内核探针走回放"
  else
    say "  [info] 没有录制文件：说明本进程能直接起子进程，内核探针直接跑"
  fi
  run py   _probe_collide.py     'D1h 碰撞/碎裂：段错误红线 + 守恒 + 级联 + 定向溅射（真跑内核）'
  run py   _probe_orbit_data.py  'D1i 轨道页冻结样本：三个场景与今日内核逐位一致（真跑内核）'
  run node _probe_timearg.js     'D1c 时间/步长参数校验 + 输出采样标定（vis-viva）'
  run node _probe_bodytypes.js   'D1d 天体类型目录（半径/光度独立复算）+ 多光源辐照度求和'
  run node _probe_primary.js     'D1e 根数参考系 --primary（轻恒星必须用，否则行星被甩掉）'
  run node _probe_integrators.js 'D1f 四种积分器：辛性/阶数/交叉点（实测，不按理论想当然）'
  run py   _probe_bio_cli.py     'D1a 真内核 JSON：结构 / 数值 / 退化输入'
  run py   _probe_bio_gateway.py 'D1b 页面 payload → 网关 → 真内核 → JSON'
  run soft _probe_realpage.js    'D1g 真实系外行星：数据文件 → 页面函数 → 网关 → 内核'
  live=$(netstat -ano 2>/dev/null | grep -c '127.0.0.1:8765.*LISTENING')
  if [ "${live:-0}" -gt 0 ]; then run py _probe_bio_http.py 'D2 真 HTTP：页面 → 网关 → 内核 → 页面元素'
  else say "  [SKIP] 8765 上没有服务，D2 真 HTTP 判据未跑"; skip=$((skip+1)); fi
  # D3 不依赖上面那颗 .exe，依赖的是 zig 与 node（都要起子进程，所以只能 python 写）。
  # 软判据：没有 zig/node 时探针自报环境缺席 → SKIP，而不是把整条路线判死。
  run pysoft _probe_wasm.py 'D3 WASM/WASI：内核库链成模块 + 真宿主实例化执行（软判据）'
else
  say "  [FAIL] 内核 + CLI 编译失败（见 _c_build2.txt）"; fail=$((fail+1))
fi

sec "E. 页面级端到端（jsdom，需要 8765 服务）"
# NODE_PATH 在文件开头就设好了（D0 收集 jsdom 探针时就要用），这里不再重复设一遍 ——
# 同一个变量写两处，迟早有一处忘了改。
live2=$(netstat -ano 2>/dev/null | grep -c '127.0.0.1:8765.*LISTENING')
if [ "${live2:-0}" -gt 0 ]; then
  # ⚠ 这 12 条与 _verify_all.ps1 的 E 段**逐条同名同序**（连标签文案也照抄），
  #   好让以后直接 diff 两段的探针清单就能看出谁加了没同步。
  for pair in "_probe_home.js|首页：真加载 → 脚本填出内核状态 → 工具入口可达（含负样本）" \
              "_probe_kids.js|小朋友页：真改旋钮 → 教的那件事（越远越慢）成不成立" \
              "_probe_orbit.js|轨道页：真加载 → 样本逐字渲染 → conj 真调内核（含负路径与负样本）" \
              "_probe_session.js|jsdom 真加载页面：改状态 → 重开 → 逐项断言恢复（含播放推进回归）" \
              "_probe_errbar.js|失败反馈：内核拒绝时告警条黏住不消失 / frames 为空时不冻死" \
              "_probe_quality.js|画质：默认帧数 / 每圈采样点读数 / 一键推荐 / 帧间插值真的生效" \
              "_probe_nav.js|脏标记 / 逐帧导航 / 跳到事件与阶 / 分享链接（不冲掉对方自己的会话）" \
              "_probe_play_modes.js|预设画廊逐个真跑通 / 稳定性挑战的判定与计分" \
              "_probe_tools.js|点画面放行星 / 信息卡 / 倒放与键盘 / 等价 CLI 命令真跑比对 / 撞击的瞬时表现" \
              "_probe_dualmode.js|普通人/教授双模式（含\"切模式不改变计算\"）+ 类型调色板" \
              "_probe_tour.js|导览（deep link / 每步真切算法）/ 积分器下拉 / 能量曲线 / CSV / 新预设" \
              "_probe_firstpaint.js|首屏耗时分解：内核 / 网关 / JSON.parse / 首帧渲染（记录用，非门禁）"; do
    f="${pair%%|*}"; l="${pair#*|}"
    run node "$f" "$l"
  done
else
  say "  [SKIP] 8765 上没有服务，页面级 e2e 未跑"; skip=$((skip+1))
fi

say ""
if [ "$fail" -eq 0 ] && [ "$skip" -eq 0 ]; then say "全部判据通过（A/B/C/D/E 五层）"
elif [ "$fail" -eq 0 ]; then say "已跑的层全过，但有 $skip 项未验证 —— 不要当作全绿"
else say "$fail 项失败，$skip 项跳过"; fi
say "[done] fail=$fail skip=$skip"
# 整份 cp 过去：这一步就是"根治并发交错"的落点 —— _runall.txt 只可能被**一份完整的**日志
# 覆盖，不可能再出现两轮的行交错在一起。（把 cp 放在 say 之后、exit 之前，顺序不能改。）
cp "$OUT" "$R/_runall.txt" 2>/dev/null
echo "本轮日志：$OUT  （已整份复制到 _runall.txt）"
exit $((fail+skip))
