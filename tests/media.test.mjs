import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandRunner, Provider } from '../provider.mjs';

test('FFmpeg convierte M4A a MP3 real, conserva el original y valida el audio',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'nlm-media-'));
  const runner=new CommandRunner();const provider=new Provider({runner});
  t.after(async()=>{await provider.close();await rm(dir,{recursive:true,force:true});});
  try {await runner.run(provider.ffmpeg,['-version']);}
  catch(e){if(e.code==='UNAVAILABLE'){t.skip('FFmpeg no está disponible en este equipo.');return;}throw e;}
  const original=join(dir,'original.m4a'),output=join(dir,'001 - Prueba.mp3');
  await runner.run(provider.ffmpeg,['-nostdin','-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=2','-c:a','aac',original]);
  await provider.convert(original,output);
  assert.ok((await stat(original)).size>128);assert.ok((await stat(output)).size>128);
  const outputInfo=await runner.run(provider.ffmpeg,['-hide_banner','-i',output,'-map','0:a:0','-f','null','-']);
  assert.equal(typeof outputInfo,'string');
  await assert.rejects(stat(output+'.part.mp3'),/ENOENT/);
});
test('el cierre mata procesos propios y rechaza nuevas ejecuciones',async()=>{
  const runner=new CommandRunner();
  const operation=runner.run(process.execPath,['-e','setInterval(()=>{},1000)']).catch(e=>e);
  await runner.close();const result=await operation;
  assert.ok(result instanceof Error);assert.equal(runner.children.size,0);
  await assert.rejects(runner.run(process.execPath,['--version']),/cerrando/);
});
test('la salida UTF-8 conserva caracteres divididos entre chunks',async t=>{
  const runner=new CommandRunner();t.after(()=>runner.close());
  const result=await runner.run(process.execPath,['-e',"const b=Buffer.from('Español');process.stdout.write(b.subarray(0,5));setTimeout(()=>process.stdout.write(b.subarray(5)),30);"]);
  assert.equal(result,'Español');
});
test('Windows: el cierre también termina procesos descendientes del lanzador', {skip:process.platform!=='win32'},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'nlm-tree-')),pidFile=join(dir,'pid.txt');
  const runner=new CommandRunner();let grandchild;
  t.after(async()=>{await runner.close();if(grandchild){try{process.kill(grandchild);}catch{}}await rm(dir,{recursive:true,force:true});});
  const operation=runner.run(process.execPath,['-e',"const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000);",pidFile]).catch(e=>e);
  for(let i=0;i<100;i++){
    try{grandchild=Number(await readFile(pidFile,'utf8'));if(grandchild)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.ok(grandchild>0);await runner.close();await operation;
  let alive=true;
  for(let i=0;i<100;i++){
    try{process.kill(grandchild,0);}catch(e){if(e.code==='ESRCH'){alive=false;break;}throw e;}
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.equal(alive,false,'El proceso descendiente debe terminar al cerrar la aplicación.');
});
