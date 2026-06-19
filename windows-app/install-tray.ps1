# Install the AI Carbon Tracker tray app: copy it into LOCALAPPDATA, add a
# Start-Menu shortcut, and (optionally) a Startup shortcut so it runs at login.
#
#   irm https://raw.githubusercontent.com/versantus/llm-usage-tracker/main/windows-app/install-tray.ps1 | iex
#
# Or from a clone:  powershell -ExecutionPolicy Bypass -File windows-app\install-tray.ps1
$ErrorActionPreference = 'Stop'

$dest = Join-Path $env:LOCALAPPDATA 'Programs\llm-usage-tracker\tray'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

# Source: alongside this script if run from a clone, else download from GitHub.
$srcDir = if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'UsageTracker.ps1'))) { $PSScriptRoot } else { $null }
$base = 'https://raw.githubusercontent.com/versantus/llm-usage-tracker/main/windows-app'
foreach ($f in 'UsageTracker.ps1', 'UsageTracker.vbs') {
    if ($srcDir) { Copy-Item (Join-Path $srcDir $f) (Join-Path $dest $f) -Force }
    else { Invoke-WebRequest "$base/$f" -OutFile (Join-Path $dest $f) -UseBasicParsing }
}
Write-Host "Installed to $dest"

function New-Shortcut($lnkPath, $target, $arguments) {
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($lnkPath)
    $sc.TargetPath = $target
    $sc.Arguments = $arguments
    $sc.WorkingDirectory = $dest
    $sc.Save()
}

$vbs = Join-Path $dest 'UsageTracker.vbs'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'

# Start-Menu shortcut
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\AI Carbon Tracker.lnk'
New-Shortcut $startMenu $wscript "`"$vbs`""
Write-Host "Start-Menu shortcut created."

# Startup shortcut (runs at login)
$ans = Read-Host "Start automatically at login? (Y/n)"
if ($ans -eq '' -or $ans -match '^[Yy]') {
    $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\AI Carbon Tracker.lnk'
    New-Shortcut $startup $wscript "`"$vbs`""
    Write-Host "Will run at login."
}

# Launch it now.
& $wscript "`"$vbs`""
Write-Host "Launched - look for the tray icon (bottom-right). Right-click it -> Settings."
