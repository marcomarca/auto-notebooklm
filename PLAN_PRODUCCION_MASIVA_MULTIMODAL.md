# Plan ejecutable: producción masiva multimodal con cuatro cuentas

Fecha: 17 de octubre de 2026, America/La_Paz. Proyecto: BloqueAudio 1.1.1.
Base inspeccionada: `ac6d2a5a44343a832fb512fee4b1d13a6da177b8`. Esquema SQLite actual: versión 5.

## 0. Encargo, alcance y cómo utilizar este documento

Este documento es el entregable de planificación solicitado. **Las mejoras descritas todavía no están implementadas por este documento.** La siguiente IA debe implementarlas por fases, verificando el código real antes de editarlo. Los nombres nuevos de tablas, rutas y módulos que aparecen abajo son propuestas de implementación, no capacidades existentes.

Objetivo de producto: tomar un libro con bloques ya cortados, solicitar materiales por bloque, completar únicamente los faltantes, aprovechar cuatro cuentas y entregar una biblioteca ordenada, verificable y recuperable tras interrupciones.

Restricción central del usuario: **el conector/MCP ya administra rotación o renovación de credenciales; la concurrencia puede interferir con ese mecanismo.** Preservar su autenticación. No reemplazarla, extraer sus secretos ni crear una segunda lógica de renovación.

Instrucciones para ejecutar:

1. Trabajar en `D:\apps-2026\auto-notebooklm`. No editar otra copia del proyecto ni NotebooklmPRO por confusión.
2. Leer las instrucciones AGENTS aplicables y comprobar `git status` y los cambios posteriores al commit indicado. No sobrescribir trabajo ajeno. Usar FFF primero para búsquedas del workspace; usar herramientas normales para leer y editar.
3. Reutilizar Node 24, SQLite nativo, HTTP nativo, frontend actual, FFmpeg y el runtime del conector. No añadir Redis, microservicios, otro servidor MCP ni un framework para este alcance.
4. Leer `PLAN_SINCRONIZACION_Y_CONTROL_NOTEBOOKLM.md` como contexto histórico. Sus hallazgos describen una versión anterior: varios ya fueron corregidos. Este plan complementa lo implementado; no manda deshacerlo.
5. Implementar fases pequeñas en el orden indicado. Cada fase debe incluir código integrado, pruebas relevantes y una explicación de limitaciones. No declarar una fase completa por haber creado tablas o botones sin conectar el flujo.
6. **Cerrar todos los servidores, ventanas y procesos de prueba propios al terminar, también cuando hay fallos.** Usar `try/finally`, `t.after()` y cierre explícito. No matar procesos del usuario por nombre genérico.
7. Las pruebas normales usarán proveedores simulados y directorios temporales. No consumir cuota ni crear/borrar material real incidentalmente. Una prueba remota debe tener alcance y cuaderno identificados antes de ejecutarse.
8. No publicar releases, instalar un EXE ni modificar las bibliotecas reales como efecto secundario. Preparar distribución después de validar y cuando corresponda al encargo de implementación.

## 1. Lo que ya existe y debe conservarse

| Área | Base existente | Trabajo pendiente |
|---|---|---|
| Fuentes y audio | `blocks`, subida, generación por una fuente exacta, seguimiento, conversión MP3 | Desacoplar fuente y materiales derivados sin perder recuperación |
| Catálogo | `remote_items`, sincronización parcial, tipos normalizados | Asociar resultados a solicitudes y mostrar completitud por bloque |
| Descargas | `download_jobs`, adaptadores de audio, imagen, informes y otros tipos | Integración con materiales solicitados, validación y entrega conjunta |
| Cuentas | `Accounts`, perfiles, permisos, respaldos, rotación por cuota | Reparto justo, identidad estable, estado por restricción real |
| Seguridad de operaciones | Baselines, reconciliación, estados inciertos, cancelación | Extender estas garantías a cada tipo de material |
| Interfaz | Biblioteca, catálogo, selección, cuentas/cuota | Recetas, matriz por bloque, prioridades y entregas |

Archivos principales para leer: `provider.mjs`, `accounts.mjs`, `queue.mjs`, `store.mjs`, `sync.mjs`, `server.mjs`, `public/app.js`, `public/index.html`, `public/style.css`, `scripts/nlm_bridge.py`, `runtime.mjs`, `electron/main.mjs`, `electron/paths.mjs`, `tests/helpers.mjs` y las pruebas del área afectada.

Dos distinciones obligatorias:

- Ya se descargan infografías existentes mediante `Provider.downloadInfographic()`. Lo nuevo es solicitarlas en serie por bloque y gestionarlas junto al audio.
- `Queue.tick()` serializa la cola local, pero después de enviar una generación se guarda el ID y se consulta más tarde. Google puede procesar varios trabajos ya aceptados. No volver a esperar la terminación completa de un audio antes de enviar el siguiente por confundir ambos niveles.

## 2. Arquitectura obligatoria de autenticación y ejecución

### 2.1 Decisión inicial: todas las llamadas al conector en serie

**La primera versión NO implementará cuatro procesos remotos simultáneos, ni siquiera uno por perfil.** Tener cuatro cuentas no demuestra que su almacenamiento de sesión, navegador o renovación sea independiente.

Crear una puerta compartida, por ejemplo `ConnectorGate`, con capacidad fija inicial de **una operación del conector en toda la aplicación**. No exponer todavía un control de usuario para subir esa capacidad.

La puerta debe cubrir:

- CLI de generación, listado, cuota, fuentes, descargas, permisos, sincronización y eliminación.
- Bridge Python y cualquier acceso alternativo al mismo conector.
- Comprobaciones de salud, descubrimiento de perfiles y autenticación interactiva.
- Llamadas iniciadas por endpoints o acciones de la interfaz, aunque no provengan de `Queue`.

El bloqueo actual `Queue.busy` no cubre todos esos caminos. `Accounts.checks` solo deduplica comprobaciones por perfil; tampoco es un cerrojo global de credenciales.

Crear una sola instancia de la puerta en la composición de la aplicación (`makeApp()` o equivalente) e inyectarla en todos los proveedores, incluyendo `forProfile()` y la fábrica alternativa de `Accounts`. No crear un cerrojo nuevo dentro de cada proveedor. Mantener los `CommandRunner` separados para poder cancelar procesos propios sin cerrar los demás proveedores.

Una ubicación práctica del acceso protegido es `Provider.cli()` y `Provider.bridge()`: ambos deben compartir la misma puerta. Los métodos de dominio como `access()` pueden invocar varias llamadas protegidas sucesivas. **No envolver además esos métodos con otro `acquire()` no reentrante:** produciría interbloqueos.

La puerta se adquiere antes de iniciar el proceso y se libera cuando el proceso termina, en `finally`, también con timeout, salida inválida o cancelación. Una solicitud que espera turno debe poder cancelarse sin llegar a ejecutar el comando. El cierre debe rechazar nuevas solicitudes, resolver/rechazar las pendientes y esperar o terminar solo los hijos propios.

El tiempo de espera en la puerta y el timeout del comando son conceptos distintos: el timeout del comando comienza cuando este se inicia. Usar orden FIFO estable entre solicitudes de igual prioridad. Acotar y deduplicar las consultas periódicas para no acumular cientos de procesos futuros.

### 2.2 Cuatro cuentas útiles sin concurrencia del conector

Ejemplo esperado:

1. Enviar material A con cuenta 1; guardar su ID remoto; liberar puerta.
2. Enviar material B con cuenta 2; guardar su ID remoto; liberar puerta.
3. Mientras Google procesa A y B, convertir un archivo local ya descargado.
4. Cuando corresponda consultar A, adquirir la puerta, consultar y liberarla.

La puerta no permanece ocupada durante minutos esperando a que Google termine. Si un comando actual incorpora una espera interna, conservar su comportamiento inicialmente y medirlo; separar envío y consulta solo si el contrato del conector lo permite y queda probado. No modificar flags de subida o generación a ciegas.

Las conversiones FFmpeg, validaciones locales y preparación de entregas pueden ejecutarse fuera de la puerta, inicialmente con **un trabajo local pesado a la vez**. La descarga sí usa conector y ocupa la puerta hasta terminar. Separar la conversión posterior para que no la retenga.

### 2.3 Renovación, identidad y límites del cerrojo

La lectura estática muestra delegación a `notebooklm-mcp-cli` y al bridge; **no demuestra el alcance interno del almacenamiento ni de la rotación de llaves**. Tratar la restricción del usuario como un requisito, no como una hipótesis que permite paralelizar hasta que falle.

Antes de cambiar ejecución, documentar sin exponer secretos:

- Qué runtime/binary usa desarrollo y cuál Electron; si comparten almacenamiento de perfiles.
- Si la renovación ocurre al consultar, dentro de cualquier RPC o mediante un proceso externo.
- Si existen otros clientes que usan esas credenciales simultáneamente.
- Qué perfil e identidad efectiva se usan antes y después de renovar.

Una puerta en memoria coordina esta aplicación, no otros procesos ni otras carpetas de datos. El bloqueo existente por `dataDir` tampoco protege dos instalaciones que comparten credenciales. Si se detecta ese uso compartido, integrar exclusión entre procesos sobre el recurso real mediante un mecanismo comprobado. No inventar un archivo de bloqueo en una carpeta arbitraria ni borrar locks ajenos por antigüedad. Si no puede garantizarse exclusión, mostrar la limitación y no afirmar seguridad entre procesos.

Conservar la renovación automática del conector dentro de la ejecución protegida. Ante `AUTH_REQUIRED`, no lanzar una tormenta de logins ni reintentar una creación incierta. Agrupar comprobaciones de la misma cuenta. El login explícito debe entrar a la misma puerta; evitar nuevas solicitudes hasta que termine. El callback `onReady` o un `discover()` posterior debe ejecutarse después de liberar el permiso del comando de login, sin adquirirlo recursivamente.

Persistir la identidad esperada de cada intento. Si un perfil pasa a representar otro correo, bloquear los intentos asociados a la identidad anterior hasta revisión. No cambiarles silenciosamente de cuenta. En generación nueva sin envío previo se puede seleccionar otra cuenta autorizada; para un resultado ya aceptado se conserva su cuenta/identidad de acceso original según el contrato existente.

### 2.4 Barrera de solicitudes inciertas por cuaderno

La serialización de procesos no evita que dos generaciones pendientes resulten ambiguas al reconciliar. Cuando se envía una creación, persistir antes el intento y su baseline. Si la respuesta es incierta, colocar una barrera persistente para nuevas creaciones de Studio en ese **ID de cuaderno remoto**, incluso desde otro perfil o vista local. Liberarla tras reconciliar inequívocamente o resolver manualmente.

No mantener un mutex de proceso ocupado durante esa revisión: la barrera es un dato del planificador y permite trabajar en otros cuadernos. Las consultas, descargas y sincronización de lectura necesarias para resolverla siguen permitidas. Un cambio externo de Studio puede seguir provocando ambigüedad; no prometer exactamente una ejecución remota si Google no ofrece una clave idempotente.

## 3. Modelo de datos: ampliar la base, no sustituirla

### 3.1 Responsabilidades

- `books`: libro y vinculación de cuenta/cuaderno. Conservar la identidad local actual `(profile, remote_id)`.
- `blocks`: bloque/fuente, posición, título, hash y procedencia. Seguir usando los IDs existentes.
- `remote_items`: inventario observado en Google. No utilizarlo como lista de deseos de producción.
- `download_jobs`: autoridad sobre la ejecución de descargas. No crear un segundo descargador incompatible.
- Nuevas `production_recipes`: recetas con versión y configuración inmutable por versión.
- Nuevas `material_tasks`: una solicitud de resultado concreto para un bloque, tipo y revisión.
- Nuevos `material_attempts`: diario de cada intento de envío a Google y de su resolución.
- Nuevos `production_events`: transiciones e incidencias relevantes, con datos mínimos sin credenciales.

La receta inicial admite `audio` e `infographic`. `report` entra después de probar ese recorrido. Los demás tipos siguen descargándose si ya existen; no activar su generación automática por haber añadido columnas a la matriz.

### 3.2 Campos y restricciones mínimas

`production_recipes`: `id`, `version`, `name`, `config_json`, `created_at`, clave única `(id, version)`. Guardar en el libro la referencia de receta/version aplicada. Editar crea versión; no sobrescribe configuraciones utilizadas.

`material_tasks`: `id`, `book_id`, `block_id`, `type`, `revision`, `is_current`, `source_fingerprint`, `recipe_id`, `recipe_version`, `params_json`, `params_hash`, `state`, `editorial_state`, `priority`, `next_at`, `retry_count`, `error_code`, `error`, `selected_attempt_id`, `selected_remote_item_id`, `selected_download_job_id`, `created_at`, `updated_at`, `canceled_at`.

Aplicar claves foráneas e índices por estado/fecha y libro/bloque. Clave única `(block_id, type, revision)` y un índice único parcial de `(block_id, type)` para `is_current=1`. Primera versión: un material actual por tipo/bloque; no construir variantes ilimitadas. La promoción de una nueva revisión debe ser transaccional.

`material_attempts`: `id`, `task_id`, `attempt_number`, `profile`, `expected_identity`, `remote_notebook_id`, `source_ids_json`, `baseline_json`, `state`, `artifact_id`, `submitted_at`, `resolved_at`, `error_code`, `error`. Clave única `(task_id, attempt_number)`. Conservar todos los IDs anteriores cuando se autorice un nuevo intento; no borrar el historial para reutilizar una fila.

`production_events`: `id`, `task_id` opcional, `book_id`, `attempt_id` opcional, `event`, `from_state`, `to_state`, `reason`, `created_at`. Registrar cambios de estado y decisiones importantes, no cada refresco de UI ni cada cookie. Índice por libro/fecha y retención documentada.

El fingerprint de fuente local parte del hash ya disponible. Para fuentes remotas sin hash fiable registrar ID y versión conocida; si Google no informa cambios, marcar la revisión de fuente como desconocida en vez de inventar un checksum del contenido no leído. Nunca casar una fuente solo por título.

El hash de parámetros se calcula sobre JSON canónico de parámetros efectivos, incluyendo instrucciones, idioma y configuración relevante. No incluir fechas ni ordenar arrays cuyo orden tenga significado. Si una actualización del conector cambia el resultado semántico, registrar esa versión en el intento y evaluar una nueva revisión explícita.

### 3.3 Migración y compatibilidad: recorrido obligatorio

1. Crear fixtures de bases v5 con bloques terminados, pendientes, con cuota, `auth`, cancelados y con baseline incierto; incluir `download_jobs` en curso.
2. Añadir una migración transaccional nueva después de v5, sin eliminar columnas viejas ni renombrar archivos en disco. Probar reapertura idempotente y fallo intermedio con rollback.
3. Crear tareas de audio equivalentes a los bloques antiguos. Preservar todos sus IDs, cuentas, estados, fechas, baselines y rutas; los casos ambiguos deben quedar en revisión, nunca listos para reenviar.
4. Vincular descargas existentes cuando la correspondencia por ID exacto sea comprobable. No asociar automáticamente una infografía a un bloque por parecido de nombre ni por que solo hay una fuente en el cuaderno.
5. Elegir una sola autoridad de ejecución. Una vez migrado el audio a `material_tasks`, el worker antiguo **no** puede seguir despachando el mismo `blocks.stage`. Endpoints antiguos traducen a tareas y los snapshots antiguos se derivan del material de audio, no de dos estados mantenidos por separado.
6. Tras migrar, comprobar invariantes y recuentos antes de arrancar el worker. No activar una migración incompleta mientras todavía despachan ambos recorridos.

No hacer una migración destructiva ni fusionar automáticamente vistas locales de un cuaderno compartido. Detectar una solicitud equivalente en otra vista del mismo cuaderno y mostrarla para vincular/reutilizar con comprobación explícita; no producir duplicados por desconocerla ni mezclar bibliotecas por correo.

## 4. Estados, idempotencia y recuperación

### 4.1 Estados separados

Estado técnico de material:

`planned → queued → submitting → remote_pending → download_pending → ready`

Estados de espera o excepción: `waiting_quota`, `waiting_auth`, `retry_wait`, `review_required`, `failed`, `canceled`. Registrar por separado el estado remoto original (`queued`, `generating`, `deferred`, etc.) en el catálogo/intento. `download_jobs` conserva sus etapas internas y la tarea refleja su resultado.

Estado editorial independiente: `unreviewed`, `approved`, `rejected`. Un archivo descargado válido es técnicamente `ready`, pero no queda aprobado por esa razón. Una nueva revisión parte sin aprobar aunque la anterior sí lo estuviera.

En la matriz, **no solicitado** es ausencia de requisito, no error ni tarea fallida. **Desactualizado** se deriva de que el material actual no corresponde a la receta/fuente deseada; no borrar por ello el archivo existente.

### 4.2 Completar pendientes

La operación de planificación NO llama a Google:

1. Validar libro, fuentes seleccionadas, receta/version y tipos soportados.
2. Calcular requisitos y comparar cada bloque/tipo con tareas, resultados exactos y revisiones existentes.
3. Devolver vista previa: crear, reutilizar, descargar existente, ya completo, desactualizado, sin capacidad, revisión necesaria.
4. Confirmar el plan mediante `requestId` idempotente y una transacción; crear solo tareas ausentes.
5. Una acción explícita de iniciar habilita su ejecución. Evitar que cambiar una receta o abrir una pantalla dispare generaciones.

Dos solicitudes simultáneas o un doble clic deben producir las mismas tareas. Usar restricciones SQL y comparación de parámetros; no basta con consultar antes de insertar. Reutilizar un `requestId` con un payload distinto debe devolver conflicto.

Los resultados existentes que requieran asociación manual se muestran como candidatos. Un artefacto con múltiples fuentes no cumple automáticamente el requisito de una sola fuente por bloque.

### 4.3 Envío y errores

Antes del envío, reclamar atómicamente la tarea en una transacción corta, verificar cancelación y permisos, seleccionar cuenta elegible y persistir el intento/baseline. No mantener transacciones SQLite abiertas durante `await` de red.

- ID aceptado: persistirlo inmediatamente y consultar ese mismo resultado después. No repetir creación porque tarda.
- Timeout, corte o JSON inválido después de posible envío: conservar intento incierto, reconciliar por cuaderno, tipo y procedencia exacta. Nunca reintentar creación a ciegas ni rotarla a otra cuenta.
- Cero coincidencias después de una consulta: puede haber propagación tardía; aplicar espera acotada y luego revisión, no declarar que nunca se creó.
- Varias coincidencias o procedencia desconocida: revisión necesaria, sin elegir la más reciente por intuición.
- Rechazo definitivo previo a aceptación por cuota: se puede seleccionar otra cuenta autorizada.
- Fallo de descarga: reintentar descarga del ID existente, no generación.
- Cancelación local: persistirla y no revivir al reiniciar; indicar que Google puede seguir trabajando si ya aceptó la solicitud. Cancelar no elimina nada remoto.

Al reiniciar, recuperar tareas reclamadas según su etapa: los envíos posiblemente iniciados se reconcilian; los procesos locales incompletos se reanudan desde temporales controlados; descargas interrumpidas vuelven a descarga del ID conocido. Revisar explícitamente la recuperación de `download_jobs` en `downloading`/etapas intermedias y de `remote_operations` en `running`; no dejarlos bloqueados para siempre.

## 5. Recetas y generación multimodal

Ejemplo de receta de usuario:

```json
{
  "name": "Libro de estudio",
  "materials": {
    "audio": { "enabled": true, "language": "es-419", "format": "deep_dive", "length": "default" },
    "infographic": { "enabled": true, "language": "es-419" },
    "report": { "enabled": false }
  }
}
```

Los nombres internos no autorizan traducirlos directamente a flags sin validación. Para cada tipo nuevo:

1. Consultar ayuda y contrato del runtime instalado, sin enviar una generación real. Capturar argumentos y respuestas de ejemplo redactadas para las pruebas.
2. Definir capacidades: generar, generar más tarde, consultar, descargar y formatos permitidos. Distinguir capacidad de generación de capacidad de descarga.
3. Implementar el adaptador en `provider.mjs` siguiendo las convenciones existentes, siempre con perfil explícito y una fuente exacta para el bloque.
4. Normalizar ID, estado y errores sin inferir éxito de una respuesta vacía. Utilizar el mismo mecanismo de ejecución protegida para CLI y bridge.
5. Probar argumentos exactos y recorridos de rechazo, cuota, respuesta incierta y recuperación.

No prometer estilos concretos de infografía, formatos de cuestionario o códigos de idioma que el runtime no confirme. No implementar automáticamente una extensión RPC de infografías copiando la estructura privada del audio.

La función oficial «Generar más tarde» y la espera local por cuota son distintas. La primera necesita soporte comprobado del adaptador y confirmación de aceptación remota. Si no existe, mantener la tarea localmente. El bridge actual de audio usa una extensión propia: preservar compatibilidad, pero no afirmar que siempre evita consumo de cuota ni que extiende esa posibilidad a todos los tipos.

## 6. Cuotas y reparto entre cuatro cuentas

### 6.1 No codificar cuotas independientes por tipo

La documentación consultada describe presupuesto por cómputo, recargas de cinco horas y tope semanal; pueden existir otras restricciones según plan/despliegue. La implementación se basa en lo observado por cuenta, no en una tabla fija de «N audios al día». Referencia: <https://support.google.com/gemininotebook/answer/17670842>.

Guardar observaciones con `profile`, identidad, fecha de lectura, ventanas, ámbito conocido (`shared`, específico o `unknown`), porcentaje y recuperación si se informan. Separar una fecha confirmada de una próxima comprobación estimada. No guardar credenciales ni respuestas crudas con secretos.

Si se agotan varias ventanas aplicables a una operación, deben recuperarse todas; no escoger el primer reset si otra sigue agotada. Un límite de generación no debe bloquear automáticamente lecturas o descargas permitidas. Autenticación y cuota son restricciones diferentes.

Lectura no disponible: cuota desconocida, no cero ni infinita. Respetar `next_at`, reducir comprobaciones repetidas, tratar el rechazo real del proveedor y usar backoff con reloj inyectable en pruebas. No calcular «quedan 12 audios» a partir de un porcentaje de cómputo.

### 6.2 Selección justa

Reemplazar gradualmente la estrategia «propietaria primero hasta agotarse» por selección entre cuentas habilitadas, con identidad verificada, permiso de editor activo, fuente accesible y sin restricción aplicable.

Usar round-robin estable entre candidatas equivalentes, persistiendo el último turno para que un reinicio no favorezca siempre a la misma. Saltar las cuentas en espera sin bloquear las demás. No duplicar fuentes ni crear cuatro cuadernos como estrategia de reparto; conservar el cuaderno compartido existente cuando los permisos lo permitan.

No dar por hecho que cuatro perfiles son cuatro identidades: deduplicar por cuenta comprobada. Si no se puede verificar una identidad, no prometer cuota adicional. No realizar invitaciones remotas como efecto de selección, sincronización o chequeo: distinguir comprobación de acceso de `Accounts.verify()`, que hoy puede invitar.

### 6.3 Equidad entre trabajos

Definir prioridad por libro y FIFO dentro de cada prioridad. Alternar libros del mismo nivel con envejecimiento para que el más antiguo progrese. Acotar consultas de estado y consultas de salud; las descargas no pueden tener prioridad absoluta y permanente sobre todos los envíos.

Reutilizar observaciones recientes de cuota/acceso con invalidación ante errores, en lugar de consultar el inventario completo antes de cada operación. El scheduler solo entrega a la puerta trabajo que ya está habilitado por `next_at`; nunca ocupa su turno durmiendo por cuota.

Registrar tiempos locales, tiempos de espera en puerta, aceptación remota y disponibilidad del resultado. Medir antes de prometer aceleración. Mantener capacidad remota del conector en uno aunque se reparta trabajo entre cuatro cuentas.

## 7. API e interfaz: recorrido verificable

Rutas propuestas, ajustables a convenciones del servidor:

| Acción | Contrato propuesto |
|---|---|
| Recetas | `GET /api/recipes`, `POST /api/recipes`, nueva versión sin alterar la anterior |
| Previsualizar requisitos | `POST /api/books/:id/production/preview` con receta y bloques; solo lectura/planificación |
| Confirmar plan | `POST /api/books/:id/production/plan` con `requestId` y revisión esperada; HTTP 202/200 idempotente |
| Empezar/pausar | `POST /api/books/:id/production/control`; pausar nuevos envíos conserva seguimiento y descarga |
| Ver matriz | `GET /api/books/:id/materials` con paginación y contadores calculados por servidor |
| Gestionar material | Acciones explícitas de reintentar etapa, cancelar, aprobar/rechazar y solicitar nueva revisión |
| Entrega | `POST /api/books/:id/exports`, consulta de su estado y archivo por ID |
| Búsqueda | `GET /api/library/search` con filtros y paginación |

Conservar rutas anteriores de audio como compatibilidad traducida. Validar tipos, parámetros, IDs pertenecientes al libro, token local en escrituras y límites de tamaño existentes. No aceptar rutas de disco arbitrarias enviadas por frontend. El `requestId` y la revisión esperada deben evitar aplicar una previsualización obsoleta: devolver conflicto y regenerar la vista previa cuando cambien fuente o receta.

La pantalla principal de libro muestra:

- Receta aplicada y botón «Preparar pendientes», con resumen antes de iniciar.
- Matriz Bloque × Material. Estados legibles y acciones por celda, sin depender solo de colores.
- Contadores distintos: requeridos, descargados válidos, aprobados, esperando, desactualizados y con incidencias.
- Motivo de espera: turno local, cuota, Google procesando, sesión, permisos o ambigüedad.
- Vista de cuatro cuentas con identidad, observación de cuota y su fecha, siguiente comprobación y tareas asociadas. No etiquetar datos cacheados como tiempo real.
- Avisos locales de libro terminado o intervención necesaria, deduplicados. No notificar cada sondeo.

Buscar primero por títulos, autor/etiquetas y metadatos realmente disponibles. Añadir campos editoriales simples al libro; no construir un CRM comercial de clientes/contactos sin otro requerimiento. La búsqueda de transcripciones completas se difiere hasta tener transcripciones reales.

La UI no debe descargar toda la biblioteca con todos los bloques cada pocos segundos a medida que crezca el catálogo. Añadir respuestas resumidas/paginadas y consultar detalle solo del libro visible. Invalidar respuestas tardías cuando cambie cuenta/libro; conservar las defensas de identidad actuales. Navegación por teclado, foco y etiquetas accesibles para acciones por material.

## 8. Validación de archivos, entrega e integridad

Conservar la validación de audio existente por FFmpeg. Añadir metadatos de duración mediante herramienta disponible/comprobada; si se usa `ffprobe`, comprobar su presencia en desarrollo y en el runtime empaquetado y añadirlo a la construcción si falta. No asumir que viene incluido por tener `ffmpeg`.

Para infografías comprobar firma y decodificación válida, dimensiones y tamaño. En Electron puede aprovecharse una capacidad existente, pero backend y tests también necesitan una validación equivalente; elegir una biblioteca pequeña comprobada solo si las herramientas ya disponibles no bastan. Un encabezado PNG válido por sí solo no demuestra una imagen completa. Para reportes verificar UTF-8 y contenido no vacío; para JSON parsear y validar estructura mínima del tipo. Mantener MIME/extensión reales.

Descargar y exportar primero a temporales propios, validar y renombrar al finalizar. Calcular checksum y tamaño del archivo final. Un archivo ausente o inválido exige descargar otra vez, no generar otra vez. No modificar MP3 existentes solo para agregar metadatos ni perder originales.

Primera entrega: carpeta consolidada, índice HTML estático seguro, `manifest.json` e índice CSV. ZIP es una mejora posterior si añade una dependencia innecesaria al primer recorrido. Escapar títulos en HTML y proteger valores peligrosos de CSV al abrirse en hojas de cálculo.

```text
exports/entregas/<libro-id>/<entrega-id>/
  001 - Bloque/
    audio.mp3
    infografia.png
  index.html
  index.csv
  manifest.json
```

El manifiesto lleva versión de esquema, libro, orden estable de bloques, receta/version, revisiones seleccionadas, tipo/formato, rutas relativas, tamaños, checksums, metadatos de calidad y fecha. No incluir cookies, llaves, rutas absolutas ni correos de cuenta por defecto en entregables.

Una entrega es una fotografía inmutable de revisiones concretas. Cambiar la receta durante el copiado no puede mezclar revisiones. Para primera versión, serializar exportación y mutaciones locales que renombren/eliminen archivos seleccionados; comprobar checksum antes y después. Copiar a nueva carpeta, sin mover ni sobrescribir la biblioteca ni entregas previas.

«Entrega completa» exige todos los materiales requeridos válidos y, si la política lo exige, aprobados. Permitir exportación parcial únicamente como acción explícita, señalando faltantes en interfaz y manifiesto. Nunca confundir «no solicitado» con «faltante».

## 9. Recuperación, respaldo y trazabilidad

Ampliar las garantías de recuperación del audio a todos los materiales y descargas. Cubrir caída tras reservar tarea, tras enviar, tras recibir ID antes de guardarlo, durante descarga, durante conversión y durante exportación.

Respaldo mínimo de primera versión: acción guiada que detiene nuevos trabajos, deja un estado consistente, cierra SQLite limpiamente y copia base, fuentes, originales y resultados necesarios con manifiesto/checksums. No copiar solo `queue.sqlite` mientras WAL está activo. No incluir credenciales del conector ni pretender respaldarlas.

Si se implementa respaldo con la app abierta, usar una API de backup consistente de SQLite y coordinación de archivos; no improvisarlo con copias concurrentes. Restaurar primero en una biblioteca nueva/temporal con app detenida, validar esquema, integridad y rutas y no pisar la biblioteca actual automáticamente. Probar también las rutas distintas de navegador y Electron.

La trazabilidad debe responder: qué se pidió, con qué fuente/receta, cuándo se envió, qué cuenta se usó internamente, qué devolvió Google, qué archivo quedó y por qué se está esperando. Un listado de errores actuales sin historial no responde estas preguntas.

## 10. Fases de implementación y salida exigida

| Fase | Cambios principales | Se puede cerrar cuando… |
|---|---|---|
| 0. Base | Revisar estado real y runtime, fixtures v5, alcance de autenticación | Existe mapa de llamadas y baseline de pruebas simuladas |
| 1. Autenticación protegida | Puerta global en CLI/bridge, inyección a perfiles, cancelación/cierre, login | Pruebas concurrentes confirman máximo una llamada al conector y ausencia de interbloqueo |
| 2. Modelo y compatibilidad | Migración, tareas/intentos, audio al nuevo recorrido, traducción de endpoints | Datos antiguos preservados y un solo despachador de cada generación |
| 3. Recetas y materiales | Vista previa, planificación idempotente, audio + infografía, descarga vinculada | Doble planificación no duplica y ambos materiales completan todo su recorrido simulado |
| 4. Planificador | Cuotas observadas, reparto de cuentas, equidad, barreras inciertas, local separado | Cuatro cuentas se utilizan en serie sin bloquear por una agotada y sin nuevas creaciones ambiguas |
| 5. Interfaz | Matriz, contadores, acciones, búsqueda y paginación | El usuario puede resolver un libro completo desde UI sin interpretar logs |
| 6. Entrega | Validación, metadatos, carpeta/manifiesto/índices, revisión editorial | Entrega consistente y reproducible, faltantes explícitos, archivos válidos |
| 7. Resiliencia | Respaldo/restauración, avisos, pruebas de fallos y empaquetado | Recuperación y cierre de procesos comprobados en desarrollo y desktop |

La fase 1 por sí sola protege el acceso, pero no convierte el sistema en gestor multimodal. Las fases 2–6 forman el recorrido mínimo de producto. No anunciar «producción masiva terminada» dejando recuperación y respaldo sin verificar.

Archivos nuevos razonables: `connector-gate.mjs`, `production.mjs` (planificación/recetas), `delivery.mjs` y pruebas de esas áreas. Crear otros módulos solo si la separación ayuda al código real; no generar una arquitectura de carpetas vacías. Mantener el estilo actual.

## 11. Matriz mínima de pruebas

Ampliar `tests/helpers.mjs` y pruebas existentes con reloj controlado, contadores de comandos activos y errores inyectables. Las pruebas nuevas deben comprobar comportamiento, no copiar la implementación.

| Caso | Evidencia exigida |
|---|---|
| CLI A + bridge B + sync + chequeo de salud concurrentes | Máximo global observado = 1; orden y respuestas correctos |
| Login, callback y perfil nuevo | Ningún comando solapado, bloqueo recursivo ni identidad cambiada silenciosamente |
| Cancelar un comando en espera | Nunca llega a arrancar; la puerta sigue funcionando |
| Fallo, timeout o salida inválida | Permiso liberado; siguiente comando progresa; creación incierta no reenviada |
| Trabajo FFmpeg lento | No ocupa la puerta; consultas remotas pueden avanzar |
| Cuatro perfiles | Round-robin entre elegibles, sin duplicar identidades; conector siempre serial |
| Una cuenta sin sesión o cuota | Se saltan solo restricciones aplicables; otras cuentas progresan |
| Presupuesto compartido y dos ventanas agotadas | No se genera infografía ignorando la misma restricción agotada |
| Cuota desconocida | No se muestra saldo ficticio ni se crea bucle de comprobación |
| Dos clics/reintentos HTTP | Mismas tareas e IDs; payload distinto con misma clave da conflicto |
| Misma fuente, receta nueva | Conserva resultado anterior; nueva revisión solo por acción explícita |
| Infografía existente | Vinculación comprobada y descarga sin ninguna llamada a generación |
| Envío aceptado con respuesta perdida | Reconciliación recupera ID o deja revisión; no duplica ni cambia de cuenta |
| Solicitud incierta y otro perfil del mismo cuaderno | Barrera impide nueva creación; otros cuadernos siguen trabajando |
| Inventario truncado o error de sección | No declara ausentes ni concluye falta de resultado con lectura incompleta |
| Reinicio con descarga activa o cancelación persistida | Recupera descarga por ID; no revive cancelados ni queda en `downloading` eterno |
| Migración v5 repetida/con fallo | Mismos IDs, rutas, cuentas y MP3; rollback limpio; sin doble worker |
| Entrega concurrente con cambio de receta | Una sola fotografía coherente o fallo explícito; sin mezclar revisiones |
| Exportación parcial y aprobación | Política aplicada, faltantes visibles, descargado no equivale a aprobado |
| Respaldo y restauración temporal | Inventario y checksums equivalentes, sin copiar secretos ni pisar datos reales |
| Cierre durante una prueba | Servidores, temporizadores, procesos CLI/Python/FFmpeg propios cerrados |

Aceptación integral simulada: **40 bloques × audio e infografía = 80 requisitos**, cuatro identidades distintas, restricciones de cuota, una sesión caducada, una respuesta de creación perdida y reinicios. Tras resolver incidencias, deben existir exactamente 80 resultados seleccionados válidos, sin creaciones duplicadas causadas por reintentos, con una entrega verificable. Los casos con incertidumbre irresoluble quedan visibles para intervención; no inventar éxito para alcanzar el número.

Añadir una prueba de biblioteca grande sobre lecturas paginadas para comprobar que abrir un libro no devuelve todos los bloques de todos los libros. No hacer benchmarks remotos masivos ni usar 80 generaciones reales como prueba automática.

Ejecutar las pruebas relevantes durante cada fase y `npm test` al integrar. El smoke desktop, si corresponde, usa datos temporales y cierra sus procesos. No ejecutar `npm run test:live` como si fuera una prueba sin coste. Reportar comandos ejecutados, resultados, lo no comprobado y procesos cerrados.

## 12. Qué se difiere y qué no puede prometerse

- Concurrencia del conector entre cuentas: diferida. Solo evaluarla mediante otra decisión basada en pruebas del almacenamiento y renovación reales; no activarla por tener runners distintos.
- Más tipos de generación: incorporar uno por uno después de audio e infografía; no construir todos los adaptadores a partir de nombres de comandos supuestos.
- Transcripciones automáticas, recomendaciones de aprendizaje, LMS, Notion y publicación automática: futuras integraciones, fuera del primer recorrido.
- CRM de ventas con clientes, pagos o campañas: no corresponde al problema actual.
- No prometer velocidad cuatro veces mayor, capacidad ilimitada ni una hora de entrega que Google no confirma.
- No prometer idempotencia absoluta de Google sin contrato remoto. El compromiso local es conservar evidencia, impedir reenvíos inseguros y permitir resolver ambigüedad.
- No prometer coordinación con otro programa que escriba credenciales si no existe exclusión compartida comprobada.

## 13. Instrucción de entrega para la siguiente IA

Empieza por fase 0 y fase 1. Presenta los cambios concretos y sus pruebas; continúa las demás fases autorizadas en orden. Si una capacidad del runtime no existe, implementa el estado visible de no disponible y explica el bloqueo sin fingir soporte. Si el código ya resolvió un punto, verifica su contrato y reutilízalo.

Al finalizar entrega: resumen de funciones utilizables, archivos principales, migración aplicada, pruebas, limitaciones y confirmación de que cerraste todos los procesos de prueba propios. No marques casillas por haber escrito documentación ni afirmes que comprobaste generación real si solo ejecutaste mocks.
