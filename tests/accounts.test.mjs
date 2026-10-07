import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { Accounts } from '../accounts.mjs';
import { Queue } from '../queue.mjs';
import { Provider, ProviderError, classify } from '../provider.mjs';
import { makeApp } from '../server.mjs';
import { FakeProvider } from './helpers.mjs';

class MultiProvider extends FakeProvider {
  constructor(profile, shared) {
    super(); this.profile = profile; this.health.profile = profile;
    this.remoteSources = shared.sources; this.remoteArtifacts = shared.artifacts;
    this.role = 'editor'; this.closed = false;
  }
  async profiles() { return ['default','cuenta2','cuenta3'].map(id => ({ id, email: `${id}@example.com` })); }
  async check() { this.health.usage = this.usageData; return this.health; }
  async access(book, email) {
    this.calls.push(['access', book, email]);
    if (this.role !== 'editor') throw new ProviderError('ACCESS', 'Necesita editor');
    return true;
  }
  async generate(book, source) {
    this.calls.push(['generate',book,source]);
    if (this.rejectQuota) throw new ProviderError('QUOTA','Quota exhausted');
    const id = `audio-${this.profile}-${++this.generations}`;
    this.remoteArtifacts.push({artifact_id:id,type:'audio',source_ids:[source],status:'completed'});
    if (this.behavior.generate) throw this.behavior.generate;
    return id;
  }
  async close() { this.closed = true; }
}
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-accounts-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const shared = { sources: [{id:'source-1',status:2}], artifacts: [] };
  const providers = new Map(['default','cuenta2','cuenta3'].map(id => [id,new MultiProvider(id,shared)]));
  let now = Date.now();
  const accounts = new Accounts(store, providers.get('default'), {factory:id=>providers.get(id),now:()=>now});
  await accounts.discover(); accounts.enable('cuenta2',true); accounts.enable('cuenta3',true);
  const options = {dataDir:dir,exportsDir:join(dir,'exports'),accounts,now:()=>now};
  const queue = new Queue(store, providers.get('default'), options);
  t.after(async()=>{await queue.stop(); store.close(); await rm(dir,{recursive:true,force:true});});
  const book = store.createBook({title:'Compartido',requestId:'book'},'default');
  store.update('books',book.id,{remote_id:'remote-book',state:'ready',running:1});
  const block = store.addBlock(book.id,{requestId:'one',title:'Uno',filename:'Uno.md',filePath:join(dir,'one.md'),hash:'one'});
  store.update('blocks',block.id,{stage:'generate',state:'ready',source_id:'source-1'});
  await accounts.configure(store.book(book.id), ['cuenta2','cuenta3']);
  const tick = async (n=1)=>{for(let i=0;i<n;i++){await queue.tick();now+=60001;}};
  return {dir,store,shared,providers,accounts,options,queue,book,block,tick,advance:n=>now+=n,now:()=>now};
}
const emptyQuota = now => ({windows:[{percent_remaining:0,resets_at:new Date(now+3600000).toISOString()}]});

test('rota por cuota sin cambiar cuaderno ni fuente; descarga por la cuenta y el ID originales', async t=>{
  const f=await setup(t); f.providers.get('default').usageData=emptyQuota(f.now());
  await f.tick(5);
  const b=f.store.block(f.block.id); assert.equal(b.state,'done'); assert.equal(b.generation_profile,'cuenta2');
  assert.equal(f.providers.get('default').generations,0);
  assert.deepEqual(f.providers.get('cuenta2').calls.find(c=>c[0]==='generate'),['generate','remote-book','source-1']);
  assert.deepEqual(f.providers.get('cuenta2').calls.find(c=>c[0]==='download'),['download','remote-book',b.artifact_id]);
  assert.equal(f.providers.get('cuenta3').generations,0);
});
test('rechazo real de cuota usa respaldo en el siguiente paso sin duplicar solicitudes aceptadas', async t=>{
  const f=await setup(t);f.providers.get('default').rejectQuota=true;
  await f.tick(6);assert.equal(f.store.block(f.block.id).state,'done');
  assert.equal(f.shared.artifacts.length,1);assert.equal(f.store.block(f.block.id).generation_profile,'cuenta2');
});
test('sesión expirada y cuenta lectora se omiten; solo un editor genera',async t=>{
  const f=await setup(t); const owner=f.providers.get('default');owner.health={...owner.health,ready:false,auth:false,errorCode:'AUTH_REQUIRED',error:'expired'};
  f.providers.get('cuenta2').role='viewer'; await f.tick(5);
  assert.equal(f.store.block(f.block.id).generation_profile,'cuenta3');assert.equal(f.shared.artifacts.length,1);
});
test('todas las cuotas agotadas esperan el reinicio más próximo y continúan',async t=>{
  const f=await setup(t);for(const p of f.providers.values()) p.usageData=emptyQuota(f.now());
  await f.tick();const b=f.store.block(f.block.id);assert.equal(b.state,'quota');assert.equal(f.shared.artifacts.length,0);
  assert.ok(b.next_at>f.now());f.providers.get('cuenta3').usageData={windows:[{percent_remaining:90}]};
  f.advance(3600001);await f.tick(5);assert.equal(f.store.block(b.id).state,'done');
});
test('respuesta incierta y reinicio conservan cuenta; nunca rotan para repetir el audio',async t=>{
  const f=await setup(t);f.providers.get('default').usageData=emptyQuota(f.now());
  f.providers.get('cuenta2').behavior.generate=new ProviderError('TEMPORARY','Connection lost',true);
  await f.tick();let b=f.store.block(f.block.id);assert.ok(b.baseline);assert.equal(b.generation_profile,'cuenta2');
  const recovered=new Queue(f.store,f.providers.get('default'),f.options);await recovered.tick();
  b=f.store.block(b.id);assert.equal(b.stage,'poll');assert.equal(b.artifact_id,'audio-cuenta2-1');
  await f.tick(4);assert.equal(f.store.block(b.id).state,'done');assert.equal(f.shared.artifacts.length,1);
});
test('consulta de reconciliación rechazada por cuota conserva diario y no rota',async t=>{
  const f=await setup(t);f.providers.get('default').usageData=emptyQuota(f.now());
  const p=f.providers.get('cuenta2');p.behavior.generate=new ProviderError('TEMPORARY','Lost',true);
  await f.tick();p.artifacts=async()=>{throw new ProviderError('QUOTA','Quota');};
  await f.tick();assert.ok(f.store.block(f.block.id).baseline);assert.equal(f.store.block(f.block.id).generation_profile,'cuenta2');
  assert.equal(f.providers.get('cuenta3').generations,0);assert.equal(f.shared.artifacts.length,1);
});
test('pausa y deshabilitar cuenta conservan seguimiento del audio enviado',async t=>{
  const f=await setup(t);f.providers.get('default').usageData=emptyQuota(f.now());await f.tick();
  f.accounts.enable('cuenta2',false);f.store.update('books',f.book.id,{running:0});
  await f.tick(4);assert.equal(f.store.block(f.block.id).state,'done');assert.equal(f.providers.get('cuenta2').generations,1);
});
test('permisos y perfiles duplicados se validan antes de modificar respaldos',async t=>{
  const f=await setup(t);f.providers.get('cuenta2').role='viewer';
  await assert.rejects(f.accounts.configure(f.store.book(f.book.id),['cuenta2']),/editor/);
  assert.equal(f.store.snapshot()[0].backups.length,2);
  f.providers.get('cuenta2').role='editor';f.accounts.ensure('cuenta2','default@example.com');
  await assert.rejects(f.accounts.configure(f.store.book(f.book.id),['cuenta2']),/misma cuenta/);
  await assert.rejects(f.accounts.configure(f.store.book(f.book.id),['../bad']),/perfil inválido/);
});
test('doble tick concurrente solo envía una generación',async t=>{
  const f=await setup(t);await Promise.all([f.queue.tick(),f.queue.tick(),f.queue.tick()]);assert.equal(f.shared.artifacts.length,1);
});
test('persistencia guarda selección, respaldos, cuenta de audio y espera; cierra todos los proveedores',async t=>{
  const f=await setup(t);f.accounts.select('cuenta2');f.providers.get('default').usageData=emptyQuota(f.now());await f.tick();
  await f.queue.stop();assert.ok([...f.providers.values()].every(p=>p.closed));
  const reopened=new Store(join(f.dir,'queue.sqlite'));
  const accounts=new Accounts(reopened,f.providers.get('default'),{factory:id=>f.providers.get(id)});
  assert.equal(accounts.current,'cuenta2');assert.equal(reopened.block(f.block.id).generation_profile,'cuenta2');
  assert.equal(reopened.snapshot()[0].backups.length,2);assert.ok(accounts.ensure('default').retry_at>f.now());
  reopened.close();
});
test('CLI reutiliza perfiles; exige editor activo y mantiene perfil explícito',async()=>{
  const calls=[];let role='viewer',pending=false;
  const runner={run:async(binary,args,opts)=>{calls.push({args,opts});
    if(args[0]==='login')return 'Available profiles:\n  default: a@example.com\n  cuenta2: b@example.com\n  cuenta3: (invalid)\n';
    if(args[0]==='share')return JSON.stringify({collaborators:[{email:'b@example.com',role,is_pending:pending}]});
    return JSON.stringify([{id:'source-1',status:2}]);},close:async()=>{}};
  const p=new Provider({profile:'cuenta2',runner});assert.equal((await p.profiles()).length,3);
  await assert.rejects(p.access('book','b@example.com'),/edición/);role='editor';pending=true;
  await assert.rejects(p.access('book','b@example.com'),/edición/);pending=false;await p.access('book','b@example.com');
  assert.ok(calls.every(c=>c.opts.env.NLM_PROFILE==='cuenta2'));assert.equal(classify('Authentication failed (network_error: ConnectTimeout)'),'TEMPORARY');
});
test('API cambia cuenta para nuevos libros, conserva existentes y no configura respaldo lector',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'nlm-multi-http-'));const shared={sources:[],artifacts:[]};
  const providers=new Map(['default','cuenta2'].map(id=>[id,new MultiProvider(id,shared)]));
  const app=await makeApp({dataDir:dir,exportsDir:join(dir,'exports'),provider:providers.get('default'),accountFactory:id=>providers.get(id),port:0,worker:false,check:false});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});await app.accounts.discover();
  const call=async(path,method='GET',data)=>fetch(app.origin+path,{method,headers:{'X-Local-Token':app.token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
  const first=await call('/api/books','POST',{title:'Uno',requestId:'one'}).then(r=>r.json());
  assert.equal((await call('/api/accounts/cuenta2/select','POST')).status,200);
  const second=await call('/api/books','POST',{title:'Dos',requestId:'two'}).then(r=>r.json());
  const books=await call('/api/books').then(r=>r.json());assert.equal(books.length,2);
  assert.equal(app.store.book(first.id).profile,'default');assert.equal(app.store.book(second.id).profile,'cuenta2');
  app.store.update('books',first.id,{remote_id:'book'});providers.get('cuenta2').role='viewer';
  assert.equal((await call(`/api/books/${first.id}/accounts`,'PUT',{profiles:['cuenta2']})).status,400);
  assert.equal((await call('/api/accounts','POST',{profile:'../../bad'})).status,400);
});
test('login abre sesión con windowsHide: false, gestiona estado activo y no es bloqueado por la cola', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nlm-login-test-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const calls = [];
  class LoginProvider extends FakeProvider {
    constructor(profile) {
      super(); this.profile = profile; this.health = { ready: false, auth: false, profile, error: 'Sesión expirada.' };
    }
    async login() {
      calls.push(['login', this.profile]);
      this.health = { ready: true, auth: true, profile: this.profile, error: null };
    }
    async check() { return this.health; }
    async profiles() { return [{ id: this.profile, email: `${this.profile}@gmail.com` }]; }
  }
  const providers = new Map(['default', 'cuenta2'].map(id => [id, new LoginProvider(id)]));
  const accounts = new Accounts(store, providers.get('default'), { factory: id => providers.get(id) });
  t.after(async () => { await accounts.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  
  // Login starts and marks loginProfile
  accounts.login('cuenta2');
  assert.equal(accounts.loginProfile, 'cuenta2');
  // Concurrent check during login returns in-progress message without overwriting
  const checking = await accounts.check('cuenta2');
  assert.equal(checking.ready, false);
  assert.match(checking.error, /Inicio de sesión en curso/);

  // Wait for login task to finish
  await Promise.all(accounts.tasks);
  assert.equal(accounts.loginProfile, null);
  assert.deepEqual(calls, [['login', 'cuenta2']]);
  assert.equal(accounts.ensure('cuenta2').email, 'cuenta2@gmail.com');
  assert.equal(providers.get('cuenta2').health.ready, true);
});
test('Provider.login ejecuta comando sin ocultar ventana y extrae errores JSON limpiamente', async () => {
  const calls = [];
  const runner = {
    run: async (bin, args, opts) => {
      calls.push({ bin, args, opts });
      if (args[0] === 'login') return 'Login success';
      if (args[0] === 'usage') {
        const err = new ProviderError('AUTH_REQUIRED', 'Could not read plan usage — Authentication expired.');
        throw err;
      }
      return '{}';
    },
    close: async () => {}
  };
  const p = new Provider({ profile: 'cuenta2', runner });
  await p.login();
  assert.equal(calls[0].opts.windowsHide, false);
  assert.deepEqual(calls[0].args, ['login', '-p', 'cuenta2']);
});
