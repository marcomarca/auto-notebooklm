const $ = id => document.getElementById(id);
const labels = { pending:'Pendiente', creating:'Creando libro', ready:'Fuente lista', upload_pending:'Por cargar', uploading:'Cargando fuente', source_processing:'Procesando fuente', submitting:'Solicitando audio', queued:'En cola de Google', generating:'Generando', download:'Descargando', convert:'Convirtiendo a MP3', done:'MP3 listo', quota:'Esperando cuota', review:'Revisión necesaria', auth:'Iniciar sesión', error:'Error' };
let token, books = [], selected = localStorage.getItem('selected-book'), uploading = false, lastRender = '', refreshing = false;
let createRequest = crypto.randomUUID();
const date = t => new Intl.DateTimeFormat('es-BO', { dateStyle:'medium', timeStyle:'short', timeZone:'America/La_Paz' }).format(t);
function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [key,value] of Object.entries(attrs)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}
function notice(text, error = false) { $('notice').textContent = text; $('notice').hidden = !text; $('notice').className = error ? 'error' : ''; }
async function api(path, { method = 'GET', data, binary } = {}) {
  const response = await fetch(path, { method, headers: { ...(method !== 'GET' ? { 'X-Local-Token': token } : {}), ...(data ? { 'Content-Type':'application/json' } : {}) }, body: binary || (data ? JSON.stringify(data) : undefined) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'No se pudo completar la operación.');
  return value;
}
async function act(fn) { try { await fn(); await refresh(); } catch(e) { notice(e.message, true); } }
function showHealth(h) {
  if (h.token) token = h.token;
  $('health-label').textContent = h.error || (h.ready ? 'NotebookLM conectado' : 'Comprobando conexión…');
  $('profile-label').textContent = `Perfil: ${h.profile || 'default'}${h.version ? ` · ${h.version.replace('nlm version ','')}` : ''}`;
  $('login-hint').hidden = h.auth || !h.cli || h.errorCode !== 'AUTH_REQUIRED';
  $('login-hint').textContent = `nlm login -p ${h.profile || 'default'}`;
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [health, current] = await Promise.all([api('/api/health'), api('/api/books')]);
    showHealth(health); books = current;
    if (!books.some(b=>b.id === selected)) selected = books[0]?.id;
    render();
  } catch(e) { notice(`No se pudo conectar a la aplicación. ${e.message}`, true); }
  finally { refreshing = false; }
}
function choose(id) { selected = id; localStorage.setItem('selected-book', id); lastRender=''; render(); }
function render() {
  // Keep an edited title and a playing audio element intact during status polling.
  if (document.activeElement?.classList.contains('block-title')) return;
  const book = books.find(b=>b.id === selected);
  const stamp = JSON.stringify({ books, selected, uploading });
  if (stamp === lastRender) return;
  lastRender = stamp;
  $('library').replaceChildren(...books.map(b => {
    const button = el('button',{class:`book-button${b.id === selected ? ' active' : ''}`,onclick:()=>choose(b.id)},b.title);
    button.append(el('small',{},`${b.blocks.filter(x=>x.state === 'done').length} de ${b.blocks.length} audios listos`));
    return button;
  }));
  $('welcome').hidden = !!book; $('workspace').hidden = !book;
  $('current-title').textContent = book?.title || 'Del libro al podcast';
  $('subtitle').textContent = book ? 'Un podcast independiente por fuente, dentro del mismo libro.' : 'Una fuente. Un audio. Cada bloque conserva su lugar.';
  $('remote-link').hidden = !book?.url; if (book?.url) $('remote-link').href=book.url;
  if (!book) return;
  const status = $('book-status'); status.replaceChildren();
  if (!book.remoteId) {
    status.append(el('span',{},book.error || labels[book.state] || book.state));
    if (['review','error','auth'].includes(book.state)) status.append(el('button',{class:'quiet',onclick:()=>act(()=>api(`/api/books/${book.id}/retry`,{method:'POST'}))},book.state === 'review' ? 'Comprobar de nuevo' : 'Reintentar'));
  }
  $('progress-label').textContent = `${book.blocks.filter(b=>b.state === 'done').length} de ${book.blocks.length} audios listos`;
  $('generate').textContent = book.running ? 'Cola en marcha' : book.blocks.some(b=>b.locked && b.state !== 'done') ? 'Reanudar pendientes' : 'Generar audios pendientes';
  $('generate').disabled = book.running || book.blocks.every(b=>b.state === 'done') || !book.remoteId || uploading;
  $('pause').disabled = !book.running;
  $('files').disabled = uploading;
  $('quota').hidden = !book.quotaError;
  $('quota').textContent = book.quotaError ? `${book.quotaError}${book.nextAt ? ` Próxima comprobación: ${date(book.nextAt)}.` : ''}` : '';
  $('empty-blocks').hidden = !!book.blocks.length;
  const oldRows = new Map([...$('blocks').children].map(row=>[row.dataset.id,row]));
  const rows = book.blocks.map((block,index) => {
    const stamp = JSON.stringify([block,block.locked ? null : [book.blocks[index-1],book.blocks[index+1]].map(b=>b ? [b.id,b.locked] : null)]);
    const existing = oldRows.get(block.id);
    if (existing?.dataset.stamp === stamp) return existing;
    const row=el('tr'); row.dataset.id=block.id; row.dataset.stamp=stamp;
    const number=el('td'); number.append(el('span',{class:'number'},String(block.number).padStart(2,'0')));
    const order=el('div',{class:'order-buttons'});
    for (const [direction, symbol, label] of [[-1,'↑','Subir bloque'],[1,'↓','Bajar bloque']]) {
      const neighbor = book.blocks[index+direction];
      order.append(el('button',{title:label,'aria-label':`${label} ${block.number}`,disabled:block.locked || !neighbor || neighbor.locked,
        onclick:()=>act(async()=>{ const ids=book.blocks.map(b=>b.id); [ids[index],ids[index+direction]]=[ids[index+direction],ids[index]]; await api(`/api/books/${book.id}/order`,{method:'PATCH',data:{ids}}); })},symbol));
    }
    number.append(order);
    const source=el('td');
    const input=el('input',{class:'block-title',value:block.title,maxLength:180,disabled:block.locked,'aria-label':`Título del bloque ${block.number}`});
    input.addEventListener('change',()=>act(async()=>{
      try { await api(`/api/blocks/${block.id}`,{method:'PATCH',data:{title:input.value}}); }
      catch(e) { input.value=block.title; throw e; }
    }));
    source.append(input,el('div',{class:'source-name'},block.filename));
    const state=el('td'); state.append(el('span',{class:`badge ${block.state}`},labels[block.state] || block.state));
    if (block.error) state.append(el('div',{class:'block-error'},block.error));
    if (block.nextAt) state.append(el('div',{class:'next-at'},`Próximo intento: ${date(block.nextAt)}`));
    if (['error','review','auth','quota'].includes(block.state)) state.append(el('button',{class:'quiet retry',onclick:()=>act(()=>api(`/api/blocks/${block.id}/retry`,{method:'POST'}))},block.state === 'review' ? 'Comprobar de nuevo' : block.errorCode === 'ARTIFACT_FAILED' ? 'Generar de nuevo' : 'Reintentar'));
    const audio=el('td');
    if (block.audioUrl) {
      const player=el('audio',{controls:true,preload:'none',src:block.audioUrl,'aria-label':`Audio del bloque ${block.number}`});
      audio.append(player,el('a',{class:'download-link',href:`${block.audioUrl}?download=1`,download:block.outputName},'Descargar MP3'));
    } else audio.append(el('span',{class:'audio-wait'},'Disponible al terminar'));
    row.append(number,source,state,audio); return row;
  });
  // Move only rows whose order changed; leave existing media nodes attached.
  const tbody=$('blocks');
  rows.forEach((row,i)=>{if(tbody.children[i] !== row) tbody.insertBefore(row,tbody.children[i] || null);});
  while(tbody.children.length > rows.length) tbody.lastChild.remove();
}
$('create-form').addEventListener('submit',event=>{
  event.preventDefault();
  $('create-button').disabled=true;
  act(async()=>{
    const book=await api('/api/books',{method:'POST',data:{title:$('book-title').value,requestId:createRequest}});
    selected=book.id; localStorage.setItem('selected-book',selected); $('book-title').value=''; createRequest=crypto.randomUUID(); notice('Libro registrado. Se está creando en NotebookLM.');
  }).finally(()=>{$('create-button').disabled=false;});
});
$('book-title').addEventListener('input',()=>{createRequest=crypto.randomUUID();});
$('check-connection').addEventListener('click',()=>{
  $('check-connection').disabled=true;
  act(async()=>{showHealth(await api('/api/health/check',{method:'POST'}));}).finally(()=>{$('check-connection').disabled=false;});
});
$('generate').addEventListener('click',()=>act(()=>api(`/api/books/${selected}/queue`,{method:'POST',data:{action:'start'}})));
$('pause').addEventListener('click',()=>act(()=>api(`/api/books/${selected}/queue`,{method:'POST',data:{action:'pause'}})));
async function addFiles(list) {
  if (uploading || !selected) return;
  const bookId=selected;
  const files=[...list].sort((a,b)=>a.name.localeCompare(b.name,'es',{numeric:true,sensitivity:'base'}));
  uploading=true; render(); let added=0, duplicates=0; const errors=[];
  for (let i=0;i<files.length;i++) {
    const file=files[i]; notice(`Guardando archivo ${i+1} de ${files.length}: ${file.name}`);
    try {
      if (!/\.(md|pdf)$/i.test(file.name)) throw new Error('Solo se admiten Markdown o PDF.');
      const result=await api(`/api/books/${bookId}/files?filename=${encodeURIComponent(file.name)}&requestId=${crypto.randomUUID()}`,{method:'PUT',binary:file});
      if(result.duplicate || result.existing) duplicates++; else added++;
    } catch(e) { errors.push(`${file.name}: ${e.message}`); }
  }
  uploading=false; $('files').value=''; lastRender='';
  notice(`${added} archivos añadidos.${duplicates ? ` ${duplicates} duplicados omitidos.` : ''}${errors.length ? ` ${errors.join(' ')}` : ' Se cargarán automáticamente en NotebookLM.'}`,!!errors.length);
  await refresh();
}
$('files').addEventListener('change',event=>addFiles(event.target.files));
const drop=$('drop-zone');
for(const event of ['dragenter','dragover']) drop.addEventListener(event,e=>{e.preventDefault();drop.classList.add('dragging');});
for(const event of ['dragleave','drop']) drop.addEventListener(event,e=>{e.preventDefault();drop.classList.remove('dragging');});
drop.addEventListener('drop',event=>addFiles(event.dataTransfer.files));
drop.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();$('files').click();}});
refresh(); setInterval(refresh,2000);
