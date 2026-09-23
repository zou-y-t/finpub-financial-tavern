$ErrorActionPreference = 'Stop'

$projectPath = $PSScriptRoot
$pidFile = Join-Path $projectPath '.finpub-dev.pid'

if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host 'FINPUB is not running (PID file not found).' -ForegroundColor Yellow
    exit 0
}

$savedPid = 0
$pidText = (Get-Content -LiteralPath $pidFile -Raw).Trim()
if (-not [int]::TryParse($pidText, [ref]$savedPid)) {
    Remove-Item -LiteralPath $pidFile -Force
    Write-Host 'Removed an invalid FINPUB PID file.' -ForegroundColor Yellow
    exit 0
}

$serverProcess = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
if (-not $serverProcess) {
    Remove-Item -LiteralPath $pidFile -Force
    Write-Host 'FINPUB was already stopped; removed the stale PID file.' -ForegroundColor Yellow
    exit 0
}

$expectedNodePath = (Get-Command node).Source
if ($serverProcess.Path -ne $expectedNodePath) {
    Write-Host "Refusing to stop PID $savedPid because it is not the managed Node process." -ForegroundColor Red
    exit 1
}

Stop-Process -Id $savedPid -Force
Remove-Item -LiteralPath $pidFile -Force
Write-Host "FINPUB stopped successfully (PID $savedPid)." -ForegroundColor Green
