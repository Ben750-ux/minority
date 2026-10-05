$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:TEMP "minority-instances"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$instances = @(
    @{ port = 3001; db = "inst1.db"; label = "Instance 1" },
    @{ port = 3002; db = "inst2.db"; label = "Instance 2" },
    @{ port = 3003; db = "inst3.db"; label = "Instance 3" }
)

foreach ($inst in $instances) {
    $busy = Get-NetTCPConnection -State Listen -LocalPort $inst.port -ErrorAction SilentlyContinue
    if ($busy) {
        Write-Host "Port $($inst.port) deja occupe (PID $($busy.OwningProcess)) - ignore"
        continue
    }

    $env:PORT = $inst.port
    $env:DB_PATH = Join-Path $logDir $inst.db

    Start-Process -FilePath "node.exe" `
        -ArgumentList "server/index.js" `
        -WorkingDirectory $root `
        -RedirectStandardOutput (Join-Path $logDir "$($inst.port).out.log") `
        -RedirectStandardError (Join-Path $logDir "$($inst.port).err.log") `
        -WindowStyle Hidden

    Write-Host "Demarre : $($inst.label) -> http://localhost:$($inst.port)"
}

Remove-Item Env:\PORT -ErrorAction SilentlyContinue
Remove-Item Env:\DB_PATH -ErrorAction SilentlyContinue

Start-Sleep -Seconds 3

Write-Host ""
Write-Host "--- Verification ---"
foreach ($inst in $instances) {
    try {
        $res = Invoke-WebRequest -Uri "http://localhost:$($inst.port)/index.html" -UseBasicParsing -TimeoutSec 5
        Write-Host "$($inst.label) (port $($inst.port)) : HTTP $($res.StatusCode)"
    } catch {
        Write-Host "$($inst.label) (port $($inst.port)) : ECHEC - $($_.Exception.Message)"
    }
}