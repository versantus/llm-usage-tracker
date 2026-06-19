# LLM Usage Tracker - one-line installer (Windows, PowerShell).
#
#   irm https://raw.githubusercontent.com/your-org/llm-usage-tracker/main/install.ps1 | iex
#
# Installs the self-contained `lut.exe` to %LOCALAPPDATA%\Programs\llm-usage-tracker,
# then runs `lut connect` to write config and wire the Claude Code Stop hook.
#
# Non-interactive: set $env:LUT_NAME / LUT_EMAIL / LUT_SERVER_URL / LUT_INGEST_TOKEN first.
# Overrides: $env:LUT_REPO (owner/repo), $env:LUT_BIN_DIR, $env:LUT_NO_CONNECT=1

$ErrorActionPreference = 'Stop'

$RepoDefault = 'versantus/llm-usage-tracker'
$Repo = if ($env:LUT_REPO) { $env:LUT_REPO } else { $RepoDefault }
$BinDir = if ($env:LUT_BIN_DIR) { $env:LUT_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\llm-usage-tracker' }
$Dest = Join-Path $BinDir 'lut.exe'

function Say($m)  { Write-Host "==> $m" -ForegroundColor Green }
function Warn($m) { Write-Host "warn: $m" -ForegroundColor Yellow }

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

# If run from a clone, prefer the local binary/source; else download the release asset.
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $null }

if ($ScriptDir -and (Test-Path (Join-Path $ScriptDir 'dist\lut-windows-x64.exe'))) {
    Say "using prebuilt dist\lut-windows-x64.exe"
    Copy-Item (Join-Path $ScriptDir 'dist\lut-windows-x64.exe') $Dest -Force
}
elseif ($ScriptDir -and (Test-Path (Join-Path $ScriptDir 'cli\lut.ts')) -and (Get-Command bun -ErrorAction SilentlyContinue)) {
    Say "building lut.exe with bun..."
    Push-Location $ScriptDir
    bun build --compile --minify --sourcemap=none --target=bun-windows-x64 cli/lut.ts --outfile $Dest
    Pop-Location
}
else {
    $url = "https://github.com/$Repo/releases/latest/download/lut-windows-x64.exe"
    Say "downloading lut.exe from $Repo releases..."
    Invoke-WebRequest -Uri $url -OutFile $Dest -UseBasicParsing
}

Say "installed $Dest"

# Add to PATH (user scope) if missing.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$BinDir*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$BinDir", 'User')
    $env:Path = "$env:Path;$BinDir"
    Warn "Added $BinDir to your PATH (restart terminals to pick it up)."
}

if ($env:LUT_NO_CONNECT -eq '1') {
    Say "skipping connect (LUT_NO_CONNECT=1). Run: `"$Dest`" connect"
    return
}

$cargs = @('connect')
if ($env:LUT_NAME)         { $cargs += @('--name', $env:LUT_NAME) }
if ($env:LUT_EMAIL)        { $cargs += @('--email', $env:LUT_EMAIL) }
if ($env:LUT_SERVER_URL)   { $cargs += @('--server-url', $env:LUT_SERVER_URL) }
if ($env:LUT_INGEST_TOKEN) { $cargs += @('--ingest-token', $env:LUT_INGEST_TOKEN) }

Say "connecting Claude Code..."
& $Dest @cargs

# Offer the tray GUI (built into lut.exe: `lut gui`) + run-at-login.
$ans = Read-Host "Run the tray GUI now and at login? (Y/n)"
if ($ans -eq '' -or $ans -match '^[Yy]') {
    # Hidden launcher so the console doesn't flash at login.
    $vbs = Join-Path $BinDir 'lut-gui.vbs'
    "CreateObject(""WScript.Shell"").Run """"""$Dest"""" gui"", 0, False" | Set-Content -Path $vbs -Encoding ASCII
    $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\AI Carbon Tracker.lnk'
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($startup)
    $sc.TargetPath = (Join-Path $env:WINDIR 'System32\wscript.exe')
    $sc.Arguments = """$vbs"""
    $sc.Save()
    & $Dest gui
    Say "Tray GUI running (system-tray icon) and set to start at login."
}

Write-Host ""
Say "All set. Run 'lut status' to verify, or 'lut gui' for the tray."
