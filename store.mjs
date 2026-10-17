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
  }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
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
      const stage = isReady ? 'download' : isFailed ? 'generate' : 'poll';
      const state = isReady ? 'download' : isFailed ? 'error' : input.status === 'queued' ? 'queued' : 'generating';
      const error = isFailed ? (input.error || 'Audio fallido en NotebookLM.') : null;

      this.db.prepare(`INSERT INTO blocks(id,book_id,request_id,position,title,filename,file_path,hash,source_title,source_id,artifact_id,generation_profile,stage,state,locked,error,error_code,original_path,output_path,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, bookId, `art-${input.artifactId.slice(0, 80)}`, position, name, filename, filePath, hash, name, input.sourceId || null, input.artifactId, input.profile, stage, state, 1, error, isFailed ? 'ARTIFACT_FAILED' : null, input.originalPath || null, input.outputPath || null, Date.now());
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
  reorder(bookId, ids) {
    const rows = this.blocks(bookId);
    if (!Array.isArray(ids) || ids.length !== rows.length || new Set(ids).size !== rows.length || ids.some(id => !rows.some(b => b.id === id)))
      throw new Error('El orden debe contener todos los bloques una sola vez.');
    if (rows.some(b => b.locked && ids[b.position - 1] !== b.id)) throw new Error('Los números de bloques ya solicitados no se pueden cambiar.');
    this.transaction(() => ids.forEach((id, i) => this.update('blocks', id, { position: i + 1 })));
  }
  recover() {
    // Interrupted creates remain uncertain. The worker reconciles them, never resubmits.
    this.db.exec(`UPDATE blocks SET next_at=0 WHERE state IN ('uploading','submitting','queued','generating','source_processing','download','convert');
      UPDATE books SET next_at=0 WHERE state='creating';`);
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
  close() { this.db.close(); }
}
