import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { makeApp } from '../server.mjs';
import { FakeProvider } from './helpers.mjs';

// Run the shipped scripts and DOM, rather than a second copy of their algorithms.
test('regresiones del plan: catálogo, cargas, scheduler, temas, avisos y diálogos en Electron', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bloqueaudio-regressions-'));
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
  const ids = ['A', 'B'].map(title => {
    const book = app.store.createBook({ title, requestId: title }, 'default');
    app.store.update('books', book.id, { remote_id: `remote-${title}`, state: 'ready' });
    return book.id;
  });
  for (const id of ids) {
    for (const [remoteId, kind, status, notVisible] of [
      ['audio', 'artifact', 'ready', false], ['absent', 'artifact', 'ready', true],
      ['uncertain', 'artifact', 'delete_uncertain', false], ['source', 'source', 'ready', false],
      ['failed', 'source', 'failed', false]
    ]) {
      const item = app.store.upsertRemoteItem({ bookId: id, remoteId: `${id}-${remoteId}`, kind, type: kind === 'artifact' ? 'audio' : 'source', status, title: remoteId });
      if (notVisible) app.store.db.prepare('UPDATE remote_items SET not_visible=1 WHERE id=?').run(item.id);
    }
  }

  const browserChecks = async ([a, b]) => {
    const results = [];
    const check = (condition, text) => { if (!condition) throw new Error(text); };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const waitFor = async fn => {
      const until = Date.now() + 4000;
      while (!fn()) { if (Date.now() > until) throw new Error('Timeout de regresión'); await sleep(10); }
    };
    const run = async (name, fn) => {
      try { await fn(); results.push({ name, ok: true }); }
      catch (error) { results.push({ name, ok: false, error: error.stack }); }
    };
    await waitFor(() => books.length === 2 && !refreshing);
    clearTimeout(refreshTimeout);
    const nativeFetch = window.fetch;
    const raw = id => nativeFetch(`/api/books/${id}/catalog`).then(r => r.json());
    selected = a; viewingExplorer = false;
    currentCatalog = normalizeCatalogResponse(await raw(a), a);
    render(); renderCatalog();

    await run('rechaza catálogo de otro libro y mantiene tipos desconocidos', () => {
      let rejected = false;
      try { normalizeCatalogResponse({ book: { id: b }, items: [] }, a); } catch { rejected = true; }
      check(rejected, 'Aceptó identidad incorrecta');
      const normalized = normalizeCatalogResponse({ book: { id: a }, items: [{ id: 'x', kind: 'artifact', source_ids_json: '{bad' }] }, a);
      check(normalized.artifacts[0].type !== 'audio', 'Inventó tipo audio');
    });
    await run('ausencias, errores y eliminaciones inciertas no son accionables', () => {
      renderCatalog();
      const arts = [...document.querySelectorAll('#catalog-artifacts-list tr')];
      check(arts.length === 3, 'No renderizó los artefactos');
      for (const title of ['absent', 'uncertain']) {
        const row = arts.find(r => r.querySelector('strong').textContent === title);
        check(row.querySelector('input').disabled, `Seleccionable: ${title}`);
        check([...row.querySelectorAll('button')].every(el => el.disabled), `Acción disponible: ${title}`);
      }
      document.querySelector('#select-all-artifacts').click();
      check(selectedCatalogArtifacts.size === 1, 'Seleccionar todos incluyó registros bloqueados');
      check([...document.querySelectorAll('#catalog-sources-list tr')].find(r => r.textContent.includes('failed')).querySelector('input').disabled, 'Fuente fallida seleccionable');
      check(document.querySelectorAll('#catalog-pane-artifacts th').length === arts[0].children.length, 'Cabeceras y columnas diferentes');
    });
    await run('render rechaza datos del libro anterior', () => {
      selected = b; renderCatalog();
      check(document.querySelector('#catalog-section').hidden, 'Mostró catálogo de A como B');
      selected = a;
    });
    await run('fallo de catálogo se muestra sin borrar caché válida', async () => {
      window.fetch = async url => String(url).includes('/catalog') ? Promise.reject(new Error('catálogo caído')) : nativeFetch(url);
      try {
        await loadCatalog(a);
        check(currentCatalog.bookId === a && !document.querySelector('#catalog-error').hidden, 'Ocultó fallo o borró caché');
      } finally { window.fetch = nativeFetch; }
    });
    await run('respuesta atrasada A no sobrescribe B', async () => {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      window.fetch = async (url, options) => {
        if (String(url).includes(`/books/${a}/catalog`)) await gate;
        return nativeFetch(url, options);
      };
      try {
        const old = loadCatalog(a);
        choose(b);
        await loadCatalog(b);
        release(); await old;
        check(currentCatalog.bookId === b, 'Aceptó respuesta atrasada');
      } finally { release(); window.fetch = nativeFetch; }
    });
    await run('terminar descarga A no borra selección nueva de B', async () => {
      choose(a); await loadCatalog(a);
      selectedCatalogArtifacts.add(currentCatalog.artifacts.find(i => i.title === 'audio').id);
      let finish;
      window.fetch = async (url, options) => String(url).endsWith('/downloads') ? new Promise(resolve => {
        const items = JSON.parse(options.body).items;
        finish = () => resolve(new Response(JSON.stringify({ accepted: items.map(i => ({ id: i.itemId })), existing: [], rejected: [] })));
      }) : nativeFetch(url, options);
      try {
        renderCatalog(); document.querySelector('#download-selected-artifacts-btn').click();
        await waitFor(() => finish);
        choose(b); await loadCatalog(b);
        const id = currentCatalog.artifacts.find(i => i.title === 'audio').id;
        selectedCatalogArtifacts.add(id);
        finish(); await sleep(50);
        check(selectedCatalogArtifacts.has(id), 'B perdió su selección al terminar A');
      } finally { finish?.(); window.fetch = nativeFetch; await waitFor(() => !refreshing); clearTimeout(refreshTimeout); }
    });
    await run('cargas reales usan filas independientes, rechazos visibles y JSON válido', async () => {
      const NativeXHR = window.XMLHttpRequest;
      let sends = 0;
      class FakeXHR {
        upload = new EventTarget();
        open() {} setRequestHeader() {}
        send() {
          sends++;
          queueMicrotask(() => {
            this.upload.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded: 1, total: 1 }));
            this.status = 200;
            this.responseText = sends === 1 ? '{bad' : JSON.stringify({ id: `saved-${sends}` });
            this.onload();
          });
        }
      }
      window.XMLHttpRequest = FakeXHR;
      try {
        await addFiles([
          new File(['one'], 'same.md'), new File(['two'], 'same.md'), new File([], 'empty.pdf'),
          { name: 'over-limit.pdf', size: 209715201 }, { name: 'at-limit.md', size: 209715200 },
          new File(['pdf'], 'UPPER.PDF', { type: '' }), new File(['bad'], 'wrong.docx')
        ]);
        const rows = [...document.querySelectorAll('.upload-item-row')];
        check(sends === 4, 'No respetó umbral de 200 MiB, extensión o tamaño cero');
        const homonyms = rows.filter(row => row.dataset.fileName === 'same.md');
        check(homonyms.length === 2 && homonyms.every(row => row.classList.contains('done')), 'Mezcló archivos homónimos');
        check(rows[0].classList.contains('error'), 'Aceptó JSON inválido como éxito');
        check(!document.querySelector('#upload-rejected-card').hidden, 'Ocultó archivos rechazados');
        check(document.querySelector('#upload-progress-title').textContent.includes('3 añadido'), 'Contadores incorrectos');
        check(getComputedStyle(rows[1].querySelector('.upload-item-progress-fill')).height !== '0px', 'Barra sin estilos');
        check(!uploading && !document.querySelector('#files').disabled, 'Dejó carga bloqueada');
      } finally { window.XMLHttpRequest = NativeXHR; await waitFor(() => !refreshing); clearTimeout(refreshTimeout); }
    });
    await run('recetas fallidas se pueden reintentar', async () => {
      recipesLoaded = false;
      window.fetch = () => Promise.reject(new Error('recetas caídas'));
      await loadRecipes();
      window.fetch = nativeFetch;
      check(!recipesLoaded, 'Marcó error como cargado');
      await loadRecipes();
      check(recipesLoaded && recipes.length, 'No recuperó recetas');
    });
    await run('XHR guarda un archivo pequeño contra el endpoint real', async () => {
      const result = await uploadFileWithProgress(`/api/books/${selected}/files?filename=real.md&requestId=regression-real`, new File(['# Texto real'], 'real.md'), token, () => {});
      check(typeof result.id === 'string', 'El servidor no confirmó el archivo');
      const data = await nativeFetch('/api/books').then(r => r.json());
      check(data.find(book => book.id === selected).blocks.some(block => block.id === result.id), 'La subida no quedó guardada');
    });
    await run('timeout funciona incluso con señal externa', async () => {
      window.fetch = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      try {
        let timedOut = false;
        try { await api('/test-timeout', { timeout: 20, signal: new AbortController().signal }); }
        catch { timedOut = true; }
        check(timedOut && timedReadControllers.size === 0, 'Timeout ignorado o controlador filtrado');
      } finally { window.fetch = nativeFetch; }
    });
    await run('refresco espera lecturas derivadas y combina solicitudes pendientes', async () => {
      clearTimeout(refreshTimeout);
      let healthCalls = 0, releaseHealth, releaseMatrix;
      const healthGate = new Promise(resolve => { releaseHealth = resolve; });
      const matrixGate = new Promise(resolve => { releaseMatrix = resolve; });
      window.fetch = async (url, options) => {
        if (url === '/api/health') { healthCalls++; if (healthCalls === 1) await healthGate; }
        if (String(url).includes('/matrix')) await matrixGate;
        return nativeFetch(url, options);
      };
      try {
        activeViewTab = 'matrix';
        const cycle = refresh();
        for (let i = 0; i < 10; i++) scheduleImmediateRefresh();
        releaseHealth(); await sleep(50);
        check(refreshing, 'Terminó ciclo mientras matriz seguía pendiente');
        releaseMatrix(); await cycle;
        await waitFor(() => healthCalls >= 2 && !refreshing);
        await sleep(80);
        check(healthCalls === 2, `Esperaba dos ciclos, recibió ${healthCalls}`);
      } finally { releaseHealth(); releaseMatrix(); window.fetch = nativeFetch; clearTimeout(refreshTimeout); }
    });
    await run('tema valida almacenamiento y alinea controles nativos', () => {
      document.documentElement.style.colorScheme = 'dark';
      applyTheme('light');
      check(getComputedStyle(document.documentElement).colorScheme === 'light', 'Controles nativos quedaron oscuros');
      applyTheme('dark');
      check(getComputedStyle(document.documentElement).colorScheme === 'dark', 'Controles nativos quedaron claros');
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'invalid' }));
      check(document.querySelector('#theme-selector').value === 'system', 'No normalizó preferencia corrupta');
      const expected = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      check(document.documentElement.dataset.theme === expected, 'Tema sistema inconsistente');
      const nativeSetItem = Storage.prototype.setItem;
      try {
        Storage.prototype.setItem = () => { throw new Error('Almacenamiento bloqueado'); };
        choose(selected === a ? b : a);
        document.querySelector('#theme-selector').value = 'dark';
        document.querySelector('#theme-selector').dispatchEvent(new Event('change'));
        check(document.documentElement.dataset.theme === 'dark', 'Tema dependió del guardado');
      } finally { Storage.prototype.setItem = nativeSetItem; }
    });
    await run('buffer conserva huecos y se limpia al fallar el audio', () => {
      const audio = studioPlayer.audio;
      try {
        studioPlayer.audio = { duration: 100, error: null, buffered: { length: 2, start: i => [0, 60][i], end: i => [20, 90][i] } };
        studioPlayer.updateBufferBar();
        const background = document.querySelector('#player-buffer-bar').style.background;
        check(background.includes('20%') && background.includes('60%'), 'Unió huecos del buffer');
        studioPlayer.audio.error = {};
        studioPlayer.updateBufferBar();
        check(document.querySelector('#player-buffer-bar').style.background === 'transparent', 'Dejó buffer de audio fallido');
      } finally { studioPlayer.audio = audio; }
    });
    await run('un éxito ajeno no borra errores y recuperación limpia conexión', () => {
      notice('Error importante', true);
      notice('Guardado correcto'); notice('');
      check(document.querySelector('#notice-container').textContent.includes('Error importante'), 'Éxito borró error');
      notice('Conexión perdida', true, { source: 'connection' });
      notice('', false, { source: 'connection' });
      check(!document.querySelector('#notice-container').textContent.includes('Conexión perdida'), 'Error de conexión quedó obsoleto');
    });
    await run('cerrar diálogos limpia objetivos y evita doble confirmación', async () => {
      openDeleteModal(books.find(i => i.id === selected), 'remote-artifact', 'Audio');
      document.querySelector('#delete-modal').requestClose();
      await sleep(30);
      check(pendingDeleteTarget === null, 'Escape conservó objetivo de eliminación');
      await openPlanPreview();
      document.querySelector('#plan-modal').requestClose();
      await sleep(30);
      check(currentPlanPreview === null && planRequestId === null, 'Escape conservó plan cerrado');
      await openPlanPreview();
      let calls = 0, finish;
      window.fetch = async (url, options) => String(url).endsWith('/plan/confirm') ? new Promise(resolve => { calls++; finish = () => resolve(new Response(JSON.stringify({ running: false }))); }) : nativeFetch(url, options);
      try {
        const first = confirmPlan(); const second = confirmPlan();
        await waitFor(() => finish);
        document.querySelector('#plan-modal').requestClose();
        check(document.querySelector('#plan-modal').open, 'Escape permitió repetir solicitud pendiente');
        finish(); await Promise.all([first, second]);
        check(calls === 1, 'Doble solicitud de confirmación');
      } finally { finish?.(); window.fetch = nativeFetch; clearTimeout(refreshTimeout); }
    });
    await run('pagehide detiene scheduler y pageshow lo reanuda', async () => {
      window.fetch = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      const pending = api('/pending-read', { timeout: 1000 }).catch(() => 'aborted');
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
      check(await pending === 'aborted' && timedReadControllers.size === 0, 'Lectura pendiente sobrevivió al cierre');
      window.fetch = nativeFetch;
      check(refreshTimeout === null, 'Quedó timer tras pagehide');
      scheduleImmediateRefresh();
      check(refreshTimeout === null, 'Reactivó timer durante cierre');
      window.dispatchEvent(new PageTransitionEvent('pageshow'));
      check(refreshTimeout !== null, 'No reanudó al volver');
    });
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    return results;
  };

  const harness = join(dir, 'regression-renderer.cjs');
  const script = `(${browserChecks.toString()})(${JSON.stringify(ids)})`;
  await writeFile(harness, `
    const { app, BrowserWindow } = require('electron');
    app.setPath('userData', ${JSON.stringify(join(dir, 'profile'))});
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
      try {
        await win.loadURL(${JSON.stringify(app.origin)});
        console.log('REGRESSION_RESULT:' + JSON.stringify(await win.webContents.executeJavaScript(${JSON.stringify(script)})));
      } catch (error) { console.error(error.stack); process.exitCode = 1; }
      finally { win.destroy(); app.quit(); }
    });
  `);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(createRequire(import.meta.url)('electron'), [harness], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, output);
  const line = output.split(/\r?\n/).find(line => line.startsWith('REGRESSION_RESULT:'));
  assert.ok(line, output);
  const results = JSON.parse(line.slice('REGRESSION_RESULT:'.length));
  assert.equal(results.length, 16);
  assert.deepEqual(results.filter(r => !r.ok), [], JSON.stringify(results.filter(r => !r.ok), null, 2));
});
