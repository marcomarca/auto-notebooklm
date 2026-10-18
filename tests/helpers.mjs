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
  async deleteArtifact(book, id) {
    this.calls.push(['deleteArtifact', book, id]);
    if (this.behavior.deleteArtifact) throw this.behavior.deleteArtifact;
    const idx = this.remoteArtifacts.findIndex(a => (a.artifact_id || a.id) === id);
    if (idx !== -1) this.remoteArtifacts.splice(idx, 1);
    return { ok: true };
  }
  async downloadVideo(book, id, path) {
    this.calls.push(['downloadVideo', book, id]);
    if (this.behavior.downloadVideo) throw this.behavior.downloadVideo;
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, Buffer.alloc(256, 1));
  }
  async downloadReport(book, id, path) {
    this.calls.push(['downloadReport', book, id]);
    if (this.behavior.downloadReport) throw this.behavior.downloadReport;
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, '# Report\nContent');
  }
  async downloadSlideDeck(book, id, path, { format } = {}) {
    this.calls.push(['downloadSlideDeck', book, id, format]);
    if (this.behavior.downloadSlideDeck) throw this.behavior.downloadSlideDeck;
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, Buffer.alloc(256, 1));
  }
  async downloadInfographic(book, id, path) {
    this.calls.push(['downloadInfographic', book, id]);
    if (this.behavior.downloadInfographic) throw this.behavior.downloadInfographic;
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, Buffer.alloc(256, 1));
  }
  async downloadMindMap(book, id, path) {
    this.calls.push(['downloadMindMap', book, id]);
    if (this.behavior.downloadMindMap) throw this.behavior.downloadMindMap;
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify({ mindmap: true }));
  }
  async downloadQuiz(book, id, path, { format } = {}) {
    this.calls.push(['downloadQuiz', book, id, format]);
    if (this.behavior.downloadQuiz) throw this.behavior.downloadQuiz;
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, format === 'markdown' ? '# Quiz' : JSON.stringify({ quiz: true }));
  }
  async downloadFlashcards(book, id, path, { format } = {}) {
    this.calls.push(['downloadFlashcards', book, id, format]);
    if (this.behavior.downloadFlashcards) throw this.behavior.downloadFlashcards;
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, format === 'markdown' ? '# Cards' : JSON.stringify({ cards: true }));
  }
  async downloadDataTable(book, id, path) {
    this.calls.push(['downloadDataTable', book, id]);
    if (this.behavior.downloadDataTable) throw this.behavior.downloadDataTable;
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, 'col1,col2\n1,2');
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
