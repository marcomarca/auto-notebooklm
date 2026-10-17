# Plan de implementación: biblioteca multicuenta, sincronización y control de trabajos

Fecha de análisis: **17 de octubre de 2026**, America/La_Paz. Producto actual: **BloqueAudio 1.1.1**.

## 0. Instrucciones para la IA que ejecutará este plan

Este documento es una especificación de trabajo. Su autor **solo analizó el proyecto y escribió este Markdown**: no implementó estas mejoras, no ejecutó borrados remotos, no generó contenidos ni arrancó servidores para esta planificación.

1. Trabajar en **`D:\apps-2026\auto-notebooklm`**. Existe otra copia en `C:\Users\Rescate\Documents\ChatGPT\auto-notebooklm`; **no actualizar esa copia por error**. Tampoco modificar el proyecto de referencia `D:\apps-2026\NotebooklmPRO`.
2. Referencia inspeccionada: commit `d0fef14740a21291ce18b3cc2f16a68068af903e`, rama `codex/bloqueaudio-launcher-fix`, árbol limpio antes de crear este documento. Comprobar el estado real antes de editar: otra IA puede haber avanzado.
3. Leer AGENTS.md aplicables. Usar FFF primero para búsquedas del workspace que tenga indexado; si esta carpeta está fuera de ese índice o FFF falla, usar `rg`. No suponer que un índice de C: describe el proyecto de D:.
4. Guardar el trabajo existente y crear una rama `codex/sync-library-controls`. No borrar cambios ajenos ni sustituir archivos completos por versiones antiguas.
5. Reutilizar Node 24, HTTP nativo, SQLite nativo, JavaScript del frontend, `Provider`, `Accounts`, `Queue`, FFmpeg y el runtime Electron existentes. No introducir otro framework, otra autenticación, un servidor MCP paralelo ni un sistema de plugins.
6. Implementar las fases en orden. Cada fase debe dejar una funcionalidad comprobable y un commit. No hacer una reescritura general antes de resolver los defectos concretos.
7. **Sincronizar no autoriza generar, descargar todo, compartir, borrar fuentes ni borrar audios.** Cada acción tiene una intención explícita distinta.
8. Las pruebas automáticas serán simuladas y usarán almacenamiento temporal. Las pruebas reales de creación o eliminación requieren un cuaderno desechable identificado y autorización específica; la petición de redactar este plan no la concede.
9. Cerrar todos los servidores, procesos y ventanas de prueba propios al terminar, incluso si una prueba falla. No cerrar procesos del usuario por nombre genérico.
10. No publicar releases, activar un repositorio de actualizaciones ni reconstruir/instalar el EXE como efecto secundario de guardar el plan. La implementación futura debe validar primero desarrollo y luego preparar la distribución que el usuario solicite.

## 1. Resultado que necesita el usuario

Desde cualquier cuenta configurada, el usuario debe poder:

- Explorar sus cuadernos de NotebookLM, sincronizar uno con la biblioteca local y volver a abrirlo después.
- Ver sus fuentes, contenidos de Studio y notas disponibles, con cuenta, tipo y estado claramente identificados.
- Descargar manualmente un contenido o una selección, sin perder el comportamiento de descarga que ya existe.
- Añadir Markdown/PDF a un cuaderno existente, con una cuenta que tenga permisos suficientes, sin crear otro cuaderno remoto.
- Elegir qué fuentes generan nuevos audios. Añadir material no debe regenerar automáticamente lo que ya existe.
- Detener un bloque o los bloques todavía pendientes. Si Google ya recibió una solicitud, ver qué puede detenerse localmente y qué requiere una eliminación remota independiente.
- Utilizar posteriormente otros contenidos de NotebookLM sin que todos sean tratados como audios.

En esta petición no se enumeraron tipos adicionales que deban **generarse** ahora. Decisión de alcance: inventariar y permitir descargas manuales de los tipos soportados; mantener la generación de audio existente; dejar la creación de otros tipos como una fase posterior elegible. No inventar una lista de nuevas generaciones obligatorias ni ejecutarlas todas.

“Carpetas de una cuenta” se interpreta aquí como sus **cuadernos/libros**, según el explorador que ya existe. No construir un sistema nuevo de carpetas de Drive ni confundirlo con las etiquetas internas de fuentes.

## 2. Hallazgos comprobados en el código actual

Estos son hallazgos de lectura estática y de ayuda/código del conector. No presentarlos como pruebas remotas de funcionamiento.

| Ref. | Ubicación | Hallazgo y consecuencia |
|---|---|---|
| F01 | `store.mjs`, `importRemoteBook()` | Busca por `remote_id` solamente. El mismo cuaderno visto desde otra cuenta puede recuperar una fila de la cuenta equivocada. |
| F02 | `store.mjs`, `importRemoteBook()` | El `request_id` remoto tampoco incorpora el perfil. Cambiar solo la consulta SQL no arregla la colisión de idempotencia. |
| F03 | `server.mjs`, detalle remoto | Busca el libro local solo por ID remoto; puede asociar descargas/estados de otra cuenta. |
| F04 | `server.mjs`, detalle e importación | Usa `.catch(() => [])` para fuentes/artefactos. Un error de sesión o de red puede parecer un cuaderno vacío. |
| F05 | `server.mjs`, detalle remoto | Filtra únicamente audio y asume audio si falta `type`. No representa todo Studio y clasifica tipos desconocidos de forma insegura. |
| F06 | `server.mjs`, importación remota | Un ID de artefacto no encontrado recibe valores por defecto, incluso `completed`. Debe rechazarse, no convertirse en un audio supuesto. |
| F07 | `store.mjs`, `importRemoteBlock()` | Mezcla un artefacto remoto con un bloque de generación, inventa nombre `.md` y puede dejar fallidos en etapa `generate`. Descargar contenido existente nunca debe solicitar su regeneración. |
| F08 | `public/app.js`, explorador | Mantiene selección por ID remoto y variables de perfil separadas. Cambiar de cuenta no invalida todo el detalle/selección anterior y no hay defensa frente a respuestas tardías A→B. |
| F09 | `public/app.js`, `refresh()` | Busca libros por ID remoto con un `OR` que puede seleccionar otro perfil aunque el ID local del detalle sea conocido. |
| F10 | `queue.mjs`, `step()` | Envía generaciones sucesivas sin esperar a que terminen las anteriores. Pueden existir diez solicitudes ya aceptadas en Google: pausar después no las retira. No regresar silenciosamente a una generación remota por vez; conservar esa capacidad y añadir controles. |
| F11 | `queue.mjs` | `running` pausa nuevas generaciones del libro, pero las cargas, consultas y descargas ya activas continúan. No existe cancelación individual persistente. |
| F12 | `queue.mjs`, validación de procedencia | La regla de una fuente sirve para audios creados por bloque. Un audio externo legítimo puede usar varias fuentes; importarlo no debe ser rechazado por esa regla ni recortar su procedencia al primer ID. |
| F13 | `accounts.mjs`, `verify()` | Puede invitar automáticamente otra cuenta como editora. No usar este método para comprobar permisos durante exploración o sincronización: esas acciones deben ser de lectura. |
| F14 | `Provider.forProfile()` | Comparte el mismo `CommandRunner` entre perfiles. Cerrar un proveedor para detener un trabajo puede cerrar operaciones de otras cuentas y dejar el runner inutilizable. |
| F15 | `Provider.artifacts()` | Ya pagina de 100 en 100, pero corta en 2.000 elementos y no informa que el inventario quedó incompleto. Conservar la paginación, corregir la señal de completitud. |
| F16 | SQLite y rutas | El esquema actual llega a `user_version=4`. El navegador usa `data/` y `exports/` del proyecto; Electron conserva `%APPDATA%/AutoNotebookLM/data` y `Documents/AutoNotebookLM/exports`. No migrar ni fusionar esas bibliotecas incidentalmente. |
| F17 | `scripts/nlm_bridge.py` | “Generar más tarde” usa una extensión RPC propia (`--later`). No equivale a cancelación ni demuestra que Google no consuma cuota. Conservar compatibilidad sin ampliar promesas. |

Antes de programar, buscar todos los consumidores de esas funciones, endpoints y estados. Los números de línea pueden cambiar; los nombres anteriores identifican los lugares de intervención.

## 3. Capacidades reales del conector: qué existe y qué no se ha demostrado

Se comprobó `nlm 0.12.0` y la ayuda `studio` del runtime Python incluido en la aplicación instalada. También se leyó la implementación MCP del paquete: **no se invocó un MCP remoto del chat**.

| Necesidad | Soporte observado | Decisión |
|---|---|---|
| Listar cuadernos | CLI `notebook list`, con perfil | Reutilizar `Provider.listBooks()`. |
| Listar fuentes | CLI `source list`, con perfil | Reutilizar `Provider.sources()`. No descarga el PDF original. |
| Consultar texto de fuente | CLI `source content` / funciones de contenido del conector | Lectura bajo demanda. Es texto extraído, no recuperación garantizada del archivo original. Confirmar argumentos con ayuda de la versión efectiva. |
| Listar Studio | CLI `studio status`, MCP `studio_status` | Recuperar todas las páginas y tipos, con estado desconocido permitido. |
| Listar notas | CLI `note list --json`, MCP `note(action=list)` | Añadir lectura si el runtime efectivo la admite; mostrar errores por sección. |
| Descargar contenidos | CLI `download` y MCP `download_artifact` | Cada descarga debe indicar el ID exacto y el perfil correcto. |
| Añadir material | CLI `source add`, con perfil | Subir al cuaderno ya vinculado; requiere permisos de escritura. |
| Eliminar un artefacto | CLI `studio delete`; MCP `studio_delete(notebook_id, artifact_id, confirm=True)` | Existe eliminación irreversible. Exigir confirmación del usuario y comprobar el resultado. |
| Eliminar una fuente | CLI `source delete`; MCP `source_delete` | Existe, pero no usarla como mecanismo para detener un audio. Es una acción independiente. |
| Eliminar una nota | CLI `note delete`; MCP `note(action=delete)` | Existe, independiente de generación y sincronización. |
| Cancelar específicamente una generación de Studio | No se encontró comando `cancel` en `studio`, función MCP equivalente ni contrato en el cliente inspeccionado | No inventar `studio_cancel`, `--cancel` ni una RPC. Implementar cancelación local y eliminación remota diferenciadas. |
| Garantizar parada de cómputo o devolución de cuota | No demostrado | No prometerlo aunque `studio delete` acepte un artefacto pendiente. |

Contratos concretos verificados por `--help` (son ejemplos para el implementador, **no órdenes para ejecutar ahora**):

```text
nlm studio status <notebook_id> --full --json --mcp-compatible --limit 100 --offset 0 -p <profile>
nlm studio delete <notebook_id> <artifact_id> --confirm -p <profile>
nlm source delete <source_id> --confirm --json -p <profile>
nlm note list <notebook_id> --json -p <profile>
nlm download audio <notebook_id> --id <artifact_id> --output <file.m4a> --no-progress
```

Algunas descargas **no admiten `-p` como argumento**; el proveedor ya fija `NLM_PROFILE` en el entorno del proceso. Mantener ese aislamiento, no añadir flags inexistentes. La CLI `studio delete` comprobada no ofrece `--json`: no asumir que su salida es JSON ni que tiene los mismos flags que `source delete`.

La eliminación existe en el servicio compartido por CLI/MCP; eso no demuestra que un artefacto en todos los estados admita borrado ni que el trabajo del servidor se cancele. El soporte de cancelación remota queda **no disponible/no verificado** hasta que una versión del proveedor exponga y documente un contrato específico.

## 4. Alcance y prioridades

### P0: imprescindible, primero

1. Aislar cuenta/cuaderno en todas las consultas, selecciones y operaciones.
2. Sincronizar metadatos completos, con errores parciales visibles y persistencia.
3. Descargar manualmente audios existentes, individualmente y por selección, sin regenerarlos.
4. Abrir cualquier cuaderno sincronizado y añadirle Markdown/PDF con permisos verificados.
5. Detener bloques aún locales y cancelar su trabajo local, conservando resultados remotos inciertos.
6. Ofrecer eliminación remota explícita de un artefacto con ID conocido y permisos suficientes.

### P1: contenidos adicionales existentes

Inventariar todos los tipos devueltos por Studio; habilitar descargas por adaptadores pequeños y comprobados. Añadir notas y lectura de fuentes sin convertirlas en bloques de generación.

### P2: creación de otros tipos, posterior

Habilitar por tipo elegido por el usuario. No generar automáticamente vídeo, informes, diapositivas y cuestionarios por cada bloque ni extender el hack `--later` a tipos distintos del audio.

Fuera del alcance: sincronización bidireccional automática de archivos, copia entre cuentas, compartir cuadernos automáticamente, borrar cuadernos enteros, cambiar branding/arquitectura otra vez, servicios en la nube adicionales.

## 5. Identidad y aislamiento multicuenta

La clave lógica de una **vista local** de un cuaderno será:

```text
(profile_id, remote_notebook_id)
```

Reglas obligatorias:

- `books.profile` identifica la cuenta de acceso de esa vista; no prueba que sea propietaria del cuaderno. Mostrar “Cuenta de acceso”, salvo que se haya verificado el rol de propietario.
- Dos cuentas pueden acceder al mismo cuaderno compartido: son dos vistas locales, pero **un solo cuaderno en Google**. Sincronizar la segunda vista no crea otro cuaderno remoto.
- Dos libros con el mismo título y distintos IDs nunca se fusionan.
- Usar `(book_id, kind, remote_item_id)` para identificar contenidos locales. Conservar todos los IDs de fuentes de un artefacto, no solo uno.
- El perfil seleccionado para nuevos libros no cambia la cuenta de libros existentes, sincronizaciones en curso ni descargas programadas.
- Las descargas manuales usan por defecto la cuenta con la que se seleccionaron. No rotarlas silenciosamente a otra cuenta por agotamiento de cuota: descargar no es generar.
- Las nuevas generaciones solo pueden usar respaldos que ya estén configurados explícitamente y tengan acceso. Un control de generación no debe alterar la cuenta de una descarga ni de una eliminación.
- Capturar el correo/identidad de la cuenta al vincular una vista. Si un perfil se vuelve a autenticar como otro correo, bloquear sus escrituras y pedir revinculación explícita; no reasignar la biblioteca histórica automáticamente.
- En un cuaderno compartido, eliminar un contenido remoto afecta al mismo contenido visto por las otras cuentas. Indicarlo en la confirmación y reflejarlo al sincronizar esas vistas.

Cambiar todas las búsquedas por `remote_id=?` que pretendan encontrar una vista local. No arreglar solo `importRemoteBook()`: revisar `server.mjs`, `public/app.js`, tests, idempotencia e importaciones.

## 6. Experiencia de usuario propuesta

### Exploración

- Selector de cuenta con alias y correo disponible.
- Lista de cuadernos de esa cuenta; cada tarjeta muestra cuenta de acceso, sincronizado/no sincronizado y fecha del último éxito.
- Al cambiar de cuenta: limpiar detalle, selección de artefactos y mensajes de operaciones de la cuenta anterior; invalidar las respuestas pendientes.
- Una respuesta tardía de A no puede reemplazar la lista o detalle de B. Usar un contador de contexto o `AbortController` más comprobación final de la clave compuesta.

### Detalle de cuaderno

Cabecera: título, cuenta de acceso, rol conocido/desconocido, enlace remoto, último estado de sincronización. Acciones:

1. **Sincronizar contenido**: lectura y actualización del catálogo, sin descargar ni generar.
2. **Añadir material**: drag-and-drop a ese cuaderno, habilitado solo con escritura comprobada.
3. Secciones **Fuentes**, **Contenidos**, **Notas** y **Trabajos**.
4. Filtros por tipo y estado; selección manual inicialmente vacía.
5. **Descargar** por fila y **Descargar seleccionados**. El contador incluye solo los seleccionados y elegibles.
6. Estados separados: “Generando en NotebookLM” y “No descargado”, o “Completado en NotebookLM” y “Descarga fallida”.
7. Si una sección falla, mostrar su error y la fecha de su caché; no reemplazarla por “No hay contenido”.

En biblioteca y cola mostrar la cuenta junto a cada libro y trabajo. Conservar esos datos aunque el usuario esté mirando otra cuenta.

No ofrecer un único botón ambiguo “Detener” para comportamientos distintos. Usar los textos de la sección 11.

## 7. Modelo de datos mínimo, sin rehacer la cola de audio

Conservar `books`, `blocks`, `accounts`, `book_accounts` y `settings`. Añadir migraciones a partir de la versión real encontrada (la inspeccionada es 4); no reinicializar `PRAGMA user_version` ni copiar el `store.mjs` de C:.

### Ajustes a `books`

- Identidad por `profile + remote_id` cuando el ID remoto no es nulo.
- `origin`: `local_created` o `remote_linked`.
- `profile_email_at_link` y rol conocido, si está disponible; desconocido no equivale a editor.
- Fechas de sincronización, última sincronización completa y estado/error resumido.
- Las fuentes descubiertas por sincronización no activan generación automática.
- Idempotencia de importación con una clave que incluya perfil e ID remoto; usar hash completo estable, no recortar IDs para construir claves ambiguas.

### Nueva tabla `remote_items`

Catálogo de lectura, separado de solicitudes de generación:

- ID local, FK `book_id`, `kind` (`source`, `artifact`, `note`), ID remoto.
- Tipo normalizado y tipo original, título, estado remoto normalizado y original.
- `source_ids_json`, fechas remotas si existen y metadatos estrictamente necesarios.
- `last_seen_at`, revisión de sincronización y marca de ausencia remota confirmada.
- Referencia opcional a un bloque local ya existente. No inventar bloques `.md` para representar un vídeo o una nota.
- Restricción única `(book_id, kind, remote_id)`.

### Nueva tabla `download_jobs`

Necesaria para distinguir descargar contenido existente de generar contenido nuevo:

- ID local, `remote_item_id`, formato, perfil fijado e identidad de cuenta esperada.
- Estado local: `queued`, `downloading`, `converting`, `done`, `error`, `canceled`.
- Intentos, próximo intento, error, ruta temporal, ruta original y ruta final.
- ID de petición para doble clic/idempotencia.
- Evitar dos trabajos activos para el mismo contenido y formato; un archivo existente validado puede reutilizarse.
- Dos formatos del mismo artefacto son dos descargas distintas; no confundirlos con dos generaciones.

### Nueva tabla `remote_operations`

Registro persistente pequeño para sincronizaciones y eliminaciones:

- ID de operación, libro, perfil, tipo (`sync`, `delete_artifact`), objetivo exacto cuando corresponda.
- Estado (`pending`, `running`, `uncertain`, `confirmed`, `failed`), marcas temporales y error.
- Para sincronización, completitud/error por sección y revisión de publicación.
- Para eliminación, alcance confirmado e identificador de petición. No almacenar cookies ni tokens.

### Ajustes a `blocks`

Conservar etapas/IDs/baselines actuales y añadir control persistente independiente, por ejemplo:

- `cancel_requested_at`, `canceled_at`, motivo opcional.
- Política de descarga del resultado: `auto`, `manual`, `none`; `auto` conserva el comportamiento de generaciones anteriores, `manual` para catálogo importado.
- No usar únicamente un valor nuevo de `state` sin revisar todos sus consumidores: `step`, `runBlock`, `retryBlock`, `recover`, progreso y frontend pueden reactivar el trabajo.

No es obligatorio crear una clase por tabla ni un repositorio genérico. Métodos concretos en `Store` y un módulo pequeño para sincronización son suficientes.

## 8. Migración y conservación de datos

1. Con la instancia detenida, identificar **la biblioteca que se va a migrar**. Respaldar SQLite mediante una copia consistente, incluidas las escrituras WAL, y conservar `data/` y `exports/`.
2. Examinar duplicados e importaciones históricas. No atribuir otro perfil a una fila basándose en su título.
3. Si hay dos filas conflictivas para la misma clave cuenta/cuaderno, emitir un informe y bloquear la nueva vinculación de esa clave hasta resolverla. No borrar filas o audios silenciosamente para poder crear un índice.
4. Aplicar las nuevas tablas/columnas en transacción y registrar la nueva versión solo tras éxito. Una biblioteca de una versión futura debe rechazarse con un mensaje de actualización, no degradarse.
5. Crear el índice único compuesto cuando no existan conflictos. Mantener defensa de idempotencia y transacción en el código, no solo en el frontend.
6. Poblar el catálogo desde los bloques que ya tienen `artifact_id`, preservando cuenta de generación y rutas existentes. No ejecutar descargas ni generaciones durante esa migración.
7. Los bloques importados con `hash` remoto, sin fuente local, no deben entrar automáticamente en `generate` aunque el artefacto esté fallido. Conservar su historial y llevarlos a descarga manual/error de contenido remoto.
8. Un audio externo con varias fuentes debe conservar el conjunto completo. Un audio generado por un bloque conserva la validación estricta de su única fuente.
9. No renombrar archivos existentes para imponer la nueva distribución por cuenta. Para nuevas descargas se puede usar `exports/<perfil>/<libro>-<id-local>/<tipo>/...`; guardar la ruta efectiva y mantener enlaces históricos.
10. Comprobar específicamente que `updateBlockOutputPaths()` no borre o sobrescriba otra descarga al resolver nombres iguales. La ampliación no debe apoyarse en borrar el destino como solución a una colisión.

## 9. Algoritmo de sincronización

Sincronizar es reconciliar **metadatos remotos hacia el catálogo local**. No es `nlm source sync`, que actualiza fuentes de Drive y puede modificar su contenido remoto.

Secuencia por `(profile, remoteNotebookId)`:

1. Validar perfil, IDs e identidad vinculada. Reutilizar su `Provider` inmutable, con el runtime correcto.
2. Crear/reutilizar una vista local de un cuaderno remoto existente con `state=ready`; **no llamar a `createBook()` remoto**.
3. Registrar una operación y agrupar dobles clics simultáneos de esa misma clave.
4. Consultar título/detalle del cuaderno, fuentes, todas las páginas de Studio y notas. El fallo de una sección no invalida la información válida de otras.
5. No usar `.catch(() => [])`. Devolver por sección `complete`, `error`, `items`, fecha de éxito y si se está mostrando caché.
6. Acumular una sección paginada antes de publicarla. Detectar páginas repetidas, IDs duplicados y ausencia de progreso. Si se aplica un límite operativo, informar `truncated=true`; no declarar completitud.
7. Normalizar tipos y estados mediante un mapa explícito. Conservar valores originales desconocidos. Una fecha inválida se representa como desconocida, no rompe toda la vista.
8. Hacer upsert en una transacción corta por sección completa, sin transacción SQLite abierta durante la red. Si se conserva una sección parcial, marcar explícitamente que es parcial y no usarla para inferir ausencias.
9. Actualizar títulos/estados sin tocar archivos descargados ni decisiones locales de cancelación.
10. Marcar un elemento como ausente solo tras una lectura completa y válida de su sección. Ausencia no significa necesariamente eliminación: puede haber permisos revocados. Distinguir `not_visible` de una eliminación confirmada por una operación propia.
11. No borrar archivos locales por una desaparición remota. Mostrar “Ya no visible en esta cuenta; copia local conservada”.
12. Persistir resumen por sección y entregar contadores: fuentes, tipos de Studio, notas, nuevos, actualizados y no visibles.

La interfaz puede seguir consultando el progreso local cada dos segundos. No repetir un inventario remoto completo cada dos segundos. Actualización remota manual y seguimiento con backoff únicamente de trabajos activos.

## 10. Añadir material a un cuaderno sincronizado

1. La acción parte de un **ID local de vista**; el backend obtiene perfil e ID remoto de esa fila. No usa el selector global para decidir el destino.
2. Comprobar acceso de escritura con una lectura de permisos. La lectura de un cuaderno no prueba acceso de editor.
3. No invocar `Accounts.verify()` en su forma actual, porque puede compartir automáticamente. Separar comprobación de permisos de invitación; la nueva función de comprobación no cambia permisos.
4. Si el rol no puede comprobarse: seguir permitiendo explorar/descargar si esas lecturas funcionan, pero bloquear escritura con una explicación y reintento. No ascender permisos automáticamente.
5. Reutilizar la validación actual de MD/PDF, copia local, tamaño, UTF-8, hash y subida idempotente.
6. Subir al `remote_id` existente; conservar el resto de fuentes y artefactos. No llamar a creación de cuaderno como fallback de un 403/404.
7. Esperar a la preparación de cada nueva fuente y reflejarla en el catálogo con su ID real.
8. No deduplicar una fuente remota por título. Un hash local conocido permite deduplicar copias locales de ese mismo contenido; si el contenido remoto no tiene hash comparable, no afirmar equivalencia.
9. Crear bloques solo para las nuevas entradas locales que el usuario quiere gestionar. Generar requiere que el usuario seleccione fuentes/bloques y pulse la acción correspondiente.
10. Para generar audio de una fuente remota seleccionada, construir un bloque enlazado a su ID real sin inventar archivo Markdown local; adaptar el modelo para admitir fuente remota sin archivo de origen.
11. Por cada audio por bloque, enviar exactamente un ID de fuente. Si desaparece o no está lista, detener ese bloque con error; nunca recurrir a todas las fuentes.
12. Conservar idioma `es-419`, formato `deep_dive`, duración `default`, numeración y modo diferido actuales, salvo elección explícita del usuario.

## 11. Detener trabajos: semántica exacta

### 11.1 Cuatro acciones distintas

| Acción de interfaz | Efecto garantizado por la aplicación | Límite que debe mostrarse |
|---|---|---|
| **Pausar nuevas generaciones** | No solicita nuevos audios del libro; permite reanudar | Lo enviado a Google sigue allí; conservar seguimiento/descargas según política existente. |
| **Cancelar este bloque** | Retira sus siguientes pasos locales y evita reintentos/reanudación automática | Si ya se envió a Google, su generación remota puede continuar. |
| **Cancelar bloques pendientes** | Cancela los bloques seleccionados aún no enviados; registra cuáles ya estaban enviados | No prometer cancelar diez trabajos si diez ya recibieron un ID remoto. |
| **Eliminar contenido de NotebookLM…** | Solicita eliminación del artefacto exacto y verifica su resultado | Es irreversible; no demuestra parada del cómputo ni devolución de cuota. |

Cancelar un bloque no elimina su fuente. Eliminar un audio no elimina otros audios ni su cuaderno. No añadir borrado del cuaderno como atajo.

### 11.2 Decisión por punto del ciclo

| Punto actual | Tratamiento |
|---|---|
| Antes de subir una fuente o enviar generación | Persistir cancelación y excluir el trabajo; no enviar la próxima llamada. Conservar los archivos ya copiados para recuperación. |
| Subida en vuelo o creación con baseline sin respuesta concluyente | Persistir intención; conservar diario; consultar resultado remoto. No reintentar creando otra fuente/audio. |
| Audio con `artifact_id`, pendiente/diferido/generando | Detener siguientes pasos automáticos locales del bloque; conservar ID y perfil. Ofrecer consulta manual o eliminación remota aparte. |
| Descarga en curso | Abortar solo esa descarga, conservar el original completo si ya existía y no publicar un temporal incompleto. |
| Conversión en curso | Detener solo ese FFmpeg; conservar el M4A original y no publicar un MP3 parcial. |
| Audio/archivo ya terminado | No llamarlo generación cancelada. Ofrecer conservar, eliminar copia local mediante acción separada, o eliminar remoto con confirmación. |

Para trabajos cancelados con solicitud remota incierta, permitir consultas acotadas de reconciliación para descubrir el ID y cerrar el diario. Esas consultas no deben reactivar generación ni descarga. Si no se puede identificar un resultado único, mostrar “Revisión necesaria; solicitud remota incierta”.

### 11.3 Evitar carreras y reactivaciones

- Guardar la intención antes de responder al POST de cancelación. Una cancelación repetida debe ser idempotente.
- Revisar cancelación al seleccionar trabajo y después de cada `await` anterior a una escritura remota o publicación de archivo.
- Justo antes de enviar generación: releer cancelación/pausa, guardar baseline y perfil, y despachar sin otro `await` intermedio que abra una carrera evitable.
- Si la cancelación llega mientras la llamada remota está en vuelo, guardar el `artifact_id` que responda, pero **sin borrar la intención de cancelar**. El callback no puede volver a poner el bloque en funcionamiento normal.
- `recover()`, `retryBlock()`, reanudación de libro, comprobación de sesión y fin de cuota deben respetar esa intención.
- Reintentar una descarga cancelada requiere acción explícita. Regenerar un audio cancelado es otra solicitud explícita; no es un reintento técnico invisible.
- No usar `Provider.close()` ni `runner.close()` para cancelar un bloque. El runner compartido afectaría a otras cuentas.
- Añadir cancelación por operación al runner existente mediante una señal/handle del proceso concreto. Terminar solo el proceso/árbol propio de ese trabajo; retirar listeners y temporizadores al cerrar. El runner debe seguir aceptando otras operaciones.
- Matar el proceso CLI de creación **no demuestra que Google no haya aceptado el trabajo**. Si ya estaba despachado, conservar la respuesta incierta y reconciliar.
- No borrar ni truncar el diario para que una cancelación parezca exitosa.

### 11.4 Eliminación remota explícita

Flujo independiente de la cancelación local:

1. Mostrar cuenta, título del cuaderno, tipo, título e ID corto del artefacto. Advertir que el borrado es remoto e irreversible y que afecta a otras cuentas con acceso al mismo cuaderno compartido.
2. Solicitar confirmación específica del elemento/selección. Nunca deducirla de “sincronizar”, “descargar” o “detener”.
3. Revalidar permiso y pertenencia de cada ID a ese cuaderno en ese perfil. No aceptar un ID arbitrario del navegador sin validarlo.
4. Persistir operación/intención; impedir que la cola reintente generar o descargar ese contenido mientras se resuelve.
5. Ejecutar `studio delete` mediante `spawn`, argumentos separados y perfil fijado. El `--confirm` representa la confirmación ya obtenida en la interfaz.
6. Consultar Studio de nuevo. Un error de red o una lista parcial no prueba eliminación. Una respuesta incierta deja `uncertain` y una comprobación posterior; no un check verde falso.
7. Marcar ausencia confirmada tras lecturas completas válidas y guardar evidencia mínima de la operación. No afirmar que el cómputo se detuvo.
8. Conservar una marca local que evite reimportación automática. Si Google vuelve a listar el ID, mostrar “Contenido reapareció” y pedir revisión; no entrar en un bucle de borrados automáticos.
9. Conservar la copia local salvo que el usuario elija borrarla por separado.
10. Para un lote, confirmar la lista exacta, devolver resultado por elemento y no ocultar fallos detrás de un éxito global.

La eliminación de fuentes/notas puede incorporarse después como acción separada. Es capacidad comprobada del conector, pero no requisito para implementar la parada local de bloques.

## 12. Descargas manuales y otros tipos

Mantener descarga individual y por selección. Sincronizar no selecciona todos los contenidos ni encola descargas.

| Tipo | Entrega inicial razonable | Observación |
|---|---|---|
| Audio | M4A original y MP3 mediante FFmpeg existente | Nunca renombrar M4A como MP3. Conservar original hasta validar. |
| Vídeo | MP4 | No enviarlo a conversión MP3 salvo una función futura expresamente solicitada. |
| Informe | Markdown | Mostrar texto con escape; no ejecutar HTML incrustado. |
| Diapositivas | PDF; PPTX si el runtime acepta `--format pptx` | Ayuda local comprobada. Validar cada formato. |
| Infografía | PNG | No regenerar para obtener descarga. |
| Mapa mental | JSON | Usar el adaptador existente del conector; sus IDs pueden requerir tratamiento distinto de Studio estándar. |
| Cuestionario | JSON y Markdown; HTML exportable si se trata de forma segura | El CLI ofrece los tres formatos. |
| Tarjetas de estudio | JSON y Markdown; HTML con la misma condición | No clasificarlas como audio por falta de campo. |
| Tabla de datos | CSV inicialmente | El servicio/MCP también contempla XLSX, pero la ayuda CLI de `download data-table` inspeccionada no expone formato XLSX. Habilitarlo solo con adaptador/contrato comprobado; no inventar un flag. |
| Nota | Lectura y exportación TXT/MD cuando la API devuelva contenido | Nota y artefacto son clases diferentes. |
| Fuente remota | Metadatos y texto extraído cuando esté disponible | No prometer descargar el PDF/archivo original desde el texto extraído. |
| Tipo desconocido / archivo genérico | Mostrar tipo original y enlace remoto | Descarga deshabilitada con motivo hasta tener un adaptador conocido; nunca asumir audio o extensión arbitraria. |

Reglas de ejecución:

- Fijar perfil, cuaderno, artefacto y formato al crear el trabajo. Un cambio de selector no cambia su destino.
- Solo descargar artefactos listos. Para pendientes, mostrar estado y, si el usuario lo solicita, “Descargar cuando termine”; esa intención debe persistir, no equivale a regenerar.
- Si falta un ID o el inventario no lo encuentra, devolver error explícito. No usar el artefacto más reciente como sustituto.
- Validar el archivo local antes de marcar `done`; la mera existencia de una ruta en SQLite no es suficiente.
- Usar temporales en el mismo volumen y renombrado final. Resolver colisiones de forma estable sin sobrescribir archivos de otros contenidos/cuentas.
- Mantener progreso y reintentos por descarga. Un fallo de conversión repite conversión; uno de descarga repite descarga. Ninguno crea un podcast nuevo.
- Un lote devuelve aceptados, existentes y rechazados, por ID. Conservar selección de los rechazados en la interfaz.
- Los audios importados pueden basarse en varias fuentes. La validación de una fuente exclusiva solo corresponde a los trabajos que esta app creó por bloque.
- Para servir archivos, resolver desde IDs de trabajos y rutas persistidas confiables; no aceptar rutas arbitrarias ni URLs de descarga proporcionadas por el navegador.
- Mantener protección de origen/token y MIME correcto. El HTML exportado de cuestionarios/tarjetas es contenido no confiable: preferir descarga como adjunto; si se previsualiza, aislarlo del origen que conoce el token local. No usar `innerHTML` sin tratamiento.

Implementar un mapa literal pequeño `tipo -> formatos y método del Provider`. No un framework extensible de plugins ni un único downloader que convierta todo a audio.

## 13. API propuesta y compatibilidad

Conservar los endpoints existentes de cuentas, libros, bloques y reproducción. Añadir contratos explícitos; los nombres siguientes son la propuesta que debe implementar la otra IA, **no endpoints que ya existan**.

| Método y ruta propuesta | Función |
|---|---|
| `GET /api/remote/notebooks?profile=P` | Mantener listado remoto, con cuenta en cada resultado. |
| `POST /api/remote/notebooks/:remoteId/sync` | Body `{profile, requestId}`; vincula vista y agenda lectura de catálogo. No crea cuaderno remoto. |
| `GET /api/books/:id/catalog` | Catálogo persistido, cuenta, capacidades y completitud por sección. Filtros por kind/type sin cambiar el perfil. |
| `POST /api/books/:id/sync` | Actualizar esa vista, tomando el perfil de la fila local. |
| `PUT /api/books/:id/files?...` | Reutilizar subida existente con verificación de permisos y destino fijo. |
| `POST /api/books/:id/generations` | Audio sobre IDs explícitos de fuentes seleccionadas; semántica por bloque, sin generar a partir de todo el cuaderno por omisión. |
| `POST /api/books/:id/downloads` | Selección de `{itemId, format}` y `requestId`; no activa `book.running`. |
| `GET /api/downloads` | Estados de trabajos, filtrables por vista/cuenta. |
| `GET /api/downloads/:id/file` | Archivo final validado; Range para medios cuando corresponda. |
| `POST /api/downloads/:id/cancel` | Cancelación de esa descarga/conversión, sin afectar otros runners. |
| `POST /api/blocks/:id/cancel` | Intención persistente de cancelar ese bloque. |
| `POST /api/books/:id/cancel-pending` | Lista explícita de bloques; resultado local/ya enviado por elemento. |
| `POST /api/books/:id/artifacts/:itemId/delete` | Confirmación explícita y operación remota registrada. No un GET ni un borrado implícito. |
| `GET /api/operations/:id` | Estado de sincronización o eliminación, incluidas respuestas inciertas. |

Respuesta de sincronización sugerida: `202 {operationId, bookId}`; consultar progreso local. Cerrar la pestaña no cancela la operación del backend.

Para una operación ya en curso de la misma clave, reutilizar su ID o devolver conflicto claro, no lanzar dos sincronizaciones que compitan.

Mantener `/api/remote/notebooks/:id/import` como compatibilidad temporal si hay consumidores. Internamente deberá validar perfil/IDs y delegar en vinculación + descargas; no conservar la rama que fabrica estados completos y enciende generaciones. Actualizar sus tests y documentar la transición.

Si hay perfil en URL y body, deben coincidir; rechazar ambigüedad. En operaciones por ID local, derivar la cuenta del recurso persistido y no de `accounts.current`.

Usar errores distinguibles (`AUTH_REQUIRED`, `ACCESS_DENIED`, `NOT_FOUND`, `REMOTE_UNAVAILABLE`, `SYNC_PARTIAL`, `PROFILE_ACCOUNT_CHANGED`, `UNSUPPORTED_TYPE`, `REMOTE_RESULT_UNCERTAIN`). No colapsarlos todos en una lista vacía o en “Iniciar sesión”.

## 14. Cambios por archivo

| Archivo | Trabajo concreto |
|---|---|
| `store.mjs` | Migraciones desde esquema real, claves compuestas, catálogo, operaciones y trabajos de descarga; no perder rutas/historial. Corregir ambas identidades de importación. |
| `provider.mjs` | Lecturas de notas/detalle, tipos completos, descarga por tipo e ID, eliminación exacta y cancelación por proceso. Conservar `forProfile`, prefijos Python y puente existentes. |
| `accounts.mjs` | Lectura de permisos sin compartir; preservar identidad de perfil. No reutilizar invitaciones implícitas para sincronizar. |
| `queue.mjs` | Controles persistentes de cancelación; separar descarga manual de generación; mantener envío continuo existente y diarios inciertos. |
| Módulo pequeño de sincronización, si hace falta | Reconciliación por cuenta/cuaderno y completitud por sección. Evitar sobrecargar las rutas HTTP con toda la lógica. |
| `server.mjs` | Contratos de sincronización/control, validaciones por cuenta, compatibilidad de importación, respuestas de error y archivos con MIME correcto. |
| `public/app.js` | Contexto compuesto, invalidación de respuestas tardías, selección manual, catálogo por tipo y acciones inequívocas de cancelar/eliminar. |
| `public/index.html`, `public/style.css` | Secciones/filtros/etiquetas; accesibilidad de selección y diálogos. Reutilizar estilo BloqueAudio, sin rediseño general. |
| `scripts/nlm_bridge.py` | Mantener generación diferida; ampliar solo si un formato necesario no tiene contrato CLI pero sí servicio soportado, con prueba específica. No añadir cancelación RPC inventada. |
| `tests/*.test.mjs` | Ampliar suites existentes y añadir los casos de la sección 16. |
| `README.md` | Diferencias entre sincronizar, descargar, generar, cancelar local y eliminar remoto; bibliotecas y límites reales. |
| Electron/instalador | Cambiar solo lo necesario para incluir módulos y versión cuando se solicite distribución. No romper `userData` histórico ni accesos ya corregidos. |

## 15. Orden de ejecución y condiciones de salida

### Fase 0 — Diagnóstico y protección

- Confirmar carpeta D:, rama, commit y runtime efectivo de navegador y Electron.
- Leer estado actual y consumidores. Preparar respaldo de la biblioteca de prueba/migración.
- Reproducir con proveedores simulados F01–F12 y dejar fallando solo las pruebas nuevas pertinentes.

**Salida:** pruebas que muestran mezcla de cuentas, pérdida de errores y descarga que puede regenerar; cero mutaciones reales en Google.

### Fase 1 — Identidad multicuenta

- Corregir consulta, claves de petición, restricciones y asociaciones en frontend.
- Guardar contexto y limpiar/inutilizar respuestas al cambiar de cuenta.
- Etiquetas y errores por cuenta visibles.

**Salida:** A y B no comparten estado local por accidente, aun viendo un cuaderno compartido. No generar ni compartir nada al explorar.

### Fase 2 — Sincronización persistente

- Implementar catálogo, operaciones y reconciliación completa/parcial.
- Sincronizar sin seleccionar/descargar por defecto. Volver a abrir desde biblioteca sin ir al explorador remoto otra vez.
- Persistir título, fuentes, artefactos, notas y su cuenta de acceso.

**Salida:** dos sincronizaciones equivalentes no duplican filas ni alteran archivos; un fallo remoto no borra el catálogo.

### Fase 3 — Descarga manual segura

- Implementar trabajos separados para audios importados y reutilizar descargas locales existentes.
- Corregir origen multifFuente, validación de IDs y fallidos remotos.
- Conservar lote manual, reproducción y apertura de carpeta.

**Salida:** descargas y reintentos no invocan `generate`, ni siquiera ante artefactos fallidos o desaparecidos.

### Fase 4 — Añadir material y elegir generaciones

- Acceso de escritura comprobado sin invitaciones automáticas.
- Subidas a cualquier cuaderno vinculado con rol suficiente, y selección de fuentes para generar.
- Evitar regeneración de fuentes antiguas no seleccionadas.

**Salida:** un cuaderno existente recibe nuevas fuentes; el contador de llamadas remotas a crear cuaderno sigue en cero.

### Fase 5 — Cancelación local y eliminación remota

- Persistencia, carreras, abortos por proceso, recuperación y textos de límite.
- Eliminación remota por ID exacto y confirmación; resultado incierto visible.
- Mantener diarios y bloquear reactivación por cuota, sesión o reinicio.

**Salida:** ninguna cancelación termina procesos de otras cuentas; no se declara detenida una generación remota sin evidencia.

### Fase 6 — Catálogo y descargas de otros tipos

- Adaptadores pequeños, formatos comprobados, tipos desconocidos visibles.
- No extender automáticamente las generaciones por bloques a todos esos tipos.

**Salida:** informe, vídeo y demás contenidos no atraviesan la conversión MP3 ni se presentan como audios.

### Fase 7 — Verificación y entrega

- Ejecutar suite completa, prueba visual con datos simulados, reinicio y migración de copia.
- Documentar resultados y límites. Cerrar todos los procesos propios de prueba.
- Si se pide distribución: actualizar versión, compilar en D:, probar el ejecutable real y verificar su destino de acceso. No dar por actualizada la app por haber compilado otra copia.

## 16. Pruebas de aceptación obligatorias

| Caso | Preparación / acción | Resultado exigido |
|---|---|---|
| A1 | Dos perfiles, títulos iguales, cuadernos distintos | Dos vistas correctamente etiquetadas, cero cruce de fuentes o archivos. |
| A2 | Mismo ID remoto compartido por A y B | Dos vistas locales de acceso, cero creación remota; descargas en la cuenta solicitada. |
| A3 | Cambiar A→B con respuesta de A retrasada | La respuesta de A se descarta; no quedan checks o botones operando sobre A desde B. |
| A4 | Cambiar cuenta global durante una descarga | El trabajo conserva perfil, cuaderno e ID originales. |
| A5 | Reautenticar un perfil con otro correo | No reasignar libros antiguos; bloquear escrituras hasta revinculación. |
| S1 | Sincronizar dos veces 25 fuentes y más de 100 artefactos | Sin duplicación; paginación completa y contadores correctos. |
| S2 | Fallar Studio, completar fuentes | Fuentes actualizadas; Studio conserva caché y error parcial. No se marca todo ausente. |
| S3 | Sesión expirada o 403 | Error de cuenta/permisos; no cuaderno vacío ni nuevo cuaderno de reemplazo. |
| S4 | Límite de 2.000 o página repetida | Incompletitud explícita y ausencia no inferida. |
| S5 | Contenido eliminado fuera de la app | Marcar no visible solo con listado válido; preservar copia local. |
| S6 | Sincronizar y cerrar/reabrir | Catálogo y cuenta disponibles sin tener que descargar. |
| D1 | Descargar audio seleccionado por ID | Cuenta e ID correctos en CLI; MP3 validado, original conservado. |
| D2 | Audio externo con dos o más fuentes | Descarga permitida; conjunto de fuentes completo; cero regeneraciones. |
| D3 | ID no encontrado o estado remoto desconocido | Rechazo o espera explícita; no asumir `completed`. |
| D4 | Audio remoto fallido | Mostrar fallo; descargar/reintentar no llama a creación. |
| D5 | Doble clic y lote con elementos existentes | No hay trabajos duplicados; resultados por elemento. |
| D6 | Conversión fallida o archivo final borrado manualmente | Reintentar etapa adecuada; “descargado” depende de archivo real validado. |
| D7 | Vídeo, informe, diapositivas y tipo desconocido | Adaptador y MIME correctos; desconocido visible sin descarga falsa; cero FFmpeg MP3 para documentos. |
| M1 | Añadir MD/PDF a un cuaderno remoto como editor | Mismo cuaderno, validaciones existentes, fuentes preparadas, sin generación hasta selección. |
| M2 | Añadir como lector | Bloqueo claro; cero invitaciones y cero subidas. |
| M3 | Dos fuentes con el mismo título | No se fusionan por título; IDs reales distintos. |
| C1 | Cancelar antes de enviar | Cero llamadas de creación posteriores para ese bloque. |
| C2 | Cancelar durante el preflight | Última comprobación impide el envío si aún no se despachó. |
| C3 | Cancelar después de despachar y antes de recibir ID | Guardar ID/baseline y cancelación; no duplicar ni descargar automáticamente. |
| C4 | Diez solicitudes ya aceptadas, cancelar todas | Clasificar diez como ya remotas; no prometer que la pausa las retiró. |
| C5 | Cancelar una descarga o FFmpeg mientras otra cuenta consulta | Solo se termina el proceso seleccionado; runner general operativo. |
| C6 | Reiniciar, renovar sesión o restablecer cuota tras cancelar | Ningún bloque cancelado vuelve a generarse o descargarse solo. |
| C7 | Solicitar borrado sin confirmación | Rechazo sin ninguna llamada remota de eliminación. |
| C8 | Borrado pierde respuesta y luego se sincroniza | Operación incierta hasta evidencia válida; no regenerar ni repetir borrados a ciegas. |
| C9 | Borrado remoto confirmado y elemento reaparece | Mostrar revisión; marca local impide reimportación automática y bucle de borrado. |
| R1 | Migrar una copia de esquema 4 con archivos y trabajos pendientes | Backup consistente, datos/rutas/perfiles preservados, migración idempotente. |
| R2 | Versiones futuras o duplicados ambiguos | Detención controlada/informe, sin borrar contenido para hacer pasar el índice. |
| X1 | Títulos Windows reservados, mayúsculas, mismo nombre, rutas maliciosas | Rutas seguras, sin sobrescritura de archivos ajenos ni escape de exports. |
| X2 | Exportación HTML con scripts o markdown malicioso | No accede al token ni ejecuta contenido en el origen de la aplicación. |
| P1 | Prueba con proveedor simulado de 25 fuentes, 3 cuentas y varios tipos | Selección, filtros, sincronización parcial, reanudación y cancelación visibles. |

Los tests nuevos deben registrar llamadas de lectura, subida, creación, descarga, invitación y borrado por separado para poder afirmar los “cero llamadas” anteriores. Ampliar `tests/remote.test.mjs`, `accounts.test.mjs`, `queue.test.mjs`, `server.test.mjs`, `migrations.test.mjs` y `media.test.mjs`; reutilizar helpers, no duplicar todo el arnés.

La prueba real de eliminación, si se autoriza después, debe usar un contenido desechable expresamente identificado. No borrar un artefacto personal para demostrar que la función existe. Si no se prueba la eliminación de un artefacto pendiente, documentar esa limitación: no declararla cancelación remota soportada.

## 17. Entrega que debe presentar la IA implementadora

- Rama y commits de la carpeta D:, con listado de archivos modificados.
- Migración y procedimiento de recuperación documentados.
- Casos comprobados, errores encontrados y limitaciones que sigan abiertas.
- Evidencia de cuenta visible en libros y trabajos, sincronización sin descargas y cancelación persistente.
- Confirmación de que no dejó servidores/procesos de prueba abiertos.
- Si preparó EXE por petición posterior: ruta exacta, versión comprobada **en ejecución**, biblioteca utilizada y acceso de Windows verificado. No afirmar visibilidad en Inicio solo por la existencia de un `.lnk`.
- Ninguna afirmación de “Google detuvo el procesamiento” basada únicamente en matar una CLI, pausar una cola o recibir éxito de `studio delete`.

## 18. Fuentes de comprobación y límites de evidencia

### Código local revisado

- Proyecto activo: `D:\apps-2026\auto-notebooklm`.
- `store.mjs`: migraciones 1–4, `importRemoteBook`, `importRemoteBlock`, rutas de salida y recuperación.
- `server.mjs`: explorador remoto, importación, subida, cola y reproducción.
- `public/app.js`: selección de cuenta/cuaderno, refresco y descarga remota.
- `provider.mjs`, `accounts.mjs`, `queue.mjs`, `scripts/nlm_bridge.py`.
- `electron/paths.mjs` y `electron/main.mjs`: bibliotecas de escritorio y runtime incluido.

### Conector local

- Ayudas de `nlm --version`, `studio`, `studio delete`, `studio status`, `source`, `source delete`, `note list` y descargas por tipo.
- Paquete `notebooklm_tools`: `mcp/tools/studio.py` (`studio_status`, `studio_delete`), `services/studio.py`, `core/studio.py` y `services/downloads.py`.
- Runtime incluido en `C:\Users\Rescate\AppData\Local\Programs\auto-notebooklm\resources\runtime-bootstrap`: comprobada la ayuda `studio` y la presencia de `studio_delete` en su implementación MCP.
- Estos son contratos observados, no una prueba de que todos los permisos, planes, tipos o estados remotos funcionen en todas las cuentas.

### Documentación primaria consultada

- [Repositorio oficial del conector](https://github.com/jacob-bd/gemini-notebook-mcp-cli).
- [Referencia CLI: Studio, descargas y perfiles](https://github.com/jacob-bd/gemini-notebook-mcp-cli/blob/main/docs/CLI_GUIDE.md).
- [Referencia CLI en texto](https://raw.githubusercontent.com/jacob-bd/gemini-notebook-mcp-cli/main/docs/CLI_GUIDE.md).

La rama `main` de la documentación puede evolucionar más rápido que el runtime empaquetado. Para cada formato o acción nueva, prevalecen la ayuda y el código de la versión que realmente ejecuta la aplicación, seguidos de pruebas de contrato. No actualizar dependencias globales ni el runtime solo para hacer coincidir una suposición del plan.

## 19. Criterio final de éxito

El usuario puede abrir un cuaderno de la cuenta A, sincronizarlo sin descargar nada, ver todo el catálogo disponible y elegir descargas; cambiar a B sin contaminación de estados; añadir fuentes al mismo cuaderno cuando tenga permiso; y retirar un bloque de su cola sin que reviva al reiniciar.

Cuando el trabajo ya esté en Google, la aplicación explica ese límite, conserva su identidad y permite la eliminación remota explícita que el conector sí ofrece. La ampliación a otros contenidos muestra solo las capacidades que estén comprobadas, sin convertir todo en audio ni prometer una cancelación que el proveedor no expone.
