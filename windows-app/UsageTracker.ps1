# AI Carbon Tracker - Windows tray app (PowerShell + WinForms).
#
# A system-tray icon + settings window that wraps the `lut.exe` CLI:
#   - Settings... : enter server URL / name / email / ingest token, choose which
#     tools to track, then Save runs `lut connect` (writes config + wires the
#     Claude Code Stop hook).
#   - Keeps the background watchers running. On macOS those are LaunchAgents,
#     but Windows has no equivalent, so this app supervises a single
#     `lut watch-all --only <surfaces>` child process while it's in the tray.
#     One process, not one per surface: each is a full embedded Bun runtime.
#   - Check for updates: `lut update`, behind a confirmation. A daily background
#     check only ever shows a balloon tip.
#   - Open dashboard / Status / Quit.
#
# Run hidden at login via UsageTracker.vbs (see README). Requires lut.exe
# installed (install.ps1).  NOTE: authored on macOS; test on Windows.

#Requires -Version 5
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# --- locate lut.exe -------------------------------------------------------
function Find-Lut {
    # Prefer the exact lut that launched us (set by `lut gui`).
    if ($env:LUT_BIN -and (Test-Path $env:LUT_BIN)) { return $env:LUT_BIN }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\llm-usage-tracker\lut.exe'),
        (Join-Path $env:USERPROFILE '.local\bin\lut.exe'),
        (Join-Path $env:USERPROFILE 'lut\lut.exe'),
        'lut.exe'
    )
    foreach ($c in $candidates) {
        $cmd = Get-Command $c -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
        if (Test-Path $c) { return $c }
    }
    return $null
}
$script:Lut = Find-Lut
if (-not $script:Lut) {
    [System.Windows.Forms.MessageBox]::Show(
        "lut.exe not found. Install it first:`n  irm https://raw.githubusercontent.com/versantus/llm-usage-tracker/main/install.ps1 | iex",
        'AI Carbon Tracker', 'OK', 'Warning') | Out-Null
    exit 1
}

# --- paths + config -------------------------------------------------------
$ConfigPath   = Join-Path $env:USERPROFILE '.config\llm-usage-tracker\config.json'
$StateDir     = Join-Path $env:LOCALAPPDATA 'llm-usage-tracker'
$SurfaceState = Join-Path $StateDir 'tray-surfaces.json'
$LogDir       = Join-Path $StateDir 'logs'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Get-Config {
    if (Test-Path $ConfigPath) {
        try { return Get-Content $ConfigPath -Raw | ConvertFrom-Json } catch { }
    }
    return $null
}

# Watcher surfaces detectable on Windows.
function Get-AvailableSurfaces {
    $s = @()
    if (Test-Path (Join-Path $env:USERPROFILE '.codex\sessions')) { $s += 'codex' }
    if (Test-Path (Join-Path $env:APPDATA 'Claude\local-agent-mode-sessions')) { $s += 'cowork' }
    if (Test-Path (Join-Path $env:USERPROFILE '.gemini'))          { $s += 'gemini' }
    if ((Test-Path (Join-Path $env:USERPROFILE '.copilot')) -or
        (Test-Path (Join-Path $env:APPDATA 'Code\User\workspaceStorage'))) { $s += 'copilot' }
    if (Test-Path (Join-Path $env:APPDATA 'Ollama\db.sqlite'))      { $s += 'ollama' }
    return $s
}

function Get-EnabledSurfaces {
    if (Test-Path $SurfaceState) {
        try { return @(Get-Content $SurfaceState -Raw | ConvertFrom-Json) } catch { }
    }
    return Get-AvailableSurfaces   # default: track everything detected
}
function Set-EnabledSurfaces([string[]]$surfaces) {
    ($surfaces | ConvertTo-Json -Compress) | Set-Content -Path $SurfaceState -Encoding UTF8
}

# --- run lut (hidden), capture output -------------------------------------
function Invoke-Lut {
    param([string[]]$LutArgs)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $script:Lut
    $psi.Arguments = ($LutArgs | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    try {
        # Read stderr asynchronously while draining stdout: reading them
        # sequentially deadlocks when the child fills the stderr pipe buffer
        # (lut writes nearly everything to stderr).
        $errTask = $p.StandardError.ReadToEndAsync()
        $out = $p.StandardOutput.ReadToEnd() + $errTask.Result
        $p.WaitForExit()
        return $out
    } finally {
        # Each Process holds an OS handle until disposed; the tray runs for
        # weeks and calls this from menu items and the settings dialog.
        try { $p.Dispose() } catch { }
    }
}

# --- watcher supervision --------------------------------------------------
# ONE `lut watch-all` process covers every enabled surface. Each watcher is a
# full embedded Bun runtime, so the old process-per-surface layout paid five
# baseline heaps for work that is almost entirely idle polling — the main reason
# the tray looked memory-hungry on Windows.
$script:Watcher    = $null
$script:WatcherArgs = ''

function Get-WatcherArgs {
    $enabled = @(Get-EnabledSurfaces)
    if (-not $enabled -or $enabled.Count -eq 0) { return $null }
    return "watch-all --only $($enabled -join ',')"
}

function Stop-Watchers {
    if (-not $script:Watcher) { return }
    try { if (-not $script:Watcher.HasExited) { $script:Watcher.Kill() } } catch { }
    # Release the OS handle. Without this every restart leaks one.
    try { $script:Watcher.Dispose() } catch { }
    $script:Watcher = $null
}

function Ensure-Watchers {
    $wanted = Get-WatcherArgs
    if (-not $wanted) { Stop-Watchers; return }

    # Restart when the selection changed, otherwise only if it died.
    if ($script:Watcher -and -not $script:Watcher.HasExited -and $wanted -eq $script:WatcherArgs) {
        return
    }
    Stop-Watchers
    try {
        $errLog = Join-Path $LogDir 'watchers.log'
        $outLog = Join-Path $LogDir 'watchers.out.log'
        $script:Watcher = Start-Process -FilePath $script:Lut `
            -ArgumentList $wanted -WindowStyle Hidden -PassThru `
            -RedirectStandardError $errLog -RedirectStandardOutput $outLog
        $script:WatcherArgs = $wanted
    } catch { }
}

# --- settings window ------------------------------------------------------
function Show-Settings {
    $cfg = Get-Config
    $available = Get-AvailableSurfaces
    $enabled = Get-EnabledSurfaces

    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'AI Carbon Tracker - Settings'
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false; $form.MinimizeBox = $false

    # Lay out fields top-down. $script:fy is used so the nested Add-Field can
    # advance the shared Y cursor (function scopes can't write a caller's local).
    $script:fy = 16
    function Add-Field([string]$label, [string]$value, [bool]$secret) {
        $lbl = New-Object System.Windows.Forms.Label
        $lbl.Text = $label; $lbl.Location = "16,$script:fy"; $lbl.Size = '420,18'
        $form.Controls.Add($lbl); $script:fy += 20
        $tb = New-Object System.Windows.Forms.TextBox
        $tb.Location = "16,$script:fy"; $tb.Size = '410,22'; $tb.Text = $value
        if ($secret) { $tb.UseSystemPasswordChar = $true }
        $form.Controls.Add($tb); $script:fy += 34
        return $tb
    }

    $tbServer = Add-Field 'Server URL' ($(if ($cfg) { $cfg.serverUrl } else { 'https://llm-usage-tracker.fly.dev' })) $false
    $tbName   = Add-Field 'Your name'  ($(if ($cfg) { $cfg.user.name } else { $env:USERNAME })) $false
    $tbEmail  = Add-Field 'Your work email' ($(if ($cfg) { $cfg.user.email } else { '' })) $false
    $tbToken  = Add-Field 'Ingest token (from 1Password)' ($(if ($cfg) { $cfg.ingestToken } else { '' })) $true

    $lblTrack = New-Object System.Windows.Forms.Label
    $lblTrack.Text = 'Track these tools:'; $lblTrack.Location = "16,$script:fy"; $lblTrack.Size = '410,18'
    $form.Controls.Add($lblTrack); $script:fy += 22

    $checks = @{}
    foreach ($s in @('codex', 'cowork', 'gemini', 'copilot', 'ollama')) {
        $cb = New-Object System.Windows.Forms.CheckBox
        $present = $available -contains $s
        $cb.Text = $s + $(if (-not $present) { '  (not detected)' } else { '' })
        $cb.Location = "24,$script:fy"; $cb.Size = '400,20'
        $cb.Checked = ($enabled -contains $s)
        $cb.Enabled = $present
        $form.Controls.Add($cb); $checks[$s] = $cb; $script:fy += 24
    }

    $script:fy += 4
    $status = New-Object System.Windows.Forms.Label
    $status.Location = "16,$script:fy"; $status.Size = '410,40'; $status.ForeColor = 'DimGray'
    $form.Controls.Add($status); $script:fy += 46

    $btn = New-Object System.Windows.Forms.Button
    $btn.Text = 'Save && Connect'; $btn.Location = "16,$script:fy"; $btn.Size = '410,30'
    $btn.Add_Click({
        if (-not $tbEmail.Text -or -not $tbServer.Text) {
            $status.ForeColor = 'Firebrick'; $status.Text = 'Server URL and email are required.'; return
        }
        $btn.Enabled = $false; $status.ForeColor = 'DimGray'; $status.Text = 'Connecting...'
        $form.Refresh()
        $out = Invoke-Lut @('connect', '--name', $tbName.Text, '--email', $tbEmail.Text,
                             '--server-url', $tbServer.Text, '--ingest-token', $tbToken.Text)
        $sel = @($checks.Keys | Where-Object { $checks[$_].Checked })
        Set-EnabledSurfaces $sel
        Ensure-Watchers
        $wired = (Invoke-Lut @('status')) -match 'hook:\s+wired'
        $status.ForeColor = $(if ($wired) { 'ForestGreen' } else { 'Firebrick' })
        $status.Text = $(if ($wired) { "Connected. Tracking: $($sel -join ', ')" } else { "Ran, but hook not wired:`n$out" })
        $btn.Enabled = $true
    })
    $form.Controls.Add($btn)
    $form.ClientSize = New-Object System.Drawing.Size(442, ($script:fy + 44))
    $form.Topmost = $true
    $form.ShowDialog() | Out-Null
}

# --- tray icon ------------------------------------------------------------
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information   # TODO: bundle a leaf icon
$notify.Text = 'AI Carbon Tracker'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miSettings = $menu.Items.Add('Settings...')
$miDash     = $menu.Items.Add('Open dashboard')
$miStatus   = $menu.Items.Add('Status')
$miUpdate   = $menu.Items.Add('Check for updates')
$menu.Items.Add('-') | Out-Null
$miQuit     = $menu.Items.Add('Quit')
$notify.ContextMenuStrip = $menu

$miSettings.Add_Click({ Show-Settings })
$notify.Add_MouseDoubleClick({ Show-Settings })
$miDash.Add_Click({
    $cfg = Get-Config
    $url = $(if ($cfg) { $cfg.serverUrl } else { 'https://llm-usage-tracker.fly.dev' })
    Start-Process $url
})
$miStatus.Add_Click({
    [System.Windows.Forms.MessageBox]::Show((Invoke-Lut @('status')), 'AI Carbon Tracker - status') | Out-Null
})

# --- update check ---------------------------------------------------------
# `lut update --check --json` reports; installing is always a deliberate Yes.
# The watcher must be stopped first: Windows cannot replace a running .exe.
function Invoke-UpdateCheck {
    param([bool]$Quiet)
    $raw = Invoke-Lut @('update', '--check', '--json')
    $info = $null
    try { $info = $raw | ConvertFrom-Json } catch { }
    if (-not $info) {
        if (-not $Quiet) {
            [System.Windows.Forms.MessageBox]::Show(
                "Couldn't check for updates.`n`n$raw", 'AI Carbon Tracker') | Out-Null
        }
        return
    }
    if (-not $info.updateAvailable) {
        if (-not $Quiet) {
            [System.Windows.Forms.MessageBox]::Show(
                "You're up to date (version $($info.current)).", 'AI Carbon Tracker') | Out-Null
        }
        return
    }
    $answer = [System.Windows.Forms.MessageBox]::Show(
        "Version $($info.latest) is available (you have $($info.current)).`n`nInstall it now? The tracker will restart.",
        'AI Carbon Tracker - update available', 'YesNo', 'Information')
    if ($answer -ne 'Yes') { return }

    Stop-Watchers
    $out = Invoke-Lut @('update', '--json')
    $result = $null
    try { $result = $out | ConvertFrom-Json } catch { }
    Ensure-Watchers
    $text = if ($result) { $result.message } else { $out }
    [System.Windows.Forms.MessageBox]::Show($text, 'AI Carbon Tracker') | Out-Null
}

$miUpdate.Add_Click({ Invoke-UpdateCheck $false })

$miQuit.Add_Click({
    Stop-Watchers
    $notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

# Start watchers + a 30s supervisor to restart them if they die.
Ensure-Watchers
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 30000
$timer.Add_Tick({ Ensure-Watchers })
$timer.Start()

# Daily update check, notify-only: a balloon tip, never a silent install.
# `lut` caches the lookup for 24h, so this costs nothing between checks.
$updateTimer = New-Object System.Windows.Forms.Timer
$updateTimer.Interval = 6 * 60 * 60 * 1000   # 6h; the 24h cache does the rest
$updateTimer.Add_Tick({
    $raw = Invoke-Lut @('update', '--check', '--json')
    try {
        $info = $raw | ConvertFrom-Json
        if ($info.updateAvailable) {
            $notify.BalloonTipTitle = 'Usage Tracker update available'
            $notify.BalloonTipText  = "Version $($info.latest) is ready. Right-click the tray icon > Check for updates."
            $notify.ShowBalloonTip(10000)
        }
    } catch { }
})
$updateTimer.Start()

# If never configured, pop Settings on first run.
if (-not (Get-Config)) { Show-Settings }

[System.Windows.Forms.Application]::Run()
Stop-Watchers
$notify.Visible = $false
