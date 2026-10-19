# Plan de mejoras verificadas de BloqueAudio / Auto NotebookLM

Documento único de ejecución para otra IA. Fecha de evaluación: 18 de octubre de 2026, America/La_Paz.

## 1. Encargo y conclusión

El usuario pidió evaluar una auditoría anterior y redactar instrucciones detalladas para que otra IA implemente las mejoras. **En esta evaluación no se ha modificado la aplicación, ni se han ejecutado pruebas, ni se han iniciado servidores. Solo se ha creado este documento.**

La auditoría anterior acierta en que faltan validación local de tamaño, progreso de transferencia por archivo y un tema oscuro. También identifica correctamente el sondeo periódico y la concentración de responsabilidades en `app.js`. Sin embargo, varias conclusiones son incorrectas o demasiado generales:

- El explorador es una vista, no un modal. No corresponde encerrarlo en un diálogo ni capturar su foco.
- Ya existen diálogos nativos para eliminación, planificación e infografías.
- Ya existen atajos de reproducción: espacio y flechas con saltos de 15 segundos.
- Ya hay estados de espera del reproductor, controles de progreso, velocidad, volumen y persistencia.
- Ya hay variables CSS, estados de foco y algunas transiciones. Su cobertura es incompleta; no están totalmente ausentes.
- Usar Segoe UI no constituye un defecto. Cambiar de fuente no demuestra una mejora.
- El sondeo no implica por sí solo que SSE sea necesario. Primero hay que medir y corregir el trabajo innecesario.
- No deben transformarse los avisos persistentes de cuota en mensajes que desaparecen automáticamente.

Además, la lectura del código ha descubierto dos problemas funcionales más prioritarios: el contrato del catálogo no coincide entre servidor y cliente, y sus respuestas asíncronas no están protegidas contra cambios de libro. Estas correcciones preceden a los cambios estéticos.

Decisión: ejecutar T00–T07 en orden. T08 es una extracción condicionada por necesidad real y T09 es una alternativa de transporte condicionada por mediciones. No implementar T08 ni T09 automáticamente. La justificación y las condiciones están escritas más adelante.

## 2. Alcance y límites de la evaluación

### Qué se comprobó

Revisión estática del árbol de trabajo actual, especialmente `public/app.js`, `public/index.html`, `public/style.css`, `server.mjs`, partes de `store.mjs`, `accounts.mjs`, `sync.mjs`, pruebas existentes y configuración de Electron. Se contrastaron las recomendaciones de plataforma con documentación de MDN enlazada al final.

No se repitió la supuesta auditoría de navegador anterior. No se accedió al informe externo alojado en la carpeta de Antigravity; se evaluaron las afirmaciones copiadas por el usuario. Por ello, los saltos visuales, costes de CPU y tiempos de respuesta son hipótesis pendientes de medición, no resultados observados aquí. Los fallos de contrato descritos sí se deducen directamente del código, pero todavía necesitan reproducción automatizada.

Carga objetivo: aplicación local de una persona, navegador y Electron, biblioteca de libros con tareas persistentes y varias cuentas. No diseñar infraestructura para un servicio público con miles de usuarios.

### Estado del proyecto en esta revisión

- Workspace: `D:\apps-2026\auto-notebooklm`.
- Producto: BloqueAudio, paquete `auto-notebooklm`, versión declarada `1.1.1`.
- HEAD observado: `e8ee90708d26495d7723100c4bd8d7ea85977059`.
- `public/app.js`: 2169 líneas; HTML: 350; CSS: 543. El tamaño es una pista de mantenimiento, no una prueba de fallo.
- Node declarado: `>=24.0.0 <25`; pruebas con `node:test`; Electron y FFmpeg se usan en pruebas del renderer/reproductor.
- Existen cambios previos ajenos a este plan en `public/app.js`, `public/index.html`, `public/style.css`, `server.mjs` y `tests/matrix-renderer.test.mjs`.
- También se observaron `tests/studio-player.test.mjs` y `AUTO NOTEBOOKLM.lnk` sin seguimiento. Conservarlos.

Huellas SHA-256 del contenido evaluado, útiles para detectar que la base cambió, **no para exigir sobrescribirla**:

| Archivo | SHA-256 |
|---|---|
| `public/app.js` | `EF6323AC8F45E606D74DAF07CBD19FA87DE626FF6DB6D2BAD7B03C90483BD94A` |
| `public/index.html` | `FE15393F7B50083FBE50A37029BBF653A779B1B8BABF6CB9AC5FACD31E88560D` |
| `public/style.css` | `AA77CF740DF6E6BC69DD6C2CDDC087294473047488C8F7789AFD02345BE2E6D5` |
| `server.mjs` | `4C138E3213FFFC40E4861ADE6339078006172CC8AF2DD5E6D0E4FE7AEB42B570` |

Las líneas citadas son orientativas de esta base. Antes de editar, localizar los símbolos; no aplicar cambios por número de línea a ciegas.

## 3. Veredicto de cada afirmación original

| Afirmación | Veredicto y evidencia | Decisión |
|---|---|---|
| `app.js` concentra demasiadas funciones | Sí concentra estado, red, cuentas, catálogo, matriz y reproductor. Pero contiene protecciones y reutilización que no deben perderse. | Evitar una reescritura. T08 solo si la extracción tiene beneficio concreto. |
| `setInterval(refresh, 2000)` continuo | Confirmado en `public/app.js:2118`. `refresh:697` tiene guardia `refreshing`; por tanto, no es correcto afirmar que todas sus ejecuciones se solapan. | T04: ciclo adaptativo y esperas completas. Medir antes de SSE. |
| Todas las consultas de refresco van a Google | Incorrecto: health devuelve estado almacenado; books y accounts consultan estado local. La comprobación remota explícita usa otra ruta. | No confundir tráfico HTTP local con consumo de cuota del proveedor. |
| No hay variables CSS | Parcialmente falso: existen `--blue`, `--line`, `--muted` y redefiniciones posteriores. Hay muchos colores literales. | T06 amplía y unifica tokens semánticos. |
| No hay modo oscuro | Confirmado en las hojas y el HTML revisados. | T06: preferencia clara/oscura/sistema. Mejora de producto, no reparación crítica. |
| Segoe UI es un problema | No demostrado. Es una fuente de sistema adecuada para Windows y evita descargas. | Conservarla; mejorar legibilidad y consistencia si hace falta. |
| No hay microinteracciones | Incorrecto como absoluto: existen hover, transiciones y pulsos. | Corregir movimiento reducido; no añadir animaciones por adorno. |
| `#explorer` es un modal sin focus trap | Incorrecto: es `<section hidden>` y alterna con `#workspace`/`#welcome`. | T05 mejora foco al navegar, sin convertirlo en modal. |
| Hay que migrar los modales a `<dialog>` | Ya son `<dialog>`: `delete-modal`, `plan-modal`, `infographic-modal`. Usan `showModal()`. | T05 completa nombres, cancelación y retorno del foco. |
| `notice`/`quota` desplazan la página | Su CSS participa en el flujo; el desplazamiento es posible. No se midió en navegador. `notice` ya tiene `role=status` y `aria-live=polite`. | T03: separar mensajes transitorios de información persistente y verificar geometría. |
| Falta validar tamaño antes de subir | Confirmado: `addFiles:1409` valida extensión, pero no `file.size`. Backend sí limita a 200 MiB y valida contenido. | T02: validación temprana conservando defensa del servidor. |
| Falta progreso individual | Hay texto «archivo i de n», sin porcentaje de transferencia de bytes. | T02: progreso real, sin confundir guardado local con carga remota. |
| Faltan atajos del reproductor | Incorrecto: `wireKeyboardShortcuts:446` ya maneja espacio y flechas ±15 s y excluye campos y diálogos abiertos. | Preservar y probar. No cambiar a ±10 s. |
| Falta indicador de buffer/onda | No se encontró una barra de buffer ni onda; sí eventos `waiting`/`playing`. Son funcionalidades distintas. | T07 añade buffer sencillo; onda descartada por coste sin utilidad acreditada. |

## 4. Reglas obligatorias para la IA ejecutora

1. Leer este documento completo y las instrucciones vigentes del repositorio antes de editar.
2. Para buscar archivos, carpetas, rutas o contenido en el workspace usar primero FFF MCP: `find_files`, `grep`, `multi_grep`. Usar herramientas normales solo si FFF no está disponible, falla o no terminó de indexar; explicar el fallback. Para leer y editar, usar herramientas normales.
3. No ejecutar `git reset --hard`, `git clean`, ni restaurar archivos completos para eliminar trabajo previo. No sobrescribir cambios del usuario. Revisar diff antes y después de cada tarea.
4. No modificar `data/`, `exports/`, perfiles, credenciales ni cuadernos reales. Pruebas con `makeApp({ port:0, dataDir:temporal, exportsDir:temporal, provider:new FakeProvider(), worker:false, check:false })`, ajustando worker únicamente cuando el caso lo necesite.
5. **Después de ejecutar pruebas de backend o frontend, cerrarlos.** Registrar los procesos/puertos propios; cerrar servidores, ventanas, hijos Electron y temporizadores incluso cuando una aserción falle. No matar procesos del usuario ni cerrar una instancia previa del puerto 4318.
6. No ejecutar `npm run test:live`, ni pruebas con cuentas reales, ni generar, eliminar o compartir contenidos reales como validación de estas mejoras.
7. No publicar releases ni tocar el actualizador, instaladores, launchers, identidad de datos o versión del producto sin necesidad derivada de una tarea.
8. Conservar HTML/CSS/JS nativos y el backend HTTP de Node. No introducir React, Vue, Vite, Tailwind, una biblioteca de toasts, WebSockets o un gestor global de estado.
9. Mantener `X-Local-Token` en mutaciones, comprobación de Host/Origin, CSP y escucha en `127.0.0.1`. No usar `unsafe-inline` para facilitar el rediseño.
10. No cambiar estados de cola, cuotas, identidad de cuentas, aislamiento por fuente, idempotencia, numeración ni semántica de cancelar/restaurar/reintentar.
11. La reproducción debe continuar al cambiar de libro, pestaña o página de matriz. Mantener un solo `#studio-audio` y la persistencia existente.
12. Un fallo transitorio de red no debe iniciar acciones remotas nuevas. Reintentar lecturas es distinto de repetir una mutación.
13. Cada tarea debe terminar con sus criterios de aceptación y evidencia de pruebas. Un test que solo busca una cadena en el archivo no demuestra comportamiento.
14. Si la base cambió, adaptar el plan a sus símbolos actuales. Si un problema ya está resuelto, demostrarlo y marcar la tarea como satisfecha; no volver a implementarla.

## 5. Orden, dependencias y esfuerzo orientativo

Los tiempos son estimaciones de trabajo, no compromisos. La experiencia de la IA y el estado del entorno pueden cambiarlos.

| ID | Entregable | Prioridad | Depende de | Esfuerzo |
|---|---|---|---|---|
| T00 | Base reproducible y mediciones | Prerrequisito | — | 0,5–1 día |
| T01 | Contrato e identidad del catálogo correctos | P1: funcional | T00 | 1–2 días |
| T02 | Validación y progreso de archivos | P1: errores evitables | T00 | 1–2 días |
| T03 | Mensajes transitorios y persistentes accesibles | P2: UX | T01, T02 | 0,5–1 día |
| T04 | Actualización adaptativa sin trabajo superpuesto | P2: eficiencia | T01, T03 | 1–2 días |
| T05 | Navegación, diálogos y movimiento accesibles | P2: accesibilidad | T03 | 0,5–1 día |
| T06 | Tokens y tema claro/oscuro/sistema | P3: presentación | T03, T05 | 1–2 días |
| T07 | Buffer del reproductor sin perder controles | P3: mejora acotada | T04, T05 | 0,5–1 día |
| T08 | Extraer reproductor si se justifica | Condicional | T01–T07 estables | 1–2 días |
| T09 | SSE si persiste un coste medido | Condicional | T04 medida y estable | 2–4 días |

Ejecutar secuencialmente. No mezclar rediseño, transporte y extracción de módulos en el mismo cambio. Las tareas condicionales no son requisitos para declarar completado el alcance principal T00–T07.

## 6. T00 — Establecer base y entorno de pruebas

**Objetivo:** distinguir fallos previos de regresiones y obtener cifras útiles para T04.

**Leer:** `package.json`, `tests/helpers.mjs`, `tests/server.test.mjs`, `tests/phase5-ui.test.mjs`, `tests/matrix-renderer.test.mjs`, `tests/studio-player.test.mjs`, `server.mjs` (`makeApp`, `close`) y configuración Electron.

**Pasos:**

1. Registrar `git status --short` y diff inicial, incluidos archivos sin seguimiento. Detectar instrucciones adicionales con FFF. No crear ramas, commits ni copias con credenciales como requisito del plan.
2. Comprobar Node 24, dependencias instaladas, Electron y FFmpeg. Reutilizar la instalación del proyecto. Si falta un requisito, registrar qué validación queda pendiente; no declarar aprobada una prueba no ejecutada.
3. Leer las pruebas antes de iniciarlas. Confirmar que usan directorios temporales, proveedor falso y limpieza mediante `t.after` o `finally`.
4. Ejecutar una base de las pruebas relevantes existentes. Guardar nombres y resultados. Un fallo previo no autoriza a cambiar el test para ocultarlo.
5. Con una instancia aislada y FakeProvider, medir 60 s por escenario: vacío; libro terminado con matriz; libro con tareas activas simuladas; vista explorador; ventana oculta. Contar peticiones por ruta, bytes de respuesta y escrituras/reemplazos DOM relevantes. No asumir que la ventana oculta reduce tráfico: medir lo que sucede.
6. Usar como datos de carga un libro con al menos 51 bloques, como la prueba del renderer, y un lote de 25 archivos pequeños. No crear contenido remoto.
7. Cerrar todo lo iniciado y verificar que el puerto temporal dejó de escuchar y que los hijos propios terminaron.

**Aceptación:** existe línea base reproducible, estado previo conservado, tabla antes/después preparada y ninguna instancia de pruebas queda abierta.

## 7. T01 — Corregir contrato y carreras del catálogo

**Problemas verificados:**

- `GET /api/books/:id/catalog` en `server.mjs:561` devuelve `{ book, items }`.
- `loadCatalog:1448` asigna esa respuesta directamente a `currentCatalog`.
- `renderCatalog:1470` lee `currentCatalog.artifacts`, `.sources`, `.notes`, que no existen en esa respuesta. Sus valores por defecto son listas vacías.
- `refresh:727` comprueba `currentCatalog.bookId`, también ausente, por lo que puede volver a cargar el catálogo en cada ciclo.
- A diferencia de `loadMatrix`, `loadCatalog` no tiene número de solicitud ni descarta respuestas/error de un libro que ya dejó de estar seleccionado.
- `choose` no limpia las selecciones del catálogo al cambiar de libro. Una carga atrasada puede contaminar la vista siguiente. Además, los IDs persistidos `remote_items.id` y `remote_items.remote_id` son distintos y no son intercambiables en todas las rutas.

**Archivos:** `public/app.js`; pruebas de catálogo existentes y una prueba de renderer focalizada. No cambiar la forma del endpoint para acomodar el error del cliente.

### Contrato de cliente que debes establecer

Mantener el endpoint existente `{ book, items }`. Hacer una normalización explícita, pequeña y comprobable en el cliente antes de renderizar:

| Campo normalizado | Origen y uso |
|---|---|
| `bookId` | `response.book.id`. Debe coincidir con el libro solicitado. |
| `book` | Metadatos originales para informar cuenta, sincronización y error. |
| `artifacts/sources/notes` | Filtrar `items` por `kind` igual a `artifact/source/note`. |
| `itemId` | `item.id`: ID local para selección estable y descargas por catálogo. |
| `remoteId` | `item.remote_id`: ID real de Google para generación desde fuentes y eliminación de artefactos. |
| `title/type/status` | Campos originales. No colapsar estados desconocidos a «Generando». |
| `errorReason` | `item.error_reason`. |
| `createdAt` | `item.created_time`; validar antes de formatear y mostrar «Fecha no disponible» si es inválida. No asumir segundos frente a milisegundos sin comprobar la normalización del proveedor. |
| `notVisible` | `Boolean(item.not_visible)`; mostrar ausencia de la última sincronización, conservando registro. |

`sync.mjs` no persiste texto de notas en los campos revisados. No inventar un `content` ni realizar consultas remotas adicionales para llenar esa columna: mostrar «Contenido no disponible en la caché» cuando falte. Añadir persistencia de notas sería otro alcance.

### Implementación paso a paso

1. Escribir primero una regresión que alimente la respuesta real `{book, items}` con una fuente, artefactos y una nota. Debe fallar con el cliente actual y comprobar filas/contadores con el cliente corregido.
2. Añadir `catalogRequestSeq`, siguiendo el patrón ya usado por `matrixRequestSeq`/`explorerSeq`. Capturar `bookId` y secuencia antes del `await`.
3. Al terminar GET o fallar, aplicar resultado solo si siguen vigentes la secuencia, el libro seleccionado y la vista local. Invalidar al cambiar de libro, entrar al explorador o vaciar selección. Un error viejo no puede borrar datos nuevos.
4. En cambio de libro: limpiar `currentCatalog`, selecciones de fuentes/artefactos y controles de selección; deshabilitar acciones hasta cargar un catálogo válido. En refresco del mismo libro: conservar únicamente selecciones cuyos IDs siguen disponibles y son accionables.
5. En `renderCatalog`, exigir `currentCatalog.bookId === selected` y no estar en explorador. No renderizar datos de A con un objeto `book` de B.
6. Para descargar, enviar `itemId` al endpoint `/downloads`. Para generar, resolver seleccionados a `remoteId` y enviar esos IDs en `sourceIds`. Para eliminar, pasar `remoteId` a la ruta y mantener el libro/cuenta correctos. Mostrar el ID remoto en la columna denominada ID remoto.
7. No habilitar acciones sobre registros `not_visible`, `deleted_confirmed`, `delete_uncertain` o `reappeared` sin verificar la política del backend; por defecto mostrarlos con explicación y exigir sincronización/revisión. Conservar su estado, no eliminar su historial.
8. Manejar `failed` de fuentes como error. Para estados desconocidos, presentar el valor de forma segura y no ofrecer una acción cuyo requisito de listo no se cumple.
9. Mostrar un fallo actual de carga de catálogo y permitir reintento explícito; no ocultarlo silenciosamente ni borrar una caché válida del mismo libro sin indicar que quedó desactualizada.
10. Capturar libro y selección al inicio de cada acción asíncrona del catálogo. Una operación iniciada en A no debe limpiar las selecciones nuevas de B cuando termina. Sincronizar A debe recargar A solo si sigue visible.

**Pruebas obligatorias:**

- API real con FakeProvider y `upsertRemoteItem`: filas de cada clase aparecen; lista vacía legítima se distingue de fallo.
- A responde lentamente, se selecciona B, B responde primero y A después: quedan título, filas, cuenta y acciones de B. Repetir haciendo fallar A.
- Entrar al explorador con un GET pendiente: su resultado no vuelve a mostrar el catálogo local.
- Dos ítems tienen ID local distinto del remoto: descargar usa el local; generar/eliminar usan el remoto. Interceptar mutaciones en el test y comprobar ruta/cuerpo; ninguna eliminación real.
- Seleccionar en A, cambiar a B: las acciones por lote no incluyen IDs de A. Terminar una descarga simulada de A no borra selección hecha en B.
- Datos con fecha inválida, fuente `failed` e ítem ausente no rompen el render ni permiten acciones incorrectas.

**Aceptación:** catálogo visible con respuesta real del servidor, identidad correcta en cada acción y respuestas atrasadas inocuas. No modificar esquema SQLite ni semántica remota.

## 8. T02 — Validar y mostrar transferencias por archivo

**Leer:** `addFiles:1409`, eventos de `#files` y `#drop-zone`, `api:40`, `server.mjs` (`maxFile`, `upload`), pruebas de carga e idempotencia. Backend actual: límite **200 × 1024 × 1024 = 209715200 bytes**, acepta `.md` y `.pdf` y valida contenido, UTF-8 y duplicados.

**Archivos:** `public/app.js`, `public/index.html`, `public/style.css`; pruebas focalizadas de archivos y renderer.

**Pasos:**

1. Mantener una sola entrada `addFiles` para selector y arrastre. Conservar orden natural y `bookId` capturado al iniciar el lote; esa parte ya está bien implementada.
2. Antes de enviar, rechazar por archivo: extensión no admitida, `size === 0`, `size > 209715200`. El límite exacto es permitido. Usar extensión sin distinguir mayúsculas; no confiar solo en MIME porque puede venir vacío.
3. Prevalidar el lote completo, mostrar rechazados y seguir con válidos, conservando orden y la razón individual. Si no hay válidos, no iniciar solicitudes PUT. No leer archivos grandes enteros en RAM para esta comprobación.
4. El límite del servidor sigue siendo autoridad. Mantener sus validaciones de bytes recibidos, PDF, Markdown UTF-8 y hash. La validación del cliente solo evita transferencias inútiles.
5. Crear una lista compacta de carga con nombre, estado y progreso por archivo. Estados mínimos: rechazado, pendiente, transfiriendo, esperando confirmación local, añadido, duplicado, error. Conservar resumen al terminar hasta la próxima carga o cierre explícito.
6. Para progreso de bytes usar un helper de `XMLHttpRequest` exclusivamente para este PUT, con `xhr.upload.progress`. Conservar el `File` como cuerpo binario y `X-Local-Token`; no envolverlo en FormData porque el endpoint espera bytes crudos. No reescribir todo `api()` para esto.
7. Registrar listeners antes de enviar. Si `lengthComputable` es falso, mostrar indeterminado. Al terminar transferencia, mostrar «Confirmando guardado» hasta tener respuesta HTTP satisfactoria y JSON válido. `100%` de bytes no demuestra que Google haya recibido/procesado la fuente.
8. Tratar HTTP no exitoso, fallo de red, abort y JSON no válido como error de ese archivo. Continuar los demás. No hacer reintentos automáticos de PUT. Si posteriormente se incorpora reintento explícito, reutilizar el `requestId` del mismo archivo/intento lógico.
9. Mantener carga secuencial. No añadir paralelismo para los 25 archivos: evita cambiar orden y presión sobre servidor/conector.
10. En `finally`, restaurar `uploading`, estado del input, botones y render aunque falle el refresco final. Al cambiar de libro, el lote sigue asociado al inicial y lo indica; no lo redirigir al nuevo libro.
11. El progreso debe tener nombre accesible. No anunciar cada byte en una región viva: anunciar inicio, cambios de archivo y resultado. Aclarar que después del guardado local la cola continúa la carga a NotebookLM.

**Pruebas:** tamaño 0, límite exacto, límite+1, `.PDF`, MIME vacío, extensión inválida, lote mixto de 25, duplicado, respuesta rechazada, fallo de red, JSON inválido y cambio de libro durante el lote. Para límites usar objetos/Blob sintéticos en frontend; no escribir 200 MiB por caso si una prueba pequeña puede verificar el umbral. Mantener al menos una integración de un archivo pequeño real con el endpoint y pruebas previas del límite servidor.

**Aceptación:** ningún archivo inválido genera PUT; los válidos llegan en orden al libro original; el porcentaje representa transferencia local; resultados y controles quedan correctos tras fallos parciales.

## 9. T03 — Separar mensajes transitorios de estados persistentes

**Situación:** `notice()` se usa para éxitos, errores y progreso; `#quota` y `#waiting-reason-box` son estados que requieren permanencia. No convertir todo indiscriminadamente en toast.

**Archivos:** HTML, CSS y `app.js` (`notice` y sus llamadas, feedback y carga).

**Pasos:**

1. Inventariar llamadas de `notice` con FFF. Mantener compatibilidad de sus argumentos mientras migras; evitar cambiar decenas de llamadas sin necesidad.
2. Éxitos e información breve: región fija de notificaciones con `role=status`, `aria-live=polite`, `aria-atomic=true`; desaparición tras unos 6 segundos. Un mensaje visible a la vez basta. Sustituir por el más reciente sin acumular una cola ilimitada.
3. Errores: permanecer hasta cierre o recuperación específica. Botón de cerrar con nombre accesible. No perder un error porque otro proceso llame a `notice('')`: asignar origen/identidad a los mensajes asíncronos que puedan interferirse, o mantener esos errores junto a su componente.
4. Progreso de carga queda en T02. Cuota, sesión requerida, error de sincronización y revisión pendiente quedan cerca del control o bloque afectado. Un toast complementario no sustituye ese estado.
5. Deduplicar el mismo fallo de conexión repetido por refrescos. Mantener indicador de conexión persistente y retirarlo al recuperarse esa conexión; no borrar errores ajenos.
6. La región fija no debe interceptar clics fuera de su tarjeta ni tapar reproductor, controles o diálogo. Definir posición y ancho para 360 px y escritorio. Preferir esquina superior del área principal, con un espacio superior de contenido que asegure acceso a controles cuando la tarjeta está visible. Verificar en lugar de suponer que un z-index alto resuelve todo.
7. Mostrar texto con `textContent`, sin insertar mensajes remotos con HTML. Pausar el cierre automático con hover/foco; el aviso nunca roba el foco al aparecer.
8. Limpiar temporizador anterior al reemplazar aviso y al desmontar/cerrar página. Una sola región de anuncios por tipo; evitar mensajes duplicados para lectores de pantalla.

**Pruebas:** aparición no cambia coordenadas del encabezado/tabla; éxito se cierra; error permanece; cerrar con teclado funciona; otro proceso no borra un error de componente; cien fallos idénticos no producen cien tarjetas/anuncios; cuota sigue visible tras cerrar un aviso; reproducción y controles accesibles en móvil y zoom 200%.

**Aceptación:** mensajes breves no producen saltos de contenido y los problemas persistentes siguen siendo consultables.

## 10. T04 — Sustituir sondeo fijo por actualización adaptativa

**Objetivo:** reducir trabajo en reposo, controlar solicitudes y mantener la frescura de datos sin añadir transporte persistente todavía.

`refresh()` hace tres GET en paralelo: health, books y accounts. Con libro seleccionado también inicia `loadMatrix()` sin esperar; catálogo se vuelve a cargar por el desajuste explicado en T01. La guardia `refreshing` cubre el cuerpo de refresh, pero no todo el trabajo no esperado de matriz/catálogo. `loadMatrix` sí descarta respuestas viejas mediante secuencia. `render` usa una firma global y `renderMatrix` conserva filas sin cambios. Mantener esas protecciones.

**Archivos:** `public/app.js` y pruebas de scheduler/renderer. No cambiar el tick del worker en `queue.mjs`: tiene otra función.

### Política inicial concreta

| Contexto | Siguiente actualización automática |
|---|---|
| Ventana visible y actividad local pendiente | 2 s después de acabar el ciclo |
| Ventana visible en reposo | 15 s después de acabar el ciclo |
| Ventana oculta | 30 s después de acabar el ciclo |
| Fallo de red | Backoff 2, 4, 8, 16, 30 s, reiniciado al éxito |
| Volver a visible, evento online o mutación local exitosa | Solicitar una actualización inmediata, combinando solicitudes concurrentes |

Ventana oculta no pausa cola ni audio. Latencia de otros clientes en reposo: hasta aproximadamente 15 s más la duración de la petición; documentarla. En actividad: intervalo de 2 s más duración del ciclo. No prometer actualización instantánea.

**Pasos:**

1. Reemplazar el `setInterval` final por un único scheduler con `setTimeout` reprogramado después del ciclo completo. Debe tener `start`, solicitud de refresco y limpieza; no un framework de tareas.
2. Centralizar in-flight: como máximo un ciclo global y una consulta de matriz/catálogo por clave libro/página. Una petición manual durante un ciclo marca un único refresco pendiente, no se pierde y no crea tres ciclos nuevos.
3. Esperar cargas derivadas relevantes o gestionarlas con deduplicación explícita. No fijar `refreshing=false` mientras se supone que esas mismas lecturas forman parte del ciclo.
4. Capturar libro, página y vista para las consultas derivadas; aplicar la comprobación de identidad de T01 y la secuencia existente de matriz. Cambiar rápidamente de página no puede mostrar una página vieja.
5. No pedir matriz periódica mientras el explorador esté abierto. Si la vista de bloques necesita el resumen multimodal de la matriz, conservar su actualización o usar los datos equivalentes ya disponibles en books; no suprimirla sin revisar consumidores. Al cambiar a matriz cargar inmediatamente si está desactualizada.
6. Catálogo: cargar al elegir libro, tras sincronización/acciones pertinentes y con una política explícita para cambios de otros clientes; inicialmente permitir refresco local del catálogo cada 30 s visible. No llamar a sincronización remota automáticamente para refrescar la pantalla.
7. `loadRecipes` debe compartir la petición pendiente y recordar carga correcta incluso si devuelve lista vacía; una lista vacía no debe producir un GET por ciclo. Un error debe permitir reintentar sin bucle rápido.
8. Definir actividad a partir de estados ya existentes de libros/bloques/materiales y login/carga. Incluir tareas en espera de resultado remoto; excluir estados terminales. Cuota con próximo intento lejano puede usar reposo, pero recuperar actividad al siguiente refresco correspondiente. Añadir pruebas para una tarea activa de un libro distinto del seleccionado.
9. Extender `api()` con señal de cancelación y timeout solo para lecturas periódicas, por ejemplo 15 s; siempre limpiar el timer. No imponer este timeout a sincronizaciones, cargas o operaciones remotas largas. Una lectura colgada no debe bloquear todo refresco indefinidamente.
10. Manejar `visibilitychange`, `online`, `pagehide` y `pageshow` evitando duplicar listeners/scheduler. Cerrar/cancelar solo lecturas propias; no audio ni operaciones de usuario. `pagehide` guarda posición como ya hace el reproductor.
11. Evitar reconstruir controles enfocados si los datos no cambiaron. Conservar firmas de filas y el único audio. En la biblioteca/catálogo restaurar foco por identidad cuando un cambio requiera reconstruir el nodo; no moverlo al body en cada ciclo.
12. Medir de nuevo los escenarios T00. Tras el refresco inicial, 60 s en reposo deben tener aproximadamente cuatro ciclos de 15 s, frente a unos treinta ciclos previos de 2 s; la cifra exacta depende de tiempos/visibilidad. Separar peticiones derivadas y bytes. No atribuir ahorro de cuota Google a estos GET locales.

**Pruebas:** un fetch lento no genera solapamientos; 10 solicitudes manuales durante un ciclo producen a lo sumo un ciclo adicional; fallo/backoff/recuperación; ocultar y volver; cambiar libro/página; resultado inicial vacío de recipes; una promesa de red colgada termina por timeout; foco estable; audio sigue sonando durante refrescos y cambios.

**Aceptación:** una sola planificación activa, lecturas pendientes acotadas, reducción medible en reposo y frescura coherente con la tabla. Si no se cumple, corregir T04 antes de evaluar SSE.

## 11. T05 — Accesibilidad de navegación y diálogos

**Archivos:** HTML, CSS y manejadores de explorador/diálogos; pruebas del renderer.

1. Mantener `#explorer` como sección. Al abrirlo, mover foco al título con `tabindex=-1` o al selector de cuenta. Al cerrarlo, devolver foco a `#open-explorer` si sigue disponible. No bloquear Tab en esta vista.
2. Completar nombre accesible de `delete-modal` y `plan-modal` con IDs de sus títulos y `aria-labelledby`; usar `aria-describedby` para advertencias/instrucciones breves, no para toda la tabla. `infographic-modal` ya tiene nombre y botón inicial.
3. En eliminación, foco inicial en Cancelar. Usar `showModal()` y comportamiento nativo de Escape; no construir una segunda trampa manual de foco.
4. Unificar cierre por Cancelar, Escape (`cancel`) y `close`: limpiar `pendingDeleteTarget`, `currentPlanPreview` y `planRequestId` cuando proceda. Capturar el objetivo antes de cerrar al confirmar para que el cleanup no lo elimine antes de enviar. Nunca ejecutar eliminación por cerrar/cancelar.
5. En planificación, capturar `plan` y `requestId` de la confirmación antes de `await`. Escape durante una solicitud no debe cancelar ficticiamente una operación ya enviada ni permitir una segunda confirmación accidental; dejar clara la operación pendiente.
6. Registrar elemento que abrió el diálogo y devolver foco al cerrar si sigue conectado y es visible. Si el refresco lo reemplazó, enfocar su equivalente estable o el título de sección. Evitar sobrescribir un foco que el usuario ya trasladó por otra acción intencional.
7. Añadir nombres de selección a checkboxes de catálogo/explorador y seleccionar todos. Garantizar foco visible en `select`, `summary`, sliders y botones; el CSS actual incluye `outline:none` en algunos controles y necesita revisión específica.
8. Mantener componentes nativos de selección/teclado. Si se añaden roles de pestaña, implementar también sus controles de teclado y estados; de lo contrario, conservar botones con estado accesible como `aria-pressed` y relación con su panel. No añadir solo `role=tab`.
9. El `prefers-reduced-motion` actual solo cambia scroll. Desactivar pulsos y transiciones no esenciales bajo esa preferencia, manteniendo texto/estado/contraste.
10. Atajos actuales: conservar espacio y ±15 s. Ignorar eventos ya consumidos, combinaciones con Ctrl/Alt/Meta, edición, controles y diálogos. Revisar enlaces y widgets enfocados para no interferir con su acción normal. Probar que no se duplica el toggle por propagación desde un botón.

**Aceptación:** recorrido completo por teclado; diálogo mantiene foco y Escape lo cierra sin acciones remotas; retorno lógico del foco; lector de pantalla recibe título/advertencia/estado; con movimiento reducido no quedan pulsos decorativos.

## 12. T06 — Unificar colores y añadir tema oscuro

**Objetivo:** añadir preferencia visual sin cambiar estructura, marca, semántica ni fuente de sistema.

**Archivos:** `public/style.css`, `public/index.html`, `public/app.js`; si se necesita aplicar tema antes del primer render, pequeño `public/theme-init.js` servido por el allowlist estático de `server.mjs`.

### Contrato de tema

- Selector accesible «Tema»: Sistema / Claro / Oscuro, en una zona estable de configuración.
- Persistencia en clave nueva, por ejemplo `bloqueaudio_theme_v1`, con valores `system`, `light`, `dark`.
- Sin preferencia válida: `system`. `matchMedia('(prefers-color-scheme: dark)')` solo decide cuando está en sistema.
- Aplicar resultado a `document.documentElement.dataset.theme` y `color-scheme`. Si localStorage falla, la app funciona con sistema.
- No mezclar esta clave con `bloqueaudio_studio_player_v1` ni datos de libros/cuentas.

### Pasos

1. Inventariar colores y reglas duplicadas con FFF, leyendo las reglas completas. Hay una redefinición morada de `--blue`; preservar esa identidad y eliminar contradicciones, no volver accidentalmente a la paleta azul anterior.
2. Introducir tokens semánticos mínimos: `--bg-page`, `--bg-surface`, `--bg-subtle`, `--text-primary`, `--text-secondary`, `--border`, `--accent`, `--on-accent`, `--focus`, colores/fondos de éxito, aviso y error. No diseñar un sistema de cien tokens.
3. Durante la migración se pueden mantener alias `--blue`, `--line`, `--muted` apuntando a los nuevos tokens. Retirarlos solo si todos los consumidores se actualizaron en esa tarea.
4. Sustituir literales en página, sidebar, tablas, campos, botones, badges, cuotas, carga, avisos, diálogos, reproductor y previews. No invertir colores de imágenes ni iconos de marca.
5. Definir paletas clara y oscura explícitas. Evitar sombras negras y fondos blancos heredados en oscuro. No depender del color como único indicador de estado.
6. Mantener Segoe UI y fallbacks de sistema. Usar una escala corta coherente de tamaños/espacios y limitar cambios a legibilidad y consistencia; no rehacer toda la composición.
7. Aplicar preferencia antes de pintar para evitar destello. Si hace falta un script temprano, servirlo como archivo propio; el backend actual solo sirve rutas enumeradas y **no servirá automáticamente archivos JS nuevos**. Añadir la ruta exacta al allowlist, con MIME correcto; no abrir acceso arbitrario al filesystem.
8. Escuchar cambios del sistema cuando el modo sea system. No duplicar listeners al cambiar selector; escuchar `storage` si se sincroniza entre pestañas. Un valor corrupto debe volver a system.
9. Verificar contraste: texto normal al menos 4,5:1; texto grande y límites/indicadores esenciales al menos 3:1. Comprobar foco y estados hover, activo y error. No declarar contraste aprobado solo por inspección subjetiva.

**Pruebas:** tema sistema claro/oscuro, override manual, recarga, almacenamiento inválido/bloqueado, cambios de sistema, diálogos y reproductor en ambos modos. Capturas en 360, 768 y 1440 px, zoom 200%; verificar que el reproductor no tape las últimas filas y que las tablas sigan desplazándose sin ocultar acciones.

**Aceptación:** todos los componentes principales legibles en ambos temas, foco visible, preferencia persistente y ningún recurso bloqueado por CSP/404. Conservar apariencia clara reconocible y jerarquía actual.

## 13. T07 — Mostrar buffer del reproductor

**No repetir:** ya existen un solo audio, barra temporal, espera por datos, controles, atajos ±15 s, volumen, velocidad y posiciones guardadas. No crear otro reproductor ni introducir una onda ficticia.

**Archivos:** objeto `studioPlayer` en `public/app.js`, timeline del HTML, CSS y `tests/studio-player.test.mjs`.

1. Añadir una capa visual de buffer debajo del slider sin interferir con puntero o teclado. No crear otro control enfocable.
2. Leer `audio.buffered` en `progress`/`loadedmetadata`/cambios pertinentes y recalcular al buscar o cambiar pista. Para varios rangos, mostrar sus segmentos reales, no todo de cero al extremo mayor si existen huecos.
3. Si duración no es finita/positiva o aún no hay rangos, limpiar indicador. Acotar posiciones a 0–100%; tolerar cambios de rangos y duración sin excepciones.
4. Vaciar segmentos al seleccionar otra pista, vaciar source o producirse error. Un evento tardío no debe restaurar visuales de otra pista; usar la identidad/secuencia de carga existente.
5. Mantener eventos `waiting`/`playing` actuales y mensajes de error/reintento. No anunciar cada actualización de buffer a lectores de pantalla; el slider ya comunica posición y duración.
6. No cambiar `preload=none`, soporte HTTP Range, endpoints ni estrategia de descarga para hacer que la barra parezca más activa. Una pista local puede quedar completamente cargada casi al instante: es válido.

**Pruebas:** sin metadata, duración inválida, un rango, varios rangos con huecos, cambio rápido de pista, error y seek. Probar cálculos de segmentos con valores controlados y una integración con MP3 decodificable; la red local no garantiza un evento visible de buffering prolongado.

**Aceptación:** buffer representa datos recibidos, no progreso de generación; controles y reproducción sobreviven a T04 y navegación; no se crea onda sonora.

## 14. T08 — Extracción pequeña del reproductor, solo si se justifica

**Condición de entrada:** T01–T07 pasan y el trabajo demuestra que el acoplamiento del reproductor impide pruebas o produce cambios repetidos en funciones ajenas. El número de líneas por sí solo no activa esta tarea. Registrar qué dependencia concreta se elimina.

**Diseño preferido si se activa:** extraer únicamente el controlador y sus helpers de tiempo/preferencias a `public/studio-player.js`, como factoría en un script clásico con ámbito propio. Así se mantiene el arranque actual sin convertir toda la app a módulos ni romper las pruebas que acceden a sus bindings. Exportar una sola factoría mediante una propiedad claramente nombrada y conservar `window.studioPlayer` por compatibilidad existente.

1. Con FFF enumerar referencias externas reales del controlador: elementos DOM, estado actual de cuenta/libro y metadatos de pistas. Leer cada uso; no asumir que la lista se limita a las primeras líneas.
2. Inyectar solo accesos que necesite como callbacks vivos, por ejemplo obtener la cuenta/selección actual. No copiar valores iniciales que queden obsoletos al cambiar de libro. No crear un contenedor de dependencias general.
3. Mantener interfaz pública que consumen celdas/matriz: `init`, `selectTrack`, consultas de pista/pausa, indicadores y demás llamadas existentes. Conservar claves y formato de persistencia, límites, manejo de errores y secuencias.
4. Cargar script extraído con `defer` antes de `app.js`. Registrar `/studio-player.js` en el allowlist del servidor. Verificar MIME/CSP y empaquetado Electron.
5. Probar comportamiento, no solo conteo de líneas. No dividir cuentas, catálogo y matriz en esta tarea; la siguiente extracción necesitaría justificación independiente.

**Aceptación:** misma reproducción/persistencia/atajos, ningún listener duplicado, sin importaciones circulares ni archivo nuevo que responda 404. Si no hay beneficio demostrable, marcar «No activada: se conserva estructura actual» y terminar con T07.

## 15. T09 — SSE como alternativa posterior, no requisito inicial

SSE permite que el servidor avise cambios mediante una conexión persistente. Es adecuado técnicamente para una dirección servidor→cliente, pero requiere cubrir cambios desde worker, cuentas, producción y HTTP, reconexión y cierre. No basta con emitir desde dos botones.

**Activar solamente si**, después de T04, las mediciones reproducibles muestran tráfico/CPU local material o latencia entre ventanas que perjudica el uso y la política de intervalos no satisface el caso. Registrar escenario, cifras y objetivo antes de programar. Como referencia operativa, investigar si el refresco consume más del 5% de CPU de forma sostenida en reposo en el equipo medido, o si la latencia requerida es menor que la política aceptada de T04. Estos umbrales son decisiones del plan, no mediciones actuales ni estándares de rendimiento.

### Diseño acotado si se activa

1. Releer las rutas y todas las escrituras relevantes antes de elegir puntos de emisión. Contrato de evento de invalidación, por ejemplo `event: invalidate` con `data: {revision, scopes:["books","accounts"], bookIds:[...]}`. No transmitir tokens, rutas locales, cookies ni libros completos.
2. Una revisión monotónica por instancia del proceso es suficiente: cada reconexión fuerza snapshot GET completo; no prometer replay durable ni usar Last-Event-ID como garantía de consistencia entre reinicios.
3. La notificación solo invalida caché; el cliente usa las funciones de lectura y validación de identidad ya corregidas. Agrupar ráfagas cortas y colapsar invalidaciones durante un refresh en una sola repetición.
4. Instrumentar cambios **después** de confirmación/persistencia: rutas HTTP, progreso/terminales de cola, creación/modificación de materiales, sincronización y login/cuenta. No publicar transacciones luego revertidas. Evitar hacer emit en cada sentencia SQL si el ciclo completo se representa con una invalidación agrupada. Enumerar productores en el cambio y probar uno de cada familia.
5. Si no hay un punto sencillo que cubra toda la salud/cuentas, conservar un GET periódico de respaldo y describir la consistencia real. No presentar SSE como «sin ningún sondeo» si queda reconciliación.
6. Añadir `GET /api/events` con `text/event-stream`, sin caché, cabeceras enviadas y heartbeat aproximado de 20–30 s. Mantener comprobaciones de Host/Origin y CSP. `EventSource` nativo no admite headers arbitrarios: no poner `X-Local-Token` en query ni relajar protección de mutaciones. Como endpoint GET local de invalidaciones, documentar su encaje con la política existente y probar rechazo de Origin/Host incorrectos.
7. Gestionar cada cliente en una colección acotada; limpiar al cerrarse request/response y ante error. Ante backpressure no acumular eventos ilimitados: desconectar cliente lento y recuperar con snapshot al reconectar.
8. En shutdown: cerrar streams, limpiar heartbeat y desuscribir productores antes de esperar el cierre del servidor. En frontend: `EventSource.close()` al salir y recreación controlada al volver. No dejar dos conexiones al reanudar página.
9. Reconexión: snapshot obligatorio y estado de conexión. Si SSE falla repetidamente, activar T04 como fallback; al recuperarse, retirar solo su timer automático redundante. No mantener ambos transportes a 2 s permanentemente.
10. Bajo HTTP/1 existen límites bajos de conexiones SSE por origen en navegadores; probar varias pestañas y el tráfico de audio. No añadir elección de líder/BroadcastChannel a priori. Un límite documentado y fallback bastan para este producto local.

**Pruebas:** evento por cambio HTTP/worker/cuenta; burst; desconexión/reconexión; reinicio con revisión distinta; snapshot que cubra un evento perdido; fallback; dos pestañas; cliente lento; servidor cerrado con conexiones abiertas. Comparar con métricas T04. No afirmar mejora si solo se cambió de técnica.

**Aceptación:** menor coste o mejor latencia demostrado, sin pérdida de estados ni bloqueo de shutdown; fallback probado. Si no se activa, el resultado de T04 sigue siendo una solución terminada.

## 16. Verificación y cierre de la implementación

### Comandos orientativos

Ejecutar desde el workspace. No ejecutarlos todos tras cada cambio trivial; seleccionar por tarea y ampliar solo cuando se justifique.

```powershell
node --version
node --check public/app.js
node --check server.mjs
node --test tests/server.test.mjs tests/phase5-ui.test.mjs
node --test tests/matrix-renderer.test.mjs
node --test tests/studio-player.test.mjs
npm test
```

Comprobar también sintaxis de los JS nuevos si los hay. Los comandos del renderer pueden abrir Electron y necesitan dependencias/FFmpeg; sus hooks de limpieza deben funcionar en éxito y fallo. No usar `test:live` para sustituirlos. La batería completa se ejecuta al terminar cambios funcionales, si el entorno permite todos sus requisitos. Si falla por entorno, reportar nombre y causa real, sin rebajar aserciones.

### Matriz mínima de regresión

| Área | Casos imprescindibles |
|---|---|
| Catálogo | Contrato real; IDs locales/remotos; A lento/B rápido; errores viejos; selección aislada; vacío y fallo diferentes |
| Carga | 0/límite/límite+1; lote mixto; duplicados; progreso; fallo parcial; libro capturado |
| Refresco | Actividad/reposo/oculto; timeout; backoff; eventos de recuperación; una sola planificación |
| Mensajes | Error persistente; éxito transitorio; deduplicación; no interferencia entre procesos; cuota visible |
| Diálogos | Nombre; Tab/Shift+Tab; Escape; Cancelar; confirmación única; retorno del foco |
| Tema | Sistema/claro/oscuro; persistencia; almacenamiento inválido; contraste y foco |
| Reproductor | Range HTTP existente; play/pause/seek; ±15 s; campos/diálogos excluidos; continuidad; cambio de pista; buffer |
| Layout | 360/768/1440 px; zoom 200%; tablas; últimas filas y controles sin quedar tapados |
| Limpieza | Servidores/ventanas/hijos/timers propios cerrados en éxito y fallo; instancia previa intacta |

No exigir pruebas de fotografía exacta ni tests que reflejen cada línea de implementación. Combinar pruebas focalizadas de regresión, renderer real existente y verificación visual documentada.

### Definición de terminado

- [ ] T00 tiene resultados y no confunde fallos previos con nuevos.
- [ ] T01 demuestra contrato e identidad correctos con respuestas fuera de orden.
- [ ] T02 evita transferencias inválidas y representa progreso de manera veraz.
- [ ] T03 conserva errores/estados importantes y evita saltos por avisos breves.
- [ ] T04 muestra reducción medida de trabajo en reposo sin bloquear actualizaciones.
- [ ] T05 funciona por teclado y respeta movimiento reducido.
- [ ] T06 cubre ambos temas y preferencia del sistema.
- [ ] T07 conserva el reproductor actual y añade buffer real.
- [ ] T08/T09 tienen decisión explícita: no activadas con razón, o activadas y verificadas.
- [ ] No hay cambios involuntarios en datos, perfiles, cola, generación, launchers o releases.
- [ ] No quedan procesos ni interfaces de pruebas abiertas.
- [ ] El diff final incluye solo lo implementado y conserva cambios previos.

La IA ejecutora debe entregar: resumen por tarea; archivos modificados; pruebas y resultados exactos; tabla de mediciones antes/después; limitaciones verificadas; decisión sobre T08/T09. No declarar «todo probado» cuando solo pasó sintaxis o inspección estática.

## 17. Estrategia de reversión

Hacer cambios pequeños y revisables por tarea. Antes de revertir, distinguir sus líneas de los cambios previos del usuario. No restaurar todo un archivo desde HEAD.

- T01/T02: revertir solo el parche propio si rompe contrato/carga; no tocar SQLite ni archivos originales.
- T03: conservar siempre acceso a errores/cuota aunque se retire presentación fija.
- T04: si hay desactualización o lecturas perdidas, corregir causa; como contingencia temporal volver al mecanismo previo sin mantener dos timers. Registrar que vuelve su coste original.
- T06: retirar selector/estilos propios restaura el tema claro sin borrar otras preferencias.
- T08: devolver controlador a su ubicación previa y retirar únicamente su ruta/script añadido.
- T09: desactivar streams y mantener T04; verificar que no quedan heartbeats/suscripciones.

No se necesita migración de datos para las mejoras principales de este plan.

## 18. Referencias de plataforma consultadas

- [MDN: elemento dialog](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog): comportamiento nativo, foco y cierre. Aplicable a T05; no justifica convertir una vista en modal.
- [MDN: XMLHttpRequest.upload](https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/upload): eventos de progreso de transferencia usados en T02.
- [MDN: EventSource](https://developer.mozilla.org/en-US/docs/Web/API/EventSource): conexión persistente y límites de conexiones en HTTP/1, relevantes solo si se activa T09.
- [MDN: uso de Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events): formato de eventos, reconexión y comentarios de heartbeat.

Estas referencias explican APIs. Las decisiones de prioridad y arquitectura se basan en el código local y el alcance del producto. No constituyen mediciones de esta aplicación.

## 19. Instrucción de arranque para la otra IA

> Implementa este plan en `D:\apps-2026\auto-notebooklm`. Lee primero las reglas y conserva los cambios existentes. Empieza por T00 y T01; continúa secuencialmente hasta T07. Usa FFF para búsquedas. Prueba con FakeProvider y datos temporales. Cierra todo backend/frontend/proceso de pruebas que abras. No uses cuentas reales, no publiques nada y no añadas frameworks. T08 y T09 solo se ejecutan si se cumplen y documentan sus condiciones; si no, márcalas como no activadas. Al terminar presenta evidencias, métricas y limitaciones reales. No necesitas el historial de la conversación: el encargo, contratos, tareas y criterios están completos en este documento.
