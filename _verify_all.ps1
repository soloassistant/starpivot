# starpivot 全量判据入口。
#
# 本机没有 CMake / MSVC / g++，编译靠从腾讯 pypi 镜像取来的 zig（自带 clang 前端）。
# 装法见 README「没有系统编译工具链时怎么办」。
#
# 判据分五层，层层不可互相替代：
#   A. 静态判据（不编译）：printf 说明符/实参个数、页面脚本与内核字段名是否对齐、
#      以及把页面里的函数原文抠出来真跑（点击朝向、三档太阳系 → payload 的翻译）
#   B. 独立复算（不编译）：用 SI 单位从第一性原理重推物理 —— 验"物理对不对"；
#      以及"数据文件 → 内核"这条链（真实系外行星的观测覆盖）
#   C. 真代码单测（要编译）：直接调 bio.cpp —— 验"代码有没有抄错"
#   D. 端到端（要编译 + 要服务）：真内核跑出 JSON、经网关、页面能拿到
#      D0 内核命令录制（见下面那段说明）
#      D1 进程内（真网关 + 真 subprocess + 真内核）
#      D2 真 HTTP（需要 8765 上有本次代码起的服务）
#   E. 页面级端到端（jsdom / 抠页面函数原文）：JS 运行时错误与"页面自己那段代码"的错
# C 层缺席时必须显式说"未验证"，而不是安静地跳过 —— 安静跳过等于假绿。
#
# D0 是为什么：本沙箱里 **Node 起不了子进程**（spawnSync/execFileSync 一律 EBUSY，
# 连 `cmd /c echo` 都是；而 bash→zig / python→exe 都正常）。于是"Node 探针直接
# 执行内核"这条路走不通，四个内核探针（时间参数、类型表、--primary、积分器）
# 只能全部 FAIL —— 那等于内核的类型名、辛性、参考系语义、参数校验在本机
# **一次都没被验证过**。办法是两段式，实现见 _runner.js / _record.py：
#     探针第 1 遍只报「我要哪些命令」→ _plan_<探针>.json，退出码 2（=缺录制，≠失败）
#     python _record.py 用 subprocess 真跑一遍 → _replay.json
#     探针第 2 遍带 STARPIVOT_REPLAY 再跑，断言在**真输出**上执行
# 录制绑定二进制指纹（体积 + sha1，由 _record.py 写入、_runner.js 的 exeOk 核对）：
# C 层一重建，指纹对不上，整份录制作废重新收 —— 不会拿旧内核的输出喂新内核的断言。
# （指纹这一项曾经漏写过，于是那句保护一直在、也一直空转：payload 里没有 exe_size，
#   exeOk() 的 `!meta.exe_size` 恒为真。现在只核体积也不够 —— 改几行而字节数没变的
#   重建挡不住，所以两项都核；两项都没有时如实说"跳过校验"，不假装校验过了。）
# 所以 D0 必须排在 D1 之前、编译之后。
#
# D0 里还有一条顺序上的硬要求：**预热清单里的探针需要的环境变量，必须在这一段之前设好。**
# 真踩过：_probe_tools.js 是 jsdom 探针，而 NODE_PATH 当时写在 E 层（D0 之后），
# 于是它在 require('jsdom') 处 rc=1、一条命令都没收到，而循环只 break 不吭声 ——
# 缺口要等 E 层回放时才以「某条命令没录到」的面目报出来，看着毫不相关。
# 现在两件事一起做：NODE_PATH 设在文件开头，D0 的收集轮退出码当场判读。
#
# 注意：本文件与 _verify_all.sh 是同一套判据的两份入口（PowerShell / bash）。
# 它们各自内联了探针清单，改一处**必须**改另一处。之所以不抽成清单文件：
# 本会话里 PowerShell 工具连 .ps1 都执行不了（& script.ps1 静默不执行、
# Invoke-Expression 被安全策略拦下），.ps1 的结构改动在这里无法验证 ——
# 不能验证的重构不做，宁可留两份明摆着的重复。

$ErrorActionPreference = 'Continue'
$R = 'C:\Users\geral\WorkBuddy\2026-09-24-16-11-48'
$P = "$R\starpivot"
$NODE = 'C:\Users\geral\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'
$PY   = 'C:\Users\geral\.workbuddy\binaries\python\versions\3.13.12\python.exe'
$ZIG  = 'D:\tmp\zigdl\zig\ziglang\zig.exe'

$script:fail = 0
$script:skip = 0

# jsdom 装在托管 workspace 里（不污染用户全局），页面级 e2e 靠它真加载页面脚本
$env:NODE_PATH = 'C:\Users\geral\.workbuddy\binaries\node\workspace\node_modules'

# 自己写一份报告文件。理由：这个沙箱里子进程的 stdout / Write-Host 都接不出来
# （本轮踩过：脚本报"退出码 1"却一个字都读不到，那等于没有判据）。
# 每个探针都把结论写进自己的 .txt，这里照同一套做法。
$REPORT = "$R\_verify_all.txt"
# 报告文件先清空（不涉及删除）。
# 勘误：这里原先写着"不要用 Remove-Item，本沙箱的删除保护会 throw"—— 那个结论是错的。
# 2026-09-26 用一个垃圾文件实测过：Remove-Item 在本沙箱正常工作（同一轮用它删了 77 项、
# 0 失败）。旧结论大概来自某次 unrelated 的失败被归因错了。留在这里是因为
# "把没验证过的结论当成规则写进注释"正是这个仓库最容易再犯的错。
Set-Content -Path $REPORT -Value "" -Encoding utf8
# 逐条追加而不是最后一次性写出：脚本中途被掐断时，至少要能看到走到哪一步、
# 前面几条结论是什么 —— "什么都没有"是最难排查的一种失败。
function Out2($t) { Write-Output $t; Add-Content -Path $REPORT -Value $t -Encoding utf8 }
function Section($t) { Out2 ""; Out2 "=== $t ===" }
function Ok($t)   { Out2 "  [OK]   $t" }
function Bad($t)  { Out2 "  [FAIL] $t"; $script:fail++ }
function Skip($t) { Out2 "  [SKIP] $t"; $script:skip++ }

function RunNode($file, $label) {
    $null = & $NODE "$R\$file" 2>&1
    if ($LASTEXITCODE -eq 0) { Ok "$label" } else { Bad "$label  （退出码 $LASTEXITCODE）" }
}
function RunPy($file, $label) {
    $null = & $PY "$R\$file" 2>&1
    if ($LASTEXITCODE -eq 0) { Ok "$label" } else { Bad "$label  （退出码 $LASTEXITCODE）" }
}
# 退出码 2 = 探针自己报的"某一节因环境缺席而未验证"（不是失败，也不是通过）。
# 单独开这一档是因为 A~D 节有价值、不该因为服务没起就不跑；但"没验证"必须
# 显式记成 skip，不能混进"通过"里 —— 安静跳过等于假绿。
function RunNodeSoft($file, $label) {
    $null = & $NODE "$R\$file" 2>&1
    if ($LASTEXITCODE -eq 0) { Ok "$label" }
    elseif ($LASTEXITCODE -eq 2) { Skip "$label —— 探针自报：环境缺席（详见它的 .txt）" }
    else { Bad "$label  （退出码 $LASTEXITCODE）" }
}
# python 版的同一档。需要它的原因很具体：WASM 那个探针每一步都要**起子进程**
# （zig 编译、node 当 WASI 宿主），而本沙箱里 Node 起不了子进程 —— 所以它只能用
# python 写，于是也就需要一个 python 的 soft 入口，否则"zig 缺席"会被判成失败。
function RunPySoft($file, $label) {
    $null = & $PY "$R\$file" 2>&1
    if ($LASTEXITCODE -eq 0) { Ok "$label" }
    elseif ($LASTEXITCODE -eq 2) { Skip "$label —— 探针自报：环境缺席（详见它的 .txt）" }
    else { Bad "$label  （退出码 $LASTEXITCODE）" }
}

# zig 需要一个可写的缓存目录，否则会以 "failed to delete ... AccessDenied" 静默失败
function EnsureDir($p) { New-Item -ItemType Directory -Force -Path $p | Out-Null }
function Build($out, [string[]]$sources, $label) {
    $env:ZIG_GLOBAL_CACHE_DIR = 'D:\tmp\zigcache'
    $env:ZIG_LOCAL_CACHE_DIR  = 'D:\tmp\ziglocal'
    New-Item -ItemType Directory -Force -Path 'D:\tmp\zigcache','D:\tmp\ziglocal' | Out-Null
    $a = @('c++','-std=c++17','-O2','-ffp-contract=off',"-I$P\include",'-o',$out) + $sources
    $null = & $ZIG @a 2>&1
    if ($LASTEXITCODE -ne 0) { Bad "$label 编译失败"; return $false }
    Ok "$label 编译成功（$((Get-Item $out).Length) 字节）"
    return $true
}
# 同一个编译动作，但**指定目标**（编 Linux 版用）。单独一个函数而不是给 Build 加参数：
# Build 的调用点都在验 Windows 产物，加一个可选参数会让"这次编的是哪个平台"变模糊。
function BuildTarget($out, [string[]]$sources, $target) {
    $env:ZIG_GLOBAL_CACHE_DIR = 'D:\tmp\zigcache'
    $env:ZIG_LOCAL_CACHE_DIR  = 'D:\tmp\ziglinux'
    New-Item -ItemType Directory -Force -Path 'D:\tmp\zigcache','D:\tmp\ziglinux' | Out-Null
    $a = @('c++',"-target",$target,'-std=c++17','-O2','-ffp-contract=off',"-I$P\include",'-o',$out) + $sources
    # 只跑一次，输出留下来：失败时屏幕上往往只有最后一行，而原因在前几行。
    $log = & $ZIG @a 2>&1
    $log | Out-File -FilePath "$R\_c_build_linux.txt" -Encoding utf8
    return ($LASTEXITCODE -eq 0)
}

Section 'A. 静态判据（不需编译）'
# A0 先跑：它验的是**判据套件自己**有没有走散。两份清单各自内联，改一处忘了改另一处不会报错 ——
# 只会让"本地跑绿、正式入口却没有这一条"安静地发生。所以把它钉成判据。
RunPy '_cmp_lists.py' 'A0 两份清单（ps1/sh）的探针集合/顺序/标签逐条一致（改一处必须改另一处）'
RunNode '_check_printf.js'   'CLI 全部 printf 的说明符/实参个数一致（含检查器自检）'
RunNode '_check_bio_page.js' '页面脚本语法 / id 齐全 / 页面与内核字段名对齐 / 页面不算物理'
RunNode '_check_home.js'     '首页：数据来源 / 四类标注 / 诚实边界 / 等价命令 + 路由可达'
RunNode '_check_kids.js'     '小朋友页：正文无术语（密度<0.5%）/ 术语挪进折叠区 / 路由可达'
RunNode '_check_session.js'  '会话持久化：快照不含内核结果 / 版本不认即丢 / 降级与落盘触发 / 负样本自检'
# 下面两条把 universe.html 里的原文抠出来真跑，验"页面自己那点算术/翻译有没有错"。
# 它们是孤儿探针，静默失效过一轮（页面后来加了 typeByKey，抠出的片段少了这个外部名字，
# 探针就再也跑不起来了，而没有任何人知道）。孤儿探针 = 安静的跳过，所以接回来。
RunNode '_check.js'          'A4 点星体算出的 (yaw,pitch) 真的正对该星轨道平面'
RunNode '_check_solar.js'    'A5 太阳系三档：UI 档位 → 真正下发的 payload.solar/primary（含参考系自动判断）'
RunNode '_check_orbit.js'    'A6 轨道页：诚实披露 / 页面不算物理 / demo 字段对齐（含"周期"假数回归）'

Section 'B. 独立复算（不需编译）'
RunPy '_probe_bio.py'  '用 SI 单位从第一性原理重推演化层物理'
RunPy '_probe_argv.py' 'webapp 转发给内核的 argv（含 bio 四字段）'
RunPy '_probe_solar.py' 'B4 --solar none/sun/full 的物理：独立 Python 复算 + webapp 转发路径'
RunNode '_probe_realdat.js' 'B3 真实数据：开普勒三定律互校 + 视差->绝对星等（外部锚点）'
# B5 与 B3 是同一个数据目录的两半：B3 验"星表本身的数对不对"，B5 验
# "观测值真的进了内核、并且与类型表那条路有可量化的区别"。
RunPy '_probe_obsstar.py' 'B5 真实系外行星：观测 (T,R) → 内核推 L → 行星温度（含反例与负路径）'

Section 'C. 真代码单测（需要编译）'
if (-not (Test-Path $ZIG)) {
    Skip "找不到 zig（$ZIG），C/D 层无法进行 —— C++ 部分仍未验证"
} else {
    $st = "$P\build\_bio_selftest.exe"
    if (Build $st @("$P\tests\_bio_selftest.cpp", "$P\src\bio.cpp") 'bio 独立自检程序') {
        $null = & $st 2>&1
        if ($LASTEXITCODE -eq 0) { Ok 'bio 自检 53 项全过（跑的是真 bio.cpp）' }
        else { Bad "bio 自检有失败项（退出码 $LASTEXITCODE）" }
    }

    $src = @(Get-ChildItem "$P\src" -Filter *.cpp | ForEach-Object { $_.FullName }) +
           @("$P\tools\starpivot_cli.cpp")
    if (Build "$P\build\bin\starpivot.exe" $src '内核 + CLI') {

        # ---- 同时编 Linux 版：线上跑的就是它 ----
        # 本地判据用 Windows 的 .exe，线上用 Linux 的 —— **两颗二进制、同一份源码**。
        # 只编一颗，另一颗就会安静地过期：页面照常打开、照样出数，
        # 只是行为和文档/判据描述的不是同一个东西。所以两颗一起编，
        # 再由 _probe_linuxbin.py 把"不比源码旧"钉成判据。
        # 目标选 musl 是为了**静态**（沙箱里没有我们的 libc）。
        # 首次全量约 3 分半 —— 早期把它误判成"挂住、疑为联网失败"，见 PRD §4.2。
        EnsureDir "$P\kernel\linux-x86_64"
        $linuxExe = "$P\kernel\linux-x86_64\starpivot"
        if (BuildTarget $linuxExe $src 'x86_64-linux-musl') {
            Ok "Linux 内核（静态 musl）编译成功（$((Get-Item $linuxExe).Length) 字节）"
        } else {
            Bad 'Linux 内核（静态 musl）编译失败（见 _c_build_linux.txt）'
        }
        RunPy '_probe_linuxbin.py' 'C4 Linux 内核产物：静态 x86-64 ELF，且不比源码旧'
        # C5：线上跑的是**另一颗二进制**（Linux 静态 ELF），本机跑不了它（没有 qemu/wsl），
        # 所以"两颗二进制行为一致"只能在线上比。三个 spray 档都不取内核默认值 0.6，
        # 并断言内核**回显**的 fragmentation.spray == 请求值（回显才能回答"网关吞没吞"）。
        # 软判据：任一端不可达 → 探针自报 rc=2 → SKIP。不是失败，但也不许当通过。
        RunPySoft '_probe_xplat_spray.py' 'C5 跨平台逐帧比对（3 个 spray 档）：本地 exe 与线上 Linux ELF 逐位一致'

        Section 'D. 端到端（需要编译）'

        # 服务在不在，D0 与 D2 都要用，所以先算一次。
        $live = (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue |
                 Measure-Object).Count

        # ---- D0 内核命令录制 / 回放预处理（理由见文件头 D0 那段）----
        Remove-Item "$R\_plan__*.json" -ErrorAction SilentlyContinue
        Remove-Item "$R\_replay.json" -ErrorAction SilentlyContinue
        $warm = @('_probe_timearg.js','_probe_bodytypes.js','_probe_primary.js','_probe_integrators.js')
        # 这两条在 E 层，但它们也要起内核（导出的 CLI 命令、首屏分段计时），
        # 清单要在同一份录制里，所以服务在的时候一起预热。
        if ($live -gt 0) { $warm += @('_probe_tools.js','_probe_firstpaint.js') }
        foreach ($f in $warm) {
            $pf = "$R\_plan_$([IO.Path]::GetFileNameWithoutExtension($f)).json"
            Remove-Item $pf -ErrorAction SilentlyContinue
            for ($round = 1; $round -le 8; $round++) {
                $null = & $NODE "$R\$f" 2>&1
                if ($LASTEXITCODE -ne 2) { break }      # 0/1 = 数据齐了或真失败，都别再录
                $null = & $PY "$R\_record.py" 2>&1
                # 录完必须立刻让**下一轮**读得到。不设的话 table() 永远为空，
                # 每轮都把同样的命令再"缺"一遍：循环必然跑满 8 轮、退出码恒为 2。
                # 而"恒为 2"最坏的地方不是慢 —— 是它把 rc=1（探针在收集时就真崩了）
                # 淹没成一件不值得看的事。下面那段判据就是为了不再淹它。
                $env:STARPIVOT_REPLAY = "$R\_replay.json"
            }
            # 收集轮的退出码必须当场判读，不能只 break。
            # 真踩过的坑：_probe_tools.js 是 jsdom 探针，NODE_PATH 缺席时它在
            # require('jsdom') 处 rc=1，一条命令都没收到；而这里当时只 break 不吭声，
            # 那个缺口一直要等到 E 层回放才以「某条命令没录到」的面目报出来 ——
            # 报错的位置与真实原因隔了一整层，看着毫不相关。
            # 所以判据是"有没有计划文件"：计划文件在 = 它确实报过要哪些命令。
            if ((-not (Test-Path $pf)) -and ($LASTEXITCODE -eq 1)) {
                Bad "D0 收集 $f 时探针真崩了（rc=1，且没有计划文件）—— 它要的命令一条都没录到"
            } elseif ((-not (Test-Path $pf)) -and ($LASTEXITCODE -eq 2)) {
                Bad "D0 收集 $f：跑了 8 轮仍一条命令都没收到（rc=2）"
            } elseif ($LASTEXITCODE -eq 1) {
                # 命令收齐了，只是探针自身有失败项 —— 不在这一层判死（会重复计数），
                # 它自己的那一层（D1c… / E）随后会如实报出来。
                Out2 "  [info] D0 已收全 $f 要的命令；该探针自身有失败项，见它自己那一层"
            }
        }
        if (Test-Path "$R\_replay.json") {
            $env:STARPIVOT_REPLAY = "$R\_replay.json"
            Ok "内核命令录制完成（$((Get-Item "$R\_replay.json").Length) 字节）—— 以下内核探针走回放"
        } else {
            Ok "本机 Node 能直接起子进程（没有产生录制文件），内核探针直接跑"
        }

        RunPy  '_probe_collide.py'    'D1h 碰撞/碎裂：段错误红线 + 守恒 + 级联 + 定向溅射（真跑内核）'
        RunPy  '_probe_orbit_data.py' 'D1i 轨道页冻结样本：三个场景与今日内核逐位一致（真跑内核）'
        RunNode '_probe_timearg.js'   'D1c 时间/步长参数校验 + 输出采样标定（vis-viva）'
        RunNode '_probe_bodytypes.js' 'D1d 天体类型目录（半径/光度独立复算）+ 多光源辐照度求和'
        RunNode '_probe_primary.js'    'D1e 根数参考系 --primary（轻恒星必须用，否则行星被甩掉）'
        RunNode '_probe_integrators.js' 'D1f 四种积分器：辛性/阶数/交叉点（实测，不按理论想当然）'
        RunPy '_probe_bio_cli.py'     'D1a 真内核 JSON：结构 / 数值 / 退化输入'
        RunPy '_probe_bio_gateway.py' 'D1b 页面 payload → 网关 → 真内核 → JSON'
        # D1g 是唯一一条把"页面上那两段自己的代码"（sanitizeBody / payloadBody / bodySpec）
        # 与"数据文件 + 网关 + 内核"串起来验的判据。它第一轮就抓到三个真问题
        # （类型键大小写被静默丢掉、预设不复位碰撞设置、%.6g 的容差定得太紧）。
        # 它需要 8765：服务没起时自分节跳过并退 2（→ skip，不是 fail）。
        RunNodeSoft '_probe_realpage.js' 'D1g 真实系外行星：数据文件 → 页面函数 → 网关 → 内核'

        # D2 需要 8765 上有"本次代码"起的服务。这里不替用户起服务（起不持久），
        # 只报告它能不能跑；探针自带健康检查，会指出"端口上是旧进程"这种情形。
        if ($live -gt 0) {
            RunPy '_probe_bio_http.py' 'D2 真 HTTP：页面 → 网关 → 内核 → 页面元素'
        } else {
            Skip '8765 上没有服务，D2 真 HTTP 判据未跑（先运行 tools/webapp.py）'
        }

        # D3 WASM/WASI 路线。它不依赖上面那颗 .exe，依赖的是 zig 与 node，
        # 而两者都要起子进程（本沙箱 Node 起不了）→ 只能用 python 写，走 RunPySoft。
        # 软判据：没有 zig/node 时探针自报环境缺席（退出码 2）记 SKIP，
        # 不把"这机器上没装 zig"判成"WASM 路线失败"。
        RunPySoft '_probe_wasm.py' 'D3 WASM/WASI：内核库链成模块 + 真宿主实例化执行（软判据）'
    }
}

# E 层：页面级端到端。这一层是唯一能抓到"JS 运行时错误"的判据 ——
# 前几轮一直没做，所以 render() 里小数帧号取到 undefined 那个 bug 才活到今天
# （后果是第二帧就抛异常、rAF 链断掉、画面定格在第一帧）。
# 用 jsdom 真加载页面脚本，fetch 打到真服务（真网关 + 真内核），
# localStorage 用 jsdom 真的那份："重开页面"= 把上次真写进去的字节喂给新实例。
Section 'E. 页面级端到端（jsdom，需要 8765 服务）'
$live2 = (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue |
          Measure-Object).Count
if ($live2 -gt 0) {
    RunNode '_probe_home.js' '首页：真加载 → 脚本填出内核状态 → 工具入口可达（含负样本）'
    RunNode '_probe_kids.js' '小朋友页：真改旋钮 → 教的那件事（越远越慢）成不成立'
    RunNode '_probe_orbit.js' '轨道页：真加载 → 样本逐字渲染 → conj 真调内核（含负路径与负样本）'
    RunNode '_probe_session.js' 'jsdom 真加载页面：改状态 → 重开 → 逐项断言恢复（含播放推进回归）'
    RunNode '_probe_errbar.js'  '失败反馈：内核拒绝时告警条黏住不消失 / frames 为空时不冻死'
    RunNode '_probe_quality.js' '画质：默认帧数 / 每圈采样点读数 / 一键推荐 / 帧间插值真的生效'
    RunNode '_probe_nav.js'     '脏标记 / 逐帧导航 / 跳到事件与阶 / 分享链接（不冲掉对方自己的会话）'
    RunNode '_probe_play_modes.js' '预设画廊逐个真跑通 / 稳定性挑战的判定与计分'
    RunNode '_probe_tools.js'   '双击画面放行星 / 信息卡 / 倒放与键盘 / 等价 CLI 命令真跑比对 / 撞击的瞬时表现'
    RunNode '_probe_dualmode.js' '普通人/教授双模式（含"切模式不改变计算"）+ 类型调色板'
    RunNode '_probe_tour.js'    '导览（deep link / 每步真切算法）/ 积分器下拉 / 能量曲线 / CSV / 新预设'
    # 首屏耗时的分段实测（内核 / 网关 / JSON.parse / 首帧渲染）。它不是门禁，是仪表：
    # 存在的意义是"优化前先量，别拿自己造的秒数立项"（上一轮就踩过这个坑）。
    RunNode '_probe_firstpaint.js' '首屏耗时分解：内核 / 网关 / JSON.parse / 首帧渲染（记录用，非门禁）'
} else {
    Skip '8765 上没有服务，页面级 e2e 未跑（先运行 tools/webapp.py）'
}

Out2 ""
if ($script:fail -eq 0 -and $script:skip -eq 0) {
    Out2 "全部判据通过（A/B/C/D/E 五层）"
} elseif ($script:fail -eq 0) {
    Out2 "已跑的层全过，但有 $script:skip 项未验证 —— 不要当作全绿"
} else {
    Out2 "$script:fail 项失败，$script:skip 项跳过"
}
Out2 "[done] fail=$script:fail skip=$script:skip"
exit ($script:fail + $script:skip)
