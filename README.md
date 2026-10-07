# Audios de NotebookLM por bloques

Web local para crear un libro de NotebookLM, cargar Markdown/PDF y generar un podcast independiente por fuente. Cada audio usa exactamente un ID de fuente del mismo cuaderno y se descarga por su propio ID. Español latinoamericano (`es-419`), formato podcast `deep_dive`, duración estándar `default` y exportación MP3 real.

## Abrir

Haz doble clic en **start-app.bat**. Abre `http://127.0.0.1:4318` y deja la ventana del lanzador abierta mientras trabaja. También puedes ejecutar:

```powershell
npm start
```

No hace falta `npm install`: se utilizan las bibliotecas incluidas en Node.js.

Requisitos: Node.js **24**, `notebooklm-mcp-cli` **0.12.0**, FFmpeg con `libmp3lame`, y sesión de NotebookLM. La aplicación comprueba estos requisitos y bloquea nuevas operaciones remotas hasta completar la comprobación.

```powershell
node --version
nlm --version
ffmpeg -version
nlm login -p default
```

Para otro perfil ya configurado, establece `NLM_PROFILE` antes de iniciar. No cambia el perfil predeterminado global del conector. Puedes establecer `PORT`, `NLM_BINARY` y `FFMPEG_BINARY` si necesitas otro puerto o rutas explícitas.

```powershell
$env:NLM_PROFILE = 'cuenta2'
.\start-app.ps1
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
| GET | `/api/books` | Libros del perfil activo con bloques y estados |
| POST | `/api/books` | JSON `{ "title": "Libro", "requestId": "clave-unica" }`; devuelve `{ "id": "..." }` con HTTP 202 |
| GET | `/api/books/:id` | Estado completo del libro |
| PUT | `/api/books/:id/files?filename=parte.md&requestId=clave-unica` | Cuerpo binario del archivo; devuelve ID del bloque. HTTP 201 |
| PATCH | `/api/books/:id/order` | JSON `{ "ids": ["id-bloque-1", "id-bloque-2"] }`, todos los bloques una vez |
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
