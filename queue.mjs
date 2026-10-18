import { mkdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { safeName, exportDirName, formatBlockOutputName } from './store.mjs';
import { ProviderError, redact } from './provider.mjs';

const thirtyMinutes = 30 * 60 * 1000;
export function quotaRetry(usage, now = Date.now()) {
  const exhausted = (usage?.windows || []).filter(w => typeof w.percent_remaining === 'number' && w.percent_remaining <= 0);
  if (!exhausted.length) return 0;
  const resets = exhausted.map(w => Date.parse(w.resets_at));
  return resets.every(t => Number.isFinite(t) && t > now) ? Math.max(...resets) + 60000 : now + thirtyMinutes;
}
function ids(rows) { return rows.map(r => r.artifact_id || r.source_id || r.id).filter(Boolean); }
function readySource(row) { return row?.status === 2 || ['ready', 'completed'].includes(row?.status); }
function exists(file) { return stat(file).then(s => s.size > 128, () => false); }

export class Queue {
  constructor(store, provider, { dataDir, exportsDir, now = Date.now, accounts } = {}) {
    this.store = store; this.provider = provider; this.dataDir = dataDir; this.exportsDir = exportsDir; this.now = now;
    this.busy = false; this.stopped = false; this.active = null;
    this.accounts = accounts;
    this.controllers = new Map();
    store.recover();
  }
  start() {
    const run = () => this.tick().catch(e => { this.provider.health.error = `Error de cola: ${redact(e.message)}`; });
    this.timer = setInterval(run, 1000);
    this.timer.unref(); run();
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer);
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    if (this.accounts) await this.accounts.close(); else await this.provider.close();
    if (this.active) await this.active;
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    this.active = this.step();
    try { return await this.active; } finally { this.busy = false; this.active = null; }
  }
  async step() {
    const now = this.now();
    const books = this.store.books().filter(b => this.accounts || b.profile === this.provider.profile);
    // Track an already submitted audio even if the book was paused or quota ran out.
    const all = books.flatMap(book => this.store.blocks(book.id).map(block => ({ book, block })));
    const runnable = b => !['done', 'review', 'auth', 'canceled'].includes(b.state) && !b.canceled_at && b.next_at <= now && !(b.state === 'error' && b.attempts > 3);

    // 0. Non-audio download jobs from remote items
    const pendingJob = this.store.get("SELECT * FROM download_jobs WHERE state='queued' AND next_at <= ? ORDER BY created_at LIMIT 1", now);
    if (pendingJob) return this.runDownloadJob(pendingJob);

    // 0.1 Fast non-audio material task downloads (e.g. infographic)
    const matDownload = this.store.get("SELECT * FROM material_tasks WHERE is_current=1 AND type != 'audio' AND state='download_pending' AND next_at <= ? ORDER BY created_at LIMIT 1", now);
    if (matDownload) return this.runMaterialTask(matDownload);

    // 1. Fast local download & convert jobs
    const local = all.find(({ block }) => ['download', 'convert'].includes(block.stage) && runnable(block));
    if (local) return this.runBlock(local.book, local.block);

    // 1.1 Non-audio material task polling (e.g. infographic)
    const matPoll = this.store.get("SELECT * FROM material_tasks WHERE is_current=1 AND type != 'audio' AND state='remote_pending' AND next_at <= ? ORDER BY next_at ASC LIMIT 1", now);
    if (matPoll) return this.runMaterialTask(matPoll);

    // 2. Poll audios in Google's cloud generation whose timer has elapsed
    const polling = all.find(({ block }) => block.stage === 'poll' && runnable(block));
    if (polling) return this.runBlock(polling.book, polling.block);

    // 3. Submitted jobs always keep their original profile. New uploads use the owner.
    const healthy = [];
    for (const id of new Set(books.map(b => b.profile))) {
      const p = this.providerFor({ profile: id });
      const a = this.accounts?.ensure(id);
      if (a && !a.enabled) continue;
      if (this.accounts && !p.health.ready && a.retry_at <= now) await this.accounts.check(id);
      if (p.health.ready) healthy.push(id);
    }
    if (!this.accounts && !this.provider.health.ready) return;

    // 4. Create book in NotebookLM if needed
    const book = books.find(b => healthy.includes(b.profile) && !b.remote_id && !['review', 'auth'].includes(b.state) && b.next_at <= now && !(b.state === 'error' && b.attempts > 3));
    if (book) return this.runBook(book);

    // 5. Upload source files
    const upload = all.find(({ book, block }) => healthy.includes(book.profile) && book.remote_id && ['upload', 'source'].includes(block.stage) && runnable(block));
    if (upload) return this.runBlock(upload.book, upload.block);

    // 6. Reconcile any uncertain generation baseline
    const uncertain = all.find(({ book, block }) => book.remote_id && block.stage === 'generate' && block.baseline && runnable(block));
    if (uncertain) return this.runBlock(uncertain.book, uncertain.block);

    // 7. Dispatch next audio generation continuously: sends requests to Google one after another
    const next = all.find(({ book, block }) => book.remote_id && book.running && book.quota_at <= now && block.stage === 'generate' && !block.baseline && runnable(block));
    if (next) return this.runBlock(next.book, next.block);

    // 8. Dispatch next non-audio material task (e.g. infographic)
    const matGen = this.store.get("SELECT t.* FROM material_tasks t JOIN books b ON t.book_id=b.id JOIN blocks bl ON t.block_id=bl.id WHERE t.is_current=1 AND t.type != 'audio' AND t.state IN ('planned', 'queued') AND b.running=1 AND (b.quota_at IS NULL OR b.quota_at <= ?) AND bl.source_id IS NOT NULL AND bl.source_id != '' AND t.next_at <= ? ORDER BY t.priority DESC, t.created_at ASC LIMIT 1", now, now);
    if (matGen) return this.runMaterialTask(matGen);

    for (const b of books.filter(b => b.running)) {
      const blocks = this.store.blocks(b.id);
      const tasks = this.store.materialTasks(b.id, { currentOnly: true });
      const blocksDone = !blocks.length || blocks.every(x => x.state === 'done');
      const tasksDone = !tasks.length || tasks.every(t => ['ready', 'canceled', 'failed'].includes(t.state));
      if (blocksDone && tasksDone) this.store.update('books', b.id, { running: 0 });
    }
  }
  providerFor(book, block) {
    return this.accounts ? this.accounts.get(block?.generation_profile || book.profile) : this.provider;
  }
  async runBook(book) {
    const provider = this.providerFor(book);
    try {
      if (book.baseline) {
        const before = JSON.parse(book.baseline);
        const matches = (await provider.listBooks()).filter(b => !before.includes(b.id || b.notebook_id) && b.title === book.remote_title);
        if (matches.length !== 1) throw new ProviderError('REVIEW', 'No se pudo identificar un único cuaderno creado. Abre NotebookLM y pulsa «Comprobar de nuevo».');
        this.store.update('books', book.id, { remote_id: matches[0].id || matches[0].notebook_id, state: 'ready', error: null, error_code: null, next_at: 0, baseline: null, attempts: 0 });
        return;
      }
      const baseline = ids(await provider.listBooks());
      this.store.update('books', book.id, { state: 'creating', baseline: JSON.stringify(baseline), started_at: this.now() });
      const remote = await provider.createBook(book.remote_title);
      this.store.update('books', book.id, { remote_id: remote, state: 'ready', error: null, error_code: null, next_at: 0, baseline: null, attempts: 0 });
    } catch (error) {
      if (book.baseline) error.uncertain = true;
      this.fail('books', this.store.book(book.id), error, provider);
    }
  }
  async reconcileSource(book, block) {
    const before = JSON.parse(block.baseline);
    const rows = await this.providerFor(book).sources(book.remote_id);
    const matches = rows.filter(s => !before.includes(s.id || s.source_id) && [block.source_title, basename(block.file_path)].includes(s.title));
    if (matches.length !== 1) throw new ProviderError('REVIEW', 'No se pudo identificar una única fuente cargada. Comprueba el cuaderno y vuelve a consultar; no se repetirá la carga.');
    const source = matches[0];
    this.store.update('blocks', block.id, { source_id: source.id || source.source_id, baseline: null, state: 'source_processing', stage: 'source', attempts: 0, next_at: 0, error: null, error_code: null });
  }
  async reconcileAudio(book, block) {
    const before = JSON.parse(block.baseline);
    const rows = await this.providerFor(book, block).artifacts(book.remote_id);
    const matches = rows.filter(a => !before.includes(a.artifact_id || a.id) && a.type === 'audio' && a.source_ids?.length === 1 && a.source_ids[0] === block.source_id);
    if (matches.length !== 1) throw new ProviderError('REVIEW', 'No se pudo identificar un único audio de esta fuente. No se solicitará otro: comprueba el cuaderno y vuelve a consultar.');
    const artId = matches[0].artifact_id || matches[0].id;
    const task = this.store.currentMaterialTask(block.id, 'audio');
    if (task) {
      const attempts = this.store.materialAttempts(task.id);
      const lastAtt = attempts.at(-1);
      if (lastAtt) {
        this.store.updateMaterialAttempt(lastAtt.id, { artifact_id: artId, state: 'accepted' });
      }
    }
    if (block.cancel_requested_at || block.canceled_at) {
      this.store.update('blocks', block.id, {
        artifact_id: artId,
        baseline: null,
        state: 'canceled',
        canceled_at: block.canceled_at || this.now(),
        error: 'Cancelado localmente. La generación remota continuó en Google.',
        error_code: 'CANCELED'
      });
      if (task) {
        this.store.updateMaterialTask(task.id, {
          state: 'canceled',
          canceled_at: block.canceled_at || this.now(),
          error: 'Cancelado localmente. La generación remota continuó en Google.',
          error_code: 'CANCELED'
        });
      }
      return;
    }
    this.store.update('blocks', block.id, { artifact_id: artId, baseline: null, stage: 'poll', state: 'generating', attempts: 0, next_at: 0, error: null, error_code: null });
    if (book.quota_error?.includes('inciert') || book.quota_error?.includes('Barrera')) {
      this.store.update('books', book.id, { quota_at: 0, quota_error: null });
    }
    if (task) {
      this.store.updateMaterialTask(task.id, {
        state: 'remote_pending',
        next_at: 0,
        error: null,
        error_code: null
      });
    }
  }
  async runBlock(book, block) {
    const initial = this.store.block(block.id);
    if (!initial || initial.canceled_at || initial.cancel_requested_at || initial.state === 'canceled') return;
    const controller = new AbortController();
    this.controllers.set(block.id, controller);
    let provider = this.providerFor(book, block);
    try {
      if (block.stage === 'upload') {
        if (block.baseline) return await this.reconcileSource(book, block);
        const before = ids(await provider.sources(book.remote_id));
        this.store.update('blocks', block.id, { state: 'uploading', baseline: JSON.stringify(before), started_at: this.now() });
        const sourceId = await provider.upload(book.remote_id, block);
        this.store.update('blocks', block.id, { source_id: sourceId, baseline: null, state: 'source_processing', stage: 'source', attempts: 0, next_at: 0, error: null, error_code: null });
      } else if (block.stage === 'source') {
        const row = (await provider.sources(book.remote_id)).find(s => (s.id || s.source_id) === block.source_id);
        if (!row) throw new ProviderError('REJECTED', 'La fuente ya no existe en el cuaderno.');
        if (row.status === 3 || row.status === 'failed') throw new ProviderError('REJECTED', 'NotebookLM no pudo procesar esta fuente.');
        if (readySource(row)) {
          this.store.upsertRemoteItem({
            bookId: book.id,
            kind: 'source',
            remoteId: block.source_id,
            title: row.title || block.source_title,
            type: 'file',
            status: 'ready',
            originalStatus: String(row.status)
          });
          if (book.origin === 'remote_linked') {
            this.store.update('blocks', block.id, { stage: 'source_ready', state: 'ready', next_at: 0, attempts: 0, error: null, error_code: null });
          } else {
            this.store.update('blocks', block.id, { stage: 'generate', state: 'ready', next_at: 0, attempts: 0, error: null, error_code: null });
          }
        } else if (this.now() - block.started_at > 30 * 60 * 1000) throw new ProviderError('REJECTED', 'La fuente lleva más de 30 minutos procesándose. Comprueba NotebookLM y reintenta la consulta.');
        else this.store.update('blocks', block.id, { state: 'source_processing', next_at: this.now() + 15000 });
      } else if (block.stage === 'generate') {
        if (block.baseline) return await this.reconcileAudio(book, block);
        if (!block.source_id) throw new ProviderError('REJECTED', 'Falta el ID de la fuente. No se generó audio.');
        const mode = block.generation_mode || book.generation_mode || 'immediate';
        const isLater = mode === 'later';
        if (this.accounts) {
          const candidate = await this.accounts.candidate(book, block.source_id);
          if (candidate.barrier) {
            this.store.update('books', book.id, { quota_at: candidate.retryAt, quota_error: 'Barrera de generación incierta activa.' });
            this.store.update('blocks', block.id, { next_at: candidate.retryAt });
            return;
          }
          if (!candidate.provider && !isLater) return this.defer(book, block, candidate.retryAt, 'No hay una cuenta habilitada con sesión, acceso y cuota disponibles. Se comprobará automáticamente.');
          if (candidate.provider) provider = candidate.provider;
        }
        if (!isLater) {
          let usage;
          try { if (!this.accounts) { usage = await provider.usage(); provider.health.usage = usage; } }
          catch (e) {
            if (['AUTH_REQUIRED', 'TEMPORARY', 'UNAVAILABLE'].includes(e.code)) throw e;
            // An unavailable quota read is unknown, not exhausted. Respect any actual generation rejection.
            provider.health.usageWarning = redact(e.message);
          }
          const retryAt = quotaRetry(usage, this.now());
          if (retryAt) return this.defer(book, block, retryAt);
        }
        const before = ids(await provider.artifacts(book.remote_id));
        // Check cancellation and running status right after preflight
        const checkBeforeDispatch = this.store.block(block.id);
        if (!this.store.book(book.id).running || checkBeforeDispatch.cancel_requested_at || checkBeforeDispatch.canceled_at) {
          if (checkBeforeDispatch.cancel_requested_at && !checkBeforeDispatch.canceled_at) {
            this.store.update('blocks', block.id, {
              canceled_at: this.now(),
              state: 'canceled',
              baseline: null,
              error: 'Cancelado localmente antes de enviar a Google.',
              error_code: 'CANCELED'
            });
          }
          return;
        }
        if (this.accounts && (!this.accounts.ensure(provider.profile).enabled ||
          (provider.profile !== book.profile && !this.store.get('SELECT profile FROM book_accounts WHERE book_id=? AND profile=?', book.id, provider.profile)))) return;
        this.store.update('books', book.id, { quota_at: 0, quota_error: null });
        this.store.update('blocks', block.id, { state: 'submitting', locked: 1, generation_profile: provider.profile, baseline: JSON.stringify(before), started_at: this.now() });
        let task = this.store.currentMaterialTask(block.id, 'audio');
        if (!task) {
          task = this.store.createMaterialTask({
            bookId: book.id,
            blockId: block.id,
            type: 'audio',
            recipeId: book.recipe_id || 'default-audio',
            recipeVersion: book.recipe_version || 1,
            sourceFingerprint: block.hash,
            params: { format: 'deep_dive', length: 'default', language: 'es-419', mode },
            state: 'submitting'
          });
        }
        const attemptNumber = (this.store.materialAttempts(task.id).length || 0) + 1;
        const attempt = this.store.createMaterialAttempt({
          taskId: task.id,
          attemptNumber,
          profile: provider.profile,
          remoteNotebookId: book.remote_id,
          sourceIds: [block.source_id],
          baseline: before,
          state: 'submitting'
        });
        this.store.updateMaterialTask(task.id, {
          state: 'submitting',
          selected_attempt_id: attempt.id
        });

        const artifactId = await provider.generate(book.remote_id, block.source_id, { defer: isLater });
        const afterGen = this.store.block(block.id);
        if (afterGen.cancel_requested_at || afterGen.canceled_at) {
          this.store.update('blocks', block.id, {
            artifact_id: artifactId,
            baseline: null,
            state: 'canceled',
            canceled_at: afterGen.canceled_at || this.now(),
            error: 'Cancelado localmente. La generación remota puede haber continuado en Google.',
            error_code: 'CANCELED'
          });
          this.store.updateMaterialAttempt(attempt.id, { artifact_id: artifactId, state: 'accepted' });
          this.store.updateMaterialTask(task.id, {
            state: 'canceled',
            canceled_at: afterGen.canceled_at || this.now(),
            error: 'Cancelado localmente. La generación remota puede haber continuado en Google.',
            error_code: 'CANCELED'
          });
          return;
        }
        this.store.update('blocks', block.id, { artifact_id: artifactId, baseline: null, state: isLater ? 'deferred' : 'generating', stage: 'poll', attempts: 0, next_at: this.now() + 15000, error: null, error_code: null });
        this.store.updateMaterialAttempt(attempt.id, { artifact_id: artifactId, state: 'accepted' });
        this.store.updateMaterialTask(task.id, {
          state: isLater ? 'deferred' : 'remote_pending',
          selected_attempt_id: attempt.id,
          next_at: this.now() + 15000
        });
      } else if (block.stage === 'poll') {
        const rows = await provider.artifacts(book.remote_id, block.artifact_id);
        const audio = rows.find(a => (a.artifact_id || a.id) === block.artifact_id);
        if (!audio) throw new ProviderError('TEMPORARY', 'El audio todavía no aparece en NotebookLM.');
        if (!block.hash?.startsWith('remote-') && audio.source_ids?.length && (audio.source_ids.length !== 1 || audio.source_ids[0] !== block.source_id))
          throw new ProviderError('REVIEW', 'El audio informa fuentes distintas al bloque. Descarga detenida para revisión.');
        if (['failed', 'error'].includes(audio.status)) throw new ProviderError('ARTIFACT_FAILED', redact(audio.error_reason || 'NotebookLM no pudo generar el audio.'));
        if (['completed', 'ready'].includes(audio.status)) {
          const bookRow = this.store.book(book.id) || book;
          const resolved = this.store.resolveBlockOutputPaths(bookRow, this.store.blocks(book.id), this.exportsDir);
          const target = resolved.get(block.id);
          const dir = join(this.exportsDir, exportDirName(bookRow));
          const original = join(this.dataDir, 'audio', `${block.id}.m4a`);
          await mkdir(dir, { recursive: true }); await mkdir(join(this.dataDir, 'audio'), { recursive: true });
          const outPath = target?.outputPath || join(dir, formatBlockOutputName(block, bookRow.numbering));
          this.store.update('blocks', block.id, { state: 'download', stage: 'download', next_at: 0, attempts: 0,
            original_path: original, output_path: outPath, error: null, error_code: null });
          const pollTask = this.store.currentMaterialTask(block.id, 'audio');
          if (pollTask) {
            this.store.updateMaterialTask(pollTask.id, {
              state: 'download_pending',
              output_path: outPath
            });
          }
        } else {
          const mode = block.generation_mode || book.generation_mode || 'immediate';
          const isLater = mode === 'later';
          const pollDelay = isLater
            ? (block.poll_count < 2 ? 30000 : Math.min(15 * 60 * 1000, 60000 * 2 ** Math.min(block.poll_count - 2, 4)))
            : Math.min(60000, 15000 * 2 ** Math.min(block.poll_count, 2));
          const stateLabel = (audio.status === 'queued' || isLater) ? (isLater ? 'deferred' : 'queued') : 'generating';
          this.store.update('blocks', block.id, { state: stateLabel, poll_count: block.poll_count + 1, next_at: this.now() + pollDelay, attempts: 0, error: null, error_code: null });
        }
      } else if (block.stage === 'download') {
        if (!(await exists(block.original_path))) await provider.download(book.remote_id, block.artifact_id, block.original_path, { signal: controller.signal });
        this.store.update('blocks', block.id, { state: 'convert', stage: 'convert', next_at: 0, attempts: 0, error: null, error_code: null });
      } else if (block.stage === 'convert') {
        await provider.convert(block.original_path, block.output_path, { signal: controller.signal });
        this.store.update('blocks', block.id, { state: 'done', next_at: 0, attempts: 0, error: null, error_code: null });
        const convTask = this.store.currentMaterialTask(block.id, 'audio');
        if (convTask) {
          this.store.updateMaterialTask(convTask.id, {
            state: 'ready',
            output_path: block.output_path
          });
          if (convTask.selected_attempt_id) {
            this.store.updateMaterialAttempt(convTask.selected_attempt_id, {
              state: 'resolved',
              resolved_at: this.now()
            });
          }
        }
      }
    } catch (error) {
      const task = this.store.currentMaterialTask(block.id, 'audio');
      if (error.code === 'ABORTED') {
        const cur = this.store.block(block.id);
        this.store.update('blocks', block.id, {
          state: 'canceled',
          canceled_at: cur?.canceled_at || this.now(),
          error: 'Operación cancelada localmente.',
          error_code: 'CANCELED'
        });
        if (task) {
          this.store.updateMaterialTask(task.id, {
            state: 'canceled',
            canceled_at: cur?.canceled_at || this.now(),
            error: 'Operación cancelada localmente.',
            error_code: 'CANCELED'
          });
        }
        return;
      }
      const current = this.store.block(block.id);
      if (block.baseline && current.baseline) error.uncertain = true;
      if (task) {
        let taskState = 'failed';
        if (error.code === 'QUOTA') taskState = 'waiting_quota';
        else if (error.code === 'AUTH_REQUIRED') taskState = 'waiting_auth';
        else if (error.code === 'REVIEW') taskState = 'review_required';
        this.store.updateMaterialTask(task.id, {
          state: taskState,
          error: redact(error.message),
          error_code: error.code || 'PROVIDER'
        });
        if (task.selected_attempt_id && !error.uncertain) {
          this.store.updateMaterialAttempt(task.selected_attempt_id, {
            state: 'failed',
            error: redact(error.message),
            error_code: error.code || 'PROVIDER',
            resolved_at: this.now()
          });
        }
      }
      // Before dispatch there is no uncertain operation: a failed preflight can use a backup.
      if (this.accounts && current.stage === 'generate' && !current.baseline && ['AUTH_REQUIRED', 'TEMPORARY'].includes(error.code)) {
        this.store.update('accounts', provider.profile, { retry_at: this.now() + (error.code === 'TEMPORARY' ? 60000 : thirtyMinutes), error: redact(error.message), error_code: error.code });
        if (error.code === 'AUTH_REQUIRED') provider.health = { ...provider.health, ready: false, auth: false, error: redact(error.message), errorCode: error.code };
        this.store.update('blocks', block.id, { state: 'ready', generation_profile: null, next_at: 0, error: null, error_code: null, attempts: 0 });
        if (task) {
          this.store.updateMaterialTask(task.id, { state: 'queued', selected_attempt_id: null, error: null, error_code: null });
        }
        return;
      }
      if (error.code === 'QUOTA' && !error.uncertain && current.stage === 'generate') {
        this.store.update('blocks', block.id, { baseline: null });
        let usage; try { usage = await provider.usage(); } catch {}
        if (this.accounts) {
          this.accounts.exhausted(provider.profile, quotaRetry(usage, this.now()) || this.now() + thirtyMinutes, redact(error.message));
          this.store.update('blocks', block.id, { state: 'ready', generation_profile: null, next_at: 0, attempts: 0, error: null, error_code: null });
          if (task) {
            this.store.updateMaterialTask(task.id, { state: 'queued', selected_attempt_id: null, error: null, error_code: null });
          }
          return;
        }
        return this.defer(book, current, quotaRetry(usage, this.now()) || this.now() + thirtyMinutes, redact(error.message));
      }
      this.fail('blocks', current, error, provider);
    } finally {
      this.controllers.delete(block.id);
    }
  }
  cancelBlock(id, reason = 'Cancelado por el usuario') {
    const block = this.store.block(id);
    if (!block) throw new Error('Bloque inexistente.');
    const now = this.now();
    if (block.state === 'done') {
      return { ok: true, alreadyDone: true, block };
    }
    const alreadyRemote = Boolean(block.artifact_id || (block.stage === 'generate' && block.baseline));
    this.store.update('blocks', block.id, {
      cancel_requested_at: block.cancel_requested_at || now,
      canceled_at: now,
      cancel_reason: reason,
      state: 'canceled',
      error: alreadyRemote
        ? 'Cancelado localmente. La generación remota puede continuar en Google.'
        : 'Cancelado localmente antes de enviar a Google.',
      error_code: 'CANCELED'
    });
    const cancelTask = this.store.currentMaterialTask(id, 'audio');
    if (cancelTask) {
      this.store.updateMaterialTask(cancelTask.id, {
        state: 'canceled',
        canceled_at: now,
        error: reason,
        error_code: 'CANCELED'
      });
    }
    const controller = this.controllers.get(id);
    if (controller) {
      controller.abort();
      this.controllers.delete(id);
    }
    return {
      ok: true,
      alreadyRemote,
      alreadyDone: false,
      block: this.store.block(id)
    };
  }
  async runDownloadJob(job) {
    const initial = this.store.downloadJob(job.id);
    if (!initial || initial.state === 'canceled') return;
    const controller = new AbortController();
    this.controllers.set(job.id, controller);

    const book = this.store.book(job.book_id);
    if (!book || !book.remote_id) {
      this.store.update('download_jobs', job.id, {
        state: 'error',
        error: 'El cuaderno asociado ya no existe o no está vinculado.',
        error_code: 'NOT_FOUND'
      });
      this.controllers.delete(job.id);
      return;
    }

    const item = this.store.get('SELECT * FROM remote_items WHERE id=?', job.remote_item_id);
    if (!item) {
      this.store.update('download_jobs', job.id, {
        state: 'error',
        error: 'El elemento remoto no existe en el catálogo local.',
        error_code: 'NOT_FOUND'
      });
      this.controllers.delete(job.id);
      return;
    }

    const provider = this.providerFor(book, { generation_profile: job.profile });
    this.store.update('download_jobs', job.id, {
      state: 'downloading',
      attempts: (job.attempts || 0) + 1,
      started_at: this.now()
    });

    try {
      const type = item.type;
      const fmt = job.format;
      const targetPath = job.output_path;
      const signal = controller.signal;

      if (type === 'video') {
        await provider.downloadVideo(book.remote_id, item.remote_id, targetPath, { signal });
      } else if (type === 'report') {
        await provider.downloadReport(book.remote_id, item.remote_id, targetPath, { signal });
      } else if (type === 'slide_deck') {
        await provider.downloadSlideDeck(book.remote_id, item.remote_id, targetPath, { format: fmt, signal });
      } else if (type === 'infographic') {
        await provider.downloadInfographic(book.remote_id, item.remote_id, targetPath, { signal });
      } else if (type === 'mind_map') {
        await provider.downloadMindMap(book.remote_id, item.remote_id, targetPath, { signal });
      } else if (type === 'quiz') {
        await provider.downloadQuiz(book.remote_id, item.remote_id, targetPath, { format: fmt, signal });
      } else if (type === 'flashcards') {
        await provider.downloadFlashcards(book.remote_id, item.remote_id, targetPath, { format: fmt, signal });
      } else if (type === 'data_table') {
        await provider.downloadDataTable(book.remote_id, item.remote_id, targetPath, { signal });
      } else if (type === 'audio') {
        await provider.download(book.remote_id, item.remote_id, targetPath, { signal });
      } else {
        throw new ProviderError('UNSUPPORTED_TYPE', `Tipo de contenido sin adaptador de descarga conocido: ${type}`);
      }

      const st = await stat(targetPath).catch(() => null);
      if (!st || st.size === 0) {
        throw new ProviderError('TEMPORARY', 'El archivo descargado no existe o está vacío.');
      }

      this.store.update('download_jobs', job.id, {
        state: 'done',
        completed_at: this.now(),
        error: null,
        error_code: null
      });
    } catch (error) {
      if (error.code === 'ABORTED' || controller.signal.aborted) {
        this.store.update('download_jobs', job.id, {
          state: 'canceled',
          error: 'Descarga cancelada localmente.',
          error_code: 'CANCELED'
        });
        return;
      }
      const attempts = (job.attempts || 0) + 1;
      const code = error.code || 'DOWNLOAD_ERROR';
      if (code === 'TEMPORARY' && attempts <= 3) {
        const nextAt = this.now() + [15000, 30000, 60000][attempts - 1];
        this.store.update('download_jobs', job.id, {
          state: 'queued',
          next_at: nextAt,
          attempts,
          error: redact(error.message).slice(0, 1200),
          error_code: code
        });
      } else {
        this.store.update('download_jobs', job.id, {
          state: 'error',
          attempts,
          error: redact(error.message).slice(0, 1200),
          error_code: code
        });
      }
    } finally {
      this.controllers.delete(job.id);
    }
  }
  cancelDownloadJob(id, reason = 'Cancelado por el usuario') {
    const job = this.store.downloadJob(id);
    if (!job) throw new Error('Trabajo de descarga inexistente.');
    if (job.state === 'done') return { ok: true, alreadyDone: true, job };
    const now = this.now();
    this.store.update('download_jobs', job.id, {
      state: 'canceled',
      error: 'Descarga cancelada localmente.',
      error_code: 'CANCELED'
    });
    const controller = this.controllers.get(id);
    if (controller) {
      controller.abort();
      this.controllers.delete(id);
    }
    return { ok: true, alreadyDone: false, job: this.store.downloadJob(id) };
  }
  defer(book, block, retryAt, message = 'Cuota agotada. Generar más tarde activado: los pendientes continuarán automáticamente cuando se restablezca la cuota.') {
    this.store.update('books', book.id, { quota_at: retryAt, quota_error: message });
    this.store.update('blocks', block.id, { state: 'quota', next_at: retryAt, error: message, error_code: 'QUOTA', baseline: null });
  }
  fail(table, row, error, provider = this.provider) {
    const code = error.code || 'PROVIDER';
    const attempts = row.attempts + 1;
    let state = 'error', nextAt = 0;
    // Authentication can fail AFTER file upload, during processing or rename. Keep that journal too.
    const definite = !error.uncertain && ['QUOTA', 'UNAVAILABLE'].includes(code);
    if (code === 'AUTH_REQUIRED') state = 'auth';
    else if (code === 'REVIEW') state = 'review';
    else if (row.baseline && !definite) {
      // Preserve the pre-operation journal. Subsequent attempts reconcile instead of recreating.
      nextAt = this.now() + 15000;
      if (attempts > 3) state = 'review';
    } else if (code === 'TEMPORARY' && attempts <= 3) nextAt = this.now() + [15000, 30000, 60000][attempts - 1];
    const changes = { state, error: redact(error.message).slice(0, 1200), error_code: code, next_at: nextAt,
      attempts: nextAt || ['auth', 'review'].includes(state) ? attempts : 4 };
    if (definite) changes.baseline = null;
    this.store.update(table, row.id, changes);
    if (code === 'AUTH_REQUIRED') provider.health = { ...provider.health, ready: false, auth: false, error: `Sesión expirada. Ejecuta nlm login -p ${provider.profile} y comprueba la cuenta.`, errorCode: code };
  }
  retryBlock(id) {
    const block = this.store.block(id);
    if (!block) throw new Error('Bloque inexistente.');
    if (block.canceled_at || block.state === 'canceled') return;
    if (!['error', 'review', 'auth', 'quota'].includes(block.state)) return;
    const changes = { state: block.baseline ? (block.stage === 'upload' ? 'uploading' : 'submitting') : ({ upload: 'upload_pending', source: 'source_processing', generate: 'ready', poll: 'generating', download: 'download', convert: 'convert' }[block.stage]), attempts: 0, next_at: 0, error: null, error_code: null };
    if (block.error_code === 'ARTIFACT_FAILED' && !block.hash?.startsWith('remote-')) Object.assign(changes, { stage: 'generate', state: 'ready', artifact_id: null, baseline: null });
    else if (block.error_code === 'ARTIFACT_FAILED' && block.hash?.startsWith('remote-')) Object.assign(changes, { stage: 'download', state: 'download' });
    this.store.update('blocks', id, changes);
    if (block.state === 'quota') this.store.update('books', block.book_id, { quota_at: 0, quota_error: null });
  }
  retryBook(id) {
    const book = this.store.book(id);
    if (!book) throw new Error('Libro inexistente.');
    if (book.remote_id) return;
    this.store.update('books', id, { state: book.baseline ? 'creating' : 'pending', attempts: 0, next_at: 0, error: null, error_code: null });
  }
  async runMaterialTask(task) {
    const book = this.store.book(task.book_id);
    const block = this.store.block(task.block_id);
    if (!book || !block) return;
    if (task.canceled_at || task.state === 'canceled') return;

    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    let provider = this.providerFor(book, block);

    try {
      if (task.state === 'download_pending') {
        const attempts = this.store.materialAttempts(task.id);
        const lastAttempt = attempts.at(-1);
        const artifactId = lastAttempt?.artifact_id || task.selected_remote_item_id;
        if (!artifactId) throw new ProviderError('REJECTED', 'Falta el ID del artefacto para la descarga.');

        const bookRow = this.store.book(book.id) || book;
        const dir = join(this.exportsDir, exportDirName(bookRow));
        await mkdir(dir, { recursive: true });

        let outPath = task.output_path;
        if (!outPath) {
          const ext = task.type === 'infographic' ? 'png' : (task.type === 'audio' ? 'mp3' : 'dat');
          const baseName = formatBlockOutputName(block, bookRow.numbering).replace(/\.[^.]+$/, '');
          outPath = join(dir, `${baseName}.${ext}`);
        }

        if (task.type === 'infographic') {
          await provider.downloadInfographic(book.remote_id, artifactId, outPath, { signal: controller.signal });
        } else if (task.type === 'audio') {
          await provider.download(book.remote_id, artifactId, outPath, { signal: controller.signal });
        }

        const st = await stat(outPath).catch(() => null);
        if (!st || st.size === 0) {
          throw new ProviderError('TEMPORARY', 'El archivo descargado está vacío.');
        }

        this.store.updateMaterialTask(task.id, {
          state: 'ready',
          output_path: outPath,
          error: null,
          error_code: null
        });

        if (lastAttempt) {
          this.store.updateMaterialAttempt(lastAttempt.id, {
            state: 'resolved',
            resolved_at: this.now()
          });
        }
      } else if (task.state === 'remote_pending') {
        const attempts = this.store.materialAttempts(task.id);
        const lastAttempt = attempts.at(-1);
        let artifactId = lastAttempt?.artifact_id || task.selected_remote_item_id;
        if (!artifactId && lastAttempt?.baseline_json) {
          const before = JSON.parse(lastAttempt.baseline_json);
          const currentArtifacts = await provider.artifacts(book.remote_id);
          const matches = currentArtifacts.filter(a =>
            !before.includes(a.artifact_id || a.id) &&
            a.type === task.type &&
            Array.isArray(a.source_ids) &&
            a.source_ids.includes(block.source_id)
          );
          if (matches.length === 1) {
            artifactId = matches[0].artifact_id || matches[0].id;
            this.store.updateMaterialAttempt(lastAttempt.id, {
              artifact_id: artifactId,
              state: 'accepted'
            });
            if (book.quota_error?.includes('inciert') || book.quota_error?.includes('Barrera')) {
              this.store.update('books', book.id, { quota_at: 0, quota_error: null });
            }
          } else if (matches.length > 1) {
            throw new ProviderError('REVIEW', 'Múltiples artefactos nuevos detectados tras reconciliación. Revisión requerida.');
          } else {
            const nextAt = this.now() + 15000;
            this.store.updateMaterialTask(task.id, {
              state: 'remote_pending',
              next_at: nextAt,
              error: 'Esperando propagación del artefacto generado en NotebookLM.',
              error_code: 'TEMPORARY'
            });
            return;
          }
        }
        if (!artifactId) throw new ProviderError('REJECTED', 'Falta el ID del artefacto.');

        const rows = await provider.artifacts(book.remote_id, artifactId);
        const remoteItem = rows.find(a => (a.artifact_id || a.id) === artifactId);
        if (!remoteItem) throw new ProviderError('TEMPORARY', 'El artefacto todavía no aparece en NotebookLM.');

        if (['failed', 'error'].includes(remoteItem.status)) {
          throw new ProviderError('ARTIFACT_FAILED', redact(remoteItem.error_reason || 'NotebookLM no pudo generar el artefacto.'));
        }

        if (['completed', 'ready'].includes(remoteItem.status)) {
          const bookRow = this.store.book(book.id) || book;
          const dir = join(this.exportsDir, exportDirName(bookRow));
          const ext = task.type === 'infographic' ? 'png' : (task.type === 'audio' ? 'mp3' : 'dat');
          const baseName = formatBlockOutputName(block, bookRow.numbering).replace(/\.[^.]+$/, '');
          const outPath = join(dir, `${baseName}.${ext}`);

          this.store.updateMaterialTask(task.id, {
            state: 'download_pending',
            output_path: outPath,
            next_at: 0,
            attempts: 0,
            error: null,
            error_code: null
          });
        } else {
          const nextAt = this.now() + 15000;
          this.store.updateMaterialTask(task.id, {
            state: 'remote_pending',
            next_at: nextAt,
            error: null,
            error_code: null
          });
        }
      } else if (['planned', 'queued'].includes(task.state)) {
        if (!block.source_id) return;

        // 1. Check for existing single-source artifact in notebook
        const remoteArtifacts = await provider.artifacts(book.remote_id);
        const existingArtifact = remoteArtifacts.find(a =>
          a.type === task.type &&
          Array.isArray(a.source_ids) &&
          a.source_ids.length === 1 &&
          a.source_ids[0] === block.source_id &&
          ['completed', 'ready'].includes(a.status)
        );

        if (existingArtifact) {
          const artId = existingArtifact.artifact_id || existingArtifact.id;
          const bookRow = this.store.book(book.id) || book;
          const dir = join(this.exportsDir, exportDirName(bookRow));
          const ext = task.type === 'infographic' ? 'png' : (task.type === 'audio' ? 'mp3' : 'dat');
          const baseName = formatBlockOutputName(block, bookRow.numbering).replace(/\.[^.]+$/, '');
          const outPath = join(dir, `${baseName}.${ext}`);

          const attemptNumber = (this.store.materialAttempts(task.id).length || 0) + 1;
          const attempt = this.store.createMaterialAttempt({
            taskId: task.id,
            attemptNumber,
            profile: provider.profile,
            remoteNotebookId: book.remote_id,
            sourceIds: [block.source_id],
            state: 'accepted',
            artifactId: artId
          });

          this.store.updateMaterialTask(task.id, {
            state: 'download_pending',
            selected_attempt_id: attempt.id,
            selected_remote_item_id: null,
            output_path: outPath,
            next_at: 0,
            error: null,
            error_code: null
          });
          return;
        }

        // 2. Check cancellation
        const currentTask = this.store.materialTask(task.id);
        if (currentTask.canceled_at || currentTask.state === 'canceled') return;

        // 3. Multi-account candidate check
        if (this.accounts) {
          const candidate = await this.accounts.candidate(book, block.source_id);
          if (candidate.barrier) {
            this.store.updateMaterialTask(task.id, {
              next_at: candidate.retryAt,
              error: 'Cuaderno con generación previa en estado incierto. Esperando reconciliación.',
              error_code: 'BARRIER'
            });
            this.store.update('books', book.id, { quota_at: candidate.retryAt, quota_error: 'Barrera de generación incierta activa.' });
            return;
          }
          if (!candidate.provider) {
            this.store.updateMaterialTask(task.id, {
              state: 'waiting_quota',
              next_at: candidate.retryAt,
              error: 'Esperando cuenta con cuota disponible.',
              error_code: 'QUOTA'
            });
            return;
          }
          provider = candidate.provider;
        }

        const before = ids(await provider.artifacts(book.remote_id));

        const attemptNumber = (this.store.materialAttempts(task.id).length || 0) + 1;
        const attempt = this.store.createMaterialAttempt({
          taskId: task.id,
          attemptNumber,
          profile: provider.profile,
          remoteNotebookId: book.remote_id,
          sourceIds: [block.source_id],
          baseline: before,
          state: 'submitting'
        });

        this.store.updateMaterialTask(task.id, {
          state: 'submitting',
          selected_attempt_id: attempt.id
        });

        const params = task.params_json ? JSON.parse(task.params_json) : {};
        let artifactId;
        if (task.type === 'infographic') {
          artifactId = await provider.generateInfographic(book.remote_id, block.source_id, params);
        } else if (task.type === 'audio') {
          artifactId = await provider.generate(book.remote_id, block.source_id, params);
        } else {
          throw new ProviderError('REJECTED', `Tipo de material no soportado: ${task.type}`);
        }

        const afterGenTask = this.store.materialTask(task.id);
        if (afterGenTask.canceled_at || afterGenTask.state === 'canceled') {
          this.store.updateMaterialAttempt(attempt.id, { artifact_id: artifactId, state: 'accepted' });
          this.store.updateMaterialTask(task.id, {
            state: 'canceled',
            error: 'Cancelado localmente. La generación remota puede haber continuado en Google.',
            error_code: 'CANCELED'
          });
          return;
        }

        this.store.updateMaterialAttempt(attempt.id, { artifact_id: artifactId, state: 'accepted' });
        this.store.updateMaterialTask(task.id, {
          state: 'remote_pending',
          selected_attempt_id: attempt.id,
          next_at: this.now() + 15000,
          error: null,
          error_code: null
        });
      }
    } catch (error) {
      this.handleMaterialTaskError(task, error, provider);
    } finally {
      this.controllers.delete(task.id);
    }
  }
  handleMaterialTaskError(task, error, provider) {
    const code = error.code || 'PROVIDER';
    const attempts = (task.retry_count || 0) + 1;
    let state = 'failed';
    let nextAt = 0;

    if (task.state === 'download_pending') {
      if (attempts <= 3) {
        state = 'download_pending';
        nextAt = this.now() + [15000, 30000, 60000][attempts - 1];
      } else {
        state = 'review_required';
      }
    } else if (code === 'AUTH_REQUIRED') {
      state = 'waiting_auth';
    } else if (code === 'QUOTA') {
      state = 'waiting_quota';
      nextAt = this.now() + 30 * 60 * 1000;
    } else if (code === 'REVIEW' || error.uncertain) {
      state = 'review_required';
    } else if (code === 'TEMPORARY') {
      if (attempts <= 3) {
        state = 'retry_wait';
        nextAt = this.now() + [15000, 30000, 60000][attempts - 1];
      } else {
        state = 'review_required';
      }
    } else if (code === 'ARTIFACT_FAILED') {
      state = 'failed';
    }

    this.store.updateMaterialTask(task.id, {
      state,
      retry_count: attempts,
      next_at: nextAt,
      error: redact(error.message).slice(0, 1200),
      error_code: code
    });

    if (task.selected_attempt_id) {
      this.store.updateMaterialAttempt(task.selected_attempt_id, {
        state: 'failed',
        error: redact(error.message).slice(0, 1200),
        error_code: code
      });
    }

    if (code === 'AUTH_REQUIRED') {
      provider.health = {
        ...provider.health,
        ready: false,
        auth: false,
        error: `Sesión expirada. Ejecuta nlm login -p ${provider.profile} y comprueba la cuenta.`,
        errorCode: code
      };
    }
  }
  cancelMaterialTask(id, reason = 'Cancelado por el usuario') {
    const task = this.store.materialTask(id);
    if (!task) throw new Error('Tarea de material inexistente.');
    if (task.state === 'ready') return { ok: true, alreadyDone: true, task };
    const controller = this.controllers.get(id);
    if (controller) {
      controller.abort();
      this.controllers.delete(id);
    }
    const alreadyRemote = ['submitting', 'remote_pending', 'download_pending'].includes(task.state);
    const msg = alreadyRemote
      ? 'Cancelado localmente. La generación remota puede haber continuado en Google.'
      : (reason || 'Cancelado por el usuario');
    const updated = this.store.cancelMaterialTask(id, msg);
    return { ok: true, alreadyDone: false, alreadyRemote, task: updated };
  }
  retryMaterialTask(id) {
    return this.store.retryMaterialTask(id);
  }
}
