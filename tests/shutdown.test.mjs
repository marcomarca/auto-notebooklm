import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemShutdown } from '../system-shutdown.mjs';
import { Store } from '../store.mjs';
import { Queue } from '../queue.mjs';
import { makeApp } from '../server.mjs';
import { FakeProvider } from './helpers.mjs';

test('SystemShutdown maneja estados, disparador y cancelación', async () => {
  const commands = [];
  const fakeExec = (cmd, args, cb) => {
    commands.push({ cmd, args });
    if (cb) cb(null);
  };

  const shutdown = new SystemShutdown({ exec: fakeExec, platform: 'win32', mock: false });
  assert.equal(shutdown.status().active, false);

  const status1 = shutdown.trigger(60, 'Test shutdown');
  assert.equal(status1.active, true);
  assert.equal(status1.secondsLeft, 60);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].args, ['/s', '/t', '60', '/c', 'Test shutdown']);

  // Segundo disparo idempotente
  const status2 = shutdown.trigger(30);
  assert.equal(status2.active, true);
  assert.equal(commands.length, 1);

  // Cancelación
  const cancelRes = shutdown.cancel();
  assert.equal(cancelRes.active, false);
  assert.equal(shutdown.status().active, false);
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[1].args, ['/a']);
});

test('API /api/system/shutdown permite consultar, habilitar y cancelar', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bloqueaudio-shutdown-api-'));
  let app;
  t.after(async () => {
    try { await app?.close(); } finally { await rm(dir, { recursive: true, force: true }); }
  });

  const commands = [];
  const fakeExec = (cmd, args, cb) => {
    commands.push({ cmd, args });
    if (cb) cb(null);
  };
  const shutdownHandler = new SystemShutdown({ exec: fakeExec, platform: 'win32', mock: false });

  app = await makeApp({
    port: 0,
    dataDir: dir,
    exportsDir: join(dir, 'exports'),
    provider: new FakeProvider(),
    worker: false,
    check: false,
    shutdownHandler
  });

  const getHealth = () => fetch(`${app.origin}/api/health`, {
    headers: { 'X-Local-Token': app.token }
  }).then(r => r.json());

  const getShutdown = () => fetch(`${app.origin}/api/system/shutdown`, {
    headers: { 'X-Local-Token': app.token }
  }).then(r => r.json());

  const postShutdown = (enabled) => fetch(`${app.origin}/api/system/shutdown`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Local-Token': app.token },
    body: JSON.stringify({ enabled })
  }).then(r => r.json());

  const cancelShutdown = () => fetch(`${app.origin}/api/system/shutdown/cancel`, {
    method: 'POST',
    headers: { 'X-Local-Token': app.token }
  }).then(r => r.json());

  // 1. Por defecto está desactivado
  const initial = await getShutdown();
  assert.equal(initial.enabled, false);
  assert.equal(initial.active, false);

  const initialHealth = await getHealth();
  assert.equal(initialHealth.shutdownOnDispatch, false);

  // 2. Activar opción
  const enabledRes = await postShutdown(true);
  assert.equal(enabledRes.ok, true);
  assert.equal(enabledRes.enabled, true);

  const check1 = await getShutdown();
  assert.equal(check1.enabled, true);

  // 3. Desactivar opción
  const disabledRes = await postShutdown(false);
  assert.equal(disabledRes.ok, true);
  assert.equal(disabledRes.enabled, false);

  // 4. Activar y disparar cancel
  await postShutdown(true);
  shutdownHandler.trigger(60, 'Simulando disparo');
  assert.equal(shutdownHandler.status().active, true);

  const activeCheck = await getShutdown();
  assert.equal(activeCheck.active, true);

  const cancelRes = await cancelShutdown();
  assert.equal(cancelRes.cancelled, true);
  assert.equal(cancelRes.active, false);

  const afterCancel = await getShutdown();
  assert.equal(afterCancel.enabled, false);
  assert.equal(afterCancel.active, false);
  assert.ok(commands.some(c => c.args.includes('/a')));
});

test('Queue apaga el equipo exactamente cuando todas las solicitudes han sido enviadas a Google', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bloqueaudio-shutdown-queue-'));
  t.after(async () => {
    try { await rm(dir, { recursive: true, force: true }); } catch {}
  });

  const commands = [];
  const fakeExec = (cmd, args, cb) => {
    commands.push({ cmd, args });
    if (cb) cb(null);
  };
  const shutdownHandler = new SystemShutdown({ exec: fakeExec, platform: 'win32', mock: false });

  const store = new Store(join(dir, 'queue.sqlite'));
  const provider = new FakeProvider();
  let now = 1000000;
  const queue = new Queue(store, provider, {
    dataDir: dir,
    exportsDir: join(dir, 'exports'),
    now: () => now,
    shutdownHandler
  });

  // Crear libro y bloques
  const book = store.createBook({ title: 'Libro Apagado', requestId: 'req-shutdown-1' }, 'default');
  store.update('books', book.id, { remote_id: 'remote-book-1', running: 1 });

  const block1 = store.addBlock(book.id, { title: 'Capítulo 1', hash: 'h1', requestId: 'r1', filename: 'c1.md', filePath: join(dir, 'c1.md') });
  const block2 = store.addBlock(book.id, { title: 'Capítulo 2', hash: 'h2', requestId: 'r2', filename: 'c2.md', filePath: join(dir, 'c2.md') });

  // 1. Con la opción desactivada (0), no debe apagarse
  store.setSetting('shutdown_on_dispatch', '0');
  store.update('blocks', block1.id, { source_id: 'src-1', stage: 'generate', state: 'ready' });
  store.update('blocks', block2.id, { source_id: 'src-2', stage: 'generate', state: 'ready' });

  await queue.tick(); // generará bloque 1 -> stage pasa a 'poll'
  assert.equal(shutdownHandler.status().active, false);

  // 2. Activamos la opción
  store.setSetting('shutdown_on_dispatch', '1');

  // Aún queda bloque 2 en stage 'generate' -> NO debe disparar apagado
  await queue.checkShutdownOnDispatch();
  assert.equal(shutdownHandler.status().active, false);

  // 3. Caso frontera: si bloque 2 entra en cuota (espera), NO debe apagarse porque aún no fue enviado
  store.update('blocks', block2.id, { state: 'quota', next_at: now + 3600000 });
  await queue.checkShutdownOnDispatch();
  assert.equal(shutdownHandler.status().active, false);

  // 4. Bloque 2 se despacha a Google y pasa a stage 'poll'
  store.update('blocks', block2.id, { artifact_id: 'art-2', stage: 'poll', state: 'generating', next_at: now + 15000 });

  // Ahora ambos bloques están solicitados a Google (stage 'poll', no completados)
  await queue.checkShutdownOnDispatch();

  // DEBE HABERSE DISPARADO EL APAGADO
  assert.equal(shutdownHandler.status().active, true);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].args, ['/s', '/t', '60', '/c', 'BloqueAudio: Solicitudes enviadas a Google NotebookLM. Apagando el equipo en 60 segundos...']);

  // La opción debe haberse deshabilitado automáticamente en la base de datos para no repetirse
  assert.equal(store.getSetting('shutdown_on_dispatch'), '0');
});

test('Queue no apaga si el libro no está en ejecución o si no hay libros pendientes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bloqueaudio-shutdown-idle-'));
  t.after(async () => {
    try { await rm(dir, { recursive: true, force: true }); } catch {}
  });

  const commands = [];
  const fakeExec = (cmd, args, cb) => {
    commands.push({ cmd, args });
    if (cb) cb(null);
  };
  const shutdownHandler = new SystemShutdown({ exec: fakeExec, platform: 'win32', mock: false });

  const store = new Store(join(dir, 'queue.sqlite'));
  const provider = new FakeProvider();
  const queue = new Queue(store, provider, {
    dataDir: dir,
    exportsDir: join(dir, 'exports'),
    shutdownHandler
  });

  store.setSetting('shutdown_on_dispatch', '1');

  // Sin libros corriendo -> no apaga
  queue.checkShutdownOnDispatch();
  assert.equal(shutdownHandler.status().active, false);

  // Con libro pausado (running = 0) -> no apaga
  const book = store.createBook({ title: 'Libro Pausado', requestId: 'req-idle' }, 'default');
  store.update('books', book.id, { remote_id: 'remote-idle', running: 0 });
  store.addBlock(book.id, { title: 'Capítulo A', hash: 'ha', requestId: 'ra', filename: 'ca.md', filePath: join(dir, 'ca.md') });

  queue.checkShutdownOnDispatch();
  assert.equal(shutdownHandler.status().active, false);
});
