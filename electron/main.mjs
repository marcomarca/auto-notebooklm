import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

import { getPaths, ensurePaths } from './paths.mjs';
import { Logger } from './logger.mjs';
import { ComponentManager } from './component-manager.mjs';
import { AppUpdater } from './updater.mjs';
import { promptLegacyMigration } from './legacy-importer.mjs';
import { makeApp } from '../server.mjs';
import { Provider } from '../provider.mjs';


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = dirname(__dirname);
const smokeDir = process.env.BLOQUEAUDIO_SMOKE_DIR;
// Keep the existing library when changing the visible product name.
app.setPath('userData', smokeDir || join(app.getPath('appData'), 'AutoNotebookLM'));
app.setAppUserModelId('com.autonotebooklm.desktop');

// 1. Single Instance Lock
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let backend = null;
let logger = null;
let updater = null;
let isClosing = false;

// Cierre centralizado y ordenado del backend
async function closeBackend() {
  if (isClosing) return;
  isClosing = true;

  if (updater) {
    updater.destroy();
    updater = null;
  }

  if (backend) {
    try {
      logger?.info('Cerrando backend y deteniendo Queue/procesos...');
      await backend.close();
      logger?.info('Backend cerrado correctamente.');
    } catch (err) {
      logger?.error('Error al cerrar el backend:', err.message);
    }
    backend = null;
  }

  if (logger) {
    await logger.close();
    logger = null;
  }
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('before-quit', async (event) => {
  if (!isClosing) {
    event.preventDefault();
    await closeBackend();
    app.exit(0);
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

// IPC handlers for window.desktop
ipcMain.handle('desktop:get-version', () => app.getVersion());
ipcMain.handle('desktop:get-update-state', () => updater?.getState() || { status: 'idle' });
ipcMain.handle('desktop:check-for-updates', () => updater?.checkForUpdates());
ipcMain.handle('desktop:install-update', () => updater?.installUpdate());

app.whenReady().then(async () => {
  // 3. Resolver y asegurar directorios persistentes
  const selectedPaths = getPaths(app);
  if (smokeDir) { selectedPaths.exportsDir = join(smokeDir, 'exports'); selectedPaths.runtimeDir = join(smokeDir, 'runtime'); }
  const paths = ensurePaths(selectedPaths);
  logger = new Logger(paths.logsDir);

  // Comprobar e importar datos legacy si es la primera ejecución
  if (!smokeDir) promptLegacyMigration(paths, logger);

  logger.info('Iniciando BloqueAudio Desktop', {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  });

  // 4. Resolver runtime
  const componentManager = new ComponentManager(paths.runtimeDir, logger);
  const runtime = await componentManager.resolveRuntime();

  logger.info('Runtime resuelto:', {
    python: runtime.python,
    nlmBinary: runtime.nlmBinary,
    nlmPrefixArgs: runtime.nlmPrefixArgs,
    ffmpeg: runtime.ffmpeg,
    connectorVersion: runtime.connectorVersion,
    upstreamNlmVersion: runtime.upstreamNlmVersion,
  });

  // 5. Construir Provider con runtime resuelto
  const provider = new Provider({
    profile: process.env.NLM_PROFILE || 'default',
    nlm: runtime.nlmBinary,
    nlmBinary: runtime.nlmBinary,
    nlmPrefixArgs: runtime.nlmPrefixArgs,
    python: runtime.python,
    bridgeScript: runtime.bridgeScript,
    ffmpeg: runtime.ffmpeg,
  });

  // 6. Iniciar makeApp() con reintento en puerto 0 si 4318 está ocupado
  try {
    backend = await makeApp({
      dataDir: paths.dataDir,
      exportsDir: paths.exportsDir,
      provider,
      port: 4318,
      worker: !smokeDir,
      check: !smokeDir,
      allowHttpShutdown: false,
    });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      logger.warn('Puerto 4318 ocupado, asignando puerto dinámico (puerto 0)...');
      backend = await makeApp({
        dataDir: paths.dataDir,
        exportsDir: paths.exportsDir,
        provider,
        port: 0,
        worker: !smokeDir,
        check: !smokeDir,
        allowHttpShutdown: false,
      });
    } else {
      logger.error('Fallo fatal al iniciar backend:', err.message);
      throw err;
    }
  }

  logger.info(`Backend HTTP listo en ${backend.origin}`);

  // 7. Crear BrowserWindow
  const preloadPath = join(__dirname, 'preload.cjs');
  const iconPath = join(rootDir, 'build', 'icon.ico');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: `BloqueAudio ${app.getVersion()}`,
    show: !smokeDir,
    icon: existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Bloquear navegación externa fuera de backend.origin
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      const originParsed = new URL(backend.origin);
      if (parsed.origin !== originParsed.origin) {
        event.preventDefault();
        shell.openExternal(url).catch(() => {});
      }
    } catch {
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      shell.openExternal(url).catch(() => {});
    } catch {}
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 8. Cargar backend.origin
  await mainWindow.loadURL(backend.origin);
  if (smokeDir) {
    mkdirSync(smokeDir, { recursive: true });
    const body = await mainWindow.webContents.executeJavaScript('document.body.innerText');
    writeFileSync(join(smokeDir, 'smoke.json'), JSON.stringify({ version: app.getVersion(), node: process.versions.node, title: mainWindow.getTitle(), branded: body.includes('BloqueAudio'), runtime: runtime.connectorVersion }));
    app.quit(); return;
  }

  // 9. Iniciar updater
  updater = new AppUpdater({
    logger,
    closeBackend,
    onStateChange: (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('desktop:update-state', state);
      }
    },
  });
  updater.init();
}).catch(async (fatalErr) => {
  if (!smokeDir) dialog.showErrorBox('BloqueAudio no pudo iniciarse', fatalErr.message);
  if (logger) {
    logger.error('Error fatal al inicializar aplicación:', fatalErr.message);
  } else {
    console.error('Fatal initialization error:', fatalErr);
  }
  await closeBackend();
  app.exit(1);
});
