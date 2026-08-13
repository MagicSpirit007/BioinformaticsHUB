#Requires -Version 5.1
<#
.SYNOPSIS
  Install the external tools BioinformaticsHUB needs for local analysis and the
  Plant-mPLoc auto-submit site. These are NOT bundled with the installer.

.DESCRIPTION
  - Detects a system Python (prefers the `py` launcher, then `python`).
  - Installs the Python packages from requirements-engine.txt.
  - Installs Playwright Chromium (used by the auto-submit site).
  - Reports whether MAFFT and IQ-TREE are already on PATH, and prints manual
    install guidance when they are not.

.EXAMPLE
  .\install_tools.ps1
  .\install_tools.ps1 -SkipChromium   # only Python deps, no browser download
#>
param(
  [string]$PipIndexUrl = "https://pypi.org/simple",
  [switch]$SkipChromium
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ReqFile = Join-Path $Here "requirements-engine.txt"

function Write-Info([string]$msg) { Write-Host "[install-tools] $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "[install-tools] $msg" -ForegroundColor Yellow }

function Find-Python {
  if ($env:BIOINFORMATICS_HUB_PYTHON -and (Test-Path $env:BIOINFORMATICS_HUB_PYTHON)) {
    return $env:BIOINFORMATICS_HUB_PYTHON
  }
  foreach ($candidate in @("py", "python", "python3")) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  return $null
}

$Python = Find-Python
if (-not $Python) {
  Write-Warn "No system Python found. Install Python 3.10+ from https://www.python.org/downloads/ and re-run this script."
  Write-Warn "Tick 'Add Python to PATH' during installation."
  exit 1
}
Write-Info "Python: $Python"
& $Python --version

if (-not (Test-Path $ReqFile)) {
  Write-Warn "requirements-engine.txt not found next to this script ($ReqFile)."
  exit 1
}

Write-Info "Install Python dependencies from requirements-engine.txt"
& $Python -m pip install --upgrade pip --index-url $PipIndexUrl
if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed" }
& $Python -m pip install -r $ReqFile --index-url $PipIndexUrl
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

if (-not $SkipChromium) {
  Write-Info "Install Playwright Chromium (for the Plant-mPLoc auto-submit site)"
  & $Python -m playwright install chromium
  if ($LASTEXITCODE -ne 0) {
    Write-Warn "Chromium install failed; Plant-mPLoc will fall back to manual open."
  }
} else {
  Write-Info "SkipChromium — Plant-mPLoc will open manually."
}

Write-Info ""
Write-Info "Checking optional command-line tools (auto-detected on PATH):"
$mafft = Get-Command mafft -ErrorAction SilentlyContinue
if ($mafft) {
  Write-Info "  MAFFT   : found at $($mafft.Source)"
} else {
  Write-Warn "  MAFFT   : not on PATH. Download the Windows package from https://mafft.cbrc.jp/alignment/software/ and add it to PATH."
}
$iqtree = Get-Command iqtree2 -ErrorAction SilentlyContinue
if (-not $iqtree) { $iqtree = Get-Command iqtree -ErrorAction SilentlyContinue }
if ($iqtree) {
  Write-Info "  IQ-TREE : found at $($iqtree.Source)"
} else {
  Write-Warn "  IQ-TREE : not on PATH. Download IQ-TREE 2 from http://www.iqtree.org/ and add it to PATH."
}

Write-Info ""
Write-Info "Done. Restart BioinformaticsHUB to refresh tool detection."
