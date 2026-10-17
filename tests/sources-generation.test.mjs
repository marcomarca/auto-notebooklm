import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../server.mjs';
import { FakeProvider } from './helpers.mjs';
import { ProviderError } from '../provider.mjs';

class MockSourcesProvider extends FakeProvider {
  constructor(profile = 'default', { role = 'editor' } = {}) {
    super();
    this.profile = profile;
    this.role = role;
    this.calls = {
      createBook: 0,
      upload: 0,
      generate: 0,
      shareInvite: 0,
      access: 0
    };
    this.remoteNotebooks = [{ id: 'nb-remote-44', title: 'Cuaderno Fase 4' }];
    this.remoteSources = [
      { id: 'src-dup-1', title: 'Capítulo 1', status: 2 },
      { id: 'src-dup-2', title: 'Capítulo 1', status: 2 }
    ];
    this.remoteArtifacts = [];
  }
  async profiles() {
    return [{ id: this.profile, email: `${this.profile}@example.com` }];
  }
  async listBooks() { return this.remoteNotebooks; }
  async sources(bookId) { return this.remoteSources; }
  async artifacts(bookId) { return this.remoteArtifacts; }
  async access(bookId, email) {
    this.calls.access++;
    if (this.role !== 'editor' && this.role !== 'owner') {
      throw new ProviderError('ACCESS', 'Esta cuenta necesita acceso de edición activo al mismo cuaderno.');
    }
    return true;
  }
  async shareInvite(bookId, email, role = 'editor') {
    this.calls.shareInvite++;
    return { ok: true };
  }
  async createBook(title) {
    this.calls.createBook++;
    const id = `nb-new-${Date.now()}`;
    this.remoteNotebooks.push({ id, title });
    return id;
  }
  async upload(bookId, block) {
    this.calls.upload++;
    const sourceId = `src-up-${this.calls.upload}`;
    this.remoteSources.push({ id: sourceId, title: block.source_title, status: 2 });
    return sourceId;
  }
  async generate(bookId, sourceId, options) {
    this.calls.generate++;
    const artId = `art-gen-${this.calls.generate}`;
    this.remoteArtifacts.push({
      artifact_id: artId,
      type: 'audio',
      title: `Audio for ${sourceId}`,
      status: 'completed',
      source_ids: [sourceId]
    });
    return artId;
  }
}

async function fixture(t, { role = 'editor' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-src-gen-'));
  const provider = new MockSourcesProvider('default', { role });
  const app = await makeApp({
    dataDir: dir,
    exportsDir: join(dir, 'exports'),
    provider,
    accountFactory: id => new MockSourcesProvider(id, { role }),
    port: 0,
    worker: false,
    check: false
  });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = (path, method = 'GET', data, headers = {}) => fetch(app.origin + path, {
    method,
    headers: {
      'X-Local-Token': app.token,
      ...(data && typeof data === 'object' && !(data instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: data ? (typeof data === 'object' && !(data instanceof Buffer) ? JSON.stringify(data) : data) : undefined
  });
  return { app, provider, call, dir };
}

test('M1: Añadir MD a cuaderno remoto como editor no genera audio hasta seleccionarlo explícitamente', async t => {
  const f = await fixture(t, { role: 'editor' });

  // 1. Sincronizar cuaderno existente
  const syncRes = await f.call('/api/remote/notebooks/nb-remote-44/sync', 'POST', { profile: 'default' });
  assert.equal(syncRes.status, 202);
  const { bookId } = await syncRes.json();

  // 2. Subir nuevo archivo Markdown al cuaderno remoto vinculado
  const mdContent = Buffer.from('# Contenido de prueba para Fase 4\nTexto descriptivo.', 'utf8');
  const upRes = await f.call(`/api/books/${bookId}/files?filename=nueva-fuente.md&requestId=req-m1-up`, 'PUT', mdContent, {
    'Content-Length': String(mdContent.length)
  });
  assert.equal(upRes.status, 201);
  const upData = await upRes.json();
  assert.ok(upData.id);

  // 3. Ejecutar queue para subir la fuente y verificar estado
  await f.app.queue.step(); // sube archivo
  assert.equal(f.provider.calls.upload, 1);
  assert.equal(f.provider.calls.createBook, 0); // No debe llamar a crear cuaderno

  await f.app.queue.step(); // procesa estado de la fuente
  const block = f.app.store.block(upData.id);
  assert.equal(block.stage, 'source_ready');
  assert.equal(block.state, 'ready');

  // Ejecutar otro step para comprobar que NO genera automáticamente
  await f.app.queue.step();
  assert.equal(f.provider.calls.generate, 0, 'No debe generar audio sin selección explícita');

  // 4. Seleccionar la fuente y solicitar generación explícita
  const genRes = await f.call(`/api/books/${bookId}/generations`, 'POST', {
    sourceIds: [block.source_id]
  });
  assert.equal(genRes.status, 200);

  // 5. El bloque debe estar en stage generate y ejecutarse en el siguiente step
  await f.app.queue.step();
  assert.equal(f.provider.calls.generate, 1, 'Debe generar audio tras selección explícita');
  assert.equal(f.provider.calls.createBook, 0, 'Cero creaciones de cuaderno remoto');
});

test('M2: Añadir material como lector es bloqueado; cero invitaciones y cero subidas', async t => {
  const f = await fixture(t, { role: 'reader' });

  // 1. Registrar libro remoto
  const syncRes = await f.call('/api/remote/notebooks/nb-remote-44/sync', 'POST', { profile: 'default' });
  const { bookId } = await syncRes.json();

  // 2. Intentar subir archivo como lector
  const mdContent = Buffer.from('# Intentando escribir sin permiso', 'utf8');
  const upRes = await f.call(`/api/books/${bookId}/files?filename=no-permitido.md&requestId=req-m2-up`, 'PUT', mdContent, {
    'Content-Length': String(mdContent.length)
  });

  assert.equal(upRes.status, 400);
  const errData = await upRes.json();
  assert.match(errData.error, /permisos de edición/);

  // 3. Verificar que no hubo subida, ni invitación, ni creación de cuaderno
  assert.equal(f.provider.calls.upload, 0, 'Cero subidas a Google');
  assert.equal(f.provider.calls.shareInvite, 0, 'Cero invitaciones automáticas enviadas');
  assert.equal(f.provider.calls.createBook, 0, 'Cero cuadernos remotos creados');
});

test('M3: Dos fuentes con el mismo título tienen IDs reales distintos y no se fusionan', async t => {
  const f = await fixture(t, { role: 'editor' });

  // 1. Sincronizar cuaderno que tiene 2 fuentes con el mismo título 'Capítulo 1'
  const syncRes = await f.call('/api/remote/notebooks/nb-remote-44/sync', 'POST', { profile: 'default' });
  const { bookId } = await syncRes.json();

  // 2. Consultar catálogo
  const catRes = await f.call(`/api/books/${bookId}/catalog?kind=source`, 'GET');
  assert.equal(catRes.status, 200);
  const catData = await catRes.json();
  const sources = catData.items;

  assert.equal(sources.length, 2);
  assert.equal(sources[0].title, 'Capítulo 1');
  assert.equal(sources[1].title, 'Capítulo 1');
  assert.notEqual(sources[0].remote_id, sources[1].remote_id);

  // 3. Generar audio para ambas fuentes
  const genRes = await f.call(`/api/books/${bookId}/generations`, 'POST', {
    sourceIds: [sources[0].remote_id, sources[1].remote_id]
  });
  assert.equal(genRes.status, 200);
  const genData = await genRes.json();
  assert.equal(genData.queued.length, 2);

  const block1 = f.app.store.block(genData.queued[0]);
  const block2 = f.app.store.block(genData.queued[1]);

  assert.notEqual(block1.id, block2.id);
  assert.notEqual(block1.source_id, block2.source_id);
  assert.equal(block1.title, 'Capítulo 1');
  assert.equal(block2.title, 'Capítulo 1');
});
