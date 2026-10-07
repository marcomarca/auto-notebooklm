import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';

const [title, ...paths] = process.argv.slice(2);
if (!title || !paths.length) {
  console.error('Uso: node scripts/create-book.mjs "Título del libro" parte1.md parte2.pdf ...');
  process.exit(1);
}
const base = process.env.APP_URL || 'http://127.0.0.1:4318';
let token;
async function request(path, { method = 'GET', data, file } = {}) {
  const response = await fetch(base + path, { method,
    headers: { ...(method !== 'GET' ? { 'X-Local-Token': token } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) },
    body: file || (data ? JSON.stringify(data) : undefined) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
try {
  ({ token } = await request('/api/health'));
  const idempotencyKey = process.env.BOOK_REQUEST_ID || randomUUID();
  const book = await request('/api/books', { method: 'POST', data: { title, requestId: idempotencyKey } });
  paths.sort((a, b) => basename(a).localeCompare(basename(b), 'es', { numeric: true, sensitivity: 'base' }));
  for (const path of paths) {
    const name = basename(path);
    await request(`/api/books/${book.id}/files?filename=${encodeURIComponent(name)}&requestId=${randomUUID()}`, { method: 'PUT', file: await readFile(path) });
    console.log(`Añadido: ${name}`);
  }
  await request(`/api/books/${book.id}/queue`, { method: 'POST', data: { action: 'start' } });
  console.log(`Libro: ${book.id}\nrequestId: ${idempotencyKey}\nLa cola continúa en el backend. Consulta ${base}`);
} catch (e) { console.error(e.message); process.exitCode = 1; }
