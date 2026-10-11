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

La API devuelve JSON. Primero consulta `GET /api/health` y utiliza su `token` como cabecera `X-Local-Token` en cada escritura. Si envías `Origin`, debe coincidir exactamente con la URL local. Los IDs de rutas son los IDs locales de la aplicación.

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
| GET | `/api/remote/notebooks/:id` | Audios, fuentes y estados locales de un cuaderno remoto |
| POST | `/api/remote/notebooks/:id/import` | JSON `{ "title": "Libro", "profile": "default", "artifactIds": ["art-1", "art-2"] }`; descarga en lote |
| GET | `/api/books` | Libros con bloques, respaldos y estados |
| POST | `/api/books` | JSON `{ "title": "Libro", "requestId": "clave-unica" }`; devuelve `{ "id": "..." }` con HTTP 202 |
| GET | `/api/books/:id` | Estado completo del libro |
| PUT | `/api/books/:id/accounts` | JSON `{ "profiles": ["cuenta2", "cuenta3"] }`; verifica permisos y asigna respaldos |
| PUT | `/api/books/:id/files?filename=parte.md&requestId=clave-unica` | Cuerpo binario del archivo; devuelve ID del bloque. HTTP 201 |
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
