import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { Accounts } from '../accounts.mjs';
import { syncNotebook } from '../sync.mjs';
import { makeApp } from '../server.mjs';
import { FakeProvider } from './helpers.mjs';

class MockDownloadsProvider extends FakeProvider {
  constructor(profile = 'default') {
    super();
    this.profile = profile;
    this.remoteNotebooks = [{ id: 'nb-dl-1', title: 'Cuaderno Descargas' }];
    this.remoteSources = [
      { id: 'src-1', title: 'Fuente 1.md', status: 2 },
      { id: 'src-2', title: 'Fuente 2.md', status: 2 }
    ];
    this.remoteArtifacts = [
      { artifact_id: 'art-single', type: 'audio', title: 'Audio Una Fuente', status: 'completed', source_ids: ['src-1'] },
      { artifact_id: 'art-multi', type: 'audio', title: 'Audio Dos Fuentes', status: 'completed', source_ids: ['src-1', 'src-2'] },
      { artifact_id: 'art-generating', type: 'audio', title: 'Audio En Progreso', status: 'generating', source_ids: ['src-1'] },
      { artifact_id: 'art-failed', type: 'audio', title: 'Audio Fallido', status: 'failed', error_reason: 'Error interno en Google', source_ids: ['src-1'] }
    ];
  }
  async listBooks() { return this.remoteNotebooks; }
  async sources(bookId) { return this.remoteSources; }
  async artifacts(bookId) { return this.remoteArtifacts; }
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-dl-'));
  const provider = new MockDownloadsProvider('default');
  const app = await makeApp({
    dataDir: dir,
    exportsDir: join(dir, 'exports'),
    provider,
    accountFactory: id => new MockDownloadsProvider(id),
    port: 0,
    worker: false,
    check: false
  });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const call = (path, method = 'GET', data) => fetch(app.origin + path, {
    method,
    headers: { 'X-Local-Token': app.token, ...(data ? { 'Content-Type': 'application/json' } : {}) },
    body: data ? JSON.stringify(data) : undefined
  });
  return { app, provider, call, dir };
}

test('D1 y D2: Descarga audio con múltiples fuentes sin regenerar ni recortar procedencia', async t => {
  const f = await fixture(t);

  // Sincronizar catálogo
  const syncRes = await f.call('/api/remote/notebooks/nb-dl-1/sync', 'POST', { profile: 'default' });
  const syncData = await syncRes.json();
  const bookId = syncData.bookId;

  // Descargar audio multi-fuente
  const dlRes = await f.call(`/api/books/${bookId}/downloads`, 'POST', {
    items: [{ itemId: 'art-multi', format: 'mp3' }]
  });
  assert.equal(dlRes.status, 200);
  const dlData = await dlRes.json();
  assert.equal(dlData.accepted.length, 1);
  assert.equal(dlData.rejected.length, 0);

  // Procesar descarga y conversión
  // Tick 1: descarga original
  await f.app.queue.tick();
  assert.equal(f.provider.calls.filter(c => c[0] === 'download').length, 1);
  assert.equal(f.provider.calls[0][2], 'art-multi');

  // Tick 2: conversión a MP3
  await f.app.queue.tick();
  assert.equal(f.provider.calls.filter(c => c[0] === 'convert').length, 1);

  // Verificar estado del bloque
  const block = f.app.store.block(dlData.accepted[0].blockId);
  assert.equal(block.state, 'done');
  assert.ok(block.output_path);

  // CERO llamadas a generate
  assert.equal(f.provider.calls.filter(c => c[0] === 'generate').length, 0);
});

test('D3 y D4: Rechaza ID no encontrado, estado en progreso y audio fallido sin llamar a creación', async t => {
  const f = await fixture(t);

  const syncRes = await f.call('/api/remote/notebooks/nb-dl-1/sync', 'POST', { profile: 'default' });
  const { bookId } = await syncRes.json();

  const dlRes = await f.call(`/api/books/${bookId}/downloads`, 'POST', {
    items: [
      { itemId: 'art-inexistente', format: 'mp3' },
      { itemId: 'art-generating', format: 'mp3' },
      { itemId: 'art-failed', format: 'mp3' }
    ]
  });
  assert.equal(dlRes.status, 200);
  const dlData = await dlRes.json();

  assert.equal(dlData.accepted.length, 0);
  assert.equal(dlData.rejected.length, 3);
  assert.ok(dlData.rejected.find(r => r.id === 'art-inexistente'));
  assert.ok(dlData.rejected.find(r => r.id === 'art-generating'));
  assert.ok(dlData.rejected.find(r => r.id === 'art-failed'));

  // Cero llamadas a generate
  assert.equal(f.provider.calls.filter(c => c[0] === 'generate').length, 0);
});

test('D5: Doble clic o lote repetido no crea bloques duplicados', async t => {
  const f = await fixture(t);

  const syncRes = await f.call('/api/remote/notebooks/nb-dl-1/sync', 'POST', { profile: 'default' });
  const { bookId } = await syncRes.json();

  // Primer clic
  const res1 = await f.call(`/api/books/${bookId}/downloads`, 'POST', {
    items: [{ itemId: 'art-single', format: 'mp3' }]
  }).then(r => r.json());
  assert.equal(res1.accepted.length, 1);

  // Doble clic inmediato con el mismo elemento
  const res2 = await f.call(`/api/books/${bookId}/downloads`, 'POST', {
    items: [{ itemId: 'art-single', format: 'mp3' }]
  }).then(r => r.json());

  assert.equal(res2.accepted.length, 1);
  assert.equal(res1.accepted[0].blockId, res2.accepted[0].blockId, 'Reutiliza el mismo bloque');

  // Solo hay 1 bloque en la base de datos
  const blocks = f.app.store.blocks(bookId);
  assert.equal(blocks.length, 1);
});

test('D6: Reintentar conversión o descarga fallida no genera nuevo audio', async t => {
  const f = await fixture(t);

  const syncRes = await f.call('/api/remote/notebooks/nb-dl-1/sync', 'POST', { profile: 'default' });
  const { bookId } = await syncRes.json();

  // Encolar descarga
  const res = await f.call(`/api/books/${bookId}/downloads`, 'POST', {
    items: [{ itemId: 'art-single', format: 'mp3' }]
  }).then(r => r.json());
  const blockId = res.accepted[0].blockId;

  // Forzar error en la descarga
  f.provider.behavior.download = new Error('Fallo de red en descarga');
  await f.app.queue.tick(); // Falla download

  let block = f.app.store.block(blockId);
  assert.equal(block.state, 'error');

  // Reintentar bloque
  f.provider.behavior.download = null;
  f.app.queue.retryBlock(blockId);
  block = f.app.store.block(blockId);
  assert.equal(block.stage, 'download');
  assert.equal(block.state, 'download');

  // Reejecutar tick
  await f.app.queue.tick(); // Descarga ok -> pasa a convert
  assert.equal(f.app.store.block(blockId).stage, 'convert');

  await f.app.queue.tick(); // Convert ok -> pasa a done
  assert.equal(f.app.store.block(blockId).state, 'done');

  // CERO llamadas a generate
  assert.equal(f.provider.calls.filter(c => c[0] === 'generate').length, 0);
});
