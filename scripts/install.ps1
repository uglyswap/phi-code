#Requires -Version 5.1
<#
.SYNOPSIS
    Install Phi Code standalone binary on Windows.
    irm https://raw.githubusercontent.com/uglyswap/phi-code/main/scripts/install.ps1 | iex
.DESCRIPTION
    Options (environment variables):
      PHI_VERSION      release to install (default: latest)
      PHI_INSTALL_DIR  install directory (default: %LOCALAPPDATA%\Programs\phi)

    phi.exe reads package.json, theme\, export-html\, assets\ and the native
    helpers from its own directory: without package.json it falls back to the
    upstream identity (name "pi", config dir ~/.pi, version 0.0.0). The whole
    archive is therefore installed, and the download is verified against the
    release SHA256SUMS before anything is copied.
#>
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# Windows PowerShell 5.1 may default to TLS 1.0, which GitHub rejects.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = "uglyswap/phi-code"
$InstallDir = if ($env:PHI_INSTALL_DIR) { $env:PHI_INSTALL_DIR } else { "$env:LOCALAPPDATA\Programs\phi" }
$Arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") { "arm64" } else { "x64" }
$Asset = "phi-windows-$Arch.zip"
$BaseUrl = if ($env:PHI_VERSION -and $env:PHI_VERSION -ne "latest") {
    "https://github.com/$Repo/releases/download/v$($env:PHI_VERSION.TrimStart('v'))"
} else {
    "https://github.com/$Repo/releases/latest/download"
}

$Tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("phi-install-" + [Guid]::NewGuid()))
try {
    $Zip = Join-Path $Tmp $Asset
    $Sums = Join-Path $Tmp "SHA256SUMS"
    Write-Host "Downloading $BaseUrl/$Asset"
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$Asset" -OutFile $Zip
    # The release workflow publishes one SHA256SUMS file covering every asset.
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/SHA256SUMS" -OutFile $Sums

    $Expected = $null
    foreach ($Line in Get-Content -Path $Sums) {
        $Parts = $Line.Trim() -split '\s+', 2
        if ($Parts.Count -eq 2 -and $Parts[1].TrimStart('*') -eq $Asset) { $Expected = $Parts[0].ToLowerInvariant(); break }
    }
    if (-not $Expected) { throw "SHA256SUMS has no entry for $Asset" }
    $Actual = (Get-FileHash -Algorithm SHA256 -Path $Zip).Hash.ToLowerInvariant()
    if ($Actual -ne $Expected) { throw "Checksum mismatch for ${Asset}: expected $Expected, got $Actual" }
    Write-Host "Checksum verified"

    $Extract = Join-Path $Tmp "extract"
    Expand-Archive -Path $Zip -DestinationPath $Extract -Force
    # Windows archives hold the release files at the root of the zip.
    if (-not (Test-Path (Join-Path $Extract "phi.exe"))) { throw "Archive did not contain phi.exe" }
    if (-not (Test-Path (Join-Path $Extract "package.json"))) { throw "Archive did not contain package.json" }

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    # A running phi.exe cannot be overwritten but can be renamed: move it aside.
    $Exe = Join-Path $InstallDir "phi.exe"
    $OldExe = Join-Path $InstallDir "phi.exe.old"
    if (Test-Path $OldExe) { Remove-Item -Force $OldExe -ErrorAction SilentlyContinue }
    if (Test-Path $Exe) { Move-Item -Force $Exe $OldExe }
    Copy-Item -Path (Join-Path $Extract "*") -Destination $InstallDir -Recurse -Force
    if (Test-Path $OldExe) { Remove-Item -Force $OldExe -ErrorAction SilentlyContinue }
    Write-Host "Installed phi to $InstallDir"

    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $PathEntries = if ($UserPath) { $UserPath -split ';' } else { @() }
    if ($PathEntries -notcontains $InstallDir) {
        $NewPath = if ($UserPath) { "$UserPath;$InstallDir" } else { $InstallDir }
        [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
        Write-Host "Added $InstallDir to user PATH (restart your terminal)"
    }
    & $Exe --version
} finally {
    Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
