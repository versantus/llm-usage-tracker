# AI Carbon Tracker - Windows tray app (PowerShell + WinForms).
#
# A system-tray icon + settings window that wraps the `lut.exe` CLI:
#   - Settings... : enter server URL / name / email / ingest token, choose which
#     tools to track, then Save runs `lut connect` (writes config + wires the
#     Claude Code Stop hook).
#   - Keeps the background watchers running. On macOS those are LaunchAgents,
#     but Windows has no equivalent, so this app supervises `lut watch-<surface>`
#     child processes itself while it's in the tray.
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
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

function Get-Config {
    if (Test-Path $ConfigPath) {
        try { return Get-Content $ConfigPath -Raw | ConvertFrom-Json } catch { }
    }
    return $null
}

# Watcher surfaces detectable on Windows (cowork is macOS-only).
function Get-AvailableSurfaces {
    $s = @()
    if (Test-Path (Join-Path $env:USERPROFILE '.codex\sessions')) { $s += 'codex' }
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
    $out = $p.StandardOutput.ReadToEnd() + $p.StandardError.ReadToEnd()
    $p.WaitForExit()
    return $out
}

# --- watcher supervision --------------------------------------------------
$script:Watchers = @{}
function Ensure-Watchers {
    $enabled = Get-EnabledSurfaces
    foreach ($s in $enabled) {
        $existing = $script:Watchers[$s]
        if (-not $existing -or $existing.HasExited) {
            try {
                $script:Watchers[$s] = Start-Process -FilePath $script:Lut `
                    -ArgumentList "watch-$s" -WindowStyle Hidden -PassThru
            } catch { }
        }
    }
    # stop watchers no longer enabled
    foreach ($s in @($script:Watchers.Keys)) {
        if ($enabled -notcontains $s) {
            try { if (-not $script:Watchers[$s].HasExited) { $script:Watchers[$s].Kill() } } catch { }
            $script:Watchers.Remove($s)
        }
    }
}
function Stop-Watchers {
    foreach ($p in $script:Watchers.Values) {
        try { if (-not $p.HasExited) { $p.Kill() } } catch { }
    }
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
    foreach ($s in @('codex', 'gemini', 'copilot', 'ollama')) {
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
$miQuit.Add_Click({
    Stop-Watchers
    $notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

# Start watchers + a 30s supervisor to restart any that died.
Ensure-Watchers
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 30000
$timer.Add_Tick({ Ensure-Watchers })
$timer.Start()

# If never configured, pop Settings on first run.
if (-not (Get-Config)) { Show-Settings }

[System.Windows.Forms.Application]::Run()
Stop-Watchers
$notify.Visible = $false
