# ESPECIFICACIÓN DE IMPLEMENTACIÓN — AutoNotebookLM Desktop/Electron

## 0. Objetivo y restricciones no negociables

Debes convertir el proyecto existente `auto-notebooklm` en una aplicación Windows instalable mediante:

```text
AutoNotebookLM-Setup-X.Y.Z.exe
```

La aplicación debe:

```text
- funcionar como aplicación Electron
- NO abrir Chrome para mostrar la interfaz principal
- mantener el backend Node actual
- mantener HTML/CSS/JS actual
- mantener SQLite actual
- mantener la API HTTP local actual
- incluir FFmpeg
- terminar incluyendo el runtime Python/NotebookLM
- instalar por usuario, sin requerir permisos de administrador
- actualizarse automáticamente
- descargar actualizaciones diferenciales siempre que sea posible
- conservar data, perfiles, colas y audios entre versiones
- permitir actualizaciones independientes del conector NotebookLM
```

No debes:

```text
- migrar a Tauri
- migrar a React
- migrar a TypeScript
- reescribir el backend en Rust
- sustituir SQLite
- eliminar la API HTTP local
- cambiar la lógica funcional de Queue
- cambiar contratos de Provider salvo lo necesario para resolver rutas/runtime
- introducir un framework frontend
- almacenar data dentro de Program Files
- almacenar data dentro de app.asar
- descargar automáticamente la última versión de notebooklm-mcp-cli desde PyPI
- actualizar el conector sin haber sido previamente validado y empaquetado por nosotros
```

El proyecto debe continuar usando ESM (`"type": "module"`).

---

# 1. Versiones exactas iniciales

Modificar `package.json`.

Instalar exactamente:

```powershell
npm install --save-dev --save-exact electron@44.7.0
npm install --save-dev --save-exact electron-builder@26.17.0
npm install --save --save-exact electron-updater@6.8.10
```

Electron 44.7.0 incluye Node 24.21.0, así que `node:sqlite` y el requisito actual de Node 24 pueden mantenerse. [Electron Releases](https://releases.electronjs.org/release/v44.7.0)

No usar:

```text
electron 45 alpha
electron-builder 27 alpha
electron-updater 7 alpha
```

Después de instalar dependencias:

```powershell
npm install
npm test
```

Generar y conservar:

```text
package-lock.json
```

---

# 2. Estructura final que debes crear

Añadir:

```text
electron/
    main.mjs
    preload.cjs
    paths.mjs
    updater.mjs
    component-manager.mjs
    logger.mjs

build/
    icon.ico

runtime/
    bootstrap/
        ... generado, NO escrito a mano ...

scripts/
    build-runtime.ps1
    nlm_entry.py

electron-builder.yml

.github/
    workflows/
        release.yml
```

Conservar:

```text
accounts.mjs
provider.mjs
queue.mjs
server.mjs
store.mjs

public/
scripts/nlm_bridge.py
tests/
```

Los antiguos:

```text
start-app.bat
start-app.ps1
```

pueden mantenerse sólo como método legacy durante desarrollo, pero **no son necesarios para el usuario del `.exe`**.

---

# 3. Cambiar package.json

Debe quedar conceptualmente así:

```json
{
  "name": "auto-notebooklm",
  "productName": "AutoNotebookLM",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "electron/main.mjs",
  "engines": {
    "node": ">=24.0.0 <25"
  },
  "scripts": {
    "start": "node server.mjs",
    "desktop": "electron .",
    "test": "node --test tests/*.test.mjs",
    "test:live": "node scripts/live-check.mjs",
    "pack:win": "electron-builder --win dir --x64",
    "dist:win": "electron-builder --win nsis --x64",
    "release:win": "electron-builder --win nsis --x64 --publish always"
  }
}
```

No eliminar `"start"` porque el backend debe seguir pudiendo ejecutarse independientemente para pruebas.

---

# 4. Separar código de datos ANTES de empaquetar

Este paso es obligatorio antes de hacer el instalador.

Actualmente `server.mjs` usa por defecto:

```text
./data
./exports
```

Eso NO debe ocurrir cuando la aplicación esté instalada.

En Electron usar:

```text
dataDir:
%APPDATA%\AutoNotebookLM\data

exportsDir:
%USERPROFILE%\Documents\AutoNotebookLM\exports

logs:
%APPDATA%\AutoNotebookLM\logs

mutable runtime:
%LOCALAPPDATA%\AutoNotebookLM\runtime
```

Crear `electron/paths.mjs`.

Debe exportar una función que produzca:

```js
{
  dataDir,
  exportsDir,
  logsDir,
  runtimeDir
}
```

Usar `app.getPath('userData')` y `app.getPath('documents')` donde corresponda. Electron proporciona específicamente `app.getPath()` para este tipo de almacenamiento persistente. [Electron](https://www.electronjs.org/docs/latest/api/app?query=show\&utm_source=chatgpt.com)

Nunca usar:

```text
process.cwd()
__dirname/data
resources/data
app.asar/data
```

para datos del usuario.

---

# 5. NO modificar server.mjs más de lo necesario

`server.mjs` ya tiene una API adecuada:

```js
makeApp({
  dataDir,
  exportsDir,
  provider,
  port,
  worker,
  check
})
```

y devuelve:

```js
{
  server,
  store,
  queue,
  provider,
  accounts,
  origin,
  token,
  close
}
```

Aprovéchalo.

No reescribas el servidor.

Haz únicamente estos cambios:

```text
1. añadir opción allowHttpShutdown=true
2. cuando Electron invoque makeApp(), pasar allowHttpShutdown=false
3. conservar true como default para npm start y pruebas
```

Actualmente existe:

```text
POST /api/shutdown
```

En modo Electron no debe poder dejar la ventana viva con el backend apagado.

---

# 6. Puerto HTTP

No cargues `file://public/index.html`.

Debes conservar el servidor HTTP porque toda la interfaz ya está diseñada para esa API.

Electron hará:

```text
BrowserWindow
    ↓
http://127.0.0.1:<puerto>
    ↓
server.mjs
```

Intenta primero:

```text
4318
```

Si `4318` está ocupado por otro proceso, vuelve a intentar con:

```js
port: 0
```

para que Windows asigne uno libre.

Después utiliza:

```js
backend.origin
```

para cargar la ventana.

---

# 7. Crear electron/main.mjs

Responsabilidades exactas:

```text
1. impedir dos instancias Electron
2. esperar app.whenReady()
3. resolver directorios persistentes
4. resolver runtime
5. construir Provider
6. iniciar makeApp()
7. crear BrowserWindow
8. cargar backend.origin
9. iniciar updater
10. cerrar backend correctamente al salir
```

Usar:

```js
app.requestSingleInstanceLock()
```

Si ya existe una instancia:

```text
- no iniciar otro backend
- enfocar/restaurar la ventana existente
- terminar la segunda instancia
```

### BrowserWindow

Configuración obligatoria:

```js
webPreferences: {
  preload: preloadPath,
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true
}
```

No habilitar `nodeIntegration`.

No exponer `require()` al frontend.

No desactivar `webSecurity`.

Bloquear navegación externa desde la ventana:

```text
will-navigate → cancelar destinos distintos de backend.origin
setWindowOpenHandler → deny
```

---

# 8. Cierre de aplicación

Debe existir una sola rutina:

```js
async function closeBackend()
```

que llame exactamente una vez:

```js
await backend.close()
```

No usar:

```js
process.exit()
```

antes de cerrar el backend.

El cierre normal debe:

```text
BrowserWindow close
    ↓
app quit
    ↓
queue.stop()
    ↓
cerrar procesos Python/nlm/FFmpeg
    ↓
cerrar HTTP
    ↓
cerrar SQLite
    ↓
eliminar .running
    ↓
terminar Electron
```

El `Queue.stop()` y `Provider.close()` actuales ya proporcionan buena parte de esta lógica.

---

# 9. Corregir Provider para soportar runtime empaquetado

Éste es un cambio importante.

Actualmente `Provider` asume:

```js
nlm = "nlm"
ffmpeg = "ffmpeg"
python = "%APPDATA%\\uv\\..."
bridgeScript = "./scripts/nlm_bridge.py"
```

Eso no funciona correctamente dentro de una aplicación instalada.

Modificar `Provider` para aceptar:

```js
{
  profile,
  nlmBinary,
  nlmPrefixArgs,
  python,
  bridgeScript,
  ffmpeg
}
```

`cli(args)` debe ejecutar:

```js
runner.run(
    nlmBinary,
    [...nlmPrefixArgs, ...args],
    ...
)
```

En desarrollo puede seguir siendo:

```text
nlmBinary = "nlm"
nlmPrefixArgs = []
```

En producción será:

```text
nlmBinary = python.exe
nlmPrefixArgs = [nlm_entry.py]
```

Por tanto:

```text
python.exe nlm_entry.py notebook list ...
```

equivale a:

```text
nlm notebook list ...
```

Crear:

```text
scripts/nlm_entry.py
```

con:

```python
from notebooklm_tools.cli.main import cli_main

if __name__ == "__main__":
    cli_main()
```

El proyecto `notebooklm-mcp-cli` define precisamente su comando `nlm` sobre `notebooklm_tools.cli.main:cli_main`. [GitHub](https://github.com/jacob-bd/gemini-notebook-mcp-cli/blob/main/pyproject.toml?utm_source=chatgpt.com)

---

# 10. Corregir Accounts

Actualmente `accounts.mjs` crea providers secundarios así:

```js
new Provider({
  profile,
  nlm: primary.nlm,
  ffmpeg: primary.ffmpeg
})
```

Eso pierde:

```text
python
bridgeScript
runtime arguments
```

No dejarlo así.

Añadir en `Provider`:

```js
forProfile(profile)
```

que construya otro Provider reutilizando exactamente:

```text
nlmBinary
nlmPrefixArgs
python
bridgeScript
ffmpeg
```

Entonces `Accounts` usará:

```js
this.factory = factory || (profile => primary.forProfile(profile))
```

Esto evita que `cuenta2`, `cuenta3`, etc. terminen intentando utilizar Python global.

---

# 11. nlm_bridge.py NO puede permanecer dentro de app.asar

El proceso Python externo no entiende rutas internas de:

```text
app.asar
```

El bridge debe estar físicamente en disco.

Empaquetarlo como recurso externo mediante `extraResources`.

Electron-builder recomienda precisamente `extraResources` para CLI, binarios y recursos que necesitan ejecutarse fuera de ASAR; en runtime se localizan mediante `process.resourcesPath`. [Electron Builder](https://www.electron.build/docs/contents/?utm_source=chatgpt.com)

---

# 12. Eliminar la ruta absoluta de patch_cdp.py

Actualmente existe una ruta similar a:

```text
C:\Users\Rescate\AppData\Roaming\uv\tools\...
```

Está prohibido dejarla así.

`patch_cdp.py` debe hacer una de dos cosas:

```text
A. eliminarse si ya no es necesario

o

B. convertirse en un parche de BUILD que reciba como argumento la ruta
   del runtime staged
```

Nunca debe parchear el Python global del usuario.

Nunca debe contener:

```text
C:\Users\<usuario>\
```

---

# 13. Construir un Python privado

El usuario final NO debe tener que instalar Python ni `uv`.

Para construir el runtime utiliza `uv` únicamente en CI/build.

`uv` puede instalar distribuciones Python portables basadas en `python-build-standalone`. [Astral Docs](https://docs.astral.sh/uv/guides/install-python/?utm_source=chatgpt.com)

Crear:

```text
scripts/build-runtime.ps1
```

Su trabajo será:

```text
1. borrar build/runtime-bootstrap temporal
2. instalar Python 3.13 portable mediante uv
3. encontrar python.exe
4. instalar notebooklm-mcp-cli==0.12.0 en ese Python
5. copiar nlm_entry.py
6. copiar nlm_bridge.py
7. aplicar parches que todavía sean necesarios
8. ejecutar smoke tests
9. generar runtime.json
```

Usar conceptualmente:

```powershell
uv python install 3.13 --install-dir build\runtime-bootstrap\python --no-bin

$python = uv python find 3.13 --install-dir build\runtime-bootstrap\python

uv pip install `
    --python $python `
    --link-mode copy `
    "notebooklm-mcp-cli==0.12.0"
```

`uv pip --python` puede instalar directamente dentro de un intérprete arbitrario. [Astral Docs](https://docs.astral.sh/uv/pip/environments/?utm_source=chatgpt.com)

No instalar automáticamente `notebooklm-mcp-cli@latest`.

La aplicación actual ha sido escrita y comprobada para:

```text
0.12.0
```

aunque upstream haya seguido publicando versiones posteriores. Por tanto las actualizaciones del conector deberán pasar primero por nuestro pipeline de compatibilidad.

---

# 14. runtime.json

El build de runtime debe generar algo como:

```json
{
  "schema": 1,
  "connectorVersion": "1",
  "upstreamNlmVersion": "0.12.0",
  "python": "python/cpython-3.13.x-windows-x86_64-none/python.exe",
  "nlmEntry": "nlm_entry.py",
  "bridge": "nlm_bridge.py"
}
```

No codifiques el nombre completo del directorio Python en `electron/main.mjs`.

Debe leerse desde `runtime.json`.

---

# 15. FFmpeg

El usuario tampoco debe depender de un FFmpeg global.

La distribución debe contener:

```text
resources/
    ffmpeg/
        ffmpeg.exe
```

`Provider.ffmpeg` debe apuntar a esa ruta en producción.

En desarrollo puede seguir utilizando:

```text
FFMPEG_BINARY
```

o:

```text
ffmpeg
```

Debes comprobar durante el build:

```powershell
ffmpeg.exe -version
```

y ejecutar una conversión MP3 con `libmp3lame`, porque el proyecto depende de ese encoder.

No sustituirlo por una build sin `libmp3lame`.

---

# 16. Component Manager para actualizaciones frecuentes

No actualizar Python/NLM sustituyendo archivos dentro de `Program Files`.

En primer lanzamiento copiar el runtime bootstrap hacia:

```text
%LOCALAPPDATA%\AutoNotebookLM\runtime\connector\
```

Estructura:

```text
connector/
    1/
        runtime.json
        python/
        nlm_entry.py
        nlm_bridge.py

    2/
        ...

    state.json
```

`state.json`:

```json
{
  "active": "1",
  "previous": null,
  "pending": null
}
```

La aplicación siempre ejecutará el runtime señalado por:

```text
active
```

Nunca desde `resources/runtime-bootstrap` directamente después del bootstrap inicial.

---

# 17. Actualizador independiente del conector

Esto es obligatorio porque NotebookLM es la parte más propensa a romperse.

No consultar PyPI desde la aplicación.

La aplicación consultará únicamente nuestro repositorio de releases del runtime.

Usar un repositorio público independiente:

```text
OWNER/auto-notebooklm-runtime
```

Cada release contendrá:

```text
connector-latest.json
connector-latest.json.sig
connector-win-x64-<version>.zip
```

`connector-latest.json`:

```json
{
  "schema": 1,
  "version": "2",
  "upstreamNlmVersion": "0.12.0",
  "compatibleAppMajor": 1,
  "platform": "win32",
  "arch": "x64",
  "url": "https://github.com/OWNER/auto-notebooklm-runtime/releases/download/connector-v2/connector-win-x64-2.zip",
  "sha256": "..."
}
```

No activar inmediatamente un runtime descargado.

Proceso obligatorio:

```text
descargar manifest
       ↓
verificar firma Ed25519
       ↓
descargar ZIP
       ↓
verificar SHA-256
       ↓
extraer a carpeta temporal
       ↓
validar runtime.json
       ↓
ejecutar python nlm_entry.py --version
       ↓
ejecutar python nlm_bridge.py --help
       ↓
mover a connector/<version>
       ↓
state.pending=<version>
       ↓
reiniciar aplicación
       ↓
activar
```

No hacer hot-swap mientras Queue esté viva.

---

# 18. Rollback del conector

Antes de activar:

```text
previous = active
active = pending
pending = null
```

Si el runtime nuevo no pasa las comprobaciones al arrancar:

```text
active = previous
previous = versión fallida
```

y volver a iniciar utilizando el anterior.

No borrar inmediatamente la versión anterior.

Mantener como mínimo:

```text
active
previous
```

y eliminar versiones más antiguas posteriormente.

---

# 19. Configuración electron-builder

Crear:

```text
electron-builder.yml
```

Base:

```yaml
appId: com.autonotebooklm.desktop
productName: AutoNotebookLM

asar: true

files:
  - "**/*"
  - "!runtime/**"
  - "!build/runtime-bootstrap/**"
  - "!dist/**"

extraResources:
  - from: "build/runtime-bootstrap"
    to: "runtime-bootstrap"

  - from: "vendor/ffmpeg"
    to: "ffmpeg"

win:
  target:
    - target: nsis
      arch:
        - x64

nsis:
  oneClick: true
  perMachine: false
  deleteAppDataOnUninstall: false
  differentialPackage: "store-asar"
  artifactName: "AutoNotebookLM-Setup-${version}.${ext}"

electronUpdaterCompatibility: ">=2.16"

publish:
  provider: github
  owner: OWNER
  repo: auto-notebooklm-releases
```

`OWNER` debe sustituirse por el propietario real.

No inventar el propietario.

No cambiar nunca `appId` después de publicar la primera versión, porque el identificador interviene en el comportamiento de actualizaciones/instalación de NSIS. [Electron Builder](https://www.electron.build/docs/nsis/?utm_source=chatgpt.com)

`differentialPackage: "store-asar"` debe mantenerse: electron-builder puede producir actualizaciones diferenciales y `store-asar` evita que un pequeño cambio del JS obligue a descargar de nuevo casi todo `app.asar`. [Electron Builder](https://www.electron.build/v26/docs/nsis/?utm_source=chatgpt.com)

---

# 20. Crear updater.mjs

Usar:

```js
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;
```

No usar el `autoUpdater` nativo de Electron para este proyecto.

Usar `electron-updater`, porque con electron-builder proporciona NSIS, metadata, progreso, staged rollout y validación de actualizaciones. [Electron Builder](https://www.electron.build/v26/docs/features/auto-update/?utm_source=chatgpt.com)

Configuración:

```js
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.allowPrerelease = false;
```

No comprobar actualizaciones durante desarrollo:

```js
if (!app.isPackaged) return;
```

Comprobar:

```text
10 segundos después de iniciar
+
cada 60 minutos
```

Manejar eventos:

```text
checking-for-update
update-available
update-not-available
download-progress
update-downloaded
error
```

Guardar estado:

```js
{
  status,
  version,
  percent,
  error
}
```

---

# 21. NO instalar updates automáticamente mientras la app trabaja

Cuando llegue:

```text
update-downloaded
```

mostrar:

```text
"Actualización X.Y.Z lista"
```

y un botón:

```text
Reiniciar y actualizar
```

Si se pulsa:

```text
1. bloquear nuevas acciones
2. await backend.close()
3. autoUpdater.quitAndInstall(true, true)
```

No llamar a `quitAndInstall()` mientras backend siga abierto.

No cerrar SQLite a la fuerza.

---

# 22. preload.cjs

Exponer únicamente:

```js
window.desktop.getVersion()
window.desktop.getUpdateState()
window.desktop.checkForUpdates()
window.desktop.installUpdate()
window.desktop.onUpdateState(callback)
```

Nada más.

No exponer:

```text
ipcRenderer completo
fs
child_process
shell
require
process
```

---

# 23. Cambios mínimos al frontend

Modificar:

```text
public/index.html
public/app.js
public/style.css
```

Añadir un banner discreto para:

```text
Buscando actualización…
Descargando X.Y.Z — 37 %
Actualización X.Y.Z lista
Error buscando actualización
```

Mostrar botón:

```text
Reiniciar y actualizar
```

únicamente cuando esté descargada.

La aplicación web debe seguir funcionando mediante:

```powershell
npm start
```

En ese modo:

```js
window.desktop
```

no existirá.

Por tanto todo acceso será:

```js
window.desktop?....
```

No romper el modo navegador.

---

# 24. Migraciones SQLite: arreglar antes del primer release

`store.mjs` debe dejar de hacer migraciones mediante una secuencia informal de:

```text
ALTER TABLE si no existe
PRAGMA user_version=4
```

Implementar migraciones ordenadas.

Ejemplo conceptual:

```js
migrate() {
    let version = getUserVersion();

    if (version < 1) migration1();
    if (version < 2) migration2();
    if (version < 3) migration3();
    if (version < 4) migration4();
}
```

Cada migración debe ejecutarse en transacción y únicamente después:

```sql
PRAGMA user_version=N;
```

El constructor NO debe hacer:

```sql
PRAGMA user_version=1;
```

incondicionalmente sobre una base existente.

Esto es obligatorio para poder actualizar constantemente sin corromper instalaciones anteriores.

---

# 25. Importación de la versión antigua

En el primer arranque Electron:

Si:

```text
%APPDATA%\AutoNotebookLM\data\queue.sqlite
```

no existe, ofrecer:

```text
Importar instalación anterior
Empezar vacío
```

Si el usuario elige importar:

pedir una carpeta que contenga:

```text
data/
exports/
```

Validar:

```text
data/queue.sqlite existe
```

Con la aplicación backend todavía apagada:

```text
copiar data → nuevo dataDir
copiar exports → nuevo exportsDir
```

No buscar automáticamente en todo el disco.

No mover ni borrar la instalación anterior.

---

# 26. Actualizaciones de aplicación y conector son diferentes

Debe existir esta separación:

```text
AutoNotebookLM Desktop
1.0.0
     ↓ electron-updater
1.0.1


Connector
1
 ↓
2
 ↓
3
```

Una actualización del conector no debe incrementar necesariamente:

```text
package.json version
```

Una actualización del frontend/backend sí.

---

# 27. Política de versiones

App:

```text
1.0.0
1.0.1
1.0.2
1.1.0
```

SemVer normal.

Connector:

```text
1
2
3
4
```

y `runtime.json` registra además:

```text
upstreamNlmVersion
```

Ejemplo:

```text
connector 7
upstream nlm 0.15.4
```

Esto evita confundir nuestra compatibilidad con la versión upstream.

---

# 28. Nunca actualizar automáticamente upstream NLM

Aunque aparezca:

```text
notebooklm-mcp-cli 0.16
```

NO publicarlo automáticamente.

Pipeline requerido:

```text
nueva versión upstream
      ↓
construir runtime candidato
      ↓
npm test
      ↓
tests de contratos CLI
      ↓
test login
      ↓
test notebook list
      ↓
test source
      ↓
test generation
      ↓
test download
      ↓
test nlm_bridge
      ↓
test:live
      ↓
publicar connector
```

Sólo después llega a usuarios.

---

# 29. GitHub Actions

Crear:

```text
.github/workflows/release.yml
```

Ejecutar solamente para tags:

```text
v*
```

Pipeline:

```text
windows-latest
    ↓
checkout
    ↓
Node 24
    ↓
npm ci
    ↓
instalar uv
    ↓
scripts/build-runtime.ps1
    ↓
npm test
    ↓
npm run release:win
```

No construir releases Windows finales en Linux.

---

# 30. Firma de código

La release pública debe estar firmada con Authenticode.

Electron recomienda firmar las aplicaciones distribuidas; electron-updater puede además verificar la firma Windows del instalador descargado antes de aplicarlo. [Electron](https://www.electronjs.org/docs/latest/tutorial/code-signing?utm_source=chatgpt.com)

Por tanto:

```text
BUILD LOCAL:
puede ser unsigned

RELEASE ESTABLE:
debe ser signed
```

No desactivar permanentemente:

```text
verifyUpdateCodeSignature
```

Cuando exista el certificado, configurar el `publisherName` exactamente igual al subject del certificado.

---

# 31. Staged rollout obligatorio para releases frecuentes

No mandar cada versión inmediatamente al 100 %.

Electron-updater soporta:

```yaml
stagingPercentage: 10
```

en `latest.yml`. [Electron Builder](https://www.electron.build/docs/features/auto-update/?utm_source=chatgpt.com)

Política inicial:

```text
release
  ↓
10 %
  ↓
25 %
  ↓
50 %
  ↓
100 %
```

Si aparece un bug con:

```text
1.4.7
```

NO intentar reemplazar 1.4.7.

Publicar:

```text
1.4.8
```

corrigiéndolo. Electron-builder indica expresamente que una release rota debe corregirse con un número de versión superior. [Electron Builder](https://www.electron.build/docs/features/auto-update/?utm_source=chatgpt.com)

---

# 32. Logging

Crear:

```text
%APPDATA%\AutoNotebookLM\logs\main.log
```

Registrar como mínimo:

```text
versión AutoNotebookLM
versión Electron
versión Node
versión connector
versión nlm upstream
inicio backend
origin HTTP
inicio/cierre Queue
update check
update available
download progress relevante
update downloaded
update error
connector update
connector rollback
errores fatales
```

Nunca registrar:

```text
cookies
tokens
authorization headers
contenido completo de sesiones
```

Reutilizar `redact()` donde sea posible.

---

# 33. README

Actualizar requisitos.

Eliminar:

```text
Instala Node.js 24
Instala Python
Instala notebooklm-mcp-cli
Instala ffmpeg
```

Para la versión desktop debe decir:

```text
Requisito:
Windows x64

AutoNotebookLM incluye:
- Electron/Node
- Python privado
- conector NotebookLM compatible
- FFmpeg
```

Conservar una sección:

```text
Desarrollo desde código fuente
```

con los requisitos técnicos.

---

# 34. Criterios de aceptación finales

No declares terminada la migración hasta que todos estos casos pasen:

| Caso | Resultado obligatorio |
|---|---|
| `npm test` | todos pasan |
| `npm start` | sigue funcionando en navegador |
| `npm run desktop` | abre ventana Electron |
| Sin Node instalado globalmente | `.exe` funciona |
| Sin Python global | `.exe` funciona |
| Sin FFmpeg global | `.exe` convierte MP3 |
| Sin `nlm` global | `.exe` consulta NotebookLM |
| Perfil default | funciona |
| cuenta2/cuenta3 | usan el mismo runtime privado |
| Cerrar aplicación | elimina `.running` |
| Volver a abrir | recupera Queue |
| Actualizar 1.0.0 → 1.0.1 | conserva SQLite |
| Actualizar | conserva fuentes |
| Actualizar | conserva MP3 |
| Actualizar | conserva perfiles |
| Connector update válido | queda activo |
| Connector update corrupto | se rechaza |
| Connector runtime inválido | rollback |
| Puerto 4318 ocupado | app puede iniciar con otro |
| Segunda instancia | enfoca la primera |
| `npm start` | `/api/shutdown` sigue funcionando |
| Electron | `/api/shutdown` no deja backend muerto con ventana viva |
| Update descargado | no fuerza reinicio |
| Reiniciar y actualizar | primero cierra backend |
| Instalador nuevo | no elimina app data |

---

# 35. Orden obligatorio de implementación

La otra IA **no debe intentar hacerlo todo simultáneamente**. Tiene que trabajar exactamente en este orden:

```text
FASE 1
package.json + Electron básico

FASE 2
paths persistentes

FASE 3
Electron main + BrowserWindow + cierre limpio

FASE 4
Provider runtime-aware + Accounts.forProfile

FASE 5
Python/NLM privado

FASE 6
FFmpeg privado

FASE 7
electron-builder + NSIS

FASE 8
SQLite migrations

FASE 9
electron-updater

FASE 10
UI de actualización

FASE 11
component-manager del conector

FASE 12
rollback del conector

FASE 13
GitHub Actions

FASE 14
firma de código

FASE 15
staged rollout

FASE 16
importador de instalación legacy

FASE 17
prueba real completa
```

**Después de cada fase debe ejecutar `npm test`. Si una fase rompe tests existentes, debe arreglarla antes de avanzar.**

---

## Regla adicional

> No “mejores” código que no esté relacionado con esta migración. No cambies nombres de rutas HTTP, estados de Queue, estructura funcional de libros/bloques, contratos remotos ni interfaz sólo porque prefieras otra arquitectura. Haz cambios pequeños, comprobables y compatibles. Antes de modificar un archivo, lee el archivo completo y sus tests relacionados. Después de cada cambio ejecuta los tests relacionados y después `npm test`.

El punto más importante es que **el updater de Electron y el updater del conector son dos sistemas distintos**. Electron puede actualizar frontend/backend/desktop mediante NSIS diferencial; el conector NotebookLM debe poder cambiar independientemente y hacer rollback. Para este proyecto, esa separación es lo que permitirá realmente publicar correcciones con alta frecuencia sin redistribuir innecesariamente todo el stack. Electron-builder soporta NSIS como target autoactualizable, progreso, staged rollout y descarga diferencial; `store-asar` está específicamente orientado a reducir los bytes transferidos cuando cambia poco código. [Electron Builder](https://www.electron.build/v26/docs/features/auto-update/?utm_source=chatgpt.com)