import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../server.mjs';
import { FakeProvider } from './helpers.mjs';
import { ProviderError, CommandRunner } from '../provider.mjs';
import { syncNotebook } from '../sync.mjs';

class CancellationProvider extends FakeProvider {
  constructor(profile = 'default') {
    super();
    this.profile = profile;
    this.deleteCalls = 0;
    this.generateCalls = 0;
    this.remoteNotebooks = [{ id: 'nb-cancel-1', title: 'Cuaderno Cancelación' }];
    this.remoteSources = [{ id: 'src-1', title: 'Fuente 1', status: 2 }];
    this.remoteArtifacts = [];
    this.onPreflight = null;
    this.onGenerate = null;
  }
  async listBooks() { return this.remoteNotebooks; }
  async sources(bookId) { return this.remoteSources; }
  async artifacts(bookId, id) {
    if (this.onPreflight) await this.onPreflight();
    return this.remoteArtifacts.filter(a => !id || (a.artifact_id || a.id) === id);
  }
  async generate(bookId, sourceId) {
    this.generateCalls++;
    if (this.onGenerate) await this.onGenerate();
    const artId = `art-gen-${this.generateCalls}`;
    this.remoteArtifacts.push({
      artifact_id: artId,
      type: 'audio',
      title: `Audio ${this.generateCalls}`,
      status: 'completed',
      source_ids: [sourceId]
    });
    return artId;
  }
  async deleteArtifact(bookId, id) {
    this.deleteCalls++;
    if (this.behavior.deleteArtifact) throw this.behavior.deleteArtifact;
    const idx = this.remoteArtifacts.findIndex(a => (a.artifact_id || a.id) === id);
    if (idx !== -1) this.remoteArtifacts.splice(idx, 1);
    return { ok: true };
  }
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-cancel-'));
  const provider = new CancellationProvider('default');
  const app = await makeApp({
    dataDir: dir,
    exportsDir: join(dir, 'exports'),
    provider,
    accountFactory: id => new CancellationProvider(id),
    port: 0,
    worker: false,
    check: false
  });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = (path, method = 'GET', data) => fetch(app.origin + path, {
    method,
    headers: {
      'X-Local-Token': app.token,
      ...(data ? { 'Content-Type': 'application/json' } : {})
    },
    body: data ? JSON.stringify(data) : undefined
  });
  return { app, provider, call, dir };
}

test('C1: Cancelar antes de enviar resulta en cero llamadas de creación', async t => {
  const f = await fixture(t);
  const syncRes = await f.call('/api/remote/notebooks/nb-cancel-1/sync', 'POST', { profile: 'default' });
  const { bookId } = await syncRes.json();

  // Crear bloque para generación
  const block = f.app.store.addRemoteSourceBlock(bookId, { sourceId: 'src-1', title: 'Audio 1' });
  f.app.store.update('books', bookId, { running: 1 });

  // Cancelar antes de que la cola lo procese
  const cancelRes = await f.call(`/api/blocks/${block.id}/cancel`, 'POST', { reason: 'Cancelado por prueba C1' });
  assert.equal(cancelRes.status, 200);
  const cancelData = await cancelRes.json();
  assert.equal(cancelData.alreadyRemote, false);

  // Ejecutar step de la cola
  await f.app.queue.step();
  assert.equal(f.provider.generateCalls, 0, 'No debe llamar a generar audio');
  const updatedBlock = f.app.store.block(block.id);
  assert.equal(updatedBlock.state, 'canceled');
});

test('C2: Cancelar durante el preflight impide el envío antes de despachar', async t => {
  const f = await fixture(t);
  const syncRes = await f.call('/api/remote/notebooks/nb-cancel-1/sync', 'POST', { profile: 'default' });
  const { bookId } = await syncRes.json();

  const block = f.app.store.addRemoteSourceBlock(bookId, { sourceId: 'src-1', title: 'Audio Preflight' });
  f.app.store.update('books', bookId, { running: 1 });

  // Hook durante el preflight (artifacts) para solicitar cancelación justo antes de despachar
  f.provider.onPreflight = async () => {
    await f.call(`/api/blocks/${block.id}/cancel`, 'POST', { reason: 'Cancelado en preflight' });
  };

  await f.app.queue.step();
  assert.equal(f.provider.generateCalls, 0, 'La última comprobación antes del envío debe impedir el despacho');
  const updatedBlock = f.app.store.block(block.id);
  assert.equal(updatedBlock.state, 'canceled');
});

test('C3: Cancelar después de despachar guarda ID pero no descarga automáticamente', async t => {
  const f = await fixture(t);
  const syncRes = await f.call('/api/remote/notebooks/nb-cancel-1/sync', 'POST', { profile: 'default' });
  const { bookId } = await syncRes.json();

  const block = f.app.store.addRemoteSourceBlock(bookId, { sourceId: 'src-1', title: 'Audio En Vuelo' });
  f.app.store.update('books', bookId, { running: 1 });

  // Hook mientras generate() está en vuelo: cancelar el bloque
  f.provider.onGenerate = async () => {
    f.app.store.update('blocks', block.id, {
      cancel_requested_at: Date.now(),
      canceled_at: Date.now(),
      state: 'canceled'
    });
  };

  await f.app.queue.step();
  assert.equal(f.provider.generateCalls, 1);
  const afterStep = f.app.store.block(block.id);
  assert.ok(afterStep.artifact_id, 'Debe guardar el artifact_id devuelto por Google');
  assert.equal(afterStep.state, 'canceled', 'Debe mantenerse cancelado');
  assert.notEqual(afterStep.stage, 'poll', 'No debe avanzar a polling normal');

  // Ejecutar steps posteriores: no debe descargar
  await f.app.queue.step();
  assert.equal(f.provider.calls.filter(c => c[0] === 'download').length, 0, 'Cero descargas automáticas');
});

test('C4: Cancelar bloques pendientes clasifica diez solicitudes ya aceptadas como remotas', async t => {
  const f = await fixture(t);
  const syncRes = await f.call('/api/remote/notebooks/nb-cancel-1/sync', 'POST', { profile: 'default' });
  const { bookId } = await syncRes.json();

  // Crear 10 bloques ya aceptados (con artifact_id)
  for (let i = 1; i <= 10; i++) {
    const b = f.app.store.addRemoteSourceBlock(bookId, { sourceId: `src-${i}`, title: `Capítulo ${i}` });
    f.app.store.update('blocks', b.id, {
      artifact_id: `art-${i}`,
      stage: 'poll',
      state: 'generating'
    });
  }

  // Cancelar todos los pendientes del libro
  const cancelRes = await f.call(`/api/books/${bookId}/cancel-pending`, 'POST');
  assert.equal(cancelRes.status, 200);
  const data = await cancelRes.json();

  assert.equal(data.alreadyRemoteCount, 10);
  assert.equal(data.canceledCount, 10);
  assert.match(data.message, /10 trabajo\(s\) ya habían sido enviados a NotebookLM/);

  const blocks = f.app.store.blocks(bookId);
  assert.ok(blocks.every(b => b.state === 'canceled'));
});

test('C5: Cancelar un proceso individual con CommandRunner no afecta a otros comandos', async t => {
  const runner = new CommandRunner();
  const controller = new AbortController();

  // Iniciar comando que se cancelará
  const cancelPromise = runner.run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { signal: controller.signal });
  // Iniciar otro comando concurrente que NO se cancelará
  const normalPromise = runner.run(process.execPath, ['-e', 'console.log("ok")']);

  controller.abort();

  await assert.rejects(cancelPromise, (err) => err.code === 'ABORTED');
  const normalResult = await normalPromise;
  assert.match(normalResult, /ok/);
  assert.equal(runner.closed, false, 'El runner general debe seguir operativo');

  await runner.close();
});

test('C6: Reinicio, sesión renovada o reintentos no reviven bloques cancelados', async t => {
  const f = await fixture(t);
  const syncRes = await f.call('/api/remote/notebooks/nb-cancel-1/sync', 'POST', { profile: 'default' });
  const { bookId } = await syncRes.json();

  const block = f.app.store.addRemoteSourceBlock(bookId, { sourceId: 'src-1', title: 'Bloque a Cancelar' });
  f.app.queue.cancelBlock(block.id, 'Cancelado permanentemente');

  // 1. Simular reinicio (recover)
  f.app.store.recover();
  const afterRecover = f.app.store.block(block.id);
  assert.equal(afterRecover.state, 'canceled');

  // 2. Simular retryBlock
  f.app.queue.retryBlock(block.id);
  const afterRetry = f.app.store.block(block.id);
  assert.equal(afterRetry.state, 'canceled', 'retryBlock no debe revivir bloques cancelados');

  // 3. Simular step de la cola
  f.app.store.update('books', bookId, { running: 1 });
  await f.app.queue.step();
  assert.equal(f.provider.generateCalls, 0, 'No debe ejecutarse tras step');
});

test('C7: Solicitar borrado sin confirmación es rechazado sin llamadas remotas', async t => {
  const f = await fixture(t);
  const syncRes = await f.call('/api/remote/notebooks/nb-cancel-1/sync', 'POST', { profile: 'default' });
  const { bookId } = await syncRes.json();

  f.app.store.upsertRemoteItem({
    bookId,
    kind: 'artifact',
    remoteId: 'art-to-del',
    title: 'Audio a Eliminar',
    type: 'audio',
    status: 'completed'
  });

  // Petición de borrado SIN confirmación
  const delRes = await f.call(`/api/books/${bookId}/artifacts/art-to-del/delete`, 'POST', { confirm: false });
  assert.equal(delRes.status, 400);
  const errData = await delRes.json();
  assert.match(errData.error, /confirmación explícita/);
  assert.equal(f.provider.deleteCalls, 0, 'Cero llamadas remotas de eliminación');
});

test('C8: Borrado con respuesta fallida registra estado incierto y se confirma al sincronizar', async t => {
  const f = await fixture(t);
  const syncRes = await f.call('/api/remote/notebooks/nb-cancel-1/sync', 'POST', { profile: 'default' });
  const { bookId } = await syncRes.json();

  f.app.store.upsertRemoteItem({
    bookId,
    kind: 'artifact',
    remoteId: 'art-uncertain-1',
    title: 'Audio Incierto',
    type: 'audio',
    status: 'completed'
  });

  // Simular fallo de red durante el borrado
  f.provider.behavior.deleteArtifact = new ProviderError('TEMPORARY', 'Conexión perdida durante borrado', true);

  const delRes = await f.call(`/api/books/${bookId}/artifacts/art-uncertain-1/delete`, 'POST', { confirm: true });
  assert.equal(delRes.status, 202);
  const delData = await delRes.json();
  assert.equal(delData.status, 'uncertain');

  const itemAfterFail = f.app.store.remoteItemByRemoteId(bookId, 'artifact', 'art-uncertain-1');
  assert.equal(itemAfterFail.status, 'delete_uncertain');

  // En una sincronización posterior, Google ya no lista ese artefacto
  f.provider.behavior.deleteArtifact = null;
  f.provider.remoteArtifacts = []; // Desapareció en Google

  await syncNotebook({
    store: f.app.store,
    accounts: f.app.accounts,
    profile: 'default',
    remoteId: 'nb-cancel-1'
  });

  const itemAfterSync = f.app.store.remoteItemByRemoteId(bookId, 'artifact', 'art-uncertain-1');
  assert.equal(itemAfterSync.status, 'deleted_confirmed');
  assert.equal(itemAfterSync.not_visible, 1);

  const op = f.app.store.remoteOperation(delData.operationId);
  assert.equal(op.state, 'confirmed');
});

test('C9: Artefacto con borrado confirmado que reaparece en NotebookLM se marca para revisión', async t => {
  const f = await fixture(t);
  const syncRes = await f.call('/api/remote/notebooks/nb-cancel-1/sync', 'POST', { profile: 'default' });
  const { bookId } = await syncRes.json();

  // Registrar un artefacto como eliminado confirmado
  f.app.store.upsertRemoteItem({
    bookId,
    kind: 'artifact',
    remoteId: 'art-reappearing',
    title: 'Audio Fantasma',
    type: 'audio',
    status: 'deleted_confirmed'
  });

  // Google vuelve a listarlo inesperadamente
  f.provider.remoteArtifacts = [
    { artifact_id: 'art-reappearing', type: 'audio', title: 'Audio Fantasma', status: 'completed' }
  ];

  await syncNotebook({
    store: f.app.store,
    accounts: f.app.accounts,
    profile: 'default',
    remoteId: 'nb-cancel-1'
  });

  const item = f.app.store.remoteItemByRemoteId(bookId, 'artifact', 'art-reappearing');
  assert.equal(item.status, 'reappeared');
  assert.match(item.error_reason, /reapareció en NotebookLM/);
  assert.equal(f.provider.deleteCalls, 0, 'No debe entrar en un bucle de borrado automático');
});
