# scripts/build-runtime.ps1
$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
$projectDir = Resolve-Path "$scriptDir\.."
Set-Location -LiteralPath $projectDir

$bootstrapDir = Join-Path $projectDir "build\runtime-bootstrap"
Write-Host "Construyendo runtime bootstrap en: $bootstrapDir"

# 1. Borrar directorio temporal previo
if (Test-Path $bootstrapDir) {
    Remove-Item -LiteralPath $bootstrapDir -Recurse -Force
}
New-Item -ItemType Directory -Path "$bootstrapDir\python" -Force | Out-Null

# 2. Instalar Python 3.13 portable con uv
Write-Host "Instalando Python 3.13 portable..."
uv python install 3.13 --install-dir "$bootstrapDir\python" --no-bin

# 3. Encontrar python.exe
$pythonItem = Get-ChildItem -Path "$bootstrapDir\python" -Filter "python.exe" -Recurse | Where-Object { $_.FullName -notmatch 'Scripts' } | Select-Object -First 1
if (-not $pythonItem) {
    throw "No se encontró python.exe en $bootstrapDir\python"
}
$pythonExe = $pythonItem.FullName
Write-Host "Python encontrado en: $pythonExe"

# 4. Instalar notebooklm-mcp-cli==0.12.0
Write-Host "Instalando notebooklm-mcp-cli==0.12.0..."
uv pip install --python $pythonExe --break-system-packages --link-mode copy "notebooklm-mcp-cli==0.12.0"

# 5. Copiar nlm_entry.py y nlm_bridge.py
Copy-Item -LiteralPath "$projectDir\scripts\nlm_entry.py" -Destination "$bootstrapDir\nlm_entry.py" -Force
Copy-Item -LiteralPath "$projectDir\scripts\nlm_bridge.py" -Destination "$bootstrapDir\nlm_bridge.py" -Force

# 6. Aplicar parches necesarios
Write-Host "Aplicando patch_cdp.py..."
& $pythonExe "$projectDir\scripts\patch_cdp.py" "$bootstrapDir\python"

# 7. Smoke tests
Write-Host "Ejecutando smoke tests de nlm_entry y nlm_bridge..."
$verOutput = (& $pythonExe "$bootstrapDir\nlm_entry.py" --version) -join "`n"
Write-Host "NLM Version: $verOutput"
if ($verOutput -notmatch '0\.12\.0') {
    throw "La versión de notebooklm-mcp-cli no coincide con 0.12.0: $verOutput"
}

$helpOutput = (& $pythonExe "$bootstrapDir\nlm_bridge.py" --help) -join "`n"
if ($helpOutput -notmatch 'NotebookLM Bridge Extension') {
    throw "nlm_bridge.py fallo el smoke test: $helpOutput"
}


# 8. Generar runtime.json
$cleanBase = $bootstrapDir.TrimEnd('\') + '\'
if ($pythonExe.StartsWith($cleanBase)) {
    $relPython = $pythonExe.Substring($cleanBase.Length).Replace('\', '/')
} else {
    $relPython = $pythonExe.Replace('\', '/')
}
$runtimeConfig = [ordered]@{
    schema = 1
    connectorVersion = "1"
    upstreamNlmVersion = "0.12.0"
    python = $relPython
    nlmEntry = "nlm_entry.py"
    bridge = "nlm_bridge.py"
}
$jsonString = $runtimeConfig | ConvertTo-Json -Depth 5
Set-Content -Path "$bootstrapDir\runtime.json" -Value $jsonString -Encoding utf8


Write-Host "Runtime bootstrap construido exitosamente en $bootstrapDir"
