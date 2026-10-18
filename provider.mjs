import { spawn } from 'node:child_process';
import { stat, mkdir, rename, rm, open } from 'node:fs/promises';
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
  constructor() { this.children = new Set(); this.terminating = new WeakSet(); this.closed = false; }
  terminate(child) {
    if (this.terminating.has(child) || child.exitCode !== null || child.signalCode !== null) return;
    this.terminating.add(child);
    if (process.platform !== 'win32' || !child.pid) { child.kill(); return; }
    // Windows console-script launchers can spawn Python; close only this child's process tree.
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
    killer.on('close', code => { if (code !== 0) child.kill(); });
  }
  run(binary, args, { timeout = 120000, env = {}, windowsHide = true, cwd, signal } = {}) {
    if (this.closed) return Promise.reject(new ProviderError('UNAVAILABLE', 'La aplicación está cerrando.'));
    if (signal?.aborted) return Promise.reject(new ProviderError('ABORTED', 'Operación cancelada localmente.', true));
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { shell: false, windowsHide, cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      this.children.add(child);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      let stdout = '', stderr = '', failure;
      const timer = setTimeout(() => { failure = new ProviderError('TEMPORARY', 'La operación excedió su tiempo de espera.', true); this.terminate(child); }, timeout);
      const onAbort = () => {
        failure = new ProviderError('ABORTED', 'Operación cancelada localmente.', true);
        this.terminate(child);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const collect = which => data => {
        if (which === 'out') stdout += data.toString('utf8'); else stderr += data.toString('utf8');
        if (stdout.length + stderr.length > 16 * 1024 * 1024) {
          failure = new ProviderError('PROVIDER', 'Respuesta del proveedor demasiado grande.', true); this.terminate(child);
        }
      };
      child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
      child.on('error', e => { failure = new ProviderError('UNAVAILABLE', `No se pudo ejecutar ${binary}: ${redact(e.message)}`); });
      child.on('close', code => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.children.delete(child);
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
  constructor({
    profile = 'default',
    runner,
    runnerFactory = () => new CommandRunner(),
    gate,
    nlm = process.env.NLM_BINARY || 'nlm',
    nlmBinary,
    nlmPrefixArgs = [],
    ffmpeg = process.env.FFMPEG_BINARY || 'ffmpeg',
    python = process.env.PYTHON_BINARY || (process.platform === 'win32' ? (process.env.APPDATA ? `${process.env.APPDATA}\\uv\\tools\\notebooklm-mcp-cli\\Scripts\\python.exe` : 'python') : 'python3'),
    bridgeScript = process.env.NLM_BRIDGE_SCRIPT || './scripts/nlm_bridge.py',
  } = {}) {
    if (!/^[\w-]{1,80}$/.test(profile)) throw new Error('NLM_PROFILE inválido.');
    this.profile = profile;
    this.runnerFactory = runnerFactory;
    this.runner = runner || runnerFactory(profile);
    this.gate = gate;
    this.nlmBinary = nlmBinary || nlm;
    this.nlm = this.nlmBinary;
    this.nlmPrefixArgs = Array.isArray(nlmPrefixArgs) ? [...nlmPrefixArgs] : [];
    this.ffmpeg = ffmpeg;
    this.python = python;
    this.bridgeScript = bridgeScript;
    this.health = { ready: false, profile, cli: false, ffmpeg: false, auth: false, error: 'Comprobando conexión…' };
  }
  forProfile(profile) {
    return new Provider({
      profile,
      runner: this.runnerFactory(profile),
      runnerFactory: this.runnerFactory,
      gate: this.gate,
      nlmBinary: this.nlmBinary,
      nlm: this.nlmBinary,
      nlmPrefixArgs: this.nlmPrefixArgs,
      ffmpeg: this.ffmpeg,
      python: this.python,
      bridgeScript: this.bridgeScript,
    });
  }
  async bridge(args, { parse = true, timeout = 120000, windowsHide = true, signal } = {}) {
    const exec = async () => {
      const stdout = await this.runner.run(this.python, [this.bridgeScript, ...args], { timeout, windowsHide, signal, env: { NLM_PROFILE: this.profile, NO_COLOR: '1', TERM: 'dumb', COLUMNS: '240' } });
      const result = parse ? json(stdout) : stdout;
      if (parse && result?.error) {
        const raw = result.error;
        const message = redact(typeof raw === 'object' ? (raw.error || raw.message || JSON.stringify(raw)) : String(raw));
        throw new ProviderError(classify(message), message);
      }
      return result;
    };
    return this.gate ? this.gate.withPermit(exec, { signal }) : exec();
  }
  async cli(args, { parse = true, timeout = 120000, windowsHide = true, signal } = {}) {
    const exec = async () => {
      const fullArgs = [...this.nlmPrefixArgs, ...args];
      const stdout = await this.runner.run(this.nlmBinary, fullArgs, { timeout, windowsHide, signal, env: { NLM_PROFILE: this.profile, NO_COLOR: '1', TERM: 'dumb', COLUMNS: '240' } });
      const result = parse ? json(stdout) : stdout;
      if (parse && result?.error) {
        const raw = result.error;
        const message = redact(typeof raw === 'object' ? (raw.error || raw.message || JSON.stringify(raw)) : String(raw));
        throw new ProviderError(classify(message), message);
      }
      return result;
    };
    return this.gate ? this.gate.withPermit(exec, { signal }) : exec();
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
  async notes(bookId) {
    return array(await this.cli(['note', 'list', remoteId(bookId), '--json', '-p', this.profile]), 'notes');
  }
  async artifacts(bookId, artifactId, { detailed = false } = {}) {
    if (artifactId) {
      const args = ['studio', 'status', remoteId(bookId), '--full', '--json', '--mcp-compatible', '--artifact-id', remoteId(artifactId), '-p', this.profile];
      const items = array(await this.cli(args), 'artifacts');
      return detailed ? { items, truncated: false } : items;
    }
    const all = [];
    const seen = new Set();
    let offset = 0;
    const limit = 100;
    let truncated = false;
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
      if (all.length >= 2000) {
        if (page.length === limit && newCount > 0) truncated = true;
        break;
      }
      if (page.length < limit || newCount === 0) break;
      offset += limit;
    }
    return detailed ? { items: all, truncated } : all;
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
    return remoteId(r.artifact_id || r.id);
  }
  async generateInfographic(bookId, sourceId, {
    orientation = 'landscape',
    detail = 'standard',
    style = 'auto_select',
    language = 'es-419',
    focus
  } = {}) {
    const source = remoteId(sourceId);
    const args = [
      'infographic', 'create', remoteId(bookId),
      '--source-ids', source,
      '--orientation', orientation,
      '--detail', detail,
      '--style', style,
      '--language', language,
      '--confirm',
      '--json',
      '-p', this.profile
    ];
    if (focus && typeof focus === 'string') {
      args.push('--focus', focus);
    }
    const r = await this.cli(args);
    return remoteId(r.artifact_id || r.id);
  }
  async deleteArtifact(bookId, artifactId) {
    const args = ['studio', 'delete', remoteId(bookId), remoteId(artifactId), '--confirm', '-p', this.profile];
    return this.cli(args, { parse: false });
  }
  async download(bookId, artifactId, destination, { signal } = {}) {
    await mkdir(dirname(destination), { recursive: true });
    const tmp = `${destination}.part.m4a`;
    await rm(tmp, { force: true });
    try {
      await this.cli(['download', 'audio', remoteId(bookId), '--id', remoteId(artifactId), '--output', tmp, '--no-progress'], { parse: false, timeout: 660000, signal });
      await this.validate(tmp, { signal });
      await rename(tmp, destination);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
  async validate(file, { signal } = {}) {
    if ((await stat(file)).size < 128) throw new ProviderError('TEMPORARY', 'El audio descargado está vacío o incompleto.');
    await this.runner.run(this.ffmpeg, ['-v', 'error', '-xerror', '-i', file, '-map', '0:a:0', '-f', 'null', '-'], { timeout: 180000, signal });
  }
  async validateImage(file, { signal } = {}) {
    const s = await stat(file);
    if (s.size < 64) throw new ProviderError('TEMPORARY', 'La infografía descargada está vacía o incompleta.');
    const fd = await open(file, 'r');
    const header = Buffer.alloc(24);
    try {
      await fd.read(header, 0, 24, 0);
    } finally {
      await fd.close();
    }
    const isPng = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47 &&
                  header[4] === 0x0D && header[5] === 0x0A && header[6] === 0x1A && header[7] === 0x0A;
    if (isPng) {
      const width = header.readUInt32BE(16);
      const height = header.readUInt32BE(20);
      if (width === 0 || height === 0) {
        throw new ProviderError('TEMPORARY', 'La infografía tiene dimensiones inválidas.');
      }
    }
    if (this.ffmpeg) {
      try {
        await this.runner.run(this.ffmpeg, ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { timeout: 60000, signal });
      } catch (e) {
        throw new ProviderError('TEMPORARY', `La infografía no se pudo decodificar: ${redact(e.message)}`);
      }
    }
  }
  async convert(original, destination, { signal } = {}) {
    const tmp = `${destination}.part.mp3`;
    try {
      await this.runner.run(this.ffmpeg, ['-nostdin', '-v', 'error', '-y', '-i', original, '-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-q:a', '2', tmp], { timeout: 300000, signal });
      await this.validate(tmp, { signal });
      await rename(tmp, destination);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
  async downloadVideo(bookId, artifactId, destination, { signal } = {}) {
    await mkdir(dirname(destination), { recursive: true });
    const tmp = `${destination}.part.mp4`;
    await rm(tmp, { force: true });
    try {
      await this.cli(['download', 'video', remoteId(bookId), '--id', remoteId(artifactId), '--output', tmp, '--no-progress', '-p', this.profile], { parse: false, timeout: 660000, signal });
      if ((await stat(tmp)).size === 0) throw new ProviderError('TEMPORARY', 'El vídeo descargado está vacío.');
      await rename(tmp, destination);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
  async downloadReport(bookId, artifactId, destination, { signal } = {}) {
    await mkdir(dirname(destination), { recursive: true });
    const tmp = `${destination}.part.md`;
    await rm(tmp, { force: true });
    try {
      await this.cli(['download', 'report', remoteId(bookId), '--id', remoteId(artifactId), '--output', tmp, '-p', this.profile], { parse: false, timeout: 120000, signal });
      if ((await stat(tmp)).size === 0) throw new ProviderError('TEMPORARY', 'El informe descargado está vacío.');
      await rename(tmp, destination);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
  async downloadSlideDeck(bookId, artifactId, destination, { format = 'pdf', signal } = {}) {
    await mkdir(dirname(destination), { recursive: true });
    const ext = format === 'pptx' ? 'pptx' : 'pdf';
    const tmp = `${destination}.part.${ext}`;
    await rm(tmp, { force: true });
    try {
      await this.cli(['download', 'slide-deck', remoteId(bookId), '--id', remoteId(artifactId), '--output', tmp, '--format', ext, '--no-progress', '-p', this.profile], { parse: false, timeout: 180000, signal });
      if ((await stat(tmp)).size === 0) throw new ProviderError('TEMPORARY', 'Las diapositivas descargadas están vacías.');
      await rename(tmp, destination);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
  async downloadInfographic(bookId, artifactId, destination, { signal } = {}) {
    await mkdir(dirname(destination), { recursive: true });
    const tmp = `${destination}.part.png`;
    await rm(tmp, { force: true });
    try {
      await this.cli(['download', 'infographic', remoteId(bookId), '--id', remoteId(artifactId), '--output', tmp, '--no-progress', '-p', this.profile], { parse: false, timeout: 180000, signal });
      await this.validateImage(tmp, { signal });
      await rename(tmp, destination);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
  async downloadMindMap(bookId, artifactId, destination, { signal } = {}) {
    await mkdir(dirname(destination), { recursive: true });
    const tmp = `${destination}.part.json`;
    await rm(tmp, { force: true });
    try {
      await this.cli(['download', 'mind-map', remoteId(bookId), '--id', remoteId(artifactId), '--output', tmp, '-p', this.profile], { parse: false, timeout: 120000, signal });
      if ((await stat(tmp)).size === 0) throw new ProviderError('TEMPORARY', 'El mapa mental descargado está vacío.');
      await rename(tmp, destination);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
  async downloadQuiz(bookId, artifactId, destination, { format = 'json', signal } = {}) {
    await mkdir(dirname(destination), { recursive: true });
    const ext = format === 'markdown' ? 'md' : 'json';
    const tmp = `${destination}.part.${ext}`;
    await rm(tmp, { force: true });
    try {
      await this.cli(['download', 'quiz', remoteId(bookId), '--id', remoteId(artifactId), '--output', tmp, '--format', format, '-p', this.profile], { parse: false, timeout: 120000, signal });
      if ((await stat(tmp)).size === 0) throw new ProviderError('TEMPORARY', 'El cuestionario descargado está vacío.');
      await rename(tmp, destination);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
  async downloadFlashcards(bookId, artifactId, destination, { format = 'json', signal } = {}) {
    await mkdir(dirname(destination), { recursive: true });
    const ext = format === 'markdown' ? 'md' : 'json';
    const tmp = `${destination}.part.${ext}`;
    await rm(tmp, { force: true });
    try {
      await this.cli(['download', 'flashcards', remoteId(bookId), '--id', remoteId(artifactId), '--output', tmp, '--format', format, '-p', this.profile], { parse: false, timeout: 120000, signal });
      if ((await stat(tmp)).size === 0) throw new ProviderError('TEMPORARY', 'Las tarjetas descargadas están vacías.');
      await rename(tmp, destination);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
  async downloadDataTable(bookId, artifactId, destination, { signal } = {}) {
    await mkdir(dirname(destination), { recursive: true });
    const tmp = `${destination}.part.csv`;
    await rm(tmp, { force: true });
    try {
      await this.cli(['download', 'data-table', remoteId(bookId), '--id', remoteId(artifactId), '--output', tmp, '-p', this.profile], { parse: false, timeout: 120000, signal });
      if ((await stat(tmp)).size === 0) throw new ProviderError('TEMPORARY', 'La tabla descargada está vacía.');
      await rename(tmp, destination);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
  close() { return this.runner.close(); }
}
