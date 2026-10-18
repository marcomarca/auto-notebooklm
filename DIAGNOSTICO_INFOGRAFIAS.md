# Infografías generadas en Google que aparecen con error local

Diagnóstico del 18 de octubre de 2026. Runtime comprobado: `notebooklm-mcp-cli 0.12.0`.

## Causa comprobada

El comando de creación admite perfil explícito mediante `-p`. Los subcomandos de **descarga** no lo admiten. La aplicación estaba enviando, por ejemplo:

```text
nlm download infographic CUADERNO --id ARTEFACTO --output ARCHIVO --no-progress -p PERFIL
```

El parser terminaba con `No such option: -p`, antes de descargar. Eso no significa que Google haya fallado al generar. Se comprobó la ayuda instalada y se leyeron los registros locales: las tareas afectadas conservaban un ID de artefacto remoto, incluida la tarea cuyo mensaje era «El proveedor terminó sin respuesta».

La selección de perfil de descargas se conserva mediante `NLM_PROFILE`, que ya pasa `Provider.cli()` al proceso. El código instalado del conector aplica esa variable a la configuración. No cambiar el perfil global ni copiar cookies para corregir el argumento inválido. La puerta compartida continúa serializando los comandos para proteger la renovación de credenciales.

## Segundo error: proceso sin salida

El mensaje antiguo ocultaba el código de salida del proceso y no identificaba la etapa. Por sí solo no demuestra sesión expirada, cuota agotada ni fallo de generación. No puede reconstruirse retroactivamente el código de salida a partir del mensaje que se guardó.

Ahora se informa el código y, si existe, la señal de terminación. La tarea indica si falló el envío, la consulta o la descarga. Si una creación pudo llegar a Google, se conserva el intento y se consulta su resultado antes de decidir cualquier otra acción.

## Correcciones

- Los nueve adaptadores de descarga usan `NLM_PROFILE`, sin el argumento incompatible `-p`; la creación mantiene sus opciones compatibles.
- Seguimiento y descarga de una infografía utilizan la cuenta guardada en su intento, que puede ser distinta de la cuenta del audio.
- Un fallo al consultar o descargar no cambia una creación ya aceptada a «generación fallida».
- «Reintentar» conserva el ID y vuelve a consultar/descargar. Con baseline sin ID, reconcilia la solicitud incierta; no envía otra creación a ciegas.
- La reconciliación exige una fuente exacta y un único candidato; termina en revisión si no puede identificarlo tras varias consultas.
- Los IDs locales del catálogo se traducen a IDs remotos antes de llamar a Google.
- Los errores de argumentos se clasifican como `CLI_USAGE` y no se repiten automáticamente como si fueran cortes de red.
- Reintentar no reactiva tareas canceladas.

## Recuperar lo que ya está generado

1. Cargar esta versión del backend reiniciando la aplicación.
2. En las infografías afectadas, pulsar **Reintentar**. No usar **Nueva revisión** para resolver un error de descarga.
3. La tarea consulta el resultado existente, pasa a descarga y finalmente a «Listo». No consume otra generación por ese recorrido.
4. Si el error persiste, recoger etapa, código de error, mensaje y cuenta utilizada. No compartir cookies, tokens ni salidas de debug sin redactar.

La validación automatizada usa archivos temporales y un conector simulado; no se reintentaron ni modificaron las tareas reales del usuario durante este diagnóstico. Se consultó la ayuda y el código instalado sin realizar generaciones ni iniciar otra sesión de autenticación.

## Verificación de regresiones

```powershell
node --test tests/infographic-recovery.test.mjs
npm test
```

Las pruebas cubren contrato de descargas, perfil y serialización, salida vacía, cuenta distinta para audio e infografía, reintentos sin regeneración, respuesta perdida, fallo de sondeo, catálogo local, cancelación y ambigüedad de procedencia. Todas cierran sus procesos y datos temporales al terminar.
