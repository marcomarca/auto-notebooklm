import { existsSync, cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import electron from 'electron';

const { dialog } = electron || {};

export function importLegacyData(sourceRoot, targetPaths, logger) {
  const sourceDb = join(sourceRoot, 'data', 'queue.sqlite');
  if (!existsSync(sourceDb)) {
    throw new Error('No se encontró data/queue.sqlite en la carpeta seleccionada.');
  }

  logger?.info(`Importando instalación anterior desde ${sourceRoot}...`);
  mkdirSync(targetPaths.dataDir, { recursive: true });
  mkdirSync(targetPaths.exportsDir, { recursive: true });

  // Copiar carpeta data
  cpSync(join(sourceRoot, 'data'), targetPaths.dataDir, { recursive: true });

  // Copiar carpeta exports si existe
  const sourceExports = join(sourceRoot, 'exports');
  if (existsSync(sourceExports)) {
    cpSync(sourceExports, targetPaths.exportsDir, { recursive: true });
  }

  logger?.info('Importación completada con éxito.');
  return true;
}

export function promptLegacyMigration(targetPaths, logger, dialogHandler = dialog) {
  const dbFile = join(targetPaths.dataDir, 'queue.sqlite');
  if (existsSync(dbFile) || !dialogHandler?.showMessageBoxSync) return false;

  const choice = dialogHandler.showMessageBoxSync({
    type: 'question',
    buttons: ['Empezar vacío', 'Importar instalación anterior'],
    defaultId: 0,
    cancelId: 0,
    title: 'Configuración inicial de AutoNotebookLM',
    message: '¿Deseas importar los datos y audios de una instalación anterior de AutoNotebookLM o empezar con una biblioteca vacía?',
  });

  if (choice === 1) {
    const selected = dialogHandler.showOpenDialogSync({
      title: 'Selecciona la carpeta que contiene data y exports',
      properties: ['openDirectory'],
    });

    if (selected && selected[0]) {
      try {
        importLegacyData(selected[0], targetPaths, logger);
        dialogHandler.showMessageBoxSync({
          type: 'info',
          title: 'Importación completada',
          message: 'Se han importado correctamente tus libros, bloques y audios anteriores.',
        });
        return true;
      } catch (err) {
        logger?.error('Error durante la importación:', err.message);
        dialogHandler.showMessageBoxSync({
          type: 'error',
          title: 'Error de importación',
          message: err.message,
        });
      }
    }
  }
  return false;
}
