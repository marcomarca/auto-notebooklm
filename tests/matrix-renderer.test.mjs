import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { makeApp } from '../server.mjs';
import { FakeProvider } from './helpers.mjs';

test('interfaz real: matriz, reproducción, vista previa PNG, cuota compacta y producción', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bloqueaudio-renderer-'));
  let app, child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
      await exited;
    }
    try { await app?.close(); } finally { await rm(dir, { recursive: true, force: true }); }
  });
  app = await makeApp({ port: 0, dataDir: dir, exportsDir: join(dir, 'exports'), provider: new FakeProvider(), worker: false, check: false });
  const book = app.store.createBook({ title: 'Libro reproductor', requestId: 'renderer-book' }, 'default');
  app.store.update('books', book.id, { remote_id: 'remote-renderer', state: 'ready' });
  const blocks = Array.from({ length: 51 }, (_, i) => app.store.addBlock(book.id, {
    requestId: `renderer-${i}`, title: `Capítulo ${i + 1}`, filename: `${i}.md`, filePath: '', hash: `hash-${i}`
  }));
  const audioPath = join(dir, 'audio.mp3');
  const encoded = spawnSync(process.env.FFMPEG_BINARY || 'ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:a', 'libmp3lame', audioPath
  ], { windowsHide: true, timeout: 10000 });
  assert.equal(encoded.status, 0, String(encoded.stderr));
  const audio = app.store.createMaterialTask({ bookId: book.id, blockId: blocks[0].id, type: 'audio', state: 'ready', outputPath: audioPath, sourceFingerprint: blocks[0].hash });
  const canceledAudio = app.store.createMaterialRevision(audio.id);
  app.store.cancelMaterialTask(canceledAudio.id);
  const imagePath = join(dir, 'infografia.png');
  const imageEncoded = spawnSync(process.env.FFMPEG_BINARY || 'ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x100', '-frames:v', '1', imagePath
  ], { windowsHide: true, timeout: 10000 });
  assert.equal(imageEncoded.status, 0, String(imageEncoded.stderr));
  app.store.createMaterialTask({ bookId: book.id, blockId: blocks[0].id, type: 'infographic', state: 'ready', outputPath: imagePath, sourceFingerprint: blocks[0].hash, params: { language: 'es-419' } });
  app.store.createMaterialTask({ bookId: book.id, blockId: blocks[1].id, type: 'infographic', state: 'failed', error: 'La imagen necesita revisión' });
  const study = app.store.createBook({ title: 'Libro para planificar', requestId: 'renderer-study' }, 'default');
  app.store.update('books', study.id, { remote_id: 'remote-study', state: 'ready' });
  const studyBlock = app.store.addBlock(study.id, { requestId: 'study-1', title: 'Bloque de estudio', filename: 'study.md', filePath: '', hash: 'study-hash' });
  app.store.update('blocks', studyBlock.id, { state: 'done', stage: 'convert', source_id: 'study-source', output_path: audioPath });
  app.store.createMaterialTask({ bookId: study.id, blockId: studyBlock.id, type: 'audio', state: 'ready', outputPath: audioPath, sourceFingerprint: studyBlock.hash });

  // Real HTTP streaming, independent of the frontend's URL construction.
  const streamed = await fetch(`${app.origin}/api/materials/${audio.id}/file`, { headers: { Range: 'bytes=0-63' } });
  assert.equal(streamed.status, 206);
  assert.equal(streamed.headers.get('content-type'), 'audio/mpeg');
  assert.equal((await streamed.arrayBuffer()).byteLength, 64);
  const missing = await fetch(`${app.origin}/api/materials/missing/file`);
  assert.equal(missing.status, 404);
  const pending = app.store.currentMaterialTask(blocks[1].id, 'infographic');
  const unavailable = await fetch(`${app.origin}/api/materials/${pending.id}/file`);
  assert.equal(unavailable.status, 400);

  const browserChecks = `async () => {
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    const waitFor = async fn => {
      const end = Date.now() + 8000;
      while (!fn()) {
        if (Date.now() > end) throw new Error('Timeout: ' + fn.toString());
        await new Promise(r => setTimeout(r, 25));
      }
    };
    choose(${JSON.stringify(book.id)});
    await waitFor(() => document.querySelectorAll('#matrix-body tr').length === 50);
    const savedAccounts = accountData;
    try {
      accountData = { current: 'default', accounts: [
        { id: 'default', enabled: true, health: { ready: true, usage: { windows: [{ window: 'corta', percent_remaining: 90 }, { window: 'semanal', percent_remaining: 80 }] } } },
        { id: 'cuenta2', enabled: true, health: { ready: true, usage: { windows: [{ percent_remaining: 30 }] } } },
        { id: 'cuenta3', enabled: true, health: { ready: true, usage: { windows: [{ percent_remaining: 0 }] } } },
        { id: 'cuenta4', enabled: false, health: { ready: false } }
      ] };
      renderAccounts();
      const panel = document.querySelector('#quota-preview');
      const rows = panel.querySelectorAll('.quota-preview-row');
      check(!panel.hidden && rows.length === 4, 'Faltan cuentas en la cuota compacta');
      check(rows[0].classList.contains('high') && rows[0].textContent.includes('80%'), 'No usa la ventana de cuota más restrictiva');
      check(rows[1].classList.contains('medium'), 'Falta color para cuota media');
      check(rows[2].classList.contains('low') && rows[2].textContent.includes('0%'), 'No distingue cuota agotada');
      check(rows[3].classList.contains('unknown') && rows[3].textContent.includes('Sin datos'), 'Inventa cuota desconocida');
      check(rows[3].querySelector('[role=progressbar]').getAttribute('aria-valuenow') === null, 'Cuota desconocida se anuncia como cero');
      check(rows[0].querySelector('[role=progressbar]').getAttribute('aria-valuenow') === '80', 'Falta valor accesible de cuota');
      check(panel.closest('.sidebar') && getComputedStyle(panel).position !== 'fixed', 'La cuota debe estar en la biblioteca sin cubrir materiales');
      panel.scrollIntoView({ block: 'nearest' });
      const bounds = panel.getBoundingClientRect();
      check(bounds.right <= innerWidth && bounds.bottom <= innerHeight + 1, 'El panel queda fuera de pantalla: ' + JSON.stringify({ right: bounds.right, bottom: bounds.bottom, width: innerWidth, height: innerHeight }));
      accountData.accounts[0].errorCode = 'QUOTA';
      renderAccounts();
      check(panel.querySelector('.quota-preview-row').textContent.includes('En espera'), 'Muestra un saldo antiguo pese al rechazo por cuota');
    } finally { accountData = savedAccounts; accountStamp = ''; renderAccounts(); }
    check(document.querySelector('#matrix-body .number').textContent === '01', 'Numeración DOM inválida');
    check(!document.querySelector('#matrix-body').textContent.includes('[object'), 'Objeto convertido a texto');
    check(document.querySelector('#matrix-body').textContent.includes('La imagen necesita revisión'), 'Error oculto');
    const restore = [...document.querySelectorAll('#matrix-body button')].find(button => button.textContent === 'Recuperar audio anterior');
    check(!!restore, 'No ofrece recuperar el audio que sigue disponible');
    restore.click();
    await waitFor(() => !!document.querySelector('#matrix-body .audio-listen-btn'));
    const buttons = [...document.querySelectorAll('#matrix-body button')].map(button => button.textContent);
    check(!buttons.some(text => /Aprobar|Rechazar|Nueva revisión/.test(text)), 'La matriz conserva acciones editoriales confusas');
    check(!document.querySelector('#matrix-body').textContent.includes('Sin revisar'), 'La matriz todavía exige revisión editorial');
    const thumbnail = document.querySelector('#matrix-body .infographic-preview img');
    await waitFor(() => thumbnail.complete && thumbnail.naturalWidth > 0);
    check(!thumbnail.src.includes('download='), 'La vista previa fuerza una descarga');
    thumbnail.closest('button').click();
    const viewer = document.querySelector('#infographic-modal');
    const fullImage = document.querySelector('#infographic-full-image');
    await waitFor(() => viewer.open && fullImage.complete && fullImage.naturalWidth > 0);
    check(document.querySelector('#infographic-title').textContent === 'Capítulo 1', 'Título incorrecto del visor');
    check(fullImage.src === thumbnail.src, 'El visor no usa el PNG existente');
    check(document.querySelector('#infographic-download').href.endsWith('?download=1'), 'Falta descarga opcional');
    document.querySelector('#infographic-close').click();
    check(!viewer.open, 'No se puede cerrar la vista ampliada');
    await waitFor(() => !fullImage.hasAttribute('src'));
    const listenBtn = document.querySelector('#matrix-body .audio-listen-btn');
    check(!!listenBtn, 'Falta botón de escuchar en la fila de audio');
    listenBtn.click();
    const player = document.querySelector('#studio-audio');
    check(!!player, 'Falta el reproductor persistente de estudio');
    player.muted = true;
    await player.play();
    await waitFor(() => player.currentTime > 0.05);
    const position = player.currentTime;
    await loadMatrix(selected);
    currentMatrix.matrix[1].materials.infographic.error = 'Nueva incidencia en otra fila';
    renderMatrix();
    check(document.querySelector('#studio-audio') === player, 'El refresco reemplazó el reproductor');
    check(document.querySelector('#matrix-body .infographic-preview img') === thumbnail, 'El refresco reemplazó la miniatura');
    check(!player.paused && player.currentTime >= position, 'El refresco interrumpió la reproducción');
    player.pause();

    await loadRecipes();
    document.querySelector('#recipe-selector').value = 'study-book';
    document.querySelector('#prepare-plan-btn').click();
    await waitFor(() => document.querySelector('#plan-modal').open);
    check(document.querySelector('#plan-modal-details').textContent.includes('Se conserva el audio existente'), 'El plan no explica que conserva el audio');
    check(document.querySelector('#plan-modal-summary .summary-card:nth-child(4) strong').textContent === '2', 'Los materiales existentes no cuentan como listos');
    document.querySelector('#plan-modal-cancel').click();

    document.querySelector('#matrix-next-page').click();
    await waitFor(() => document.querySelector('#matrix-body .number')?.textContent === '51');
    check(document.querySelector('#matrix-page-info').textContent === '2 de 2', 'Faltan controles de página');

    // A delayed response for A must never replace book B's matrix.
    matrixPage = 1;
    const nativeFetch = window.fetch;
    let release;
    window.fetch = async (url, options) => {
      const response = await nativeFetch(url, options);
      if (String(url).includes('/api/books/${book.id}/matrix')) await new Promise(r => { release = r; });
      return response;
    };
    try {
      const stale = loadMatrix(${JSON.stringify(book.id)});
      await waitFor(() => !!release);
      choose(${JSON.stringify(study.id)});
      await waitFor(() => currentMatrix?.bookId === ${JSON.stringify(study.id)});
      release();
      await stale;
      check(currentMatrix.bookId === ${JSON.stringify(study.id)}, 'Una respuesta antigua cambió el libro');
    } finally { window.fetch = nativeFetch; }

    await loadRecipes();
    document.querySelector('#recipe-selector').value = 'study-book';
    document.querySelector('#prepare-plan-btn').click();
    await waitFor(() => document.querySelector('#plan-modal').open);
    check(document.querySelector('#plan-modal-summary').textContent.includes('Libro de estudio'), 'Receta incorrecta en preview');
    check(document.querySelectorAll('#plan-modal-details tbody tr').length === 2, 'Preview no muestra los dos requisitos');
    check(document.querySelector('#plan-modal-details').textContent.includes('Infografía'), 'Infografía ausente en preview');

    // Server accepts the plan but the client loses its response: retry must reuse the requestId.
    let lostResponse = false;
    const confirmations = [];
    window.fetch = async (url, options) => {
      const response = await nativeFetch(url, options);
      if (String(url).endsWith('/plan/confirm')) {
        confirmations.push(JSON.parse(options.body));
        if (!lostResponse) { lostResponse = true; throw new Error('Respuesta perdida simulada'); }
      }
      return response;
    };
    try {
      document.querySelector('#plan-modal-confirm').click();
      await waitFor(() => lostResponse && !document.querySelector('#plan-modal-confirm').disabled);
      document.querySelector('#plan-modal-confirm').click();
      await waitFor(() => !document.querySelector('#plan-modal').open);
      check(confirmations.length === 2 && confirmations[0].requestId === confirmations[1].requestId, 'Reintento no idempotente');
      check(confirmations.every(p => p.recipeId === 'study-book' && p.recipeVersion === 1), 'Confirmó otra receta');
    } finally { window.fetch = nativeFetch; }
    const result = await nativeFetch('/api/books/${study.id}/matrix').then(r => r.json());
    check(result.summary.totalRequirements === 2, 'Confirmación creó tareas duplicadas o incompletas');
    check(result.matrix[0].materials.audio && result.matrix[0].materials.infographic, 'La receta perdió un tipo de material');
    check(result.matrix[0].materials.audio.state === 'ready', 'Reactivó un audio terminado');
    check(result.matrix[0].materials.infographic.state === 'queued', 'Confirmar dejó la infografía planeada');
    await waitFor(() => books.find(b => b.id === selected)?.running);
    check(document.querySelector('#pause').disabled === false, 'No activó la producción');
    check(document.querySelector('#progress-percent').textContent === '50%', 'Ignoró la infografía en el progreso');
    check(!document.querySelector('#feedback-text').textContent.includes('Todos los audios completados'), 'Feedback anuncia finalización prematura');
    document.querySelector('#pause').click();
    await waitFor(() => !books.find(b => b.id === selected)?.running);
    check(!document.querySelector('#generate').disabled, 'Todos los audios listos bloquearon reanudar infografías');
    document.querySelector('#generate').click();
    await waitFor(() => books.find(b => b.id === selected)?.running);
    check(document.querySelector('#generate').textContent === 'Cola en marcha', 'No reanudó la cola multimodal');
    return { ok: true };
  }`;

  const harness = join(dir, 'renderer-check.cjs');
  await writeFile(harness, `
    const { app, BrowserWindow } = require('electron');
    app.setPath('userData', ${JSON.stringify(join(dir, 'electron-profile'))});
    app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
      try {
        await win.loadURL(${JSON.stringify(app.origin)});
        const result = await win.webContents.executeJavaScript('(' + ${JSON.stringify(browserChecks)} + ')()');
        console.log('RENDERER_RESULT:' + JSON.stringify(result));
      } catch (error) { console.error(error.stack); process.exitCode = 1; }
      finally { win.destroy(); app.quit(); }
    });
  `);
  const electron = createRequire(import.meta.url)('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electron, [harness], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, output);
  assert.ok(output.includes('RENDERER_RESULT:{"ok":true}'), output);
});
