import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { Queue } from '../queue.mjs';
import { ProviderError } from '../provider.mjs';

export class FakeProvider {
  constructor() {
    this.profile='default'; this.health={ ready:true, auth:true, cli:true, ffmpeg:true, profile:'default' };
    this.remoteBooks=[]; this.remoteSources=[]; this.remoteArtifacts=[]; this.calls=[];
    this.usageData={windows:[{window:'rolling',percent_remaining:100,resets_at:null}]};
    this.behavior={}; this.generations=0;
  }
  async check() { return this.health; }
  async close() {}
  async usage() { this.calls.push(['usage']); if(this.behavior.usage) throw this.behavior.usage; return this.usageData; }
  async listBooks() { return this.remoteBooks; }
  async createBook(title) {
    const id=`book-${this.remoteBooks.length+1}`;
    this.calls.push(['createBook',title]); this.remoteBooks.push({id,title});
    if(this.behavior.createBook) throw this.behavior.createBook;
    return id;
  }
  async sources() { return this.remoteSources; }
  async upload(book,block) {
    const id=`source-${this.remoteSources.length+1}`;
    this.calls.push(['upload',book,block.id]); this.remoteSources.push({id,title:block.source_title,status:2});
    if(this.behavior.upload) throw this.behavior.upload;
    return id;
  }
  async artifacts(book,id) { return this.remoteArtifacts.filter(a=>!id || a.artifact_id === id); }
  async generate(book,source) {
    if(!source) throw new Error('Missing source');
    const id=`audio-${++this.generations}`;
    this.calls.push(['generate',book,source]);
    this.remoteArtifacts.push({artifact_id:id,type:'audio',source_ids:[source],status:'completed'});
    if(this.behavior.generate) throw this.behavior.generate;
    return id;
  }
  async download(book,id,path) {
    this.calls.push(['download',book,id]);
    if(this.behavior.download) throw this.behavior.download;
    await mkdir(join(path,'..'),{recursive:true}); await writeFile(path,Buffer.alloc(256,1));
  }
  async convert(original,path) {
    this.calls.push(['convert',original,path]);
    if(this.behavior.convert) throw this.behavior.convert;
    await mkdir(join(path,'..'),{recursive:true}); await writeFile(path,Buffer.alloc(512,2));
  }
}
export async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'auto-nlm-test-'));
  let store=new Store(join(dir,'queue.sqlite')); const provider=new FakeProvider();
  let now=Date.now();
  const options={dataDir:dir,exportsDir:join(dir,'exports'),now:()=>now};
  const queue=new Queue(store,provider,options);
  t.after(async()=>{await queue.stop();store.close();await rm(dir,{recursive:true,force:true});});
  const book=store.createBook({title:'Libro de prueba',requestId:'book-request'},'default');
  const add=(n=1)=>store.addBlock(book.id,{requestId:`request-${n}`,title:`Parte ${n}`,filename:`Parte ${n}.md`,filePath:join(dir,`part-${n}.md`),hash:`hash-${n}`});
  const tick=async(count=1)=>{for(let i=0;i<count;i++){await queue.tick();now+=60001;}};
  return {dir,store,provider,queue,book,add,tick,advance:n=>{now+=n;},now:()=>now,options};
}
export const temporary = () => new ProviderError('TEMPORARY','Connection lost',true);
