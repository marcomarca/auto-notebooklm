import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { makeApp } from '../server.mjs';
import { FakeProvider } from './helpers.mjs';

// Comportamiento del código real cubierto en implementation-regressions.test.mjs.
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
