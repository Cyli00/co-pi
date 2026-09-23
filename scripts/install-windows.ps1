#Requires -Version 7.0
$ErrorActionPreference = 'Stop'

try {
    if (-not (Test-Path -LiteralPath 'C:\Git\bin\bash.exe' -PathType Leaf)) {
        throw '请先将 Git for Windows 安装到 C:\Git，确保 C:\Git\bin\bash.exe 可用。'
    }
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $nodeCommand) {
        throw '请先安装 Node.js ≥ 22.19.0，并加入 PATH。'
    }
    $installer = Join-Path $PSScriptRoot 'install.mjs'
    & $nodeCommand.Source $installer --platform win32 @args
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
