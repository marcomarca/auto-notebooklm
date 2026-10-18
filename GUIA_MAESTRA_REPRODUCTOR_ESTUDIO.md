# Guía maestra: estudiar cómodamente en BloqueAudio

## Encargo y autoridad

Eres la IA implementadora. Este archivo contiene el encargo completo del usuario y las decisiones de producto para esta mejora. Implementa, verifica y entrega el resultado; no te limites a proponerlo. Respeta las instrucciones del sistema y del proyecto. Si descubres que el código cambió, adapta los puntos de integración conservando estos resultados exigidos.

El usuario quiere estudiar desde la misma aplicación de escritorio, con un reproductor hermoso y cómodo: reproducir, pausar, adelantar, retroceder y elegir velocidades como 1×, 2× y 2,5× fácilmente. La robustez es obligatoria. La IA que redactó este documento solo inspeccionó archivos y escribió esta guía: no implementó esta mejora ni ejecutó pruebas.

No necesitas consultar a otra IA ni enviarle mensajes. Resuelve siguiendo este documento. Solo pregunta al usuario si existe un bloqueo real que impida avanzar sin comprometer sus datos.

## Resultado esperado

Desde cualquier audio local disponible en la matriz o en la lista de capítulos, el usuario pulsa «Escuchar» y controla la reproducción en una barra de estudio persistente. Puede consultar una infografía, desplazarse, cambiar de pestaña o explorar otro libro sin perder el audio. Siempre ve qué libro y capítulo está escuchando. Nunca suenan dos audios a la vez.

La mejora debe funcionar en el Electron real y en la interfaz web que comparte sus archivos. No basta con ensanchar los controles nativos ni con añadir un selector de velocidad escondido.

## Reglas del proyecto que debes cumplir

- Antes de editar, lee las instrucciones aplicables y `git status --short`. Hay trabajo local preexistente: no lo reviertas, sobrescribas ni uses `git reset` o `git checkout` para limpiarlo. Revisa el diff de los archivos que vayas a tocar.
- Para buscar nombres, carpetas o rutas dentro del workspace, usa primero FFF `find_files`. Para contenido, FFF `grep` o `multi_grep`. Si falla, no está disponible o su índice está incompleto, usa `rg` o el sistema de archivos y deja constancia breve del motivo.
- FFF solo busca; lee y edita con herramientas normales.
- Si ejecutas backend, frontend o Electron para pruebas, CIÉRRALOS al terminar, también cuando fallen. Cierra únicamente procesos y servidores que tú hayas creado; no mates sesiones del usuario. Usa `finally` o `t.after`, conserva sus PID y espera su salida.
- No uses datos reales, credenciales ni NotebookLM real para las pruebas. Usa proveedores falsos, directorios temporales y un perfil Electron temporal.
- Haz el menor cambio completo. Reutiliza el proyecto y las API nativas; no agregues React, librerías de audio, gestores globales, dependencias ni infraestructura para esta mejora.
- No cambies producción, cuotas, recuperación de materiales, cuentas, base de datos, autenticación o actualizador salvo que una incidencia demostrada de esta tarea lo exija. No debilites la seguridad de Electron.

## Mapa del código inspeccionado

Las ubicaciones y nombres siguientes fueron observados el 18 de octubre de 2026. Vuelve a leerlos antes de editar: las líneas pueden cambiar.

| Archivo | Qué debes revisar |
| --- | --- |
| `public/app.js` | `render()` crea un `<audio controls preload="none">` por bloque usando `block.audioUrl`. Reutiliza filas por `dataset.stamp`, pero puede reconstruirlas al cambiar datos. |
| `public/app.js` | `renderMatrix()` compara `dataset.rowStamp` con todo el objeto de fila. Conserva filas idénticas; reconstruye la fila cuando cambia un material. `renderMaterialCell(mat, row, kind)` crea otro `<audio>` para materiales de audio disponibles. |
| `public/app.js` | La URL de matriz observada es `/api/materials/${mat.id}/file`; la vista de bloques recibe `block.audioUrl`. No construyas una ruta alternativa ignorando estos contratos. |
| `public/app.js` | `choose()`, `openExplorer()`, cambios de pestaña, paginación y `refresh(); setInterval(refresh,2000)` son puntos de riesgo para continuidad y foco. |
| `public/index.html` | Contiene sidebar, `main`, matriz, capítulos, diálogos de producción e infografía. Coloca el reproductor fuera de nodos reconstruidos u ocultados al navegar. |
| `public/style.css` | Existe `audio{width:190px;height:35px...}` y estilos globales para botones e inputs. Hay una paleta inicial azul, después sobreescrita por violeta (`--blue: #6344a8`, `--line: #e1ddea`). Respeta la paleta final y evita reglas que se contradigan. |
| `server.mjs` | La ruta de audio por bloque ya maneja `GET`, `HEAD`, `Range`, respuestas 206/416 y `Accept-Ranges`. Revisa también la ruta de archivo por material; no supongas que todas las rutas usan la misma función. |
| `electron/main.mjs` | Ventana inicial 1280×860 y mínima 900×600; carga el servidor local. Mantén `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`. |
| `tests/matrix-renderer.test.mjs` | Prueba real con Electron y audio generado mediante FFmpeg. Ya verifica que refrescar otra fila no sustituya ni interrumpa el reproductor. Contiene recuperación de audio cancelado, infografía y producción; conserva esa cobertura. |
| `tests/phase5-ui.test.mjs`, `tests/helpers.mjs` | Convenciones de pruebas, `makeApp`, `FakeProvider`, cierre y limpieza. |
| `package.json` | ES modules, Node `>=24.0.0 <25`, `npm test`, `npm run dev`, `npm run desktop`, `npm run pack:win` y `npm run dist:win`. No hace falta cambiar versión ni publicar para esta tarea. |

Riesgo concreto: conservar filas idénticas no protege un audio cuyo hermano de infografía cambie en la MISMA fila. Desacopla la vida del motor de audio de las filas y sus estados de producción.

## Diseño obligatorio

### Concepto: una consola de escucha tranquila

Una sola superficie de estudio, anclada en la parte inferior de la ventana y disponible mientras hay un audio seleccionado. Su elemento protagonista es una línea de tiempo amplia y manejable. El contenido del libro sigue siendo el centro de la aplicación.

Conserva el violeta actual como acento, Segoe UI como tipografía local y el idioma español. No añadas fuentes remotas, fondos con degradados, ondas falsas, animaciones decorativas ni una colección de tarjetas nuevas. Usa separación, jerarquía y alineación para darle calidad.

Tokens orientativos para el reproductor: superficie `#ffffff`, texto `#203248`, acento `#6344a8`, fondo secundario `#f0ebfa`, borde `#e1ddea`, texto secundario `#607089`. Valida contraste en el diseño final; un color orientativo no justifica texto ilegible. Números de tiempo con cifras tabulares. Título 15–16 px, metadatos 12–13 px y controles legibles, sin reducirlos para hacerlos caber.

Esquema de escritorio (no es un requisito de columnas rígidas):

```text
┌──────────────────────────────────────────────────────────────────┐
│ Libro · Capítulo 03: título completo accesible                     │
│ 04:32 ━━━━━━━━━━━━━━━●─────────────────────────────────── 28:10    │
│ [−15 s]  [Reproducir / Pausar]  [+15 s]    [1× ▾]   [Volumen ━●]   │
└──────────────────────────────────────────────────────────────────┘
```

- Reproducción/pausa tiene mayor peso visual y objetivo de al menos 44×44 px. Los saltos y velocidad están siempre a mano, sin menús de tres puntos.
- El botón de cada fila dice «Escuchar»; el audio activo tiene un indicador claro y comunica su estado sin depender solo del color. Ambos accesos controlan el mismo reproductor.
- Al seleccionar otro audio, el título de la barra se actualiza de inmediato y el capítulo activo se identifica en la vista correspondiente. No confundas «Pausar audio» con el botón existente que pausa la cola de producción.
- Una barra fija exige espacio reservado al final del contenido. Nunca cubras la última fila, botones, avisos o foco. Ajusta también el espacio de la sidebar si su contenido queda debajo de la barra.
- A 900×600, todos los controles esenciales siguen siendo utilizables. A 1280×860, no se amontonan. A 200 % de zoom y en web de 390 px, reorganiza en dos o tres filas sin desbordamiento horizontal del reproductor.
- Los diálogos existentes aparecen por encima de la barra. No tapes su cierre ni interfieras con su foco.
- Estados visuales explícitos: sin selección, cargando, reproduciendo, pausado, esperando datos, terminado y error. Sin audio seleccionado, evita una barra grande vacía.

## Comportamiento preciso

### Controles

1. Reproducir/pausar con un clic. El botón refleja el estado real del elemento multimedia, no una variable optimista que pueda quedar desincronizada.
2. Retroceder 15 segundos y adelantar 15 segundos. Limita la posición al intervalo válido. Desactiva la búsqueda cuando no exista duración/intervalo utilizable; nunca asignes `NaN` o `Infinity`.
3. Línea de tiempo accesible: clic, arrastre y teclado. Muestra tiempo actual y duración con formato `mm:ss` o `h:mm:ss`. Antes de metadatos, usa `--:--`, nunca `NaN:NaN`.
4. Mientras se arrastra, muestra la posición elegida sin que `timeupdate` mueva el cursor hacia atrás. Al confirmar, aplica el salto sin reproducir un audio pausado. Un arrastre cancelado no deja el control bloqueado.
5. Selector visible de velocidad: **0,75×, 1×, 1,25×, 1,5×, 1,75×, 2× y 2,5×**. Valor técnico numérico, etiqueta localizada. Cambiar velocidad no reinicia la pista. Conserva el tono cuando el motor lo permita.
6. Volumen 0–100 % y silenciar/restaurar. Sincroniza los cambios reales del elemento; al restaurar desde silencio, usa el último nivel audible razonable.
7. Al terminar, conserva el capítulo seleccionado, muestra el estado final y permite reproducirlo desde cero con un clic. **No avances automáticamente** a otro capítulo ni inicies audio al abrir la aplicación.
8. Conserva la descarga del MP3 y sus nombres. No obligues a abrir un reproductor externo para estudiar.

### Teclado

Los atajos operan solo sobre el audio activo, cuando no hay un diálogo modal abierto ni se está editando texto, seleccionando opciones o usando controles con teclado propio.

| Tecla | Acción |
| --- | --- |
| Espacio | Reproducir/pausar si el foco está en una superficie neutra. En botones, respeta la activación nativa; no ejecutes dos acciones. |
| Flecha izquierda/derecha | −15/+15 segundos desde superficie neutra. Dentro del slider, respeta su navegación nativa. |
| Tab / Shift+Tab | Recorrido lógico, foco visible, sin trampas. |

No captures atajos globales del sistema. No uses letras simples que interfieran con búsquedas. Evita `preventDefault()` salvo cuando realmente consumas un atajo. Explica los atajos en un texto de ayuda discreto y accesible.

### Continuidad y memoria local

- Un único elemento `HTMLAudioElement` persistente fuera de los renderizados de tablas. Las filas seleccionan audio, no crean motores independientes.
- Misma pista: pulsar su control no vuelve a asignar `src`, no llama `load()` sin necesidad y no la reinicia. Define con claridad si el botón de fila alterna pausa o continúa y refleja esa decisión en su nombre accesible.
- Otra pista: guarda la posición anterior, detén su reproducción y cambia la fuente una sola vez. Intenta reproducir la nueva por la acción del usuario. Si falla, muestra un estado recuperable.
- Navegar entre libros, matriz, capítulos, explorador y páginas no desmonta la barra ni reasigna la fuente actual. La barra conserva la identidad del audio aunque el libro visible sea otro.
- Recuerda velocidad, volumen y posición por audio en almacenamiento local versionado y acotado. Incluye identidad estable de cuenta/libro/bloque y de revisión/archivo para no reutilizar la posición de una revisión distinta ni mezclar cuentas. No uses el título, número de capítulo o puerto HTTP aleatorio como única identidad.
- No hace falta cambiar SQLite ni crear endpoints para recordar escucha. Comprueba si el origen HTTP cambia entre sesiones de Electron: no prometas persistencia entre reinicios hasta verificarlo. Si `localStorage` no basta por el origen, reutiliza un mecanismo local existente y seguro con el menor alcance; no habilites acceso Node en el renderer. Documenta cualquier límite real.
- Restaura posición solo tras metadatos válidos, limitándola a duración. Una pista terminada vuelve al inicio al reproducir. Restaurar memoria no inicia sonido sin acción del usuario.
- Guarda con frecuencia acotada (por ejemplo, cada pocos segundos), además de pausa/cambio/fin; no escribas almacenamiento en cada `timeupdate`. `pagehide` es apoyo, no el único guardado.
- Maneja JSON corrupto, versión desconocida, valores fuera de rango, cuota excedida y almacenamiento no disponible: el reproductor sigue funcionando con valores seguros. Acota el historial, por ejemplo a los últimos 100 audios, sin guardar archivos ni credenciales.

## Robustez técnica que debes demostrar

- Usa los eventos multimedia (`play`, `pause`, `timeupdate`, `loadedmetadata`, `durationchange`, `waiting`, `playing`, `ended`, `error`, `ratechange`, `volumechange`) para sincronizar UI. No uses un bucle de renderizado de toda la aplicación para actualizar segundos.
- Captura el rechazo de `audio.play()`. Un cambio rápido de A a B puede cancelar una promesa de A: ese resultado obsoleto no puede pausar, etiquetar ni mostrar un error sobre B. Usa identidad de carga o una protección equivalente pequeña y explícita.
- Los listeners se registran una vez o se limpian correctamente. Refrescar veinte veces no multiplica acciones. No acumules reproductores, timers o referencias a filas retiradas.
- Un refresco de producción, una infografía del mismo capítulo, otro libro o el orden de filas no cambia posición, velocidad o reproducción. Conservar DOM de filas por sí solo no satisface esta regla.
- Cuando cambie la revisión del archivo activo, no reproduzcas silenciosamente un archivo distinto. Informa que hay una nueva versión y permite cargarla mediante acción explícita. Si el archivo activo desaparece, detén el audio, deshabilita los controles que ya no sirven y ofrece recuperación comprensible.
- Diferencia una carga temporal de un fallo definitivo. Ante archivo ausente o incompatible, muestra «No se pudo reproducir este audio» y «Reintentar». Reintentar reproduce la misma fuente sin generar ni descargar de nuevo desde NotebookLM. No muestres rutas internas, tokens ni trazas al usuario.
- Usa las rutas locales existentes. No cargues todo el MP3 como `Blob` para poder saltar ni precargues todos los audios de una biblioteca. Al seleccionar un audio sí puedes cargar sus metadatos.
- Verifica los saltos sobre las dos rutas reales de audio. Si falla `Range` en una, corrige esa ruta con pruebas y conserva validación de acceso, MIME, descargas y límites; no reescribas el servidor por anticipación.
- Usa `textContent`/el helper `el` para títulos y mensajes. No interpolaciones de títulos en `innerHTML`.
- Accesibilidad: botones reales, nombres actualizados «Reproducir»/«Pausar», labels de sliders y velocidad, valores entendibles en tiempo, foco visible. Anuncia errores y cambios importantes con moderación; no anuncies cada segundo con `aria-live`.
- Mantén los tokens, estilos y selectores del reproductor acotados para no alterar los sliders, formularios y botones de producción existentes.

## Plan de ejecución

1. Lee el código actual, las instrucciones y los diffs locales. Identifica ambas entradas de audio, sus identidades y cómo llegan al renderer. No supongas que `material.id` equivale a `block.id`.
2. Define una pequeña API interna de selección y control compartida por ambas vistas. Mantén un solo estado de pista activa y deriva el estado reproducido del elemento. Si separar en un archivo pequeño aclara responsabilidades, hazlo y conecta su carga; no crees un framework.
3. Monta la barra persistente, sustituye las entradas de audio por controles que la usan y conserva descarga/recuperación/infografías. No dejes controles nativos invisibles que todavía puedan reproducir otra pista.
4. Implementa eventos, saltos, velocidad, volumen, memoria y protección frente a cambios rápidos. Verifica continuidad antes de pulir detalles visuales.
5. Ajusta el diseño y el teclado; revisa capturas de la aplicación real. Corrige amontonamientos, contenido tapado y estados sin feedback.
6. Ejecuta las pruebas pertinentes, corrige regresiones y entrega un informe breve con evidencia. No publiques, instales sobre la copia del usuario ni cambies el acceso directo para esta tarea.

## Pruebas y criterios de aceptación

No se acepta como prueba funcional buscar cadenas en HTML ni simular que `play()` siempre funciona. Reutiliza el harness Electron existente con audio decodificable y datos falsos; puedes mutearlo. Los buffers vacíos del proveedor falso no demuestran reproducción real.

Adapta las aserciones antiguas que esperan un `<audio>` dentro de la fila a la nueva arquitectura, **conservando lo que verificaban**. No elimines la prueba de continuidad ni afirmes éxito si Electron/FFmpeg faltan.

| Caso | Evidencia mínima para aprobar |
| --- | --- |
| Dos entradas | «Escuchar» en matriz y capítulos controla el mismo elemento persistente, sin audios simultáneos. |
| Pausa | Tras avanzar, pausar mantiene el tiempo estable dentro de tolerancia; continuar lo hace avanzar. |
| Saltos | −15/+15 y búsqueda con slider cambian `currentTime`; cerca de inicio/fin no salen de límites. Usa una fixture de al menos 40–60 s para comprobar saltos completos. |
| Velocidad | 1×, 2× y 2,5× cambian `playbackRate` y la etiqueta sin cambiar fuente ni reiniciar posición. Verifica también las opciones intermedias y datos persistidos inválidos. |
| Volumen | Silenciar y restaurar recupera el nivel previo; slider y elemento coinciden. |
| Metadatos | Sin duración y durante carga no hay excepciones, tiempos inválidos ni slider operable sin rango válido. |
| Refresco | Reproduciendo a 2×, veinte refrescos y un cambio de infografía en la misma fila conservan elemento, reproducción, posición y velocidad. |
| Navegación | Cambiar pestaña, página, libro y abrir/cerrar infografía conserva la reproducción y muestra la identidad correcta. |
| Carrera | Seleccionar A → B rápidamente, incluyendo rechazo tardío de A, deja B seleccionado y una sola pista audible, sin error obsoleto. |
| Memoria | Pausar/cambiar/reabrir restaura posición y preferencias sin autoplay; no mezcla revisiones o cuentas. Verifica aparte el alcance real entre reinicios de Electron. |
| Teclado | Espacio y flechas funcionan en superficie neutra; escribir en búsquedas/títulos, usar selectores/sliders y diálogos no dispara controles ajenos. Un botón con Espacio actúa una sola vez. |
| Error | Fuente 404/inválida muestra recuperación; reintentar no toca producción. Al pasar luego a un audio válido se recupera. |
| Fin | `ended` permite reiniciar desde cero y no inicia otro capítulo. |
| Diseño | Capturas a 1280×860, 900×600 y web estrecha; comprobación de zoom 200 %, Tab y última fila visible. |
| Regresión | Se conservan descarga de MP3, recuperación de audio cancelado, vista de infografía, plan de producción y sus pruebas relevantes. |

Secuencia orientativa de validación:

```powershell
node --test tests/matrix-renderer.test.mjs tests/phase5-ui.test.mjs
# Ejecuta también las pruebas específicas de reproductor que añadas.
npm test
```

Si modificas rutas de archivo, incluye pruebas HTTP de `GET`/`HEAD`, `Range` válido/insatisfacible, archivo ausente y descarga. Si la suite tiene un fallo previo ajeno, documenta el caso y evidencia que es previo; no lo ocultes ni arregles sistemas no relacionados sin necesidad.

Las pruebas tienen que cerrar servidores, ventanas Electron y procesos FFmpeg propios aun en timeout o fallo. No dejes un backend de prueba atendiendo puertos cuando termines.

## Definición de terminado y entrega

La tarea está terminada cuando el usuario puede estudiar un audio desde ambas vistas con controles amplios, velocidad hasta 2,5×, teclado y continuidad, y las pruebas demuestran los casos anteriores sin romper producción ni infografías.

Entrega al usuario:

- Qué cambió y cómo usar reproducción, saltos, velocidad y teclado, en lenguaje sencillo.
- Archivos modificados y pruebas ejecutadas con su resultado real.
- Capturas o rutas a capturas que permitan revisar el diseño final.
- Confirmación de que cerraste los procesos de prueba propios.
- Cualquier límite demostrado, especialmente persistencia entre sesiones o comprobaciones que no pudiste ejecutar.

No declares que la aplicación instalada ya incluye el cambio si solo modificaste fuentes o generaste un paquete. Si generas un artefacto local, identifica su ruta y distingue el paquete de la instalación existente. No publiques ni reemplaces la instalación del usuario sin una instrucción específica.

## Fuera de alcance

No añadas transcripción, IA de resúmenes, marcadores, notas, repetición A–B, ecualizador, sincronización en nube, avance automático, nuevas pantallas de biblioteca ni rediseño global. No conviertas un reproductor cómodo en un proyecto distinto. La prioridad es terminar bien esta experiencia de escucha.
