import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeApp } from '../server.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const reportDir = join(root, 'data', 'live-check');
const app = await makeApp({ port: 0, worker: false, check: false });
const started = Date.now();
let bookId, report;
try {
  const health = await app.provider.check();
  if (!health.ready) throw new Error(health.error || 'Proveedor no disponible.');
  const book = app.store.createBook({ title: 'Prueba de audios por bloques', requestId: 'live-check-v1' }, app.provider.profile);
  bookId = book.id;
  const samples = [
    ['01 - Ciclo del agua.md', `# El ciclo del agua\n\nEl ciclo del agua describe cómo circula el agua entre océanos, tierra y atmósfera. La energía del Sol calienta la superficie del mar y transforma parte del agua líquida en vapor. Este proceso se llama evaporación. Las plantas también liberan vapor por sus hojas mediante la transpiración. Juntos, estos procesos aportan humedad a la atmósfera.\n\nAl ascender, el aire se enfría. El vapor se condensa alrededor de pequeñas partículas y forma gotas o cristales de hielo. Su acumulación produce nubes. Cuando las gotas aumentan de tamaño y peso, caen como precipitación: lluvia, nieve o granizo. La forma depende de la temperatura de las capas de aire atravesadas.\n\nUna parte del agua que llega al suelo se infiltra entre sus poros y alimenta acuíferos. Otra parte fluye sobre la superficie como escorrentía, alimentando arroyos y ríos que llevan el agua de regreso a lagos y mares. La vegetación facilita la infiltración y reduce la erosión. Si el suelo está cubierto de asfalto, la infiltración disminuye y la escorrentía aumenta.\n\nEl agua también puede permanecer almacenada en glaciares, lagos y acuíferos durante periodos muy distintos. El ciclo no tiene un único punto de inicio ni una duración fija. Una gota puede evaporarse pronto o quedar almacenada mucho tiempo.\n\nUn experimento sencillo consiste en colocar agua tibia en un recipiente y una tapa fría encima. El vapor asciende y forma gotas en la tapa. Estas gotas pueden volver a caer al recipiente. El experimento ilustra evaporación, condensación y precipitación, aunque no representa todas las rutas del ciclo.\n\nComprender este ciclo ayuda a explicar por qué una ciudad puede sufrir inundaciones después de una lluvia intensa y por qué proteger bosques y suelos beneficia el almacenamiento de agua. El agua circula continuamente, pero la disponibilidad local depende de la estación, el clima y el uso del territorio.`],
    ['02 - Sucesión de Fibonacci.md', `# La sucesión de Fibonacci\n\nLa sucesión de Fibonacci es una lista de números en la que cada término se obtiene sumando los dos anteriores. Si comenzamos con cero y uno, aparecen 0, 1, 1, 2, 3, 5, 8, 13 y 21. Para construir la lista no hace falta una fórmula compleja: basta recordar los últimos dos valores.\n\nLa relación se escribe F(n) = F(n-1) + F(n-2), con F(0) = 0 y F(1) = 1. Es un ejemplo de definición recursiva. Recursiva significa que la definición de un término utiliza términos anteriores de la misma sucesión. El cálculo puede hacerse de manera iterativa, avanzando desde los primeros valores sin repetir trabajo.\n\nUn ejemplo de conteo consiste en subir una escalera dando pasos de uno o dos peldaños. Para llegar a un peldaño determinado, el último paso proviene del peldaño anterior o del situado dos posiciones antes. Por eso el número de rutas posibles sigue una relación del mismo tipo. Para uno, dos, tres y cuatro peldaños existen respectivamente una, dos, tres y cinco rutas.\n\nSi dividimos un término por el anterior, cuando este no es cero, obtenemos cocientes que se acercan a aproximadamente 1,618. Este número se conoce como razón áurea. La aproximación mejora al avanzar en la sucesión, aunque los primeros cocientes fluctúan alrededor del valor.\n\nSe pueden dibujar cuadrados con lados de longitud uno, uno, dos, tres, cinco y ocho, colocando cada nuevo cuadrado junto a los anteriores. Si se trazan arcos dentro de los cuadrados, aparece una espiral aproximada. Esa figura es una construcción geométrica vinculada a la sucesión, no una prueba de que toda espiral natural siga exactamente sus números.\n\nLa sucesión aparece en algunos patrones de crecimiento de plantas y en problemas de algoritmos. Conviene distinguir una observación medible de una afirmación general. No todas las flores tienen números de pétalos de Fibonacci ni todas las proporciones agradables corresponden a la razón áurea.\n\nUna actividad útil es calcular los primeros diez términos, comprobar cada suma y contar las rutas de una escalera pequeña. Ambos ejercicios muestran cómo una regla breve puede organizar muchos resultados.`]
  ];
  for (let i = 0; i < samples.length; i++) {
    const [filename, content] = samples[i];
    const response = await fetch(`${app.origin}/api/books/${bookId}/files?filename=${encodeURIComponent(filename)}&requestId=live-source-${i}`, {
      method: 'PUT', headers: { 'X-Local-Token': app.token }, body: content
    });
    if (!response.ok) throw new Error((await response.json()).error);
  }
  app.store.update('books', bookId, { running: 1 });
  let previous;
  while (Date.now() - started < 25 * 60 * 1000) {
    await app.queue.tick();
    const b = app.store.book(bookId), blocks = app.store.blocks(bookId);
    const state = `${b.state}: ${blocks.map(x => `${x.position}=${x.state}`).join(', ')}`;
    if (state !== previous) { console.log(state); previous = state; }
    if (b.error) throw new Error(b.error);
    const failed = blocks.find(x => ['review', 'auth', 'quota'].includes(x.state) || (x.state === 'error' && x.attempts > 3));
    if (failed) throw new Error(`${failed.state}: ${failed.error}`);
    if (blocks.length === 2 && blocks.every(x => x.state === 'done')) {
      report = { passed: true, finishedAt: new Date().toISOString(), bookId, notebookId: b.remote_id,
        format: 'deep_dive', language: 'es-419', length: 'default',
        blocks: blocks.map(x => ({ number: x.position, sourceId: x.source_id, artifactId: x.artifact_id, mp3: x.output_path, original: x.original_path })) };
      if (new Set(report.blocks.map(x => x.sourceId)).size !== 2 || new Set(report.blocks.map(x => x.artifactId)).size !== 2) throw new Error('IDs remotos duplicados.');
      console.log('LIVE CHECK PASSED: dos audios independientes convertidos y decodificados como MP3.');
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!report) throw new Error('Prueba real excedió 25 minutos. La cola se conserva para continuar con npm start.');
} catch (e) {
  report = { passed: false, finishedAt: new Date().toISOString(), bookId, error: e.message };
  console.error(`LIVE CHECK FAILED: ${e.message}`); process.exitCode = 1;
} finally {
  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
  await app.close();
}
