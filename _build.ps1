# Build the kernel with zig as the C++ compiler.
# Diagnostics always go to the workspace _build.txt: in this sandbox PowerShell
# stdout cannot be captured, so an exit code alone carries no information.
# NOTE: ASCII only on purpose. A .ps1 containing non-ASCII needs a UTF-8 BOM,
# otherwise PS 5.1 parses it as ANSI and the whole script silently misbehaves.
$R = 'C:\Users\geral\WorkBuddy\2026-09-24-16-11-48'
$P = "$R\starpivot"
$ZIG = 'D:\tmp\zigdl\zig\ziglang\zig.exe'
$env:ZIG_GLOBAL_CACHE_DIR = 'D:\tmp\zigcache'
$env:ZIG_LOCAL_CACHE_DIR  = 'D:\tmp\ziglocal'
$log = "$R\_build.txt"
Set-Content -Path $log -Value "" -Encoding utf8
if (-not (Test-Path $ZIG)) { Add-Content $log "zig not found: $ZIG" -Encoding utf8; exit 3 }
$src = @(Get-ChildItem "$P\src" -Filter *.cpp | ForEach-Object { $_.FullName }) +
       @("$P\tools\starpivot_cli.cpp")
$out = & $ZIG c++ -std=c++17 -O2 -ffp-contract=off "-I$P\include" -o "$P\build\bin\starpivot.exe" @src 2>&1 | Out-String
$code = $LASTEXITCODE
Add-Content $log "exit=$code" -Encoding utf8
if ($out.Trim()) { Add-Content $log $out -Encoding utf8 }
$i = Get-Item "$P\build\bin\starpivot.exe"
Add-Content $log "size=$($i.Length) mtime=$($i.LastWriteTime)" -Encoding utf8
exit $code
