import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { ProviderError } from '../provider.mjs';
import { Accounts } from '../accounts.mjs';
import { syncNotebook } from '../sync.mjs';
import { makeApp } from '../server.mjs';
import { FakeProvider } from './helpers.mjs';

class MockSyncProvider extends FakeProvider {
  constructor(profile = 'default') {
    super();
    this.profile = profile;
    this.remoteNotebooks = [{ id: 'nb-sync-1', title: 'Cuaderno Sincronizado' }];
    this.remoteSources = Array.from({ length: 25 }, (_, i) => ({
      id: `src-${i + 1}`,
      title: `Capítulo ${i + 1}`,
      status: 2
    }));
    this.remoteArtifacts = Array.from({ length: 120 }, (_, i) => ({
      artifact_id: `art-${i + 1}`,
      type: i % 2 === 0 ? 'audio' : 'video',
      title: `Contenido ${i + 1}`,
      status: 'completed',
      source_ids: [`src-${(i % 25) + 1}`]
    }));
    this.remoteNotes = [
      { id: 'note-1', title: 'Resumen inicial', content: 'Notas del curso' }
    ];
    this.failArtifacts = false;
    this.truncateArtifacts = false;
  }
  async listBooks() {
    if (this.failList) throw new ProviderError('AUTH_REQUIRED', 'Sesión expirada.');
    return this.remoteNotebooks;
  }
  async sources(bookId) {
    if (this.failSources) throw new ProviderError('TEMPORARY', 'Fallo de red en fuentes.');
    return this.remoteSources;
  }
  async artifacts(bookId, artifactId, { detailed = false } = {}) {
    if (this.failArtifacts) throw new ProviderError('TEMPORARY', 'Fallo temporal en Studio.');
    if (artifactId) {
      const match = this.remoteArtifacts.find(a => a.artifact_id === artifactId);
      const items = match ? [match] : [];
      return detailed ? { items, truncated: false } : items;
    }
    return detailed ? { items: this.remoteArtifacts, truncated: this.truncateArtifacts } : this.remoteArtifacts;
  }
  async notes(bookId) {
    return this.remoteNotes;
  }
}

test('S1: Sincronizar dos veces 25 fuentes y más de 100 artefactos sin duplicación', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-s1-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const provider = new MockSyncProvider('default');
  const accounts = new Accounts(store, provider);
  t.after(() => { store.close(); return rm(dir, { recursive: true, force: true }); });

  // Sincronización 1
  const res1 = await syncNotebook({
    store,
    accounts,
    profile: 'default',
    remoteId: 'nb-sync-1',
    requestId: 'sync-req-1'
  });
  assert.equal(res1.ok, true);
  assert.equal(res1.state, 'confirmed');
  assert.equal(res1.summary.counts.sources, 25);
  assert.equal(res1.summary.counts.artifacts, 120);
  assert.equal(res1.summary.counts.notes, 1);
  assert.equal(res1.summary.counts.new, 146);

  const sources1 = store.remoteItems(res1.bookId, { kind: 'source' });
  const artifacts1 = store.remoteItems(res1.bookId, { kind: 'artifact' });
  assert.equal(sources1.length, 25);
  assert.equal(artifacts1.length, 120);

  // Sincronización 2 (idempotente: actualiza, no duplica)
  const res2 = await syncNotebook({
    store,
    accounts,
    profile: 'default',
    remoteId: 'nb-sync-1',
    requestId: 'sync-req-2'
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.summary.counts.new, 0);
  assert.equal(res2.summary.counts.updated, 146);

  const sources2 = store.remoteItems(res1.bookId, { kind: 'source' });
  const artifacts2 = store.remoteItems(res1.bookId, { kind: 'artifact' });
  assert.equal(sources2.length, 25);
  assert.equal(artifacts2.length, 120);
});

test('S2: Fallar Studio y completar fuentes actualiza fuentes y conserva caché de Studio sin marcar ausente', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-s2-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const provider = new MockSyncProvider('default');
  const accounts = new Accounts(store, provider);
  t.after(() => { store.close(); return rm(dir, { recursive: true, force: true }); });

  // Primera sincronización exitosa
  const res1 = await syncNotebook({
    store,
    accounts,
    profile: 'default',
    remoteId: 'nb-sync-1'
  });
  assert.equal(res1.state, 'confirmed');

  // Segunda sincronización con fallo en Studio
  provider.failArtifacts = true;
  provider.remoteSources.push({ id: 'src-26', title: 'Capítulo 26', status: 2 });

  const res2 = await syncNotebook({
    store,
    accounts,
    profile: 'default',
    remoteId: 'nb-sync-1'
  });

  assert.equal(res2.state, 'partial');
  assert.equal(res2.summary.sections.sources.complete, true);
  assert.equal(res2.summary.sections.artifacts.complete, false);
  assert.ok(res2.summary.sections.artifacts.error);

  // Las fuentes se actualizaron a 26
  const sources = store.remoteItems(res1.bookId, { kind: 'source' });
  assert.equal(sources.length, 26);

  // Los 120 artefactos se conservaron de la caché anterior y NO se marcaron ausentes (not_visible = 0)
  const artifacts = store.remoteItems(res1.bookId, { kind: 'artifact' });
  assert.equal(artifacts.length, 120);
  assert.ok(artifacts.every(a => a.not_visible === 0));
});

test('S3: Sesión expirada informa error de autenticación sin crear cuaderno de reemplazo', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-s3-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const provider = new MockSyncProvider('default');
  provider.failList = true;
  provider.failSources = true;
  provider.failArtifacts = true;
  const accounts = new Accounts(store, provider);
  t.after(() => { store.close(); return rm(dir, { recursive: true, force: true }); });

  const res = await syncNotebook({
    store,
    accounts,
    profile: 'default',
    remoteId: 'nb-sync-1'
  });

  assert.equal(res.ok, false);
  assert.equal(res.state, 'failed');
  assert.equal(store.books().length, 1);
  assert.equal(provider.calls.filter(c => c[0] === 'createBook').length, 0);
});

test('S4: Límite de paginación o truncamiento informa incompletitud y no infiere ausencias', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-s4-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const provider = new MockSyncProvider('default');
  provider.truncateArtifacts = true;
  const accounts = new Accounts(store, provider);
  t.after(() => { store.close(); return rm(dir, { recursive: true, force: true }); });

  const res = await syncNotebook({
    store,
    accounts,
    profile: 'default',
    remoteId: 'nb-sync-1'
  });

  assert.equal(res.summary.sections.artifacts.truncated, true);
  assert.equal(res.summary.sections.artifacts.complete, false);
  const artifacts = store.remoteItems(res.bookId, { kind: 'artifact' });
  assert.ok(artifacts.every(a => a.not_visible === 0));
});

test('S5: Contenido eliminado fuera de la app se marca como no visible conservando el registro', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-s5-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const provider = new MockSyncProvider('default');
  provider.remoteArtifacts = [
    { artifact_id: 'art-1', type: 'audio', title: 'Audio 1', status: 'completed' },
    { artifact_id: 'art-2', type: 'audio', title: 'Audio 2', status: 'completed' }
  ];
  const accounts = new Accounts(store, provider);
  t.after(() => { store.close(); return rm(dir, { recursive: true, force: true }); });

  const res1 = await syncNotebook({ store, accounts, profile: 'default', remoteId: 'nb-sync-1' });
  assert.equal(res1.state, 'confirmed');

  // El usuario borra art-2 en Google NotebookLM
  provider.remoteArtifacts = [
    { artifact_id: 'art-1', type: 'audio', title: 'Audio 1', status: 'completed' }
  ];

  const res2 = await syncNotebook({ store, accounts, profile: 'default', remoteId: 'nb-sync-1' });
  assert.equal(res2.state, 'confirmed');

  const art1 = store.remoteItemByRemoteId(res1.bookId, 'artifact', 'art-1');
  const art2 = store.remoteItemByRemoteId(res1.bookId, 'artifact', 'art-2');

  assert.equal(art1.not_visible, 0);
  assert.equal(art2.not_visible, 1, 'art-2 se marca como not_visible=1 pero se conserva');
  assert.equal(res2.summary.counts.not_visible, 1);
});

test('S6: Sincronizar y consultar catálogo persistido vía API sin descargar nada', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-s6-'));
  const provider = new MockSyncProvider('default');
  const app = await makeApp({
    dataDir: dir,
    exportsDir: join(dir, 'exports'),
    provider,
    accountFactory: id => new MockSyncProvider(id),
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

  // POST /api/remote/notebooks/:remoteId/sync
  const syncRes = await call('/api/remote/notebooks/nb-sync-1/sync', 'POST', {
    profile: 'default',
    requestId: 'sync-op-1'
  });
  assert.equal(syncRes.status, 202);
  const syncData = await syncRes.json();
  assert.ok(syncData.bookId);
  assert.ok(syncData.operationId);

  // GET /api/operations/:id
  const opRes = await call(`/api/operations/${syncData.operationId}`);
  assert.equal(opRes.status, 200);
  const opData = await opRes.json();
  assert.equal(opData.type, 'sync');
  assert.equal(opData.state, 'confirmed');

  // GET /api/books/:id/catalog
  const catRes = await call(`/api/books/${syncData.bookId}/catalog`);
  assert.equal(catRes.status, 200);
  const catData = await catRes.json();
  assert.equal(catData.book.remoteId, 'nb-sync-1');
  assert.equal(catData.items.length, 146); // 25 fuentes + 120 artefactos + 1 nota

  // Filtro por tipo: sólo audio
  const audioRes = await call(`/api/books/${syncData.bookId}/catalog?type=audio`);
  const audioData = await audioRes.json();
  assert.ok(audioData.items.length > 0);
  assert.ok(audioData.items.every(item => item.type === 'audio'));

  // Cero descargas realizadas
  assert.equal(provider.calls.filter(c => c[0] === 'download').length, 0);
  // Cero generaciones realizadas
  assert.equal(provider.calls.filter(c => c[0] === 'generate').length, 0);
});
