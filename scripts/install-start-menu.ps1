$ErrorActionPreference='Stop'
$projectDir=Split-Path -Parent $PSScriptRoot
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:exe /codepage:65001 "/win32icon:$(Join-Path $projectDir 'public\icon.ico')" "/out:$(Join-Path $projectDir 'BloqueAudioDev.exe')" (Join-Path $PSScriptRoot 'dev-launcher.cs')
if($LASTEXITCODE -ne 0){throw 'No se pudo compilar el acceso de desarrollo.'}
$programs=[Environment]::GetFolderPath('Programs')
$links=New-Object -ComObject WScript.Shell
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ShellRefresh { [DllImport("shell32.dll", CharSet=CharSet.Unicode)] public static extern void SHChangeNotify(uint e,uint f,string a,string b); }'
foreach($entry in @(@('BloqueAudio', (Join-Path $projectDir 'BloqueAudioDev.exe')), @('BloqueAudio (distribucion)',(Join-Path $projectDir 'dist\win-unpacked\BloqueAudio.exe')))) {
    if(-not(Test-Path -LiteralPath $entry[1])){throw "No existe $($entry[1])"}
    $shortcut=$links.CreateShortcut((Join-Path $programs ($entry[0]+'.lnk')))
    $shortcut.TargetPath=$entry[1];$shortcut.WorkingDirectory=$projectDir
    $shortcut.IconLocation=(Join-Path $projectDir 'public\icon.ico')+',0'
    $shortcut.Description=if($entry[0] -eq 'BloqueAudio'){'BloqueAudio - desarrollo desde D:\apps-2026\auto-notebooklm'}else{'BloqueAudio - distribucion 1.1.1'}
    $shortcut.Save()
    [ShellRefresh]::SHChangeNotify(2,5,(Join-Path $programs ($entry[0]+'.lnk')),$null)
}
[ShellRefresh]::SHChangeNotify(0x08000000,0,$null,$null)
$installed=Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object DisplayName -match '^BloqueAudio(?:\s|$)' | Select-Object -First 1
$installedExe=if($installed.InstallLocation){Join-Path $installed.InstallLocation 'BloqueAudio.exe'}elseif($installed.DisplayIcon){($installed.DisplayIcon -replace ',\d+$','').Trim('"')}else{$null}
if($installedExe -and (Test-Path -LiteralPath $installedExe)){$env:BLOQUEAUDIO_INSTALLED_EXE=$installedExe}
$registration=Start-Process -FilePath (Join-Path $projectDir 'node_modules\electron\dist\electron.exe') -ArgumentList ('"'+(Join-Path $PSScriptRoot 'register-menu.cjs')+'"') -WindowStyle Hidden -Wait -PassThru
if($registration.ExitCode -ne 0){throw 'Fallo el registro nativo de accesos de Windows.'}
Write-Host "Accesos actualizados en $programs"
