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
    store.recover();
  }
  start() {
    const run = () => this.tick().catch(e => { this.provider.health.error = `Error de cola: ${redact(e.message)}`; });
    this.timer = setInterval(run, 1000);
    this.timer.unref(); run();
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer);
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
    const runnable = b => !['done', 'review', 'auth'].includes(b.state) && b.next_at <= now && !(b.state === 'error' && b.attempts > 3);

    // 1. Fast local download & convert jobs
    const local = all.find(({ block }) => ['download', 'convert'].includes(block.stage) && runnable(block));
    if (local) return this.runBlock(local.book, local.block);

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

    for (const b of books.filter(b => b.running)) {
      const blocks = this.store.blocks(b.id);
      if (blocks.length && blocks.every(x => x.state === 'done')) this.store.update('books', b.id, { running: 0 });
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
    this.store.update('blocks', block.id, { artifact_id: matches[0].artifact_id || matches[0].id, baseline: null, stage: 'poll', state: 'generating', attempts: 0, next_at: 0, error: null, error_code: null });
  }
  async runBlock(book, block) {
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
        if (readySource(row)) this.store.update('blocks', block.id, { stage: 'generate', state: 'ready', next_at: 0, attempts: 0, error: null, error_code: null });
        else if (this.now() - block.started_at > 30 * 60 * 1000) throw new ProviderError('REJECTED', 'La fuente lleva más de 30 minutos procesándose. Comprueba NotebookLM y reintenta la consulta.');
        else this.store.update('blocks', block.id, { state: 'source_processing', next_at: this.now() + 15000 });
      } else if (block.stage === 'generate') {
        if (block.baseline) return await this.reconcileAudio(book, block);
        if (!block.source_id) throw new ProviderError('REJECTED', 'Falta el ID de la fuente. No se generó audio.');
        const mode = block.generation_mode || book.generation_mode || 'immediate';
        const isLater = mode === 'later';
        if (this.accounts) {
          const candidate = await this.accounts.candidate(book, block.source_id);
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
        // The pause may have arrived while the preflight request was running.
        if (!this.store.book(book.id).running) return;
        if (this.accounts && (!this.accounts.ensure(provider.profile).enabled ||
          (provider.profile !== book.profile && !this.store.get('SELECT profile FROM book_accounts WHERE book_id=? AND profile=?', book.id, provider.profile)))) return;
        this.store.update('books', book.id, { quota_at: 0, quota_error: null });
        this.store.update('blocks', block.id, { state: 'submitting', locked: 1, generation_profile: provider.profile, baseline: JSON.stringify(before), started_at: this.now() });
        const artifactId = await provider.generate(book.remote_id, block.source_id, { defer: isLater });
        this.store.update('blocks', block.id, { artifact_id: artifactId, baseline: null, state: isLater ? 'deferred' : 'generating', stage: 'poll', attempts: 0, next_at: this.now() + 15000, error: null, error_code: null });
      } else if (block.stage === 'poll') {
        const rows = await provider.artifacts(book.remote_id, block.artifact_id);
        const audio = rows.find(a => (a.artifact_id || a.id) === block.artifact_id);
        if (!audio) throw new ProviderError('TEMPORARY', 'El audio todavía no aparece en NotebookLM.');
        if (audio.source_ids?.length && (audio.source_ids.length !== 1 || audio.source_ids[0] !== block.source_id))
          throw new ProviderError('REVIEW', 'El audio informa fuentes distintas al bloque. Descarga detenida para revisión.');
        if (['failed', 'error'].includes(audio.status)) throw new ProviderError('ARTIFACT_FAILED', redact(audio.error_reason || 'NotebookLM no pudo generar el audio.'));
        if (['completed', 'ready'].includes(audio.status)) {
          const bookRow = this.store.book(book.id) || book;
          const resolved = this.store.resolveBlockOutputPaths(bookRow, this.store.blocks(book.id), this.exportsDir);
          const target = resolved.get(block.id);
          const dir = join(this.exportsDir, exportDirName(bookRow));
          const original = join(this.dataDir, 'audio', `${block.id}.m4a`);
          await mkdir(dir, { recursive: true }); await mkdir(join(this.dataDir, 'audio'), { recursive: true });
          this.store.update('blocks', block.id, { state: 'download', stage: 'download', next_at: 0, attempts: 0,
            original_path: original, output_path: target?.outputPath || join(dir, formatBlockOutputName(block, bookRow.numbering)), error: null, error_code: null });
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
        if (!(await exists(block.original_path))) await provider.download(book.remote_id, block.artifact_id, block.original_path);
        this.store.update('blocks', block.id, { state: 'convert', stage: 'convert', next_at: 0, attempts: 0, error: null, error_code: null });
      } else if (block.stage === 'convert') {
        await provider.convert(block.original_path, block.output_path);
        this.store.update('blocks', block.id, { state: 'done', next_at: 0, attempts: 0, error: null, error_code: null });
      }
    } catch (error) {
      const current = this.store.block(block.id);
      if (block.baseline && current.baseline) error.uncertain = true;
      // Before dispatch there is no uncertain operation: a failed preflight can use a backup.
      if (this.accounts && current.stage === 'generate' && !current.baseline && ['AUTH_REQUIRED', 'TEMPORARY'].includes(error.code)) {
        this.store.update('accounts', provider.profile, { retry_at: this.now() + (error.code === 'TEMPORARY' ? 60000 : thirtyMinutes), error: redact(error.message), error_code: error.code });
        if (error.code === 'AUTH_REQUIRED') provider.health = { ...provider.health, ready: false, auth: false, error: redact(error.message), errorCode: error.code };
        this.store.update('blocks', block.id, { state: 'ready', generation_profile: null, next_at: 0, error: null, error_code: null, attempts: 0 });
        return;
      }
      if (error.code === 'QUOTA' && !error.uncertain && current.stage === 'generate') {
        this.store.update('blocks', block.id, { baseline: null });
        let usage; try { usage = await provider.usage(); } catch {}
        if (this.accounts) {
          this.accounts.exhausted(provider.profile, quotaRetry(usage, this.now()) || this.now() + thirtyMinutes, redact(error.message));
          this.store.update('blocks', block.id, { state: 'ready', generation_profile: null, next_at: 0, attempts: 0, error: null, error_code: null });
          return;
        }
        return this.defer(book, current, quotaRetry(usage, this.now()) || this.now() + thirtyMinutes, redact(error.message));
      }
      this.fail('blocks', current, error, provider);
    }
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
    if (!['error', 'review', 'auth', 'quota'].includes(block.state)) return;
    const changes = { state: block.baseline ? (block.stage === 'upload' ? 'uploading' : 'submitting') : ({ upload: 'upload_pending', source: 'source_processing', generate: 'ready', poll: 'generating', download: 'download', convert: 'convert' }[block.stage]), attempts: 0, next_at: 0, error: null, error_code: null };
    if (block.error_code === 'ARTIFACT_FAILED') Object.assign(changes, { stage: 'generate', state: 'ready', artifact_id: null, baseline: null });
    this.store.update('blocks', id, changes);
    if (block.state === 'quota') this.store.update('books', block.book_id, { quota_at: 0, quota_error: null });
  }
  retryBook(id) {
    const book = this.store.book(id);
    if (!book) throw new Error('Libro inexistente.');
    if (book.remote_id) return;
    this.store.update('books', id, { state: book.baseline ? 'creating' : 'pending', attempts: 0, next_at: 0, error: null, error_code: null });
  }
}
