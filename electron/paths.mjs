import electron from 'electron';
const app = electron?.app || electron;

import path from 'node:path';
import os from 'node:os';
import { mkdirSync } from 'node:fs';

export function getPaths(appInstance = app) {
  const userData = appInstance ? appInstance.getPath('userData') : path.join(process.env.APPDATA || os.homedir(), 'AutoNotebookLM');
  const documents = appInstance ? appInstance.getPath('documents') : path.join(os.homedir(), 'Documents');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

  const paths = {
    userData,
    dataDir: path.join(userData, 'data'),
    exportsDir: path.join(documents, 'AutoNotebookLM', 'exports'),
    logsDir: path.join(userData, 'logs'),
    runtimeDir: path.join(localAppData, 'AutoNotebookLM', 'runtime'),
  };

  return paths;
}

export function ensurePaths(paths) {
  for (const key of ['dataDir', 'exportsDir', 'logsDir', 'runtimeDir']) {
    if (paths[key]) {
      mkdirSync(paths[key], { recursive: true });
    }
  }
  return paths;
}

export default getPaths;
