import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';

test('migraciones SQLite: inicializa en user_version 4 y es idempotente', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nlm-test-migrate-'));
  const dbFile = join(dir, 'test.sqlite');
  try {
    const store = new Store(dbFile);
    assert.equal(store.getUserVersion(), 4);
    
    // Check tables exist
    const tables = store.all("SELECT name FROM sqlite_master WHERE type='table'").map(t => t.name);
    assert.ok(tables.includes('books'));
    assert.ok(tables.includes('blocks'));
    assert.ok(tables.includes('accounts'));
    assert.ok(tables.includes('book_accounts'));
    assert.ok(tables.includes('settings'));

    // Check migrated columns
    const blockCols = store.all('PRAGMA table_info(blocks)').map(c => c.name);
    assert.ok(blockCols.includes('generation_profile'));
    assert.ok(blockCols.includes('generation_mode'));

    const bookCols = store.all('PRAGMA table_info(books)').map(c => c.name);
    assert.ok(bookCols.includes('numbering'));
    assert.ok(bookCols.includes('generation_mode'));

    store.close();

    // Reopen database without re-running migrations or downgrading user_version
    const reopened = new Store(dbFile);
    assert.equal(reopened.getUserVersion(), 4);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
