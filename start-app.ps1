$ErrorActionPreference = 'Stop'
$projectDir = $PSScriptRoot
Set-Location -LiteralPath $projectDir
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Instala Node.js 24 y vuelve a ejecutar este archivo.' }
if (-not $env:PORT) { $env:PORT = '4318' }
$appUrl = "http://127.0.0.1:$($env:PORT)"
$appProcess = $null
$existingHealth = $null
try {
    $existingHealth = Invoke-RestMethod -Uri "$appUrl/api/health" -TimeoutSec 1 -UseBasicParsing -ErrorAction SilentlyContinue
} catch {}

if ($existingHealth) {
    Write-Host "La aplicación ya está ejecutándose en $appUrl (Perfil: $($existingHealth.profile))"
    Start-Process $appUrl
    Write-Host 'Puedes cerrar el navegador. Cierra esta ventana o pulsa Ctrl+C para salir.'
    while ($true) { Start-Sleep -Seconds 1 }
}

try {
    $appProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList 'server.mjs' -WorkingDirectory $projectDir -PassThru
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        if ($appProcess.HasExited) { throw 'El servidor no pudo iniciarse. Ejecuta npm start para ver el error; comprueba si el puerto está ocupado.' }
        try {
            $response = Invoke-RestMethod -Uri "$appUrl/api/health" -TimeoutSec 1 -UseBasicParsing -ErrorAction SilentlyContinue
            if ($response -and $response.token) { break }
        } catch {}
    }
    if ($attempt -eq 40) { throw 'El servidor no respondió al iniciar.' }
    Start-Process $appUrl
    Write-Host "Aplicación ejecutándose en $appUrl"
    Write-Host 'Puedes cerrar el navegador. Cierra esta ventana o pulsa Ctrl+C para detener el backend.'
    while (-not $appProcess.HasExited) { Start-Sleep -Seconds 1 }
} finally {
    if ($appProcess -and -not $appProcess.HasExited) {
        try {
            $health = Invoke-RestMethod -Uri "$appUrl/api/health" -TimeoutSec 2 -UseBasicParsing
            Invoke-RestMethod -Method Post -Uri "$appUrl/api/shutdown" -Headers @{ 'X-Local-Token' = $health.token } -TimeoutSec 2 -UseBasicParsing | Out-Null
            $appProcess.WaitForExit(8000) | Out-Null
        } catch {}
        if (-not $appProcess.HasExited) { Stop-Process -Id $appProcess.Id -ErrorAction SilentlyContinue }
    }
}
