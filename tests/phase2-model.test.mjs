import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { createV5FixtureDb } from './helpers.mjs';
import { previewProductionPlan, confirmProductionPlan } from '../production.mjs';

test('Fase 2: Migración v5 -> v6 preserva todos los bloques e inicializa tareas de audio', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-phase2-mig-'));
  const dbFile = join(dir, 'queue.sqlite');
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // 1. Create genuine v5 DB
  const v5db = createV5FixtureDb(dbFile);
  assert.equal(Number(v5db.prepare('PRAGMA user_version').get()?.user_version), 5);
  v5db.close();

  // 2. Open Store (triggers v6 migration)
  const store = new Store(dbFile);
  assert.equal(store.getUserVersion(), 6);

  // 3. Invariants & counts
  const books = store.books();
  assert.equal(books.length, 1);
  const book = books[0];
  assert.equal(book.recipe_id, 'default-audio');
  assert.equal(book.recipe_version, 1);

  const blocks = store.blocks(book.id);
  assert.equal(blocks.length, 6);

  const tasks = store.materialTasks(book.id);
  assert.equal(tasks.length, 6);
  assert.ok(tasks.every(t => t.type === 'audio'));
  assert.ok(tasks.every(t => t.is_current === 1));

  // Verify done block mapped to ready task with output path
  const doneBlock = blocks.find(b => b.id === 'block-v5-done');
  const doneTask = tasks.find(t => t.block_id === doneBlock.id);
  assert.equal(doneTask.state, 'ready');
  assert.equal(doneTask.output_path, '/tmp/b1.mp3');

  // Verify uncertain block mapped to submitting task with baseline
  const uncertainBlock = blocks.find(b => b.id === 'block-v5-uncertain');
  const uncertainTask = tasks.find(t => t.block_id === uncertainBlock.id);
  assert.equal(uncertainTask.state, 'submitting');

  const attempts = store.materialAttempts(uncertainTask.id);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].state, 'uncertain');
  assert.ok(attempts[0].baseline_json.includes('art-audio-1'));

  // 4. Test idempotence: reopening same DB stays at version 6 without duplicate tasks
  store.close();
  const reopened = new Store(dbFile);
  assert.equal(reopened.getUserVersion(), 6);
  assert.equal(reopened.materialTasks(book.id).length, 6);
  reopened.close();
});

test('Fase 2: Transición de material task sincroniza blocks para compatibilidad con snapshot', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-phase2-sync-'));
  const dbFile = join(dir, 'queue.sqlite');
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const store = new Store(dbFile);
  const book = store.createBook({ title: 'Libro Sync Audio', requestId: 'req-sync-1' }, 'default');
  const block = store.addBlock(book.id, {
    requestId: 'req-blk-1',
    title: 'Capítulo 1',
    filename: 'c1.md',
    filePath: '/tmp/c1.md',
    hash: 'hash-c1'
  });

  // Automatically created or manually created material task
  const task = store.createMaterialTask({
    bookId: book.id,
    blockId: block.id,
    type: 'audio',
    state: 'planned'
  });

  assert.equal(task.state, 'planned');

  // Advance task to remote_pending
  store.updateMaterialTask(task.id, { state: 'remote_pending' });
  let b = store.block(block.id);
  assert.equal(b.state, 'generating');
  assert.equal(b.stage, 'poll');

  // Advance task to ready with output_path
  store.updateMaterialTask(task.id, { state: 'ready', output_path: '/tmp/c1.mp3' });
  b = store.block(block.id);
  assert.equal(b.state, 'done');
  assert.equal(b.output_path, '/tmp/c1.mp3');

  // Snapshot contains accurate values
  const snap = store.snapshot();
  const snapBlock = snap[0].blocks.find(x => x.id === block.id);
  assert.equal(snapBlock.state, 'done');
  assert.equal(snapBlock.outputName, 'c1.mp3');

  store.close();
});

test('Fase 2: Planificación de recetas previsualiza y confirma plan idempotente', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-phase2-plan-'));
  const dbFile = join(dir, 'queue.sqlite');
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const store = new Store(dbFile);
  const book = store.createBook({ title: 'Libro Plan', requestId: 'req-plan-1' }, 'default');
  const b1 = store.addBlock(book.id, { requestId: 'r1', title: 'B1', filename: 'b1.md', filePath: '/tmp/b1.md', hash: 'h1' });
  const b2 = store.addBlock(book.id, { requestId: 'r2', title: 'B2', filename: 'b2.md', filePath: '/tmp/b2.md', hash: 'h2' });

  // 1. Preview default recipe (audio enabled only)
  const prev1 = previewProductionPlan({ store, bookId: book.id });
  assert.equal(prev1.summary.totalRequirements, 2);
  assert.equal(prev1.summary.toCreate, 2);
  assert.equal(prev1.requirements.length, 2);

  // 2. Confirm plan with requestId
  const conf1 = confirmProductionPlan({ store, bookId: book.id, requestId: 'plan-req-101' });
  assert.equal(conf1.ok, true);
  assert.equal(conf1.idempotent, false);
  assert.equal(conf1.createdCount, 2);

  // 3. Confirm again with same requestId is strictly idempotent
  const conf2 = confirmProductionPlan({ store, bookId: book.id, requestId: 'plan-req-101' });
  assert.equal(conf2.ok, true);
  assert.equal(conf2.idempotent, true);

  // 4. Preview now shows requirements as reusable (already created)
  const prev2 = previewProductionPlan({ store, bookId: book.id });
  assert.equal(prev2.summary.toCreate, 0);
  assert.equal(prev2.summary.reusable, 2);

  store.close();
});
