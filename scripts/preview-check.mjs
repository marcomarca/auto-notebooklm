// Disposable UI fixture: no NotebookLM calls. Stops automatically after three minutes.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../server.mjs';
import { FakeProvider } from '../tests/helpers.mjs';
const dir = await mkdtemp(join(tmpdir(), 'nlm-preview-'));
const provider = new FakeProvider();
provider.remoteNotebooks = [
  { id: 'preview-notebook', title: 'Historia de la ciencia', modified_time: new Date().toISOString() },
  { id: 'preview-nb-2', title: 'Inteligencia Artificial y Sociedad', modified_time: new Date().toISOString() }
];
provider.remoteSources = [
  { id: 'src-1', title: '01 - Los primeros observadores.md', status: 2 },
  { id: 'src-2', title: '02 - La revolución del telescopio.md', status: 2 }
];
provider.remoteArtifacts = [
  { artifact_id: 'art-preview-1', type: 'audio', title: '01 - Los primeros observadores', status: 'completed', source_ids: ['src-1'] },
  { artifact_id: 'art-preview-2', type: 'audio', title: '02 - La revolución del telescopio', status: 'completed', source_ids: ['src-2'] }
];
const app = await makeApp({ dataDir: dir, exportsDir: join(dir, 'exports'), provider, port: 4318, worker: false, check: false });
app.accounts.ensure('default', 'autor@example.com');
app.accounts.ensure('cuenta2', 'respaldo1@example.com');
app.accounts.enable('cuenta2', true);
app.accounts.ensure('cuenta3', 'respaldo2@example.com');
const book = app.store.createBook({ title: 'Historia de la ciencia', requestId: 'preview-book' }, 'default');
app.store.db.prepare('INSERT INTO book_accounts(book_id,profile) VALUES(?,?)').run(book.id, 'cuenta2');
app.store.update('books', book.id, { state: 'ready', remote_id: 'preview-notebook', running: 1, quota_at: Date.now() + 3600000, quota_error: 'Cuota agotada. Los bloques pendientes se conservan.' });
for (let n = 1; n <= 25; n++) {
  const name = ['Los primeros observadores', 'La revolución del telescopio', 'Newton y las leyes del movimiento', 'El descubrimiento de la electricidad'][n - 1] || `Capítulo ${n}`;
  const b = app.store.addBlock(book.id, { requestId: `preview-${n}`, title: name, filename: `${String(n).padStart(2, '0')} - ${name}.md`, filePath: join(dir, `sample-${n}.md`), hash: `preview-${n}` });
  app.store.update('blocks', b.id, { stage: n < 3 ? 'convert' : 'generate', state: n < 3 ? 'done' : n === 3 ? 'quota' : 'ready', source_id: `preview-source-${n}`, locked: n < 4 ? 1 : 0,
    generation_profile: n === 1 ? 'default' : n === 2 ? 'cuenta2' : null,
    ...(n === 3 ? { next_at: Date.now() + 3600000 } : {}) });
}
console.log(`PREVIEW ${app.origin} (25 bloques simulados; cierre automático en 180 segundos)`);
let closed = false;
async function close() { if (closed) return; closed = true; clearTimeout(timer); await app.close(); await rm(dir, { recursive: true, force: true }); }
const timer = setTimeout(close, 180000);
process.once('SIGINT', close); process.once('SIGTERM', close);
