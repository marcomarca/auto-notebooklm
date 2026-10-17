param([ValidateSet('Development','Distribution')][string]$Mode = 'Development')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
try {
    $nodePath = Join-Path $PSScriptRoot 'runtime\node.exe'
    if (-not (Test-Path -LiteralPath $nodePath)) {
        $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
        if (-not $nodeCommand) { throw 'Instala Node.js 24 o utiliza la distribucion que incluye runtime\node.exe.' }
        $nodePath = $nodeCommand.Source
    }
    $launchMode = if ($Mode -eq 'Development') { '--dev' } else { '--distribution' }
    & $nodePath (Join-Path $PSScriptRoot 'scripts\launch.mjs') $launchMode
    if ($LASTEXITCODE -ne 0) { throw "BloqueAudio termino con codigo $LASTEXITCODE. Revisa el error mostrado arriba." }
} catch {
    Write-Host "BloqueAudio no pudo iniciarse: $($_.Exception.Message)" -ForegroundColor Red
    if ($env:BLOQUEAUDIO_NO_BROWSER -ne '1') { Read-Host 'Pulsa Enter para cerrar' | Out-Null }
    exit 1
}
