$ErrorActionPreference = 'Stop'

$projectPath = $PSScriptRoot
$pidFile = Join-Path $projectPath '.finpub-dev.pid'
$runtimePath = Join-Path $projectPath 'work\runtime'
$stdoutLog = Join-Path $runtimePath 'finpub.stdout.log'
$stderrLog = Join-Path $runtimePath 'finpub.stderr.log'
$viteEntry = Join-Path $projectPath 'node_modules\vite\bin\vite.js'

if (Test-Path -LiteralPath $pidFile) {
    $savedPid = 0
    $pidText = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    if ([int]::TryParse($pidText, [ref]$savedPid)) {
        $existingProcess = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
        $expectedNodePath = (Get-Command node).Source
        if ($existingProcess -and $existingProcess.Path -eq $expectedNodePath) {
            Write-Host "FINPUB is already running (PID $savedPid)." -ForegroundColor Yellow
            Write-Host 'Open http://127.0.0.1:5173/'
            exit 0
        }
    }
    Remove-Item -LiteralPath $pidFile -Force
}

if (-not (Test-Path -LiteralPath $viteEntry)) {
    Write-Host 'Dependencies are missing. Run npm install first.' -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
$arguments = @(
    $viteEntry,
    '--configLoader', 'native',
    '--host', '127.0.0.1',
    '--port', '5173',
    '--strictPort'
)

$serverProcess = Start-Process `
    -FilePath (Get-Command node).Source `
    -ArgumentList $arguments `
    -WorkingDirectory $projectPath `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

Set-Content -LiteralPath $pidFile -Value $serverProcess.Id -Encoding ascii

$ready = $false
for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    Start-Sleep -Milliseconds 250
    if ($serverProcess.HasExited) { break }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5173/' -TimeoutSec 1
        if ($response.StatusCode -eq 200) {
            $ready = $true
            break
        }
    } catch {
        # The server may still be starting.
    }
}

if (-not $ready) {
    if (-not $serverProcess.HasExited) { Stop-Process -Id $serverProcess.Id -Force }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Write-Host 'FINPUB failed to start. Check work\runtime\finpub.stderr.log.' -ForegroundColor Red
    exit 1
}

Write-Host "FINPUB started successfully (PID $($serverProcess.Id))." -ForegroundColor Green
Write-Host 'Open http://127.0.0.1:5173/'
Write-Host 'Logs: work\runtime\finpub.stdout.log and finpub.stderr.log'
