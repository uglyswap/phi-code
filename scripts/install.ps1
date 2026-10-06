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
    $InstallDir = (Get-Item -LiteralPath $InstallDir).FullName
    $Exe = Join-Path $InstallDir "phi.exe"
    # A running phi keeps phi.exe and every native module it loaded locked
    # (node_modules\**\*.node, onnxruntime.dll, libvips, native\...): they
    # cannot be overwritten but can be renamed. Each locked file is moved aside
    # as <name>.<id>.phi-old, and leftovers are deleted by the next install once
    # no phi process uses them any more. A bulk Copy-Item stopped at the first
    # locked file and left the install without phi.exe.
    Get-ChildItem -LiteralPath $InstallDir -Recurse -Force -File -Filter "*.phi-old" -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    $LegacyOldExe = Join-Path $InstallDir "phi.exe.old"
    if (Test-Path -LiteralPath $LegacyOldExe) { Remove-Item -LiteralPath $LegacyOldExe -Force -ErrorAction SilentlyContinue }

    $ExtractRoot = (Get-Item -LiteralPath $Extract).FullName.TrimEnd('\')
    # phi.exe last, so an interrupted update never leaves the directory without it.
    $Files = @(Get-ChildItem -LiteralPath $ExtractRoot -Recurse -Force -File |
        Sort-Object { if ($_.FullName -eq (Join-Path $ExtractRoot "phi.exe")) { 1 } else { 0 } })
    foreach ($File in $Files) {
        $Dest = Join-Path $InstallDir $File.FullName.Substring($ExtractRoot.Length + 1)
        [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($Dest)) | Out-Null
        try {
            [System.IO.File]::Copy($File.FullName, $Dest, $true)
        } catch [System.IO.IOException], [System.UnauthorizedAccessException] {
            if (-not [System.IO.File]::Exists($Dest)) { throw }
            $Aside = "$Dest.$([Guid]::NewGuid().ToString('N')).phi-old"
            [System.IO.File]::Move($Dest, $Aside)
            [System.IO.File]::Copy($File.FullName, $Dest, $true)
        }
    }
    # Drop files left by older releases (e.g. the unpruned onnxruntime binaries of
    # previous archives), but only inside the directories this archive ships
    # (node_modules, extensions, theme, ...): top-level files of a shared install
    # directory are never touched. Locked leftovers are moved aside like above.
    $Shipped = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($File in $Files) { [void]$Shipped.Add($File.FullName.Substring($ExtractRoot.Length + 1)) }
    $ShippedDirs = @(Get-ChildItem -LiteralPath $ExtractRoot -Force -Directory | ForEach-Object { $_.Name })
    foreach ($Dir in $ShippedDirs) {
        $Target = Join-Path $InstallDir $Dir
        if (-not (Test-Path -LiteralPath $Target)) { continue }
        Get-ChildItem -LiteralPath $Target -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
            $Relative = $_.FullName.Substring($InstallDir.TrimEnd('\').Length + 1)
            if ($Shipped.Contains($Relative) -or $_.Name -like "*.phi-old") { return }
            try {
                Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
            } catch {
                try { [System.IO.File]::Move($_.FullName, "$($_.FullName).$([Guid]::NewGuid().ToString('N')).phi-old") } catch {}
            }
        }
    }
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
