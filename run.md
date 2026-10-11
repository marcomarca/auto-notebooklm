# Comandos Frecuentes — AutoNotebookLM

Guía rápida de comandos para desarrollo, pruebas, construcción y empaquetado del proyecto.

---

## 1. Desarrollo y Pruebas

### Ejecutar tests unitarios e integración
```powershell
npm test
```
*Ejecuta los tests usando el runner nativo de Node.js (`tests/*.test.mjs`).*

### Iniciar la aplicación de escritorio (Electron)
```powershell
npm run desktop
```
*Abre la aplicación nativa en ventana de escritorio sin requerir navegador externo.*

### Iniciar en modo servidor web (Navegador)
```powershell
npm start
```
*Inicia el backend en `http://127.0.0.1:4318` para uso directo desde el navegador web.*

### Smoke test en vivo con sesión activa
```powershell
npm run test:live
```
*Comprueba la conectividad, cuenta y cuota real contra los servidores de NotebookLM.*

---

## 2. Construcción del Runtime Privado

Antes de empaquetar el instalador `.exe`, se debe generar el runtime portable de Python y el conector:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-runtime.ps1
```
*Acciones que realiza:*
1. Instala Python 3.13 portable en `build/runtime-bootstrap/python` mediante `uv`.
2. Instala `notebooklm-mcp-cli==0.12.0`.
3. Integra `scripts/nlm_entry.py` y `scripts/nlm_bridge.py`.
4. Aplica el parche CDP a `cdp.py`.
5. Ejecuta smoke tests de CLI.
6. Genera el manifiesto `build/runtime-bootstrap/runtime.json`.

---

## 3. Empaquetado y Distribución (.exe)

### Empaquetado local sin instalador (carpeta unpacked)
```powershell
npm run pack:win
```
*Genera los archivos ejecutables en `dist/win-unpacked/AutoNotebookLM.exe` para pruebas locales rápidas.*

### Generar instalador final Windows (NSIS)
```powershell
npm run dist:win
```
*Genera el instalador por usuario `dist/AutoNotebookLM-Setup-X.Y.Z.exe`.*

### Publicar release en GitHub
```powershell
$env:GH_TOKEN = "tu_token_de_github"
npm run release:win
```

---

## 4. Scripts Auxiliares

### Crear un libro y cargar archivos por CLI
```powershell
node scripts/create-book.mjs "Título del Libro" "D:\fuentes\01.md" "D:\fuentes\02.pdf"
```

### Iniciar con perfil alternativo en consola
```powershell
$env:NLM_PROFILE = "cuenta2"
npm start
```

---

## 5. Rutas Clave del Sistema en Windows

| Tipo | Ruta en Windows |
|---|---|
| **Base de datos SQLite** | `%APPDATA%\AutoNotebookLM\data\queue.sqlite` |
| **Audios MP3 exportados** | `%USERPROFILE%\Documents\AutoNotebookLM\exports\` |
| **Archivos de registro** | `%APPDATA%\AutoNotebookLM\logs\main.log` |
| **Runtime mutable conector** | `%LOCALAPPDATA%\AutoNotebookLM\runtime\connector\` |
| **Estado del conector** | `%LOCALAPPDATA%\AutoNotebookLM\runtime\connector\state.json` |
