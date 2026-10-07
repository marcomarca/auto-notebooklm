import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../server.mjs';
import { FakeProvider } from './helpers.mjs';

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-num-'));
  const exportsDir = join(dir, 'exports');
  const provider = new FakeProvider();
  const app = await makeApp({ dataDir: dir, exportsDir, provider, port: 0, worker: false, check: false });
  const auth = { headers: { 'X-Local-Token': app.token } };
  return { dir, exportsDir, app, auth, provider };
}

test('numeración: activada por defecto y genera prefijo 001 - Título.mp3', async t => {
  const { dir, exportsDir, app, auth } = await setup();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  const res = await fetch(`${app.origin}/api/books`, { method: 'POST', ...auth, headers: { ...auth.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Libro Uno', requestId: 'req-1' }) });
  assert.equal(res.status, 202);
  const { id } = await res.json();
  const book = app.store.book(id);
  assert.equal(book.numbering, 1);

  const b1 = app.store.addBlock(id, { requestId: 'b-1', title: 'Capítulo Inicial', filename: '01.md', filePath: join(dir, '01.md'), hash: 'h1' });
  const resolved = app.store.resolveBlockOutputPaths(book, [b1], exportsDir);
  assert.equal(resolved.get(b1.id).outputName, '001 - Capítulo Inicial.mp3');
});

test('numeración: desactivar renombra archivos ya descargados en disco y actualiza base de datos', async t => {
  const { dir, exportsDir, app, auth } = await setup();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  const res = await fetch(`${app.origin}/api/books`, { method: 'POST', ...auth, headers: { ...auth.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Novela Histórica', requestId: 'req-2' }) });
  const { id: bookId } = await res.json();

  const b1 = app.store.addBlock(bookId, { requestId: 'b-1', title: 'Introducción', filename: '01.md', filePath: join(dir, '01.md'), hash: 'h1' });
  const b2 = app.store.addBlock(bookId, { requestId: 'b-2', title: 'Capítulo Primero', filename: '02.md', filePath: join(dir, '02.md'), hash: 'h2' });

  // Simulate downloaded MP3 files
  app.store.updateBlockOutputPaths(bookId, exportsDir, { renameFiles: false });
  const block1 = app.store.block(b1.id);
  const block2 = app.store.block(b2.id);
  assert.match(block1.output_path, /001 - Introducción\.mp3$/);
  assert.match(block2.output_path, /002 - Capítulo Primero\.mp3$/);

  await import('node:fs/promises').then(fs => fs.mkdir(join(exportsDir, app.store.book(bookId).title + '-' + bookId.slice(0, 8)), { recursive: true }));
  const { dirname } = await import('node:path');
  await import('node:fs/promises').then(fs => fs.mkdir(dirname(block1.output_path), { recursive: true }));
  await writeFile(block1.output_path, 'audio-content-1');
  await writeFile(block2.output_path, 'audio-content-2');
  app.store.update('blocks', b1.id, { state: 'done' });
  app.store.update('blocks', b2.id, { state: 'done' });

  // Toggle numbering OFF
  const patchRes = await fetch(`${app.origin}/api/books/${bookId}/numbering`, { method: 'PATCH', ...auth, headers: { ...auth.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ numbering: false }) });
  assert.equal(patchRes.status, 200);
  const patchData = await patchRes.json();
  assert.equal(patchData.numbering, false);

  const updated1 = app.store.block(b1.id);
  const updated2 = app.store.block(b2.id);
  assert.match(updated1.output_path, /Introducción\.mp3$/);
  assert.match(updated2.output_path, /Capítulo Primero\.mp3$/);
  assert.ok(!updated1.output_path.includes('001 - '));
  assert.ok(!updated2.output_path.includes('002 - '));

  // Verify disk files were renamed
  assert.ok(!existsSync(block1.output_path));
  assert.ok(!existsSync(block2.output_path));
  assert.ok(existsSync(updated1.output_path));
  assert.ok(existsSync(updated2.output_path));
  assert.equal((await readFile(updated1.output_path, 'utf8')), 'audio-content-1');
  assert.equal((await readFile(updated2.output_path, 'utf8')), 'audio-content-2');

  // Toggle numbering back ON
  const onRes = await fetch(`${app.origin}/api/books/${bookId}/numbering`, { method: 'PATCH', ...auth, headers: { ...auth.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ numbering: true }) });
  assert.equal(onRes.status, 200);

  const restored1 = app.store.block(b1.id);
  const restored2 = app.store.block(b2.id);
  assert.match(restored1.output_path, /001 - Introducción\.mp3$/);
  assert.match(restored2.output_path, /002 - Capítulo Primero\.mp3$/);
  assert.ok(existsSync(restored1.output_path));
  assert.ok(existsSync(restored2.output_path));
  assert.equal((await readFile(restored1.output_path, 'utf8')), 'audio-content-1');
});

test('numeración: colisión de títulos duplicados sin numeración resuelve con sufijos únicos', async t => {
  const { dir, exportsDir, app, auth } = await setup();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  const res = await fetch(`${app.origin}/api/books`, { method: 'POST', ...auth, headers: { ...auth.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Libro Duplicados', requestId: 'req-dup' }) });
  const { id: bookId } = await res.json();

  const b1 = app.store.addBlock(bookId, { requestId: 'b-1', title: 'Capítulo 1', filename: '01.md', filePath: join(dir, '01.md'), hash: 'h1' });
  const b2 = app.store.addBlock(bookId, { requestId: 'b-2', title: 'Capítulo 1', filename: '02.md', filePath: join(dir, '02.md'), hash: 'h2' });
  const b3 = app.store.addBlock(bookId, { requestId: 'b-3', title: 'Capítulo 1', filename: '03.md', filePath: join(dir, '03.md'), hash: 'h3' });

  // Toggle numbering OFF
  await fetch(`${app.origin}/api/books/${bookId}/numbering`, { method: 'PATCH', ...auth, headers: { ...auth.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ numbering: false }) });

  const blocks = app.store.blocks(bookId);
  const names = blocks.map(b => b.output_path.split(/[\\/]/).at(-1));
  assert.deepEqual(names, ['Capítulo 1.mp3', 'Capítulo 1 (2).mp3', 'Capítulo 1 (3).mp3']);
});

test('numeración: reordenar o cambiar título renombra archivos en disco', async t => {
  const { dir, exportsDir, app, auth } = await setup();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  const res = await fetch(`${app.origin}/api/books`, { method: 'POST', ...auth, headers: { ...auth.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Libro Reorder', requestId: 'req-reorder' }) });
  const { id: bookId } = await res.json();

  const b1 = app.store.addBlock(bookId, { requestId: 'b-1', title: 'Tema A', filename: '01.md', filePath: join(dir, '01.md'), hash: 'h1' });
  const b2 = app.store.addBlock(bookId, { requestId: 'b-2', title: 'Tema B', filename: '02.md', filePath: join(dir, '02.md'), hash: 'h2' });

  app.store.updateBlockOutputPaths(bookId, exportsDir, { renameFiles: false });
  const path1 = app.store.block(b1.id).output_path;
  const path2 = app.store.block(b2.id).output_path;
  const { dirname } = await import('node:path');
  await import('node:fs/promises').then(fs => fs.mkdir(dirname(path1), { recursive: true }));
  await writeFile(path1, 'content-A');
  await writeFile(path2, 'content-B');

  // Reorder blocks
  const reorderRes = await fetch(`${app.origin}/api/books/${bookId}/order`, { method: 'PATCH', ...auth, headers: { ...auth.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [b2.id, b1.id] }) });
  assert.equal(reorderRes.status, 200);

  const newB2 = app.store.block(b2.id);
  const newB1 = app.store.block(b1.id);
  assert.match(newB2.output_path, /001 - Tema B\.mp3$/);
  assert.match(newB1.output_path, /002 - Tema A\.mp3$/);
  assert.ok(existsSync(newB2.output_path));
  assert.ok(existsSync(newB1.output_path));
  assert.equal(await readFile(newB2.output_path, 'utf8'), 'content-B');
  assert.equal(await readFile(newB1.output_path, 'utf8'), 'content-A');

  // Rename block title
  const renameTitleRes = await fetch(`${app.origin}/api/blocks/${b2.id}`, { method: 'PATCH', ...auth, headers: { ...auth.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Tema Bravo' }) });
  assert.equal(renameTitleRes.status, 200);

  const finalB2 = app.store.block(b2.id);
  assert.match(finalB2.output_path, /001 - Tema Bravo\.mp3$/);
  assert.ok(existsSync(finalB2.output_path));
  assert.equal(await readFile(finalB2.output_path, 'utf8'), 'content-B');
});
