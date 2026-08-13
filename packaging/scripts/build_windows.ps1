#Requires -Version 5.1
<#
.SYNOPSIS
  Windows release build: UI → (slim engine scripts) → electron-builder (NSIS).

.DESCRIPTION
  Local analysis tools (Python interpreter, Python packages, MAFFT, IQ-TREE,
  Playwright Chromium) are NOT bundled into the installer by default. The app
  auto-detects them on the user's machine at runtime and degrades gracefully
  when they are missing. Only the small Python scripts ship in resources\engine.

.EXAMPLE
  .\packaging\scripts\build_windows.ps1 -Proxy http://127.0.0.1:7890   # slim build (default)
  .\packaging\scripts\build_windows.ps1 -BundleEngine -Proxy http://127.0.0.1:7890  # full bundled build
  .\packaging\scripts\build_windows.ps1 -SkipInstaller   # only stage UI + engine scripts
#>
param(
  [string]$Proxy = "",
  [switch]$BundleEngine,
  [switch]$SkipUi,
  [switch]$SkipInstaller,
  [switch]$SkipDownload
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$HubDir = Join-Path $RepoRoot "apps\bioinformatics-hub"
$DeskDir = Join-Path $RepoRoot "apps\bioinformatics-hub-desktop"
$EngineDir = Join-Path $RepoRoot "packaging\engine"
$ScriptsDir = Join-Path $RepoRoot "scripts"

function Write-Info([string]$msg) { Write-Host "[build-win] $msg" -ForegroundColor Green }

if ($Proxy) {
  $env:HTTP_PROXY = $Proxy
  $env:HTTPS_PROXY = $Proxy
  $env:ELECTRON_GET_USE_PROXY = "1"
  $env:GLOBAL_AGENT_HTTP_PROXY = $Proxy
  $env:GLOBAL_AGENT_HTTPS_PROXY = $Proxy
}

# Avoid winCodeSign extract (macOS symlinks need admin on Windows)
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"

# 1) UI
if (-not $SkipUi) {
  Write-Info "Build bioinformatics-hub (Vite base ./)"
  Push-Location $HubDir
  try {
    if (-not (Test-Path "node_modules")) { npm install }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "UI build failed" }
  } finally {
    Pop-Location
  }
  if (-not (Test-Path (Join-Path $HubDir "dist\index.html"))) {
    throw "Missing BioinformaticsHUB dist/index.html"
  }
} else {
  Write-Info "SkipUi"
}

# 2) Engine: slim scripts by default, full bundle only when -BundleEngine.
if ($BundleEngine) {
  Write-Info "Bootstrap FULL engine → packaging\engine (Python + MAFFT + Chromium)"
  $boot = Join-Path $PSScriptRoot "bootstrap_engine.ps1"
  $bootParams = @{}
  if ($Proxy) { $bootParams["Proxy"] = $Proxy }
  if ($SkipDownload) { $bootParams["SkipDownload"] = $true }
  & $boot @bootParams
  if ($LASTEXITCODE -ne 0) { throw "bootstrap_engine failed" }
} else {
  Write-Info "Stage slim engine scripts → packaging\engine\scripts"
  if (-not (Test-Path (Join-Path $ScriptsDir "session_runner.py"))) {
    throw "Missing scripts/session_runner.py"
  }
  $EngineScripts = Join-Path $EngineDir "scripts"
  if (Test-Path $EngineScripts) { Remove-Item -LiteralPath $EngineScripts -Recurse -Force }
  New-Item -ItemType Directory -Path $EngineScripts -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $ScriptsDir "session_runner.py") -Destination $EngineScripts -Force
  Copy-Item -LiteralPath (Join-Path $ScriptsDir "pipeline") -Destination $EngineScripts -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $ScriptsDir "browser") -Destination $EngineScripts -Recurse -Force
  # strip pycache from the staged copy
  Get-ChildItem -LiteralPath $EngineScripts -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  # doctor + install helper are copied into the installer for user reference.
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot "doctor.py") -Destination (Join-Path $EngineDir "doctor.py") -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot "install_tools.ps1") -Destination (Join-Path $EngineDir "install_tools.ps1") -Force
  Copy-Item -LiteralPath (Join-Path $RepoRoot "packaging\requirements-engine.txt") -Destination (Join-Path $EngineDir "requirements-engine.txt") -Force
}

# 3) Desktop deps + installer
if (-not $SkipInstaller) {
  Write-Info "Prepare desktop deps + electron-builder"
  Push-Location $DeskDir
  try {
    if (-not (Test-Path "node_modules")) { npm install }
    $Builder = Join-Path $DeskDir "node_modules\.bin\electron-builder.cmd"
    if (-not (Test-Path $Builder)) {
      npm install
      if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    }
    if (-not (Test-Path $Builder)) { throw "electron-builder is missing from desktop dependencies" }
    Write-Info "electron-builder → release/"
    & $Builder --win --x64
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed" }
  } finally {
    Pop-Location
  }
  Write-Info "Artifacts under apps\bioinformatics-hub-desktop\release\"
} else {
  Write-Info "SkipInstaller — UI and engine scripts staged only"
}

Write-Info "Done."
