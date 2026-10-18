import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, temporary } from './helpers.mjs';
import { makeApp } from '../server.mjs';
import { FakeProvider } from './helpers.mjs';

test('multimodal conserva los 8 audios existentes y solo genera las 8 infografías faltantes', async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 8; i++) f.add(i);
  f.store.update('books', f.book.id, { running: 1 });
  await f.tick(65);
  const audios = f.store.materialTasks(f.book.id).filter(task => task.type === 'audio');
  assert.equal(audios.length, 8);
  assert.ok(audios.every(task => task.state === 'ready'));
  const files = await Promise.all(audios.map(task => readFile(task.output_path)));
  // Reproduce migrated metadata, including a content-setting difference the user accepts.
  for (const task of audios) {
    f.store.update('material_tasks', task.id, {
      params_json: JSON.stringify({ format: 'deep_dive', length: 'long', language: 'es-419', mode: 'immediate' }),
      params_hash: 'legacy-hash'
    });
  }
  const preview = previewProductionPlan({ store: f.store, bookId: f.book.id, recipeId: 'study-book' });
  assert.equal(preview.summary.ready, 8);
  assert.equal(preview.summary.toCreate, 8);
  assert.equal(preview.summary.outdated, 0);
  assert.ok(preview.requirements.filter(req => req.type === 'audio').every(req => req.status === 'ready'));
  f.provider.calls.length = 0;
  const plan = appConfirmPlan(f.store, f.book.id, 'study-book', 'preserve-existing-audio');
  assert.equal(plan.createdCount, 8);
  assert.equal(plan.reusedCount, 8);
  assert.equal(plan.running, true);
  assert.equal(f.store.book(f.book.id).running, 1);
  assert.ok(f.store.materialTasks(f.book.id).filter(task => task.type === 'infographic').every(task => task.state === 'queued'));
  await f.tick(45);
  assert.equal(f.provider.calls.filter(call => call[0] === 'generateInfographic').length, 8);
  assert.equal(f.provider.calls.filter(call => ['generate', 'download', 'convert'].includes(call[0])).length, 0);
  for (const [index, original] of audios.entries()) {
    assert.deepEqual(f.store.currentMaterialTask(original.block_id, 'audio'), f.store.materialTask(original.id));
    assert.equal(f.store.currentMaterialTask(original.block_id, 'audio').revision, original.revision);
    assert.deepEqual(await readFile(original.output_path), files[index]);
  }
});

test('confirmar inicia automáticamente; reintentar la confirmación no deshace una pausa posterior', async t => {
  const f = await fixture(t);
  f.add(1);
  const first = appConfirmPlan(f.store, f.book.id, 'study-book', 'auto-start-plan');
  assert.equal(first.running, true);
  assert.equal(f.store.book(f.book.id).running, 1);
  assert.ok(f.store.materialTasks(f.book.id).every(task => task.state === 'queued'));
  f.store.update('books', f.book.id, { running: 0 });
  const replay = appConfirmPlan(f.store, f.book.id, 'study-book', 'auto-start-plan');
  assert.equal(replay.idempotent, true);
  assert.equal(replay.running, false);
  assert.equal(f.store.book(f.book.id).running, 0);
});

test('metadatos de audio migrados no provocan falsos desactualizados; un cambio de fuente sigue siendo visible', async t => {
  const f = await fixture(t);
  const block = f.add(1);
  const task = f.store.createMaterialTask({
    bookId: f.book.id, blockId: block.id, type: 'audio', sourceFingerprint: block.hash,
    params: { format: 'deep_dive', length: 'default', language: 'es-419', mode: 'immediate' }
  });
  const pending = previewProductionPlan({ store: f.store, bookId: f.book.id, recipeId: 'study-book' });
  assert.equal(pending.summary.reusable, 1);
  assert.equal(pending.summary.outdated, 0);
  f.store.update('material_tasks', task.id, { state: 'ready', source_fingerprint: 'old-source-hash' });
  const changed = previewProductionPlan({ store: f.store, bookId: f.book.id, recipeId: 'study-book' });
  assert.equal(changed.summary.outdated, 1);
  assert.equal(changed.requirements.find(req => req.type === 'audio').status, 'outdated');
  const plan = appConfirmPlan(f.store, f.book.id, 'study-book', 'changed-source');
  assert.equal(plan.createdCount, 1);
  assert.equal(f.store.currentMaterialTask(block.id, 'audio').id, task.id);
  assert.equal(f.provider.calls.filter(call => call[0] === 'generate').length, 0);
});

test('Fase 3: Recetas API - listar recetas base y crear receta personalizada con validación', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-nlm-rec-'));
  const app = await makeApp({ port: 0, dataDir: dir, exportsDir: join(dir, 'exports'), provider: new FakeProvider(), worker: false, check: false });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  // 1. List default recipes
  const res1 = await fetch(`${app.origin}/api/recipes`);
  assert.equal(res1.status, 200);
  const data1 = await res1.json();
  assert.equal(data1.ok, true);
  assert.ok(data1.recipes.some(r => r.id === 'default-audio'));
  assert.ok(data1.recipes.some(r => r.id === 'study-book'));

  // 2. Create custom recipe
  const customConfig = {
    materials: {
      audio: { enabled: true, language: 'es-419', format: 'deep_dive' },
      infographic: { enabled: true, orientation: 'portrait' }
    }
  };
  const res2 = await fetch(`${app.origin}/api/recipes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Local-Token': app.token },
    body: JSON.stringify({ id: 'custom-study', name: 'Estudio vertical', config: customConfig })
  });
  assert.equal(res2.status, 201);
  const data2 = await res2.json();
  assert.equal(data2.ok, true);
  assert.equal(data2.recipe.id, 'custom-study');
  assert.equal(data2.recipe.version, 1);
  assert.equal(data2.recipe.name, 'Estudio vertical');

  // 3. Reject invalid material type
  const badConfig = {
    materials: {
      unsupported_type: { enabled: true }
    }
  };
  const res3 = await fetch(`${app.origin}/api/recipes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Local-Token': app.token },
    body: JSON.stringify({ id: 'bad-recipe', name: 'Receta Inválida', config: badConfig })
  });
  assert.equal(res3.status, 400);
});

test('Fase 3: Previsualización y confirmación idempotente con rechazo de conflicto (409)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-nlm-plan-'));
  const app = await makeApp({ port: 0, dataDir: dir, exportsDir: join(dir, 'exports'), provider: new FakeProvider(), worker: false, check: false });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  const book = app.store.createBook({ title: 'Libro Idempotencia', requestId: 'req-idem-book' }, 'default');
  const b1 = app.store.addBlock(book.id, { requestId: 'req-b1', title: 'Bloque 1', filename: 'b1.md', filePath: join(dir, 'b1.md'), hash: 'h1' });
  const b2 = app.store.addBlock(book.id, { requestId: 'req-b2', title: 'Bloque 2', filename: 'b2.md', filePath: join(dir, 'b2.md'), hash: 'h2' });

  // 1. Preview study-book recipe
  const prevRes = await fetch(`${app.origin}/api/books/${book.id}/production/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Local-Token': app.token },
    body: JSON.stringify({ recipeId: 'study-book' })
  });
  assert.equal(prevRes.status, 200);
  const prevData = await prevRes.json();
  assert.equal(prevData.ok, true);
  assert.equal(prevData.summary.totalBlocks, 2);
  assert.equal(prevData.summary.totalRequirements, 4); // 2 blocks * 2 materials (audio, infographic)
  assert.equal(prevData.summary.toCreate, 4);

  // 2. Confirm production plan
  const planRes1 = await fetch(`${app.origin}/api/books/${book.id}/production/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Local-Token': app.token },
    body: JSON.stringify({ recipeId: 'study-book', requestId: 'idem-plan-001' })
  });
  assert.equal(planRes1.status, 200);
  const planData1 = await planRes1.json();
  assert.equal(planData1.ok, true);
  assert.equal(planData1.idempotent, false);
  assert.equal(planData1.createdCount, 4);

  // 3. Double-confirm with same requestId and same payload -> idempotent 200
  const planRes2 = await fetch(`${app.origin}/api/books/${book.id}/production/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Local-Token': app.token },
    body: JSON.stringify({ recipeId: 'study-book', requestId: 'idem-plan-001' })
  });
  assert.equal(planRes2.status, 200);
  const planData2 = await planRes2.json();
  assert.equal(planData2.ok, true);
  assert.equal(planData2.idempotent, true);

  // 4. Confirm with same requestId but different payload -> 409 Conflict
  const planResConflict = await fetch(`${app.origin}/api/books/${book.id}/production/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Local-Token': app.token },
    body: JSON.stringify({ recipeId: 'default-audio', requestId: 'idem-plan-001' })
  });
  assert.equal(planResConflict.status, 409);
  const conflictData = await planResConflict.json();
  assert.match(conflictData.error, /Conflicto/);
});

test('Fase 3: Recorrido multimodal simulado completo (Audio + Infografía) y verificación de matriz', async t => {
  const f = await fixture(t);
  const b1 = f.add(1);
  const b2 = f.add(2);

  // 1. Confirm plan for study-book (Audio + Infographic)
  const confirmed = await fetch(`${f.options.dataDir}`).catch(() => null); // dummy
  const plan = appConfirmPlan(f.store, f.book.id, 'study-book', 'req-multi-1');
  assert.equal(plan.createdCount, 4);

  // Start production
  f.store.update('books', f.book.id, { running: 1 });
  f.store.db.prepare("UPDATE material_tasks SET state='queued' WHERE book_id=?").run(f.book.id);

  // Tick until all uploaded, generated, polled, and downloaded
  await f.tick(25);

  const tasks = f.store.materialTasks(f.book.id);
  assert.equal(tasks.length, 4);
  for (const task of tasks) {
    assert.equal(task.state, 'ready', `Task ${task.id} (${task.type}) should be ready`);
    assert.ok(task.output_path, `Task ${task.id} should have output_path`);
    const st = await stat(task.output_path);
    assert.ok(st.size > 0, `Output file for ${task.type} must not be empty`);
  }

  // Check blocks state
  const blocks = f.store.blocks(f.book.id);
  assert.equal(blocks[0].state, 'done');
  assert.equal(blocks[1].state, 'done');

  // Verify matrix calculation in Store
  const mat = f.store.materialMatrix(f.book.id);
  assert.equal(mat.summary.totalBlocks, 2);
  assert.equal(mat.summary.totalRequirements, 4);
  assert.equal(mat.summary.ready, 4);
  assert.equal(mat.summary.waiting, 0);
  assert.equal(mat.matrix.length, 2);
  assert.ok(mat.matrix[0].materials.audio);
  assert.ok(mat.matrix[0].materials.infographic);
  assert.equal(mat.matrix[0].materials.audio.state, 'ready');
  assert.equal(mat.matrix[0].materials.infographic.state, 'ready');
});

test('Fase 3: Vinculación de infografía existente por ID exacto de fuente sin llamada a generación', async t => {
  const f = await fixture(t);
  const b1 = f.add(1);

  // Upload source first
  f.store.update('books', f.book.id, { running: 1 });
  await f.tick(3);
  const block = f.store.block(b1.id);
  assert.ok(block.source_id, 'Source should be uploaded');

  // Inject an existing completed infographic with matching single source in remote notebook
  const existingArtId = 'infographic-existing-001';
  f.provider.remoteArtifacts.push({
    artifact_id: existingArtId,
    type: 'infographic',
    source_ids: [block.source_id],
    status: 'completed'
  });

  // Create an infographic task
  const task = f.store.createMaterialTask({
    bookId: f.book.id,
    blockId: block.id,
    type: 'infographic',
    state: 'queued',
    params: {}
  });

  const genCallsBefore = f.provider.calls.filter(c => c[0] === 'generateInfographic').length;

  // Tick queue until linking and download complete
  await f.tick(8);

  const genCallsAfter = f.provider.calls.filter(c => c[0] === 'generateInfographic').length;
  // ZERO calls to generateInfographic because it linked existing
  assert.equal(genCallsAfter, genCallsBefore, 'No se debe haber llamado a generateInfographic');

  const updatedTask = f.store.materialTask(task.id);
  assert.equal(updatedTask.state, 'ready');
  const attempts = f.store.materialAttempts(task.id);
  assert.equal(attempts[0].artifact_id, existingArtId);
  assert.ok(updatedTask.output_path);
  const st = await stat(updatedTask.output_path);
  assert.ok(st.size > 0);
});

test('Fase 3: Artefacto remoto con múltiples fuentes no se vincula automáticamente', async t => {
  const f = await fixture(t);
  const b1 = f.add(1);

  // Upload source
  f.store.update('books', f.book.id, { running: 1 });
  await f.tick(3);
  const block = f.store.block(b1.id);

  // Inject artifact with MULTIPLE sources (not 1:1)
  f.provider.remoteArtifacts.push({
    artifact_id: 'infographic-multi-source',
    type: 'infographic',
    source_ids: [block.source_id, 'other-source-id'],
    status: 'completed'
  });

  // Create task
  const task = f.store.createMaterialTask({
    bookId: f.book.id,
    blockId: block.id,
    type: 'infographic',
    state: 'queued',
    params: {}
  });

  const genCallsBefore = f.provider.calls.filter(c => c[0] === 'generateInfographic').length;
  await f.tick(12);

  const genCallsAfter = f.provider.calls.filter(c => c[0] === 'generateInfographic').length;
  // Must generate its own infographic instead of linking the multi-source one!
  assert.equal(genCallsAfter, genCallsBefore + 1, 'Debe generar infografía propia para una sola fuente');

  const updatedTask = f.store.materialTask(task.id);
  assert.equal(updatedTask.state, 'ready');
  const attempts = f.store.materialAttempts(task.id);
  assert.notEqual(attempts[0]?.artifact_id, 'infographic-multi-source');
});

test('Fase 3: Fallo de descarga reintenta descarga del ID existente y NO regenera', async t => {
  const f = await fixture(t);
  const b1 = f.add(1);

  // Upload source and generate infographic
  f.store.update('books', f.book.id, { running: 1 });
  await f.tick(3);
  const block = f.store.block(b1.id);

  const task = f.store.createMaterialTask({
    bookId: f.book.id,
    blockId: block.id,
    type: 'infographic',
    state: 'queued',
    params: {}
  });

  // Tick until infographic is submitted
  while (f.provider.calls.filter(c => c[0] === 'generateInfographic').length === 0) {
    await f.tick(1);
  }
  const genCalls = f.provider.calls.filter(c => c[0] === 'generateInfographic').length;
  assert.equal(genCalls, 1);

  // Wait until task reaches download_pending
  await f.tick(1);

  // Induce download failure
  f.provider.behavior.downloadInfographic = temporary();
  await f.tick(3);

  // Task fails download and enters retry_wait or download_pending backoff
  const failedTask = f.store.materialTask(task.id);
  assert.ok(['download_pending', 'retry_wait'].includes(failedTask.state));
  assert.ok(failedTask.retry_count >= 1);

  // Generations must remain 1!
  assert.equal(f.provider.calls.filter(c => c[0] === 'generateInfographic').length, 1);

  // Remove download error and tick
  delete f.provider.behavior.downloadInfographic;
  f.advance(60000);
  await f.tick(5);

  const finishedTask = f.store.materialTask(task.id);
  assert.equal(finishedTask.state, 'ready');
  // Still exactly 1 generation call
  assert.equal(f.provider.calls.filter(c => c[0] === 'generateInfographic').length, 1);
  assert.equal(f.provider.calls.filter(c => c[0] === 'generateInfographic').length, 1);
});

test('Fase 3: Gestión editorial y nuevas revisiones (approve, reject, revision)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-nlm-mat-'));
  const app = await makeApp({ port: 0, dataDir: dir, exportsDir: join(dir, 'exports'), provider: new FakeProvider(), worker: false, check: false });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  const book = app.store.createBook({ title: 'Libro Editorial', requestId: 'req-edit-book' }, 'default');
  const b1 = app.store.addBlock(book.id, { requestId: 'req-edit-b1', title: 'Bloque Editorial', filename: 'e1.md', filePath: join(dir, 'e1.md'), hash: 'he1' });

  const task = app.store.createMaterialTask({
    bookId: book.id,
    blockId: b1.id,
    type: 'infographic',
    state: 'ready',
    editorialState: 'unreviewed'
  });

  // 1. Approve
  const approveRes = await fetch(`${app.origin}/api/materials/${task.id}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Local-Token': app.token },
    body: JSON.stringify({ action: 'approve' })
  });
  assert.equal(approveRes.status, 200);
  const approveData = await approveRes.json();
  assert.equal(approveData.task.editorial_state, 'approved');

  // 2. Reject
  const rejectRes = await fetch(`${app.origin}/api/materials/${task.id}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Local-Token': app.token },
    body: JSON.stringify({ action: 'reject' })
  });
  assert.equal(rejectRes.status, 200);
  const rejectData = await rejectRes.json();
  assert.equal(rejectData.task.editorial_state, 'rejected');

  // Approve again before revision test
  app.store.approveMaterialTask(task.id);

  // 3. Request new revision
  const revRes = await fetch(`${app.origin}/api/materials/${task.id}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Local-Token': app.token },
    body: JSON.stringify({ action: 'revision' })
  });
  assert.equal(revRes.status, 201);
  const revData = await revRes.json();
  assert.equal(revData.task.revision, 2);
  assert.equal(revData.task.is_current, 1);
  // New revision starts unreviewed!
  assert.equal(revData.task.editorial_state, 'unreviewed');
  assert.equal(revData.task.state, 'planned');

  // Previous task is no longer current, but preserves its approved state
  const prevTask = app.store.materialTask(task.id);
  assert.equal(prevTask.is_current, 0);
  assert.equal(prevTask.editorial_state, 'approved');
});

test('Fase 3: Búsqueda en biblioteca /api/library/search con filtros y paginación', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-nlm-search-'));
  const app = await makeApp({ port: 0, dataDir: dir, exportsDir: join(dir, 'exports'), provider: new FakeProvider(), worker: false, check: false });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  const bA = app.store.createBook({ title: 'Historia Romana', requestId: 'req-hist' }, 'default');
  app.store.addBlock(bA.id, { requestId: 'req-h1', title: 'Julio César', filename: 'cesar.md', filePath: join(dir, 'cesar.md'), hash: 'hc1' });

  const bB = app.store.createBook({ title: 'Física Cuántica', requestId: 'req-fis' }, 'default');
  app.store.addBlock(bB.id, { requestId: 'req-f1', title: 'Mecánica de Ondas', filename: 'ondas.md', filePath: join(dir, 'ondas.md'), hash: 'hf1' });

  // 1. Search by book title
  const res1 = await fetch(`${app.origin}/api/library/search?q=Romana`);
  const data1 = await res1.json();
  assert.equal(data1.ok, true);
  assert.equal(data1.items.length, 1);
  assert.equal(data1.items[0].title, 'Historia Romana');

  // 2. Search by block title
  const res2 = await fetch(`${app.origin}/api/library/search?q=César`);
  const data2 = await res2.json();
  assert.equal(data2.ok, true);
  assert.equal(data2.items.length, 1);
  assert.equal(data2.items[0].title, 'Historia Romana');

  // 3. Search with no matches
  const res3 = await fetch(`${app.origin}/api/library/search?q=InexistenteTermino`);
  const data3 = await res3.json();
  assert.equal(data3.ok, true);
  assert.equal(data3.items.length, 0);
});
import { confirmProductionPlan as cppDirect, previewProductionPlan } from '../production.mjs';
function appConfirmPlan(store, bookId, recipeId, requestId) {
  return cppDirect({ store, bookId, recipeId, requestId });
}
