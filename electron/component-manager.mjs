import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import electron from 'electron';

const app = electron?.app || electron;

export class ComponentManager {
  constructor(runtimeDir, logger) {
    this.runtimeDir = runtimeDir;
    this.logger = logger;
    this.connectorDir = join(runtimeDir, 'connector');
    this.stateFile = join(this.connectorDir, 'state.json');
  }

  getState() {
    if (!existsSync(this.stateFile)) {
      return { active: null, previous: null, pending: null };
    }
    try {
      return JSON.parse(readFileSync(this.stateFile, 'utf8'));
    } catch {
      return { active: null, previous: null, pending: null };
    }
  }

  saveState(state) {
    mkdirSync(this.connectorDir, { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify(state, null, 2), 'utf8');
  }

  initBootstrap(resourcesPath) {
    if (existsSync(this.stateFile)) return;

    const bootstrapDir = join(resourcesPath, 'runtime-bootstrap');
    const bootstrapMeta = join(bootstrapDir, 'runtime.json');
    if (!existsSync(bootstrapMeta)) return;

    try {
      this.logger?.info('Inicializando runtime connector desde bootstrap en primera ejecución...');
      const targetDir = join(this.connectorDir, '1');
      mkdirSync(targetDir, { recursive: true });
      cpSync(bootstrapDir, targetDir, { recursive: true });

      const state = { active: '1', previous: null, pending: null };
      this.saveState(state);
      this.logger?.info('Runtime connector bootstrap completado. Versión activa: 1');
    } catch (err) {
      this.logger?.error('Error inicializando bootstrap:', err.message);
    }
  }

  verifyRuntimeDir(versionDir) {
    const metaFile = join(versionDir, 'runtime.json');
    if (!existsSync(metaFile)) return { ok: false, error: 'Falta runtime.json' };

    let meta;
    try {
      meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    } catch (e) {
      return { ok: false, error: `runtime.json inválido: ${e.message}` };
    }

    const pythonPath = join(versionDir, meta.python);
    const nlmEntryPath = join(versionDir, meta.nlmEntry || 'nlm_entry.py');
    const bridgeScriptPath = join(versionDir, meta.bridge || 'nlm_bridge.py');

    if (!existsSync(pythonPath)) return { ok: false, error: 'python.exe no existe' };
    if (!existsSync(nlmEntryPath)) return { ok: false, error: 'nlm_entry.py no existe' };
    if (!existsSync(bridgeScriptPath)) return { ok: false, error: 'nlm_bridge.py no existe' };

    // Smoke test: python nlm_entry.py --version
    const verRes = spawnSync(pythonPath, [nlmEntryPath, '--version'], { encoding: 'utf8', timeout: 15000 });
    if (verRes.status !== 0) {
      return { ok: false, error: `Smoke test nlm_entry falló: ${verRes.stderr || verRes.stdout}` };
    }

    // Smoke test: python nlm_bridge.py --help
    const helpRes = spawnSync(pythonPath, [bridgeScriptPath, '--help'], { encoding: 'utf8', timeout: 15000 });
    if (helpRes.status !== 0) {
      return { ok: false, error: `Smoke test nlm_bridge falló: ${helpRes.stderr || helpRes.stdout}` };
    }

    return { ok: true, meta, pythonPath, nlmEntryPath, bridgeScriptPath };
  }

  cleanOldVersions(active, previous) {
    try {
      if (!existsSync(this.connectorDir)) return;
      const keep = new Set([String(active), String(previous), 'state.json'].filter(Boolean));
      const entries = readdirSync(this.connectorDir);
      for (const entry of entries) {
        if (!keep.has(entry)) {
          const p = join(this.connectorDir, entry);
          rmSync(p, { recursive: true, force: true });
          this.logger?.info(`Versión antigua del conector eliminada: ${entry}`);
        }
      }
    } catch (err) {
      this.logger?.warn('Error limpiando versiones antiguas del conector:', err.message);
    }
  }

  async resolveRuntime() {
    const isPackaged = app?.isPackaged ?? false;
    const resourcesPath = isPackaged ? process.resourcesPath : process.cwd();

    // Inicializar bootstrap si es necesario
    this.initBootstrap(resourcesPath);

    const state = this.getState();

    // 1. Manejar activación pendiente con validación y rollback
    if (state.pending) {
      const pendingVersion = String(state.pending);
      const pendingDir = join(this.connectorDir, pendingVersion);
      this.logger?.info(`Comprobando activación pendiente de conector v${pendingVersion}...`);

      const verifyPending = this.verifyRuntimeDir(pendingDir);
      if (verifyPending.ok) {
        this.logger?.info(`Conector v${pendingVersion} validado con éxito. Activando.`);
        state.previous = state.active;
        state.active = pendingVersion;
        state.pending = null;
        this.saveState(state);
      } else {
        this.logger?.error(`Conector v${pendingVersion} corrupto o fallido: ${verifyPending.error}. Descartando pendiente.`);
        rmSync(pendingDir, { recursive: true, force: true });
        state.pending = null;
        this.saveState(state);
      }
    }

    // 2. Ejecutar runtime activo
    if (state.active) {
      const activeVersion = String(state.active);
      const activeDir = join(this.connectorDir, activeVersion);
      let verified = this.verifyRuntimeDir(activeDir);

      if (!verified.ok && state.previous) {
        // Rollback automático al conector previo
        this.logger?.error(`Runtime activo v${activeVersion} falló (${verified.error}). Ejecutando rollback a v${state.previous}...`);
        const rollbackDir = join(this.connectorDir, String(state.previous));
        const verifiedPrevious = this.verifyRuntimeDir(rollbackDir);
        if (verifiedPrevious.ok) {
          state.active = state.previous;
          state.previous = activeVersion;
          this.saveState(state);
          verified = verifiedPrevious;
          this.logger?.info(`Rollback completado a v${state.active}.`);
        }
      }

      if (verified.ok) {
        this.cleanOldVersions(state.active, state.previous);
        return {
          python: verified.pythonPath,
          nlmBinary: verified.pythonPath,
          nlmPrefixArgs: [verified.nlmEntryPath],
          bridgeScript: verified.bridgeScriptPath,
          ffmpeg: this._resolveFfmpeg(resourcesPath),
          connectorVersion: verified.meta.connectorVersion || state.active,
          upstreamNlmVersion: verified.meta.upstreamNlmVersion || '0.12.0',
        };
      }
    }

    // 3. Fallback a desarrollo
    return {
      python: process.env.PYTHON_BINARY || (process.platform === 'win32' ? (process.env.APPDATA ? `${process.env.APPDATA}\\uv\\tools\\notebooklm-mcp-cli\\Scripts\\python.exe` : 'python') : 'python3'),
      nlmBinary: process.env.NLM_BINARY || 'nlm',
      nlmPrefixArgs: [],
      bridgeScript: process.env.NLM_BRIDGE_SCRIPT || join(process.cwd(), 'scripts', 'nlm_bridge.py'),
      ffmpeg: this._resolveFfmpeg(resourcesPath),
      connectorVersion: 'dev',
      upstreamNlmVersion: '0.12.0',
    };
  }

  stageConnectorUpdate({ version, sourceDir }) {
    const targetDir = join(this.connectorDir, String(version));
    mkdirSync(targetDir, { recursive: true });
    cpSync(sourceDir, targetDir, { recursive: true });

    const verification = this.verifyRuntimeDir(targetDir);
    if (!verification.ok) {
      rmSync(targetDir, { recursive: true, force: true });
      throw new Error(`Validación de nuevo runtime falló: ${verification.error}`);
    }

    const state = this.getState();
    state.pending = String(version);
    this.saveState(state);
    this.logger?.info(`Nuevo conector v${version} preparado en staged. Pendiente de reinicio.`);
    return true;
  }

  _resolveFfmpeg(resourcesPath) {
    if (process.env.FFMPEG_BINARY) return process.env.FFMPEG_BINARY;
    const bundledFfmpeg = join(resourcesPath, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (existsSync(bundledFfmpeg)) return bundledFfmpeg;
    const vendorFfmpeg = join(process.cwd(), 'vendor', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (existsSync(vendorFfmpeg)) return vendorFfmpeg;
    return 'ffmpeg';
  }
}
