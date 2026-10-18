import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';

import { createV5FixtureDb } from './helpers.mjs';

test('migraciones SQLite: inicializa en user_version 6 y es idempotente', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nlm-test-migrate-'));
  const dbFile = join(dir, 'test.sqlite');
  try {
    const store = new Store(dbFile);
    assert.equal(store.getUserVersion(), 6);
    
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
    assert.ok(tables.includes('production_recipes'));
    assert.ok(tables.includes('material_tasks'));
    assert.ok(tables.includes('material_attempts'));
    assert.ok(tables.includes('production_events'));

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
    assert.ok(bookCols.includes('recipe_id'));
    assert.ok(bookCols.includes('recipe_version'));

    store.close();

    // Reopen database without re-running migrations or downgrading user_version
    const reopened = new Store(dbFile);
    assert.equal(reopened.getUserVersion(), 6);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migraciones SQLite: migra base v5 existente a v6 preservando datos y creando material_tasks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nlm-test-migrate-v5-to-v6-'));
  const dbFile = join(dir, 'v5.sqlite');
  try {
    // 1. Create a genuine v5 database with diverse blocks and download jobs
    const v5db = createV5FixtureDb(dbFile);
    assert.equal(Number(v5db.prepare('PRAGMA user_version').get()?.user_version), 5);
    v5db.close();

    // 2. Open with Store to trigger migration v6
    const store = new Store(dbFile);
    assert.equal(store.getUserVersion(), 6);

    // 3. Verify all 6 blocks were migrated to audio material_tasks
    const tasks = store.materialTasks('book-v5-1');
    assert.equal(tasks.length, 6);
    assert.ok(tasks.every(t => t.type === 'audio'));
    assert.ok(tasks.every(t => t.is_current === 1));

    // Check states preserved
    const doneTask = tasks.find(t => t.block_id === 'block-v5-done');
    assert.equal(doneTask.state, 'ready');
    assert.equal(doneTask.output_path, '/tmp/b1.mp3');

    const quotaTask = tasks.find(t => t.block_id === 'block-v5-quota');
    assert.equal(quotaTask.state, 'waiting_quota');

    const authTask = tasks.find(t => t.block_id === 'block-v5-auth');
    assert.equal(authTask.state, 'waiting_auth');

    const canceledTask = tasks.find(t => t.block_id === 'block-v5-canceled');
    assert.equal(canceledTask.state, 'canceled');

    const uncertainTask = tasks.find(t => t.block_id === 'block-v5-uncertain');
    assert.equal(uncertainTask.state, 'submitting');

    // 4. Verify material attempts were created
    const attempts = store.all('SELECT * FROM material_attempts');
    assert.ok(attempts.length >= 5);

    // 5. Verify default recipe was created and linked to book
    const book = store.book('book-v5-1');
    assert.equal(book.recipe_id, 'default-audio');
    assert.equal(book.recipe_version, 1);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
