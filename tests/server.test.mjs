import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../server.mjs';
import { FakeProvider } from './helpers.mjs';
import { get as httpGet } from 'node:http';

async function appFixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'nlm-http-'));
  const app=await makeApp({dataDir:dir,exportsDir:join(dir,'exports'),provider:new FakeProvider(),port:0,worker:false,check:false});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const call=(path,method='GET',data,extra={})=>fetch(app.origin+path,{method,headers:{'X-Local-Token':app.token,...(typeof data === 'object' && !Buffer.isBuffer(data)?{'Content-Type':'application/json'}:{}),...extra},body:data===undefined?undefined:typeof data==='object' && !Buffer.isBuffer(data)?JSON.stringify(data):data});
  const book=await call('/api/books','POST',{title:'Libro',requestId:'request-book'}).then(r=>r.json());
  return {app,call,book,dir};
}
test('API local rechaza origen externo y escrituras sin token',async t=>{
  const {app,call}=await appFixture(t);
  assert.equal((await call('/api/books','POST',{title:'Bad',requestId:'bad'},{Origin:'https://evil.example'})).status,403);
  assert.equal((await fetch(app.origin+'/api/books',{method:'POST',body:'{}'})).status,403);
  const badHost = await new Promise((resolve,reject)=>httpGet(app.origin+'/api/health',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject));
  assert.equal(badHost,403);
  assert.equal((await call('/api/health')).status,200);
});
test('lote de 25 archivos se ordena naturalmente, deduplica y permite editar',async t=>{
  const {app,call,book}=await appFixture(t);
  for(let n=25;n>=1;n--){const r=await call(`/api/books/${book.id}/files?filename=Parte%20${n}.md&requestId=file-${n}`,'PUT',`# Parte ${n}\nContenido ${n}`);assert.equal(r.status,201);}
  const rows=app.store.blocks(book.id);assert.equal(rows.length,25);assert.equal(rows[0].filename,'Parte 1.md');assert.equal(rows[24].filename,'Parte 25.md');
  const duplicate=await call(`/api/books/${book.id}/files?filename=otro.md&requestId=other`,'PUT','# Parte 1\nContenido 1').then(r=>r.json());assert.equal(duplicate.duplicate,true);
  assert.equal((await call(`/api/blocks/${rows[0].id}`,'PATCH',{title:'Introducción'})).status,200);
  app.store.update('blocks',rows[0].id,{locked:1});assert.equal((await call(`/api/blocks/${rows[0].id}`,'PATCH',{title:'Cambio'})).status,400);
});
test('rechaza vacío, rutas, extensión ajena, PDF falso y Markdown binario',async t=>{
  const {call,book}=await appFixture(t);
  for(const [name,contents] of [['empty.md',''],['../bad.md','text'],['bad.exe','text'],['fake.pdf','hello'],['binary.md',Buffer.from([0,1,2])],['spaces.md','   ']]) {
    const result=await call(`/api/books/${book.id}/files?filename=${encodeURIComponent(name)}&requestId=${crypto.randomUUID()}`,'PUT',contents);assert.equal(result.status,400,name);
  }
});
test('descarga MP3 acepta rangos para reproducción y no expone rutas arbitrarias',async t=>{
  const {app,call,book,dir}=await appFixture(t);
  await call(`/api/books/${book.id}/files?filename=Tema.md&requestId=source`,'PUT','# Tema');
  const block=app.store.blocks(book.id)[0];const file=join(dir,"O'Reilly.mp3");await writeFile(file,Buffer.alloc(1024,1));
  app.store.update('blocks',block.id,{state:'done',output_path:file});
  const result=await call(`/api/blocks/${block.id}/audio`,'GET',undefined,{Range:'bytes=10-19'});
  assert.equal(result.status,206);assert.equal((await result.arrayBuffer()).byteLength,10);
  assert.equal(result.headers.get('content-type'),'audio/mpeg');assert.equal(result.headers.get('content-range'),'bytes 10-19/1024');
  assert.match(result.headers.get('content-disposition'),/O%27Reilly\.mp3/);
  assert.equal((await call(`/api/blocks/${block.id}/audio`,'GET',undefined,{Range:'bytes=1024-'})).status,416);
  assert.equal((await call('/data/queue.sqlite')).status,404);
});
test('impide dos workers sobre los mismos datos y ofrece cierre limpio',async t=>{
  const {app,call,dir}=await appFixture(t);
  await assert.rejects(makeApp({dataDir:dir,provider:new FakeProvider(),port:0,worker:false,check:false}),/Ya hay una aplicación/);
  const result=await call('/api/shutdown','POST');assert.equal(result.status,200);
  await new Promise(resolve=>setTimeout(resolve,100));
  await assert.rejects(fetch(app.origin+'/api/health'));
});
test('cargas concurrentes del mismo archivo conservan un único bloque',async t=>{
  const {app,call,book}=await appFixture(t);
  const responses=await Promise.all([1,2,3].map(n=>call(`/api/books/${book.id}/files?filename=parte${n}.md&requestId=upload-${n}`,'PUT','# Mismo contenido')));
  assert.ok(responses.every(r=>r.status===201));
  const values=await Promise.all(responses.map(r=>r.json()));assert.equal(new Set(values.map(v=>v.id)).size,1);assert.equal(app.store.blocks(book.id).length,1);
});
