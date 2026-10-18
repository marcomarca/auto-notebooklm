import { randomUUID } from 'node:crypto';
import { title } from './store.mjs';
import { redact, ProviderError } from './provider.mjs';
import { profileId } from './accounts.mjs';

export function normalizeArtifactType(type) {
  if (!type) return 'unknown';
  const t = String(type).toLowerCase().trim();
  if (t === 'audio' || t.includes('audio') || t.includes('podcast')) return 'audio';
  if (t === 'video' || t.includes('video')) return 'video';
  if (t === 'report' || t.includes('report') || t.includes('informe')) return 'report';
  if (t === 'slides' || t.includes('slide') || t.includes('diapositiva')) return 'slides';
  if (t === 'quiz' || t.includes('quiz') || t.includes('cuestionario')) return 'quiz';
  if (t === 'flashcards' || t.includes('flashcard') || t.includes('tarjetas')) return 'flashcards';
  if (t === 'data_table' || t.includes('data_table') || t.includes('tabla')) return 'data_table';
  if (t === 'mind_map' || t.includes('mind_map') || t.includes('mapa')) return 'mind_map';
  if (t === 'infographic' || t.includes('infographic') || t.includes('infografia')) return 'infographic';
  return 'unknown';
}

export function normalizeStatus(status) {
  if (status === null || status === undefined) return 'unknown';
  if (typeof status === 'number') {
    if (status === 2) return 'completed';
    if (status === 3) return 'failed';
    return 'generating';
  }
  const s = String(status).toLowerCase().trim();
  if (['completed', 'ready', 'done'].includes(s)) return 'completed';
  if (['failed', 'error'].includes(s)) return 'failed';
  if (['queued', 'pending'].includes(s)) return 'queued';
  if (['generating', 'processing', 'in_progress', 'running'].includes(s)) return 'generating';
  return 'unknown';
}

export async function syncNotebook({ store, accounts, profile: rawProfile, remoteId, requestId }) {
  const profile = profileId(rawProfile);
  const account = accounts.ensure(profile);

  let book = store.get('SELECT * FROM books WHERE profile=? AND remote_id=?', profile, remoteId);
  if (!book) {
    book = store.importRemoteBook({
      remoteId,
      title: 'Cuaderno remoto',
      profile,
      email: account.email || null
    });
  }

  // Deduplicate in-flight sync operation for the same book and profile
  const existingOp = store.get("SELECT * FROM remote_operations WHERE book_id=? AND profile=? AND type='sync' AND state='running'", book.id, profile);
  if (existingOp) {
    return { operationId: existingOp.id, bookId: book.id, deduplicated: true };
  }

  const op = store.createRemoteOperation({
    requestId: requestId || null,
    bookId: book.id,
    profile,
    type: 'sync',
    state: 'running'
  });

  const provider = accounts.get(profile);
  const rev = Date.now();
  const results = {
    title: null,
    sources: { complete: false, items: [], error: null, errorCode: null },
    artifacts: { complete: false, items: [], truncated: false, error: null, errorCode: null },
    notes: { complete: false, items: [], error: null, errorCode: null }
  };
  const counts = { sources: 0, artifacts: 0, notes: 0, new: 0, updated: 0, not_visible: 0 };

  // 1. Fetch remote notebook list to verify session/title
  try {
    const list = await provider.listBooks();
    const match = list.find(b => (b.id || b.notebook_id) === remoteId);
    if (match?.title) {
      results.title = match.title;
      const cleanTitle = title(match.title);
      store.update('books', book.id, {
        title: book.origin === 'remote_linked' ? cleanTitle : book.title,
        remote_title: match.title
      });
    }
  } catch (e) {
    results.titleError = redact(e.message);
  }

  // 2. Fetch sources
  try {
    const srcList = await provider.sources(remoteId);
    results.sources.complete = true;
    results.sources.items = srcList;
  } catch (e) {
    results.sources.error = redact(e.message);
    results.sources.errorCode = e.code || 'PROVIDER';
  }

  // 3. Fetch studio artifacts with completeness / truncation tracking
  try {
    let artRes;
    if (provider.artifactsDetailed) {
      artRes = await provider.artifactsDetailed(remoteId);
    } else {
      const maybeDetailed = await provider.artifacts(remoteId, null, { detailed: true });
      if (maybeDetailed && typeof maybeDetailed === 'object' && Array.isArray(maybeDetailed.items)) {
        artRes = maybeDetailed;
      } else {
        artRes = { items: maybeDetailed || [], truncated: false };
      }
    }
    results.artifacts.complete = !artRes.truncated;
    results.artifacts.truncated = !!artRes.truncated;
    results.artifacts.items = artRes.items || [];
  } catch (e) {
    results.artifacts.error = redact(e.message);
    results.artifacts.errorCode = e.code || 'PROVIDER';
  }

  // 4. Fetch notes
  try {
    if (provider.notes) {
      results.notes.items = await provider.notes(remoteId);
      results.notes.complete = true;
    }
  } catch (e) {
    results.notes.error = redact(e.message);
    results.notes.errorCode = e.code || 'PROVIDER';
  }

  // 5. Short transactional upsert per complete section
  if (results.sources.complete) {
    store.transaction(() => {
      for (const s of results.sources.items) {
        const sId = s.id || s.source_id;
        if (!sId) continue;
        const sTitle = s.title || 'Fuente sin título';
        const existing = store.remoteItemByRemoteId(book.id, 'source', sId);
        if (!existing) counts.new++; else counts.updated++;
        const sStatus = (s.status === 2 || ['ready', 'completed'].includes(s.status)) ? 'ready' : (s.status === 3 || s.status === 'failed') ? 'failed' : 'processing';
        store.upsertRemoteItem({
          bookId: book.id,
          kind: 'source',
          remoteId: sId,
          type: 'source',
          originalType: 'source',
          title: sTitle,
          status: sStatus,
          originalStatus: String(s.status ?? ''),
          lastSeenAt: rev,
          syncRev: rev
        });
        counts.sources++;
      }
      store.markAbsentRemoteItems(book.id, 'source', rev);
    });
  }

  if (results.artifacts.items.length > 0 || results.artifacts.complete) {
    store.transaction(() => {
      const localBlocks = store.blocks(book.id);
      const blockMap = new Map(localBlocks.filter(b => b.artifact_id).map(b => [b.artifact_id, b.id]));

      for (const a of results.artifacts.items) {
        const aId = a.artifact_id || a.id;
        if (!aId) continue;
        const normType = normalizeArtifactType(a.type);
        const normStatus = normalizeStatus(a.status);
        const existing = store.remoteItemByRemoteId(book.id, 'artifact', aId);
        if (!existing) counts.new++; else counts.updated++;
        let finalStatus = normStatus;
        let finalErrorReason = a.error_reason || null;
        if (existing && (existing.status === 'deleted_confirmed' || existing.status === 'reappeared')) {
          finalStatus = 'reappeared';
          finalErrorReason = 'El contenido eliminado reapareció en NotebookLM. Se requiere revisión manual.';
        } else if (existing && existing.status === 'delete_uncertain') {
          finalStatus = 'delete_uncertain';
          finalErrorReason = 'Eliminación incierta; el elemento sigue presente en NotebookLM.';
        }
        store.upsertRemoteItem({
          bookId: book.id,
          kind: 'artifact',
          remoteId: aId,
          type: normType,
          originalType: a.type || null,
          title: a.title || 'Sin título',
          status: finalStatus,
          originalStatus: String(a.status ?? ''),
          sourceIdsJson: JSON.stringify(a.source_ids || []),
          createdTime: a.created_time || (a.created_at ? Date.parse(a.created_at) : null),
          modifiedTime: a.modified_time || (a.modified_at ? Date.parse(a.modified_at) : null),
          errorReason: finalErrorReason,
          lastSeenAt: rev,
          syncRev: rev,
          blockId: blockMap.get(aId) || null
        });
        counts.artifacts++;
      }
      if (results.artifacts.complete && !results.artifacts.truncated) {
        store.markAbsentRemoteItems(book.id, 'artifact', rev);
        const pendingOps = store.all("SELECT * FROM remote_operations WHERE book_id=? AND type='delete_artifact' AND state='uncertain'", book.id);
        for (const op of pendingOps) {
          const item = store.remoteItemByRemoteId(book.id, 'artifact', op.target_id);
          if (item && item.not_visible) {
            store.update('remote_operations', op.id, { state: 'confirmed', completed_at: Date.now() });
            store.update('remote_items', item.id, { status: 'deleted_confirmed' });
          }
        }
      }
    });
  }

  if (results.notes.complete) {
    store.transaction(() => {
      for (const n of results.notes.items) {
        const nId = n.id || n.note_id;
        if (!nId) continue;
        const existing = store.remoteItemByRemoteId(book.id, 'note', nId);
        if (!existing) counts.new++; else counts.updated++;
        store.upsertRemoteItem({
          bookId: book.id,
          kind: 'note',
          remoteId: nId,
          type: 'note',
          originalType: 'note',
          title: n.title || 'Nota',
          status: 'completed',
          originalStatus: 'completed',
          lastSeenAt: rev,
          syncRev: rev
        });
        counts.notes++;
      }
      store.markAbsentRemoteItems(book.id, 'note', rev);
    });
  }

  counts.not_visible = store.get('SELECT COUNT(*) as c FROM remote_items WHERE book_id=? AND not_visible=1', book.id)?.c || 0;

  const anySectionFailed = !results.sources.complete || !results.artifacts.complete;
  const allFailed = !results.sources.complete && !results.artifacts.complete;
  const opState = allFailed ? 'failed' : anySectionFailed ? 'partial' : 'confirmed';

  const summary = {
    rev,
    sections: {
      sources: { complete: results.sources.complete, error: results.sources.error, errorCode: results.sources.errorCode },
      artifacts: { complete: results.artifacts.complete, truncated: results.artifacts.truncated, error: results.artifacts.error, errorCode: results.artifacts.errorCode },
      notes: { complete: results.notes.complete, error: results.notes.error, errorCode: results.notes.errorCode }
    },
    counts
  };

  store.update('remote_operations', op.id, {
    state: opState,
    completed_at: Date.now(),
    error: results.artifacts.error || results.sources.error || null,
    error_code: results.artifacts.errorCode || results.sources.errorCode || null,
    summary_json: JSON.stringify(summary)
  });

  store.update('books', book.id, {
    last_synced_at: rev,
    last_sync_full: opState === 'confirmed' ? 1 : 0,
    sync_error: anySectionFailed ? (results.artifacts.error || results.sources.error || 'Sincronización parcial.') : null,
    sync_error_code: results.artifacts.errorCode || results.sources.errorCode || null
  });

  return {
    ok: opState !== 'failed',
    operationId: op.id,
    bookId: book.id,
    state: opState,
    summary
  };
}
