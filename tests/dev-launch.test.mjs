import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CommandRunner } from '../provider.mjs';
import { Store } from '../store.mjs';
import { createServer } from 'node:http';

const root=resolve(import.meta.dirname,'..');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn) {
  for(let i=0;i<120;i++){const value=await fn();if(value)return value;await delay(100);}
  throw new Error('El proceso no estuvo listo dentro de 12 segundos.');
}
async function launch(t,binary,args,cwd) {
  const dir=await mkdtemp(join(tmpdir(),'bloque audio prueba-'));
  const runner=new CommandRunner();let output='',failed;
  const env={PORT:'0',BLOQUEAUDIO_NO_BROWSER:'1',BLOQUEAUDIO_DATA_DIR:join(dir,'data'),BLOQUEAUDIO_EXPORTS_DIR:join(dir,'exports'),NLM_BINARY:join(dir,'no-nlm-installed.exe'),
    ...(binary.endsWith('BloqueAudio.exe') ? {PATH:join(process.env.SystemRoot,'System32')} : {})};
  // Test the real launch chain while preventing cloud access and browser windows.
  const processTask=runner.run(binary,args,{timeout:30000,env,cwd}).then(s=>{output=s;},e=>{failed=e;});
  t.after(async()=>{await runner.close();await processTask;await rm(dir,{recursive:true,force:true});});
  const processes=runner.children;
  const stdout=[];for(const p of processes)p.stdout.on('data',s=>stdout.push(s));
  const pid=await until(async()=>{try{return Number(await readFile(join(dir,'data','.running'),'utf8'));}catch{return 0;}});
  // The fork sends ready before the first health query. Capture an ephemeral URL from output.
  const origin=await until(()=>stdout.join('').match(/Listo: (http:\/\/127\.0\.0\.1:\d+)/)?.[1]).catch(e=>{throw new Error(`${e.message}\n${stdout.join('')}\n${output}\n${failed?.message || ''}`);});
  return {dir,origin,pid,runner,stdout,processTask,error:()=>failed,output:()=>output};
}

test('desarrollo reinicia de forma segura, sirve marca y cierra el proceso completo',async t=>{
  const copy=await mkdtemp(join(tmpdir(),'bloque audio codigo-'));
  t.after(()=>rm(copy,{recursive:true,force:true}));
  for(const file of ['package.json','runtime.mjs','server.mjs','store.mjs','provider.mjs','queue.mjs','accounts.mjs','sync.mjs','public']) await cp(join(root,file),join(copy,file),{recursive:true});
  await cp(join(root,'scripts'),join(copy,'scripts'),{recursive:true});
  const f=await launch(t,process.execPath,[join(copy,'scripts','launch.mjs'),'--dev'],copy);
  let health=await fetch(f.origin+'/api/health').then(r=>r.json());assert.equal(health.mode,'development');assert.equal(health.app,'BloqueAudio');
  assert.match(await fetch(f.origin+'/').then(r=>r.text()),/BloqueAudio/);
  assert.equal((await fetch(f.origin+'/favicon.ico')).status,200);
  const serverFile=join(copy,'server.mjs');await writeFile(serverFile,(await readFile(serverFile,'utf8'))+'\n// dev restart check\n');
  const second=await until(()=>f.stdout.join('').match(/Listo: (http:\/\/127\.0\.0\.1:\d+)/g)?.[1]?.replace('Listo: ',''));
  const newPid=Number(await readFile(join(f.dir,'data','.running'),'utf8'));assert.notEqual(newPid,f.pid);
  await assert.rejects(fetch(f.origin+'/api/health'));
  health=await fetch(second+'/api/health').then(r=>r.json());
  await fetch(second+'/api/shutdown',{method:'POST',headers:{'X-Local-Token':health.token}});
  await f.processTask;assert.equal(f.error(),undefined);await assert.rejects(access(join(f.dir,'data','.running')));
});

