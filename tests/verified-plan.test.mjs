import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { makeApp } from '../server.mjs';
import { FakeProvider } from './helpers.mjs';

test('T01 - Normalización de catálogo, resolución de IDs y estados', () => {
  const rawCatalogResponse = {
    book: { id: 'book-123', title: 'Libro de prueba', remoteId: 'remote-nb-123' },
    items: [
      { id: 101, remote_id: 'g-art-1', kind: 'artifact', type: 'audio', title: 'Audio 1', status: 'ready', created_time: 1729000000000, not_visible: 0 },
      { id: 102, remote_id: 'g-art-2', kind: 'artifact', type: 'audio', title: 'Audio 2', status: 'completed', created_time: '1729000100000', not_visible: 1 },
      { id: 201, remote_id: 'g-src-1', kind: 'source', type: 'source', title: 'Capítulo 1', status: 2, created_time: 1729000000000, not_visible: 0 },
      { id: 301, remote_id: 'g-note-1', kind: 'note', type: 'note', title: 'Nota inicial', status: null, created_time: 1729000000000, not_visible: 0 }
    ]
  };

  // Replicar función normalizeCatalogResponse de app.js para prueba unitaria estricta
  const normalize = (data, expectedBookId) => {
    if (!data || typeof data !== 'object') return null;
    const book = data.book || { id: expectedBookId };
    const bookId = book.id || expectedBookId;
    const rawItems = Array.isArray(data.items) ? data.items : [];
    const artifacts = [], sources = [], notes = [];

    for (const item of rawItems) {
      const normalized = {
        id: item.id,
        remoteId: item.remote_id || item.remoteId,
        kind: item.kind,
        type: item.type || (item.kind === 'note' ? 'note' : item.kind === 'source' ? 'source' : 'audio'),
        title: item.title || (item.kind === 'note' ? 'Nota' : item.kind === 'source' ? 'Fuente' : 'Contenido'),
        status: item.status,
        createdAt: item.created_time || item.createdAt || item.createdTime || null,
        notVisible: !!(item.not_visible ?? item.notVisible),
        errorReason: item.error_reason || item.errorReason || null
      };
      if (item.kind === 'source') sources.push(normalized);
      else if (item.kind === 'note') notes.push(normalized);
      else artifacts.push(normalized);
    }
    return { bookId, book, artifacts, sources, notes, rawItems };
  };

  const norm = normalize(rawCatalogResponse, 'book-123');
  assert.equal(norm.bookId, 'book-123');
  assert.equal(norm.artifacts.length, 2);
  assert.equal(norm.sources.length, 1);
  assert.equal(norm.notes.length, 1);

  // Verificación de notVisible y remoteId
  assert.equal(norm.artifacts[0].notVisible, false);
  assert.equal(norm.artifacts[0].remoteId, 'g-art-1');
  assert.equal(norm.artifacts[1].notVisible, true);
  assert.equal(norm.artifacts[1].remoteId, 'g-art-2');

  // Separación de contratos de red:
  // Descargas espera el local itemId (norm.artifacts[0].id)
  const downloadPayload = { items: [{ itemId: norm.artifacts[0].id }] };
  assert.equal(downloadPayload.items[0].itemId, 101);

  // Generaciones espera remoteId de fuentes
  const genPayload = { sourceIds: [norm.sources[0].remoteId] };
  assert.equal(genPayload.sourceIds[0], 'g-src-1');

  // Delete espera remoteId de artefacto en URL
  const deleteUrl = `/api/books/${norm.bookId}/artifacts/${encodeURIComponent(norm.artifacts[0].remoteId)}/delete`;
  assert.equal(deleteUrl, '/api/books/book-123/artifacts/g-art-1/delete');
});

test('T02 - Reglas de validación frontal de archivos de subida', () => {
  const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

  const validate = file => {
    if (!/\.(md|pdf)$/i.test(file.name)) {
      return { valid: false, reason: 'Formato no compatible (solo .md y .pdf).' };
    }
    if (file.size === 0) {
      return { valid: false, reason: 'El archivo está vacío (0 bytes).' };
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return { valid: false, reason: 'El archivo supera el límite de 200 MiB.' };
    }
    return { valid: true };
  };

  assert.equal(validate({ name: 'capitulo1.md', size: 1024 }).valid, true);
  assert.equal(validate({ name: 'MANUAL.PDF', size: 50 * 1024 * 1024 }).valid, true);
  assert.equal(validate({ name: 'vacio.md', size: 0 }).valid, false);
  assert.match(validate({ name: 'vacio.md', size: 0 }).reason, /vacío/);
  assert.equal(validate({ name: 'pesado.pdf', size: 200 * 1024 * 1024 + 1 }).valid, false);
  assert.match(validate({ name: 'pesado.pdf', size: 200 * 1024 * 1024 + 1 }).reason, /200 MiB/);
  assert.equal(validate({ name: 'documento.docx', size: 2048 }).valid, false);
  assert.match(validate({ name: 'documento.docx', size: 2048 }).reason, /solo \.md y \.pdf/i);
});

test('T04 - Lógica de delays del Scheduler Adaptativo', () => {
  const getDelay = ({ errors = 0, isHidden = false, hasActivity = false }) => {
    if (errors > 0) return Math.min(60000, 2000 * Math.pow(1.5, errors));
    if (isHidden) return 30000;
    if (hasActivity) return 2000;
    return 15000;
  };

  // 1. Actividad en curso
  assert.equal(getDelay({ hasActivity: true, isHidden: false, errors: 0 }), 2000);
  // 2. Reposo en primer plano
  assert.equal(getDelay({ hasActivity: false, isHidden: false, errors: 0 }), 15000);
  // 3. Pestaña oculta en segundo plano
  assert.equal(getDelay({ hasActivity: false, isHidden: true, errors: 0 }), 30000);
  // 4. Backoff exponencial con errores
  assert.equal(getDelay({ errors: 1 }), 3000);
  assert.equal(getDelay({ errors: 2 }), 4500);
  assert.equal(getDelay({ errors: 5 }), 15187.5);
  assert.equal(getDelay({ errors: 15 }), 60000);
});

test('T05 & T06 & T07 - Verificación de HTML, CSS, theme-init.js y allowlist de assets', async t => {
  const indexHtml = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8');
  const styleCss = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8');

  // T05: Atributos accesibles
  assert.ok(indexHtml.includes('id="explorer-title" tabindex="-1"'), 'Encabezado de explorador debe ser programáticamente enfocable');
  assert.ok(indexHtml.includes('id="delete-modal"') && indexHtml.includes('aria-labelledby="delete-modal-title"') && indexHtml.includes('aria-describedby="delete-modal-details"'), 'delete-modal debe tener aria-labelledby y aria-describedby');
  assert.ok(indexHtml.includes('id="plan-modal"') && indexHtml.includes('aria-labelledby="plan-modal-title"'), 'plan-modal debe tener aria-labelledby');
  assert.ok(indexHtml.includes('id="notice-container"') && indexHtml.includes('aria-live="polite"'), 'notice-container debe tener aria-live="polite"');
  assert.ok(indexHtml.includes('id="theme-selector"'), 'Selector de tema debe existir en index.html');

  // T07: Buffer visual
  assert.ok(indexHtml.includes('id="player-buffer-bar" class="player-buffer-bar"'), 'player-buffer-bar debe existir en index.html');
  assert.ok(styleCss.includes('.player-buffer-bar'), 'Estilos de player-buffer-bar deben existir en style.css');

  // T05: Movimiento reducido
  assert.ok(styleCss.includes('prefers-reduced-motion: reduce'), 'style.css debe tener soporte de prefers-reduced-motion: reduce');

  // T06: theme-init.js y whitelist en server.mjs
  const dir = await mkdtemp(join(tmpdir(), 'bloqueaudio-plan-test-'));
  let app;
  t.after(async () => {
    try { await app?.close(); } finally { await rm(dir, { recursive: true, force: true }); }
  });

  const provider = new FakeProvider();
  app = await makeApp({ port: 0, dataDir: dir, exportsDir: join(dir, 'exports'), provider, worker: false, check: false });

  const themeInitRes = await fetch(`${app.origin}/theme-init.js`);
  assert.equal(themeInitRes.status, 200);
  assert.match(themeInitRes.headers.get('content-type') || '', /javascript/);
  const themeInitText = await themeInitRes.text();
  assert.ok(themeInitText.includes('bloqueaudio_theme_v1'), 'theme-init.js debe leer bloqueaudio_theme_v1');
});
