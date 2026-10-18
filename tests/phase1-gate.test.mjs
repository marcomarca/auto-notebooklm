import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectorGate } from '../connector-gate.mjs';
import { Provider, ProviderError } from '../provider.mjs';
import { Accounts } from '../accounts.mjs';
import { CallConcurrencyTracker } from './helpers.mjs';

class MockRunner {
  constructor(tracker, { delay = 25, failOn } = {}) {
    this.tracker = tracker;
    this.delay = delay;
    this.failOn = failOn;
    this.closed = false;
  }
  async run(binary, args, options = {}) {
    if (this.closed) throw new ProviderError('UNAVAILABLE', 'Runner cerrado');
    if (options.signal?.aborted) throw new ProviderError('ABORTED', 'Operación cancelada localmente.', true);

    const callKey = `${binary.includes('python') ? 'python' : (binary.includes('ffmpeg') ? 'ffmpeg' : 'nlm')} ${args[0] || ''}`.trim();
    return this.tracker.track(callKey, async () => {
      if (this.failOn && args.includes(this.failOn)) {
        throw new ProviderError('PROVIDER', `Fallo provocado en ${this.failOn}`);
      }
      if (options.signal) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, this.delay);
          options.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new ProviderError('ABORTED', 'Cancelado durante ejecución', true));
          }, { once: true });
        });
      } else {
        await new Promise(resolve => setTimeout(resolve, this.delay));
      }

      if (args.includes('--version')) return 'notebooklm-mcp-cli 0.12.0\n';
      if (args[0] === 'usage') return JSON.stringify({ windows: [{ window: 'rolling', percent_remaining: 100 }] });
      if (args[0] === 'notebook' && args[1] === 'list') return JSON.stringify({ notebooks: [] });
      if (args[0] === 'source' && args[1] === 'list') return JSON.stringify({ sources: [] });
      if (args[0] === 'studio' && args[1] === 'status') return JSON.stringify({ artifacts: [] });
      if (args[0] === 'login' && args[1] === 'profile' && args[2] === 'list') return '  default: user1@example.com\n  cuenta2: user2@example.com\n';
      if (args[0] === 'login') return 'Login success';
      if (binary.includes('ffmpeg')) return '';
      return JSON.stringify({ ok: true, artifact_id: 'art-mock-1' });
    });
  }
  async close() {
    this.closed = true;
  }
}

test('Fase 1: CLI + bridge + chequeos concurrentes observan máximo 1 operación en el conector', async (t) => {
  const gate = new ConnectorGate({ capacity: 1 });
  const tracker = new CallConcurrencyTracker();
  t.after(async () => {
    await gate.close();
  });

  const p1 = new Provider({ profile: 'default', runnerFactory: () => new MockRunner(tracker), gate });
  const p2 = p1.forProfile('cuenta2');

  // Trigger 4 operations concurrently across profiles, CLI and bridge
  const [r1, r2, r3, r4] = await Promise.all([
    p1.cli(['notebook', 'list', '--json']),
    p2.bridge(['audio', 'create', 'nb-1', '--json']),
    p1.check(),
    p2.usage()
  ]);

  assert.ok(r1);
  assert.ok(r2);
  assert.ok(r3.ready);
  assert.ok(r4);

  assert.equal(gate.maxConcurrentObserved, 1, 'ConnectorGate no debe permitir más de 1 llamada concurrente');
  assert.equal(gate.active, 0, 'La puerta debe quedar libre tras finalizar');
  assert.equal(gate.waiting, 0, 'No deben quedar solicitudes en espera');
});

test('Fase 1: Cancelar comando en espera de turno nunca llega a arrancar y no bloquea la puerta', async (t) => {
  const gate = new ConnectorGate({ capacity: 1 });
  const tracker = new CallConcurrencyTracker();
  t.after(async () => {
    await gate.close();
  });

  const p1 = new Provider({ profile: 'default', runner: new MockRunner(tracker, { delay: 60 }), gate });
  const controller = new AbortController();

  // Op 1 takes the permit
  const op1 = p1.cli(['notebook', 'list', '--json']);

  // Op 2 waits in gate queue
  const op2 = p1.cli(['usage', '--json'], { signal: controller.signal });

  // Cancel Op 2 before Op 1 finishes
  controller.abort();

  await assert.rejects(op2, (err) => {
    assert.equal(err.code, 'ABORTED');
    return true;
  });

  await op1;

  // Verify Op 2 never ran
  assert.ok(!tracker.calls.includes('nlm usage'), 'Comando cancelado en espera no debió ejecutarse');

  // Next command should work normally
  const op3 = await p1.cli(['notebook', 'list', '--json']);
  assert.ok(op3);
  assert.equal(gate.active, 0);
});

test('Fase 1: Fallo o error en comando libera el permiso para los siguientes', async (t) => {
  const gate = new ConnectorGate({ capacity: 1 });
  const tracker = new CallConcurrencyTracker();
  t.after(async () => {
    await gate.close();
  });

  const p1 = new Provider({
    profile: 'default',
    runner: new MockRunner(tracker, { failOn: 'fail-now' }),
    gate
  });

  // Op 1 fails
  await assert.rejects(
    p1.cli(['fail-now']),
    /Fallo provocado/
  );

  // Gate must be released immediately
  assert.equal(gate.active, 0);

  // Op 2 succeeds
  const op2 = await p1.cli(['notebook', 'list', '--json']);
  assert.ok(op2);
  assert.equal(gate.active, 0);
});

test('Fase 1: FFmpeg lento no ocupa la puerta del conector', async (t) => {
  const gate = new ConnectorGate({ capacity: 1 });
  const tracker = new CallConcurrencyTracker();
  t.after(async () => {
    await gate.close();
  });

  const p1 = new Provider({ profile: 'default', runner: new MockRunner(tracker, { delay: 40 }), gate });

  // Start FFmpeg directly via runner (as convert/validate does)
  const ffmpegTask = p1.runner.run(p1.ffmpeg, ['-version']);

  // Concurrently run connector CLI call
  const cliTask = p1.cli(['notebook', 'list', '--json']);

  await Promise.all([ffmpegTask, cliTask]);

  // Both ran, but gate maxConcurrentObserved was at most 1 because FFmpeg doesn't acquire the gate
  assert.equal(gate.maxConcurrentObserved, 1);
  assert.equal(gate.active, 0);
});

test('Fase 1: Login explícito entra por la puerta y no causa bloqueo recursivo', async (t) => {
  const gate = new ConnectorGate({ capacity: 1 });
  const tracker = new CallConcurrencyTracker();
  t.after(async () => {
    await gate.close();
  });

  const p1 = new Provider({ profile: 'default', runner: new MockRunner(tracker), gate });
  
  // Login executes through cli() which enters gate
  const res = await p1.login({ clear: false, force: false });
  assert.ok(res);
  assert.equal(gate.active, 0);

  // Subsequent check works without deadlock
  const chk = await p1.check();
  assert.ok(chk.ready);
  assert.equal(gate.active, 0);
});
