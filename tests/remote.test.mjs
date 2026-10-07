import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../server.mjs';
import { FakeProvider } from './helpers.mjs';

class RemoteTestProvider extends FakeProvider {
  constructor(profile = 'default') {
    super();
    this.profile = profile;
    this.remoteNotebooks = [
      { id: 'nb-1', title: 'Historia Universal', modified_time: '2026-10-01T12:00:00Z' },
      { id: 'nb-2', title: 'Física Cuántica', modified_time: '2026-10-02T15:00:00Z' }
    ];
    this.remoteSources = [
      { id: 'src-1', title: '01 - Introducción.md', status: 2 },
      { id: 'src-2', title: '02 - Desarrollo.md', status: 2 }
    ];
    this.remoteArtifacts = [
      { artifact_id: 'art-1', type: 'audio', title: 'Episodio 1: Intro', status: 'completed', source_ids: ['src-1'] },
      { artifact_id: 'art-2', type: 'audio', title: 'Episodio 2: Detalle', status: 'completed', source_ids: ['src-2'] }
    ];
  }
  async listBooks() { return this.remoteNotebooks; }
  async sources(bookId) { return this.remoteSources; }
  async artifacts(bookId) { return this.remoteArtifacts; }
}

async function remoteFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-remote-'));
  const provider = new RemoteTestProvider('default');
  const app = await makeApp({
    dataDir: dir,
    exportsDir: join(dir, 'exports'),
    provider,
    accountFactory: id => new RemoteTestProvider(id),
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

test('API lista cuadernos remotos y detalles de audios para descarga', async t => {
  const f = await remoteFixture(t);
  
  // List remote notebooks
  const booksRes = await f.call('/api/remote/notebooks');
  assert.equal(booksRes.status, 200);
  const notebooks = await booksRes.json();
  assert.equal(notebooks.length, 2);
  assert.equal(notebooks[0].title, 'Historia Universal');

  // Query notebook details
  const detailRes = await f.call('/api/remote/notebooks/nb-1');
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(detail.artifacts.length, 2);
  assert.equal(detail.artifacts[0].title, 'Episodio 1: Intro');
  assert.equal(detail.artifacts[0].sourceTitle, '01 - Introducción.md');
  assert.equal(detail.artifacts[0].isDone, false);
});

test('importa audios remotos en lote y la cola los descarga y convierte uno a uno', async t => {
  const f = await remoteFixture(t);
  
  // Import both artifacts
  const importRes = await f.call('/api/remote/notebooks/nb-1/import', 'POST', {
    title: 'Historia Universal',
    artifactIds: ['art-1', 'art-2']
  });
  assert.equal(importRes.status, 200);
  const result = await importRes.json();
  assert.equal(result.imported, 2);
  assert.ok(result.bookId);

  const book = f.app.store.book(result.bookId);
  assert.equal(book.remote_id, 'nb-1');
  assert.equal(book.title, 'Historia Universal');
  assert.equal(book.running, 1);

  const blocks = f.app.store.blocks(book.id);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].stage, 'download');
  assert.equal(blocks[0].artifact_id, 'art-1');
  assert.equal(blocks[1].stage, 'download');
  assert.equal(blocks[1].artifact_id, 'art-2');

  // Process through queue tick by tick (one by one)
  // Tick 1: Download block 1
  await f.app.queue.tick();
  assert.equal(f.app.store.block(blocks[0].id).stage, 'convert');
  assert.equal(f.provider.calls.filter(c => c[0] === 'download').length, 1);

  // Tick 2: Convert block 1
  await f.app.queue.tick();
  assert.equal(f.app.store.block(blocks[0].id).state, 'done');

  // Tick 3: Download block 2
  await f.app.queue.tick();
  assert.equal(f.app.store.block(blocks[1].id).stage, 'convert');
  assert.equal(f.provider.calls.filter(c => c[0] === 'download').length, 2);

  // Tick 4: Convert block 2
  await f.app.queue.tick();
  assert.equal(f.app.store.block(blocks[1].id).state, 'done');

  // Re-query detail via API shows both are done
  const updatedDetail = await f.call('/api/remote/notebooks/nb-1').then(r => r.json());
  assert.equal(updatedDetail.artifacts[0].isDone, true);
  assert.equal(updatedDetail.artifacts[1].isDone, true);

  // Importing again is idempotent
  const reimport = await f.call('/api/remote/notebooks/nb-1/import', 'POST', {
    title: 'Historia Universal',
    artifactIds: ['art-1', 'art-2']
  }).then(r => r.json());
  assert.equal(reimport.imported, 0);
  assert.equal(f.app.store.blocks(book.id).length, 2);
});

test('CLI studio status solicita con --limit 100 y pagina más de 20 artefactos', async () => {
  const calls = [];
  const runner = {
    run: async (binary, args) => {
      calls.push(args);
      const offset = Number(args[args.indexOf('--offset') + 1] || 0);
      if (offset === 0) {
        // Return 100 items for first page
        return JSON.stringify(Array.from({ length: 100 }, (_, i) => ({
          artifact_id: `art-${i + 1}`,
          type: 'audio',
          title: `Audio ${i + 1}`
        })));
      }
      // Return 30 items for second page
      return JSON.stringify(Array.from({ length: 30 }, (_, i) => ({
        artifact_id: `art-${100 + i + 1}`,
        type: 'audio',
        title: `Audio ${100 + i + 1}`
      })));
    },
    close: async () => {}
  };
  const { Provider } = await import('../provider.mjs');
  const p = new Provider({ runner, profile: 'default' });
  const list = await p.artifacts('book-1');
  assert.equal(list.length, 130);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('--limit') && calls[0].includes('100'));
  assert.ok(calls[0].includes('--offset') && calls[0].includes('0'));
  assert.ok(calls[1].includes('--offset') && calls[1].includes('100'));
});
