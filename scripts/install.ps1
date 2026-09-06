#Requires -Version 5.1
<#
.SYNOPSIS
    Install Phi Code standalone binary on Windows.
    irm https://raw.githubusercontent.com/uglyswap/phi-code/main/scripts/install.ps1 | iex
#>
$ErrorActionPreference = "Stop"

$Repo = "uglyswap/phi-code"
$InstallDir = if ($env:PHI_INSTALL_DIR) { $env:PHI_INSTALL_DIR } else { "$env:LOCALAPPDATA\Programs\phi" }
$Arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") { "arm64" } else { "x64" }
$Asset = "phi-windows-$Arch.zip"
$Url = "https://github.com/$Repo/releases/latest/download/$Asset"

$Tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("phi-install-" + [Guid]::NewGuid()))
try {
    Write-Host "Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile (Join-Path $Tmp "phi.zip")
    Expand-Archive -Path (Join-Path $Tmp "phi.zip") -DestinationPath $Tmp -Force
    $Bin = Get-ChildItem -Path $Tmp -Recurse -Filter "phi.exe" | Select-Object -First 1
    if (-not $Bin) { throw "Archive did not contain phi.exe" }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Copy-Item $Bin.FullName (Join-Path $InstallDir "phi.exe")
    Write-Host "Installed phi to $InstallDir\phi.exe"
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($UserPath -notlike "*$InstallDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
        Write-Host "Added $InstallDir to user PATH (restart your terminal)"
    }
} finally {
    Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
