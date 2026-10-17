import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { CommandRunner } from '../provider.mjs';
import { version } from '../runtime.mjs';
const dir=await mkdtemp(join(tmpdir(),'bloqueaudio-desktop-'));
const runner=new CommandRunner();
try {
  await runner.run(resolve(process.argv[2] || 'dist/win-unpacked/BloqueAudio.exe'),[],{timeout:120000,env:{BLOQUEAUDIO_SMOKE_DIR:dir}});
  const report=JSON.parse(await readFile(join(dir,'smoke.json'),'utf8'));
  assert.equal(report.version,version);assert.equal(report.branded,true);assert.notEqual(report.runtime,'dev');
  console.log(JSON.stringify(report,null,2));
} finally { await runner.close();await rm(dir,{recursive:true,force:true}); }
