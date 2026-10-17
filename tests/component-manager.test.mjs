import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComponentManager } from '../electron/component-manager.mjs';

test('ComponentManager: state management, rollback y limpieza de versiones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nlm-test-comp-'));
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  try {
    const cm = new ComponentManager(dir, logger);
    assert.deepEqual(cm.getState(), { active: null, previous: null, pending: null });

    // Initial state save
    cm.saveState({ active: '1', previous: null, pending: null });
    assert.equal(cm.getState().active, '1');

    // Simulate old version cleanup
    const cDir = join(dir, 'connector');
    mkdirSync(join(cDir, '0'), { recursive: true });
    mkdirSync(join(cDir, '1'), { recursive: true });
    mkdirSync(join(cDir, '2'), { recursive: true });
    cm.cleanOldVersions('2', '1');
    assert.equal(cm.getState().active, '1');

    // Verify corrupt pending triggers rollback / discard
    cm.saveState({ active: '1', previous: null, pending: '99' });
    mkdirSync(join(cDir, '99'), { recursive: true });
    writeFileSync(join(cDir, '99', 'runtime.json'), '{ invalid json }');

    const res = await cm.resolveRuntime();
    const finalState = cm.getState();
    assert.equal(finalState.pending, null);
    assert.equal(finalState.active, '1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime.json con BOM de PowerShell se interpreta y valida sus rutas', () => {
  const dir=mkdtempSync(join(tmpdir(),'nlm-bom-'));
  try {
    writeFileSync(join(dir,'runtime.json'),'\uFEFF'+JSON.stringify({python:'missing-python.exe'}));
    const result=new ComponentManager(dir,{}).verifyRuntimeDir(dir);
    assert.equal(result.ok,false);assert.equal(result.error,'python.exe no existe');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
