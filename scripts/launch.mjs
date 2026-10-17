import { fork, spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { root, version, dataDir } from '../runtime.mjs';

const dev = process.argv.includes('--dev');
const noBrowser = process.env.BLOQUEAUDIO_NO_BROWSER === '1';
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('BloqueAudio requiere Node.js 24.');
console.log(`BloqueAudio ${version} · ${dev ? 'Desarrollo' : 'Distribución'}\nBiblioteca: ${dataDir}\nCtrl+C para cerrar.`);
let child, watcher, stopping = false, restart = false, opened = false, timer;
function start() {
  child = fork(join(root, 'server.mjs'), [], { cwd: root, stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, BLOQUEAUDIO_MODE: dev ? 'development' : 'distribution' } });
  child.on('message', message => {
    if (message?.type !== 'ready') return;
    console.log(`Listo: ${message.origin}`);
    if (!opened && !noBrowser) {
      opened = true;
      const browser = spawn('explorer.exe', [message.origin], { shell: false, windowsHide: true, stdio: 'ignore' });
      browser.on('error', () => console.log(`Abre ${message.origin} en el navegador.`)); browser.unref();
    }
  });
  child.on('error', e => { console.error(e.message); stop(1); });
  child.on('exit', code => {
    clearTimeout(timer);
    if (restart && !stopping) { restart = false; start(); }
    else { watcher?.close(); process.exitCode = code || 0; }
  });
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true; watcher?.close(); clearTimeout(timer); process.exitCode = code;
  if (child?.connected) child.send({ type: 'shutdown' });
}
process.once('SIGINT', () => stop()); process.once('SIGTERM', () => stop());
if (dev) {
  // Watch source only: data, exports and build outputs never trigger a restart.
  watcher = watch(root, { recursive: true }, (event, name) => {
    if (!name || stopping || !/^(?:[^\\/]+\.mjs|package\.json)$/.test(name)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (restart || !child?.connected) return;
      console.log('Cambio de código: cerrando la cola antes de reiniciar…');
      restart = true; child.send({ type: 'shutdown' });
    }, 350);
  });
  console.log('Backend: reinicio seguro al guardar. Interfaz: recarga la pestaña para ver cambios.');
}
start();
