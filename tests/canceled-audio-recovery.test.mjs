import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Store } from '../store.mjs';
import { fixture } from './helpers.mjs';
import { previewProductionPlan, confirmProductionPlan } from '../production.mjs';

async function canceledRevision(t) {
  const f = await fixture(t);
  const block = f.add(1);
  f.store.update('books', f.book.id, { running: 1 });
  await f.tick(10);
  const original = f.store.currentMaterialTask(block.id, 'audio');
  assert.equal(original.state, 'ready');
  const revision = f.store.createMaterialRevision(original.id);
  f.queue.cancelMaterialTask(revision.id);
  f.provider.calls.length = 0;
  return { ...f, block, original, revision };
}

test('recupera el audio anterior de una revisión cancelada sin modificar archivo ni generar otra vez', async t => {
  const f = await canceledRevision(t);
  const contents = await readFile(f.original.output_path);
  assert.equal(f.store.materialMatrix(f.book.id).matrix[0].materials.audio.can_restore, true);
  const restored = await f.queue.restorePreviousMaterial(f.revision.id);
  assert.equal(restored.id, f.original.id);
  assert.equal(f.store.block(f.block.id).state, 'done');
  assert.equal(f.store.block(f.block.id).canceled_at, null);
  assert.equal(f.store.block(f.block.id).cancel_requested_at, null);
  assert.ok(f.store.block(f.block.id).artifact_id);
  assert.equal(f.store.materialTask(f.revision.id).state, 'canceled');
  assert.equal(f.store.materialTask(f.revision.id).is_current, 0);
  await f.tick(3);
  assert.deepEqual(await readFile(f.original.output_path), contents);
  assert.equal(f.provider.calls.filter(call => ['generate', 'download', 'convert'].includes(call[0])).length, 0);
  const reopened = new Store(f.store.db.location());
  try { assert.equal(reopened.currentMaterialTask(f.block.id, 'audio').id, f.original.id); }
  finally { reopened.close(); }
  const next = f.store.createMaterialRevision(f.original.id);
  assert.equal(next.revision, 3, 'Debe saltar el número de revisión cancelado que se conserva en el historial');
});

test('preparar pendientes recupera la versión anterior y conserva cancelada la revisión fallida', async t => {
  const f = await canceledRevision(t);
  const preview = previewProductionPlan({ store: f.store, bookId: f.book.id });
  assert.equal(preview.requirements[0].status, 'restore');
  assert.equal(preview.summary.ready, 1);
  assert.equal(preview.summary.toCreate, 0);
  const confirmed = confirmProductionPlan({ store: f.store, bookId: f.book.id, requestId: 'restore-plan' });
  assert.equal(confirmed.createdCount, 0);
  assert.equal(confirmed.reusedCount, 1);
  assert.equal(f.store.currentMaterialTask(f.block.id, 'audio').id, f.original.id);
  assert.equal(f.store.materialTask(f.revision.id).state, 'canceled');
  assert.equal(f.provider.calls.length, 0);
});

test('si no existe versión anterior, confirmar genera una nueva revisión sin reutilizar el número 1 ni la cancelación', async t => {
  const f = await fixture(t);
  const block = f.add(1);
  f.store.update('books', f.book.id, { remote_id: 'existing-book', state: 'ready' });
  f.store.update('blocks', block.id, { source_id: 'existing-source', state: 'ready', stage: 'generate' });
  const canceled = f.store.createMaterialTask({ bookId: f.book.id, blockId: block.id, type: 'audio', state: 'queued' });
  f.queue.cancelMaterialTask(canceled.id);
  assert.equal(f.store.materialMatrix(f.book.id).matrix[0].materials.audio.can_restore, false);
  const confirmed = confirmProductionPlan({ store: f.store, bookId: f.book.id, requestId: 'generate-canceled' });
  assert.equal(confirmed.createdCount, 1);
  assert.equal(confirmed.running, true);
  assert.equal(f.store.currentMaterialTask(block.id, 'audio').revision, 2);
  assert.equal(f.store.block(block.id).canceled_at, null);
  await f.tick(6);
  assert.equal(f.store.currentMaterialTask(block.id, 'audio').state, 'ready');
  assert.equal(f.store.materialTask(canceled.id).state, 'canceled');
  assert.equal(f.provider.calls.filter(call => call[0] === 'generate').length, 1);
});
