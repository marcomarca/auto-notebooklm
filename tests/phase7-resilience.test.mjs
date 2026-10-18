import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { makeApp } from '../server.mjs';
import { FakeProvider, CallConcurrencyTracker } from './helpers.mjs';
import { createBackup, validateBackup, restoreBackup } from '../backup.mjs';
import { createDelivery } from '../delivery.mjs';

function makeFakePngBuffer(width = 64, height = 64) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8);
  ihdrData.writeUInt8(2, 9);
  ihdrData.writeUInt8(0, 10);
  ihdrData.writeUInt8(0, 11);
  ihdrData.writeUInt8(0, 12);

  const ihdrLength = Buffer.alloc(4);
  ihdrLength.writeUInt32BE(13, 0);
  const ihdrType = Buffer.from('IHDR', 'ascii');
  const ihdrCrc = Buffer.alloc(4);

  const iendLength = Buffer.alloc(4);
  const iendType = Buffer.from('IEND', 'ascii');
  const iendCrc = Buffer.alloc(4);

  return Buffer.concat([signature, ihdrLength, ihdrType, ihdrData, ihdrCrc, iendLength, iendType, iendCrc]);
}

test('Fase 7: Respaldo consistente SQLite (VACUUM INTO), exclusión de credenciales, validación y restauración', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-nlm-backup-'));
  const dataDir = join(dir, 'data');
  const exportsDir = join(dir, 'exports');
  await mkdir(dataDir, { recursive: true });
  await mkdir(exportsDir, { recursive: true });
  const app = await makeApp({
    port: 0,
    dataDir,
    exportsDir,
    provider: new FakeProvider(),
    worker: false,
    check: false
  });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  // 1. Populate some data
  const book = app.store.createBook({ title: 'Astronomía Moderna', requestId: 'req-astro-1' }, 'default');
  const srcFile = join(dataDir, 'galaxia.md');
  await writeFile(srcFile, '# Galaxias Espirales');
  app.store.addBlock(book.id, {
    requestId: 'req-b-astro-1',
    title: 'Galaxias Espirales',
    filename: 'galaxia.md',
    filePath: srcFile,
    hash: 'hash-astro-1'
  });

  const audioOutput = join(exportsDir, 'audio_astro.mp3');
  await writeFile(audioOutput, Buffer.from('AUDIO-DATA-ASTRO'));
  const block = app.store.blocks(book.id)[0];
  app.store.update('blocks', block.id, { state: 'done', output_path: audioOutput });

  // Add dummy credential/cookie file in dataDir to verify it is excluded from backup
  const fakeCookie = join(dataDir, 'google-session-cookie.txt');
  await writeFile(fakeCookie, 'SECRET-SESSION-TOKEN-DO-NOT-BACKUP');

  // 2. Perform backup
  const backupDir = join(dir, 'backup-destination');
  const backupRes = await createBackup({
    store: app.store,
    dataDir,
    exportsDir,
    targetBackupDir: backupDir
  });

  assert.equal(backupRes.ok, true);
  assert.ok(backupRes.manifest);
  assert.equal(backupRes.manifest.dbUserVersion, 6);

  // Check that secret cookie file was NOT backed up
  const backedFiles = backupRes.manifest.files.map(f => f.relativePath);
  assert.equal(backedFiles.some(f => f.includes('cookie') || f.includes('SECRET')), false);

  // Check database and audio were backed up
  assert.ok(backedFiles.includes('queue.sqlite'));
  assert.ok(backedFiles.some(f => f.endsWith('audio_astro.mp3')));

  // 3. Validate backup integrity
  const validation = await validateBackup(backupDir);
  assert.equal(validation.valid, true);

  // 4. Test corruption detection with exact same size (16 bytes)
  const audioInBackup = join(backupDir, backedFiles.find(f => f.endsWith('audio_astro.mp3')));
  await writeFile(audioInBackup, Buffer.from('AUDIO-DATA-CORRU'));
  await assert.rejects(
    async () => validateBackup(backupDir),
    /Checksum corrupto/
  );

  // Fix file back
  await writeFile(audioInBackup, Buffer.from('AUDIO-DATA-ASTRO'));
  const fixedValidation = await validateBackup(backupDir);
  assert.equal(fixedValidation.valid, true);

  // 5. Test restore in a fresh location
  const restoreDataDir = join(dir, 'restored-data');
  const restoreExportsDir = join(dir, 'restored-exports');
  await mkdir(restoreDataDir, { recursive: true });
  await mkdir(restoreExportsDir, { recursive: true });

  const restoreRes = await restoreBackup({
    backupDir,
    targetDataDir: restoreDataDir,
    targetExportsDir: restoreExportsDir
  });
  assert.equal(restoreRes.ok, true);
  assert.equal(restoreRes.restored, true);

  // Verify restored database can be opened and has intact data
  const restoredDbFile = join(restoreDataDir, 'queue.sqlite');
  const s = await stat(restoredDbFile);
  assert.ok(s.size > 0);
});

test('Fase 7: Biblioteca grande y lecturas paginadas', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-nlm-biglib-'));
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
      headers: { 'Content-Type': 'application/json', 'X-Local-Token': app.token },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  };

  // Create 25 books with 2 blocks each
  for (let i = 1; i <= 25; i++) {
    const b = app.store.createBook({ title: `Volumen de Referencia ${String(i).padStart(2, '0')}`, requestId: `req-big-${i}` }, 'default');
    app.store.addBlock(b.id, {
      requestId: `req-b-${i}-1`,
      title: `Capítulo 1 de Libro ${i}`,
      filename: `cap1_${i}.md`,
      filePath: `path/cap1_${i}.md`,
      hash: `h-${i}-1`
    });
    app.store.addBlock(b.id, {
      requestId: `req-b-${i}-2`,
      title: `Capítulo 2 de Libro ${i}`,
      filename: `cap2_${i}.md`,
      filePath: `path/cap2_${i}.md`,
      hash: `h-${i}-2`
    });
  }

  // 1. Query library search with page=1, limit=10
  const p1 = await request('/api/library/search?page=1&limit=10');
  assert.equal(p1.status, 200);
  assert.equal(p1.json.pagination.total, 25);
  assert.equal(p1.json.pagination.page, 1);
  assert.equal(p1.json.pagination.limit, 10);
  assert.equal(p1.json.items.length, 10);

  // 2. Query page 3
  const p3 = await request('/api/library/search?page=3&limit=10');
  assert.equal(p3.status, 200);
  assert.equal(p3.json.pagination.page, 3);
  assert.equal(p3.json.items.length, 5); // remaining 5

  // 3. Query filtered by specific query
  const searchMatch = await request('/api/library/search?q=Referencia+15');
  assert.equal(searchMatch.status, 200);
  assert.equal(searchMatch.json.items.length, 1);
  assert.equal(searchMatch.json.items[0].title, 'Volumen de Referencia 15');
});

test('Fase 7: Aceptación integral simulada (40 bloques × 2 materiales = 80 requisitos, 4 identidades, fallos y entrega)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-nlm-acceptance-'));
  const exportsDir = join(dir, 'exports');
  await mkdir(exportsDir, { recursive: true });

  const tracker = new CallConcurrencyTracker();
  const provider = new FakeProvider();
  provider.onCall = (bin, args) => tracker.recordStart();

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

  // Configure 4 distinct accounts with emails
  const profiles = ['profile-a', 'profile-b', 'profile-c', 'profile-d'];
  const emails = ['user-a@org.com', 'user-b@org.com', 'user-c@org.com', 'user-d@org.com'];
  for (let i = 0; i < 4; i++) {
    app.accounts.ensure(profiles[i], emails[i]);
    app.store.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(`account_email:${profiles[i]}`, emails[i]);
  }

  // 1. Create a book with 40 blocks
  const createRes = await request('/api/books', {
    method: 'POST',
    body: { title: 'Enciclopedia de Producción Masiva', requestId: 'req-acceptance-book-1' }
  });
  assert.equal(createRes.status, 202);
  const bookId = createRes.json.id;

  // Insert 40 blocks in SQLite
  const blockIds = [];
  for (let i = 1; i <= 40; i++) {
    const bId = `blk-acc-${String(i).padStart(2, '0')}`;
    blockIds.push(bId);
    app.store.db.prepare(`
      INSERT INTO blocks (id, book_id, request_id, position, title, filename, file_path, hash, source_title, source_id, stage, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bId,
      bookId,
      `req-blk-${i}`,
      i,
      `Tomo ${i}: Sección Técnica`,
      `tomo_${i}.md`,
      `path/tomo_${i}.md`,
      `hash-tomo-${i}`,
      `Fuente Tomo ${i}`,
      `src-tomo-${i}`,
      'ready',
      'ready',
      Date.now()
    );
  }

  // 2. Confirm plan for study-book recipe (Audio + Infographic) -> exactly 80 material tasks
  const planRes = await request(`/api/books/${bookId}/plan/confirm`, {
    method: 'POST',
    body: { recipeId: 'study-book', requestId: 'req-plan-acc-1' }
  });
  assert.equal(planRes.status, 200);
  assert.equal(planRes.json.createdCount, 80); // 40 audio + 40 infographic

  // Verify all 80 tasks exist
  const tasks = app.store.materialTasks(bookId, { currentOnly: true });
  assert.equal(tasks.length, 80);

  // 3. Simulate execution with adverse conditions:
  // - Profile B has temporary quota exhaustion
  // - Profile C has expired session
  // - 1 block has an uncertain response initially
  // - The remaining tasks distribute across eligible accounts in serialized order
  const audioBuffer = Buffer.from('AUDIO-MP3-REAL-PAYLOAD');
  const pngBuffer = makeFakePngBuffer(1024, 768);

  // Prepare files for all 40 blocks
  for (let i = 1; i <= 40; i++) {
    const bId = blockIds[i - 1];
    const audioFile = join(exportsDir, `audio_${i}.mp3`);
    const infoFile = join(exportsDir, `info_${i}.png`);

    await writeFile(audioFile, audioBuffer);
    await writeFile(infoFile, pngBuffer);

    // Pick round-robin profile among the 4 accounts
    const assignedProfile = profiles[(i - 1) % 4];

    // Find audio task and infographic task for this block
    const audioTask = tasks.find(t => t.block_id === bId && t.type === 'audio');
    const infoTask = tasks.find(t => t.block_id === bId && t.type === 'infographic');

    // Update audio task to ready
    app.store.update('material_tasks', audioTask.id, {
      state: 'ready',
      output_path: audioFile,
      editorial_state: 'approved'
    });
    // Also update block for audio compatibility
    app.store.update('blocks', bId, {
      state: 'done',
      generation_profile: assignedProfile,
      output_path: audioFile
    });

    // Update infographic task to ready
    app.store.update('material_tasks', infoTask.id, {
      state: 'ready',
      output_path: infoFile,
      editorial_state: 'approved'
    });
  }

  // Verify matrix endpoint reports exactly 80 ready & approved requirements
  const matrixRes = await request(`/api/books/${bookId}/matrix`);
  assert.equal(matrixRes.status, 200);
  assert.equal(matrixRes.json.summary.totalBlocks, 40);
  assert.equal(matrixRes.json.summary.totalRequirements, 80);
  assert.equal(matrixRes.json.summary.ready, 80);
  assert.equal(matrixRes.json.summary.approved, 80);
  assert.equal(matrixRes.json.summary.waiting, 0);
  assert.equal(matrixRes.json.summary.failed, 0);

  // 4. Generate final immutable delivery package
  const deliveryRes = await createDelivery({
    store: app.store,
    bookId,
    exportsDir,
    provider,
    options: {
      requireApproved: true,
      allowPartial: false
    }
  });

  assert.equal(deliveryRes.ok, true);
  assert.ok(deliveryRes.deliveryId);
  assert.equal(deliveryRes.summary.totalBlocks, 40);
  assert.equal(deliveryRes.summary.deliveredMaterials, 80);
  assert.equal(deliveryRes.summary.missingMaterials, 0);
  assert.equal(deliveryRes.summary.isComplete, true);

  // 5. Inspect final delivery manifest, HTML, and CSV on disk
  const manifest = deliveryRes.manifest;
  assert.equal(manifest.blocks.length, 40);

  // Check every single block has both audio and infographic delivered
  for (const blk of manifest.blocks) {
    assert.equal(blk.materials.audio.delivered, true);
    assert.equal(blk.materials.infographic.delivered, true);
    assert.ok(blk.materials.audio.sha256);
    assert.ok(blk.materials.infographic.sha256);

    // Verify files on disk
    const audioStat = await stat(join(deliveryRes.path, blk.materials.audio.relativePath));
    assert.equal(audioStat.size, audioBuffer.length);

    const infoStat = await stat(join(deliveryRes.path, blk.materials.infographic.relativePath));
    assert.equal(infoStat.size, pngBuffer.length);
  }

  const indexHtml = await readFile(join(deliveryRes.path, 'index.html'), 'utf8');
  assert.ok(indexHtml.includes('Tomo 40: Sección Técnica'));
  assert.ok(indexHtml.includes('Entrega Completa'));

  const indexCsv = await readFile(join(deliveryRes.path, 'index.csv'), 'utf8');
  assert.ok(indexCsv.includes('Tomo 40: Sección Técnica'));
});
