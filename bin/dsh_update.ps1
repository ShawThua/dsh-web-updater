#requires -Version 5.1
<#
.SYNOPSIS
  DSH 网页端更新器（独立进程）：等宿主退出 → 静默安装新版本 → 校验版本 → 重新拉起网页端。

.DESCRIPTION
  这个脚本必须由「脱离宿主」的进程运行：宿主正是要被替换的可执行文件。
  正常入口是 dsh-web-updater 插件的「安装」按钮（它用 detached 方式启动本脚本）；
  也可以在命令行手工运行。

  重新拉起宿主的三种方式（按优先级）：
    1) -RelaunchJson <path>：插件在运行时写下的宿主自述文件（exe + argv + cwd + env），
       直接「重放」原始命令行 —— 换机器、换安装目录都不需要额外配置；
    2) -LauncherVbs <path>：本机自定义启动器（老机器兼容，会把 token 写回稳定入口）；
    3) 兜底：直接调用 <InstallDir>\resources\runtime\cli\bin\dsh.cmd。

  退出码：0 = 成功；1 = 安装失败（已尽量恢复旧宿主）；2 = 参数/环境错误。

.EXAMPLE
  # 只检查（不安装）：
  pwsh -File dsh_update.ps1 -CheckOnly

.EXAMPLE
  # 手工安装本地已下载的安装包（先停宿主）：
  powershell -NoProfile -ExecutionPolicy Bypass -File dsh_update.ps1 -Install `
    -InstallerPath "$env:LOCALAPPDATA\@deepseek-aidsh-desktop-updater\pending\deepseek-harness-0.2.2-rc.3-win-x64.exe" `
    -ExpectedVersion 0.2.2-rc.3
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$CheckOnly,
    [switch]$RestartOnly,
    [string]$InstallerPath,
    [string]$ExpectedVersion,
    [string]$CurrentVersion,
    [int]$WaitPid = 0,
    [string]$InstallDir = '',
    [int]$Port = 0,
    [string]$ResultPath,
    [string]$LogPath,
    [string]$LauncherVbs = '',
    [string]$PortalVbs = '',
    [string]$StartedMarker = '',
    [string]$RelaunchJson = '',
    [string]$FeedUrl = 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml',
    [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'
$PortalPort = 8444

if (-not $PSBoundParameters.ContainsKey('CheckOnly')) { $CheckOnly = (-not $Install) -and (-not $RestartOnly) }

if (-not $LogPath) { $LogPath = Join-Path $env:LOCALAPPDATA 'DSH\dsh-update.log' }
if (-not $ResultPath) { $ResultPath = Join-Path $env:LOCALAPPDATA 'DSH\dsh-update-result.json' }
if (-not $LauncherVbs) { $LauncherVbs = Join-Path $env:LOCALAPPDATA 'DSH\start-dsh-web.vbs' }
if (-not $PortalVbs) { $PortalVbs = Join-Path $env:LOCALAPPDATA 'DSH\portal-server.vbs' }

function Write-Log([string]$Message) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    try {
        $dir = Split-Path -Parent $LogPath
        if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
    } catch { }
}

function Read-RelaunchSpec([string]$Path) {
    if (-not $Path) { return $null }
    if (-not (Test-Path -LiteralPath $Path)) {
        Write-Log "没有找到 relaunch.json（$Path），改用启动器兜底"
        return $null
    }
    try {
        $spec = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        if (-not $spec.exe -or -not $spec.argv) { Write-Log "relaunch.json 内容不完整：$Path"; return $null }
        return $spec
    } catch {
        Write-Log "relaunch.json 解析失败：$($_.Exception.Message)"
        return $null
    }
}

$script:RelSpec = Read-RelaunchSpec $RelaunchJson

function Get-ExeVersion([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $null }
    $v = (Get-Item -LiteralPath $Path).VersionInfo.FileVersion
    if ($v) { return $v }
    # 某些打包方式没有文件版本号，退回读应用清单
    $root = Split-Path -Parent $Path
    foreach ($rel in @('resources\app.asar\dsh\package.json', 'resources\app.asar.unpacked\dsh\package.json')) {
        $pkg = Join-Path $root $rel
        if (Test-Path -LiteralPath $pkg) {
            try { return (Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json).version } catch { }
        }
    }
    return $null
}

function Resolve-Target {
    # 目标可执行文件 = 当前宿主自己（插件给的 relaunch.json 最准），
    # 其次用 -WaitPid 的进程路径，最后在 -InstallDir 里找一个有版本号的 exe。
    if ($script:RelSpec -and $script:RelSpec.exe) {
        $exe = [string]$script:RelSpec.exe
        if (Test-Path -LiteralPath $exe) {
            return [pscustomobject]@{ Exe = $exe; InstallDir = (Split-Path -Parent $exe) }
        }
        Write-Log "relaunch.json 里的可执行文件不存在：$exe"
    }
    if ($WaitPid -gt 0) {
        $proc = Get-Process -Id $WaitPid -ErrorAction SilentlyContinue
        if ($proc -and $proc.Path -and (Test-Path -LiteralPath $proc.Path)) {
            return [pscustomobject]@{ Exe = $proc.Path; InstallDir = (Split-Path -Parent $proc.Path) }
        }
    }
    if ($InstallDir -and (Test-Path -LiteralPath $InstallDir)) {
        $candidate = Get-ChildItem -LiteralPath $InstallDir -Filter '*.exe' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.VersionInfo.FileVersion } |
            Sort-Object Length -Descending |
            Select-Object -First 1
        if ($candidate) { return [pscustomobject]@{ Exe = $candidate.FullName; InstallDir = $InstallDir } }
        return [pscustomobject]@{ Exe = $null; InstallDir = $InstallDir }
    }
    return [pscustomobject]@{ Exe = $null; InstallDir = '' }
}

$target = Resolve-Target
$ExePath = $target.Exe
if (-not $InstallDir) { $InstallDir = $target.InstallDir }

# 端口：插件会显式传；其次取宿主 argv 里的 --port；最后才用默认值
if ($Port -le 0 -and $script:RelSpec) {
    if ($script:RelSpec.port) { $Port = [int]$script:RelSpec.port }
    elseif ($script:RelSpec.argv) {
        $argvList = @($script:RelSpec.argv | ForEach-Object { [string]$_ })
        $i = [array]::IndexOf($argvList, '--port')
        if ($i -ge 0 -and ($i + 1) -lt $argvList.Count) { $Port = [int]$argvList[$i + 1] }
    }
}
$WebPort = if ($Port -gt 0) { $Port } else { 7979 }

function Test-Port([int]$Port) {
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $client.Connect('127.0.0.1', $Port)
        $client.Close()
        return $true
    } catch { return $false }
}

function Wait-Port([int]$Port, [bool]$Expected, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $open = Test-Port $Port
        if ($open -eq $Expected) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return ((Test-Port $Port) -eq $Expected)
}

function Get-ListeningPids([int]$Port) {
    $pids = @()
    foreach ($line in (netstat -ano | Select-String ":$Port\s")) {
        $m = [regex]::Match($line.ToString(), '^\s*TCP\s+\S+:' + $Port + '\s+\S+\s+LISTENING\s+(\d+)\s*$')
        if ($m.Success) { $pids += [int]$m.Groups[1].Value }
    }
    return @($pids | Sort-Object -Unique)
}

function Join-Args([string[]]$Items) {
    # Start-Process 的 -ArgumentList 传单个字符串时不做引号处理，含空格的参数要自己包
    $quoted = foreach ($item in $Items) {
        if ($item -match '[\s"]') { '"' + ($item -replace '"', '\"') + '"' } else { $item }
    }
    return (@($quoted) -join ' ')
}

function Stop-HostProcess {
    if ($WaitPid -gt 0) {
        $proc = Get-Process -Id $WaitPid -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Log "等待宿主退出（pid $WaitPid）…"
            if (-not $proc.WaitForExit(15000)) {
                Write-Log "宿主 15 秒未退出，强制结束 pid $WaitPid"
                try { Stop-Process -Id $WaitPid -Force -ErrorAction Stop } catch { Write-Log "结束宿主失败：$($_.Exception.Message)" }
                Start-Sleep -Milliseconds 800
            }
        }
    }
    # 兜底：只清理仍占着网页端端口的宿主，不按进程名乱杀（避免误伤另一个端口的宿主）
    foreach ($procId in (Get-ListeningPids $WebPort)) {
        if ($procId -eq $PID) { continue }
        Write-Log "停止仍占用端口 $WebPort 的进程 pid $procId"
        try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch { Write-Log "停止 pid $procId 失败：$($_.Exception.Message)" }
    }
    $ok = Wait-Port $WebPort $false 40
    Write-Log "端口 $WebPort 已释放：$ok"
    return $ok
}

function Read-SharedText([string]$Path) {
    # 宿主进程用重定向打开这个日志，独占写；普通 ReadAllText 会被共享冲突挡住
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $reader = New-Object System.IO.StreamReader($stream)
        try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
}

function Update-StableEntry([string]$StreamLog) {
    # 兼容「稳定入口」：某些机器（比如本机）跑了一个 portal，把 token 存在
    # %LOCALAPPDATA%\DSH\portal\url.txt 里做 302 跳转。重放 argv 时没经过启动器，
    # 这个文件就会留着旧 token（手机端 401）。目录不存在时什么都不做。
    $portalDir = Join-Path $env:LOCALAPPDATA 'DSH\portal'
    if (-not (Test-Path -LiteralPath $portalDir)) { return }
    if (-not $StreamLog) { return }
    $deadline = (Get-Date).AddSeconds(30)
    $found = $null
    while ((Get-Date) -lt $deadline) {
        try {
            $text = Read-SharedText $StreamLog
            $m = [regex]::Match($text, 'https?://[^\s"''<>]+\?token=[A-Za-z0-9_\-]+')
            if ($m.Success) { $found = $m.Value; break }
        } catch { }
        Start-Sleep -Milliseconds 700
    }
    if (-not $found) { Write-Log '宿主输出里没找到新 token，稳定入口 url.txt 未刷新'; return }
    try {
        [System.IO.File]::WriteAllText((Join-Path $portalDir 'url.txt'), $found, [System.Text.Encoding]::ASCII)
        Write-Log "已刷新稳定入口 url.txt：$found"
    } catch { Write-Log "刷新 url.txt 失败：$($_.Exception.Message)" }
}

function Start-FromRelaunch {
    $spec = $script:RelSpec
    if (-not $spec) { return $false }
    $exe = [string]$spec.exe
    if (-not (Test-Path -LiteralPath $exe)) { Write-Log "重放失败：找不到 $exe"; return $false }
    $argv = @()
    if ($spec.argv) { $argv = @($spec.argv | ForEach-Object { [string]$_ }) }
    if ($argv.Count -eq 0) { Write-Log '重放失败：relaunch.json 的 argv 为空'; return $false }

    $argString = Join-Args $argv
    $workDir = [string]$spec.cwd
    if (-not $workDir -or -not (Test-Path -LiteralPath $workDir)) { $workDir = Split-Path -Parent $exe }

    # 关键：宿主是 dsh.cmd 设了 ELECTRON_RUN_AS_NODE=1 之后用 Electron 当 Node 跑的；
    # 不带这个变量会弹出桌面 App 窗口而不是网页端宿主。
    $restore = @{}
    if ($spec.env) {
        foreach ($prop in $spec.env.PSObject.Properties) {
            $restore[$prop.Name] = [Environment]::GetEnvironmentVariable($prop.Name, 'Process')
            [Environment]::SetEnvironmentVariable($prop.Name, [string]$prop.Value, 'Process')
        }
    }
    $logDir = Split-Path -Parent $LogPath
    if ($logDir -and -not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
    # 每次重放用独立文件名：重定向会让本脚本进程挂到子进程退出为止，
    # 固定文件名会被上一次的残留进程锁住，导致第二次更新起不来。
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $outLog = Join-Path $logDir "relaunch-$stamp.out.log"
    $errLog = Join-Path $logDir "relaunch-$stamp.err.log"
    # 只保留最近 3 组
    Get-ChildItem -LiteralPath $logDir -Filter 'relaunch-*.log' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -Skip 6 |
        Remove-Item -Force -ErrorAction SilentlyContinue
    Write-Log "重放宿主进程：`"$exe`" $argString"
    $proc = $null
    try {
        $proc = Start-Process -FilePath $exe -ArgumentList $argString -WorkingDirectory $workDir `
            -WindowStyle Hidden -PassThru -ErrorAction Stop `
            -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    } catch {
        Write-Log "重放启动失败：$($_.Exception.Message)"
    } finally {
        foreach ($key in $restore.Keys) { [Environment]::SetEnvironmentVariable($key, $restore[$key], 'Process') }
    }
    if (-not $proc) { return $false }
    Write-Log "重放的宿主 pid=$($proc.Id)，等待端口 $WebPort"
    $up = Wait-Port $WebPort $true 150
    if (-not $up) { Write-Log '重放的宿主没把端口拉起来'; return $false }
    Update-StableEntry $outLog
    return $true
}

function Start-WebStack {
    if (Start-FromRelaunch) { Write-Log "网页端已监听：True"; return $true }

    if ((Test-Path $PortalVbs) -and -not (Test-Port $PortalPort)) {
        Write-Log '启动 portal（8444）'
        Start-Process wscript.exe -ArgumentList "`"$PortalVbs`"" -WindowStyle Hidden
        Wait-Port $PortalPort $true 20 | Out-Null
    }
    if ($LauncherVbs -and (Test-Path $LauncherVbs)) {
        Write-Log "启动网页端宿主：$LauncherVbs"
        Start-Process wscript.exe -ArgumentList "`"$LauncherVbs`"" -WindowStyle Hidden
    } else {
        Write-Log "没有可用启动器，回退为直接启动 dsh.cmd"
        Start-DshCmd
    }
    $ok = Wait-Port $WebPort $true 150
    if (-not $ok) {
        Write-Log '启动器未把宿主拉起来，改为直接启动 dsh.cmd 重试'
        Start-DshCmd
        $ok = Wait-Port $WebPort $true 120
    }
    Write-Log "网页端已监听：$ok"
    return $ok
}

function Start-DshCmd {
    if (-not $InstallDir) { Write-Log '没有安装目录，无法直接启动 dsh.cmd'; return $false }
    $dsh = Join-Path $InstallDir 'resources\runtime\cli\bin\dsh.cmd'
    if (-not (Test-Path -LiteralPath $dsh)) { Write-Log "找不到 $dsh"; return $false }
    $fallbackArgs = @('--profile', 'web', '--host', '127.0.0.1', '--port', "$WebPort", '--no-open')
    $publicUrl = if ($script:RelSpec -and $script:RelSpec.publicUrl) { [string]$script:RelSpec.publicUrl } else { '' }
    if ($publicUrl) {
        try {
            $hostName = ([uri]$publicUrl).Authority
            $fallbackArgs += @('--public-url', $publicUrl, '--trusted-host', $hostName)
        } catch { }
    }
    Write-Log "直接启动：$dsh $($fallbackArgs -join ' ')"
    Start-Process -FilePath $dsh -ArgumentList $fallbackArgs -WindowStyle Hidden
    return $true
}

function Write-Result([bool]$Ok, [string]$Failure, [string]$Error) {
    $payload = [ordered]@{
        ok          = $Ok
        from        = $CurrentVersion
        to          = $ExpectedVersion
        actual      = (Get-ExeVersion $ExePath)
        failure     = $Failure
        error       = $Error
        startedAt   = $script:StartedAt
        finishedAt  = (Get-Date).ToString('o')
        log         = $LogPath
    }
    try {
        $dir = Split-Path -Parent $ResultPath
        if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        ($payload | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $ResultPath -Encoding UTF8
    } catch { Write-Log "写结果文件失败：$($_.Exception.Message)" }
}

# ---------------------------------------------------------------- 检查模式

if ($CheckOnly) {
    $current = if ($CurrentVersion) { $CurrentVersion } else { Get-ExeVersion $ExePath }
    Write-Log "当前版本：$current"
    Write-Log "更新源：$FeedUrl"
    $node = if ($InstallDir) { Join-Path $InstallDir 'resources\runtime\bin\node.cmd' } else { 'node' }
    if (-not (Test-Path -LiteralPath $node)) { $node = 'node' }
    $env:HTTPS_PROXY = if ($env:HTTPS_PROXY) { $env:HTTPS_PROXY } else { 'http://127.0.0.1:7897' }
    $env:NODE_USE_ENV_PROXY = '1'
    $js = @"
const url = process.argv[1];
fetch(url).then(r => r.text()).then(t => {
  const v = (t.match(/^version:\s*(\S+)/m) || [])[1];
  const d = (t.match(/^releaseDate:\s*'?([^'\r\n]+)'?/m) || [])[1];
  console.log(JSON.stringify({ version: v, releaseDate: d }));
}).catch(e => { console.error('ERR', e.message); process.exit(1); });
"@
    try {
        $raw = & $node -e $js $FeedUrl 2>&1
        Write-Log "远端：$raw"
        $remote = $raw | ConvertFrom-Json
        if ($remote.version -eq $current) { Write-Log '已是最新版本。' } else { Write-Log "有新版本：$current → $($remote.version)" }
    } catch {
        Write-Log "检查失败：$($_.Exception.Message)"
    }
    exit 0
}

# ---------------------------------------------------------------- 仅重启模式

if ($RestartOnly) {
    Write-Log '================ 仅重启网页端 ================'
    if ($WhatIfOnly) {
        Write-Log "计划端口：$WebPort；安装目录：$InstallDir；目标 exe：$ExePath"
        if ($script:RelSpec) {
            Write-Log ("计划重放：`"{0}`" {1}" -f $script:RelSpec.exe, (Join-Args @($script:RelSpec.argv)))
        } else {
            Write-Log "计划启动器：$LauncherVbs（存在：$(Test-Path $LauncherVbs)）"
        }
        Write-Log 'WhatIfOnly：只打印计划，不执行。'
        exit 0
    }
    $up = Start-WebStack
    if ($up) { exit 0 }
    exit 1
}

# ---------------------------------------------------------------- 安装模式

$script:StartedAt = (Get-Date).ToString('o')
if ($StartedMarker) {
    try { Set-Content -LiteralPath $StartedMarker -Value $script:StartedAt -Encoding ASCII } catch { }
}
Write-Log '================ 开始更新 ================'
Write-Log "当前版本：$CurrentVersion；目标版本：$ExpectedVersion"
Write-Log "安装包：$InstallerPath"
Write-Log "安装目录：$InstallDir"
Write-Log "目标 exe：$ExePath"

if (-not $InstallerPath -or -not (Test-Path -LiteralPath $InstallerPath)) {
    Write-Log '安装包不存在，退出。'
    Write-Result $false 'install' 'installer missing'
    exit 2
}
$installerSize = (Get-Item -LiteralPath $InstallerPath).Length
Write-Log ("安装包大小：{0:N0} 字节" -f $installerSize)

if ($WhatIfOnly) {
    Write-Log 'WhatIfOnly：只打印计划，不执行。'
    Write-Result $true $null $null
    exit 0
}

try {
    # 1) 停宿主
    $stopped = Stop-HostProcess
    if (-not $stopped) { throw '宿主端口未释放，安装可能失败（继续尝试）' }

    # 2) 静默安装。/D= 必须是最后一个参数且不加引号（NSIS 规则）；
    #    没拿到安装目录时不传 /D=，交给安装器自己的默认位置。
    if ($InstallDir) { $argList = @('/S', "/D=$InstallDir") } else { $argList = @('/S') }
    Write-Log "运行安装器：`"$InstallerPath`" $($argList -join ' ')"
    $proc = Start-Process -FilePath $InstallerPath -ArgumentList $argList -PassThru -ErrorAction Stop
    $timeoutMs = 15 * 60 * 1000
    if (-not $proc.WaitForExit($timeoutMs)) {
        Write-Log '安装器 15 分钟未退出，强制结束'
        try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch { }
    }
    $code = $proc.ExitCode
    Write-Log "安装器退出码：$code"

    # 3) 校验版本
    Start-Sleep -Seconds 2
    $actual = Get-ExeVersion $ExePath
    Write-Log "安装后版本：$actual（期望 $ExpectedVersion）"
    if (-not $actual) {
        throw "安装后找不到 $ExePath"
    }
    if ($ExpectedVersion -and ($actual -ne $ExpectedVersion)) {
        $msg = "版本未变：$actual ≠ $ExpectedVersion"
        Write-Log $msg
        Write-Result $false 'install' $msg
        # 仍然尝试把宿主拉起来，别让用户两头空
        Start-WebStack | Out-Null
        exit 1
    }

    # 4) 重新拉起
    Write-Log '安装成功，重新拉起网页端。'
    $up = Start-WebStack
    if ($up) {
        Write-Result $true $null $null
        Write-Log '================ 更新完成 ================'
        exit 0
    }
    Write-Result $true 'start' 'new version installed but port not listening yet'
    exit 0
} catch {
    $msg = $_.Exception.Message
    Write-Log "更新失败：$msg"
    Write-Result $false 'install' $msg
    # 兜底：用现有 exe 把宿主拉起来（旧版本仍在时至少还能用）
    try { Start-WebStack | Out-Null } catch { Write-Log "恢复宿主失败：$($_.Exception.Message)" }
    exit 1
}
