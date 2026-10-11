import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../provider.mjs';

export class Logger {
  constructor(logsDir) {
    this.filePath = join(logsDir, 'main.log');
    this.stream = createWriteStream(this.filePath, { flags: 'a', encoding: 'utf8' });
  }

  log(level, message, meta) {
    const timestamp = new Date().toISOString();
    let text = typeof message === 'string' ? redact(message) : redact(JSON.stringify(message));
    let metaStr = '';
    if (meta !== undefined) {
      try {
        metaStr = ' ' + redact(typeof meta === 'object' ? JSON.stringify(meta) : String(meta));
      } catch {}
    }
    const line = `[${timestamp}] [${level.toUpperCase()}] ${text}${metaStr}\n`;
    this.stream.write(line);
    if (process.env.NODE_ENV !== 'production') {
      process.stdout.write(line);
    }
  }

  info(message, meta) { this.log('info', message, meta); }
  warn(message, meta) { this.log('warn', message, meta); }
  error(message, meta) { this.log('error', message, meta); }

  close() {
    return new Promise(resolve => {
      this.stream.end(resolve);
    });
  }
}
