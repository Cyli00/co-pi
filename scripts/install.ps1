#Requires -Version 7.0
$ErrorActionPreference = 'Stop'

try {
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $nodeCommand) {
        throw '请先安装 Node.js ≥ 22.19.0，并加入 PATH。'
    }
    $installer = Join-Path $PSScriptRoot 'install.mjs'
    & $nodeCommand.Source $installer @args
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
