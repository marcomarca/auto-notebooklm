import electron from 'electron';
import electronUpdater from 'electron-updater';

const app = electron?.app || electron;

function getAutoUpdater() {
  return electronUpdater?.autoUpdater;
}

export class AppUpdater {
  constructor({ logger, onStateChange, closeBackend }) {
    this.logger = logger;
    this.onStateChange = onStateChange;
    this.closeBackend = closeBackend;
    this.state = {
      status: 'idle', // 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'
      version: null,
      percent: 0,
      error: null,
    };
    this.intervalId = null;
  }

  getState() {
    return this.state;
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.onStateChange?.(this.state);
  }

  init() {
    if (!app?.isPackaged) {
      this.logger?.info('AppUpdater omitido en modo desarrollo.');
      return;
    }

    const autoUpdater = getAutoUpdater();
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;

    autoUpdater.on('checking-for-update', () => {
      this.logger?.info('Comprobando actualizaciones de la aplicación...');
      this.setState({ status: 'checking', error: null });
    });

    autoUpdater.on('update-available', (info) => {
      this.logger?.info('Actualización disponible:', info.version);
      this.setState({ status: 'available', version: info.version, error: null });
    });

    autoUpdater.on('update-not-available', (info) => {
      this.logger?.info('Aplicación actualizada:', info?.version || app.getVersion());
      this.setState({ status: 'not-available', error: null });
    });

    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.round(progress.percent || 0);
      this.logger?.info(`Progreso de descarga de actualización: ${percent}%`);
      this.setState({ status: 'downloading', percent });
    });

    autoUpdater.on('update-downloaded', (info) => {
      this.logger?.info('Actualización descargada y lista para instalar:', info.version);
      this.setState({ status: 'downloaded', version: info.version, percent: 100 });
    });

    autoUpdater.on('error', (err) => {
      this.logger?.error('Error en autoUpdater:', err.message);
      this.setState({ status: 'error', error: err.message });
    });

    // Comprobar 10 segundos después del inicio
    setTimeout(() => {
      this.checkForUpdates();
    }, 10000);

    // Comprobar cada 60 minutos
    this.intervalId = setInterval(() => {
      this.checkForUpdates();
    }, 60 * 60 * 1000);
  }

  async checkForUpdates() {
    if (!app?.isPackaged) return { status: 'dev-mode' };
    try {
      const autoUpdater = getAutoUpdater();
      return await autoUpdater.checkForUpdates();
    } catch (err) {
      this.logger?.error('Error comprobando actualizaciones:', err.message);
      this.setState({ status: 'error', error: err.message });
      return null;
    }
  }

  async installUpdate() {
    if (this.state.status !== 'downloaded') {
      throw new Error('No hay ninguna actualización descargada para instalar.');
    }
    this.logger?.info('Iniciando instalación de actualización: cerrando backend...');
    if (this.closeBackend) {
      await this.closeBackend();
    }
    const autoUpdater = getAutoUpdater();
    autoUpdater.quitAndInstall(true, true);
  }


  destroy() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
