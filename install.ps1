# LLM Usage Tracker - one-line installer (Windows, PowerShell).
#
#   irm https://raw.githubusercontent.com/versantus/llm-usage-tracker/main/install.ps1 | iex
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
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $url = "https://github.com/$Repo/releases/latest/download/lut-windows-$arch.exe"
    Say "downloading lut.exe ($arch) from $Repo releases..."
    Invoke-WebRequest -Uri $url -OutFile $Dest -UseBasicParsing
}

Say "installed $Dest"

# Add to PATH (user scope) if missing. Go via the registry with
# DoNotExpandEnvironmentNames so %VAR%-style entries survive (the .NET
# Environment API expands them, which would permanently flatten the user PATH).
$regKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$userPath = [string]$regKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$parts = $userPath -split ';' | Where-Object { $_ }
if ($parts -notcontains $BinDir) {
    $newPath = if ($userPath) { "$userPath;$BinDir" } else { $BinDir }
    $regKey.SetValue('Path', $newPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
    $env:Path = "$env:Path;$BinDir"
    Warn "Added $BinDir to your PATH (restart terminals to pick it up)."
}
$regKey.Close()

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
    # Hidden launcher so the console doesn't flash at login. Same file name +
    # location as the one lut.exe writes on first run, so we never end up with
    # two competing login launchers. Unicode encoding: ASCII would corrupt
    # non-ASCII install paths (e.g. C:\Users\José).
    $vbsBody = "CreateObject(""WScript.Shell"").Run """"""$Dest"""" gui"", 0, False"
    $startupVbs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\AI Carbon Tracker.vbs'
    $vbsBody | Set-Content -Path $startupVbs -Encoding Unicode
    # Launch detached — `& $Dest gui` would block this installer forever.
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList """$startupVbs"""
    Say "Tray GUI starting (system-tray icon) and set to start at login."
}

Write-Host ""
Say "All set. Run 'lut status' to verify, or 'lut gui' for the tray."
