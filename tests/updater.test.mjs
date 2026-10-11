import test from 'node:test';
import assert from 'node:assert/strict';
import { AppUpdater } from '../electron/updater.mjs';

test('AppUpdater: estado inicial y máquina de estados', () => {
  const events = [];
  const updater = new AppUpdater({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    onStateChange: (state) => events.push({ ...state }),
    closeBackend: async () => {},
  });

  assert.equal(updater.getState().status, 'idle');
  assert.equal(updater.getState().percent, 0);

  updater.setState({ status: 'checking' });
  assert.equal(updater.getState().status, 'checking');

  updater.setState({ status: 'downloading', percent: 45 });
  assert.equal(updater.getState().status, 'downloading');
  assert.equal(updater.getState().percent, 45);

  updater.setState({ status: 'downloaded', version: '1.0.1', percent: 100 });
  assert.equal(updater.getState().status, 'downloaded');
  assert.equal(updater.getState().version, '1.0.1');

  assert.equal(events.length, 3);
  updater.destroy();
});
