import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Provider, ProviderError, CommandRunner, classify } from '../provider.mjs';
import { ConnectorGate } from '../connector-gate.mjs';
import { fixture, FakeProvider } from './helpers.mjs';

test('todos los adaptadores de descarga usan NLM_PROFILE y no envían -p, manteniendo la puerta serial', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-download-contract-'));
  let active = 0, peak = 0;
  const commands = [];
  const gate = new ConnectorGate();
  const runner = {
    async run(binary, args, options) {
      if (binary !== 'fake-nlm') return '';
      commands.push(args);
      assert.equal(args[0], 'download');
      assert.equal(args.includes('-p'), false);
      assert.equal(options.env.NLM_PROFILE, 'cuenta4');
      assert.equal(args[args.indexOf('--id') + 1], 'existing-id');
      active++; peak = Math.max(peak, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 5));
        const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSAAAAABJRU5ErkJggg==', 'base64');
        await writeFile(args[args.indexOf('--output') + 1], args[1] === 'infographic' ? image : Buffer.alloc(256, 1));
        return 'Downloaded';
      } finally { active--; }
    },
    async close() {}
  };
  const p = new Provider({ profile: 'cuenta4', nlm: 'fake-nlm', runner, gate });
  t.after(async () => { await p.close(); await gate.close(); await rm(dir, { recursive: true, force: true }); });
  const methods = ['download', 'downloadVideo', 'downloadReport', 'downloadSlideDeck', 'downloadInfographic', 'downloadMindMap', 'downloadQuiz', 'downloadFlashcards', 'downloadDataTable'];
  await Promise.all(methods.map(method => p[method]('book-id', 'existing-id', join(dir, method))));
  assert.equal(commands.length, 9);
  assert.equal(peak, 1);
  assert.equal(classify('No such option: -p'), 'CLI_USAGE');
});

test('proceso sin salida conserva código y señala que el resultado es incierto', async t => {
  const runner = new CommandRunner();
  t.after(() => runner.close());
  await assert.rejects(runner.run(process.execPath, ['-e', 'process.exit(7)']), error => {
    assert.match(error.message, /sin salida.*código 7/);
    assert.equal(error.exitCode, 7);
    assert.equal(error.uncertain, true);
    return true;
  });
});

test('reintenta una infografía fallida por descarga usando su ID remoto y la cuenta de la infografía', async t => {
  const f = await fixture(t);
  const block = f.add(1);
  f.store.update('books', f.book.id, { remote_id: 'remote-book', state: 'ready' });
  f.store.update('blocks', block.id, { source_id: 'src-1', state: 'done', stage: 'convert', generation_profile: 'audio-account' });
  const creator = new FakeProvider(); creator.profile = 'image-account';
  creator.remoteArtifacts.push({ artifact_id: 'existing-image', type: 'infographic', source_ids: ['src-1'], status: 'completed' });
  f.queue.accounts = { get: id => id === 'image-account' ? creator : f.provider, async close() {} };
  const task = f.store.createMaterialTask({ bookId: f.book.id, blockId: block.id, type: 'infographic', state: 'review_required', error: 'No such option: -p' });
  const attempt = f.store.createMaterialAttempt({ taskId: task.id, attemptNumber: 1, profile: 'image-account', remoteNotebookId: 'remote-book', artifactId: 'existing-image', state: 'failed' });
  f.store.updateMaterialTask(task.id, { selected_attempt_id: attempt.id });
  assert.equal(f.queue.retryMaterialTask(task.id).state, 'remote_pending');
  await f.tick(2);
  assert.equal(f.store.materialTask(task.id).state, 'ready');
  assert.ok(creator.calls.some(call => call[0] === 'downloadInfographic' && call[2] === 'existing-image'));
  assert.equal(f.provider.calls.filter(call => call[0] === 'downloadInfographic').length, 0);
  assert.equal(creator.calls.filter(call => call[0] === 'generateInfographic').length, 0);
});

test('una descarga fallida no transforma un intento aceptado en generación fallida', async t => {
  const f = await fixture(t);
  const block = f.add(1);
  f.store.update('books', f.book.id, { remote_id: 'remote-book', state: 'ready' });
  f.store.update('blocks', block.id, { source_id: 'src-1', state: 'done', stage: 'convert' });
  const task = f.store.createMaterialTask({ bookId: f.book.id, blockId: block.id, type: 'infographic', state: 'download_pending' });
  const attempt = f.store.createMaterialAttempt({ taskId: task.id, attemptNumber: 1, profile: 'default', artifactId: 'existing-image', state: 'accepted' });
  f.store.updateMaterialTask(task.id, { selected_attempt_id: attempt.id });
  f.provider.behavior.downloadInfographic = new ProviderError('CLI_USAGE', 'No such option: -p');
  await f.tick(1);
  const failed = f.store.materialTask(task.id);
  assert.equal(failed.state, 'review_required');
  assert.match(failed.error, /Descarga del resultado existente/);
  assert.equal(f.store.materialAttempts(task.id)[0].state, 'accepted');
  delete f.provider.behavior.downloadInfographic;
  f.provider.remoteArtifacts.push({ artifact_id: 'existing-image', type: 'infographic', source_ids: ['src-1'], status: 'completed' });
  f.queue.retryMaterialTask(task.id);
  await f.tick(2);
  assert.equal(f.store.materialTask(task.id).state, 'ready');
  assert.equal(f.provider.calls.filter(call => call[0] === 'generateInfographic').length, 0);
});

test('respuesta perdida al crear se reconcilia y descarga sin una segunda generación', async t => {
  const f = await fixture(t);
  const block = f.add(1);
  f.store.update('books', f.book.id, { remote_id: 'remote-book', state: 'ready', running: 1 });
  f.store.update('blocks', block.id, { source_id: 'src-1', state: 'done', stage: 'convert' });
  const task = f.store.createMaterialTask({ bookId: f.book.id, blockId: block.id, type: 'infographic', state: 'queued' });
  f.provider.behavior.generateInfographic = new ProviderError('PROVIDER', 'El proveedor terminó sin respuesta.');
  await f.tick(1);
  const uncertain = f.store.materialTask(task.id);
  assert.equal(uncertain.state, 'remote_pending');
  assert.equal(f.store.materialAttempts(task.id)[0].state, 'uncertain');
  assert.match(uncertain.error, /Envío incierto/);
  delete f.provider.behavior.generateInfographic;
  await f.tick(2);
  assert.equal(f.store.materialTask(task.id).state, 'ready');
  assert.equal(f.provider.calls.filter(call => call[0] === 'generateInfographic').length, 1);
});

test('fallo de consulta conserva el ID aceptado y retoma el sondeo, no la generación', async t => {
  const f = await fixture(t);
  const block = f.add(1);
  f.store.update('books', f.book.id, { remote_id: 'remote-book', state: 'ready' });
  f.store.update('blocks', block.id, { source_id: 'src-1', state: 'done', stage: 'convert' });
  const task = f.store.createMaterialTask({ bookId: f.book.id, blockId: block.id, type: 'infographic', state: 'remote_pending' });
  const attempt = f.store.createMaterialAttempt({ taskId: task.id, attemptNumber: 1, profile: 'default', artifactId: 'known-image', state: 'accepted' });
  f.store.updateMaterialTask(task.id, { selected_attempt_id: attempt.id });
  const originalArtifacts = f.provider.artifacts.bind(f.provider);
  let first = true;
  f.provider.artifacts = (...args) => {
    if (first) { first = false; throw new ProviderError('PROVIDER', 'El conector terminó sin salida (código 1).', true); }
    return originalArtifacts(...args);
  };
  f.provider.remoteArtifacts.push({ artifact_id: 'known-image', type: 'infographic', source_ids: ['src-1'], status: 'completed' });
  await f.tick(1);
  assert.equal(f.store.materialTask(task.id).state, 'remote_pending');
  assert.match(f.store.materialTask(task.id).error, /Consulta del resultado existente/);
  assert.equal(f.store.materialAttempts(task.id)[0].state, 'accepted');
  await f.tick(2);
  assert.equal(f.store.materialTask(task.id).state, 'ready');
  assert.equal(f.provider.calls.filter(call => call[0] === 'generateInfographic').length, 0);
});

test('un ID local de catálogo se traduce al ID remoto y reintentar no revive cancelaciones', async t => {
  const f = await fixture(t);
  const block = f.add(1);
  f.store.update('books', f.book.id, { remote_id: 'remote-book', state: 'ready' });
  f.store.update('blocks', block.id, { source_id: 'src-1', state: 'done', stage: 'convert' });
  const item = f.store.upsertRemoteItem({ bookId: f.book.id, kind: 'artifact', remoteId: 'remote-image', type: 'infographic', title: 'Infografía', status: 'completed' });
  const task = f.store.createMaterialTask({ bookId: f.book.id, blockId: block.id, type: 'infographic', state: 'failed', selectedRemoteItemId: item.id });
  f.provider.remoteArtifacts.push({ artifact_id: 'remote-image', type: 'infographic', source_ids: ['src-1'], status: 'completed' });
  f.queue.retryMaterialTask(task.id);
  await f.tick(2);
  assert.equal(f.store.materialTask(task.id).state, 'ready');
  assert.ok(f.provider.calls.some(call => call[0] === 'downloadInfographic' && call[2] === 'remote-image'));
  const canceled = f.store.createMaterialRevision(task.id);
  f.queue.cancelMaterialTask(canceled.id);
  assert.equal(f.queue.retryMaterialTask(canceled.id).state, 'canceled');
});

test('reconciliación exige una fuente exacta y termina en revisión si nunca identifica el resultado', async t => {
  const f = await fixture(t);
  const block = f.add(1);
  f.store.update('books', f.book.id, { remote_id: 'remote-book', state: 'ready' });
  f.store.update('blocks', block.id, { source_id: 'src-1', state: 'done', stage: 'convert' });
  const task = f.store.createMaterialTask({ bookId: f.book.id, blockId: block.id, type: 'infographic', state: 'failed' });
  const attempt = f.store.createMaterialAttempt({ taskId: task.id, attemptNumber: 1, profile: 'default', baseline: [], state: 'failed' });
  f.store.updateMaterialTask(task.id, { selected_attempt_id: attempt.id });
  f.provider.remoteArtifacts.push({ artifact_id: 'wrong-multi-source', type: 'infographic', source_ids: ['src-1', 'src-2'], status: 'completed' });
  f.queue.retryMaterialTask(task.id);
  await f.tick(9);
  assert.equal(f.store.materialTask(task.id).state, 'review_required');
  assert.equal(f.provider.calls.filter(call => call[0] === 'generateInfographic').length, 0);
  assert.equal(f.provider.calls.filter(call => call[0] === 'downloadInfographic').length, 0);
});
