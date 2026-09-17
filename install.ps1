<# Overcode Windows Installer
#
# Run from PowerShell:
#   irm https://raw.githubusercontent.com/ConnorSawaya/overcode/overcode-rebrand/install.ps1 | iex
#
# Options:
#   -Version <version>    Install a specific version (e.g. 1.0.180)
#   -Binary <path>        Install from a local binary instead of downloading
#   -NoModifyPath         Don't add the install directory to the user PATH
#   -InstallDir <path>    Override the install directory (default: $HOME\.overcode\bin)
#
# After installing, open a NEW terminal and type:
#   overcode        # fullscreen TUI
#   overcode cli    # plain-terminal CLI (works in any console)
#>
param(
  [string]$Version = $env:VERSION,
  [string]$Binary = "",
  [switch]$NoModifyPath,
  [string]$InstallDir = (Join-Path $HOME ".overcode\bin"),
  [switch]$Help
)

$App = "overcode"
$Repo = "ConnorSawaya/overcode"

if ($Help) {
  Get-Help $PSCommandPath -Detailed
  exit 0
}

function Fail([string]$Message) {
  Write-Host "Error: $Message" -ForegroundColor Red
  exit 1
}

function Info([string]$Message) {
  Write-Host $Message
}

# --- Resolve version ---------------------------------------------------------
$SpecificVersion = $null
$ZipUrl = $null

if ($Binary -ne "") {
  if (-not (Test-Path $Binary -PathType Leaf)) {
    Fail "Binary not found at $Binary"
  }
  $SpecificVersion = "local"
} else {
  # --- Detect architecture ---------------------------------------------------
  $Arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" { "x64" }
    "ARM64" { "arm64" }
    default { Fail "Unsupported architecture: $($env:PROCESSOR_ARCHITECTURE)" }
  }

  # --- Detect AVX2 on x64 (baseline fallback) --------------------------------
  $NeedsBaseline = $false
  if ($Arch -eq "x64") {
    try {
      $Avx2 = Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);' -Name Kernel32Avx2 -Namespace Win32 -PassThru
      if (-not $Avx2::IsProcessorFeaturePresent(40)) {
        $NeedsBaseline = $true
      }
    } catch {
      # If detection fails, prefer the broadly-compatible baseline binary.
      $NeedsBaseline = $true
    }
  }

  $Target = "windows-$Arch"
  if ($NeedsBaseline) {
    $Target = "$Target-baseline"
  }
  $FileName = "$App-$Target.zip"

  if ([string]::IsNullOrWhiteSpace($Version)) {
    try {
      $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing
      $SpecificVersion = ($Release.tag_name -replace '^v', '')
      if ([string]::IsNullOrWhiteSpace($SpecificVersion)) {
        Fail "Failed to fetch version information"
      }
    } catch {
      Fail "Failed to fetch version information: $($_.Exception.Message)"
    }
    $ZipUrl = "https://github.com/$Repo/releases/latest/download/$FileName"
  } else {
    $SpecificVersion = $Version -replace '^v', ''
    $ZipUrl = "https://github.com/$Repo/releases/download/v$SpecificVersion/$FileName"
  }
}

# --- Skip if the requested version is already installed ----------------------
$Existing = Get-Command $App -ErrorAction SilentlyContinue
if ($null -ne $Existing -and $SpecificVersion -ne "local") {
  try {
    $Installed = (& $App --version 2>$null).Trim()
    if ($Installed -eq $SpecificVersion) {
      Info "Version $SpecificVersion already installed."
      exit 0
    }
    if ($Installed -ne "") {
      Info "Installed version: $Installed."
    }
  } catch {
    # Fall through to a fresh install.
  }
}

# --- Install -----------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$Destination = Join-Path $InstallDir "overcode.exe"

if ($SpecificVersion -eq "local") {
  Info "Installing $App from: $Binary"
  Copy-Item -Force $Binary $Destination
} else {
  Info "Installing $App version: $SpecificVersion"
  $TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("overcode_install_" + [System.IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
  try {
    $ZipPath = Join-Path $TempDir $FileName
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $ZipUrl -OutFile $ZipPath -UseBasicParsing
    Expand-Archive -Path $ZipPath -DestinationPath $TempDir -Force
    $Extracted = Join-Path $TempDir "overcode.exe"
    if (-not (Test-Path $Extracted -PathType Leaf)) {
      Fail "Downloaded archive did not contain overcode.exe ($ZipUrl)"
    }
    Move-Item -Force $Extracted $Destination
  } catch {
    Fail $_.Exception.Message
  } finally {
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
  }
}

# --- Smoke test ---------------------------------------------------------------
try {
  $Smoke = & $Destination --version 2>$null
  if ($LASTEXITCODE -ne 0) {
    Fail "Installed binary failed to run (exit code $LASTEXITCODE)"
  }
  Info "overcode $Smoke installed to $Destination"
} catch {
  Fail "Installed binary failed to run: $($_.Exception.Message)"
}

# --- PATH ---------------------------------------------------------------------
function Test-OnPath([string]$Dir) {
  return ($env:Path -split ";" | Where-Object { $_ -ne "" }) -contains $Dir
}

if (-not (Test-OnPath $InstallDir)) {
  if ($NoModifyPath) {
    Write-Host "Add to PATH manually: $InstallDir" -ForegroundColor Yellow
  } else {
    try {
      $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
      if ([string]::IsNullOrEmpty($UserPath)) {
        $UserPath = ""
      }
      if (($UserPath -split ";" | Where-Object { $_ -ne "" }) -notcontains $InstallDir) {
        [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
      }
      $env:Path = "$env:Path;$InstallDir"
      Info "Added $InstallDir to the user PATH. Open a NEW terminal to use it."
    } catch {
      Write-Host "Could not update PATH automatically: $($_.Exception.Message)" -ForegroundColor Yellow
      Write-Host "Add to PATH manually: $InstallDir" -ForegroundColor Yellow
    }
  }
}

Write-Host ""
Write-Host "                   " -NoNewline; Write-Host "             _     "
Write-Host "overcode installed. To start:" -ForegroundColor Green
Write-Host ""
Write-Host "  cd <project>  # open directory"
Write-Host "  overcode      # fullscreen TUI"
Write-Host "  overcode cli  # plain-terminal CLI"
Write-Host ""
