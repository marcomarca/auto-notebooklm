import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { Provider } from '../provider.mjs';

test('F01 y F02: importRemoteBook actual busca solo por remote_id y mezcla perfiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nlm-f01-'));
  try {
    const store = new Store(join(dir, 'test.sqlite'));
    const book1 = store.importRemoteBook({ remoteId: 'nb-shared', title: 'Cuaderno', profile: 'cuentaA' });
    const book2 = store.importRemoteBook({ remoteId: 'nb-shared', title: 'Cuaderno', profile: 'cuentaB' });
    assert.equal(book1.profile, 'cuentaA');
    const hasBugF01 = (book2.profile === 'cuentaA' && book1.id === book2.id);
    assert.ok(hasBugF01, 'Demostrado F01: importRemoteBook devuelve la fila de otra cuenta');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F07: importRemoteBlock con status=failed asigna stage=generate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nlm-f07-'));
  try {
    const store = new Store(join(dir, 'test.sqlite'));
    const book = store.createBook({ title: 'Test', requestId: 'req-1' }, 'default');
    const block = store.importRemoteBlock(book.id, {
      artifactId: 'art-fail-1',
      status: 'failed',
      profile: 'default'
    });
    assert.equal(block.stage, 'generate', 'Demostrado F07: artefacto fallido entra a stage generate');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F14: Provider.forProfile comparte CommandRunner y cerrar un perfil inhabilita el otro', async () => {
  const p1 = new Provider({ profile: 'p1' });
  const p2 = p1.forProfile('p2');
  assert.equal(p1.runner, p2.runner, 'Demostrado F14: comparten runner');
  await p2.close();
  assert.equal(p1.runner.closed, true, 'Demostrado F14: cerrar p2 cierra el runner compartido de p1');
});
