import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { makeApp } from '../server.mjs';
import { FakeProvider } from './helpers.mjs';

test('HTTP audio streaming: GET, HEAD, Range 206, 416, 404 y download header para ambas rutas', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-http-'));
  let app;
  t.after(async () => {
    try { await app?.close(); } finally { await rm(dir, { recursive: true, force: true }); }
  });

  app = await makeApp({ port: 0, dataDir: dir, exportsDir: join(dir, 'exports'), provider: new FakeProvider(), worker: false, check: false });
  const book = app.store.createBook({ title: 'Libro HTTP', requestId: 'http-book' }, 'default');
  app.store.update('books', book.id, { remote_id: 'remote-http', state: 'ready' });
  const block = app.store.addBlock(book.id, {
    requestId: 'http-block', title: 'Capítulo HTTP', filename: 'http.md', filePath: '', hash: 'hash-http'
  });

  const audioPath = join(dir, 'audio-test.mp3');
  const encoded = spawnSync(process.env.FFMPEG_BINARY || 'ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-c:a', 'libmp3lame', audioPath
  ], { windowsHide: true, timeout: 10000 });
  assert.equal(encoded.status, 0, String(encoded.stderr));

  app.store.update('blocks', block.id, { state: 'done', stage: 'convert', source_id: 'src-1', output_path: audioPath });
  const material = app.store.createMaterialTask({
    bookId: book.id, blockId: block.id, type: 'audio', state: 'ready', outputPath: audioPath, sourceFingerprint: block.hash
  });

  const endpoints = [
    { name: 'material endpoint', url: `${app.origin}/api/materials/${material.id}/file` },
    { name: 'block endpoint', url: `${app.origin}/api/blocks/${block.id}/audio` }
  ];

  for (const ep of endpoints) {
    // 1. GET full file
    const resGet = await fetch(ep.url);
    assert.equal(resGet.status, 200, `${ep.name} GET full failed`);
    assert.equal(resGet.headers.get('content-type'), 'audio/mpeg');
    assert.equal(resGet.headers.get('accept-ranges'), 'bytes');
    const totalSize = (await resGet.arrayBuffer()).byteLength;
    assert.ok(totalSize > 0, `${ep.name} size should be > 0`);

    // 2. HEAD request
    const resHead = await fetch(ep.url, { method: 'HEAD' });
    assert.equal(resHead.status, 200, `${ep.name} HEAD failed`);
    assert.equal(resHead.headers.get('content-type'), 'audio/mpeg');
    assert.equal(Number(resHead.headers.get('content-length')), totalSize);

    // 3. Valid Range request (first 64 bytes)
    const resRange = await fetch(ep.url, { headers: { Range: 'bytes=0-63' } });
    assert.equal(resRange.status, 206, `${ep.name} Range 0-63 failed`);
    assert.equal(resRange.headers.get('content-range'), `bytes 0-63/${totalSize}`);
    assert.equal((await resRange.arrayBuffer()).byteLength, 64);

    // 4. Unsatisfiable Range request
    const resUnsat = await fetch(ep.url, { headers: { Range: `bytes=${totalSize + 500}-${totalSize + 1000}` } });
    assert.equal(resUnsat.status, 416, `${ep.name} Range 416 failed`);

    // 5. Download attachment header
    const resDl = await fetch(`${ep.url}?download=1`);
    assert.equal(resDl.status, 200);
    assert.ok(resDl.headers.get('content-disposition')?.includes('attachment;'), `${ep.name} attachment missing`);
  }

  // 6. Missing file on disk returns 404
  const missingMat = await fetch(`${app.origin}/api/materials/nonexistent/file`);
  assert.equal(missingMat.status, 404);

  const blockMissing = app.store.addBlock(book.id, {
    requestId: 'block-missing', title: 'Missing', filename: 'm.md', filePath: '', hash: 'm-hash'
  });
  app.store.update('blocks', blockMissing.id, { state: 'done', stage: 'convert', source_id: 'src-m', output_path: join(dir, 'no-file.mp3') });
  const missingBlockRes = await fetch(`${app.origin}/api/blocks/${blockMissing.id}/audio`);
  assert.equal(missingBlockRes.status, 404);
});

test('Reproductor de estudio: integración completa en Electron real con audio decodificable de 60s', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bloqueaudio-studio-player-'));
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
  const bookA = app.store.createBook({ title: 'Libro de Estudio A', requestId: 'book-a' }, 'default');
  app.store.update('books', bookA.id, { remote_id: 'remote-a', state: 'ready' });

  const bookB = app.store.createBook({ title: 'Libro de Estudio B', requestId: 'book-b' }, 'default');
  app.store.update('books', bookB.id, { remote_id: 'remote-b', state: 'ready' });

  // 60-second audio fixture
  const audio60Path = join(dir, 'audio60.mp3');
  const enc60 = spawnSync(process.env.FFMPEG_BINARY || 'ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60', '-c:a', 'libmp3lame', audio60Path
  ], { windowsHide: true, timeout: 15000 });
  assert.equal(enc60.status, 0, String(enc60.stderr));

  // Secondary audio fixture for track B
  const audioBPath = join(dir, 'audioB.mp3');
  const encB = spawnSync(process.env.FFMPEG_BINARY || 'ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=30', '-c:a', 'libmp3lame', audioBPath
  ], { windowsHide: true, timeout: 15000 });
  assert.equal(encB.status, 0, String(encB.stderr));

  // Blocks for Book A
  const blockA1 = app.store.addBlock(bookA.id, {
    requestId: 'block-a1', title: 'Capítulo 1: Fundamentos', filename: 'cap1.md', filePath: '', hash: 'hash-a1'
  });
  app.store.update('blocks', blockA1.id, { state: 'done', stage: 'convert', source_id: 'src-a1', output_path: audio60Path });
  const matA1 = app.store.createMaterialTask({
    bookId: bookA.id, blockId: blockA1.id, type: 'audio', state: 'ready', outputPath: audio60Path, sourceFingerprint: blockA1.hash
  });

  const blockA2 = app.store.addBlock(bookA.id, {
    requestId: 'block-a2', title: 'Capítulo 2: Profundización', filename: 'cap2.md', filePath: '', hash: 'hash-a2'
  });
  app.store.update('blocks', blockA2.id, { state: 'done', stage: 'convert', source_id: 'src-a2', output_path: audioBPath });
  app.store.createMaterialTask({
    bookId: bookA.id, blockId: blockA2.id, type: 'audio', state: 'ready', outputPath: audioBPath, sourceFingerprint: blockA2.hash
  });

  // Infographic in book A row 1
  const imgPath = join(dir, 'info.png');
  const encImg = spawnSync(process.env.FFMPEG_BINARY || 'ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=c=purple:s=160x100', '-frames:v', '1', imgPath
  ], { windowsHide: true, timeout: 10000 });
  assert.equal(encImg.status, 0, String(encImg.stderr));
  app.store.createMaterialTask({
    bookId: bookA.id, blockId: blockA1.id, type: 'infographic', state: 'ready', outputPath: imgPath, sourceFingerprint: blockA1.hash
  });

  // Block for Book B
  const blockB1 = app.store.addBlock(bookB.id, {
    requestId: 'block-b1', title: 'Capítulo B1: Exploración', filename: 'b1.md', filePath: '', hash: 'hash-b1'
  });
  app.store.update('blocks', blockB1.id, { state: 'done', stage: 'convert', source_id: 'src-b1', output_path: audioBPath });
  app.store.createMaterialTask({
    bookId: bookB.id, blockId: blockB1.id, type: 'audio', state: 'ready', outputPath: audioBPath, sourceFingerprint: blockB1.hash
  });

  const screenshotsDir = join(dir, 'screenshots');
  await mkdir(screenshotsDir, { recursive: true });

  const browserChecks = `async () => {
    const check = (ok, msg) => { if (!ok) throw new Error(msg); };
    const waitFor = async (fn, timeout = 8000) => {
      const end = Date.now() + timeout;
      while (!fn()) {
        if (Date.now() > end) throw new Error('Timeout: ' + fn.toString());
        await new Promise(r => setTimeout(r, 25));
      }
    };

    choose(${JSON.stringify(bookA.id)});
    await waitFor(() => document.querySelectorAll('#matrix-body tr').length === 2);

    const playerBar = document.querySelector('#studio-player');
    const audio = document.querySelector('#studio-audio');
    check(!!playerBar && !!audio, 'Faltan elementos del reproductor de estudio');
    check(playerBar.hidden, 'La barra de estudio debe estar oculta antes de seleccionar audio');

    // 1. Dos entradas: clic en "Escuchar" en Matriz
    audio.muted = true;
    const matrixListenBtn = document.querySelector('#matrix-body .audio-listen-btn');
    check(!!matrixListenBtn, 'Falta botón Escuchar en la matriz');
    matrixListenBtn.click();

    await waitFor(() => !playerBar.hidden && !audio.paused && audio.duration > 50);
    check(document.body.classList.contains('has-studio-player'), 'Falta clase body has-studio-player');
    check(document.querySelector('#player-title').textContent.includes('Capítulo 1'), 'Título no muestra capítulo');
    check(document.querySelector('#player-book').textContent.includes('Libro de Estudio A'), 'No muestra nombre de libro');

    // Comprobar que en la matriz el botón cambió a "Pausar" y tiene badge Sonando
    check(matrixListenBtn.textContent === 'Pausar', 'El botón de matriz no cambió a Pausar');
    check(matrixListenBtn.classList.contains('is-active-track'), 'Falta clase activa en botón de fila');

    // Comprobar la vista de capítulos: debe reflejar el mismo audio activo
    document.querySelector('#tab-view-blocks').click();
    await waitFor(() => !document.querySelector('#blocks-section').hidden);
    const chapterListenBtn = document.querySelector('#blocks .audio-listen-btn');
    check(!!chapterListenBtn, 'Falta botón Escuchar en la vista de capítulos');
    check(chapterListenBtn.textContent === 'Pausar', 'Capítulos no sincroniza estado con la matriz');
    check(chapterListenBtn.classList.contains('is-active-track'), 'Falta clase activa en capítulos');

    // 2. Pausa y continuación
    document.querySelector('#player-play-btn').click();
    await waitFor(() => audio.paused);
    const pausedTime = audio.currentTime;
    await new Promise(r => setTimeout(r, 200));
    check(Math.abs(audio.currentTime - pausedTime) < 0.05, 'El tiempo avanzó estando en pausa');
    check(document.querySelector('#player-play-label').textContent === 'Reproducir', 'Botón no cambió a Reproducir');
    check(chapterListenBtn.textContent === 'Escuchar', 'Fila no cambió a Escuchar al pausar');

    // Reanudar desde la fila de capítulos
    chapterListenBtn.click();
    await waitFor(() => !audio.paused && audio.currentTime > pausedTime);
    check(audio.currentTime > pausedTime, 'Continuar no hizo avanzar el audio');

    // Volver a matriz
    document.querySelector('#tab-view-matrix').click();
    await waitFor(() => !document.querySelector('#matrix-section').hidden);

    // 3. Saltos +15 y -15 y slider
    const t0 = audio.currentTime;
    document.querySelector('#player-step-forward').click();
    await waitFor(() => audio.currentTime >= t0 + 13);
    const t1 = audio.currentTime;
    check(t1 >= t0 + 13 && t1 <= t0 + 17, 'Salto +15s inexacto: ' + (t1 - t0));

    document.querySelector('#player-step-back').click();
    await waitFor(() => audio.currentTime <= t1 - 13);

    // Salto cerca de inicio (no debe bajar de 0)
    audio.currentTime = 5;
    document.querySelector('#player-step-back').click();
    check(audio.currentTime === 0, 'Salto hacia atrás no respetó límite 0: ' + audio.currentTime);

    // Salto cerca de fin (no debe exceder duration)
    audio.currentTime = audio.duration - 5;
    document.querySelector('#player-step-forward').click();
    check(audio.currentTime === audio.duration, 'Salto adelante excedió duración');

    // Búsqueda con slider
    const progress = document.querySelector('#player-progress');
    progress.value = 45;
    progress.dispatchEvent(new Event('change'));
    await waitFor(() => Math.abs(audio.currentTime - 45) < 0.5);

    // 4. Velocidad: 1×, 2×, 2,5× y conservando tono
    const rateSelect = document.querySelector('#player-rate-select');
    check(audio.preservesPitch === true, 'No conserva el tono de reproducción');

    rateSelect.value = '2';
    rateSelect.dispatchEvent(new Event('change'));
    check(audio.playbackRate === 2, 'No aplicó velocidad 2x');

    rateSelect.value = '2.5';
    rateSelect.dispatchEvent(new Event('change'));
    check(audio.playbackRate === 2.5, 'No aplicó velocidad 2.5x');

    rateSelect.value = '0.75';
    rateSelect.dispatchEvent(new Event('change'));
    check(audio.playbackRate === 0.75, 'No aplicó velocidad 0.75x');

    rateSelect.value = '1';
    rateSelect.dispatchEvent(new Event('change'));
    check(audio.playbackRate === 1, 'No restauró velocidad 1x');

    // 5. Volumen y silenciar/restaurar
    const muteBtn = document.querySelector('#player-mute-btn');
    audio.muted = false;
    audio.volume = 0.8;
    audio.dispatchEvent(new Event('volumechange'));
    muteBtn.click();
    check(audio.muted === true, 'No silenció el audio');
    muteBtn.click();
    check(audio.muted === false && audio.volume === 0.8, 'No restauró el volumen previo');
    audio.muted = true;

    // 6. Refrescos continuos mientras reproduce a 2x y cambio de infografía
    rateSelect.value = '2';
    rateSelect.dispatchEvent(new Event('change'));
    if (audio.paused) await audio.play();
    const curBefore = audio.currentTime;
    for (let i = 0; i < 20; i++) {
      currentMatrix.matrix[0].materials.infographic.error = 'Test de refresco ' + i;
      renderMatrix();
    }
    check(document.querySelector('#studio-audio') === audio, 'Refrescos reemplazaron el elemento audio');
    check(!audio.paused, 'Refrescos interrumpieron la reproducción');
    check(audio.playbackRate === 2, 'Refrescos alteraron la velocidad');
    check(audio.currentTime >= curBefore, 'Refrescos retrocedieron la posición');

    // 7. Navegación entre libros
    choose(${JSON.stringify(bookB.id)});
    await waitFor(() => currentMatrix?.bookId === ${JSON.stringify(bookB.id)});
    check(document.querySelector('#studio-audio') === audio, 'Cambio de libro destruyó el reproductor');
    check(!audio.paused, 'Cambio de libro pausó la reproducción');
    check(document.querySelector('#player-title').textContent.includes('Capítulo 1'), 'Perdió el título del audio');
    check(document.querySelector('#player-book').textContent.includes('Libro de Estudio A'), 'Perdió la identidad del libro');

    // 8. Carrera rápida A -> B
    choose(${JSON.stringify(bookA.id)});
    await waitFor(() => document.querySelectorAll('#matrix-body tr').length === 2);
    const btnA2 = document.querySelectorAll('#matrix-body .audio-listen-btn')[1];
    check(!!btnA2, 'Falta botón de segundo audio');
    btnA2.click(); // Cambiar a pista 2
    await waitFor(() => document.querySelector('#player-title').textContent.includes('Capítulo 2'));
    check(document.querySelector('#player-title').textContent.includes('Capítulo 2'), 'No actualizó título a capítulo 2');
    check(document.querySelectorAll('#matrix-body .audio-listen-btn')[1].classList.contains('is-active-track'), 'No marcó pista 2 activa');
    check(!document.querySelectorAll('#matrix-body .audio-listen-btn')[0].classList.contains('is-active-track'), 'Pista 1 sigue activa');

    // 9. Teclado: Espacio y flechas
    // Probar Espacio sobre superficie neutra (body)
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
    await waitFor(() => audio.paused);
    check(audio.paused, 'Espacio en superficie neutra no pausó');

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
    await waitFor(() => !audio.paused);
    check(!audio.paused, 'Espacio en superficie neutra no reanudó');

    // Flecha izquierda -15s
    const tBeforeKey = audio.currentTime;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft', key: 'ArrowLeft', bubbles: true }));
    check(audio.currentTime <= Math.max(0, tBeforeKey - 10), 'Flecha izquierda no retrocedió');

    // En campo de texto (search input): Espacio no debe pausar el audio
    const searchInput = document.querySelector('#library-search-input');
    if (searchInput) {
      searchInput.focus();
      const pausedBefore = audio.paused;
      searchInput.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
      check(audio.paused === pausedBefore, 'Espacio en campo de texto alteró la reproducción');
    }

    // 10. Evento ended: permite reiniciar desde 0 y no avanza solo
    await waitFor(() => Number.isFinite(audio.duration) && audio.duration > 0);
    audio.currentTime = audio.duration - 0.2;
    await waitFor(() => audio.ended, 5000);
    check(audio.ended, 'El audio no terminó');
    check(document.querySelector('#player-badge').textContent === 'Terminado', 'Badge no anuncia Terminado');
    check(document.querySelector('#player-play-label').textContent === 'Reproducir de nuevo', 'No ofrece reproducir de nuevo');

    // Clic en reproducir de nuevo debe empezar desde 0
    document.querySelector('#player-play-btn').click();
    await waitFor(() => !audio.paused);
    check(audio.currentTime < 2, 'No reinició desde el principio al terminar');

    audio.pause();
    return { ok: true };
  }`;

  const harness = join(dir, 'studio-player-harness.cjs');
  await writeFile(harness, `
    const { app, BrowserWindow } = require('electron');
    const { writeFile } = require('node:fs/promises');
    const { join } = require('node:path');

    app.setPath('userData', ${JSON.stringify(join(dir, 'electron-profile'))});
    app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

    app.whenReady().then(async () => {
      const win = new BrowserWindow({
        width: 1280,
        height: 860,
        show: false,
        webPreferences: { backgroundThrottling: false }
      });
      win.webContents.on('console-message', (event, level, message, line, sourceId) => {
        console.log('RENDERER_CONSOLE: ' + message + ' (' + sourceId + ':' + line + ')');
      });
      try {
        await win.loadURL(${JSON.stringify(app.origin)});
        const result = await win.webContents.executeJavaScript('(' + ${JSON.stringify(browserChecks)} + ')()');
        console.log('STUDIO_RESULT:' + JSON.stringify(result));

        // Capturas en 3 resoluciones
        // 1. 1280x860
        const shot1280 = await win.capturePage();
        await writeFile(join(${JSON.stringify(screenshotsDir)}, 'studio-player-1280x860.png'), shot1280.toPNG());

        // 2. 900x600 (tamaño mínimo)
        win.setSize(900, 600);
        await new Promise(r => setTimeout(r, 200));
        const shot900 = await win.capturePage();
        await writeFile(join(${JSON.stringify(screenshotsDir)}, 'studio-player-900x600.png'), shot900.toPNG());

        // 3. 390x844 (vista web móvil estrecha)
        win.setSize(390, 844);
        await new Promise(r => setTimeout(r, 200));
        const shot390 = await win.capturePage();
        await writeFile(join(${JSON.stringify(screenshotsDir)}, 'studio-player-390x844.png'), shot390.toPNG());

        console.log('SCREENSHOTS_SAVED:true');
      } catch (error) {
        console.error(error.stack);
        process.exitCode = 1;
      } finally {
        win.destroy();
        app.quit();
      }
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
  assert.ok(output.includes('STUDIO_RESULT:{"ok":true}'), output);
  assert.ok(output.includes('SCREENSHOTS_SAVED:true'), output);

  const artifactDir = process.env.BLOQUEAUDIO_TEST_ARTIFACTS_DIR;
  if (artifactDir) {
    await mkdir(artifactDir, { recursive: true });
    for (const name of ['studio-player-1280x860.png', 'studio-player-900x600.png', 'studio-player-390x844.png']) {
      await writeFile(join(artifactDir, name), await readFile(join(screenshotsDir, name)));
    }
  }
});
