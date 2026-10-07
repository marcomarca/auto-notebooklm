import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

export class Store {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS books (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        remote_title TEXT NOT NULL, remote_id TEXT, profile TEXT NOT NULL,
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
      ); CREATE UNIQUE INDEX IF NOT EXISTS blocks_content ON blocks(book_id,hash);
      PRAGMA user_version=1;`);
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
    // A visible unique marker lets us reconcile an interrupted remote create safely.
    this.db.prepare('INSERT INTO books(id,request_id,title,remote_title,profile,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, requestId, name, `${name} [${id.slice(0, 8)}]`, profile, Date.now());
    return this.book(id);
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
      url: book.remote_id ? `https://notebooklm.google.com/notebook/${encodeURIComponent(book.remote_id)}` : null,
      state: book.state, running: !!book.running, error: book.error, errorCode: book.error_code,
      nextAt: Math.max(book.next_at, book.quota_at) || null, quotaError: book.quota_error,
      blocks: this.blocks(book.id).map(b => ({
        id: b.id, number: b.position, title: b.title, filename: b.filename, sourceId: b.source_id,
        artifactId: b.artifact_id, state: b.state, stage: b.stage, locked: !!b.locked,
        error: b.error, errorCode: b.error_code, nextAt: b.next_at || null,
        audioUrl: b.state === 'done' ? `/api/blocks/${b.id}/audio` : null,
        outputName: b.output_path ? b.output_path.split(/[\\/]/).at(-1) : null
      }))
    }));
  }
  close() { this.db.close(); }
}
