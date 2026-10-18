import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV5FixtureDb, CallConcurrencyTracker } from './helpers.mjs';

test('Fase 0: fixture v5 crea base válida con todos los estados exigidos', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-phase0-v5-'));
  const dbPath = join(dir, 'test-v5.sqlite');
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const db = createV5FixtureDb(dbPath);
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    assert.equal(version, 5);

    const books = db.prepare('SELECT * FROM books').all();
    assert.equal(books.length, 1);
    assert.equal(books[0].id, 'book-v5-1');

    const blocks = db.prepare('SELECT * FROM blocks ORDER BY position').all();
    assert.equal(blocks.length, 6);

    const states = blocks.map(b => b.state);
    assert.ok(states.includes('done'), 'Debe incluir bloque terminado');
    assert.ok(states.includes('upload_pending') || states.includes('ready'), 'Debe incluir bloque pendiente');
    assert.ok(states.includes('quota'), 'Debe incluir bloque en cuota');
    assert.ok(states.includes('auth'), 'Debe incluir bloque en error auth');
    assert.ok(states.includes('canceled'), 'Debe incluir bloque cancelado');
    assert.ok(states.includes('submitting'), 'Debe incluir bloque con baseline incierto');

    const uncertain = blocks.find(b => b.state === 'submitting');
    assert.ok(uncertain.baseline, 'Bloque incierto debe tener baseline');

    const jobs = db.prepare('SELECT * FROM download_jobs').all();
    assert.equal(jobs.length, 2);
    assert.ok(jobs.some(j => j.state === 'downloading'), 'Debe incluir download_job en curso');
    assert.ok(jobs.some(j => j.state === 'queued'), 'Debe incluir download_job en cola');

    const accounts = db.prepare('SELECT * FROM accounts').all();
    assert.equal(accounts.length, 4, 'Debe incluir cuatro cuentas');
  } finally {
    db.close();
  }
});

test('Fase 0: CallConcurrencyTracker mide llamadas simultáneas y detecta picos', async () => {
  const tracker = new CallConcurrencyTracker();
  assert.equal(tracker.maxActive, 0);

  // Run three staggered tasks concurrently
  await Promise.all([
    tracker.track('call-1', async () => {
      await new Promise(r => setTimeout(r, 30));
    }),
    tracker.track('call-2', async () => {
      await new Promise(r => setTimeout(r, 30));
    }),
    tracker.track('call-3', async () => {
      await new Promise(r => setTimeout(r, 30));
    })
  ]);

  assert.equal(tracker.calls.length, 3);
  assert.ok(tracker.maxActive >= 2, 'Tracker debe haber detectado concurrencia >= 2');
  assert.equal(tracker.active, 0, 'Al finalizar las llamadas activas deben ser 0');
});
