import { createHash, randomUUID } from 'node:crypto';
import { title } from './store.mjs';

export function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(canonicalJson).join(',')}]`;
  }
  const keys = Object.keys(obj).sort();
  const entries = keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${entries.join(',')}}`;
}

export function hashParams(params) {
  return createHash('sha256').update(canonicalJson(params)).digest('hex');
}

export const SUPPORTED_MATERIAL_TYPES = ['audio', 'infographic'];

export const DEFAULT_RECIPES = {
  'default-audio': {
    name: 'Audio estándar',
    materials: {
      audio: { enabled: true, language: 'es-419', format: 'deep_dive', length: 'default' },
      infographic: { enabled: false }
    }
  },
  'study-book': {
    name: 'Libro de estudio (Audio + Infografía)',
    materials: {
      audio: { enabled: true, language: 'es-419', format: 'deep_dive', length: 'default' },
      infographic: { enabled: true, language: 'es-419' }
    }
  }
};

export function validateRecipe(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('Configuración de receta inválida.');
  }
  if (!config.materials || typeof config.materials !== 'object') {
    throw new Error('La receta debe definir un mapa de materiales.');
  }
  for (const [type, settings] of Object.entries(config.materials)) {
    if (!SUPPORTED_MATERIAL_TYPES.includes(type)) {
      throw new Error(`Tipo de material no soportado en este alcance: ${type}. Tipos admitidos: ${SUPPORTED_MATERIAL_TYPES.join(', ')}.`);
    }
    if (typeof settings !== 'object' || settings === null) {
      throw new Error(`Configuración de material ${type} inválida.`);
    }
  }
  return true;
}

export function previewProductionPlan({ store, bookId, recipeId = 'default-audio', recipeVersion, blockIds } = {}) {
  const book = store.book(bookId);
  if (!book) throw new Error('Libro inexistente.');

  const recipe = store.recipe(recipeId, recipeVersion) || store.recipe('default-audio', 1);
  if (!recipe) throw new Error('Receta inexistente.');

  const config = JSON.parse(recipe.config_json);
  validateRecipe(config);

  const allBlocks = store.blocks(bookId);
  const targetBlocks = Array.isArray(blockIds) && blockIds.length > 0
    ? allBlocks.filter(b => blockIds.includes(b.id))
    : allBlocks;

  const requirements = [];
  const summary = {
    totalBlocks: targetBlocks.length,
    totalRequirements: 0,
    toCreate: 0,
    reusable: 0,
    ready: 0,
    outdated: 0,
    reviewRequired: 0,
    canceled: 0
  };

  for (const block of targetBlocks) {
    for (const [type, settings] of Object.entries(config.materials)) {
      if (!settings.enabled) continue;
      summary.totalRequirements++;

      const params = { ...settings };
      delete params.enabled;
      const paramsHash = hashParams(params);
      const currentTask = store.currentMaterialTask(block.id, type);

      let status = 'to_create';
      let existingTaskId = currentTask?.id || null;

      if (currentTask) {
        if (currentTask.state === 'ready') {
          if (currentTask.params_hash === paramsHash && currentTask.source_fingerprint === block.hash) {
            status = 'ready';
            summary.ready++;
          } else {
            status = 'outdated';
            summary.outdated++;
          }
        } else if (['planned', 'queued', 'submitting', 'remote_pending', 'download_pending'].includes(currentTask.state)) {
          if (currentTask.params_hash === paramsHash && currentTask.source_fingerprint === block.hash) {
            status = 'reusable';
            summary.reusable++;
          } else {
            status = 'outdated';
            summary.outdated++;
          }
        } else if (currentTask.state === 'review_required') {
          status = 'review_required';
          summary.reviewRequired++;
        } else if (currentTask.state === 'canceled') {
          status = 'canceled';
          summary.canceled++;
        } else {
          status = 'to_create';
          summary.toCreate++;
        }
      } else {
        summary.toCreate++;
      }

      requirements.push({
        blockId: block.id,
        blockNumber: block.position,
        blockTitle: block.title,
        type,
        status,
        existingTaskId,
        recipeId: recipe.id,
        recipeVersion: recipe.version,
        params,
        paramsHash,
        sourceFingerprint: block.hash
      });
    }
  }

  return {
    bookId,
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    recipeName: recipe.name,
    summary,
    requirements
  };
}

export function confirmProductionPlan({ store, bookId, recipeId, recipeVersion, blockIds, requestId, expectedRevision } = {}) {
  if (!requestId || typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) {
    throw new Error('requestId inválido para confirmar plan de producción.');
  }

  return store.transaction(() => {
    const payloadSignature = hashParams({
      recipeId: recipeId || 'default-audio',
      recipeVersion: recipeVersion || 1,
      blockIds: Array.isArray(blockIds) ? blockIds.slice().sort() : null
    });

    // Check if already applied under this requestId
    const existingEvent = store.get("SELECT * FROM production_events WHERE book_id=? AND event='plan_confirmed' AND reason=?", bookId, requestId);
    if (existingEvent) {
      if (existingEvent.from_state && existingEvent.from_state !== payloadSignature) {
        const conflictErr = new Error('Conflicto: requestId ya utilizado con parámetros diferentes.');
        conflictErr.code = 'CONFLICT';
        conflictErr.status = 409;
        throw conflictErr;
      }
      const existingTasks = store.materialTasks(bookId);
      return {
        ok: true,
        idempotent: true,
        bookId,
        tasks: existingTasks
      };
    }

    const preview = previewProductionPlan({ store, bookId, recipeId, recipeVersion, blockIds });

    // Update book recipe link
    store.update('books', bookId, {
      recipe_id: preview.recipeId,
      recipe_version: preview.recipeVersion
    });

    const createdTasks = [];
    const reusedTasks = [];

    for (const req of preview.requirements) {
      if (req.status === 'to_create' || req.status === 'canceled') {
        const task = store.createMaterialTask({
          bookId,
          blockId: req.blockId,
          type: req.type,
          recipeId: req.recipeId,
          recipeVersion: req.recipeVersion,
          sourceFingerprint: req.sourceFingerprint,
          params: req.params,
          paramsHash: req.paramsHash,
          state: 'planned',
          reason: `Plan confirmado (${requestId})`
        });
        createdTasks.push(task);
      } else if (req.existingTaskId) {
        const existing = store.materialTask(req.existingTaskId);
        if (existing) reusedTasks.push(existing);
      }
    }

    store.recordProductionEvent({
      bookId,
      event: 'plan_confirmed',
      fromState: payloadSignature,
      toState: 'planned',
      reason: requestId
    });

    return {
      ok: true,
      idempotent: false,
      bookId,
      recipeId: preview.recipeId,
      recipeVersion: preview.recipeVersion,
      createdCount: createdTasks.length,
      reusedCount: reusedTasks.length,
      tasks: store.materialTasks(bookId)
    };
  });
}
