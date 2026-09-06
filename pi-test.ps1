#Requires -Version 5.1
<#
.SYNOPSIS
    Runs the Phi Code test suite on Windows (called by pi-test.bat).
#>
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir
npm run test -- @args
exit $LASTEXITCODE
