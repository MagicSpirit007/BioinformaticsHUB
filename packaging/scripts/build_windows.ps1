#Requires -Version 5.1
<#
.SYNOPSIS
  Full Windows release build: UI → engine → electron-builder (NSIS + portable).

.EXAMPLE
  .\packaging\scripts\build_windows.ps1 -Proxy http://127.0.0.1:7890
  .\packaging\scripts\build_windows.ps1 -SkipEngine   # reuse packaging\engine
  .\packaging\scripts\build_windows.ps1 -SkipInstaller  # only stage UI+engine
#>
param(
  [string]$Proxy = "",
  [switch]$SkipEngine,
  [switch]$SkipUi,
  [switch]$SkipInstaller,
  [switch]$SkipDownload
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$HubDir = Join-Path $RepoRoot "apps\bioinformatics-hub"
$DeskDir = Join-Path $RepoRoot "apps\bioinformatics-hub-desktop"
$EngineDir = Join-Path $RepoRoot "packaging\engine"

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

# 2) Engine
if (-not $SkipEngine) {
  Write-Info "Bootstrap engine → packaging\engine"
  $boot = Join-Path $PSScriptRoot "bootstrap_engine.ps1"
  $bootParams = @{}
  if ($Proxy) { $bootParams["Proxy"] = $Proxy }
  if ($SkipDownload) { $bootParams["SkipDownload"] = $true }
  & $boot @bootParams
  if ($LASTEXITCODE -ne 0) { throw "bootstrap_engine failed" }
} else {
  Write-Info "SkipEngine (expect existing $EngineDir)"
  if (-not (Test-Path (Join-Path $EngineDir "scripts\session_runner.py"))) {
    throw "Engine incomplete: run bootstrap_engine.ps1 first"
  }
  if (-not (Test-Path (Join-Path $EngineDir "python\python.exe"))) {
    throw "Engine python.exe missing"
  }
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
  Write-Info "SkipInstaller — UI and engine staged only"
}

Write-Info "Done."
