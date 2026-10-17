import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = dirname(fileURLToPath(import.meta.url));
export const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
export const mode = process.env.BLOQUEAUDIO_MODE === 'development' ? 'development' : 'distribution';
export const dataDir = resolve(process.env.BLOQUEAUDIO_DATA_DIR || join(root, 'data'));
export const exportsDir = resolve(process.env.BLOQUEAUDIO_EXPORTS_DIR || join(root, 'exports'));
