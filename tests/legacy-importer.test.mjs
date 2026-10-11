import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importLegacyData } from '../electron/legacy-importer.mjs';

test('importLegacyData: copia data y exports preservando archivos', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'nlm-test-legacy-'));
  const sourceRoot = join(tempDir, 'source');
  const targetRoot = join(tempDir, 'target');

  try {
    // 1. Valid source setup
    mkdirSync(join(sourceRoot, 'data'), { recursive: true });
    mkdirSync(join(sourceRoot, 'exports'), { recursive: true });
    writeFileSync(join(sourceRoot, 'data', 'queue.sqlite'), 'sqlite-header-mock');
    writeFileSync(join(sourceRoot, 'exports', 'sample.mp3'), 'mp3-content-mock');

    const targetPaths = {
      dataDir: join(targetRoot, 'data'),
      exportsDir: join(targetRoot, 'exports'),
    };

    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    const success = importLegacyData(sourceRoot, targetPaths, logger);
    assert.equal(success, true);

    assert.ok(existsSync(join(targetPaths.dataDir, 'queue.sqlite')));
    assert.ok(existsSync(join(targetPaths.exportsDir, 'sample.mp3')));

    // 2. Invalid source without queue.sqlite throws error
    const emptySource = join(tempDir, 'empty-source');
    mkdirSync(emptySource, { recursive: true });
    assert.throws(() => {
      importLegacyData(emptySource, targetPaths, logger);
    }, /queue\.sqlite/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
