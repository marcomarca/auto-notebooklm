import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, safeName, title } from '../store.mjs';
import { Queue, quotaRetry } from '../queue.mjs';
import { Provider, ProviderError } from '../provider.mjs';
import { fixture, temporary } from './helpers.mjs';
import { join } from 'node:path';

test('25 bloques: una fuente por audio, descargas por ID y nombres ordenados',async t=>{
  const f=await fixture(t); for(let i=1;i<=25;i++)f.add(i);
  f.store.update('books',f.book.id,{running:1});
  await f.tick(210);
  const blocks=f.store.blocks(f.book.id);
  assert.equal(blocks.filter(b=>b.state==='done').length,25);
  assert.deepEqual(f.provider.calls.filter(c=>c[0]==='generate').map(c=>c[2]),blocks.map(b=>b.source_id));
  assert.deepEqual(f.provider.calls.filter(c=>c[0]==='download').map(c=>c[2]),blocks.map(b=>b.artifact_id));
  assert.match(blocks[0].output_path,/001 - Parte 1\.mp3$/);
  assert.match(blocks[24].output_path,/025 - Parte 25\.mp3$/);
  assert.equal(f.store.book(f.book.id).running,0);
});
test('cuota: no genera, conserva pendientes y retoma después del reinicio',async t=>{
  const f=await fixture(t);f.add(1);f.add(2);await f.tick(5);
  f.store.update('books',f.book.id,{running:1});
  const reset=f.now()+3600000;
  f.provider.usageData={windows:[{percent_remaining:0,resets_at:new Date(reset).toISOString()}]};
  await f.tick();assert.equal(f.provider.generations,0);
  assert.equal(f.store.book(f.book.id).quota_at,reset+60000);
  assert.equal(f.store.blocks(f.book.id)[0].state,'quota');
  f.advance(3600000); f.provider.usageData.windows[0].percent_remaining=100;
  await f.tick(20);assert.equal(f.provider.generations,2);assert.ok(f.store.blocks(f.book.id).every(b=>b.state==='done'));
});
test('cuota desconocida usa 30 minutos y el último reinicio de ventanas agotadas',()=>{
  const now=1000000;
  assert.equal(quotaRetry({windows:[{percent_remaining:null}]},now),0);
  assert.equal(quotaRetry({windows:[{percent_remaining:0,resets_at:null}]},now),now+1800000);
  assert.equal(quotaRetry({windows:[{percent_remaining:0,resets_at:new Date(now+1000).toISOString()},{percent_remaining:0,resets_at:new Date(now+4000).toISOString()}]},now),now+64000);
});
test('respuestas inciertas se reconcilian sin repetir libro, fuente o audio',async t=>{
  const f=await fixture(t);f.add();f.store.update('books',f.book.id,{running:1});
  f.provider.behavior={createBook:temporary(),upload:temporary(),generate:temporary()};
  await f.tick(20);
  assert.equal(f.provider.calls.filter(c=>c[0]==='createBook').length,1);
  assert.equal(f.provider.calls.filter(c=>c[0]==='upload').length,1);
  assert.equal(f.provider.generations,1);
  assert.equal(f.store.blocks(f.book.id)[0].state,'done');
});
test('audio incierto sin procedencia entra en revisión y no se duplica',async t=>{
  const f=await fixture(t);f.add();await f.tick(3);f.store.update('books',f.book.id,{running:1});
  f.provider.behavior.generate=temporary();await f.tick();f.provider.remoteArtifacts[0].source_ids=[];
  await f.tick(5);const block=f.store.blocks(f.book.id)[0];
  assert.equal(block.state,'review');assert.equal(f.provider.generations,1);
  f.queue.retryBlock(block.id);await f.tick();assert.equal(f.provider.generations,1);
});
test('reinicio recupera una solicitud de audio en curso y continúa descargando',async t=>{
  const f=await fixture(t);const block=f.add();await f.tick(3);f.store.update('books',f.book.id,{running:1});
  f.provider.behavior.generate=temporary();await f.tick();
  const secondStore=new Store(join(f.dir,'queue.sqlite'));
  const queue=new Queue(secondStore,f.provider,f.options);
  try {for(let i=0;i<6;i++){await queue.tick();f.advance(60001);}assert.equal(secondStore.block(block.id).state,'done');assert.equal(f.provider.generations,1);}
  finally{await queue.stop();secondStore.close();}
});
test('pausar no detiene el audio enviado, pero impide solicitar el siguiente',async t=>{
  const f=await fixture(t);f.add(1);f.add(2);await f.tick(5);f.store.update('books',f.book.id,{running:1});
  await f.tick();f.store.update('books',f.book.id,{running:0});await f.tick(10);
  assert.equal(f.provider.generations,1);assert.equal(f.store.blocks(f.book.id)[0].state,'done');
  assert.equal(f.store.blocks(f.book.id)[1].state,'ready');
});
test('conversión fallida se reintenta sin regenerar ni descargar otra vez',async t=>{
  const f=await fixture(t);f.add();f.store.update('books',f.book.id,{running:1});
  f.provider.behavior.convert=new ProviderError('TEMPORARY','ffmpeg temporarily failed');await f.tick(10);
  const block=f.store.blocks(f.book.id)[0];assert.equal(block.state,'error');assert.equal(block.stage,'convert');
  delete f.provider.behavior.convert;f.queue.retryBlock(block.id);await f.tick(3);
  assert.equal(f.store.block(block.id).state,'done');assert.equal(f.provider.generations,1);
  assert.equal(f.provider.calls.filter(c=>c[0]==='download').length,1);
});
test('descarga tiene tres reintentos automáticos y después requiere acción manual',async t=>{
  const f=await fixture(t);f.add();f.store.update('books',f.book.id,{running:1});f.provider.behavior.download=temporary();await f.tick(20);
  const block=f.store.blocks(f.book.id)[0];assert.equal(block.stage,'download');assert.equal(block.attempts,4);
  assert.equal(f.provider.calls.filter(c=>c[0]==='download').length,4);assert.equal(f.provider.generations,1);
});
test('sin sesión detiene solicitudes y conserva fuente para reanudar',async t=>{
  const f=await fixture(t);f.add();await f.tick(3);f.store.update('books',f.book.id,{running:1});
  f.provider.behavior.usage=new ProviderError('AUTH_REQUIRED','Run nlm login');await f.tick(5);
  const block=f.store.blocks(f.book.id)[0];assert.equal(block.state,'auth');assert.equal(f.provider.generations,0);
  delete f.provider.behavior.usage;f.provider.health.ready=true;f.provider.health.auth=true;f.queue.retryBlock(block.id);await f.tick(8);assert.equal(f.store.block(block.id).state,'done');
});
test('bloque solicitado conserva número y título; los nuevos se añaden al final',async t=>{
  const f=await fixture(t);const one=f.add(1),two=f.add(2);f.store.update('blocks',one.id,{locked:1});
  assert.throws(()=>f.store.reorder(f.book.id,[two.id,one.id]),/números/);
  const three=f.add(3);assert.equal(three.position,3);
});
test('crear libro repetido usa el mismo requestId y solo una fila',async t=>{
  const f=await fixture(t);const same=f.store.createBook({title:'Libro de prueba',requestId:'book-request'},'default');
  assert.equal(same.id,f.book.id);assert.equal(f.store.books().length,1);
  await Promise.all([f.queue.tick(),f.queue.tick(),f.queue.tick()]);assert.equal(f.provider.remoteBooks.length,1);
});
test('rechaza un audio cuya procedencia contiene otras fuentes',async t=>{
  const f=await fixture(t);f.add();f.store.update('books',f.book.id,{running:1});await f.tick(4);
  f.provider.remoteArtifacts[0].source_ids.push('another-source');await f.tick(3);
  assert.equal(f.store.blocks(f.book.id)[0].state,'review');assert.equal(f.provider.calls.filter(c=>c[0]==='download').length,0);
});
test('CLI exacta: aislamiento, español latinoamericano y duración estándar',async()=>{
  const calls=[];const runner={run:async(binary,args,options)=>{calls.push({binary,args,options});return JSON.stringify({artifact_id:'audio-1'});},close:async()=>{}};
  const p=new Provider({runner});await p.generate('book-1','source-1');
  assert.deepEqual(calls[0].args,['audio','create','book-1','--source-ids','source-1','--format','deep_dive','--length','default','--language','es-419','--confirm','--json','-p','default']);
  await assert.rejects(p.generate('book-1',null),/ID remoto/);await assert.rejects(p.generate('book-1','one,two'),/ID remoto/);assert.equal(calls.length,1);
});
test('nombres Windows: rutas, reservados y caracteres inválidos',()=>{
  assert.equal(safeName('Tema: A/B?'),'Tema_ A_B_');assert.equal(safeName('CON'),'_CON');assert.equal(safeName('final.  '),'final');assert.equal(safeName('NUL.mp3'),'_NUL.mp3');
  assert.ok(safeName('a'.repeat(79)+'🎧').isWellFormed());assert.throws(()=>title('\ud800'),/título/);
});
test('no crea ni carga fuentes antes de verificar herramientas y sesión',async t=>{
  const f=await fixture(t);f.add();f.provider.health.ready=false;
  await f.tick(4);assert.equal(f.provider.remoteBooks.length,0);assert.equal(f.provider.remoteSources.length,0);
  f.provider.health.ready=true;await f.tick(3);assert.equal(f.provider.remoteSources.length,1);
});
test('fallo de autenticación después de cargar conserva el diario para evitar duplicados',async t=>{
  const f=await fixture(t);f.add();await f.tick();
  f.provider.behavior.upload=new ProviderError('AUTH_REQUIRED','Session expired during source rename');await f.tick();
  const block=f.store.blocks(f.book.id)[0];assert.equal(block.state,'auth');assert.ok(block.baseline);
  f.provider.health.ready=true;f.queue.retryBlock(block.id);await f.tick(3);
  assert.equal(f.provider.calls.filter(c=>c[0]==='upload').length,1);assert.equal(f.store.block(block.id).state,'ready');
});
test('generaciones continuas: envía las solicitudes de audio una tras otra sin esperar a que el audio anterior termine', async t => {
  const f = await fixture(t);
  const one = f.add(1), two = f.add(2);
  f.store.update('books', f.book.id, { remote_id: 'remote-book', state: 'ready', running: 1 });
  f.store.update('blocks', one.id, { stage: 'generate', state: 'ready', source_id: 'src-1' });
  f.store.update('blocks', two.id, { stage: 'generate', state: 'ready', source_id: 'src-2' });

  // Tick 1: Dispatches generation for block 1
  await f.queue.tick();
  assert.equal(f.provider.generations, 1);
  assert.equal(f.store.block(one.id).state, 'generating');
  assert.equal(f.store.block(one.id).stage, 'poll');

  // Tick 2: Dispatches generation for block 2 immediately without waiting for block 1 to complete
  await f.queue.tick();
  assert.equal(f.provider.generations, 2);
  assert.equal(f.store.block(two.id).state, 'generating');
  assert.equal(f.store.block(two.id).stage, 'poll');

  // Both complete and download
  await f.tick(15);
  assert.equal(f.store.block(one.id).state, 'done');
  assert.equal(f.store.block(two.id).state, 'done');
});
test('modo diferido (Generar más tarde): Provider invoca bridge con --later y la cola pasa a deferred', async t => {
  const calls = [];
  const runner = {
    run: async (binary, args, options) => {
      calls.push({ binary, args, options });
      return JSON.stringify({ artifact_id: 'audio-defer-1', deferred: true });
    },
    close: async () => {}
  };
  const p = new Provider({ runner });
  const artId = await p.generate('book-1', 'source-1', { defer: true });
  assert.equal(artId, 'audio-defer-1');
  assert.ok(calls[0].args.includes('--later'));

  // Test en cola
  const f = await fixture(t);
  const block = f.add(1);
  f.store.update('books', f.book.id, { remote_id: 'remote-book', state: 'ready', running: 1, generation_mode: 'later' });
  f.store.update('blocks', block.id, { stage: 'generate', state: 'ready', source_id: 'src-1', generation_mode: 'later' });
  await f.queue.tick();
  assert.equal(f.store.block(block.id).state, 'deferred');
  assert.equal(f.store.block(block.id).stage, 'poll');
});
