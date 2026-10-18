import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../server.mjs';
import { FakeProvider } from './helpers.mjs';

class OtherTypesProvider extends FakeProvider {
  constructor(profile = 'default') {
    super();
    this.profile = profile;
  }
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-other-types-'));
  const provider = new OtherTypesProvider('default');
  const app = await makeApp({
    dataDir: dir,
    exportsDir: join(dir, 'exports'),
    provider,
    accountFactory: id => new OtherTypesProvider(id),
    port: 0,
    worker: false,
    check: false
  });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = (path, method = 'GET', data, headers = {}) => fetch(app.origin + path, {
    method,
    headers: {
      'X-Local-Token': app.token,
      ...(data ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: data ? JSON.stringify(data) : undefined
  });
  const book = app.store.createBook({ title: 'Libro de prueba D7', requestId: 'req-d7' }, 'default');
  app.store.update('books', book.id, { remote_id: 'nb-d7' });
  return { app, provider, call, store: app.store, queue: app.queue, book, dir };
}

test('D7: descarga de vídeo (MP4), informe (MD) y diapositivas sin conversión FFmpeg MP3', async t => {
  const f = await fixture(t);

  // Insert catalog items for various types
  f.store.upsertRemoteItem({
    bookId: f.book.id,
    kind: 'artifact',
    remoteId: 'art-video-1',
    type: 'video',
    title: 'Vídeo explicativo',
    status: 'completed'
  });
  f.store.upsertRemoteItem({
    bookId: f.book.id,
    kind: 'artifact',
    remoteId: 'art-report-1',
    type: 'report',
    title: 'Informe de síntesis',
    status: 'completed'
  });
  f.store.upsertRemoteItem({
    bookId: f.book.id,
    kind: 'artifact',
    remoteId: 'art-slides-1',
    type: 'slide_deck',
    title: 'Presentación ejecutiva',
    status: 'completed'
  });
  f.store.upsertRemoteItem({
    bookId: f.book.id,
    kind: 'artifact',
    remoteId: 'art-unknown-1',
    type: 'hologram_future',
    title: 'Elemento desconocido',
    status: 'completed'
  });

  // Verify unknown item is visible in catalog
  const catalog = f.store.remoteItems(f.book.id);
  assert.equal(catalog.some(i => i.type === 'hologram_future'), true);

  // Request downloads for video, report, slides, and unknown item
  const res = await f.call(`/api/books/${f.book.id}/downloads`, 'POST', {
    items: [
      { itemId: 'art-video-1' },
      { itemId: 'art-report-1' },
      { itemId: 'art-slides-1', format: 'pdf' },
      { itemId: 'art-unknown-1' }
    ]
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.accepted.length, 3);
  assert.equal(data.rejected.length, 1);
  assert.equal(data.rejected[0].id, 'art-unknown-1');
  assert.match(data.rejected[0].reason, /Tipo de contenido sin adaptador de descarga conocido/);

  // Process the queue for the 3 download jobs
  await f.queue.tick(); // Video
  await f.queue.tick(); // Report
  await f.queue.tick(); // Slides

  // Verify adapter calls were made
  const downloadVideoCalls = f.provider.calls.filter(c => c[0] === 'downloadVideo');
  const downloadReportCalls = f.provider.calls.filter(c => c[0] === 'downloadReport');
  const downloadSlidesCalls = f.provider.calls.filter(c => c[0] === 'downloadSlideDeck');
  const convertCalls = f.provider.calls.filter(c => c[0] === 'convert');

  assert.equal(downloadVideoCalls.length, 1, 'Debe haber llamado a downloadVideo');
  assert.equal(downloadReportCalls.length, 1, 'Debe haber llamado a downloadReport');
  assert.equal(downloadSlidesCalls.length, 1, 'Debe haber llamado a downloadSlideDeck');
  assert.equal(convertCalls.length, 0, 'CERO llamadas a convert/FFmpeg MP3 para documentos y video');

  // Verify jobs in download_jobs table are done
  const jobs = f.store.downloadJobs(f.book.id);
  assert.equal(jobs.length, 3);
  assert.equal(jobs.every(j => j.state === 'done'), true);

  // Check GET /api/downloads endpoint
  const dlRes = await f.call(`/api/downloads?bookId=${f.book.id}`, 'GET');
  assert.equal(dlRes.status, 200);
  const dlList = await dlRes.json();
  assert.equal(dlList.length, 3);
  const videoDl = dlList.find(d => d.type === 'video');
  assert.equal(videoDl.state, 'done');
  assert.match(videoDl.outputPath, /\.mp4$/);

  // Test GET /api/downloads/:id/file serving video with MIME type and Range support
  const fileRes = await f.call(`/api/downloads/${videoDl.id}/file`, 'GET');
  assert.equal(fileRes.status, 200);
  assert.equal(fileRes.headers.get('Content-Type'), 'video/mp4');

  // Test Range request
  const rangeRes = await f.call(`/api/downloads/${videoDl.id}/file`, 'GET', null, { 'Range': 'bytes=0-10' });
  assert.equal(rangeRes.status, 206);
  assert.equal(rangeRes.headers.get('Content-Range'), 'bytes 0-10/256');

  // Test Report download serving
  const reportDl = dlList.find(d => d.type === 'report');
  const repRes = await f.call(`/api/downloads/${reportDl.id}/file`, 'GET');
  assert.equal(repRes.status, 200);
  assert.match(repRes.headers.get('Content-Type'), /text\/markdown/);
  const repContent = await repRes.text();
  assert.equal(repContent, '# Report\nContent');
});

test('D7: cancelación de un trabajo de descarga no-audio', async t => {
  const f = await fixture(t);

  f.store.upsertRemoteItem({
    bookId: f.book.id,
    kind: 'artifact',
    remoteId: 'art-infog-1',
    type: 'infographic',
    title: 'Infografía',
    status: 'completed'
  });

  const res = await f.call(`/api/books/${f.book.id}/downloads`, 'POST', {
    items: ['art-infog-1']
  });
  const data = await res.json();
  assert.equal(data.accepted.length, 1);
  const jobId = data.accepted[0].jobId;

  // Cancel before processing
  const cancelRes = await f.call(`/api/downloads/${jobId}/cancel`, 'POST');
  assert.equal(cancelRes.status, 200);
  const cancelData = await cancelRes.json();
  assert.equal(cancelData.ok, true);
  assert.equal(cancelData.job.state, 'canceled');

  // Process queue - canceled job should not run
  await f.queue.tick();
  assert.equal(f.provider.calls.filter(c => c[0] === 'downloadInfographic').length, 0);
  const checkJob = f.store.downloadJob(jobId);
  assert.equal(checkJob.state, 'canceled');
});
