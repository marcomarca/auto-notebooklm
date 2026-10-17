const { app, shell } = require('electron');
const { join, dirname } = require('node:path');
const { existsSync } = require('node:fs');
const root = dirname(__dirname);
app.whenReady().then(() => {
  const folder = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  for (const [name, target, id] of [
    ['BloqueAudio', join(root, 'BloqueAudioDev.exe'), 'com.bloqueaudio.development'],
    ['BloqueAudio (distribucion)', process.env.BLOQUEAUDIO_INSTALLED_EXE || join(root, 'dist', 'win-unpacked', 'BloqueAudio.exe'), 'com.autonotebooklm.desktop']
  ]) {
    for (const location of [folder, ...(existsSync(join(folder, 'BloqueAudio')) ? [join(folder, 'BloqueAudio')] : [])]) {
      if (!shell.writeShortcutLink(join(location, `${name}.lnk`), 'replace', { target, cwd: root, icon: join(root, 'public', 'icon.ico'), iconIndex: 0, appUserModelId: id, description: `${name} 1.1.1` })) throw new Error(`No se pudo registrar ${name}`);
    }
  }
  app.exit(0);
}).catch(e=>{console.error(e.message);app.exit(1);});
