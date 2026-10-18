import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function title(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || value.length > 180 || /[\x00-\x1f]/.test(value))
    throw new Error('El título debe tener entre 1 y 180 caracteres, sin caracteres de control.');
  return value.trim();
}

export function safeName(value) {
  let name = String(value).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80).toWellFormed().replace(/[. ]+$/g, '');
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name || 'Sin título'}`;
  return name;
}

export function exportDirName(book) {
  return `${safeName(book.title).slice(0, 60).toWellFormed().replace(/[. ]+$/, '')}-${book.id.slice(0, 8)}`;
}

export function formatBlockOutputName(block, numbering = 1, disambiguator = 0) {
  const clean = safeName(block.title);
  const suffix = disambiguator > 1 ? ` (${disambiguator})` : '';
  return (numbering !== 0 && numbering !== false)
    ? `${String(block.position).padStart(3, '0')} - ${clean}${suffix}.mp3`
    : `${clean}${suffix}.mp3`;
}

export class Store {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.migrate();
  }
  getUserVersion() {
    return Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0);
  }
  migrate() {
    let version = this.getUserVersion();
    if (version < 1) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS books (
            id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
            remote_title TEXT NOT NULL, remote_id TEXT, profile TEXT NOT NULL,
            numbering INTEGER NOT NULL DEFAULT 1,
            state TEXT NOT NULL DEFAULT 'pending', running INTEGER NOT NULL DEFAULT 0,
            error TEXT, error_code TEXT, baseline TEXT, started_at INTEGER,
            attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
            quota_at INTEGER NOT NULL DEFAULT 0, quota_error TEXT,
            created_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS blocks (
            id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id),
            request_id TEXT NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL,
            filename TEXT NOT NULL, file_path TEXT NOT NULL, hash TEXT NOT NULL,
            source_title TEXT NOT NULL, source_id TEXT, artifact_id TEXT,
            state TEXT NOT NULL DEFAULT 'upload_pending', stage TEXT NOT NULL DEFAULT 'upload',
            locked INTEGER NOT NULL DEFAULT 0, error TEXT, error_code TEXT,
            attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
            poll_count INTEGER NOT NULL DEFAULT 0, baseline TEXT, started_at INTEGER,
            output_path TEXT, original_path TEXT, created_at INTEGER NOT NULL,
            UNIQUE(book_id, request_id)
          );
          CREATE UNIQUE INDEX IF NOT EXISTS blocks_content ON blocks(book_id,hash);
          CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY, email TEXT, enabled INTEGER NOT NULL DEFAULT 0,
            retry_at INTEGER NOT NULL DEFAULT 0, error TEXT, error_code TEXT
          );
          CREATE TABLE IF NOT EXISTS book_accounts (
            book_id TEXT NOT NULL REFERENCES books(id), profile TEXT NOT NULL,
            PRIMARY KEY(book_id, profile)
          );
          CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        `);
        this.db.exec('PRAGMA user_version = 1;');
      });
      version = 1;
    }

    if (version < 2) {
      this.transaction(() => {
        const columns = this.all('PRAGMA table_info(blocks)').map(c => c.name);
        if (!columns.includes('generation_profile')) {
          this.db.exec('ALTER TABLE blocks ADD COLUMN generation_profile TEXT');
        }
        this.db.exec(`
          UPDATE blocks SET generation_profile=(SELECT profile FROM books WHERE books.id=blocks.book_id)
          WHERE generation_profile IS NULL AND (artifact_id IS NOT NULL OR (stage='generate' AND baseline IS NOT NULL));
        `);
        this.db.exec('PRAGMA user_version = 2;');
      });
      version = 2;
    }

    if (version < 3) {
      this.transaction(() => {
        const columns = this.all('PRAGMA table_info(books)').map(c => c.name);
        if (!columns.includes('numbering')) {
          this.db.exec('ALTER TABLE books ADD COLUMN numbering INTEGER NOT NULL DEFAULT 1');
        }
        this.db.exec('PRAGMA user_version = 3;');
      });
      version = 3;
    }

    if (version < 4) {
      this.transaction(() => {
        const blockCols = this.all('PRAGMA table_info(blocks)').map(c => c.name);
        if (!blockCols.includes('generation_mode')) {
          this.db.exec("ALTER TABLE blocks ADD COLUMN generation_mode TEXT NOT NULL DEFAULT 'immediate'");
        }
        const bookCols = this.all('PRAGMA table_info(books)').map(c => c.name);
        if (!bookCols.includes('generation_mode')) {
          this.db.exec("ALTER TABLE books ADD COLUMN generation_mode TEXT NOT NULL DEFAULT 'immediate'");
        }
        this.db.exec('PRAGMA user_version = 4;');
      });
      version = 4;
    }

    if (version < 5) {
      this.transaction(() => {
        const bookCols = this.all('PRAGMA table_info(books)').map(c => c.name);
        if (!bookCols.includes('origin')) {
          this.db.exec("ALTER TABLE books ADD COLUMN origin TEXT NOT NULL DEFAULT 'local_created'");
        }
        if (!bookCols.includes('profile_email_at_link')) {
          this.db.exec('ALTER TABLE books ADD COLUMN profile_email_at_link TEXT');
        }
        if (!bookCols.includes('remote_role')) {
          this.db.exec('ALTER TABLE books ADD COLUMN remote_role TEXT');
        }
        if (!bookCols.includes('last_synced_at')) {
          this.db.exec('ALTER TABLE books ADD COLUMN last_synced_at INTEGER');
        }
        if (!bookCols.includes('last_sync_full')) {
          this.db.exec('ALTER TABLE books ADD COLUMN last_sync_full INTEGER NOT NULL DEFAULT 0');
        }
        if (!bookCols.includes('sync_error')) {
          this.db.exec('ALTER TABLE books ADD COLUMN sync_error TEXT');
        }
        if (!bookCols.includes('sync_error_code')) {
          this.db.exec('ALTER TABLE books ADD COLUMN sync_error_code TEXT');
        }

        const blockCols = this.all('PRAGMA table_info(blocks)').map(c => c.name);
        if (!blockCols.includes('cancel_requested_at')) {
          this.db.exec('ALTER TABLE blocks ADD COLUMN cancel_requested_at INTEGER');
        }
        if (!blockCols.includes('canceled_at')) {
          this.db.exec('ALTER TABLE blocks ADD COLUMN canceled_at INTEGER');
        }
        if (!blockCols.includes('cancel_reason')) {
          this.db.exec('ALTER TABLE blocks ADD COLUMN cancel_reason TEXT');
        }
        if (!blockCols.includes('download_policy')) {
          this.db.exec("ALTER TABLE blocks ADD COLUMN download_policy TEXT NOT NULL DEFAULT 'auto'");
        }

        const dupes = this.all('SELECT profile, remote_id, COUNT(*) as c FROM books WHERE remote_id IS NOT NULL GROUP BY profile, remote_id HAVING c > 1');
        if (dupes.length === 0) {
          this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS books_profile_remote ON books(profile, remote_id) WHERE remote_id IS NOT NULL;');
        }

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS remote_items (
            id TEXT PRIMARY KEY,
            book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            remote_id TEXT NOT NULL,
            type TEXT,
            original_type TEXT,
            title TEXT NOT NULL,
            status TEXT,
            original_status TEXT,
            source_ids_json TEXT,
            created_time INTEGER,
            modified_time INTEGER,
            error_reason TEXT,
            last_seen_at INTEGER NOT NULL,
            sync_rev INTEGER NOT NULL DEFAULT 0,
            not_visible INTEGER NOT NULL DEFAULT 0,
            block_id TEXT REFERENCES blocks(id),
            metadata_json TEXT,
            UNIQUE(book_id, kind, remote_id)
          );
          CREATE INDEX IF NOT EXISTS idx_remote_items_book ON remote_items(book_id, kind);

          CREATE TABLE IF NOT EXISTS download_jobs (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL UNIQUE,
            book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            remote_item_id TEXT NOT NULL REFERENCES remote_items(id) ON DELETE CASCADE,
            format TEXT NOT NULL DEFAULT 'original',
            profile TEXT NOT NULL,
            expected_email TEXT,
            state TEXT NOT NULL DEFAULT 'queued',
            attempts INTEGER NOT NULL DEFAULT 0,
            next_at INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            error_code TEXT,
            temp_path TEXT,
            original_path TEXT,
            output_path TEXT,
            created_at INTEGER NOT NULL,
            started_at INTEGER,
            completed_at INTEGER
          );
          CREATE INDEX IF NOT EXISTS idx_download_jobs_state ON download_jobs(state);
          CREATE INDEX IF NOT EXISTS idx_download_jobs_item ON download_jobs(remote_item_id, format);

          CREATE TABLE IF NOT EXISTS remote_operations (
            id TEXT PRIMARY KEY,
            request_id TEXT UNIQUE,
            book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            profile TEXT NOT NULL,
            type TEXT NOT NULL,
            target_id TEXT,
            state TEXT NOT NULL DEFAULT 'pending',
            created_at INTEGER NOT NULL,
            started_at INTEGER,
            completed_at INTEGER,
            error TEXT,
            error_code TEXT,
            summary_json TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_remote_operations_book ON remote_operations(book_id, type);
        `);
        this.db.exec('PRAGMA user_version = 5;');
      });
      version = 5;
    }

    if (version < 6) {
      this.transaction(() => {
        const bookCols = this.all('PRAGMA table_info(books)').map(c => c.name);
        if (!bookCols.includes('recipe_id')) {
          this.db.exec("ALTER TABLE books ADD COLUMN recipe_id TEXT NOT NULL DEFAULT 'default-audio'");
        }
        if (!bookCols.includes('recipe_version')) {
          this.db.exec('ALTER TABLE books ADD COLUMN recipe_version INTEGER NOT NULL DEFAULT 1');
        }

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS production_recipes (
            id TEXT NOT NULL,
            version INTEGER NOT NULL,
            name TEXT NOT NULL,
            config_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (id, version)
          );

          CREATE TABLE IF NOT EXISTS material_tasks (
            id TEXT PRIMARY KEY,
            book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
            type TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            is_current INTEGER NOT NULL DEFAULT 1,
            source_fingerprint TEXT,
            recipe_id TEXT,
            recipe_version INTEGER,
            params_json TEXT,
            params_hash TEXT,
            state TEXT NOT NULL DEFAULT 'planned',
            editorial_state TEXT NOT NULL DEFAULT 'unreviewed',
            priority INTEGER NOT NULL DEFAULT 0,
            next_at INTEGER NOT NULL DEFAULT 0,
            retry_count INTEGER NOT NULL DEFAULT 0,
            error_code TEXT,
            error TEXT,
            selected_attempt_id TEXT,
            selected_remote_item_id TEXT REFERENCES remote_items(id),
            selected_download_job_id TEXT REFERENCES download_jobs(id),
            output_path TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            canceled_at INTEGER,
            UNIQUE (block_id, type, revision)
          );
          CREATE UNIQUE INDEX IF NOT EXISTS idx_material_tasks_current ON material_tasks(block_id, type) WHERE is_current=1;
          CREATE INDEX IF NOT EXISTS idx_material_tasks_state_next ON material_tasks(state, next_at);
          CREATE INDEX IF NOT EXISTS idx_material_tasks_book ON material_tasks(book_id);
          CREATE INDEX IF NOT EXISTS idx_material_tasks_block ON material_tasks(block_id);

          CREATE TABLE IF NOT EXISTS material_attempts (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES material_tasks(id) ON DELETE CASCADE,
            attempt_number INTEGER NOT NULL,
            profile TEXT NOT NULL,
            expected_identity TEXT,
            remote_notebook_id TEXT,
            source_ids_json TEXT,
            baseline_json TEXT,
            state TEXT NOT NULL DEFAULT 'submitting',
            artifact_id TEXT,
            submitted_at INTEGER NOT NULL,
            resolved_at INTEGER,
            error_code TEXT,
            error TEXT,
            UNIQUE (task_id, attempt_number)
          );
          CREATE INDEX IF NOT EXISTS idx_material_attempts_task ON material_attempts(task_id);

          CREATE TABLE IF NOT EXISTS production_events (
            id TEXT PRIMARY KEY,
            task_id TEXT REFERENCES material_tasks(id) ON DELETE SET NULL,
            book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            attempt_id TEXT REFERENCES material_attempts(id) ON DELETE SET NULL,
            event TEXT NOT NULL,
            from_state TEXT,
            to_state TEXT,
            reason TEXT,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_production_events_book_created ON production_events(book_id, created_at);
        `);

        const defaultRecipeJson = JSON.stringify({
          name: 'Audio estándar',
          materials: {
            audio: { enabled: true, language: 'es-419', format: 'deep_dive', length: 'default' },
            infographic: { enabled: false }
          }
        });
        this.db.prepare(`
          INSERT OR IGNORE INTO production_recipes (id, version, name, config_json, created_at)
          VALUES ('default-audio', 1, 'Audio estándar', ?, ?)
        `).run(defaultRecipeJson, Date.now());

        const allBlocks = this.all('SELECT * FROM blocks');
        for (const b of allBlocks) {
          const taskId = `task-${b.id}-audio-r1`;
          let taskState = 'planned';
          let editorialState = 'unreviewed';
          if (b.canceled_at || b.state === 'canceled') taskState = 'canceled';
          else if (b.state === 'done') { taskState = 'ready'; }
          else if (b.state === 'review') taskState = 'review_required';
          else if (b.state === 'auth') taskState = 'waiting_auth';
          else if (b.state === 'quota') taskState = 'waiting_quota';
          else if (['download', 'convert'].includes(b.stage) || ['download', 'convert'].includes(b.state)) taskState = 'download_pending';
          else if (b.stage === 'poll' || ['generating', 'deferred', 'queued'].includes(b.state)) taskState = 'remote_pending';
          else if (b.stage === 'generate') {
            if (b.baseline) taskState = 'submitting';
            else if (b.state === 'ready') taskState = 'planned';
            else taskState = 'queued';
          } else if (b.state === 'error') taskState = 'failed';

          const paramsJson = JSON.stringify({
            format: 'deep_dive',
            length: 'default',
            language: 'es-419',
            mode: b.generation_mode || 'immediate'
          });
          const paramsHash = createHash('sha256').update(paramsJson).digest('hex');

          let selectedRemoteItemId = null;
          let selectedDownloadJobId = null;
          if (b.artifact_id) {
            const ri = this.get("SELECT id FROM remote_items WHERE book_id=? AND kind='artifact' AND remote_id=?", b.book_id, b.artifact_id);
            if (ri) {
              selectedRemoteItemId = ri.id;
              const dj = this.get('SELECT id FROM download_jobs WHERE remote_item_id=?', ri.id);
              if (dj) selectedDownloadJobId = dj.id;
            }
          }

          let selectedAttemptId = null;
          const shouldCreateAttempt = Boolean(b.generation_profile || b.artifact_id || b.baseline || b.stage === 'generate' || b.stage === 'poll' || ['generating', 'deferred', 'done', 'download', 'convert'].includes(b.state));
          if (shouldCreateAttempt) {
            selectedAttemptId = `att-${b.id}-1`;
          }

          this.db.prepare(`
            INSERT OR IGNORE INTO material_tasks (
              id, book_id, block_id, type, revision, is_current, source_fingerprint,
              recipe_id, recipe_version, params_json, params_hash, state, editorial_state,
              priority, next_at, retry_count, error_code, error,
              selected_attempt_id, selected_remote_item_id, selected_download_job_id,
              output_path, created_at, updated_at, canceled_at
            ) VALUES (?, ?, ?, 'audio', 1, 1, ?, 'default-audio', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            taskId,
            b.book_id,
            b.id,
            b.hash,
            paramsJson,
            paramsHash,
            taskState,
            editorialState,
            0,
            b.next_at || 0,
            b.attempts || 0,
            b.error_code || null,
            b.error || null,
            selectedAttemptId,
            selectedRemoteItemId,
            selectedDownloadJobId,
            b.output_path || null,
            b.created_at,
            Date.now(),
            b.canceled_at || null
          );

          if (shouldCreateAttempt && selectedAttemptId) {
            const attId = selectedAttemptId;
            const bookRow = this.get('SELECT profile, remote_id FROM books WHERE id=?', b.book_id);
            const attProfile = b.generation_profile || bookRow?.profile || 'default';
            const attNotebookId = bookRow?.remote_id || null;
            const attState = b.state === 'done' ? 'resolved' : (b.baseline ? 'uncertain' : (b.artifact_id ? 'accepted' : 'submitting'));
            this.db.prepare(`
              INSERT OR IGNORE INTO material_attempts (
                id, task_id, attempt_number, profile, remote_notebook_id, source_ids_json, baseline_json,
                state, artifact_id, submitted_at, resolved_at, error_code, error
              ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              attId,
              taskId,
              attProfile,
              attNotebookId,
              b.source_id ? JSON.stringify([b.source_id]) : null,
              b.baseline || null,
              attState,
              b.artifact_id || null,
              b.started_at || b.created_at,
              b.state === 'done' ? (b.started_at || b.created_at) : null,
              b.error_code || null,
              b.error || null
            );
          }
        }

        this.db.exec('PRAGMA user_version = 6;');
      });
      version = 6;
    }
  }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  transaction(fn) {
    if (this.inTransaction) return fn();
    this.inTransaction = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.inTransaction = false;
    }
  }
  books() { return this.all('SELECT * FROM books ORDER BY created_at DESC'); }
  book(id) { return this.get('SELECT * FROM books WHERE id=?', id); }
  blocks(id) { return this.all('SELECT * FROM blocks WHERE book_id=? ORDER BY position, created_at', id); }
  block(id) { return this.get('SELECT * FROM blocks WHERE id=?', id); }
  update(table, id, changes) {
    // Column names are internal constants; user input is always bound as values.
    const fields = Object.keys(changes);
    this.db.prepare(`UPDATE ${table} SET ${fields.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...Object.values(changes), id);
  }
  resolveBlockOutputPaths(book, blocks, exportsDir) {
    const dir = join(exportsDir, exportDirName(book));
    const numbering = book.numbering !== 0 && book.numbering !== false;
    const sorted = [...blocks].sort((a, b) => (a.position - b.position) || (a.created_at - b.created_at));
    const countByName = new Map();
    const map = new Map();
    for (const block of sorted) {
      const clean = safeName(block.title);
      let disambiguator = 0;
      if (!numbering) {
        const current = (countByName.get(clean) || 0) + 1;
        countByName.set(clean, current);
        disambiguator = current;
      }
      const outputName = formatBlockOutputName(block, numbering, disambiguator);
      const outputPath = join(dir, outputName);
      map.set(block.id, { outputPath, outputName });
    }
    return map;
  }
  updateBlockOutputPaths(bookId, exportsDir, { renameFiles = true } = {}) {
    const book = this.book(bookId);
    if (!book) throw new Error('Libro inexistente.');
    const blocks = this.blocks(bookId);
    const resolved = this.resolveBlockOutputPaths(book, blocks, exportsDir);
    const dir = join(exportsDir, exportDirName(book));
    if (renameFiles && existsSync(dir)) {
      for (const block of blocks) {
        const target = resolved.get(block.id);
        if (!target) continue;
        const oldPath = block.output_path;
        const newPath = target.outputPath;
        if (oldPath && oldPath !== newPath && existsSync(oldPath)) {
          try {
            mkdirSync(dirname(newPath), { recursive: true });
            if (existsSync(newPath) && newPath.toLowerCase() === oldPath.toLowerCase()) {
              const tempPath = `${newPath}.${randomUUID()}.tmp`;
              renameSync(oldPath, tempPath);
              renameSync(tempPath, newPath);
            } else if (existsSync(newPath)) {
              rmSync(newPath, { force: true });
              renameSync(oldPath, newPath);
            } else {
              renameSync(oldPath, newPath);
            }
          } catch {}
        }
      }
    }
    this.transaction(() => {
      for (const block of blocks) {
        const target = resolved.get(block.id);
        if (target) {
          this.update('blocks', block.id, { output_path: target.outputPath });
        }
      }
    });
    return resolved;
  }
  setBookNumbering(bookId, numbering, exportsDir) {
    const book = this.book(bookId);
    if (!book) throw new Error('Libro inexistente.');
    const num = (numbering !== false && numbering !== 0) ? 1 : 0;
    this.update('books', bookId, { numbering: num });
    this.updateBlockOutputPaths(bookId, exportsDir, { renameFiles: true });
    return this.book(bookId);
  }
  createBook(input, profile) {
    const name = title(input.title);
    const requestId = input.requestId;
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) throw new Error('requestId inválido.');
    const existing = this.get('SELECT * FROM books WHERE request_id=?', requestId);
    if (existing) {
      if (existing.profile !== profile) throw new Error('Ese requestId pertenece a otro perfil.');
      if (existing.title !== name) throw new Error('Ese requestId ya corresponde a otro título.');
      return existing;
    }
    const id = randomUUID();
    const numbering = (input.numbering !== false && input.numbering !== 0) ? 1 : 0;
    // A visible unique marker lets us reconcile an interrupted remote create safely.
    this.db.prepare('INSERT INTO books(id,request_id,title,remote_title,profile,numbering,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, requestId, name, `${name} [${id.slice(0, 8)}]`, profile, numbering, Date.now());
    return this.book(id);
  }
  importRemoteBook({ remoteId, title: bookTitle, profile, numbering = 1, email = null, role = null }) {
    const name = title(bookTitle || 'Cuaderno remoto');
    let existing = this.get('SELECT * FROM books WHERE profile=? AND remote_id=?', profile, remoteId);
    if (!existing) {
      const id = randomUUID();
      const hashKey = createHash('sha256').update(`${profile}:${remoteId}`).digest('hex');
      const requestId = `remote-${hashKey.slice(0, 32)}`;
      const num = (numbering !== false && numbering !== 0) ? 1 : 0;
      this.db.prepare(`INSERT INTO books(id,request_id,title,remote_title,remote_id,profile,origin,numbering,state,profile_email_at_link,remote_role,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, requestId, name, name, remoteId, profile, 'remote_linked', num, 'ready', email, role, Date.now());
      existing = this.book(id);
    }
    return existing;
  }
  importRemoteBlock(bookId, input) {
    return this.transaction(() => {
      const existing = this.get('SELECT * FROM blocks WHERE book_id=? AND artifact_id=?', bookId, input.artifactId);
      if (existing) return { ...existing, existing: true };
      const position = this.get('SELECT COALESCE(MAX(position),0)+1 AS n FROM blocks WHERE book_id=?', bookId).n;
      const id = randomUUID();
      const name = title(input.title || `Audio ${position}`);
      const filename = `${safeName(name)}.md`;
      const filePath = input.filePath || '';
      const hash = `remote-${input.artifactId}`;
      const isReady = input.status === 'completed' || input.status === 'ready' || input.status === 2;
      const isFailed = input.status === 'failed' || input.status === 'error';
      const stage = isReady ? 'download' : isFailed ? 'download' : 'poll';
      const state = isReady ? 'download' : isFailed ? 'error' : input.status === 'queued' ? 'queued' : 'generating';
      const error = isFailed ? (input.error || 'Audio fallido en NotebookLM.') : null;
      const attempts = isFailed ? 4 : 0;

      this.db.prepare(`INSERT INTO blocks(id,book_id,request_id,position,title,filename,file_path,hash,source_title,source_id,artifact_id,generation_profile,stage,state,locked,error,error_code,attempts,original_path,output_path,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, bookId, `art-${input.artifactId.slice(0, 80)}`, position, name, filename, filePath, hash, name, input.sourceId || null, input.artifactId, input.profile, stage, state, 1, error, isFailed ? 'ARTIFACT_FAILED' : null, attempts, input.originalPath || null, input.outputPath || null, Date.now());
      return this.block(id);
    });
  }
  addBlock(bookId, input) {
    return this.transaction(() => {
      const position = this.get('SELECT COALESCE(MAX(position),0)+1 AS n FROM blocks WHERE book_id=?', bookId).n;
      const id = randomUUID();
      const name = title(input.title);
      this.db.prepare(`INSERT INTO blocks(id,book_id,request_id,position,title,filename,file_path,hash,source_title,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, bookId, input.requestId, position, name, input.filename, input.filePath, input.hash, `${name} [${id.slice(0, 8)}]`, Date.now());
      return this.block(id);
    });
  }
  addRemoteSourceBlock(bookId, { sourceId, title: blockTitle, generationMode = 'immediate' }) {
    return this.transaction(() => {
      const position = this.get('SELECT COALESCE(MAX(position),0)+1 AS n FROM blocks WHERE book_id=?', bookId).n;
      const id = randomUUID();
      const name = title(blockTitle || `Audio ${position}`);
      const filename = `${safeName(name)}.source`;
      const hash = `remote-source-${sourceId}`;
      const existing = this.get('SELECT * FROM blocks WHERE book_id=? AND hash=?', bookId, hash);
      if (existing) return existing;
      this.db.prepare(`
        INSERT INTO blocks(id, book_id, request_id, position, title, filename, file_path, hash, source_title, source_id, stage, state, locked, generation_mode, created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(id, bookId, `gen-${randomUUID().slice(0, 20)}`, position, name, filename, '', hash, name, sourceId, 'generate', 'ready', 1, generationMode, Date.now());
      return this.block(id);
    });
  }
  reorder(bookId, ids) {
    const rows = this.blocks(bookId);
    if (!Array.isArray(ids) || ids.length !== rows.length || new Set(ids).size !== rows.length || ids.some(id => !rows.some(b => b.id === id)))
      throw new Error('El orden debe contener todos los bloques una sola vez.');
    if (rows.some(b => b.locked && ids[b.position - 1] !== b.id)) throw new Error('Los números de bloques ya solicitados no se pueden cambiar.');
    this.transaction(() => ids.forEach((id, i) => this.update('blocks', id, { position: i + 1 })));
  }
  recover() {
    // Interrupted creates remain uncertain. The worker reconciles them, never resubmits.
    this.db.exec(`UPDATE blocks SET next_at=0 WHERE state IN ('uploading','submitting','queued','generating','source_processing','download','convert') AND canceled_at IS NULL;
      UPDATE books SET next_at=0 WHERE state='creating';
      UPDATE material_tasks SET next_at=0 WHERE state IN ('queued', 'remote_pending', 'download_pending') AND canceled_at IS NULL;
      UPDATE download_jobs SET state='queued', next_at=0 WHERE state='downloading';
      UPDATE remote_operations SET state='failed', error='Interrumpido por reinicio', completed_at=${Date.now()} WHERE state='running';`);
  }
  snapshot() {
    return this.books().map(book => ({
      id: book.id, title: book.title, remoteId: book.remote_id, remoteTitle: book.remote_title,
      profile: book.profile, origin: book.origin || 'local_created',
      remoteRole: book.remote_role || null,
      lastSyncedAt: book.last_synced_at || null,
      syncError: book.sync_error || null,
      backups: this.all('SELECT profile FROM book_accounts WHERE book_id=? ORDER BY profile', book.id).map(a => a.profile),
      url: book.remote_id ? `https://notebooklm.google.com/notebook/${encodeURIComponent(book.remote_id)}` : null,
      numbering: book.numbering !== 0 && book.numbering !== false,
      state: book.state, running: !!book.running, error: book.error, errorCode: book.error_code,
      nextAt: Math.max(book.next_at, book.quota_at) || null, quotaError: book.quota_error,
      blocks: this.blocks(book.id).map(b => ({
        id: b.id, number: b.position, title: b.title, filename: b.filename, sourceId: b.source_id,
        artifactId: b.artifact_id, state: b.state, stage: b.stage, locked: !!b.locked,
        generationProfile: b.generation_profile,
        cancelRequestedAt: b.cancel_requested_at || null,
        canceledAt: b.canceled_at || null,
        downloadPolicy: b.download_policy || 'auto',
        error: b.error, errorCode: b.error_code, nextAt: b.next_at || null,
        audioUrl: b.state === 'done' ? `/api/blocks/${b.id}/audio` : null,
        outputName: b.output_path ? b.output_path.split(/[\\/]/).at(-1) : null
      }))
    }));
  }
  remoteItems(bookId, { kind, type } = {}) {
    let sql = 'SELECT * FROM remote_items WHERE book_id=?';
    const params = [bookId];
    if (kind) { sql += ' AND kind=?'; params.push(kind); }
    if (type) { sql += ' AND type=?'; params.push(type); }
    sql += ' ORDER BY created_time DESC, last_seen_at DESC';
    return this.all(sql, ...params);
  }
  remoteItem(id) {
    return this.get('SELECT * FROM remote_items WHERE id=?', id);
  }
  remoteItemByRemoteId(bookId, kind, remoteId) {
    return this.get('SELECT * FROM remote_items WHERE book_id=? AND kind=? AND remote_id=?', bookId, kind, remoteId);
  }
  upsertRemoteItem(item) {
    const existing = this.remoteItemByRemoteId(item.bookId, item.kind, item.remoteId);
    if (existing) {
      this.db.prepare(`
        UPDATE remote_items SET
          title=?, type=?, original_type=?, status=?, original_status=?,
          source_ids_json=?, created_time=?, modified_time=?, error_reason=?,
          last_seen_at=?, sync_rev=?, not_visible=0, block_id=COALESCE(block_id, ?),
          metadata_json=?
        WHERE id=?
      `).run(
        item.title, item.type || null, item.originalType || null,
        item.status || null, item.originalStatus || null,
        item.sourceIdsJson || null, item.createdTime || null, item.modifiedTime || null,
        item.errorReason || null, item.lastSeenAt || Date.now(), item.syncRev || 0,
        item.blockId || null, item.metadataJson || null, existing.id
      );
      return this.remoteItem(existing.id);
    }
    const id = item.id || randomUUID();
    this.db.prepare(`
      INSERT INTO remote_items(
        id, book_id, kind, remote_id, type, original_type, title, status, original_status,
        source_ids_json, created_time, modified_time, error_reason, last_seen_at, sync_rev,
        not_visible, block_id, metadata_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, item.bookId, item.kind, item.remoteId, item.type || null, item.originalType || null,
      item.title, item.status || null, item.originalStatus || null, item.sourceIdsJson || null,
      item.createdTime || null, item.modifiedTime || null, item.errorReason || null,
      item.lastSeenAt || Date.now(), item.syncRev || 0, 0, item.blockId || null, item.metadataJson || null
    );
    return this.remoteItem(id);
  }
  markAbsentRemoteItems(bookId, kind, currentRev) {
    return this.db.prepare('UPDATE remote_items SET not_visible=1 WHERE book_id=? AND kind=? AND sync_rev < ?')
      .run(bookId, kind, currentRev);
  }
  createRemoteOperation({ requestId, bookId, profile, type, targetId, state = 'pending' }) {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO remote_operations(id, request_id, book_id, profile, type, target_id, state, created_at)
      VALUES(?,?,?,?,?,?,?,?)
    `).run(id, requestId || null, bookId, profile, type, targetId || null, state, Date.now());
    return this.remoteOperation(id);
  }
  remoteOperation(id) {
    return this.get('SELECT * FROM remote_operations WHERE id=?', id);
  }
  remoteOperations(bookId) {
    return this.all('SELECT * FROM remote_operations WHERE book_id=? ORDER BY created_at DESC', bookId);
  }
  createDownloadJob({ bookId, remoteItemId, format, profile, outputPath, requestId }) {
    const id = randomUUID();
    const reqId = requestId || `dl-${randomUUID().slice(0, 20)}`;
    const existing = this.get('SELECT * FROM download_jobs WHERE remote_item_id=? AND format=?', remoteItemId, format);
    if (existing) {
      if (['error', 'canceled'].includes(existing.state)) {
        this.update('download_jobs', existing.id, { state: 'queued', attempts: 0, next_at: 0, error: null, error_code: null });
      }
      return this.downloadJob(existing.id);
    }
    this.db.prepare(`
      INSERT INTO download_jobs(id, book_id, remote_item_id, format, profile, state, output_path, request_id, created_at)
      VALUES(?,?,?,?,?,?,?,?,?)
    `).run(id, bookId, remoteItemId, format, profile, 'queued', outputPath, reqId, Date.now());
    return this.downloadJob(id);
  }
  downloadJob(id) {
    return this.get('SELECT * FROM download_jobs WHERE id=?', id);
  }
  downloadJobs(bookId) {
    if (bookId) return this.all('SELECT * FROM download_jobs WHERE book_id=? ORDER BY created_at DESC', bookId);
    return this.all('SELECT * FROM download_jobs ORDER BY created_at DESC');
  }
  findDownloadJob(remoteItemId, format) {
    return this.get('SELECT * FROM download_jobs WHERE remote_item_id=? AND format=?', remoteItemId, format);
  }
  recipes() { return this.all('SELECT * FROM production_recipes ORDER BY id, version DESC'); }
  recipe(id, version) {
    if (version !== undefined) {
      return this.get('SELECT * FROM production_recipes WHERE id=? AND version=?', id, version);
    }
    return this.get('SELECT * FROM production_recipes WHERE id=? ORDER BY version DESC LIMIT 1', id);
  }
  createRecipe({ id = randomUUID(), name, config }) {
    return this.transaction(() => {
      const current = this.recipe(id);
      const nextVersion = current ? current.version + 1 : 1;
      const configJson = typeof config === 'string' ? config : JSON.stringify(config);
      this.db.prepare(`
        INSERT INTO production_recipes (id, version, name, config_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, nextVersion, title(name), configJson, Date.now());
      return this.recipe(id, nextVersion);
    });
  }
  materialTasks(bookId, { blockId, type, currentOnly = true } = {}) {
    let sql = 'SELECT * FROM material_tasks WHERE book_id=?';
    const params = [bookId];
    if (blockId) { sql += ' AND block_id=?'; params.push(blockId); }
    if (type) { sql += ' AND type=?'; params.push(type); }
    if (currentOnly) { sql += ' AND is_current=1'; }
    sql += ' ORDER BY created_at ASC';
    return this.all(sql, ...params);
  }
  materialTask(id) {
    return this.get('SELECT * FROM material_tasks WHERE id=?', id);
  }
  currentMaterialTask(blockId, type) {
    return this.get('SELECT * FROM material_tasks WHERE block_id=? AND type=? AND is_current=1', blockId, type);
  }
  createMaterialTask(input) {
    return this.transaction(() => {
      const id = input.id || randomUUID();
      const now = Date.now();
      const paramsJson = typeof input.params === 'string' ? input.params : JSON.stringify(input.params || {});
      const paramsHash = input.paramsHash || createHash('sha256').update(paramsJson).digest('hex');
      const revision = input.revision || 1;
      const isCurrent = input.isCurrent !== undefined ? (input.isCurrent ? 1 : 0) : 1;

      if (isCurrent) {
        this.db.prepare('UPDATE material_tasks SET is_current=0, updated_at=? WHERE block_id=? AND type=? AND is_current=1')
          .run(now, input.blockId, input.type);
      }

      this.db.prepare(`
        INSERT INTO material_tasks (
          id, book_id, block_id, type, revision, is_current, source_fingerprint,
          recipe_id, recipe_version, params_json, params_hash, state, editorial_state,
          priority, next_at, retry_count, error_code, error,
          selected_attempt_id, selected_remote_item_id, selected_download_job_id,
          output_path, created_at, updated_at, canceled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.bookId,
        input.blockId,
        input.type,
        revision,
        isCurrent,
        input.sourceFingerprint || null,
        input.recipeId || null,
        input.recipeVersion || null,
        paramsJson,
        paramsHash,
        input.state || 'planned',
        input.editorialState || 'unreviewed',
        input.priority || 0,
        input.nextAt || 0,
        input.retryCount || 0,
        input.errorCode || null,
        input.error || null,
        input.selectedAttemptId || null,
        input.selectedRemoteItemId || null,
        input.selectedDownloadJobId || null,
        input.outputPath || null,
        input.createdAt || now,
        now,
        input.canceledAt || null
      );

      this.recordProductionEvent({
        taskId: id,
        bookId: input.bookId,
        event: 'task_created',
        toState: input.state || 'planned',
        reason: input.reason || 'Tarea creada'
      });

      return this.materialTask(id);
    });
  }
  updateMaterialTask(id, changes) {
    return this.transaction(() => {
      const task = this.materialTask(id);
      if (!task) throw new Error('Tarea de material inexistente.');
      const allowed = [
        'state', 'editorial_state', 'priority', 'next_at', 'retry_count',
        'error_code', 'error', 'selected_attempt_id', 'selected_remote_item_id',
        'selected_download_job_id', 'output_path', 'canceled_at', 'is_current'
      ];
      const updates = {};
      for (const k of allowed) {
        if (changes[k] !== undefined) updates[k] = changes[k];
      }
      updates.updated_at = Date.now();
      this.update('material_tasks', id, updates);

      if (changes.state && changes.state !== task.state) {
        this.recordProductionEvent({
          taskId: id,
          bookId: task.book_id,
          attemptId: changes.selected_attempt_id || task.selected_attempt_id,
          event: 'state_changed',
          fromState: task.state,
          toState: changes.state,
          reason: changes.error || changes.reason || null
        });

        if (task.type === 'audio' && task.is_current) {
          const blockUpdates = {};
          if (changes.state === 'ready') {
            blockUpdates.state = 'done';
            blockUpdates.stage = 'convert';
            if (changes.output_path) blockUpdates.output_path = changes.output_path;
          } else if (changes.state === 'canceled') {
            blockUpdates.state = 'canceled';
            blockUpdates.canceled_at = changes.canceled_at || Date.now();
            blockUpdates.cancel_reason = changes.error || 'Cancelado';
          } else if (changes.state === 'remote_pending') {
            blockUpdates.state = 'generating';
            blockUpdates.stage = 'poll';
          } else if (changes.state === 'download_pending') {
            blockUpdates.state = 'download';
            blockUpdates.stage = 'download';
          } else if (changes.state === 'waiting_quota') {
            blockUpdates.state = 'quota';
            if (changes.next_at !== undefined) blockUpdates.next_at = changes.next_at;
          } else if (changes.state === 'waiting_auth') {
            blockUpdates.state = 'auth';
            blockUpdates.error_code = 'AUTH_REQUIRED';
          } else if (changes.state === 'review_required') {
            blockUpdates.state = 'review';
            blockUpdates.error = changes.error;
          } else if (changes.state === 'failed') {
            blockUpdates.state = 'error';
            blockUpdates.error = changes.error;
            blockUpdates.error_code = changes.error_code;
          }
          if (Object.keys(blockUpdates).length) {
            this.update('blocks', task.block_id, blockUpdates);
          }
        }
      }

      return this.materialTask(id);
    });
  }
  createMaterialAttempt(input) {
    const id = input.id || randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO material_attempts (
        id, task_id, attempt_number, profile, expected_identity, remote_notebook_id,
        source_ids_json, baseline_json, state, artifact_id, submitted_at,
        resolved_at, error_code, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.taskId,
      input.attemptNumber,
      input.profile,
      input.expectedIdentity || null,
      input.remoteNotebookId || null,
      input.sourceIds ? JSON.stringify(input.sourceIds) : null,
      input.baseline ? (typeof input.baseline === 'string' ? input.baseline : JSON.stringify(input.baseline)) : null,
      input.state || 'submitting',
      input.artifactId || null,
      input.submittedAt || now,
      input.resolvedAt || null,
      input.errorCode || null,
      input.error || null
    );
    return this.get('SELECT * FROM material_attempts WHERE id=?', id);
  }
  updateMaterialAttempt(id, changes) {
    const allowed = ['state', 'artifact_id', 'resolved_at', 'error_code', 'error'];
    const updates = {};
    for (const k of allowed) {
      if (changes[k] !== undefined) updates[k] = changes[k];
    }
    this.update('material_attempts', id, updates);
    return this.get('SELECT * FROM material_attempts WHERE id=?', id);
  }
  materialAttempts(taskId) {
    return this.all('SELECT * FROM material_attempts WHERE task_id=? ORDER BY attempt_number ASC', taskId);
  }
  recordProductionEvent({ taskId, bookId, attemptId, event, fromState, toState, reason }) {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO production_events (
        id, task_id, book_id, attempt_id, event, from_state, to_state, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      taskId || null,
      bookId,
      attemptId || null,
      event,
      fromState || null,
      toState || null,
      reason || null,
      Date.now()
    );
    return this.get('SELECT * FROM production_events WHERE id=?', id);
  }
  productionEvents(bookId, { taskId, limit = 100 } = {}) {
    let sql = 'SELECT * FROM production_events WHERE book_id=?';
    const params = [bookId];
    if (taskId) { sql += ' AND task_id=?'; params.push(taskId); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    return this.all(sql, ...params);
  }
  close() { this.db.close(); }
}
