import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';

test('migraciones SQLite: inicializa en user_version 5 y es idempotente', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nlm-test-migrate-'));
  const dbFile = join(dir, 'test.sqlite');
  try {
    const store = new Store(dbFile);
    assert.equal(store.getUserVersion(), 5);
    
    // Check tables exist
    const tables = store.all("SELECT name FROM sqlite_master WHERE type='table'").map(t => t.name);
    assert.ok(tables.includes('books'));
    assert.ok(tables.includes('blocks'));
    assert.ok(tables.includes('accounts'));
    assert.ok(tables.includes('book_accounts'));
    assert.ok(tables.includes('settings'));
    assert.ok(tables.includes('remote_items'));
    assert.ok(tables.includes('download_jobs'));
    assert.ok(tables.includes('remote_operations'));

    // Check migrated columns
    const blockCols = store.all('PRAGMA table_info(blocks)').map(c => c.name);
    assert.ok(blockCols.includes('generation_profile'));
    assert.ok(blockCols.includes('generation_mode'));
    assert.ok(blockCols.includes('cancel_requested_at'));
    assert.ok(blockCols.includes('canceled_at'));
    assert.ok(blockCols.includes('download_policy'));

    const bookCols = store.all('PRAGMA table_info(books)').map(c => c.name);
    assert.ok(bookCols.includes('numbering'));
    assert.ok(bookCols.includes('generation_mode'));
    assert.ok(bookCols.includes('origin'));
    assert.ok(bookCols.includes('profile_email_at_link'));
    assert.ok(bookCols.includes('last_synced_at'));

    store.close();

    // Reopen database without re-running migrations or downgrading user_version
    const reopened = new Store(dbFile);
    assert.equal(reopened.getUserVersion(), 5);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
