import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { Provider } from '../provider.mjs';
import { makeApp } from '../server.mjs';
import { FakeProvider } from './helpers.mjs';

class MockMultiAccountProvider extends FakeProvider {
  constructor(profile = 'default') {
    super();
    this.profile = profile;
    this.remoteNotebooks = [
      { id: `nb-shared`, title: 'Cuaderno Compartido', modified_time: '2026-10-01T12:00:00Z' },
      { id: `nb-${profile}-only`, title: `Privado de ${profile}`, modified_time: '2026-10-02T12:00:00Z' }
    ];
    this.remoteSources = [
      { id: `src-${profile}-1`, title: 'Tema 1.md', status: 2 }
    ];
    this.remoteArtifacts = [
      { artifact_id: `art-${profile}-1`, type: 'audio', title: `Audio ${profile}`, status: 'completed', source_ids: [`src-${profile}-1`] }
    ];
  }
  async listBooks() { return this.remoteNotebooks; }
  async sources(bookId) { return this.remoteSources; }
  async artifacts(bookId) { return this.remoteArtifacts; }
}

test('A1: Dos perfiles, títulos iguales, cuadernos distintos no se cruzan', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-a1-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  t.after(() => { store.close(); return rm(dir, { recursive: true, force: true }); });

  const bookA = store.importRemoteBook({ remoteId: 'nb-a', title: 'Biología', profile: 'cuentaA' });
  const bookB = store.importRemoteBook({ remoteId: 'nb-b', title: 'Biología', profile: 'cuentaB' });

  assert.equal(bookA.title, 'Biología');
  assert.equal(bookB.title, 'Biología');
  assert.notEqual(bookA.id, bookB.id);
  assert.equal(bookA.profile, 'cuentaA');
  assert.equal(bookB.profile, 'cuentaB');
  assert.equal(bookA.remote_id, 'nb-a');
  assert.equal(bookB.remote_id, 'nb-b');
});

test('A2: Mismo ID remoto compartido por A y B genera dos vistas locales aisladas sin crear cuaderno remoto', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-a2-'));
  const provider = new MockMultiAccountProvider('cuentaA');
  const app = await makeApp({
    dataDir: dir,
    exportsDir: join(dir, 'exports'),
    provider,
    accountFactory: id => new MockMultiAccountProvider(id),
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

  // Importar cuaderno compartido desde cuentaA
  const resA = await call('/api/remote/notebooks/nb-shared/import', 'POST', {
    title: 'Cuaderno Compartido',
    profile: 'cuentaA',
    artifactIds: ['art-cuentaA-1']
  });
  assert.equal(resA.status, 200);
  const dataA = await resA.json();

  // Importar el mismo cuaderno compartido desde cuentaB
  const resB = await call('/api/remote/notebooks/nb-shared/import', 'POST', {
    title: 'Cuaderno Compartido',
    profile: 'cuentaB',
    artifactIds: ['art-cuentaB-1']
  });
  assert.equal(resB.status, 200);
  const dataB = await resB.json();

  // Dos vistas locales distintas
  assert.notEqual(dataA.bookId, dataB.bookId);

  const localA = app.store.book(dataA.bookId);
  const localB = app.store.book(dataB.bookId);
  assert.equal(localA.profile, 'cuentaA');
  assert.equal(localB.profile, 'cuentaB');
  assert.equal(localA.remote_id, 'nb-shared');
  assert.equal(localB.remote_id, 'nb-shared');

  // Consulta de detalle remoto asocia la vista local correcta según el perfil solicitado
  const detailA = await call('/api/remote/notebooks/nb-shared?profile=cuentaA').then(r => r.json());
  assert.equal(detailA.localBookId, dataA.bookId);
  assert.equal(detailA.profile, 'cuentaA');

  const detailB = await call('/api/remote/notebooks/nb-shared?profile=cuentaB').then(r => r.json());
  assert.equal(detailB.localBookId, dataB.bookId);
  assert.equal(detailB.profile, 'cuentaB');

  // Cero llamadas remotas a createBook
  assert.equal(provider.calls.filter(c => c[0] === 'createBook').length, 0);
});

test('A4: Cambiar cuenta global no altera la cuenta de libros o trabajos existentes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-a4-'));
  const provider = new MockMultiAccountProvider('cuentaA');
  const app = await makeApp({
    dataDir: dir,
    exportsDir: join(dir, 'exports'),
    provider,
    accountFactory: id => new MockMultiAccountProvider(id),
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

  // Crear libro con cuentaA
  const book = app.store.createBook({ title: 'Libro A', requestId: 'req-lib-a' }, 'cuentaA');
  assert.equal(book.profile, 'cuentaA');

  // Cambiar cuenta activa a cuentaB
  await call('/api/accounts/cuentaB/select', 'POST');
  assert.equal(app.accounts.current, 'cuentaB');

  // El libro sigue con perfil cuentaA
  const checkBook = app.store.book(book.id);
  assert.equal(checkBook.profile, 'cuentaA');
});

test('F14: Provider.forProfile aísla CommandRunner y no cierra otros perfiles', async () => {
  const p1 = new Provider({ profile: 'p1' });
  const p2 = p1.forProfile('p2');
  assert.notEqual(p1.runner, p2.runner, 'Cada perfil tiene runner independiente');
  await p2.close();
  assert.equal(p2.runner.closed, true);
  assert.equal(p1.runner.closed, false, 'Cerrar p2 no afecta a p1');
  await p1.close();
});
