import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

async function calculateSha256(filePath) {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function collectFiles(dir, baseDir = dir) {
  const results = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const fullPath = join(dir, ent.name);
      if (ent.isDirectory()) {
        // Skip temporary or lock directories
        if (ent.name.startsWith('.tmp') || ent.name === 'node_modules' || ent.name === '.git') continue;
        results.push(...await collectFiles(fullPath, baseDir));
      } else if (ent.isFile()) {
        const name = ent.name.toLowerCase();
        // Strictly exclude credentials, sessions, locks, and active WAL temporary files
        if (
          name.includes('cookie') ||
          name.includes('token') ||
          name.includes('credential') ||
          name.endsWith('-wal') ||
          name.endsWith('-shm') ||
          name === '.running' ||
          name.endsWith('.lock')
        ) {
          continue;
        }
        results.push({
          fullPath,
          relPath: relative(baseDir, fullPath).replace(/\\/g, '/')
        });
      }
    }
  } catch {}
  return results;
}

export async function createBackup({
  store,
  dataDir,
  exportsDir,
  targetBackupDir
} = {}) {
  const backupDir = resolve(targetBackupDir);
  const tempBackupDir = join(dirname(backupDir), `.tmp-backup-${randomUUID().slice(0, 8)}`);

  await mkdir(tempBackupDir, { recursive: true });

  const backupDbPath = join(tempBackupDir, 'queue.sqlite');
  // 1. Consistent SQLite snapshot via VACUUM INTO
  const escapedDbPath = backupDbPath.replace(/'/g, "''");
  store.db.exec(`VACUUM INTO '${escapedDbPath}'`);

  const backedUpFiles = [];

  // Record database in manifest
  const dbSha256 = await calculateSha256(backupDbPath);
  const dbStat = await stat(backupDbPath);
  backedUpFiles.push({
    relativePath: 'queue.sqlite',
    sizeBytes: dbStat.size,
    sha256: dbSha256
  });

  // 2. Backup data files (source markdown, pdfs, audio)
  if (dataDir) {
    const dataFiles = await collectFiles(resolve(dataDir));
    const destDataDir = join(tempBackupDir, 'data');
    for (const file of dataFiles) {
      // Don't copy queue.sqlite again through the data walk
      if (file.relPath === 'queue.sqlite') continue;
      const destPath = join(destDataDir, file.relPath);
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(file.fullPath, destPath);

      const fileSha = await calculateSha256(destPath);
      const fileStat = await stat(destPath);
      backedUpFiles.push({
        relativePath: `data/${file.relPath}`,
        sizeBytes: fileStat.size,
        sha256: fileSha
      });
    }
  }

  // 3. Backup exports files (audio outputs, infographics, deliveries)
  if (exportsDir) {
    const exportFiles = await collectFiles(resolve(exportsDir));
    const destExportsDir = join(tempBackupDir, 'exports');
    for (const file of exportFiles) {
      const destPath = join(destExportsDir, file.relPath);
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(file.fullPath, destPath);

      const fileSha = await calculateSha256(destPath);
      const fileStat = await stat(destPath);
      backedUpFiles.push({
        relativePath: `exports/${file.relPath}`,
        sizeBytes: fileStat.size,
        sha256: fileSha
      });
    }
  }

  // 4. Create backup-manifest.json
  const manifest = {
    schemaVersion: '1.0.0',
    createdAt: Date.now(),
    dbUserVersion: 6,
    summary: {
      fileCount: backedUpFiles.length,
      totalBytes: backedUpFiles.reduce((acc, f) => acc + f.sizeBytes, 0)
    },
    files: backedUpFiles
  };

  await writeFile(join(tempBackupDir, 'backup-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // Atomic promote
  await rm(backupDir, { recursive: true, force: true });
  await rename(tempBackupDir, backupDir);

  return {
    ok: true,
    backupDir,
    manifest
  };
}

export async function validateBackup(backupDir) {
  const dir = resolve(backupDir);
  const manifestPath = join(dir, 'backup-manifest.json');
  let manifest;
  try {
    const raw = await readFile(manifestPath, 'utf8');
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Manifiesto de respaldo inválido o ausente: ${err.message}`);
  }

  // 1. Verify files exist and match checksum
  for (const item of manifest.files || []) {
    const filePath = join(dir, item.relativePath);
    let s;
    try {
      s = await stat(filePath);
    } catch {
      throw new Error(`Archivo faltante en el respaldo: ${item.relativePath}`);
    }
    if (s.size !== item.sizeBytes) {
      throw new Error(`Tamaño de archivo inconsistente para ${item.relativePath}`);
    }
    const actualSha = await calculateSha256(filePath);
    if (actualSha !== item.sha256) {
      throw new Error(`Checksum corrupto para ${item.relativePath}`);
    }
  }

  // 2. Verify SQLite database integrity & schema version
  const dbPath = join(dir, 'queue.sqlite');
  let testDb;
  try {
    testDb = new DatabaseSync(dbPath, { readOnly: true });
    const integrity = testDb.prepare('PRAGMA integrity_check').all();
    if (!integrity || integrity[0]?.integrity_check !== 'ok') {
      throw new Error('Fallo de integridad interna en SQLite.');
    }
    const userVersionRow = testDb.prepare('PRAGMA user_version').get();
    const userVersion = userVersionRow ? Object.values(userVersionRow)[0] : 0;
    if (userVersion < 6) {
      throw new Error(`Versión de esquema obsoleta (${userVersion}), se esperaba al menos v6.`);
    }
  } finally {
    if (testDb) testDb.close();
  }

  return {
    valid: true,
    manifest
  };
}

export async function restoreBackup({
  backupDir,
  targetDataDir,
  targetExportsDir,
  validateOnly = false
} = {}) {
  // Validate first
  const { manifest } = await validateBackup(backupDir);
  if (validateOnly) return { ok: true, validated: true, manifest };

  const dir = resolve(backupDir);
  const destData = resolve(targetDataDir);
  const destExports = targetExportsDir ? resolve(targetExportsDir) : null;

  // Restore database
  await mkdir(destData, { recursive: true });
  await copyFile(join(dir, 'queue.sqlite'), join(destData, 'queue.sqlite'));

  // Restore data & exports files
  for (const item of manifest.files) {
    if (item.relativePath === 'queue.sqlite') continue;
    const srcPath = join(dir, item.relativePath);

    let targetPath;
    if (item.relativePath.startsWith('data/')) {
      targetPath = join(destData, item.relativePath.slice(5));
    } else if (item.relativePath.startsWith('exports/') && destExports) {
      targetPath = join(destExports, item.relativePath.slice(8));
    } else {
      continue;
    }

    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(srcPath, targetPath);
  }

  return {
    ok: true,
    restored: true,
    manifest
  };
}
