# Audios de NotebookLM por bloques

Web local para crear un libro de NotebookLM, cargar Markdown/PDF y generar un podcast independiente por fuente. Cada audio usa exactamente un ID de fuente del mismo cuaderno y se descarga por su propio ID. Español latinoamericano (`es-419`), formato podcast `deep_dive`, duración estándar `default` y exportación MP3 real.

## Abrir

Haz doble clic en **start-app.bat**. Abre `http://127.0.0.1:4318` y deja la ventana del lanzador abierta mientras trabaja. También puedes ejecutar:

```powershell
npm start
```

No hace falta `npm install`: se utilizan las bibliotecas incluidas en Node.js.

## Requisitos

**Versión Desktop instalable (Windows x64):**
Requisito: Windows x64.
AutoNotebookLM incluye de forma integrada:
- Electron / Node.js
- Python privado
- Conector NotebookLM compatible (`0.12.0`)
- FFmpeg con soporte `libmp3lame`

## Desarrollo desde código fuente

Si ejecutas la aplicación directamente en modo desarrollo sin el instalador:
- Node.js **24**
- `notebooklm-mcp-cli` **0.12.0**
- FFmpeg con `libmp3lame`
- Sesión iniciada de NotebookLM

```powershell
npm install
npm test
npm run desktop   # Iniciar aplicación de escritorio Electron
npm start         # Iniciar backend para navegador web
```


## Uso

1. Escribe el título y pulsa **Crear libro**. Se creará un único cuaderno remoto. Su título incluye un identificador corto para recuperar una creación interrumpida sin duplicarla.
2. Arrastra tus archivos `.md` y `.pdf`, o usa **Seleccionar archivos**. Se guardan primero en disco y después se cargan automáticamente en NotebookLM. Se aceptan lotes de 25 o más archivos, sujetos a los límites de tu cuenta. El límite local es 200 MiB por archivo; Markdown debe ser UTF-8.
3. Comprueba el orden natural y modifica títulos o mueve los bloques con las flechas antes de generar. Los archivos con el mismo contenido dentro del mismo libro se omiten como duplicados.
4. Pulsa **Generar audios pendientes**. La aplicación procesa una generación a la vez y descarga/convierte cada resultado automáticamente.
5. Reproduce o descarga los MP3 desde la lista. Los nuevos bloques se añaden al final cuando existen números ya fijados por una generación.

Los archivos finales aparecen en `exports/<libro>-<id-local>/001 - Título.mp3`. El directorio incluye el ID del libro para evitar colisiones entre libros con el mismo título. Las fuentes originales, los M4A y la base SQLite se conservan en `data/`; ninguna de estas carpetas se incluye en Git. Copia **data y exports juntas, con la aplicación cerrada**, para respaldar todo el estado.

**Pausar** impide iniciar otra generación. El audio que Google ya está generando se sigue consultando y descargando. Las cargas de fuentes también continúan. Cerrar la pestaña no detiene Node.js; cerrar el lanzador, finalizar Node.js o apagar el PC sí lo detiene. La cola retoma su etapa guardada al volver a iniciar.

Si se agota la cuota, se guarda el próximo intento según las ventanas agotadas que informe el proveedor. Sin una fecha fiable, se comprueba cada 30 minutos. La interfaz muestra las fechas en la zona `America/La_Paz`. No estima cuántos audios permitirá el saldo restante. Una consulta de cuota no disponible se trata como desconocida; el rechazo real de generación sigue deteniendo la cola.

**En cola de Google** refleja el estado remoto `queued`. La aplicación sigue consultando ese mismo ID: no genera otro audio ni promete una hora de finalización. La duración estándar corresponde a la opción del proveedor, no a un número fijo de minutos.

**Reintentar** repite únicamente la etapa fallida. **Generar de nuevo** solo aparece cuando NotebookLM informó explícitamente que ese audio falló. **Revisión necesaria** significa que el resultado remoto no pudo identificarse sin riesgo de duplicarlo: abre el cuaderno y usa **Comprobar de nuevo** después de que aparezca. Si sigue ambiguo, la aplicación conserva los datos y no envía otra solicitud. Una lista vacía de procedencia del proveedor no se interpreta como prueba de aislamiento al recuperar una solicitud incierta.

## Cuentas y rotación de cuota

La aplicación admite múltiples perfiles de `notebooklm-mcp-cli` (`default`, `cuenta2`, etc.), compatibles con NotebooklmPRO:

1. **Gestión de perfiles**: En el panel lateral «Cuentas y cuota» puedes añadir perfiles, comprobar su estado de sesión/cuota, iniciar sesión con `nlm login` y habilitar/deshabilitar cuentas para la cola.
2. **Cuenta propietaria y respaldos**: Cada libro se crea con la cuenta activa en ese momento. En la sección «Cuentas de respaldo para este libro» puedes vincular otras cuentas habilitadas. Para utilizarlas, comparte el cuaderno desde NotebookLM con dichas cuentas otorgándoles permiso de **Editor**.
3. **Rotación automática**: Si la cuenta propietaria agota su cuota disponible (detectada en la consulta o por rechazo remoto `QUOTA`), la cola rota automáticamente a la siguiente cuenta de respaldo configurada sin duplicar el libro ni las fuentes.
4. **Descargas consistentes**: Cada audio se descarga y convierte utilizando exactamente la cuenta que lo generó (guardada en el registro del bloque).

## Explorador remoto y descarga en lote

Puedes revisar los cuadernos existentes en tus cuentas de NotebookLM y descargar todos sus audios de una sola vez:

1. Pulsa **☁ Explorar cuadernos de mi cuenta** en el panel lateral.
2. Selecciona el perfil y el cuaderno que deseas inspeccionar.
3. Se mostrarán todos los podcasts y audios generados en ese cuaderno remoto con sus fuentes vinculadas y estados.
4. Marca **Seleccionar todos** (o selecciona los audios deseados) y pulsa **Descargar audios seleccionados**.
5. La cola local los importa como bloques y procesa automáticamente la descarga y conversión a MP3 **uno a uno**, guardándolos ordenadamente en `exports/<nombre-libro>/...`.

## Entrada desde Node.js

Con la aplicación ejecutándose:

```powershell
node scripts/create-book.mjs "Historia de la ciencia" "D:\capitulos\01.md" "D:\capitulos\02.pdf"
```

El script guarda los archivos y enciende la cola; el backend continúa después de que termine el script. Puedes fijar `BOOK_REQUEST_ID` para repetir una llamada sin crear otro libro. `APP_URL` permite usar otro puerto.

## Semántica de control y operaciones

Cada acción en la aplicación tiene una intención explícita y aislada:

1. **Sincronizar contenido (`POST /api/books/:id/sync`)**:
   - Reconcilia metadatos remotos (fuentes, contenidos de Studio y notas) hacia el catálogo local en SQLite (`remote_items`).
   - **Invariante**: Sincronizar **NUNCA** genera contenidos, **NUNCA** inicia descargas automáticas, **NUNCA** comparte con otras cuentas ni elimina fuentes o audios.
   - Si una sección remota falla (por ejemplo, Studio da timeout pero Fuentes responde bien), se actualizan las fuentes y se preserva la caché de Studio con su error visible, sin marcar elementos como ausentes.

2. **Descarga manual (`POST /api/books/:id/downloads`)**:
   - Permite descargar contenidos existentes identificados por su ID exacto, individualmente o por selección en lote.
   - **Audio**: Descarga el original M4A y lo convierte a MP3 mediante FFmpeg, conservando el M4A.
   - **Otros tipos de Studio**: Vídeos (MP4), Informes (Markdown), Diapositivas (PDF/PPTX), Infografías (PNG), Cuestionarios (JSON/MD), Tarjetas de estudio (JSON/MD), Mapas mentales (JSON) y Tablas de datos (CSV) se descargan con sus adaptadores específicos y se sirven con su MIME type correcto. **Cero llamadas a FFmpeg MP3 para documentos o vídeos**.
   - **Tipos desconocidos**: Aparecen visibles en el catálogo con su tipo original y enlace remoto, con la descarga deshabilitada hasta disponer de un adaptador comprobado. Nunca se asumen como audio.
   - **Invariante**: Descargar **NUNCA** solicita regeneración a Google.

3. **Añadir material y generación selectiva**:
   - Añadir archivos Markdown/PDF a un cuaderno sincronizado requiere permisos de escritura comprobados (`accounts.checkWriteAccess`). Nunca invita automáticamente cuentas lectoras como editoras.
   - Las nuevas fuentes se suben al cuaderno existente sin crear cuadernos duplicados.
   - **Generación selectiva (`POST /api/books/:id/generations`)**: Solo las fuentes explícitamente seleccionadas por el usuario entran a la cola de generación. Añadir material nunca regenera fuentes antiguas.

4. **Detención y cancelación de trabajos**:
   - **Pausar nuevas generaciones**: Detiene el envío de nuevos audios. Los audios ya despachados a Google continúan su ciclo de seguimiento y descarga.
   - **Cancelar este bloque (`POST /api/blocks/:id/cancel`)**: Interrumpe inmediatamente las etapas locales pendientes y evita reintentos/reanudaciones automáticas tras reinicios o cuota restaurada. Si el trabajo ya fue despachado a Google, se conserva su ID y se indica claramente: *«Cancelado localmente. La generación remota puede continuar en Google»*. No se promete parada de cómputo en servidores de Google ni devolución de cuota.
   - **Cancelar bloques pendientes (`POST /api/books/:id/cancel-pending`)**: Cancela los bloques que aún no salieron a Google e informa cuántos ya estaban en curso remoto.
   - **Cancelación por proceso**: Los abortos terminan únicamente el proceso CLI/FFmpeg del trabajo en cuestión (`AbortController`), manteniendo el runner general y las demás cuentas operativas.

5. **Eliminación remota explícita (`POST /api/books/:id/artifacts/:itemId/delete`)**:
   - Flujo independiente de la cancelación local.
   - Requiere confirmación explícita obligatoria (`confirm: true`).
   - Muestra la cuenta de acceso, el cuaderno, el tipo y el ID exacto del artefacto. Advierte que es irreversible y que afecta a todas las cuentas con acceso al cuaderno compartido.
   - Valida la pertenencia del artefacto al cuaderno y ejecuta `nlm studio delete <notebook_id> <artifact_id> --confirm -p <profile>`.
   - Si la respuesta es incierta o falla la red, registra `uncertain` para reconciliación en la siguiente sincronización; no afirma éxito prematuro.
   - Si el elemento reaparece tras confirmarse su borrado, se marca para revisión manual y se evita un bucle de borrados automáticos.

| Método | Ruta | Entrada / resultado |
|---|---|---|
| GET | `/api/health` | Conexión, perfil, cuota, token local y actividad del worker |
| POST | `/api/health/check` | Comprobar herramientas/sesión y desbloquear tareas de autenticación |
| GET | `/api/accounts` | Lista de cuentas configuradas, cuenta activa y estado de salud/cuota |
| POST | `/api/accounts` | JSON `{ "profile": "cuenta3" }`; registra el perfil en la base local |
| POST | `/api/accounts/:id/check` | Comprobar conexión y cuota de un perfil específico |
| POST | `/api/accounts/:id/select` | Seleccionar perfil activo predeterminado para nuevos libros |
| POST | `/api/accounts/:id/enabled` | JSON `{ "enabled": true }`; habilitar/deshabilitar perfil para la cola |
| POST | `/api/accounts/:id/login` | Iniciar proceso de autenticación interactivo en Chrome |
| GET | `/api/remote/notebooks` | Listado de cuadernos remotos en NotebookLM (`?profile=default`) |
| POST | `/api/remote/notebooks/:remoteId/sync` | JSON `{ "profile": "default" }`; vincula vista local y agenda lectura de catálogo |
| GET | `/api/books` | Libros con bloques, respaldos y estados |
| POST | `/api/books` | JSON `{ "title": "Libro", "requestId": "clave-unica" }`; devuelve `{ "id": "..." }` con HTTP 202 |
| GET | `/api/books/:id` | Estado completo del libro |
| POST | `/api/books/:id/sync` | Sincronizar catálogo remoto del cuaderno (fuentes, Studio, notas) sin descargar ni generar |
| GET | `/api/books/:id/catalog` | Catálogo persistido en SQLite, completitud por sección y capacidades |
| POST | `/api/books/:id/generations` | JSON `{ "sourceIds": ["src-1"], "mode": "immediate" }`; genera audios de fuentes seleccionadas |
| POST | `/api/books/:id/downloads` | JSON `{ "items": [{ "itemId": "art-1", "format": "pdf" }] }`; programa descarga manual |
| GET | `/api/downloads` | Listado de trabajos de descarga (audio y Studio no-audio) con estados y rutas |
| GET | `/api/downloads/:id/file` | Servir archivo descargado validado, con MIME type correcto y soporte Range |
| POST | `/api/downloads/:id/cancel` | Cancelar trabajo de descarga individual sin afectar otros procesos |
| POST | `/api/blocks/:id/cancel` | Cancelar bloque local individualmente |
| POST | `/api/books/:id/cancel-pending` | Cancelar bloques pendientes de un libro; reporta cuántos eran locales vs ya remotos |
| POST | `/api/books/:id/artifacts/:itemId/delete` | JSON `{ "confirm": true }`; eliminación remota explícita en NotebookLM |
| GET | `/api/operations/:id` | Consultar estado de operaciones asíncronas (`sync`, `delete_artifact`) |
| PUT | `/api/books/:id/accounts` | JSON `{ "profiles": ["cuenta2", "cuenta3"] }`; verifica permisos y asigna respaldos |
| PUT | `/api/books/:id/files?filename=parte.md&requestId=clave-unica` | Cuerpo binario del archivo; sube fuente a NotebookLM con permisos de editor |
| PATCH | `/api/books/:id/order` | JSON `{ "ids": ["id-bloque-1", "id-bloque-2"] }`, todos los bloques una vez |
| PATCH | `/api/books/:id/numbering` | JSON `{ "numbering": true }` (o `false`); renombra archivos en disco y actualiza rutas |
| PATCH | `/api/blocks/:id` | JSON `{ "title": "Nuevo título" }`, antes de solicitar audio |
| POST | `/api/books/:id/queue` | JSON `{ "action": "start" }`; también `pause` y `resume` |
| POST | `/api/books/:id/retry` | Reintentar creación o reconciliar cuaderno incierto |
| POST | `/api/blocks/:id/retry` | Reintentar etapa o reconciliar operación incierta |
| POST | `/api/shutdown` | Cierre limpio del backend y sus procesos; utilizado por el lanzador |
| GET / HEAD | `/api/blocks/:id/audio` | MP3; admite rangos HTTP para reproducción. Añade `?download=1` para descargar |

El servidor solo escucha en `127.0.0.1`. Rechaza hosts y orígenes externos y requiere token en las escrituras. No expone directorios de datos, credenciales ni un servidor MCP a la red. Los archivos se suben a NotebookLM al incorporarlos al libro. El conector utiliza APIs no oficiales y puede requerir actualización si cambia Google; no se inventan resultados ni IDs cuando falla.

Solo se permite una instancia por carpeta de datos, incluso con distintos puertos. El bloqueo se recupera automáticamente después de un proceso terminado. Cierra la instancia anterior antes de iniciar con otro perfil.

## Verificación

```powershell
npm test
npm run test:live
```

`npm test` usa `node:test`, CLI simulada y servidores HTTP temporales que se cierran al terminar. Cubre 25 bloques, cuota, recuperación, operaciones inciertas, aislamiento de fuentes, descargas por ID, conversión/reintentos, nombres y validación de archivos, sesión expirada, idempotencia y seguridad de la API.

`test:live` crea un cuaderno de prueba con dos Markdown distintos, genera dos podcasts reales y valida cada MP3 decodificándolo con FFmpeg. **Consume cuota real**. Guarda el informe en `data/live-check/report.json`, conserva los audios y cierra su servidor/procesos al terminar. Es reanudable: una segunda ejecución usa el mismo libro y no vuelve a generar bloques terminados. No elimina automáticamente el cuaderno remoto.

`node scripts/preview-check.mjs` sirve una biblioteca desechable de 25 bloques para verificar la interfaz. No llama a NotebookLM, no sirve audios reales y se cierra automáticamente después de tres minutos.

## BloqueAudio 1.1.1 (carpeta activa D:)

Este proyecto activo está en `D:\apps-2026\auto-notebooklm`. La copia bajo `Documents/ChatGPT` es otra biblioteca y otro repositorio; sus compilaciones no actualizan esta aplicación.

- `npm run dev` o `start-app.bat`: inicia el código actual en el navegador, reinicia el backend al guardar módulos y conserva `data/` y `exports/` de esta carpeta.
- `npm run dist:win`: recompila el instalador Electron `dist/BloqueAudio-Setup-1.1.1.exe` y la aplicación `dist/win-unpacked/BloqueAudio.exe`.
- `npm run install:start-menu`: registra BloqueAudio (desarrollo) y BloqueAudio (distribucion) con identificadores propios de Windows. No inicia automáticamente al encender el PC.
- El escritorio conserva `%APPDATA%/AutoNotebookLM` y `Documents/AutoNotebookLM/exports`; el cambio de marca no mueve ni reemplaza esa biblioteca. El navegador de desarrollo conserva la biblioteca de D:.
- `node scripts/smoke-desktop.mjs`: prueba el ejecutable real con datos temporales, sin acceder a Google ni iniciar trabajos, y cierra todos sus procesos.

Correcciones: lectura de `runtime.json` con BOM generado por PowerShell; uso directo del runtime incluido para evitar copiar miles de archivos antes de abrir la interfaz; desactivación del actualizador mientras su repositorio siga siendo el ejemplo OWNER; errores de inicio visibles. La versión aparece en la interfaz y en las propiedades del ejecutable.
