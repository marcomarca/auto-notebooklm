import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../server.mjs';
import { FakeProvider } from './helpers.mjs';

test('T01: Contrato del catálogo del servidor y aislamiento de operaciones', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bloqueaudio-catalog-test-'));
  let app;
  t.after(async () => {
    try { await app?.close(); } finally { await rm(dir, { recursive: true, force: true }); }
  });

  const provider = new FakeProvider();
  app = await makeApp({ port: 0, dataDir: dir, exportsDir: join(dir, 'exports'), provider, worker: false, check: false });

  // 1. Create Book A linked to remote notebook
  const bookA = app.store.createBook({ title: 'Libro Catálogo A', requestId: 'cat-book-a' }, 'default');
  app.store.update('books', bookA.id, { remote_id: 'remote-nb-a', state: 'ready' });

  // Insert artifacts, sources, notes into store for Book A
  const srcA1 = app.store.upsertRemoteItem({
    bookId: bookA.id,
    kind: 'source',
    remoteId: 'google-src-111',
    title: 'Fuente Capítulo 1',
    status: 2, // ready
    lastSeenAt: Date.now()
  });

  const srcA2 = app.store.upsertRemoteItem({
    bookId: bookA.id,
    kind: 'source',
    remoteId: 'google-src-222',
    title: 'Fuente Capítulo 2 (Fallida)',
    status: 3, // failed
    lastSeenAt: Date.now()
  });

  const artA1 = app.store.upsertRemoteItem({
    bookId: bookA.id,
    kind: 'artifact',
    remoteId: 'google-art-333',
    title: 'Audio Resumen Cap 1',
    type: 'audio',
    status: 'completed',
    createdTime: 1729000000000,
    lastSeenAt: Date.now()
  });

  const noteA1 = app.store.upsertRemoteItem({
    bookId: bookA.id,
    kind: 'note',
    remoteId: 'google-note-444',
    title: 'Nota de lectura',
    createdTime: 1729000000000,
    lastSeenAt: Date.now()
  });

  // Verify server endpoint returns { book, items }
  const resCat = await fetch(`${app.origin}/api/books/${bookA.id}/catalog`);
  assert.equal(resCat.status, 200);
  const data = await resCat.json();
  assert.ok(data.book, 'Debe devolver data.book');
  assert.equal(data.book.id, bookA.id);
  assert.equal(data.book.remoteId, 'remote-nb-a');
  assert.ok(Array.isArray(data.items), 'Debe devolver data.items como arreglo');
  assert.equal(data.items.length, 4);

  // 2. Test generation from sources endpoint: requires remoteId
  const genRes = await fetch(`${app.origin}/api/books/${bookA.id}/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Local-Token': app.token },
    body: JSON.stringify({ sourceIds: ['google-src-111'] })
  });
  assert.equal(genRes.status, 200);
  const genData = await genRes.json();
  assert.ok(genData.queued?.length > 0, 'Debe encolar bloque a partir del remoteId de la fuente');

  // Verify block was created with source_id = google-src-111
  const blockCreated = app.store.get('SELECT * FROM blocks WHERE book_id=? AND source_id=?', bookA.id, 'google-src-111');
  assert.ok(blockCreated, 'El bloque debe tener el remote_id de la fuente');

  // 3. Test downloads endpoint: requires local itemId (remote_items.id)
  const dlRes = await fetch(`${app.origin}/api/books/${bookA.id}/downloads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Local-Token': app.token },
    body: JSON.stringify({ items: [{ itemId: artA1.id }] })
  });
  assert.equal(dlRes.status, 200);
  const dlData = await dlRes.json();
  assert.equal(dlData.accepted.length, 1);
  assert.equal(dlData.accepted[0].id, artA1.id);

  // 4. Test delete endpoint: requires remoteId in URL path
  const delRes = await fetch(`${app.origin}/api/books/${bookA.id}/artifacts/${encodeURIComponent(artA1.remote_id)}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Local-Token': app.token },
    body: JSON.stringify({ confirm: true, requestId: 'del-req-1' })
  });
  assert.equal(delRes.status, 200);
});
