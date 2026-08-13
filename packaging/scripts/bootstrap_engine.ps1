#Requires -Version 5.1
<#
.SYNOPSIS
  Build the portable BioinformaticsHUB website-session engine for Windows:
  embeddable CPython + local tools + Playwright + MAFFT + optional IQ-TREE.

.EXAMPLE
  .\packaging\scripts\bootstrap_engine.ps1
  .\packaging\scripts\bootstrap_engine.ps1 -Proxy http://127.0.0.1:7890
  .\packaging\scripts\bootstrap_engine.ps1 -SkipDownload   # reuse cache/python
  .\packaging\scripts\bootstrap_engine.ps1 -NoMafft        # development-only opt-out
#>
param(
  [string]$OutDir = "",
  [string]$Proxy = "",
  [string]$BrowserProxy = "",
  [string]$PipIndexUrl = "https://pypi.org/simple",
  [string]$PythonVersion = "3.12.8",
  [switch]$SkipDownload,
  [switch]$SkipPip,
  [switch]$NoIqtree,
  [switch]$NoMafft
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $OutDir) {
  $OutDir = Join-Path $RepoRoot "packaging\engine"
}
$CacheDir = Join-Path $RepoRoot "packaging\cache"
$PyTag = "python-$PythonVersion-embed-amd64"
$ZipName = "$PyTag.zip"
$ZipPath = Join-Path $CacheDir $ZipName
$GetPipPath = Join-Path $CacheDir "get-pip.py"
$PyHome = Join-Path $OutDir "python"
# 3.12.8 -> 312
$MajorMinor = "{0}{1}" -f ($PythonVersion -split '\.')[0], ($PythonVersion -split '\.')[1]
$PthName = "python$MajorMinor._pth"
$PyUrl = "https://www.python.org/ftp/python/$PythonVersion/$ZipName"
$GetPipUrl = "https://bootstrap.pypa.io/get-pip.py"
$ReqFile = Join-Path $RepoRoot "packaging\requirements-engine.txt"
$MafftVersion = "7.526"
$MafftZipName = "mafft-$MafftVersion-win64-signed.zip"
$MafftZipPath = Join-Path $CacheDir $MafftZipName
$MafftUrl = "https://mafft.cbrc.jp/alignment/software/$MafftZipName"
$MafftSha256 = "7C3A508C8512AF04007D68019C6FBD4FF00D891244B58F87EC9AA0E53FBAE8A7"

function Write-Info([string]$msg) { Write-Host "[bootstrap] $msg" -ForegroundColor Cyan }
function Write-Warn([string]$msg) { Write-Host "[bootstrap] $msg" -ForegroundColor Yellow }

function Invoke-Download([string]$Url, [string]$Dest) {
  Write-Info "Download $Url"
  $dir = Split-Path -Parent $Dest
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  if ($Proxy) {
    Invoke-WebRequest -Uri $Url -OutFile $Dest -Proxy $Proxy -UseBasicParsing
  } else {
    Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
  }
}

function Copy-Tree([string]$Src, [string]$Dst) {
  if (-not (Test-Path $Src)) { throw "Missing source: $Src" }
  if (Test-Path $Dst) { Remove-Item -LiteralPath $Dst -Recurse -Force }
  New-Item -ItemType Directory -Path (Split-Path -Parent $Dst) -Force | Out-Null
  Copy-Item -LiteralPath $Src -Destination $Dst -Recurse -Force
}

# --- layout ---
Write-Info "RepoRoot = $RepoRoot"
Write-Info "OutDir   = $OutDir"
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
New-Item -ItemType Directory -Path $CacheDir -Force | Out-Null

if ($Proxy) {
  $env:HTTP_PROXY = $Proxy
  $env:HTTPS_PROXY = $Proxy
  Write-Info "Proxy = $Proxy"
}

# --- embeddable Python ---
if (-not $SkipDownload) {
  if (-not (Test-Path $ZipPath)) {
    try {
      Invoke-Download $PyUrl $ZipPath
    } catch {
      Write-Warn "Download failed: $($_.Exception.Message)"
      Write-Warn "If network is blocked, set -Proxy or place $ZipName in packaging\cache\"
      throw
    }
  } else {
    Write-Info "Using cached $ZipPath"
  }
  if (-not (Test-Path $GetPipPath)) {
    try {
      Invoke-Download $GetPipUrl $GetPipPath
    } catch {
      Write-Warn "get-pip download failed: $($_.Exception.Message)"
      throw
    }
  }
  if (-not $NoMafft -and -not (Test-Path $MafftZipPath)) {
    try {
      Invoke-Download $MafftUrl $MafftZipPath
    } catch {
      Write-Warn "MAFFT download failed: $($_.Exception.Message)"
      throw
    }
  }
} else {
  if (-not (Test-Path $ZipPath)) { throw "SkipDownload set but cache missing: $ZipPath" }
  if (-not $NoMafft -and -not (Test-Path $MafftZipPath)) {
    throw "SkipDownload set but MAFFT cache missing: $MafftZipPath"
  }
}

if (-not $NoMafft) {
  $actualMafftSha = (Get-FileHash -LiteralPath $MafftZipPath -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($actualMafftSha -ne $MafftSha256) {
    throw "MAFFT archive SHA-256 mismatch: expected $MafftSha256, got $actualMafftSha"
  }
  Write-Info "Verified $MafftZipName SHA-256"
}

if (Test-Path $PyHome) {
  Write-Info "Refreshing python/ tree"
  Remove-Item -LiteralPath $PyHome -Recurse -Force
}
New-Item -ItemType Directory -Path $PyHome -Force | Out-Null
Write-Info "Expand embeddable Python → $PyHome"
Expand-Archive -LiteralPath $ZipPath -DestinationPath $PyHome -Force

$PthPath = Join-Path $PyHome $PthName
if (-not (Test-Path $PthPath)) {
  $found = Get-ChildItem -LiteralPath $PyHome -Filter "python*._pth" | Select-Object -First 1
  if ($found) { $PthPath = $found.FullName } else { throw "python*._pth not found under $PyHome" }
}
Write-Info "Enable site-packages in $($PthPath | Split-Path -Leaf)"
@"
python$MajorMinor.zip
.
Lib\site-packages
import site
"@ | Set-Content -LiteralPath $PthPath -Encoding ascii

$PythonExe = Join-Path $PyHome "python.exe"
if (-not (Test-Path $PythonExe)) { throw "python.exe missing at $PythonExe" }

# --- pip + deps ---
if (-not $SkipPip) {
  Write-Info "Install pip"
  & $PythonExe $GetPipPath --no-warn-script-location --no-cache-dir --index-url $PipIndexUrl
  if ($LASTEXITCODE -ne 0) { throw "get-pip failed ($LASTEXITCODE)" }

  $Pip = Join-Path $PyHome "Scripts\pip.exe"
  if (-not (Test-Path $Pip)) {
    # fallback: python -m pip
    Write-Info "pip.exe not found; using python -m pip"
    & $PythonExe -m pip install --upgrade pip --no-warn-script-location
    if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed" }
  }

  Write-Info "Install engine requirements: $ReqFile"
  $pipArgs = @("install", "-r", $ReqFile, "--no-warn-script-location", "--no-cache-dir", "--index-url", $PipIndexUrl)
  if ($Proxy) {
    $pipArgs += @("--proxy", $Proxy)
  }
  & $PythonExe -m pip @pipArgs
  if ($LASTEXITCODE -ne 0) { throw "pip install requirements failed ($LASTEXITCODE)" }
} else {
  Write-Warn "SkipPip: site-packages not refreshed"
}

# --- fixed Playwright Chromium ---
$BrowsersPath = Join-Path $OutDir "playwright-browsers"
if (Test-Path $BrowsersPath) {
  Write-Info "Refreshing playwright-browsers/ tree"
  Remove-Item -LiteralPath $BrowsersPath -Recurse -Force
}
New-Item -ItemType Directory -Path $BrowsersPath -Force | Out-Null
$env:PLAYWRIGHT_BROWSERS_PATH = $BrowsersPath
if ($BrowserProxy) {
  $env:HTTP_PROXY = $BrowserProxy
  $env:HTTPS_PROXY = $BrowserProxy
  Write-Info "Chromium-only proxy = $BrowserProxy"
}
$env:PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT = "120000"
Write-Info "Install fixed Playwright Chromium → $BrowsersPath"
& $PythonExe -m playwright install chromium
if ($LASTEXITCODE -ne 0) { throw "playwright chromium install failed ($LASTEXITCODE)" }

# --- session/local-tool scripts (mini repo root under engine/) ---
$ScriptsDst = Join-Path $OutDir "scripts"
Write-Info "Copy session engine → $ScriptsDst"
if (Test-Path $ScriptsDst) { Remove-Item -LiteralPath $ScriptsDst -Recurse -Force }
New-Item -ItemType Directory -Path $ScriptsDst -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $RepoRoot "scripts\session_runner.py") -Destination $ScriptsDst -Force
Copy-Tree (Join-Path $RepoRoot "scripts\pipeline") (Join-Path $ScriptsDst "pipeline")
Copy-Tree (Join-Path $RepoRoot "scripts\browser") (Join-Path $ScriptsDst "browser")

# strip pycache from copy
Get-ChildItem -LiteralPath $ScriptsDst -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# --- IQ-TREE ---
$ToolsDst = Join-Path $OutDir "tools"
if (Test-Path $ToolsDst) {
  Write-Info "Refreshing tools/ tree"
  Remove-Item -LiteralPath $ToolsDst -Recurse -Force
}
New-Item -ItemType Directory -Path $ToolsDst -Force | Out-Null
if (-not $NoIqtree) {
  $IqSrc = Join-Path $RepoRoot "tools\iqtree-2.3.6-Windows"
  if (Test-Path $IqSrc) {
    Write-Info "Copy IQ-TREE → tools/"
    if (-not (Test-Path $ToolsDst)) { New-Item -ItemType Directory -Path $ToolsDst -Force | Out-Null }
    Copy-Tree $IqSrc (Join-Path $ToolsDst "iqtree-2.3.6-Windows")
  } else {
    Write-Warn "IQ-TREE not found at $IqSrc (optional for local-only)"
  }
} else {
  Write-Warn "NoIqtree: skipping tools/"
}

# --- MAFFT Windows all-in-one ---
if (-not $NoMafft) {
  $MafftDst = Join-Path $ToolsDst "mafft-$MafftVersion-win64-signed"
  Write-Info "Extract official MAFFT $MafftVersion → tools/"
  New-Item -ItemType Directory -Path $MafftDst -Force | Out-Null
  Expand-Archive -LiteralPath $MafftZipPath -DestinationPath $MafftDst -Force
  $MafftBat = Get-ChildItem -LiteralPath $MafftDst -Recurse -File -Filter "mafft.bat" | Select-Object -First 1
  if (-not $MafftBat) { throw "MAFFT archive did not contain mafft.bat" }
  Write-Info "MAFFT launcher: $($MafftBat.FullName)"
} else {
  Write-Warn "NoMafft: skipping bundled MAFFT"
}

# --- doctor + requirements copy ---
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "doctor.py") -Destination (Join-Path $OutDir "doctor.py") -Force
Copy-Item -LiteralPath $ReqFile -Destination (Join-Path $OutDir "requirements-engine.txt") -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "packaging\THIRD_PARTY_NOTICES.md") -Destination (Join-Path $OutDir "THIRD_PARTY_NOTICES.md") -Force

# empty runs placeholder (engine never writes into install tree by default)
$RunsKeep = Join-Path $OutDir "runs"
New-Item -ItemType Directory -Path $RunsKeep -Force | Out-Null
Set-Content -LiteralPath (Join-Path $RunsKeep ".gitkeep") -Value "" -Encoding ascii

# --- manifest ---
$manifest = [ordered]@{
  product       = "BioinformaticsHUB"
  engine_version = "0.5.2"
  python_version = $PythonVersion
  built_at      = (Get-Date).ToUniversalTime().ToString("o")
  repo_root_src = $RepoRoot
  include_iqtree = (-not $NoIqtree)
  include_mafft = (-not $NoMafft)
  mafft_version = if ($NoMafft) { $null } else { $MafftVersion }
  mafft_sha256 = if ($NoMafft) { $null } else { $MafftSha256 }
  include_playwright = $true
  include_chromium = $true
  notes         = "Website-session engine: local tools plus fixed Playwright Chromium; no HTTP/REST API clients."
}
$manifestPath = Join-Path $OutDir "engine_manifest.json"
$manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8
Write-Info "Wrote $manifestPath"

# --- self-check ---
Write-Info "Run doctor"
& $PythonExe (Join-Path $OutDir "doctor.py")
$doctorCode = $LASTEXITCODE
if ($doctorCode -ne 0) {
  Write-Warn "doctor exited $doctorCode — fix deps before packaging"
  exit $doctorCode
}

Write-Info "Engine ready: $OutDir"
Write-Info "Python: $PythonExe"
exit 0
