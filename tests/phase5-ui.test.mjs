import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeApp } from '../server.mjs';
import { FakeProvider } from './helpers.mjs';

test('Fase 5: Estructura HTML y componentes multimodales en index.html', async () => {
  const html = await readFile(resolve('public/index.html'), 'utf8');

  // Verify all essential Fase 5 IDs exist in index.html
  assert.ok(html.includes('id="recipe-selector"'), 'Debe existir #recipe-selector');
  assert.ok(html.includes('id="prepare-plan-btn"'), 'Debe existir #prepare-plan-btn');
  assert.ok(html.includes('id="material-metrics-bar"'), 'Debe existir #material-metrics-bar');
  assert.ok(html.includes('id="waiting-reason-box"'), 'Debe existir #waiting-reason-box');
  assert.ok(html.includes('id="tab-view-matrix"'), 'Debe existir #tab-view-matrix');
  assert.ok(html.includes('id="tab-view-blocks"'), 'Debe existir #tab-view-blocks');
  assert.ok(html.includes('id="matrix-section"'), 'Debe existir #matrix-section');
  assert.ok(html.includes('id="matrix-body"'), 'Debe existir #matrix-body');
  assert.ok(html.includes('id="plan-modal"'), 'Debe existir #plan-modal');
  assert.ok(html.includes('id="plan-modal-summary"'), 'Debe existir #plan-modal-summary');
  assert.ok(html.includes('id="plan-modal-confirm"'), 'Debe existir #plan-modal-confirm');
  assert.ok(html.includes('id="library-search-input"'), 'Debe existir #library-search-input');
  assert.ok(html.includes('id="library-page-info"'), 'Debe existir #library-page-info');
  assert.ok(html.includes('id="library-prev-page"'), 'Debe existir #library-prev-page');
  assert.ok(html.includes('id="library-next-page"'), 'Debe existir #library-next-page');
});

test('Fase 5: Flujo de API de interfaz (Plan preview -> Confirm -> Matriz -> Acciones editoriales)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-nlm-ui-'));
  const app = await makeApp({
    port: 0,
    dataDir: dir,
    exportsDir: join(dir, 'exports'),
    provider: new FakeProvider(),
    worker: false,
    check: false
  });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const request = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(`${app.origin}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Local-Token': app.token
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  };

  // 1. Create a book with 2 blocks
  const createRes = await request('/api/books', {
    method: 'POST',
    body: { title: 'Libro UI Multimodal', requestId: 'req-ui-book-1' }
  });
  assert.equal(createRes.status, 202);
  const bookId = createRes.json.id;

  // Add 2 blocks to store
  app.store.db.prepare(`
    INSERT INTO blocks (id, book_id, request_id, position, title, filename, file_path, hash, source_title, source_id, stage, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('blk-ui-1', bookId, 'r1', 1, 'Capítulo 1', 'cap1.md', 'path/cap1.md', 'hash-1', 'Fuente 1', 'src-1', 'ready', 'ready', Date.now());

  app.store.db.prepare(`
    INSERT INTO blocks (id, book_id, request_id, position, title, filename, file_path, hash, source_title, source_id, stage, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('blk-ui-2', bookId, 'r2', 2, 'Capítulo 2', 'cap2.md', 'path/cap2.md', 'hash-2', 'Fuente 2', 'src-2', 'ready', 'ready', Date.now());

  // 2. Fetch recipes
  const recipesRes = await request('/api/recipes');
  assert.equal(recipesRes.status, 200);
  assert.ok(recipesRes.json.recipes.length >= 1);
  const studyRecipe = recipesRes.json.recipes.find(r => r.id === 'study-book') || recipesRes.json.recipes[0];
  const recipeId = studyRecipe.id;

  // 3. Preview plan
  const previewRes = await request(`/api/books/${bookId}/plan/preview`, {
    method: 'POST',
    body: { recipeId }
  });
  assert.equal(previewRes.status, 200);
  assert.equal(previewRes.json.summary.totalRequirements, 4); // 2 audio + 2 infographic
  assert.equal(previewRes.json.summary.toCreate, 4);

  // 4. Confirm plan
  const confirmRes = await request(`/api/books/${bookId}/plan/confirm`, {
    method: 'POST',
    body: { recipeId, requestId: 'ui-confirm-1' }
  });
  if (confirmRes.status !== 200) {
    console.error('Confirm error:', confirmRes);
  }
  assert.equal(confirmRes.status, 200);
  assert.equal(confirmRes.json.createdCount, 4);

  // 5. Query matrix endpoint
  const matrixRes = await request(`/api/books/${bookId}/matrix`);
  assert.equal(matrixRes.status, 200);
  assert.equal(matrixRes.json.summary.totalBlocks, 2);
  assert.equal(matrixRes.json.summary.totalRequirements, 4);
  assert.equal(matrixRes.json.matrix.length, 2);
  assert.ok(matrixRes.json.matrix[0].materials.audio);
  assert.ok(matrixRes.json.matrix[0].materials.infographic);

  // 6. Test editorial action on a material task
  const audioTask = matrixRes.json.matrix[0].materials.audio;
  // Mark audio task as ready first
  app.store.update('material_tasks', audioTask.id, { state: 'ready' });

  const approveRes = await request(`/api/materials/${audioTask.id}/action`, {
    method: 'POST',
    body: { action: 'approve' }
  });
  assert.equal(approveRes.status, 200);
  assert.equal(approveRes.json.task.editorial_state, 'approved');

  // Reject it
  const rejectRes = await request(`/api/materials/${audioTask.id}/action`, {
    method: 'POST',
    body: { action: 'reject' }
  });
  assert.equal(rejectRes.status, 200);
  assert.equal(rejectRes.json.task.editorial_state, 'rejected');

  // Create revision
  const revRes = await request(`/api/materials/${audioTask.id}/action`, {
    method: 'POST',
    body: { action: 'revision' }
  });
  assert.equal(revRes.status, 201);
  assert.equal(revRes.json.task.revision, 2);

  // 7. Verify search API returns book
  const searchRes = await request(`/api/library/search?q=Multimodal`);
  assert.equal(searchRes.status, 200);
  assert.equal(searchRes.json.items.length, 1);
  assert.equal(searchRes.json.items[0].id, bookId);
});
