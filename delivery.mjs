import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

function safeName(s) {
  return (s || '').replace(/[\/\\?%*:|"<>]/g, '_').trim() || 'sin_titulo';
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function safeCsv(val) {
  if (val === null || val === undefined) return '""';
  let str = String(val);
  // Protect against spreadsheet formula injection (=, +, -, @, \t, \r)
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  return `"${str.replace(/"/g, '""')}"`;
}

async function calculateSha256(filePath) {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function extractImageDimensions(filePath) {
  try {
    const handle = await open(filePath, 'r');
    const header = Buffer.alloc(24);
    await handle.read(header, 0, 24, 0);
    await handle.close();
    if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      const width = header.readUInt32BE(16);
      const height = header.readUInt32BE(20);
      return { width, height };
    }
  } catch {}
  return null;
}

async function extractAudioDuration(provider, filePath) {
  if (!provider?.ffmpeg || !provider?.runner) return null;
  try {
    let output = '';
    try {
      output = await provider.runner.run(provider.ffmpeg, ['-i', filePath, '-f', 'null', '-'], { timeout: 15000 });
    } catch (e) {
      output = e.output || e.message || '';
    }
    const match = /Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/i.exec(output);
    if (match) {
      const h = Number(match[1]);
      const m = Number(match[2]);
      const s = Number(match[3]);
      return Math.round((h * 3600 + m * 60 + s) * 100) / 100;
    }
  } catch {}
  return null;
}

export async function createDelivery({
  store,
  bookId,
  exportsDir,
  provider = null,
  options = {}
} = {}) {
  const {
    requireApproved = false,
    allowPartial = false,
    requestId = randomUUID()
  } = options;

  const book = store.book(bookId);
  if (!book) throw new Error('Libro inexistente para generar entrega.');

  const allBlocks = store.blocks(bookId);
  if (!allBlocks.length) throw new Error('El libro no contiene bloques para entregar.');

  const recipe = store.recipe(book.recipe_id || 'study-book') || store.recipes()[0];
  const recipeConfig = typeof recipe.config_json === 'string' ? JSON.parse(recipe.config_json) : (recipe.config || {});
  const enabledKinds = Object.entries(recipeConfig.materials || {})
    .filter(([_, s]) => s.enabled)
    .map(([kind]) => kind);

  if (!enabledKinds.length) enabledKinds.push('audio');

  const allTasks = store.materialTasks(bookId, { currentOnly: true });
  const tasksByBlock = new Map();
  for (const t of allTasks) {
    if (!tasksByBlock.has(t.block_id)) tasksByBlock.set(t.block_id, {});
    tasksByBlock.get(t.block_id)[t.type] = t;
  }

  // Check requirements and collect missing
  const missingItems = [];
  const unapprovedItems = [];
  const plannedItems = [];

  for (const block of allBlocks) {
    const blockMats = tasksByBlock.get(block.id) || {};
    for (const kind of enabledKinds) {
      const task = blockMats[kind];
      let sourcePath = null;

      if (kind === 'audio') {
        sourcePath = block.output_path || task?.output_path || null;
      } else {
        sourcePath = task?.output_path || null;
      }

      let fileExists = false;
      if (sourcePath) {
        try {
          const s = await stat(sourcePath);
          fileExists = s.isFile() && s.size > 0;
        } catch {
          fileExists = false;
        }
      }

      const isReady = (kind === 'audio' && block.state === 'done' && fileExists) || (task?.state === 'ready' && fileExists);
      const isApproved = task?.editorial_state === 'approved';

      if (!isReady) {
        missingItems.push({
          blockId: block.id,
          blockNumber: block.position,
          blockTitle: block.title,
          kind,
          reason: !sourcePath ? 'No generado ni planificado' : !fileExists ? 'Archivo físico no encontrado' : `Estado actual: ${task?.state || block.state}`
        });
      } else if (requireApproved && !isApproved) {
        unapprovedItems.push({
          blockId: block.id,
          blockNumber: block.position,
          blockTitle: block.title,
          kind,
          editorialState: task?.editorial_state || 'unreviewed'
        });
      }

      plannedItems.push({
        block,
        kind,
        task,
        sourcePath,
        isReady,
        isApproved
      });
    }
  }

  if (!allowPartial) {
    if (missingItems.length > 0) {
      const err = new Error(`Entrega incompleta: faltan ${missingItems.length} materiales requeridos.`);
      err.code = 'INCOMPLETE_DELIVERY';
      err.missing = missingItems;
      throw err;
    }
    if (requireApproved && unapprovedItems.length > 0) {
      const err = new Error(`Aprobación requerida: ${unapprovedItems.length} materiales no han sido aprobados.`);
      err.code = 'APPROVAL_REQUIRED';
      err.unapproved = unapprovedItems;
      throw err;
    }
  }

  const deliveryId = `entrega-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const baseDeliveryDir = join(resolve(exportsDir), 'entregas', book.id);
  const tempDeliveryDir = join(baseDeliveryDir, `.tmp-${deliveryId}`);
  const finalDeliveryDir = join(baseDeliveryDir, deliveryId);

  await mkdir(tempDeliveryDir, { recursive: true });

  const deliveredBlocks = [];
  let deliveredMaterialsCount = 0;
  let missingMaterialsCount = 0;

  for (const block of allBlocks) {
    const blockFolder = `${String(block.position).padStart(3, '0')} - ${safeName(block.title)}`;
    const blockDestDir = join(tempDeliveryDir, blockFolder);
    await mkdir(blockDestDir, { recursive: true });

    const blockEntry = {
      blockId: block.id,
      position: block.position,
      title: block.title,
      folder: blockFolder,
      materials: {}
    };

    for (const kind of enabledKinds) {
      const item = plannedItems.find(p => p.block.id === block.id && p.kind === kind);
      if (!item || !item.isReady || (requireApproved && !item.isApproved)) {
        missingMaterialsCount++;
        blockEntry.materials[kind] = {
          delivered: false,
          missing: true,
          reason: !item ? 'No solicitado' : !item.isReady ? 'Pendiente o incompleto' : 'No aprobado'
        };
        continue;
      }

      // Delivered material
      const ext = kind === 'audio' ? 'mp3' : 'png';
      const destFilename = `${kind === 'audio' ? 'audio' : 'infografia'}.${ext}`;
      const destPath = join(blockDestDir, destFilename);

      // 1. Pre-copy checksum
      const preSha256 = await calculateSha256(item.sourcePath);
      const preStat = await stat(item.sourcePath);

      // 2. Safe copy
      await copyFile(item.sourcePath, destPath);

      // 3. Post-copy checksum and integrity check
      const postSha256 = await calculateSha256(destPath);
      const postStat = await stat(destPath);

      if (preSha256 !== postSha256 || preStat.size !== postStat.size) {
        throw new Error(`Fallo de integridad al copiar ${destFilename} para bloque ${block.position}. Checksum mismatch.`);
      }

      // Metadata extraction
      let durationSeconds = null;
      let dimensions = null;

      if (kind === 'audio') {
        durationSeconds = await extractAudioDuration(provider, destPath);
      } else if (kind === 'infographic') {
        dimensions = await extractImageDimensions(destPath);
      }

      deliveredMaterialsCount++;
      blockEntry.materials[kind] = {
        delivered: true,
        filename: destFilename,
        relativePath: `${blockFolder}/${destFilename}`,
        sizeBytes: postStat.size,
        sha256: postSha256,
        editorialState: item.task?.editorial_state || 'unreviewed',
        revision: item.task?.revision || 1,
        durationSeconds,
        dimensions
      };
    }

    deliveredBlocks.push(blockEntry);
  }

  const manifest = {
    schemaVersion: '1.0.0',
    deliveryId,
    requestId,
    createdAt: Date.now(),
    book: {
      id: book.id,
      title: book.title
    },
    recipe: {
      id: recipe.id,
      version: recipe.version,
      name: recipe.name
    },
    policy: {
      requireApproved,
      allowPartial
    },
    summary: {
      totalBlocks: allBlocks.length,
      deliveredBlocks: deliveredBlocks.length,
      requiredMaterials: allBlocks.length * enabledKinds.length,
      deliveredMaterials: deliveredMaterialsCount,
      missingMaterials: missingMaterialsCount,
      isComplete: missingMaterialsCount === 0
    },
    blocks: deliveredBlocks
  };

  // Write manifest.json
  await writeFile(join(tempDeliveryDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // Write index.html
  const htmlContent = generateDeliveryHtml(manifest);
  await writeFile(join(tempDeliveryDir, 'index.html'), htmlContent, 'utf8');

  // Write index.csv
  const csvContent = generateDeliveryCsv(manifest);
  await writeFile(join(tempDeliveryDir, 'index.csv'), csvContent, 'utf8');

  // Atomic promote to final directory
  await rename(tempDeliveryDir, finalDeliveryDir);

  // Record audit event
  store.recordProductionEvent({
    bookId: book.id,
    event: 'delivery_created',
    fromState: manifest.summary.isComplete ? 'complete' : 'partial',
    toState: 'delivered',
    reason: deliveryId
  });

  return {
    ok: true,
    deliveryId,
    path: finalDeliveryDir,
    relativePath: `entregas/${book.id}/${deliveryId}`,
    summary: manifest.summary,
    manifest
  };
}

export async function listDeliveries({ exportsDir, bookId }) {
  const deliveriesDir = join(resolve(exportsDir), 'entregas', bookId);
  try {
    const entries = await readdir(deliveriesDir, { withFileTypes: true });
    const deliveries = [];
    for (const ent of entries) {
      if (ent.isDirectory() && !ent.name.startsWith('.')) {
        const manifestPath = join(deliveriesDir, ent.name, 'manifest.json');
        try {
          const content = await readFile(manifestPath, 'utf8');
          const manifest = JSON.parse(content);
          deliveries.push({
            id: ent.name,
            createdAt: manifest.createdAt || null,
            recipe: manifest.recipe,
            summary: manifest.summary,
            path: join(deliveriesDir, ent.name)
          });
        } catch {}
      }
    }
    deliveries.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return deliveries;
  } catch {
    return [];
  }
}

export async function getDelivery({ exportsDir, bookId, deliveryId }) {
  const safeId = safeName(deliveryId);
  const manifestPath = join(resolve(exportsDir), 'entregas', bookId, safeId, 'manifest.json');
  const content = await readFile(manifestPath, 'utf8');
  return JSON.parse(content);
}

function generateDeliveryHtml(manifest) {
  const b = manifest.book;
  const s = manifest.summary;
  const dateStr = new Date(manifest.createdAt).toLocaleString('es-BO', { timeZone: 'America/La_Paz' });

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(b.title)} · Entrega de Materiales</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 2rem;
      line-height: 1.5;
    }
    .container {
      max-width: 1000px;
      margin: 0 auto;
    }
    header {
      border-bottom: 1px solid var(--border);
      padding-bottom: 1.5rem;
      margin-bottom: 2rem;
    }
    h1 {
      margin: 0 0 0.5rem 0;
      font-size: 1.8rem;
    }
    .badge {
      display: inline-block;
      padding: 0.25rem 0.6rem;
      border-radius: 4px;
      font-size: 0.8rem;
      font-weight: 600;
    }
    .badge-success { background: rgba(16, 185, 129, 0.2); color: #34d399; }
    .badge-warning { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
    .badge-missing { background: rgba(239, 68, 68, 0.2); color: #f87171; }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .metric-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
      text-align: center;
    }
    .metric-card strong {
      display: block;
      font-size: 1.8rem;
      color: var(--primary);
    }
    .metric-card small {
      color: var(--text-muted);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }
    th, td {
      padding: 0.85rem 1rem;
      border-bottom: 1px solid var(--border);
      text-align: left;
    }
    th {
      background: #111827;
      color: var(--text-muted);
      font-weight: 600;
      font-size: 0.85rem;
      text-transform: uppercase;
    }
    tr:last-child td {
      border-bottom: none;
    }
    audio {
      height: 36px;
      vertical-align: middle;
      max-width: 240px;
    }
    a {
      color: var(--primary);
      text-decoration: none;
      font-weight: 500;
    }
    a:hover {
      text-decoration: underline;
    }
    footer {
      margin-top: 3rem;
      text-align: center;
      color: var(--text-muted);
      font-size: 0.85rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>${escapeHtml(b.title)}</h1>
      <p style="color: var(--text-muted); margin: 0 0 0.5rem 0;">
        Receta: <strong>${escapeHtml(manifest.recipe?.name || 'Estándar')}</strong> · Entrega: <code>${escapeHtml(manifest.deliveryId)}</code> · Fecha: ${escapeHtml(dateStr)}
      </p>
      <div>
        ${s.isComplete
          ? '<span class="badge badge-success">✓ Entrega Completa</span>'
          : '<span class="badge badge-warning">⚠ Entrega Parcial</span>'}
      </div>
    </header>

    <div class="metrics-grid">
      <div class="metric-card">
        <strong>${s.totalBlocks}</strong>
        <small>Total Capítulos</small>
      </div>
      <div class="metric-card">
        <strong>${s.deliveredMaterials} / ${s.requiredMaterials}</strong>
        <small>Materiales Entregados</small>
      </div>
      <div class="metric-card">
        <strong>${s.missingMaterials}</strong>
        <small>Materiales Faltantes</small>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th style="width: 50px;">#</th>
          <th>Capítulo / Bloque</th>
          <th>Audio (Podcast)</th>
          <th>Infografía</th>
        </tr>
      </thead>
      <tbody>
        ${manifest.blocks.map(blk => {
          const audio = blk.materials?.audio;
          const info = blk.materials?.infographic;

          const audioCell = audio?.delivered
            ? `<audio controls preload="none" src="${escapeHtml(audio.relativePath)}"></audio><br><a href="${escapeHtml(audio.relativePath)}" download>Descargar MP3</a>`
            : `<span class="badge badge-missing">Faltante</span>`;

          const infoCell = info?.delivered
            ? `<a href="${escapeHtml(info.relativePath)}" target="_blank">👁️ Ver Infografía (PNG)</a>`
            : `<span class="badge badge-missing">Faltante</span>`;

          return `<tr>
            <td><strong>${blk.position}</strong></td>
            <td><strong>${escapeHtml(blk.title)}</strong></td>
            <td>${audioCell}</td>
            <td>${infoCell}</td>
          </tr>`;
        }).join('\n')}
      </tbody>
    </table>

    <footer>
      Generado automáticamente por BloqueAudio · Archivos organizados con sumas de comprobación SHA-256.
    </footer>
  </div>
</body>
</html>`;
}

function generateDeliveryCsv(manifest) {
  const headers = ['Numero', 'Bloque', 'Audio_Archivo', 'Audio_Duracion_Segundos', 'Audio_SHA256', 'Infografia_Archivo', 'Infografia_SHA256', 'Estado'];
  const rows = [headers.map(safeCsv).join(',')];

  for (const blk of manifest.blocks) {
    const audio = blk.materials?.audio;
    const info = blk.materials?.infographic;

    const row = [
      safeCsv(blk.position),
      safeCsv(blk.title),
      safeCsv(audio?.delivered ? audio.relativePath : ''),
      safeCsv(audio?.delivered && audio.durationSeconds ? audio.durationSeconds : ''),
      safeCsv(audio?.delivered ? audio.sha256 : ''),
      safeCsv(info?.delivered ? info.relativePath : ''),
      safeCsv(info?.delivered ? info.sha256 : ''),
      safeCsv(audio?.delivered && info?.delivered ? 'Completo' : 'Incompleto')
    ];
    rows.push(row.join(','));
  }

  return rows.join('\r\n');
}
