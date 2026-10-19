import { execFile } from 'node:child_process';

export class SystemShutdown {
  constructor({ exec = execFile, platform = process.platform, mock = false, onTrigger, onCancel } = {}) {
    this.exec = exec;
    this.platform = platform;
    this.mock = mock || Boolean(process.env.BLOQUEAUDIO_MOCK_SHUTDOWN);
    this.active = false;
    this.triggeredAt = null;
    this.timeoutSeconds = 60;
    this.onTrigger = onTrigger;
    this.onCancel = onCancel;
    this.commandLog = [];
  }

  status() {
    if (!this.active || !this.triggeredAt) {
      return { active: false, secondsLeft: 0, message: '' };
    }
    const elapsed = Math.floor((Date.now() - this.triggeredAt) / 1000);
    const secondsLeft = Math.max(0, this.timeoutSeconds - elapsed);
    return {
      active: true,
      secondsLeft,
      message: `Todas las solicitudes fueron enviadas a Google NotebookLM. Apagando el equipo en ${secondsLeft} s...`
    };
  }

  trigger(seconds = 60, message = 'BloqueAudio: Todas las solicitudes fueron enviadas a Google. Apagando equipo...') {
    if (this.active) return this.status();
    this.active = true;
    this.triggeredAt = Date.now();
    this.timeoutSeconds = seconds;
    const currentStatus = this.status();

    this.commandLog.push({ action: 'shutdown', seconds, message, time: this.triggeredAt });

    if (this.platform === 'win32' && !this.mock) {
      this.exec('shutdown.exe', ['/s', '/t', String(seconds), '/c', message], (err) => {
        if (err) console.error('Error al invocar shutdown.exe:', err.message);
      });
    }

    if (this.onTrigger) {
      try { this.onTrigger(currentStatus); } catch {}
    }
    return currentStatus;
  }

  cancel() {
    if (!this.active) return { ok: true, active: false };
    this.active = false;
    this.triggeredAt = null;

    this.commandLog.push({ action: 'cancel', time: Date.now() });

    if (this.platform === 'win32' && !this.mock) {
      this.exec('shutdown.exe', ['/a'], () => {
        // Ignorar código de error si no había apagado en curso
      });
    }

    if (this.onCancel) {
      try { this.onCancel(); } catch {}
    }
    return { ok: true, active: false };
  }
}
