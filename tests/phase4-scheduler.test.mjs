import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { Accounts } from '../accounts.mjs';
import { Queue, quotaRetry } from '../queue.mjs';
import { ProviderError } from '../provider.mjs';
import { ConnectorGate } from '../connector-gate.mjs';
import { FakeProvider, CallConcurrencyTracker } from './helpers.mjs';

class GatedMultiProvider extends FakeProvider {
  constructor(profile, shared, gate, tracker) {
    super();
    this.profile = profile;
    this.health.profile = profile;
    this.remoteSources = shared.sources;
    this.remoteArtifacts = shared.artifacts;
    this.role = 'editor';
    this.closed = false;
    this.gate = gate;
    this.tracker = tracker;
  }
  async profiles() {
    return [
      { id: 'default', email: 'owner@example.com' },
      { id: 'cuenta2', email: 'editor2@example.com' },
      { id: 'cuenta3', email: 'editor3@example.com' },
      { id: 'cuenta4', email: 'editor4@example.com' }
    ];
  }
  async check() {
    return this.gate.withPermit(() => this.tracker.track(`check-${this.profile}`, async () => {
      this.health.usage = this.usageData;
      return this.health;
    }));
  }
  async access(book, email) {
    return this.gate.withPermit(() => this.tracker.track(`access-${this.profile}`, async () => {
      this.calls.push(['access', book, email]);
      if (this.role !== 'editor') throw new ProviderError('ACCESS', 'Se requiere rol editor');
      return true;
    }));
  }
  async usage() {
    return this.gate.withPermit(() => this.tracker.track(`usage-${this.profile}`, async () => {
      this.calls.push(['usage']);
      if (this.behavior.usage) throw this.behavior.usage;
      return this.usageData;
    }));
  }
  async generate(book, source, options = {}) {
    return this.gate.withPermit(() => this.tracker.track(`generate-${this.profile}`, async () => {
      this.calls.push(['generate', book, source, options]);
      if (this.rejectQuota) throw new ProviderError('QUOTA', 'Quota exhausted');
      if (this.behavior.generate) throw this.behavior.generate;
      const id = `audio-${this.profile}-${++this.generations}`;
      this.remoteArtifacts.push({ artifact_id: id, type: 'audio', source_ids: [source], status: 'completed' });
      return id;
    }));
  }
  async generateInfographic(book, source, options = {}) {
    return this.gate.withPermit(() => this.tracker.track(`generateInfographic-${this.profile}`, async () => {
      this.calls.push(['generateInfographic', book, source, options]);
      if (this.rejectQuota) throw new ProviderError('QUOTA', 'Quota exhausted');
      if (this.behavior.generateInfographic) throw this.behavior.generateInfographic;
      const id = `infographic-${this.profile}-${++this.generations}`;
      this.remoteArtifacts.push({ artifact_id: id, type: 'infographic', source_ids: [source], status: 'completed', ...options });
      return id;
    }));
  }
  async artifacts(book, id) {
    return this.gate.withPermit(() => this.tracker.track(`artifacts-${this.profile}`, async () => {
      return this.remoteArtifacts.filter(a => !id || a.artifact_id === id);
    }));
  }
  async sources(book) {
    return this.gate.withPermit(() => this.tracker.track(`sources-${this.profile}`, async () => {
      return this.remoteSources;
    }));
  }
  async close() {
    this.closed = true;
  }
}

async function setup4(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-phase4-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const tracker = new CallConcurrencyTracker();
  const gate = new ConnectorGate({ concurrency: 1 });
  const shared = {
    sources: [{ id: 'src-1', status: 2 }, { id: 'src-2', status: 2 }],
    artifacts: []
  };

  const accountIds = ['default', 'cuenta2', 'cuenta3', 'cuenta4'];
  const providers = new Map(accountIds.map(id => [id, new GatedMultiProvider(id, shared, gate, tracker)]));
  let now = Date.now();

  const accounts = new Accounts(store, providers.get('default'), {
    factory: id => providers.get(id),
    gate,
    now: () => now
  });

  await accounts.discover();
  for (const id of ['cuenta2', 'cuenta3', 'cuenta4']) {
    accounts.enable(id, true);
  }

  const options = { dataDir: dir, exportsDir: join(dir, 'exports'), accounts, now: () => now };
  const queue = new Queue(store, providers.get('default'), options);

  t.after(async () => {
    await queue.stop();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const tick = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      await queue.tick();
      now += 60001;
    }
  };

  return {
    dir,
    store,
    shared,
    tracker,
    gate,
    providers,
    accounts,
    queue,
    options,
    tick,
    advance: n => { now += n; },
    now: () => now
  };
}

test('Fase 4: Cuatro perfiles round-robin serialization through ConnectorGate y persistencia de turno', async t => {
  const f = await setup4(t);
  const book = f.store.createBook({ title: 'Libro Cuatro Cuentas', requestId: 'b4' }, 'default');
  f.store.update('books', book.id, { remote_id: 'rem-b4', state: 'ready', running: 1 });
  await f.accounts.configure(f.store.book(book.id), ['cuenta2', 'cuenta3', 'cuenta4']);

  // Add 4 blocks with source ready
  const b1 = f.store.addBlock(book.id, { requestId: 'req-1', title: 'B1', filename: 'b1.md', filePath: join(f.dir, 'b1.md'), hash: 'h1' });
  f.store.update('blocks', b1.id, { stage: 'generate', state: 'ready', source_id: 'src-1' });

  const b2 = f.store.addBlock(book.id, { requestId: 'req-2', title: 'B2', filename: 'b2.md', filePath: join(f.dir, 'b2.md'), hash: 'h2' });
  f.store.update('blocks', b2.id, { stage: 'generate', state: 'ready', source_id: 'src-1' });

  const b3 = f.store.addBlock(book.id, { requestId: 'req-3', title: 'B3', filename: 'b3.md', filePath: join(f.dir, 'b3.md'), hash: 'h3' });
  f.store.update('blocks', b3.id, { stage: 'generate', state: 'ready', source_id: 'src-1' });

  const b4 = f.store.addBlock(book.id, { requestId: 'req-4', title: 'B4', filename: 'b4.md', filePath: join(f.dir, 'b4.md'), hash: 'h4' });
  f.store.update('blocks', b4.id, { stage: 'generate', state: 'ready', source_id: 'src-1' });

  // Process all 4 blocks through the queue
  await f.tick(16);

  const bl1 = f.store.block(b1.id);
  const bl2 = f.store.block(b2.id);
  const bl3 = f.store.block(b3.id);
  const bl4 = f.store.block(b4.id);

  assert.equal(bl1.state, 'done');
  assert.equal(bl2.state, 'done');
  assert.equal(bl3.state, 'done');
  assert.equal(bl4.state, 'done');

  // Verify round-robin sequence used 4 distinct profiles
  const profilesUsed = [bl1.generation_profile, bl2.generation_profile, bl3.generation_profile, bl4.generation_profile];
  assert.deepEqual(profilesUsed, ['default', 'cuenta2', 'cuenta3', 'cuenta4'], 'Debe distribuir los 4 trabajos en round-robin exacto');

  // Verify ConnectorGate max concurrency was strictly 1
  assert.equal(f.tracker.maxActive, 1, 'Todas las operaciones de conector deben ser seriales (max 1)');
  assert.equal(f.gate.maxConcurrentObserved, 1, 'Puerta del conector debe observar concurrencia máxima de 1');

  // Verify persistent round-robin setting
  const lastProfile = f.store.get('SELECT value FROM settings WHERE key=?', `book_last_profile:${book.id}`)?.value;
  assert.equal(lastProfile, 'cuenta4');

  // Add 5th block: should wrap around to 'default'
  const b5 = f.store.addBlock(book.id, { requestId: 'req-5', title: 'B5', filename: 'b5.md', filePath: join(f.dir, 'b5.md'), hash: 'h5' });
  f.store.update('blocks', b5.id, { stage: 'generate', state: 'ready', source_id: 'src-1' });
  f.store.update('books', book.id, { running: 1 });

  await f.tick(4);
  const bl5 = f.store.block(b5.id);
  assert.equal(bl5.state, 'done');
  assert.equal(bl5.generation_profile, 'default', 'Debe rotar de regreso a default tras agotar el ciclo');
});

test('Fase 4: Deduplicación de candidatas por identidad verificada (mismo email no duplica cuota)', async t => {
  const f = await setup4(t);
  const book = f.store.createBook({ title: 'Libro Deduplicación', requestId: 'b-dedup' }, 'default');
  f.store.update('books', book.id, { remote_id: 'rem-dedup', state: 'ready', running: 1 });

  // Set cuenta3 with the same email as cuenta2 directly in DB
  f.store.update('accounts', 'cuenta3', { email: 'editor2@example.com' });

  // Configure cuenta2, cuenta3, cuenta4 in book_accounts table
  f.store.db.prepare('INSERT INTO book_accounts(book_id,profile) VALUES(?,?)').run(book.id, 'cuenta2');
  f.store.db.prepare('INSERT INTO book_accounts(book_id,profile) VALUES(?,?)').run(book.id, 'cuenta3');
  f.store.db.prepare('INSERT INTO book_accounts(book_id,profile) VALUES(?,?)').run(book.id, 'cuenta4');

  // Call candidate multiple times and collect profiles
  const profilesPicked = [];
  for (let i = 0; i < 6; i++) {
    const cand = await f.accounts.candidate(f.store.book(book.id), 'src-1');
    assert.ok(cand.provider);
    profilesPicked.push(cand.provider.profile);
  }

  // cuenta3 shares email with cuenta2, so it should be skipped!
  assert.ok(!profilesPicked.includes('cuenta3'), 'cuenta3 debe omitirse por tener identidad duplicada');
  assert.ok(profilesPicked.includes('default'));
  assert.ok(profilesPicked.includes('cuenta2'));
  assert.ok(profilesPicked.includes('cuenta4'));
});

test('Fase 4: Una cuenta sin sesión y otra sin cuota se saltan; las cuentas habilitadas progresan', async t => {
  const f = await setup4(t);
  const book = f.store.createBook({ title: 'Libro Saltos', requestId: 'b-skips' }, 'default');
  f.store.update('books', book.id, { remote_id: 'rem-skips', state: 'ready', running: 1 });
  await f.accounts.configure(f.store.book(book.id), ['cuenta2', 'cuenta3', 'cuenta4']);

  // cuenta2: expired auth
  f.providers.get('cuenta2').health = { ready: false, auth: false, errorCode: 'AUTH_REQUIRED', error: 'Token expired' };

  // cuenta3: exhausted quota (5 hours reset)
  f.providers.get('cuenta3').usageData = {
    windows: [{ window: 'rolling', percent_remaining: 0, resets_at: new Date(f.now() + 18000000).toISOString() }]
  };

  // Add 2 blocks
  const b1 = f.store.addBlock(book.id, { requestId: 'r1', title: 'B1', filename: 'b1.md', filePath: join(f.dir, 'b1.md'), hash: 'h1' });
  f.store.update('blocks', b1.id, { stage: 'generate', state: 'ready', source_id: 'src-1' });

  const b2 = f.store.addBlock(book.id, { requestId: 'r2', title: 'B2', filename: 'b2.md', filePath: join(f.dir, 'b2.md'), hash: 'h2' });
  f.store.update('blocks', b2.id, { stage: 'generate', state: 'ready', source_id: 'src-1' });

  await f.tick(8);

  const bl1 = f.store.block(b1.id);
  const bl2 = f.store.block(b2.id);

  assert.equal(bl1.state, 'done');
  assert.equal(bl2.state, 'done');

  // Should have skipped cuenta2 (no auth) and cuenta3 (no quota)
  const used = [bl1.generation_profile, bl2.generation_profile];
  assert.ok(used.every(p => ['default', 'cuenta4'].includes(p)), `Cuentas usadas deben ser default o cuenta4, obtenidas: ${used}`);
  assert.ok(!used.includes('cuenta2'));
  assert.ok(!used.includes('cuenta3'));
});

test('Fase 4: Presupuesto compartido y dos ventanas agotadas espera la ventana máxima y no genera infografía', async t => {
  const f = await setup4(t);
  const now = f.now();
  const reset1 = now + 100000;
  const reset2 = now + 500000;

  // Verify quotaRetry calculation waits for Math.max(...resets)
  const usage2Windows = {
    windows: [
      { window: 'hourly', percent_remaining: 0, resets_at: new Date(reset1).toISOString() },
      { window: 'weekly', percent_remaining: 0, resets_at: new Date(reset2).toISOString() }
    ]
  };
  const retryAt = quotaRetry(usage2Windows, now);
  assert.equal(retryAt, reset2 + 60000, 'Debe esperar el reinicio máximo de las dos ventanas más 60s');

  // Exhaust all accounts for this book
  for (const p of f.providers.values()) {
    p.usageData = usage2Windows;
  }

  const book = f.store.createBook({ title: 'Libro Infografía Cuota', requestId: 'b-info-quota' }, 'default');
  f.store.update('books', book.id, { remote_id: 'rem-info-quota', state: 'ready', running: 1 });
  const block = f.store.addBlock(book.id, { requestId: 'b-iq-1', title: 'IQ1', filename: 'iq1.md', filePath: join(f.dir, 'iq1.md'), hash: 'iq1' });
  f.store.update('blocks', block.id, { stage: 'source_ready', state: 'ready', source_id: 'src-1' });

  // Create an infographic task
  const task = f.store.createMaterialTask({
    bookId: book.id,
    blockId: block.id,
    type: 'infographic',
    state: 'planned'
  });

  await f.tick(2);

  const curTask = f.store.materialTask(task.id);
  assert.equal(curTask.state, 'waiting_quota', 'Tarea de infografía debe quedar en waiting_quota');
  assert.ok(curTask.next_at >= reset2, 'next_at debe respetar el tiempo máximo de reinicio');
  assert.equal(f.providers.get('default').calls.filter(c => c[0] === 'generateInfographic').length, 0, 'No debe llamar a generar infografía con cuota compartida agotada');
});

test('Fase 4: Cuota desconocida se maneja de forma tolerante sin bloquear ni entrar en bucle', async t => {
  const f = await setup4(t);
  const book = f.store.createBook({ title: 'Libro Cuota Desconocida', requestId: 'b-unk' }, 'default');
  f.store.update('books', book.id, { remote_id: 'rem-unk', state: 'ready', running: 1 });

  // Default provider throws an unknown/non-fatal error when usage is requested
  f.providers.get('default').behavior.usage = new Error('Usage endpoint not supported by this CLI version');

  const block = f.store.addBlock(book.id, { requestId: 'b-unk-1', title: 'U1', filename: 'u1.md', filePath: join(f.dir, 'u1.md'), hash: 'u1' });
  f.store.update('blocks', block.id, { stage: 'generate', state: 'ready', source_id: 'src-1' });

  await f.tick(4);

  const bl = f.store.block(block.id);
  assert.equal(bl.state, 'done', 'Bloque debe completarse normalmente aunque la cuota no sea legible');
  assert.ok(f.providers.get('default').health.usageWarning, 'Debe registrar advertencia de cuota en lugar de fallar');
});

test('Fase 4: Solicitud incierta y barrera de cuaderno: impide nueva creación en ese cuaderno mientras otro avanza', async t => {
  const f = await setup4(t);

  // Book 1: Has an uncertain baseline block
  const book1 = f.store.createBook({ title: 'Cuaderno Incierto', requestId: 'b-unc-1' }, 'default');
  f.store.update('books', book1.id, { remote_id: 'rem-b1', state: 'ready', running: 1 });
  await f.accounts.configure(f.store.book(book1.id), ['cuenta2']);

  const uncBlock = f.store.addBlock(book1.id, { requestId: 'unc-1', title: 'Unc', filename: 'unc.md', filePath: join(f.dir, 'unc.md'), hash: 'h-unc' });
  f.store.update('blocks', uncBlock.id, {
    stage: 'generate',
    state: 'submitting',
    source_id: 'src-1',
    baseline: JSON.stringify(['old-audio-1']),
    generation_profile: 'default',
    next_at: f.now() + 600000
  });

  const nextBlock1 = f.store.addBlock(book1.id, { requestId: 'next-1', title: 'Next1', filename: 'n1.md', filePath: join(f.dir, 'n1.md'), hash: 'h-n1' });
  f.store.update('blocks', nextBlock1.id, { stage: 'generate', state: 'ready', source_id: 'src-1' });

  // Book 2: Normal book with ready blocks
  const book2 = f.store.createBook({ title: 'Cuaderno Normal', requestId: 'b-norm-2' }, 'cuenta2');
  f.store.update('books', book2.id, { remote_id: 'rem-b2', state: 'ready', running: 1 });

  const b2Block = f.store.addBlock(book2.id, { requestId: 'b2-1', title: 'B2Block', filename: 'b2.md', filePath: join(f.dir, 'b2.md'), hash: 'h-b2' });
  f.store.update('blocks', b2Block.id, { stage: 'generate', state: 'ready', source_id: 'src-2' });

  // Candidate on book1 returns barrier
  const cand1 = await f.accounts.candidate(f.store.book(book1.id), 'src-1');
  assert.equal(cand1.barrier, true, 'Debe activar barrera por baseline incierto');

  // Candidate on book2 succeeds
  const cand2 = await f.accounts.candidate(f.store.book(book2.id), 'src-2');
  assert.ok(cand2.provider, 'Cuaderno normal debe recibir cuenta');

  // Execute queue tick: book2 should proceed to generate and complete, while nextBlock1 remains deferred
  await f.tick(5);

  const updatedB2 = f.store.block(b2Block.id);
  assert.equal(updatedB2.state, 'done', 'Cuaderno 2 debe progresar y terminar');

  const updatedNext1 = f.store.block(nextBlock1.id);
  assert.notEqual(updatedNext1.state, 'done', 'Bloque de cuaderno con baseline incierto no debe haber generado');

  // Now simulate reconciliation of uncBlock
  f.shared.artifacts.push({
    artifact_id: 'audio-reconciled-1',
    type: 'audio',
    source_ids: ['src-1'],
    status: 'completed'
  });
  f.store.update('blocks', uncBlock.id, { next_at: 0 });

  // Reconcile book1
  await f.tick(6);

  const reconciledUnc = f.store.block(uncBlock.id);
  assert.equal(reconciledUnc.state, 'done', 'Bloque incierto reconcilia exitosamente');

  // After reconciliation, the barrier is gone and nextBlock1 can now run!
  await f.tick(6);
  const finishedNext1 = f.store.block(nextBlock1.id);
  assert.equal(finishedNext1.state, 'done', 'Bloque posterior en cuaderno 1 completa tras levantarse la barrera');
});
