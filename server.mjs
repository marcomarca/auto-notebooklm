import { createServer } from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { join, dirname, extname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, title, safeName, exportDirName } from './store.mjs';
import { Provider, redact } from './provider.mjs';
import { ConnectorGate } from './connector-gate.mjs';
import { Queue } from './queue.mjs';
import { Accounts, profileId } from './accounts.mjs';
import { syncNotebook } from './sync.mjs';
import { validateRecipe, previewProductionPlan, confirmProductionPlan, startProduction } from './production.mjs';
import { createDelivery, listDeliveries, getDelivery } from './delivery.mjs';
import { createBackup, validateBackup, restoreBackup } from './backup.mjs';
import { version as appVersion, mode, dataDir as defaultDataDir, exportsDir as defaultExportsDir } from './runtime.mjs';

export function openInExplorer(targetPath) {
  const dir = resolve(targetPath);
  try {
    if (process.platform === 'win32') {
      spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {}
  return dir;
}

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, 'public');
const maxFile = 200 * 1024 * 1024;
const natural = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

const SUPPORTED_NON_AUDIO = {
  video: { ext: () => 'mp4', defaultFormat: 'mp4' },
  report: { ext: () => 'md', defaultFormat: 'markdown' },
  slide_deck: { ext: (f) => f === 'pptx' ? 'pptx' : 'pdf', defaultFormat: 'pdf' },
  infographic: { ext: () => 'png', defaultFormat: 'png' },
  mind_map: { ext: () => 'json', defaultFormat: 'json' },
  quiz: { ext: (f) => f === 'markdown' ? 'md' : 'json', defaultFormat: 'json' },
  flashcards: { ext: (f) => f === 'markdown' ? 'md' : 'json', defaultFormat: 'json' },
  data_table: { ext: () => 'csv', defaultFormat: 'csv' }
};

const MIME_TYPES = {
  mp4: 'video/mp4',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  txt: 'text/plain; charset=utf-8'
};

async function acquireLock(dataDir) {
  const file = join(dataDir, '.running');
  try {
    const lock = await open(file, 'wx');
    await lock.writeFile(String(process.pid)); await lock.close();
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(await readFile(file, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('El bloqueo data/.running está incompleto. Comprueba que la app está cerrada antes de retirar ese archivo.');
    try { process.kill(pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') { await rm(file); return acquireLock(dataDir); }
      throw error;
    }
    throw new Error('Ya hay una aplicación usando esta carpeta de datos. Cierra esa instancia antes de iniciar otra.');
  }
  return () => rm(file, { force: true });
}

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1024 * 1024) throw new Error('Solicitud demasiado grande.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('JSON inválido.'); }
}
function filename(value) {
  if (typeof value !== 'string' || value.length > 220 || /[/\\\x00-\x1f]/.test(value) || !['.pdf', '.md'].includes(extname(value).toLowerCase()))
    throw new Error('Selecciona un nombre de archivo Markdown (.md) o PDF (.pdf), sin rutas.');
  return value;
}
function requestId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('requestId inválido.');
  return value;
}

export async function makeApp({ dataDir = defaultDataDir, exportsDir = defaultExportsDir, gate, provider, accountFactory, port = Number(process.env.PORT || 4318), worker = true, check = true, allowHttpShutdown = true, shutdownHandler } = {}) {
  await mkdir(dataDir, { recursive: true });
  const releaseLock = await acquireLock(dataDir);
  let store;
  try { store = new Store(join(dataDir, 'queue.sqlite')); } catch (e) { await releaseLock(); throw e; }
  const connectorGate = gate || provider?.gate || new ConnectorGate();
  if (!provider) {
    provider = new Provider({ profile: process.env.NLM_PROFILE || 'default', gate: connectorGate });
  } else if (!provider.gate) {
    provider.gate = connectorGate;
  }
  const accounts = new Accounts(store, provider, { factory: accountFactory, gate: connectorGate });
  const queue = new Queue(store, provider, { dataDir, exportsDir, accounts, gate: connectorGate, shutdownHandler });
  const token = randomBytes(32).toString('hex');
  let origin, closed = false, shutdown, initialization;
  const completion = Promise.withResolvers();
  const resumeAuth = id => {
    for (const b of store.books()) {
      if (b.profile === id && b.state === 'auth') queue.retryBook(b.id);
      for (const block of store.blocks(b.id).filter(x => x.state === 'auth' && (x.generation_profile || b.profile) === id)) queue.retryBlock(block.id);
      const participates = b.profile === id || store.get('SELECT profile FROM book_accounts WHERE book_id=? AND profile=?', b.id, id);
      if (participates && b.quota_at && accounts.ensure(id).retry_at === 0) {
        store.update('books', b.id, { quota_at: 0, quota_error: null });
        for (const block of store.blocks(b.id).filter(x => x.state === 'quota')) queue.retryBlock(block.id);
      }
    }
  };
  accounts.onReady = resumeAuth;
  const healthCheck = async (id = accounts.current) => {
    await accounts.discover(); const h = await accounts.check(id);
    return h;
  };

  async function upload(req, book, url) {
    try {
      await accounts.checkWriteAccess(book);
    } catch (err) {
      req.resume();
      throw err;
    }
    const name = filename(url.searchParams.get('filename'));
    const rid = requestId(url.searchParams.get('requestId'));
    const existing = store.get('SELECT * FROM blocks WHERE book_id=? AND request_id=?', book.id, rid);
    if (existing) { req.resume(); return { id: existing.id, existing: true }; }
    if (Number(req.headers['content-length']) > maxFile) throw new Error('El archivo supera el límite local de 200 MiB.');
    const dir = join(dataDir, 'sources', book.id);
    await mkdir(dir, { recursive: true });
    const dest = join(dir, `${randomUUID()}${extname(name).toLowerCase()}`);
    const tmp = `${dest}.part`;
    let bytes = 0, prefix = Buffer.alloc(0), digest;
    const hash = createHash('sha256');
    const counter = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxFile) return callback(new Error('El archivo supera el límite local de 200 MiB.'));
      if (prefix.length < 4096) prefix = Buffer.concat([prefix, chunk]).subarray(0, 4096);
      hash.update(chunk); callback(null, chunk);
    } });
    try {
      await pipeline(req, counter, createWriteStream(tmp, { flags: 'wx' }));
      if (!bytes) throw new Error('El archivo está vacío.');
      if (extname(name).toLowerCase() === '.pdf' && !prefix.subarray(0, 1024).includes(Buffer.from('%PDF-')))
        throw new Error('El archivo no contiene una cabecera PDF válida.');
      if (extname(name).toLowerCase() === '.md') {
        const contents = await readFile(tmp);
        if (contents.includes(0)) throw new Error('Markdown contiene datos binarios.');
        try { new TextDecoder('utf-8', { fatal: true }).decode(contents); } catch { throw new Error('Guarda el Markdown con codificación UTF-8.'); }
        if (!contents.toString('utf8').trim()) throw new Error('El Markdown no contiene texto.');
      }
      digest = hash.digest('hex');
      const duplicate = store.get('SELECT id FROM blocks WHERE book_id=? AND hash=?', book.id, digest);
      if (duplicate) { await rm(tmp, { force: true }); return { id: duplicate.id, duplicate: true }; }
      await rename(tmp, dest);
      const block = store.addBlock(book.id, { requestId: rid, title: name.slice(0, -extname(name).length).slice(0, 180), filename: name, filePath: dest, hash: digest });
      const blocks = store.blocks(book.id);
      if (!blocks.some(b => b.locked)) store.reorder(book.id, blocks.sort((a, b) => natural.compare(a.filename, b.filename) || a.created_at - b.created_at).map(b => b.id));
      return { id: block.id };
    } catch (e) {
      await rm(tmp, { force: true });
      if (!store.get('SELECT id FROM blocks WHERE file_path=?', dest)) await rm(dest, { force: true });
      // Concurrent retries can finish copying together. The SQLite constraint picks one winner.
      if (String(e.message).includes('UNIQUE constraint')) {
        const winner = store.get('SELECT id FROM blocks WHERE book_id=? AND request_id=?', book.id, rid);
        if (winner) return { id: winner.id, existing: true };
        const duplicate = store.get('SELECT id FROM blocks WHERE book_id=? AND hash=?', book.id, digest);
        if (duplicate) return { id: duplicate.id, duplicate: true };
      }
      throw e;
    }
  }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (req.headers.host !== new URL(origin).host) return send(res, 403, { error: 'Host no permitido.' });
      if (req.headers.origin && req.headers.origin !== origin) return send(res, 403, { error: 'Origen no permitido.' });
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-local-token'] !== token) return send(res, 403, { error: 'Falta el token local. Consulta GET /api/health primero.' });
      const url = new URL(req.url, origin);
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'POST' && url.pathname === '/api/shutdown') {
        if (!allowHttpShutdown) return send(res, 403, { error: 'Apagado por HTTP deshabilitado en esta instancia.' });
        send(res, 200, { ok: true });
        setImmediate(async () => {
          try { await shutdown(); }
          finally { if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(0); }
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return send(res, 200, {
          ...accounts.get(accounts.current).health,
          app: 'BloqueAudio',
          appVersion,
          mode,
          token,
          busy: queue.busy,
          shutdownOnDispatch: store.getSetting('shutdown_on_dispatch', '0') === '1',
          shutdownStatus: queue.shutdownHandler ? queue.shutdownHandler.status() : null
        });
      }
      if (parts[0] === 'api' && parts[1] === 'system' && parts[2] === 'shutdown') {
        if (req.method === 'GET' && parts.length === 3) {
          const enabled = store.getSetting('shutdown_on_dispatch', '0') === '1';
          return send(res, 200, { enabled, ...queue.shutdownHandler.status() });
        }
        if (req.method === 'POST' && parts.length === 3) {
          const payload = await body(req);
          const enabled = Boolean(payload.enabled);
          store.setSetting('shutdown_on_dispatch', enabled ? '1' : '0');
          return send(res, 200, { ok: true, enabled, ...queue.shutdownHandler.status() });
        }
        if (req.method === 'POST' && parts[3] === 'cancel') {
          const status = queue.cancelShutdown();
          return send(res, 200, { ok: true, cancelled: true, enabled: false, ...status });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/health/check') {
        const h = await healthCheck();
        return send(res, 200, h);
      }
      if (req.method === 'GET' && url.pathname === '/api/accounts') return send(res, 200, accounts.snapshot());
      if (req.method === 'POST' && url.pathname === '/api/accounts') {
        const { profile } = await body(req); accounts.ensure(profileId(profile)); return send(res, 201, accounts.snapshot());
      }
      if (parts[0] === 'api' && parts[1] === 'accounts' && parts[2] && req.method === 'POST') {
        const id = profileId(parts[2]);
        if (parts[3] === 'check') return send(res, 200, await healthCheck(id));
        if (parts[3] === 'select') { accounts.select(id); accounts.enable(id, true); return send(res, 200, accounts.snapshot()); }
        if (parts[3] === 'enabled') {
          accounts.enable(id, (await body(req)).enabled);
          for (const b of store.books()) {
            store.update('books', b.id, { quota_at: 0, quota_error: null });
            for (const block of store.blocks(b.id).filter(x => x.state === 'quota')) queue.retryBlock(block.id);
          }
          return send(res, 200, accounts.snapshot());
        }
        if (parts[3] === 'login') {
          accounts.login(id); return send(res, 202, accounts.snapshot());
        }
      }
      if (parts[0] === 'api' && parts[1] === 'remote') {
        const profile = profileId(url.searchParams.get('profile') || accounts.current);
        const p = accounts.get(profile);
        if (parts[2] === 'notebooks' && parts.length === 3 && req.method === 'GET') {
          const list = await p.listBooks();
          const items = list.map(b => ({
            id: b.id || b.notebook_id,
            title: b.title || 'Sin título',
            createdAt: b.created_time || b.created_at || null,
            modifiedAt: b.modified_time || b.modified_at || null
          })).filter(b => b.id);
          return send(res, 200, items);
        }
        if (parts[2] === 'notebooks' && parts[3]) {
          const remoteId = parts[3];
          if (parts.length === 4 && req.method === 'GET') {
            const [artifacts, sources] = await Promise.all([
              p.artifacts(remoteId).catch(() => []),
              p.sources(remoteId).catch(() => [])
            ]);
            const sourceMap = new Map(sources.map(s => [s.id || s.source_id, s.title]));
            const localBook = store.get('SELECT * FROM books WHERE profile=? AND remote_id=?', profile, remoteId);
            const localBlocks = localBook ? store.blocks(localBook.id) : [];
            const blockMap = new Map(localBlocks.map(b => [b.artifact_id, b]));

            const audios = artifacts.filter(a => a.type === 'audio' || !a.type).map(a => {
              const artId = a.artifact_id || a.id;
              const local = blockMap.get(artId);
              const sIds = a.source_ids || [];
              const sourceTitle = sIds.map(id => sourceMap.get(id)).filter(Boolean).join(', ');
              return {
                id: artId,
                title: a.title || sourceTitle || 'Audio',
                status: a.status || 'completed',
                sourceIds: sIds,
                sourceTitle: sourceTitle || null,
                createdAt: a.created_at || a.created_time || null,
                errorReason: a.error_reason || null,
                localState: local?.state || null,
                localBlockId: local?.id || null,
                isDone: local?.state === 'done'
              };
            });
            return send(res, 200, {
              id: remoteId,
              title: localBook?.title || null,
              profile,
              localBookId: localBook?.id || null,
              artifacts: audios,
              sources: sources.map(s => ({ id: s.id || s.source_id, title: s.title }))
            });
          }
          if (parts[4] === 'sync' && req.method === 'POST') {
            const payload = await body(req);
            const reqProfile = profileId(payload.profile || profile);
            const result = await syncNotebook({
              store,
              accounts,
              profile: reqProfile,
              remoteId,
              requestId: payload.requestId
            });
            return send(res, 202, result);
          }
          if (parts[4] === 'import' && req.method === 'POST') {
            const payload = await body(req);
            const reqProfile = profileId(payload.profile || profile);
            const reqProvider = accounts.get(reqProfile);
            const bookTitle = title(payload.title || 'Cuaderno remoto');
            const artifactIds = Array.isArray(payload.artifactIds) ? payload.artifactIds : [];
            if (!artifactIds.length) throw new Error('Selecciona al menos un audio para descargar.');

            const book = store.importRemoteBook({ remoteId, title: bookTitle, profile: reqProfile });
            const [artifacts, sources] = await Promise.all([
              reqProvider.artifacts(remoteId).catch(() => []),
              reqProvider.sources(remoteId).catch(() => [])
            ]);
            const sourceMap = new Map(sources.map(s => [s.id || s.source_id, s.title]));
            const artMap = new Map(artifacts.map(a => [a.artifact_id || a.id, a]));

            const dir = join(exportsDir, exportDirName(book));
            await mkdir(dir, { recursive: true });
            await mkdir(join(dataDir, 'audio'), { recursive: true });

            let importedCount = 0;
            for (const artId of artifactIds) {
              const art = artMap.get(artId);
              if (!art) throw new Error(`El artefacto ${artId} no existe en este cuaderno.`);
              const sourceTitle = (art.source_ids || []).map(id => sourceMap.get(id)).filter(Boolean).join(', ');
              const artTitle = art.title || sourceTitle || 'Audio';
              const sId = art.source_ids?.[0] || null;
              const status = art.status || 'completed';

              const block = store.importRemoteBlock(book.id, {
                title: artTitle,
                artifactId: artId,
                sourceId: sId,
                profile: reqProfile,
                status,
                originalPath: join(dataDir, 'audio', `pending.m4a`),
                outputPath: null
              });
              if (!block.existing) {
                store.update('blocks', block.id, {
                  original_path: join(dataDir, 'audio', `${block.id}.m4a`)
                });
                importedCount++;
              }
            }
            store.updateBlockOutputPaths(book.id, exportsDir, { renameFiles: false });
            store.update('books', book.id, { running: 1 });
            return send(res, 200, { ok: true, bookId: book.id, imported: importedCount });
          }
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/recipes') {
        return send(res, 200, {
          ok: true,
          recipes: store.recipes().map(r => ({ ...r, config: JSON.parse(r.config_json) }))
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/recipes') {
        const { id, name, config } = await body(req);
        if (!name) return send(res, 400, { error: 'Nombre de receta requerido.' });
        validateRecipe(config);
        const created = store.createRecipe({ id, name, config });
        return send(res, 201, {
          ok: true,
          recipe: { ...created, config: JSON.parse(created.config_json) }
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/backup') {
        const payload = req.headers['content-length'] > 0 ? await body(req).catch(() => ({})) : {};
        const targetDir = payload?.targetDir || join(exportsDir, 'backups', `backup-${Date.now()}`);
        const result = await createBackup({
          store,
          dataDir,
          exportsDir,
          targetBackupDir: targetDir
        });
        return send(res, 201, result);
      }
      if (req.method === 'POST' && url.pathname === '/api/backup/validate') {
        const { backupDir } = await body(req);
        if (!backupDir) return send(res, 400, { error: 'backupDir es requerido.' });
        try {
          const result = await validateBackup(backupDir);
          return send(res, 200, result);
        } catch (err) {
          return send(res, 400, { error: err.message, valid: false });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/library/search') {
        const q = (url.searchParams.get('q') || '').trim().toLowerCase();
        const profile = url.searchParams.get('profile');
        const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 20));
        let books = store.books();
        if (profile) books = books.filter(b => b.profile === profile);
        if (q) {
          books = books.filter(b => {
            const bMatches = b.title.toLowerCase().includes(q) || b.remote_title?.toLowerCase().includes(q);
            if (bMatches) return true;
            const blks = store.blocks(b.id);
            return blks.some(bl => bl.title.toLowerCase().includes(q) || bl.filename?.toLowerCase().includes(q));
          });
        }
        const total = books.length;
        const start = (page - 1) * limit;
        const items = books.slice(start, start + limit).map(b => ({
          id: b.id,
          title: b.title,
          remoteTitle: b.remote_title,
          profile: b.profile,
          state: b.state,
          blocksCount: store.blocks(b.id).length
        }));
        return send(res, 200, { ok: true, items, pagination: { page, limit, total } });
      }
      if (req.method === 'GET' && url.pathname === '/api/books') return send(res, 200, store.snapshot());
      if (req.method === 'POST' && url.pathname === '/api/books') {
        const book = store.createBook(await body(req), accounts.current);
        return send(res, 202, { id: book.id });
      }
      if (parts[0] === 'api' && parts[1] === 'books' && parts[2]) {
        const book = store.book(parts[2]);
        if (!book) return send(res, 404, { error: 'Libro inexistente.' });
        if (parts[3] === 'production' || parts[3] === 'plan') {
          if (parts[4] === 'preview' && req.method === 'POST') {
            const payload = req.headers['content-length'] > 0 ? await body(req).catch(() => ({})) : {};
            const preview = previewProductionPlan({
              store,
              bookId: book.id,
              recipeId: payload?.recipeId,
              recipeVersion: payload?.recipeVersion,
              blockIds: payload?.blockIds
            });
            return send(res, 200, { ok: true, ...preview });
          }
          if ((parts[4] === 'plan' || parts[4] === 'confirm') && req.method === 'POST') {
            const payload = await body(req);
            try {
              if (queue.active && store.materialTasks(book.id, { currentOnly: true }).some(t => t.state === 'canceled')) await queue.active;
              const confirmed = confirmProductionPlan({
                store,
                bookId: book.id,
                recipeId: payload.recipeId,
                recipeVersion: payload.recipeVersion,
                blockIds: payload.blockIds,
                requestId: payload.requestId,
                expectedRevision: payload.expectedRevision
              });
              return send(res, 200, confirmed);
            } catch (err) {
              if (err.status === 409 || err.code === 'CONFLICT') {
                return send(res, 409, { error: err.message });
              }
              throw err;
            }
          }
          if (parts[4] === 'control' && req.method === 'POST') {
            const { action } = await body(req);
            if (!['start', 'pause'].includes(action)) throw new Error('Acción de producción inválida.');
            if (action === 'start') return send(res, 200, startProduction({ store, bookId: book.id }));
            store.update('books', book.id, { running: 0 });
            return send(res, 200, { ok: true, running: false });
          }
        }
        if ((parts[3] === 'materials' || parts[3] === 'matrix') && req.method === 'GET') {
          const page = Number(url.searchParams.get('page')) || 1;
          const limit = Number(url.searchParams.get('limit')) || 50;
          const type = url.searchParams.get('type') || undefined;
          const state = url.searchParams.get('state') || undefined;
          const editorialState = url.searchParams.get('editorialState') || undefined;
          const result = store.materialMatrix(book.id, { page, limit, type, state, editorialState });
          return send(res, 200, result);
        }
        if (parts[3] === 'exports') {
          if (parts.length === 4 && req.method === 'GET') {
            const deliveries = await listDeliveries({ exportsDir, bookId: book.id });
            return send(res, 200, { ok: true, deliveries });
          }
          if (parts.length === 4 && req.method === 'POST') {
            const payload = req.headers['content-length'] > 0 ? await body(req).catch(() => ({})) : {};
            try {
              const result = await createDelivery({
                store,
                bookId: book.id,
                exportsDir,
                provider,
                options: {
                  requireApproved: payload?.requireApproved === true,
                  allowPartial: payload?.allowPartial === true,
                  requestId: payload?.requestId
                }
              });
              return send(res, 201, result);
            } catch (err) {
              if (err.code === 'INCOMPLETE_DELIVERY' || err.code === 'APPROVAL_REQUIRED') {
                return send(res, 400, {
                  error: err.message,
                  code: err.code,
                  missing: err.missing || [],
                  unapproved: err.unapproved || []
                });
              }
              throw err;
            }
          }
          if (parts.length === 5 && req.method === 'GET') {
            try {
              const delivery = await getDelivery({ exportsDir, bookId: book.id, deliveryId: parts[4] });
              return send(res, 200, { ok: true, delivery });
            } catch (err) {
              return send(res, 404, { error: 'Entrega no encontrada.' });
            }
          }
        }
        if (parts[3] === 'accounts' && req.method === 'PUT') {
          await accounts.configure(book, (await body(req)).profiles); return send(res, 200, { ok: true });
        }
        if (parts.length === 3 && req.method === 'GET') return send(res, 200, store.snapshot().find(b => b.id === book.id));
        if (parts[3] === 'files' && req.method === 'PUT') return send(res, 201, await upload(req, book, url));
        if (parts[3] === 'order' && req.method === 'PATCH') {
          store.reorder(book.id, (await body(req)).ids);
          store.updateBlockOutputPaths(book.id, exportsDir, { renameFiles: true });
          return send(res, 200, { ok: true });
        }
        if (parts[3] === 'numbering' && req.method === 'PATCH') {
          const { numbering } = await body(req);
          store.setBookNumbering(book.id, numbering !== false, exportsDir);
          return send(res, 200, { ok: true, numbering: numbering !== false, book: store.snapshot().find(b => b.id === book.id) });
        }
        if (parts[3] === 'queue' && req.method === 'POST') {
          const { action, mode } = await body(req);
          if (!['start', 'pause', 'resume'].includes(action)) throw new Error('Acción de cola inválida.');
          if (action !== 'pause') return send(res, 200, startProduction({ store, bookId: book.id, mode }));
          const updates = { running: 0 };
          if (mode && ['immediate', 'later'].includes(mode)) updates.generation_mode = mode;
          store.update('books', book.id, updates);
          return send(res, 200, { ok: true });
        }
        if (parts[3] === 'mode' && req.method === 'PATCH') {
          const { mode } = await body(req);
          if (!['immediate', 'later'].includes(mode)) throw new Error('Modo de generación inválido.');
          store.update('books', book.id, { generation_mode: mode });
          return send(res, 200, { ok: true, mode });
        }
        if (parts[3] === 'sync' && req.method === 'POST') {
          if (!book.remote_id) return send(res, 400, { error: 'Este libro no está vinculado a un cuaderno remoto.' });
          const payload = req.headers['content-length'] > 0 ? await body(req).catch(() => ({})) : {};
          const result = await syncNotebook({
            store,
            accounts,
            profile: book.profile,
            remoteId: book.remote_id,
            requestId: payload?.requestId
          });
          return send(res, 202, result);
        }
        if (parts[3] === 'catalog' && req.method === 'GET') {
          const kind = url.searchParams.get('kind') || undefined;
          const type = url.searchParams.get('type') || undefined;
          const items = store.remoteItems(book.id, { kind, type });
          return send(res, 200, {
            book: {
              id: book.id,
              title: book.title,
              remoteId: book.remote_id,
              profile: book.profile,
              origin: book.origin,
              remoteRole: book.remote_role,
              lastSyncedAt: book.last_synced_at,
              lastSyncFull: !!book.last_sync_full,
              syncError: book.sync_error,
              syncErrorCode: book.sync_error_code
            },
            items
          });
        }
        if (parts[3] === 'downloads' && req.method === 'POST') {
          const payload = await body(req);
          const rawItems = Array.isArray(payload.items) ? payload.items : [];
          if (!rawItems.length) throw new Error('Selecciona al menos un elemento para descargar.');

          const catalog = store.remoteItems(book.id);
          const catMap = new Map();
          for (const item of catalog) {
            catMap.set(item.id, item);
            catMap.set(item.remote_id, item);
          }

          const accepted = [];
          const existing = [];
          const rejected = [];

          const dir = join(exportsDir, exportDirName(book));
          await mkdir(dir, { recursive: true });
          await mkdir(join(dataDir, 'audio'), { recursive: true });

          for (const raw of rawItems) {
            const itemId = typeof raw === 'string' ? raw : (raw.itemId || raw.id);
            const format = (typeof raw === 'object' && raw.format) ? raw.format : 'mp3';
            const catItem = catMap.get(itemId);

            if (!catItem) {
              rejected.push({ id: itemId, reason: 'Elemento no encontrado en el catálogo.' });
              continue;
            }
            if (catItem.status === 'failed') {
              rejected.push({ id: itemId, reason: 'El elemento falló en NotebookLM; no se puede descargar.' });
              continue;
            }
            if (catItem.status !== 'completed' && catItem.status !== 'ready') {
              rejected.push({ id: itemId, reason: 'El elemento aún no está listo en NotebookLM.' });
              continue;
            }

            if (catItem.type === 'audio') {
              let block = store.get('SELECT * FROM blocks WHERE book_id=? AND artifact_id=?', book.id, catItem.remote_id);
              if (block && block.state === 'done') {
                existing.push({ id: itemId, blockId: block.id, state: 'done', path: block.output_path });
                continue;
              }

              if (!block) {
                block = store.importRemoteBlock(book.id, {
                  title: catItem.title,
                  artifactId: catItem.remote_id,
                  sourceId: catItem.source_ids_json ? JSON.parse(catItem.source_ids_json)?.[0] : null,
                  profile: book.profile,
                  status: 'completed',
                  originalPath: join(dataDir, 'audio', `pending.m4a`),
                  outputPath: null
                });
                store.update('blocks', block.id, {
                  original_path: join(dataDir, 'audio', `${block.id}.m4a`)
                });
                accepted.push({ id: itemId, blockId: block.id, state: 'queued' });
              } else {
                if (block.state === 'error') {
                  store.update('blocks', block.id, { stage: 'download', state: 'download', attempts: 0, next_at: 0, error: null, error_code: null });
                }
                accepted.push({ id: itemId, blockId: block.id, state: block.state });
              }
            } else if (catItem.type && SUPPORTED_NON_AUDIO[catItem.type]) {
              const spec = SUPPORTED_NON_AUDIO[catItem.type];
              const fmt = (typeof raw === 'object' && raw.format) ? raw.format : spec.defaultFormat;
              const ext = spec.ext(fmt);
              const clean = safeName(catItem.title);
              const fileName = `${clean}-${catItem.remote_id.slice(0, 8)}.${ext}`;
              const outputPath = join(dir, fileName);

              const existingJob = store.findDownloadJob(catItem.id, fmt);
              if (existingJob && existingJob.state === 'done') {
                const fsStat = await import('node:fs/promises').then(fs => fs.stat(existingJob.output_path)).catch(() => null);
                if (fsStat && fsStat.size > 0) {
                  existing.push({ id: itemId, jobId: existingJob.id, state: 'done', path: existingJob.output_path });
                  continue;
                }
              }

              const job = store.createDownloadJob({
                bookId: book.id,
                remoteItemId: catItem.id,
                format: fmt,
                profile: book.profile,
                outputPath,
                requestId: payload?.requestId
              });
              accepted.push({ id: itemId, jobId: job.id, state: job.state, path: job.output_path });
            } else {
              rejected.push({ id: itemId, reason: `Tipo de contenido sin adaptador de descarga conocido: ${catItem.type || 'desconocido'}` });
            }
          }
          store.updateBlockOutputPaths(book.id, exportsDir, { renameFiles: false });
          return send(res, 200, { ok: true, accepted, existing, rejected });
        }
        if (parts[3] === 'generations' && req.method === 'POST') {
          await accounts.checkWriteAccess(book);
          const { sourceIds, mode } = await body(req);
          if (!Array.isArray(sourceIds) || !sourceIds.length) {
            return send(res, 400, { error: 'Selecciona al menos una fuente para generar audio.' });
          }
          const genMode = mode && ['immediate', 'later'].includes(mode) ? mode : (book.generation_mode || 'immediate');
          const queued = [];
          for (const sId of sourceIds) {
            const existingBlock = store.get('SELECT * FROM blocks WHERE book_id=? AND source_id=?', book.id, sId);
            if (existingBlock) {
              if (existingBlock.stage === 'source_ready') {
                store.update('blocks', existingBlock.id, { stage: 'generate', state: 'ready', generation_mode: genMode });
                queued.push(existingBlock.id);
              }
            } else {
              const item = store.remoteItemByRemoteId(book.id, 'source', sId);
              const sourceTitle = item?.title || 'Audio';
              const block = store.addRemoteSourceBlock(book.id, {
                sourceId: sId,
                title: sourceTitle,
                generationMode: genMode
              });
              queued.push(block.id);
            }
          }
          store.update('books', book.id, { running: 1 });
          return send(res, 200, { ok: true, queued });
        }
        if (parts[3] === 'cancel-pending' && req.method === 'POST') {
          const payload = req.headers['content-length'] > 0 ? await body(req).catch(() => ({})) : {};
          const blockIds = payload?.blockIds;
          const allBlocks = store.blocks(book.id);
          const targets = Array.isArray(blockIds) && blockIds.length
            ? allBlocks.filter(b => blockIds.includes(b.id))
            : allBlocks.filter(b => !['done', 'canceled'].includes(b.state));
          let alreadyRemoteCount = 0;
          let canceledCount = 0;
          const details = [];
          for (const b of targets) {
            const r = queue.cancelBlock(b.id, payload?.reason || 'Cancelado por el usuario');
            if (r.alreadyRemote) alreadyRemoteCount++;
            if (!r.alreadyDone) canceledCount++;
            details.push({ id: b.id, alreadyRemote: r.alreadyRemote, state: r.block.state });
          }
          return send(res, 200, {
            ok: true,
            canceledCount,
            alreadyRemoteCount,
            message: alreadyRemoteCount > 0
              ? `${alreadyRemoteCount} trabajo(s) ya habían sido enviados a NotebookLM. Sus siguientes pasos locales se cancelaron, pero la generación remota puede continuar en Google.`
              : `${canceledCount} trabajo(s) cancelados localmente.`,
            details
          });
        }
        if (parts[3] === 'artifacts' && parts[4] && parts[5] === 'delete' && req.method === 'POST') {
          const itemId = parts[4];
          const payload = await body(req);
          if (!payload?.confirm) {
            return send(res, 400, { error: 'Se requiere confirmación explícita para eliminar contenido remoto de NotebookLM.' });
          }
          await accounts.checkWriteAccess(book);
          const item = store.remoteItemByRemoteId(book.id, 'artifact', itemId) ||
            store.get('SELECT * FROM blocks WHERE book_id=? AND artifact_id=?', book.id, itemId);
          if (!item) {
            return send(res, 404, { error: 'El artefacto no pertenece a este cuaderno.' });
          }
          const block = store.get('SELECT * FROM blocks WHERE book_id=? AND artifact_id=?', book.id, itemId);
          if (block && block.state !== 'done') {
            queue.cancelBlock(block.id, 'Cancelado por eliminación remota');
          }
          const op = store.createRemoteOperation({
            requestId: payload.requestId,
            bookId: book.id,
            profile: book.profile,
            type: 'delete_artifact',
            targetId: itemId,
            state: 'running'
          });
          const provider = accounts.get(book.profile);
          try {
            await provider.deleteArtifact(book.remote_id, itemId);
            let stillExists = false;
            try {
              const checkRows = await provider.artifacts(book.remote_id, itemId);
              stillExists = checkRows.some(a => (a.artifact_id || a.id) === itemId);
            } catch {
              stillExists = false;
            }
            if (stillExists) {
              store.update('remote_operations', op.id, {
                state: 'uncertain',
                error: 'La llamada de eliminación finalizó pero el elemento todavía aparece en NotebookLM.',
                completed_at: Date.now()
              });
              if (item.id) store.update('remote_items', item.id, { status: 'delete_uncertain', error_reason: 'Eliminación incierta; sigue presente.' });
              return send(res, 202, { ok: false, status: 'uncertain', operationId: op.id });
            }
            store.update('remote_operations', op.id, { state: 'confirmed', completed_at: Date.now() });
            if (item.id) {
              store.update('remote_items', item.id, { status: 'deleted_confirmed', not_visible: 1 });
            }
            return send(res, 200, { ok: true, status: 'confirmed', operationId: op.id });
          } catch (err) {
            store.update('remote_operations', op.id, {
              state: 'uncertain',
              error: redact(err.message),
              completed_at: Date.now()
            });
            if (item.id) {
              store.update('remote_items', item.id, { status: 'delete_uncertain', error_reason: redact(err.message) });
            }
            return send(res, 202, { ok: false, status: 'uncertain', operationId: op.id, error: redact(err.message) });
          }
        }
        if (parts[3] === 'open-folder' && req.method === 'POST') {
          const dir = resolve(join(exportsDir, exportDirName(book)));
          await mkdir(dir, { recursive: true });
          openInExplorer(dir);
          return send(res, 200, { ok: true, path: dir });
        }
        if (parts[3] === 'retry' && req.method === 'POST') { queue.retryBook(book.id); return send(res, 200, { ok: true }); }
      }
      if (parts[0] === 'api' && parts[1] === 'operations' && parts[2] && req.method === 'GET') {
        const op = store.remoteOperation(parts[2]);
        if (!op) return send(res, 404, { error: 'Operación inexistente.' });
        let summary = null;
        try { if (op.summary_json) summary = JSON.parse(op.summary_json); } catch {}
        return send(res, 200, {
          id: op.id,
          requestId: op.request_id,
          bookId: op.book_id,
          profile: op.profile,
          type: op.type,
          targetId: op.target_id,
          state: op.state,
          createdAt: op.created_at,
          startedAt: op.started_at,
          completedAt: op.completed_at,
          error: op.error,
          errorCode: op.error_code,
          summary
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/downloads') {
        const bookId = url.searchParams.get('bookId');
        let sql = "SELECT * FROM blocks WHERE stage IN ('download', 'convert') OR state='done'";
        const params = [];
        if (bookId) {
          sql += ' AND book_id=?';
          params.push(bookId);
        }
        sql += ' ORDER BY created_at DESC';
        const rows = store.all(sql, ...params);
        const blockItems = rows.map(b => ({
          id: b.id,
          blockId: b.id,
          bookId: b.book_id,
          artifactId: b.artifact_id,
          title: b.title,
          type: 'audio',
          stage: b.stage,
          state: b.state,
          error: b.error,
          outputPath: b.output_path
        }));

        let djSql = 'SELECT dj.*, ri.title, ri.type as item_type, ri.remote_id as remote_item_remote_id FROM download_jobs dj JOIN remote_items ri ON dj.remote_item_id = ri.id';
        const djParams = [];
        if (bookId) {
          djSql += ' WHERE dj.book_id=?';
          djParams.push(bookId);
        }
        djSql += ' ORDER BY dj.created_at DESC';
        const djRows = store.all(djSql, ...djParams);
        const jobItems = djRows.map(dj => ({
          id: dj.id,
          jobId: dj.id,
          bookId: dj.book_id,
          artifactId: dj.remote_item_remote_id,
          title: dj.title,
          type: dj.item_type,
          format: dj.format,
          stage: dj.state,
          state: dj.state,
          error: dj.error,
          outputPath: dj.output_path
        }));

        return send(res, 200, [...blockItems, ...jobItems]);
      }
      if (parts[0] === 'api' && parts[2] && (parts[1] === 'downloads' || (parts[1] === 'materials' && parts[3] === 'file'))) {
        const id = parts[2];
        if (parts[3] === 'file' && ['GET', 'HEAD'].includes(req.method)) {
          const material = parts[1] === 'materials' ? store.materialTask(id) : null;
          const job = parts[1] === 'downloads' ? store.downloadJob(id) : null;
          const block = parts[1] === 'downloads' && !job ? store.block(id) : null;
          const item = material || job || block;
          if (!item) return send(res, 404, { error: 'Descarga inexistente.' });
          if (item.state !== (material ? 'ready' : 'done')) return send(res, 400, { error: 'La descarga no ha finalizado.' });
          const filePath = item.output_path;
          if (!filePath) return send(res, 404, { error: 'Archivo no encontrado.' });
          const fsStat = await import('node:fs/promises').then(fs => fs.stat(filePath)).catch(() => null);
          if (!fsStat || fsStat.size === 0) return send(res, 404, { error: 'El archivo en disco no existe o está vacío.' });

          const size = fsStat.size;
          let start = 0, end = size - 1, status = 200;
          if (req.headers.range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
            if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
            if (match[1]) { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
            else start = Math.max(0, size - Number(match[2]));
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
            status = 206;
          }
          const ext = extname(filePath).slice(1).toLowerCase();
          const mime = MIME_TYPES[ext] || 'application/octet-stream';
          const name = basename(filePath);
          const encodedName = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
          res.writeHead(status, {
            'Content-Type': mime,
            'Content-Length': end - start + 1,
            'Accept-Ranges': 'bytes',
            'Content-Disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename="${name}"; filename*=UTF-8''${encodedName}`,
            ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
          });
          if (req.method === 'HEAD') return res.end();
          await pipeline(createReadStream(filePath, { start, end }), res);
          return;
        }
        if (parts[3] === 'cancel' && req.method === 'POST') {
          const job = store.downloadJob(id);
          if (job) return send(res, 200, queue.cancelDownloadJob(job.id));
          const block = store.block(id);
          if (block) return send(res, 200, queue.cancelBlock(block.id));
          return send(res, 404, { error: 'Trabajo de descarga no encontrado.' });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/exports/open') {
        const dir = resolve(exportsDir);
        await mkdir(dir, { recursive: true });
        openInExplorer(dir);
        return send(res, 200, { ok: true, path: dir });
      }
      if (parts[0] === 'api' && parts[1] === 'blocks' && parts[2]) {
        const block = store.block(parts[2]);
        if (!block) return send(res, 404, { error: 'Bloque inexistente.' });
        if (parts.length === 3 && req.method === 'PATCH') {
          const b = await body(req);
          const updates = {};
          if (b.title !== undefined) {
            if (block.locked) throw new Error('El título ya está fijado para este audio.');
            updates.title = title(b.title);
          }
          if (b.mode !== undefined) {
            if (!['immediate', 'later'].includes(b.mode)) throw new Error('Modo de generación inválido.');
            updates.generation_mode = b.mode;
          }
          if (Object.keys(updates).length) {
            store.update('blocks', block.id, updates);
            if (updates.title) store.updateBlockOutputPaths(block.book_id, exportsDir, { renameFiles: true });
          }
          return send(res, 200, { ok: true });
        }
        if (parts[3] === 'retry' && req.method === 'POST') { queue.retryBlock(block.id); return send(res, 200, { ok: true }); }
        if (parts[3] === 'cancel' && req.method === 'POST') {
          const payload = req.headers['content-length'] > 0 ? await body(req).catch(() => ({})) : {};
          const result = queue.cancelBlock(block.id, payload?.reason);
          return send(res, 200, result);
        }
        if (parts[3] === 'audio' && ['GET', 'HEAD'].includes(req.method) && block.state === 'done') {
          if (!block.output_path) return send(res, 404, { error: 'Archivo no encontrado.' });
          const fsStat = await import('node:fs/promises').then(fs => fs.stat(block.output_path)).catch(() => null);
          if (!fsStat || fsStat.size === 0) return send(res, 404, { error: 'El archivo en disco no existe o está vacío.' });
          const { size } = fsStat;
          let start = 0, end = size - 1, status = 200;
          if (req.headers.range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
            if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
            if (match[1]) { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
            else start = Math.max(0, size - Number(match[2]));
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
            status = 206;
          }
          const name = block.output_path.split(/[\\/]/).at(-1);
          const encodedName = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
          res.writeHead(status, { 'Content-Type': 'audio/mpeg', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
            'Content-Disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename="${name}"; filename*=UTF-8''${encodedName}`,
            ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
          if (req.method === 'HEAD') return res.end();
          await pipeline(createReadStream(block.output_path, { start, end }), res); return;
        }
      }
      if (parts[0] === 'api' && parts[1] === 'materials' && parts[2]) {
        const task = store.materialTask(parts[2]);
        if (!task) return send(res, 404, { error: 'Tarea de material inexistente.' });
        if (parts[3] === 'action' && req.method === 'POST') {
          const { action, reason } = await body(req);
          if (action === 'approve') {
            const updated = store.approveMaterialTask(task.id);
            return send(res, 200, { ok: true, task: updated });
          } else if (action === 'reject') {
            const updated = store.rejectMaterialTask(task.id);
            return send(res, 200, { ok: true, task: updated });
          } else if (action === 'retry') {
            const updated = queue.retryMaterialTask(task.id);
            return send(res, 200, { ok: true, task: updated });
          } else if (action === 'cancel') {
            const result = queue.cancelMaterialTask(task.id, reason);
            return send(res, 200, result);
          } else if (action === 'restore') {
            const updated = await queue.restorePreviousMaterial(task.id);
            return send(res, 200, { ok: true, task: updated });
          } else if (action === 'restart') {
            if (queue.active) await queue.active;
            const updated = store.transaction(() => {
              const current = store.materialTask(task.id);
              if (!current.is_current || current.state !== 'canceled') throw new Error('Solo se puede reiniciar un material actual cancelado.');
              const next = store.createMaterialRevision(current.id);
              startProduction({ store, bookId: task.book_id });
              return store.materialTask(next.id);
            });
            return send(res, 201, { ok: true, task: updated });
          } else if (action === 'revision') {
            const updated = store.createMaterialRevision(task.id);
            return send(res, 201, { ok: true, task: updated });
          } else {
            return send(res, 400, { error: 'Acción de material inválida.' });
          }
        }
      }
      if (req.method === 'GET') {
        const assets = {
          '/': ['index.html', 'text/html'],
          '/app.js': ['app.js', 'text/javascript'],
          '/theme-init.js': ['theme-init.js', 'text/javascript'],
          '/style.css': ['style.css', 'text/css'],
          '/icon.svg': ['icon.svg', 'image/svg+xml'],
          '/favicon.ico': ['icon.ico', 'image/x-icon']
        };
        const asset = assets[url.pathname];
        if (asset) {
          const content = await readFile(join(publicDir, asset[0]));
          res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-cache' }); res.end(content); return;
        }
      }
      send(res, 404, { error: 'Ruta inexistente.' });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) send(res, 400, { error: redact(error.message).slice(0, 1200) });
      else res.destroy();
    }
  });
  server.requestTimeout = 10 * 60 * 1000;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (e) { store.close(); await provider.close(); await connectorGate.close(); await releaseLock(); throw e; }
  origin = `http://127.0.0.1:${server.address().port}`;
  if (check) initialization = healthCheck().catch(e => { provider.health.error = redact(e.message); });
  if (worker) queue.start();
  shutdown = async () => {
      if (closed) return; closed = true;
      const closing = new Promise(resolve => server.close(resolve));
      server.closeAllConnections(); await queue.stop(); await connectorGate.close(); await initialization; await closing; store.close();
      await releaseLock();
      completion.resolve();
  };
  return { server, store, queue, provider, accounts, gate: connectorGate, origin, token, close: shutdown, finished: completion.promise };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await makeApp();
  app.finished.then(() => process.exit(0));
  console.log(`BloqueAudio ${appVersion}: ${app.origin}`);
  process.send?.({ type: 'ready', origin: app.origin });
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  process.on('message', m => { if (m?.type === 'shutdown') shutdown(); });
  process.once('disconnect', shutdown);
}
