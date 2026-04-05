param(
  [string]$InstallDir
)

$ErrorActionPreference = 'Stop'

$Repo = 'chenhunghan/mdg'
$BinName = 'mdg.exe'

if (-not $InstallDir) {
  if ($env:LOCALAPPDATA) {
    $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\mdg'
  } else {
    $InstallDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\mdg'
  }
}

$VersionFile = Join-Path $InstallDir '.mdg-version'

function Write-Info {
  param([string]$Message)
  Write-Host $Message
}

function Fail {
  param([string]$Message)
  throw "mdg installer: $Message"
}

function Get-Arch {
  $arch = $env:PROCESSOR_ARCHITECTURE
  if (-not $arch -and $env:PROCESSOR_ARCHITEW6432) {
    $arch = $env:PROCESSOR_ARCHITEW6432
  }

  if (-not $arch) {
    Fail 'could not detect architecture'
  }

  switch ($arch.ToUpperInvariant()) {
    'AMD64' { return 'x64' }
    'ARM64' { return 'arm64' }
    default { Fail "unsupported architecture: $arch" }
  }
}

function Ensure-Path {
  param([string]$PathToAdd)

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @()
  if ($userPath) {
    $parts = $userPath -split ';' | Where-Object { $_ -and $_.Trim() }
  }

  if ($parts -notcontains $PathToAdd) {
    $updated = @($parts + $PathToAdd) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
    Write-Info "Added $PathToAdd to your user PATH."
  }

  if ($env:Path -notlike "*$PathToAdd*") {
    $env:Path = "$PathToAdd;$env:Path"
  }
}

if ($PSVersionTable.PSVersion.Major -lt 6) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

if (-not (Test-Path $InstallDir)) {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
}

$arch = Get-Arch
$release = Invoke-RestMethod -Headers @{ 'User-Agent' = 'mdg-installer' } -Uri "https://api.github.com/repos/$Repo/releases/latest"
$tag = $release.tag_name

if (-not $tag) {
  Fail 'could not determine latest release tag'
}

if ((Test-Path (Join-Path $InstallDir $BinName)) -and (Test-Path $VersionFile)) {
  $currentTag = (Get-Content $VersionFile -Raw).Trim()
  if ($currentTag -eq $tag) {
    Write-Info "mdg $tag is already installed at $(Join-Path $InstallDir $BinName)"
    Ensure-Path $InstallDir
    return
  }
}

$archiveName = "mdg-windows-$arch.zip"
$asset = $release.assets | Where-Object { $_.name -eq $archiveName } | Select-Object -First 1

if (-not $asset) {
  Fail "could not find release asset $archiveName"
}

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
$archivePath = Join-Path $tmpDir $archiveName

New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

try {
  Write-Info "Downloading $tag for windows/$arch..."
  Invoke-WebRequest -Headers @{ 'User-Agent' = 'mdg-installer' } -Uri $asset.browser_download_url -OutFile $archivePath

  Expand-Archive -Path $archivePath -DestinationPath $tmpDir -Force

  $binary = Get-ChildItem -Path $tmpDir -Filter $BinName -Recurse | Select-Object -First 1
  if (-not $binary) {
    Fail "release archive did not contain $BinName"
  }

  Copy-Item -Path $binary.FullName -Destination (Join-Path $InstallDir $BinName) -Force
  Set-Content -Path $VersionFile -Value $tag -NoNewline

  Ensure-Path $InstallDir
  Write-Info "Installed $BinName $tag to $(Join-Path $InstallDir $BinName)"
} finally {
  if (Test-Path $tmpDir) {
    Remove-Item -Path $tmpDir -Recurse -Force
  }
}
