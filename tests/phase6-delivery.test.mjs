import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { makeApp } from '../server.mjs';
import { FakeProvider } from './helpers.mjs';

function makeFakePngBuffer(width = 64, height = 64) {
  // Minimal valid PNG stream with 8-byte signature and IHDR chunk
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8); // bit depth
  ihdrData.writeUInt8(2, 9); // truecolor
  ihdrData.writeUInt8(0, 10); // compression
  ihdrData.writeUInt8(0, 11); // filter
  ihdrData.writeUInt8(0, 12); // interlace

  const ihdrLength = Buffer.alloc(4);
  ihdrLength.writeUInt32BE(13, 0);
  const ihdrType = Buffer.from('IHDR', 'ascii');
  const ihdrCrc = Buffer.alloc(4); // simple stub CRC

  // IEND chunk
  const iendLength = Buffer.alloc(4);
  const iendType = Buffer.from('IEND', 'ascii');
  const iendCrc = Buffer.alloc(4);

  return Buffer.concat([signature, ihdrLength, ihdrType, ihdrData, ihdrCrc, iendLength, iendType, iendCrc]);
}

test('Fase 6: Entrega completa consolidada (manifiesto, checksums, HTML, CSV, inmutabilidad)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-nlm-del-'));
  const exportsDir = join(dir, 'exports');
  await mkdir(exportsDir, { recursive: true });
  const provider = new FakeProvider();
  const app = await makeApp({
    port: 0,
    dataDir: dir,
    exportsDir,
    provider,
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
      headers: { 'Content-Type': 'application/json', 'X-Local-Token': app.token },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  };

  // 1. Create a book with 2 blocks (one with dangerous formula character in title: "=SUM(1,2)")
  const createRes = await request('/api/books', {
    method: 'POST',
    body: { title: 'Física Clásica', requestId: 'req-del-book-1' }
  });
  const bookId = createRes.json.id;

  const audioPath1 = join(exportsDir, 'audio1.mp3');
  const audioPath2 = join(exportsDir, 'audio2.mp3');
  const infoPath1 = join(exportsDir, 'info1.png');
  const infoPath2 = join(exportsDir, 'info2.png');

  await writeFile(audioPath1, Buffer.from('FAKE-AUDIO-STREAM-DATA-1'));
  await writeFile(audioPath2, Buffer.from('FAKE-AUDIO-STREAM-DATA-2'));
  await writeFile(infoPath1, makeFakePngBuffer(800, 600));
  await writeFile(infoPath2, makeFakePngBuffer(800, 600));

  app.store.db.prepare(`
    INSERT INTO blocks (id, book_id, request_id, position, title, filename, file_path, hash, source_title, source_id, stage, state, output_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('blk-del-1', bookId, 'r1', 1, 'Cinemática Básica', 'cinematica.md', 'path/cin.md', 'hash-1', 'Fuente 1', 'src-1', 'done', 'done', audioPath1, Date.now());

  app.store.db.prepare(`
    INSERT INTO blocks (id, book_id, request_id, position, title, filename, file_path, hash, source_title, source_id, stage, state, output_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('blk-del-2', bookId, 'r2', 2, '=Fórmula Riesgosa y Leyes de Newton', 'newton.md', 'path/new.md', 'hash-2', 'Fuente 2', 'src-2', 'done', 'done', audioPath2, Date.now());

  // Confirm plan for study-book (audio + infographic)
  await request(`/api/books/${bookId}/plan/confirm`, {
    method: 'POST',
    body: { recipeId: 'study-book', requestId: 'req-confirm-plan' }
  });

  // Link infographic tasks to the created png files and mark ready
  const tasks = app.store.materialTasks(bookId, { currentOnly: true });
  const infoTask1 = tasks.find(t => t.block_id === 'blk-del-1' && t.type === 'infographic');
  const infoTask2 = tasks.find(t => t.block_id === 'blk-del-2' && t.type === 'infographic');

  app.store.update('material_tasks', infoTask1.id, { state: 'ready', output_path: infoPath1, editorial_state: 'approved' });
  app.store.update('material_tasks', infoTask2.id, { state: 'ready', output_path: infoPath2, editorial_state: 'approved' });

  const audioTask1 = tasks.find(t => t.block_id === 'blk-del-1' && t.type === 'audio');
  const audioTask2 = tasks.find(t => t.block_id === 'blk-del-2' && t.type === 'audio');
  app.store.update('material_tasks', audioTask1.id, { state: 'ready', output_path: audioPath1, editorial_state: 'approved' });
  app.store.update('material_tasks', audioTask2.id, { state: 'ready', output_path: audioPath2, editorial_state: 'approved' });

  // 2. Export complete delivery
  const exportRes = await request(`/api/books/${bookId}/exports`, {
    method: 'POST',
    body: { requireApproved: true, allowPartial: false }
  });

  assert.equal(exportRes.status, 201);
  assert.equal(exportRes.json.ok, true);
  assert.ok(exportRes.json.deliveryId);
  assert.equal(exportRes.json.summary.isComplete, true);
  assert.equal(exportRes.json.summary.deliveredMaterials, 4);
  assert.equal(exportRes.json.summary.missingMaterials, 0);

  const deliveryDir = exportRes.json.path;

  // 3. Verify directory structure and files on disk
  const manifestRaw = await readFile(join(deliveryDir, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);

  assert.equal(manifest.schemaVersion, '1.0.0');
  assert.equal(manifest.book.id, bookId);
  assert.equal(manifest.summary.totalBlocks, 2);
  assert.equal(manifest.blocks.length, 2);

  // Check no sensitive credential data in manifest
  assert.equal(manifestRaw.includes('cookie'), false);
  assert.equal(manifestRaw.includes('token'), false);
  assert.equal(manifestRaw.includes('@gmail.com'), false);

  // Check block 1 folder and checksums
  const b1 = manifest.blocks[0];
  assert.ok(b1.materials.audio.delivered);
  assert.ok(b1.materials.infographic.delivered);

  const expectedAudio1Sha = createHash('sha256').update(Buffer.from('FAKE-AUDIO-STREAM-DATA-1')).digest('hex');
  assert.equal(b1.materials.audio.sha256, expectedAudio1Sha);

  const copiedAudio1 = await readFile(join(deliveryDir, b1.folder, 'audio.mp3'));
  assert.equal(createHash('sha256').update(copiedAudio1).digest('hex'), expectedAudio1Sha);

  const copiedInfo1 = await readFile(join(deliveryDir, b1.folder, 'infografia.png'));
  assert.ok(copiedInfo1.length > 0);

  // 4. Verify index.html exists, contains escaped titles and correct structure
  const indexHtml = await readFile(join(deliveryDir, 'index.html'), 'utf8');
  assert.ok(indexHtml.includes('Cinemática Básica'));
  assert.ok(indexHtml.includes('Entrega Completa'));
  assert.ok(indexHtml.includes('audio.mp3'));
  assert.ok(indexHtml.includes('infografia.png'));

  // 5. Verify index.csv protects against formula injection
  const indexCsv = await readFile(join(deliveryDir, 'index.csv'), 'utf8');
  // "=Fórmula Riesgosa" must be escaped with leading apostrophe
  assert.ok(indexCsv.includes("''=Fórmula Riesgosa") || indexCsv.includes("'=Fórmula Riesgosa"));

  // 6. List deliveries endpoint
  const listRes = await request(`/api/books/${bookId}/exports`);
  assert.equal(listRes.status, 200);
  assert.equal(listRes.json.deliveries.length, 1);
  assert.equal(listRes.json.deliveries[0].id, exportRes.json.deliveryId);

  // 7. Get delivery detail endpoint
  const detailRes = await request(`/api/books/${bookId}/exports/${exportRes.json.deliveryId}`);
  assert.equal(detailRes.status, 200);
  assert.equal(detailRes.json.delivery.deliveryId, exportRes.json.deliveryId);
});

test('Fase 6: Rechazo de entrega incompleta vs Entrega parcial explícita', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-nlm-del-partial-'));
  const exportsDir = join(dir, 'exports');
  await mkdir(exportsDir, { recursive: true });
  const app = await makeApp({
    port: 0,
    dataDir: dir,
    exportsDir,
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
      headers: { 'Content-Type': 'application/json', 'X-Local-Token': app.token },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  };

  const createRes = await request('/api/books', {
    method: 'POST',
    body: { title: 'Química Orgánica', requestId: 'req-chem-1' }
  });
  const bookId = createRes.json.id;

  const audioPath1 = join(exportsDir, 'audio_chem1.mp3');
  await writeFile(audioPath1, Buffer.from('CHEMISTRY-AUDIO-DATA'));

  app.store.db.prepare(`
    INSERT INTO blocks (id, book_id, request_id, position, title, filename, file_path, hash, source_title, source_id, stage, state, output_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('blk-chem-1', bookId, 'rc1', 1, 'Alcanos y Alquenos', 'alcanos.md', 'path/alc.md', 'hash-chem', 'Fuente 1', 'src-chem-1', 'done', 'done', audioPath1, Date.now());

  // Confirm plan: requires both audio AND infographic
  await request(`/api/books/${bookId}/plan/confirm`, {
    method: 'POST',
    body: { recipeId: 'study-book', requestId: 'req-confirm-chem' }
  });

  // Note: infographic is NOT ready (missing)

  // 1. Attempt delivery with allowPartial = false -> Must fail with 400 INCOMPLETE_DELIVERY
  const failRes = await request(`/api/books/${bookId}/exports`, {
    method: 'POST',
    body: { allowPartial: false }
  });
  assert.equal(failRes.status, 400);
  assert.equal(failRes.json.code, 'INCOMPLETE_DELIVERY');
  assert.ok(failRes.json.missing.length > 0);
  assert.equal(failRes.json.missing[0].kind, 'infographic');

  // 2. Attempt delivery with allowPartial = true -> Must succeed and mark missing
  const partialRes = await request(`/api/books/${bookId}/exports`, {
    method: 'POST',
    body: { allowPartial: true }
  });
  assert.equal(partialRes.status, 201);
  assert.equal(partialRes.json.ok, true);
  assert.equal(partialRes.json.summary.isComplete, false);
  assert.equal(partialRes.json.summary.missingMaterials, 1);
  assert.equal(partialRes.json.summary.deliveredMaterials, 1);

  // Check manifest reflects partial state
  const manifest = partialRes.json.manifest;
  assert.equal(manifest.summary.isComplete, false);
  assert.equal(manifest.blocks[0].materials.audio.delivered, true);
  assert.equal(manifest.blocks[0].materials.infographic.delivered, false);
  assert.equal(manifest.blocks[0].materials.infographic.missing, true);
});

test('Fase 6: Política editorial requireApproved', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-nlm-del-appr-'));
  const exportsDir = join(dir, 'exports');
  await mkdir(exportsDir, { recursive: true });
  const app = await makeApp({
    port: 0,
    dataDir: dir,
    exportsDir,
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
      headers: { 'Content-Type': 'application/json', 'X-Local-Token': app.token },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  };

  const createRes = await request('/api/books', {
    method: 'POST',
    body: { title: 'Historia del Arte', requestId: 'req-art-1' }
  });
  const bookId = createRes.json.id;

  const audioPath = join(exportsDir, 'audio_art.mp3');
  await writeFile(audioPath, Buffer.from('ART-AUDIO-DATA'));

  app.store.db.prepare(`
    INSERT INTO blocks (id, book_id, request_id, position, title, filename, file_path, hash, source_title, source_id, stage, state, output_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('blk-art-1', bookId, 'ra1', 1, 'Renacimiento', 'renacimiento.md', 'path/ren.md', 'hash-art', 'Fuente 1', 'src-art-1', 'done', 'done', audioPath, Date.now());

  // Confirm plan for default-audio
  await request(`/api/books/${bookId}/plan/confirm`, {
    method: 'POST',
    body: { recipeId: 'default-audio', requestId: 'req-confirm-art' }
  });

  const tasks = app.store.materialTasks(bookId, { currentOnly: true });
  const audioTask = tasks.find(t => t.type === 'audio');
  // Task is ready but editorial_state is unreviewed
  app.store.update('material_tasks', audioTask.id, { state: 'ready', output_path: audioPath, editorial_state: 'unreviewed' });

  // 1. Export with requireApproved: true -> must fail with APPROVAL_REQUIRED
  const failRes = await request(`/api/books/${bookId}/exports`, {
    method: 'POST',
    body: { requireApproved: true, allowPartial: false }
  });
  assert.equal(failRes.status, 400);
  assert.equal(failRes.json.code, 'APPROVAL_REQUIRED');
  assert.equal(failRes.json.unapproved.length, 1);

  // 2. Approve the task
  await request(`/api/materials/${audioTask.id}/action`, {
    method: 'POST',
    body: { action: 'approve' }
  });

  // 3. Retry export with requireApproved: true -> must succeed
  const okRes = await request(`/api/books/${bookId}/exports`, {
    method: 'POST',
    body: { requireApproved: true, allowPartial: false }
  });
  assert.equal(okRes.status, 201);
  assert.equal(okRes.json.ok, true);
  assert.equal(okRes.json.summary.isComplete, true);
});
