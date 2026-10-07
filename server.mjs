import { createServer } from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, title } from './store.mjs';
import { Provider, redact } from './provider.mjs';
import { Queue } from './queue.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, 'public');
const maxFile = 200 * 1024 * 1024;
const natural = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

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

export async function makeApp({ dataDir = join(root, 'data'), exportsDir = join(root, 'exports'), provider = new Provider({ profile: process.env.NLM_PROFILE || 'default' }), port = Number(process.env.PORT || 4318), worker = true, check = true } = {}) {
  await mkdir(dataDir, { recursive: true });
  const releaseLock = await acquireLock(dataDir);
  let store;
  try { store = new Store(join(dataDir, 'queue.sqlite')); } catch (e) { await releaseLock(); throw e; }
  const queue = new Queue(store, provider, { dataDir, exportsDir });
  const token = randomBytes(32).toString('hex');
  let origin, closed = false, checking, shutdown;
  const healthCheck = () => checking ||= provider.check().finally(() => { checking = null; });

  async function upload(req, book, url) {
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
        send(res, 200, { ok: true }); setImmediate(() => shutdown().catch(() => {})); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ...provider.health, token, busy: queue.busy });
      if (req.method === 'POST' && url.pathname === '/api/health/check') {
        const h = await healthCheck();
        if (h.ready) {
          for (const b of store.books().filter(b => b.profile === provider.profile)) {
            if (b.state === 'auth') queue.retryBook(b.id);
            for (const block of store.blocks(b.id).filter(b => b.state === 'auth')) queue.retryBlock(block.id);
          }
        }
        return send(res, 200, h);
      }
      if (req.method === 'GET' && url.pathname === '/api/books') return send(res, 200, store.snapshot().filter(b => store.book(b.id).profile === provider.profile));
      if (req.method === 'POST' && url.pathname === '/api/books') {
        const book = store.createBook(await body(req), provider.profile);
        return send(res, 202, { id: book.id });
      }
      if (parts[0] === 'api' && parts[1] === 'books' && parts[2]) {
        const book = store.book(parts[2]);
        if (!book || book.profile !== provider.profile) return send(res, 404, { error: 'Libro inexistente.' });
        if (parts.length === 3 && req.method === 'GET') return send(res, 200, store.snapshot().find(b => b.id === book.id));
        if (parts[3] === 'files' && req.method === 'PUT') return send(res, 201, await upload(req, book, url));
        if (parts[3] === 'order' && req.method === 'PATCH') {
          store.reorder(book.id, (await body(req)).ids); return send(res, 200, { ok: true });
        }
        if (parts[3] === 'queue' && req.method === 'POST') {
          const { action } = await body(req);
          if (!['start', 'pause', 'resume'].includes(action)) throw new Error('Acción de cola inválida.');
          store.update('books', book.id, { running: action === 'pause' ? 0 : 1 });
          return send(res, 200, { ok: true });
        }
        if (parts[3] === 'retry' && req.method === 'POST') { queue.retryBook(book.id); return send(res, 200, { ok: true }); }
      }
      if (parts[0] === 'api' && parts[1] === 'blocks' && parts[2]) {
        const block = store.block(parts[2]);
        if (!block || store.book(block.book_id).profile !== provider.profile) return send(res, 404, { error: 'Bloque inexistente.' });
        if (parts.length === 3 && req.method === 'PATCH') {
          const name = title((await body(req)).title);
          if (block.locked) throw new Error('El título ya está fijado para este audio.');
          store.update('blocks', block.id, { title: name }); return send(res, 200, { ok: true });
        }
        if (parts[3] === 'retry' && req.method === 'POST') { queue.retryBlock(block.id); return send(res, 200, { ok: true }); }
        if (parts[3] === 'audio' && ['GET', 'HEAD'].includes(req.method) && block.state === 'done') {
          const { size } = await import('node:fs/promises').then(fs => fs.stat(block.output_path));
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
            'Content-Disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename="audio.mp3"; filename*=UTF-8''${encodedName}`,
            ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
          if (req.method === 'HEAD') return res.end();
          await pipeline(createReadStream(block.output_path, { start, end }), res); return;
        }
      }
      if (req.method === 'GET') {
        const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
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
  } catch (e) { store.close(); await provider.close(); await releaseLock(); throw e; }
  origin = `http://127.0.0.1:${server.address().port}`;
  if (check) healthCheck().catch(() => {});
  if (worker) queue.start();
  shutdown = async () => {
      if (closed) return; closed = true;
      const closing = new Promise(resolve => server.close(resolve));
      server.closeAllConnections(); await queue.stop(); await closing; store.close();
      await releaseLock();
  };
  return { server, store, queue, provider, origin, token, close: shutdown };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await makeApp();
  console.log(`Audios por bloques: ${app.origin}\nPerfil: ${app.provider.profile}\nCtrl+C para cerrar.`);
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
