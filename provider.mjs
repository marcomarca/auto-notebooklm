import { spawn } from 'node:child_process';
import { stat, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export class ProviderError extends Error {
  constructor(code, message, uncertain = false) { super(message); this.code = code; this.uncertain = uncertain; }
}
export function redact(value) {
  return String(value).replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[cuenta]')
    .replace(/((?:cookie|token|authorization|csrf|session_id)[\w-]*\s*[=:]\s*)[^\s,;]+/gi, '$1[oculto]');
}
export function classify(message) {
  const text = String(message);
  if (/network_error|ConnectTimeout|ECONN|socket|502|503|504/i.test(text)) return 'TEMPORARY';
  if (/auth|cookies? expired|log.?in|session expired|unauthenticated|401/i.test(text)) return 'AUTH_REQUIRED';
  if (/resource.exhausted|quota|rate.?limit|429|allowance|usage limit/i.test(text)) return 'QUOTA';
  if (/timeout|timed out|ECONN|network|connection|socket|502|503|504|temporarily|not ready|propagat/i.test(text)) return 'TEMPORARY';
  if (/invalid.argument|validation|too many sources|source limit|maximum.*sources|file.*large|unsupported|not found|400|403/i.test(text)) return 'REJECTED';
  return 'PROVIDER';
}

export class CommandRunner {
  constructor() { this.children = new Set(); this.terminating = new WeakSet(); }
  terminate(child) {
    if (this.terminating.has(child) || child.exitCode !== null || child.signalCode !== null) return;
    this.terminating.add(child);
    if (process.platform !== 'win32' || !child.pid) { child.kill(); return; }
    // Windows console-script launchers can spawn Python; close only this child's process tree.
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
    killer.on('close', code => { if (code !== 0) child.kill(); });
  }
  run(binary, args, { timeout = 120000, env = {}, windowsHide = true } = {}) {
    if (this.closed) return Promise.reject(new ProviderError('UNAVAILABLE', 'La aplicación está cerrando.'));
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { shell: false, windowsHide, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      this.children.add(child);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      let stdout = '', stderr = '', failure;
      const timer = setTimeout(() => { failure = new ProviderError('TEMPORARY', 'La operación excedió su tiempo de espera.', true); this.terminate(child); }, timeout);
      const collect = which => data => {
        if (which === 'out') stdout += data.toString('utf8'); else stderr += data.toString('utf8');
        if (stdout.length + stderr.length > 16 * 1024 * 1024) {
          failure = new ProviderError('PROVIDER', 'Respuesta del proveedor demasiado grande.', true); this.terminate(child);
        }
      };
      child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
      child.on('error', e => { failure = new ProviderError('UNAVAILABLE', `No se pudo ejecutar ${binary}: ${redact(e.message)}`); });
      child.on('close', code => {
        clearTimeout(timer); this.children.delete(child);
        if (failure) reject(failure);
        else if (code !== 0) {
          const raw = (stderr || stdout || 'El proveedor terminó sin respuesta.').trim();
          let message = raw;
          try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
              message = parsed.error || parsed.message || parsed.detail || raw;
              if (typeof message === 'object') message = JSON.stringify(message);
            }
          } catch {}
          message = redact(message).slice(0, 1200);
          reject(new ProviderError(classify(message || raw), message, code === null));
        } else resolve(stdout);
      });
    });
  }
  async close() {
    this.closed = true;
    const children = [...this.children];
    await Promise.all(children.map(child => new Promise(resolve => { child.once('close', resolve); this.terminate(child); })));
  }
}

function json(text) {
  try { return JSON.parse(text); }
  catch { throw new ProviderError('PROVIDER', 'La CLI devolvió una respuesta JSON inválida.', true); }
}
function remoteId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new ProviderError('PROVIDER', 'ID remoto ausente o inválido.', true);
  return value;
}
function array(value, key) {
  const rows = Array.isArray(value) ? value : value?.[key];
  if (!Array.isArray(rows)) throw new ProviderError('PROVIDER', `Formato inesperado al consultar ${key}.`);
  return rows;
}

export class Provider {
  constructor({ profile = 'default', runner = new CommandRunner(), nlm = process.env.NLM_BINARY || 'nlm', ffmpeg = process.env.FFMPEG_BINARY || 'ffmpeg', python = process.env.PYTHON_BINARY || (process.platform === 'win32' ? (process.env.APPDATA ? `${process.env.APPDATA}\\uv\\tools\\notebooklm-mcp-cli\\Scripts\\python.exe` : 'python') : 'python3'), bridgeScript = process.env.NLM_BRIDGE_SCRIPT || './scripts/nlm_bridge.py' } = {}) {
    if (!/^[\w-]{1,80}$/.test(profile)) throw new Error('NLM_PROFILE inválido.');
    this.profile = profile; this.runner = runner; this.nlm = nlm; this.ffmpeg = ffmpeg;
    this.python = python; this.bridgeScript = bridgeScript;
    this.health = { ready: false, profile, cli: false, ffmpeg: false, auth: false, error: 'Comprobando conexión…' };
  }
  async bridge(args, { parse = true, timeout = 120000, windowsHide = true } = {}) {
    const stdout = await this.runner.run(this.python, [this.bridgeScript, ...args], { timeout, windowsHide, env: { NLM_PROFILE: this.profile, NO_COLOR: '1', TERM: 'dumb', COLUMNS: '240' } });
    const result = parse ? json(stdout) : stdout;
    if (parse && result?.error) {
      const raw = result.error;
      const message = redact(typeof raw === 'object' ? (raw.error || raw.message || JSON.stringify(raw)) : String(raw));
      throw new ProviderError(classify(message), message);
    }
    return result;
  }
  async cli(args, { parse = true, timeout = 120000, windowsHide = true } = {}) {
    const stdout = await this.runner.run(this.nlm, args, { timeout, windowsHide, env: { NLM_PROFILE: this.profile, NO_COLOR: '1', TERM: 'dumb', COLUMNS: '240' } });
    const result = parse ? json(stdout) : stdout;
    if (parse && result?.error) {
      const raw = result.error;
      const message = redact(typeof raw === 'object' ? (raw.error || raw.message || JSON.stringify(raw)) : String(raw));
      throw new ProviderError(classify(message), message);
    }
    return result;
  }
  async check() {
    const h = { ready: false, profile: this.profile, cli: false, ffmpeg: false, auth: false, error: null };
    try {
      const version = await this.cli(['--version'], { parse: false, timeout: 15000 });
      h.version = version.trim(); h.cli = /0\.12\.0\b/.test(version);
      if (!h.cli) throw new Error('Se requiere notebooklm-mcp-cli 0.12.0 para los contratos verificados.');
      await this.runner.run(this.ffmpeg, ['-version'], { timeout: 15000 }); h.ffmpeg = true;
      // A successful usage read verifies the session without the expensive login --check catalog scan.
      h.usage = await this.usage(); h.auth = true; h.ready = true;
    } catch (e) {
      h.error = redact(e.message); h.errorCode = e.code || 'UNAVAILABLE';
      // Some profiles do not expose usage. A read-only notebook list can still verify auth.
      if (h.cli && h.ffmpeg && e.code !== 'AUTH_REQUIRED') {
        try { await this.listBooks(); h.auth = true; h.ready = true; h.usageWarning = h.error; h.error = null; } catch (err) { h.error = redact(err.message); h.errorCode = err.code; }
      }
    }
    this.health = h; return h;
  }
  async usage() {
    const value = await this.cli(['usage', '--json', '-p', this.profile], { timeout: 45000 });
    if (!Array.isArray(value.windows) || !value.windows.length) throw new ProviderError('PROVIDER', 'NotebookLM no informó la cuota disponible.');
    return value;
  }
  async listBooks() { return array(await this.cli(['notebook', 'list', '--json', '-p', this.profile]), 'notebooks'); }
  async profiles() {
    // Reuse nlm's profile store, as NotebooklmPRO does. Never read cookie files.
    const output = await this.cli(['login', 'profile', 'list'], { parse: false, timeout: 15000 });
    return [...output.matchAll(/^\s+([\w-]{1,80}):\s*(.*?)\s*$/gm)].map(m => ({
      id: m[1], email: /^[^\s@]+@[^\s@]+$/.test(m[2]) ? m[2] : null
    }));
  }
  async access(bookId, email) {
    if (!email) throw new ProviderError('ACCESS', 'Comprueba primero la identidad guardada de esta cuenta.');
    const value = await this.cli(['share', 'status', remoteId(bookId), '--json', '-p', this.profile]);
    const me = value.collaborators?.find(c => c.email?.toLowerCase() === email.toLowerCase());
    if (!me || !['owner', 'editor'].includes(me.role) || me.is_pending)
      throw new ProviderError('ACCESS', 'Esta cuenta necesita acceso de edición activo al mismo cuaderno. Compártelo desde NotebookLM y vuelve a verificar.');
    await this.sources(bookId);
    return true;
  }
  async shareInvite(bookId, email, role = 'editor') {
    return this.cli(['share', 'invite', remoteId(bookId), email, '--role', role, '-p', this.profile]);
  }
  async login({ clear = true, force = true } = {}) {
    const args = ['login', '-p', this.profile];
    if (clear) args.push('--clear');
    if (force) args.push('--force');
    return this.cli(args, { parse: false, timeout: 360000, windowsHide: false });
  }
  async createBook(name) {
    const r = await this.cli(['notebook', 'create', name, '--json', '-p', this.profile]);
    return remoteId(r.notebook_id);
  }
  async sources(bookId) {
    return array(await this.cli(['source', 'list', remoteId(bookId), '--full', '--json', '-p', this.profile]), 'sources');
  }
  async upload(bookId, block) {
    const r = await this.cli(['source', 'add', remoteId(bookId), '--file', block.file_path, '--title', block.source_title,
      '--wait', '--wait-timeout', '600', '--json', '-p', this.profile], { timeout: 660000 });
    return remoteId(r.source_id);
  }
  async artifacts(bookId, artifactId) {
    if (artifactId) {
      const args = ['studio', 'status', remoteId(bookId), '--full', '--json', '--mcp-compatible', '--artifact-id', remoteId(artifactId), '-p', this.profile];
      return array(await this.cli(args), 'artifacts');
    }
    const all = [];
    const seen = new Set();
    let offset = 0;
    const limit = 100;
    while (true) {
      const args = ['studio', 'status', remoteId(bookId), '--full', '--json', '--mcp-compatible', '--limit', String(limit), '--offset', String(offset), '-p', this.profile];
      const page = array(await this.cli(args), 'artifacts');
      let newCount = 0;
      for (const item of page) {
        const id = item.artifact_id || item.id;
        if (id && !seen.has(id)) {
          seen.add(id);
          all.push(item);
          newCount++;
        } else if (!id) {
          all.push(item);
          newCount++;
        }
      }
      if (page.length < limit || newCount === 0 || all.length >= 2000) break;
      offset += limit;
    }
    return all;
  }
  async generate(bookId, sourceId, { defer = false } = {}) {
    // Never let the CLI's omitted-source default broaden this to the whole notebook.
    const source = remoteId(sourceId);
    let r;
    if (defer) {
      r = await this.bridge(['audio', 'create', remoteId(bookId), '--source-ids', source, '--format', 'deep_dive',
        '--length', 'default', '--language', 'es-419', '--later', '--confirm', '--json', '-p', this.profile]);
    } else {
      r = await this.cli(['audio', 'create', remoteId(bookId), '--source-ids', source, '--format', 'deep_dive',
        '--length', 'default', '--language', 'es-419', '--confirm', '--json', '-p', this.profile]);
    }
    return remoteId(r.artifact_id);
  }
  async download(bookId, artifactId, destination) {
    await mkdir(dirname(destination), { recursive: true });
    const tmp = `${destination}.part.m4a`;
    await rm(tmp, { force: true });
    await this.cli(['download', 'audio', remoteId(bookId), '--id', remoteId(artifactId), '--output', tmp, '--no-progress'], { parse: false, timeout: 660000 });
    await this.validate(tmp); await rename(tmp, destination);
  }
  async validate(file) {
    if ((await stat(file)).size < 128) throw new ProviderError('TEMPORARY', 'El audio descargado está vacío o incompleto.');
    await this.runner.run(this.ffmpeg, ['-v', 'error', '-xerror', '-i', file, '-map', '0:a:0', '-f', 'null', '-'], { timeout: 180000 });
  }
  async convert(original, destination) {
    const tmp = `${destination}.part.mp3`;
    await this.runner.run(this.ffmpeg, ['-nostdin', '-v', 'error', '-y', '-i', original, '-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-q:a', '2', tmp], { timeout: 300000 });
    await this.validate(tmp); await rename(tmp, destination);
  }
  close() { return this.runner.close(); }
}
