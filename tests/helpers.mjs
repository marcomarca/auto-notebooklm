import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../store.mjs';
import { Queue } from '../queue.mjs';
import { ProviderError } from '../provider.mjs';

export class FakeProvider {
  constructor() {
    this.profile='default'; this.health={ ready:true, auth:true, cli:true, ffmpeg:true, profile:'default' };
    this.remoteBooks=[]; this.remoteSources=[]; this.remoteArtifacts=[]; this.calls=[];
    this.usageData={windows:[{window:'rolling',percent_remaining:100,resets_at:null}]};
    this.behavior={}; this.generations=0;
  }
  async check() { return this.health; }
  async close() {}
  async usage() { this.calls.push(['usage']); if(this.behavior.usage) throw this.behavior.usage; return this.usageData; }
  async listBooks() { return this.remoteBooks; }
  async createBook(title) {
    const id=`book-${this.remoteBooks.length+1}`;
    this.calls.push(['createBook',title]); this.remoteBooks.push({id,title});
    if(this.behavior.createBook) throw this.behavior.createBook;
    return id;
  }
  async sources() { return this.remoteSources; }
  async upload(book,block) {
    const id=`source-${this.remoteSources.length+1}`;
    this.calls.push(['upload',book,block.id]); this.remoteSources.push({id,title:block.source_title,status:2});
    if(this.behavior.upload) throw this.behavior.upload;
    return id;
  }
  async artifacts(book,id) { return this.remoteArtifacts.filter(a=>!id || a.artifact_id === id); }
  async generate(book,source) {
    if(!source) throw new Error('Missing source');
    const id=`audio-${++this.generations}`;
    this.calls.push(['generate',book,source]);
    this.remoteArtifacts.push({artifact_id:id,type:'audio',source_ids:[source],status:'completed'});
    if(this.behavior.generate) throw this.behavior.generate;
    return id;
  }
  async download(book,id,path) {
    this.calls.push(['download',book,id]);
    if(this.behavior.download) throw this.behavior.download;
    await mkdir(join(path,'..'),{recursive:true}); await writeFile(path,Buffer.alloc(256,1));
  }
  async convert(original,path) {
    this.calls.push(['convert',original,path]);
    if(this.behavior.convert) throw this.behavior.convert;
    await mkdir(join(path,'..'),{recursive:true}); await writeFile(path,Buffer.alloc(512,2));
  }
  async deleteArtifact(book, id) {
    this.calls.push(['deleteArtifact', book, id]);
    if (this.behavior.deleteArtifact) throw this.behavior.deleteArtifact;
    const idx = this.remoteArtifacts.findIndex(a => (a.artifact_id || a.id) === id);
    if (idx !== -1) this.remoteArtifacts.splice(idx, 1);
    return { ok: true };
  }
  async downloadVideo(book, id, path) {
    this.calls.push(['downloadVideo', book, id]);
    if (this.behavior.downloadVideo) throw this.behavior.downloadVideo;
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, Buffer.alloc(256, 1));
  }
  async downloadReport(book, id, path) {
    this.calls.push(['downloadReport', book, id]);
    if (this.behavior.downloadReport) throw this.behavior.downloadReport;
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, '# Report\nContent');
  }
  async downloadSlideDeck(book, id, path, { format } = {}) {
    this.calls.push(['downloadSlideDeck', book, id, format]);
    if (this.behavior.downloadSlideDeck) throw this.behavior.downloadSlideDeck;
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, Buffer.alloc(256, 1));
  }
  async downloadInfographic(book, id, path) {
    this.calls.push(['downloadInfographic', book, id]);
    if (this.behavior.downloadInfographic) throw this.behavior.downloadInfographic;
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, Buffer.alloc(256, 1));
  }
  async downloadMindMap(book, id, path) {
    this.calls.push(['downloadMindMap', book, id]);
    if (this.behavior.downloadMindMap) throw this.behavior.downloadMindMap;
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify({ mindmap: true }));
  }
  async downloadQuiz(book, id, path, { format } = {}) {
    this.calls.push(['downloadQuiz', book, id, format]);
    if (this.behavior.downloadQuiz) throw this.behavior.downloadQuiz;
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, format === 'markdown' ? '# Quiz' : JSON.stringify({ quiz: true }));
  }
  async downloadFlashcards(book, id, path, { format } = {}) {
    this.calls.push(['downloadFlashcards', book, id, format]);
    if (this.behavior.downloadFlashcards) throw this.behavior.downloadFlashcards;
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, format === 'markdown' ? '# Cards' : JSON.stringify({ cards: true }));
  }
  async downloadDataTable(book, id, path) {
    this.calls.push(['downloadDataTable', book, id]);
    if (this.behavior.downloadDataTable) throw this.behavior.downloadDataTable;
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, 'col1,col2\n1,2');
  }
}
export async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'auto-nlm-test-'));
  let store=new Store(join(dir,'queue.sqlite')); const provider=new FakeProvider();
  let now=Date.now();
  const options={dataDir:dir,exportsDir:join(dir,'exports'),now:()=>now};
  const queue=new Queue(store,provider,options);
  t.after(async()=>{await queue.stop();store.close();await rm(dir,{recursive:true,force:true});});
  const book=store.createBook({title:'Libro de prueba',requestId:'book-request'},'default');
  const add=(n=1)=>store.addBlock(book.id,{requestId:`request-${n}`,title:`Parte ${n}`,filename:`Parte ${n}.md`,filePath:join(dir,`part-${n}.md`),hash:`hash-${n}`});
  const tick=async(count=1)=>{for(let i=0;i<count;i++){await queue.tick();now+=60001;}};
  return {dir,store,provider,queue,book,add,tick,advance:n=>{now+=n;},now:()=>now,options};
}
export const temporary = () => new ProviderError('TEMPORARY','Connection lost',true);

export class CallConcurrencyTracker {
  constructor() {
    this.active = 0;
    this.maxActive = 0;
    this.history = [];
    this.calls = [];
  }
  async track(name, fn) {
    const start = Date.now();
    this.active++;
    this.calls.push(name);
    if (this.active > this.maxActive) this.maxActive = this.active;
    try {
      return await fn();
    } finally {
      this.active--;
      this.history.push({ name, start, end: Date.now() });
    }
  }
  reset() {
    this.active = 0;
    this.maxActive = 0;
    this.history = [];
    this.calls = [];
  }
}

export function createV5FixtureDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec(`
    CREATE TABLE books (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      remote_title TEXT NOT NULL, remote_id TEXT, profile TEXT NOT NULL,
      numbering INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'pending', running INTEGER NOT NULL DEFAULT 0,
      error TEXT, error_code TEXT, baseline TEXT, started_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
      quota_at INTEGER NOT NULL DEFAULT 0, quota_error TEXT,
      created_at INTEGER NOT NULL,
      generation_mode TEXT NOT NULL DEFAULT 'immediate',
      origin TEXT NOT NULL DEFAULT 'local_created',
      profile_email_at_link TEXT,
      remote_role TEXT,
      last_synced_at INTEGER,
      last_sync_full INTEGER NOT NULL DEFAULT 0,
      sync_error TEXT,
      sync_error_code TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS books_profile_remote ON books(profile, remote_id) WHERE remote_id IS NOT NULL;

    CREATE TABLE blocks (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id),
      request_id TEXT NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL,
      filename TEXT NOT NULL, file_path TEXT NOT NULL, hash TEXT NOT NULL,
      source_title TEXT NOT NULL, source_id TEXT, artifact_id TEXT,
      state TEXT NOT NULL DEFAULT 'upload_pending', stage TEXT NOT NULL DEFAULT 'upload',
      locked INTEGER NOT NULL DEFAULT 0, error TEXT, error_code TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
      poll_count INTEGER NOT NULL DEFAULT 0, baseline TEXT, started_at INTEGER,
      output_path TEXT, original_path TEXT, created_at INTEGER NOT NULL,
      generation_profile TEXT,
      generation_mode TEXT NOT NULL DEFAULT 'immediate',
      cancel_requested_at INTEGER,
      canceled_at INTEGER,
      cancel_reason TEXT,
      download_policy TEXT NOT NULL DEFAULT 'auto',
      UNIQUE(book_id, request_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS blocks_content ON blocks(book_id,hash);

    CREATE TABLE accounts (
      id TEXT PRIMARY KEY, email TEXT, enabled INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0, error TEXT, error_code TEXT
    );
    CREATE TABLE book_accounts (
      book_id TEXT NOT NULL REFERENCES books(id), profile TEXT NOT NULL,
      PRIMARY KEY(book_id, profile)
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE remote_items (
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

    CREATE TABLE download_jobs (
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

    CREATE TABLE remote_operations (
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

    PRAGMA user_version = 5;
  `);

  const now = Date.now();
  // Populate fixture data representing required baseline conditions:
  // Books
  db.prepare(`
    INSERT INTO books (id, request_id, title, remote_title, remote_id, profile, numbering, state, running, created_at, origin)
    VALUES ('book-v5-1', 'req-book-v5-1', 'Libro Fixture V5', 'Libro Fixture V5 [req-b1]', 'nb-remote-123', 'default', 1, 'ready', 1, ?, 'local_created')
  `).run(now);

  // Accounts
  db.prepare(`INSERT INTO accounts (id, email, enabled, retry_at) VALUES ('default', 'user1@example.com', 1, 0)`).run();
  db.prepare(`INSERT INTO accounts (id, email, enabled, retry_at) VALUES ('cuenta2', 'user2@example.com', 1, 0)`).run();
  db.prepare(`INSERT INTO accounts (id, email, enabled, retry_at) VALUES ('cuenta3', 'user3@example.com', 0, 0)`).run();
  db.prepare(`INSERT INTO accounts (id, email, enabled, retry_at) VALUES ('cuenta4', 'user4@example.com', 0, 0)`).run();
  db.prepare(`INSERT INTO book_accounts (book_id, profile) VALUES ('book-v5-1', 'cuenta2')`).run();

  // Blocks: finished, pending, quota, auth, canceled, uncertain baseline
  // 1. Finished block (state: done, stage: convert)
  db.prepare(`
    INSERT INTO blocks (id, book_id, request_id, position, title, filename, file_path, hash, source_title, source_id, artifact_id, state, stage, locked, output_path, created_at)
    VALUES ('block-v5-done', 'book-v5-1', 'req-b-done', 1, 'Bloque Terminado', 'b1.md', '/tmp/b1.md', 'h-done', 'Fuente 1', 'src-1', 'art-audio-1', 'done', 'convert', 1, '/tmp/b1.mp3', ?)
  `).run(now);

  // 2. Pending block (state: ready, stage: upload)
  db.prepare(`
    INSERT INTO blocks (id, book_id, request_id, position, title, filename, file_path, hash, source_title, state, stage, locked, created_at)
    VALUES ('block-v5-pending', 'book-v5-1', 'req-b-pending', 2, 'Bloque Pendiente', 'b2.md', '/tmp/b2.md', 'h-pending', 'Fuente 2', 'upload_pending', 'upload', 0, ?)
  `).run(now);

  // 3. Block with quota (state: quota, stage: generate)
  db.prepare(`
    INSERT INTO blocks (id, book_id, request_id, position, title, filename, file_path, hash, source_title, source_id, state, stage, locked, next_at, error, error_code, created_at)
    VALUES ('block-v5-quota', 'book-v5-1', 'req-b-quota', 3, 'Bloque con Cuota', 'b3.md', '/tmp/b3.md', 'h-quota', 'Fuente 3', 'src-3', 'quota', 'generate', 1, ?, 'Cuota agotada temporalmente', 'QUOTA', ?)
  `).run(now + 3600000, now);

  // 4. Block with auth error (state: auth, stage: generate)
  db.prepare(`
    INSERT INTO blocks (id, book_id, request_id, position, title, filename, file_path, hash, source_title, source_id, state, stage, locked, error, error_code, created_at)
    VALUES ('block-v5-auth', 'book-v5-1', 'req-b-auth', 4, 'Bloque con Error Auth', 'b4.md', '/tmp/b4.md', 'h-auth', 'Fuente 4', 'src-4', 'auth', 'generate', 1, 'Sesión expirada', 'AUTH_REQUIRED', ?)
  `).run(now);

  // 5. Canceled block
  db.prepare(`
    INSERT INTO blocks (id, book_id, request_id, position, title, filename, file_path, hash, source_title, source_id, state, stage, locked, canceled_at, cancel_reason, created_at)
    VALUES ('block-v5-canceled', 'book-v5-1', 'req-b-canceled', 5, 'Bloque Cancelado', 'b5.md', '/tmp/b5.md', 'h-canceled', 'Fuente 5', 'src-5', 'canceled', 'generate', 1, ?, 'Cancelado por usuario', ?)
  `).run(now, now);

  // 6. Block with uncertain baseline (state: submitting, stage: generate, baseline set)
  db.prepare(`
    INSERT INTO blocks (id, book_id, request_id, position, title, filename, file_path, hash, source_title, source_id, state, stage, locked, baseline, started_at, created_at)
    VALUES ('block-v5-uncertain', 'book-v5-1', 'req-b-uncertain', 6, 'Bloque Incierto', 'b6.md', '/tmp/b6.md', 'h-uncertain', 'Fuente 6', 'src-6', 'submitting', 'generate', 1, '["art-audio-1"]', ?, ?)
  `).run(now, now);

  // Remote item (infographic)
  db.prepare(`
    INSERT INTO remote_items (id, book_id, kind, remote_id, type, title, status, last_seen_at)
    VALUES ('ri-v5-infog', 'book-v5-1', 'artifact', 'art-infog-1', 'infographic', 'Infografía 1', 'completed', ?)
  `).run(now);

  // Download jobs: in progress and queued
  db.prepare(`
    INSERT INTO download_jobs (id, request_id, book_id, remote_item_id, format, profile, state, attempts, created_at, started_at)
    VALUES ('dj-v5-in-progress', 'req-dj-1', 'book-v5-1', 'ri-v5-infog', 'png', 'default', 'downloading', 1, ?, ?)
  `).run(now, now);

  db.prepare(`
    INSERT INTO download_jobs (id, request_id, book_id, remote_item_id, format, profile, state, attempts, created_at)
    VALUES ('dj-v5-queued', 'req-dj-2', 'book-v5-1', 'ri-v5-infog', 'png', 'default', 'queued', 0, ?)
  `).run(now);

  return db;
}


