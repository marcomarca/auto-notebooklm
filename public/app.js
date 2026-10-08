const $ = id => document.getElementById(id);
const labels = { pending:'Pendiente', creating:'Creando libro', ready:'Fuente lista', upload_pending:'Por cargar', uploading:'Cargando fuente', source_processing:'Procesando fuente', submitting:'Solicitando audio', queued:'En cola de Google', generating:'Generando', download:'Descargando', convert:'Convirtiendo a MP3', done:'MP3 listo', quota:'Esperando cuota (Generar más tarde)', review:'Revisión necesaria', auth:'Iniciar sesión', error:'Error' };
let token, books = [], selected = localStorage.getItem('selected-book'), uploading = false, lastRender = '', refreshing = false;
let createRequest = crypto.randomUUID();
let accountData = { accounts: [] }, accountStamp = '', backupStamp = '', savingBackups = false;
let viewingExplorer = false, remoteBooks = [], selectedRemoteId = null, remoteDetail = null, selectedArtifacts = new Set(), explorerProfile = null;
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
    const [health, current, profiles] = await Promise.all([api('/api/health'), api('/api/books'), api('/api/accounts')]);
    accountData = profiles; renderAccounts();
    showHealth(health); books = current;
    if (!viewingExplorer && !books.some(b=>b.id === selected)) selected = books[0]?.id;
    if (viewingExplorer && selectedRemoteId && remoteDetail) {
      const localBook = books.find(b => b.remoteId === selectedRemoteId || b.id === remoteDetail.localBookId);
      if (localBook) {
        remoteDetail.localBookId = localBook.id;
        const blockByArtifact = new Map((localBook.blocks || []).filter(b => b.artifactId).map(b => [b.artifactId, b]));
        let changed = false;
        for (const art of (remoteDetail.artifacts || [])) {
          const localBlock = blockByArtifact.get(art.id);
          const newState = localBlock ? localBlock.state : null;
          const newDone = localBlock ? localBlock.state === 'done' : false;
          if (art.localState !== newState || art.isDone !== newDone) {
            art.localState = newState;
            art.isDone = newDone;
            changed = true;
          }
        }
        if (changed) renderRemoteDetail();
      }
    }
    render();
  } catch(e) { notice(`No se pudo conectar a la aplicación. ${e.message}`, true); }
  finally { refreshing = false; }
}
function renderAccounts() {
  const stamp = JSON.stringify(accountData);
  if (stamp === accountStamp) return;
  accountStamp = stamp;
  const cards = accountData.accounts.map(a => {
    const card = el('div', { class: 'account-card' });
    const h = a.health, windows = h.usage?.windows || [];
    const remaining = windows.filter(w => typeof w.percent_remaining === 'number').map(w => w.percent_remaining);
    const isLoggingIn = accountData.loginProfile === a.id;
    const status = isLoggingIn ? 'Iniciando sesión en el navegador…' : h.ready ? 'Sesión comprobada' : h.errorCode === 'AUTH_REQUIRED' ? 'Sesión expirada' : 'Sesión sin confirmar';
    card.append(el('strong', {}, `${a.id}${a.id === accountData.current ? ' · Para nuevos libros' : ''}`),
      el('small', {}, a.email || 'Sin cuenta guardada'), el('small', {}, `${status}${remaining.length ? ` · Cuota mínima restante: ${Math.min(...remaining)}%` : isLoggingIn ? '' : ' · Cuota sin confirmar'}`));
    if (isLoggingIn) {
      card.append(el('small', { class: 'block-hint' }, 'Completa el inicio de sesión en la ventana de Chrome que se ha abierto.'));
    } else if (a.error || h.error) {
      card.append(el('small', { class: 'block-error' }, a.error || h.error));
    }
    if (a.nextAt && !isLoggingIn) card.append(el('small', {}, `Próxima comprobación: ${date(a.nextAt)}`));
    const enabled = el('input', { type: 'checkbox', checked: a.enabled });
    enabled.addEventListener('change', () => act(() => api(`/api/accounts/${a.id}/enabled`, { method: 'POST', data: { enabled: enabled.checked } })));
    const label = el('label', { class: 'account-option' }); label.append(enabled, document.createTextNode('Habilitada para la cola')); card.append(label);
    const buttons = el('div', { class: 'account-actions' });
    for (const [action, text] of [['check', 'Comprobar'], ['login', isLoggingIn ? 'Iniciando sesión…' : 'Iniciar sesión'], ['select', 'Usar para nuevos libros']]) {
      const button = el('button', { class: 'quiet', disabled: (action === 'login' && !!accountData.loginProfile) || (action === 'select' && a.id === accountData.current),
        onclick: () => {
          button.disabled = true;
          act(async () => {
            await api(`/api/accounts/${a.id}/${action}`, { method: 'POST' });
            if (action === 'select') createRequest = crypto.randomUUID();
            if (action === 'login') notice('Se ha abierto Chrome para iniciar sesión. Al terminar, la cuenta se validará automáticamente.');
          }).finally(() => { button.disabled = false; accountStamp = ''; });
        }
      }, text);
      buttons.append(button);
    }
    card.append(buttons); return card;
  });
  $('accounts').replaceChildren(...cards);
  
  const select = $('explorer-profile');
  if (select) {
    const cur = explorerProfile || accountData.current || 'default';
    select.replaceChildren(...accountData.accounts.map(a => {
      const opt = el('option', { value: a.id }, `${a.id}${a.email ? ` (${a.email})` : ''}`);
      if (a.id === cur) opt.selected = true;
      return opt;
    }));
  }
}
function renderBackups(book) {
  $('book-owner').textContent = `Cuenta propietaria: ${book.profile}. La cuenta de cada audio aparece en su estado.`;
  const stamp = JSON.stringify([book.id, book.backups, accountData.accounts.map(a => [a.id, a.email])]);
  if (stamp === backupStamp || savingBackups) return;
  backupStamp = stamp;
  $('backups').replaceChildren(...accountData.accounts.filter(a => a.id !== book.profile).map(a => {
    const label = el('label', { class: 'account-option' });
    label.append(el('input', { type: 'checkbox', value: a.id, checked: book.backups.includes(a.id), disabled: !a.email }), document.createTextNode(`${a.id} · ${a.email || 'Inicia sesión primero'}`));
    return label;
  }));
  $('backup-status').textContent = book.backups.length ? `Respaldos verificados: ${book.backups.join(', ')}` : 'Solo se está usando la cuenta propietaria.';
  $('save-backups').disabled = !book.remoteId;
}
function choose(id) { viewingExplorer = false; selected = id; localStorage.setItem('selected-book', id); lastRender=''; render(); }

async function openExplorer() {
  viewingExplorer = true; lastRender = ''; render();
  await loadRemoteBooks();
}
function closeExplorer() {
  viewingExplorer = false; if (!selected && books.length) selected = books[0].id;
  lastRender = ''; render();
}
async function loadRemoteBooks() {
  const profile = $('explorer-profile')?.value || explorerProfile || accountData.current || 'default';
  explorerProfile = profile;
  notice('Cargando lista de cuadernos desde NotebookLM…');
  try {
    remoteBooks = await api(`/api/remote/notebooks?profile=${encodeURIComponent(profile)}`);
    notice(`Se encontraron ${remoteBooks.length} cuadernos en la cuenta.`);
    renderRemoteBooks();
  } catch(e) {
    notice(`Error al listar cuadernos: ${e.message}`, true);
  }
}
function renderRemoteBooks() {
  const list = $('remote-books');
  if (!remoteBooks.length) {
    list.replaceChildren(el('div', { class: 'remote-empty-state' }, 'No hay cuadernos disponibles en esta cuenta.'));
    return;
  }
  list.replaceChildren(...remoteBooks.map(b => {
    const item = el('button', {
      class: `remote-book-item${b.id === selectedRemoteId ? ' active' : ''}`,
      onclick: () => selectRemoteBook(b.id)
    }, b.title);
    if (b.modifiedAt || b.createdAt) {
      item.append(el('small', {}, `Modificado: ${date(Date.parse(b.modifiedAt || b.createdAt))}`));
    }
    return item;
  }));
}
async function selectRemoteBook(id) {
  selectedRemoteId = id;
  renderRemoteBooks();
  const profile = $('explorer-profile')?.value || explorerProfile || accountData.current || 'default';
  notice('Consultando audios del cuaderno seleccionado…');
  try {
    remoteDetail = await api(`/api/remote/notebooks/${encodeURIComponent(id)}?profile=${encodeURIComponent(profile)}`);
    const bookTitle = remoteDetail.title || remoteBooks.find(b => b.id === id)?.title || 'Cuaderno';
    $('remote-book-title').textContent = bookTitle;
    $('remote-book-link').href = `https://notebooklm.google.com/notebook/${encodeURIComponent(id)}`;
    selectedArtifacts = new Set(remoteDetail.artifacts.map(a => a.id));
    $('remote-detail-empty').hidden = true;
    $('remote-detail').hidden = false;
    renderRemoteDetail();
    notice('');
  } catch (e) {
    notice(`Error al consultar cuaderno: ${e.message}`, true);
  }
}
function renderRemoteDetail() {
  if (!remoteDetail) return;
  const tbody = $('remote-artifacts');
  const empty = $('remote-artifacts-empty');
  const artifacts = remoteDetail.artifacts || [];
  empty.hidden = !!artifacts.length;
  tbody.hidden = !artifacts.length;
  
  $('remote-select-all').checked = artifacts.length > 0 && artifacts.every(a => selectedArtifacts.has(a.id));
  $('remote-download-btn').disabled = selectedArtifacts.size === 0;
  $('remote-download-btn').textContent = selectedArtifacts.size > 0
    ? `Descargar audios seleccionados (${selectedArtifacts.size})`
    : 'Descargar audios seleccionados';

  tbody.replaceChildren(...artifacts.map(a => {
    const row = el('tr');
    const checkTd = el('td');
    const cb = el('input', { type: 'checkbox', checked: selectedArtifacts.has(a.id) });
    cb.addEventListener('change', () => {
      if (cb.checked) selectedArtifacts.add(a.id);
      else selectedArtifacts.delete(a.id);
      renderRemoteDetail();
    });
    checkTd.append(cb);
    
    const titleTd = el('td');
    titleTd.append(el('strong', {}, a.title || 'Audio'));
    if (a.createdAt) titleTd.append(el('small', { class: 'source-name' }, `Creado: ${date(Date.parse(a.createdAt))}`));
    
    const srcTd = el('td', {}, a.sourceTitle || '—');
    const stateTd = el('td');
    stateTd.append(el('span', { class: `badge ${a.status === 'completed' || a.status === 'ready' ? 'done' : a.status === 'failed' ? 'error' : 'generating'}` },
      a.status === 'completed' || a.status === 'ready' ? 'Completado' : a.status === 'queued' ? 'En cola de Google' : a.status === 'failed' ? 'Error' : 'Generando'));
    if (a.errorReason) stateTd.append(el('div', { class: 'block-error' }, a.errorReason));
    
    const localTd = el('td');
    if (a.isDone) {
      localTd.append(el('span', { class: 'badge done' }, 'MP3 listo'));
    } else if (a.localState === 'download') {
      const b = el('span', { class: 'badge download active-pulse' });
      b.append(el('span', { class: 'mini-dot' }), document.createTextNode(' Descargando…'));
      localTd.append(b);
    } else if (a.localState === 'convert') {
      const b = el('span', { class: 'badge convert active-pulse' });
      b.append(el('span', { class: 'mini-dot' }), document.createTextNode(' Convirtiendo a MP3…'));
      localTd.append(b);
    } else if (a.localState === 'generating' || a.localState === 'submitting') {
      const b = el('span', { class: 'badge generating active-pulse' });
      b.append(el('span', { class: 'mini-dot' }), document.createTextNode(' Generando…'));
      localTd.append(b);
    } else if (a.localState) {
      localTd.append(el('span', { class: `badge ${a.localState}` }, labels[a.localState] || a.localState));
    } else {
      localTd.append(el('span', { class: 'audio-wait' }, 'No descargado'));
    }
    
    row.append(checkTd, titleTd, srcTd, stateTd, localTd);
    return row;
  }));
}
async function downloadRemoteAudios() {
  if (!selectedRemoteId || !selectedArtifacts.size) return;
  const artifactIds = [...selectedArtifacts];
  const profile = $('explorer-profile')?.value || explorerProfile || accountData.current || 'default';
  const bookTitle = remoteDetail?.title || remoteBooks.find(b => b.id === selectedRemoteId)?.title || 'Cuaderno remoto';
  $('remote-download-btn').disabled = true;
  notice(`Añadiendo ${artifactIds.length} audios a la cola de descarga…`);
  try {
    const res = await api(`/api/remote/notebooks/${encodeURIComponent(selectedRemoteId)}/import`, {
      method: 'POST',
      data: { title: bookTitle, profile, artifactIds }
    });
    viewingExplorer = false;
    selected = res.bookId;
    localStorage.setItem('selected-book', selected);
    notice(`${artifactIds.length} audios añadidos a la cola. Se descargarán y convertirán a MP3 uno a uno.`);
    lastRender = '';
    await refresh();
  } catch (e) {
    notice(`Error al programar descargas: ${e.message}`, true);
  } finally {
    $('remote-download-btn').disabled = false;
  }
}

function getActiveStatus() {
  const selectedBook = books.find(b => b.id === selected);
  const processingBook = books.find(b => (b.blocks || []).some(bl => ['download', 'convert', 'generating', 'submitting', 'uploading', 'source_processing', 'queued'].includes(bl.state)));
  const runningBook = books.find(b => b.running && (b.blocks || []).some(bl => bl.state !== 'done'));
  
  const book = processingBook || runningBook || selectedBook;
  if (!book || !book.blocks || !book.blocks.length) return null;
  
  const total = book.blocks.length;
  const done = book.blocks.filter(b => b.state === 'done').length;
  const percent = total ? Math.round((done / total) * 100) : 0;
  const activeBlock = book.blocks.find(b => ['download', 'convert', 'generating', 'submitting', 'uploading', 'source_processing', 'queued'].includes(b.state));
  
  let action = '';
  let dotClass = 'feedback-dot';
  let isLive = false;
  
  if (activeBlock) {
    const st = activeBlock.state;
    const verb = st === 'download' ? 'Descargando'
      : st === 'convert' ? 'Convirtiendo a MP3'
      : st === 'uploading' ? 'Cargando fuente'
      : st === 'source_processing' ? 'Procesando fuente'
      : st === 'submitting' ? 'Solicitando audio'
      : st === 'queued' ? 'En cola de Google'
      : 'Generando audio';
    action = `${book.title} · ${verb} audio ${activeBlock.number} de ${total}: «${activeBlock.title}»`;
    dotClass += ' active';
    isLive = true;
  } else if (book.quotaError || book.blocks.some(b => b.state === 'quota')) {
    action = `${book.title} · Esperando cuota (Generar más tarde) (${done} de ${total} listos)`;
    dotClass += ' waiting';
    isLive = true;
  } else if (done === total && total > 0) {
    action = `${book.title} · Todos los audios completados (${total} MP3 listos)`;
    dotClass += ' done';
    isLive = false;
  } else if (book.running) {
    action = `${book.title} · Procesando cola (${done} de ${total} listos)`;
    dotClass += ' active';
    isLive = true;
  } else {
    action = `${book.title} · ${done} de ${total} audios listos`;
    dotClass += ' paused';
    isLive = false;
  }
  
  return { book, total, done, percent, action, dotClass, isLive, activeBlock };
}

function renderPermanentFeedback() {
  const status = getActiveStatus();
  const box = $('permanent-feedback');
  if (!status) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $('feedback-dot').className = status.dotClass;
  $('feedback-text').textContent = status.action;
  $('feedback-percent').textContent = `${status.percent}%`;
  $('feedback-fill').style.width = `${status.percent}%`;
}

function render() {
  renderPermanentFeedback();
  if (document.activeElement?.classList.contains('block-title')) return;
  const book = books.find(b=>b.id === selected);
  const stamp = JSON.stringify({ books, selected, uploading, viewingExplorer, profiles: accountData.accounts.map(a => [a.id, a.email]) });
  if (stamp === lastRender) return;
  lastRender = stamp;
  $('library').replaceChildren(...books.map(b => {
    const button = el('button',{class:`book-button${!viewingExplorer && b.id === selected ? ' active' : ''}`,onclick:()=>{ viewingExplorer=false; choose(b.id); }},b.title);
    button.append(el('small',{},`${b.blocks.filter(x=>x.state === 'done').length} de ${b.blocks.length} audios listos`));
    return button;
  }));

  if (viewingExplorer) {
    $('welcome').hidden = true; $('workspace').hidden = true; $('explorer').hidden = false;
    $('current-title').textContent = 'Explorador de cuadernos';
    $('subtitle').textContent = 'Revisa tus libros de NotebookLM y descarga sus audios en lote con un clic.';
    $('remote-link').hidden = true;
    $('open-folder-btn').hidden = true;
    return;
  }

  $('explorer').hidden = true;
  $('welcome').hidden = !!book; $('workspace').hidden = !book;
  $('current-title').textContent = book?.title || 'Del libro al podcast';
  $('subtitle').textContent = book ? 'Un podcast independiente por fuente, dentro del mismo libro.' : 'Una fuente. Un audio. Cada bloque conserva su lugar.';
  $('remote-link').hidden = !book?.url; if (book?.url) $('remote-link').href=book.url;
  $('open-folder-btn').hidden = !book;
  if (!book) return;
  renderBackups(book);
  const status = $('book-status'); status.replaceChildren();
  if (!book.remoteId) {
    status.append(el('span',{},book.error || labels[book.state] || book.state));
    if (['review','error','auth'].includes(book.state)) status.append(el('button',{class:'quiet',onclick:()=>act(()=>api(`/api/books/${book.id}/retry`,{method:'POST'}))},book.state === 'review' ? 'Comprobar de nuevo' : 'Reintentar'));
  }
  const doneCount = book.blocks.filter(b => b.state === 'done').length;
  const totalCount = book.blocks.length;
  const percent = totalCount ? Math.round((doneCount / totalCount) * 100) : 0;
  const activeBlock = book.blocks.find(b => ['download', 'convert', 'generating', 'submitting', 'uploading', 'source_processing', 'queued'].includes(b.state));

  let actionText = '';
  let pulseClass = 'pulse-dot';
  if (activeBlock) {
    const st = activeBlock.state;
    const verb = st === 'download' ? 'Descargando'
      : st === 'convert' ? 'Convirtiendo a MP3'
      : st === 'uploading' ? 'Cargando fuente'
      : st === 'source_processing' ? 'Procesando fuente'
      : st === 'submitting' ? 'Solicitando audio'
      : st === 'queued' ? 'En cola de Google'
      : 'Generando audio';
    actionText = `${verb} audio ${activeBlock.number} de ${totalCount}: «${activeBlock.title}»`;
    pulseClass += ' active';
  } else if (book.quotaError || book.blocks.some(b => b.state === 'quota')) {
    actionText = `Esperando cuota (Generar más tarde) (${doneCount} de ${totalCount} listos)`;
    pulseClass += ' waiting';
  } else if (doneCount === totalCount && totalCount > 0) {
    actionText = `Todos los audios completados (${totalCount} MP3 listos)`;
    pulseClass += ' done';
  } else if (!book.running) {
    actionText = `Cola pausada (${doneCount} de ${totalCount} listos)`;
    pulseClass += ' paused';
  } else {
    actionText = `${doneCount} de ${totalCount} audios listos`;
  }

  $('progress-label').textContent = actionText;
  $('progress-percent').textContent = `${percent}%`;
  $('progress-bar-fill').style.width = `${percent}%`;
  $('pulse-indicator').className = pulseClass;

  $('book-numbering').checked = book.numbering !== false;
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
    const state=el('td');
    const isPulsing = ['download', 'convert', 'generating', 'submitting', 'uploading', 'source_processing'].includes(block.state);
    const badge = el('span', { class: `badge ${block.state}${isPulsing ? ' active-pulse' : ''}` });
    if (isPulsing) {
      badge.append(el('span', { class: 'mini-dot' }), document.createTextNode(` ${labels[block.state] || block.state}…`));
    } else {
      badge.textContent = labels[block.state] || block.state;
    }
    state.append(badge);
    if (block.generationProfile) state.append(el('div', { class: 'account-tag' }, `Cuenta: ${block.generationProfile}`));
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
  const tbody=$('blocks');
  rows.forEach((row,i)=>{if(tbody.children[i] !== row) tbody.insertBefore(row,tbody.children[i] || null);});
  while(tbody.children.length > rows.length) tbody.lastChild.remove();
}

$('book-numbering').addEventListener('change', e => {
  if (!selected) return;
  const numbering = e.target.checked;
  act(async () => {
    await api(`/api/books/${selected}/numbering`, { method: 'PATCH', data: { numbering } });
    notice(numbering
      ? 'Numeración activada. Los archivos exportados se nombrarán como «001 - Título.mp3».'
      : 'Numeración desactivada. Los archivos exportados se nombrarán como «Título.mp3».');
  });
});

$('open-explorer').addEventListener('click', openExplorer);
$('close-explorer').addEventListener('click', closeExplorer);
$('explorer-reload').addEventListener('click', () => act(loadRemoteBooks));
$('explorer-profile').addEventListener('change', e => { explorerProfile = e.target.value; act(loadRemoteBooks); });
$('remote-select-all').addEventListener('change', e => {
  const artifacts = remoteDetail?.artifacts || [];
  if (e.target.checked) {
    selectedArtifacts = new Set(artifacts.map(a => a.id));
  } else {
    selectedArtifacts.clear();
  }
  renderRemoteDetail();
});
$('remote-download-btn').addEventListener('click', () => act(downloadRemoteAudios));

$('create-form').addEventListener('submit',event=>{
  event.preventDefault();
  $('create-button').disabled=true;
  act(async()=>{
    const book=await api('/api/books',{method:'POST',data:{title:$('book-title').value,requestId:createRequest}});
    viewingExplorer = false; selected=book.id; localStorage.setItem('selected-book',selected); $('book-title').value=''; createRequest=crypto.randomUUID(); notice('Libro registrado. Se está creando en NotebookLM.');
  }).finally(()=>{$('create-button').disabled=false;});
});
$('book-title').addEventListener('input',()=>{createRequest=crypto.randomUUID();});
$('account-form').addEventListener('submit', event => {
  event.preventDefault(); $('add-account').disabled = true;
  act(async () => {
    const profile = $('new-profile').value.trim();
    if (!profile) return;
    await api('/api/accounts', { method: 'POST', data: { profile } });
    await api(`/api/accounts/${profile}/login`, { method: 'POST' });
    $('new-profile').value = '';
    notice('Se ha abierto Chrome para iniciar sesión. Al terminar, la cuenta se validará automáticamente.');
  }).finally(() => { $('add-account').disabled = false; });
});
$('save-backups').addEventListener('click', () => {
  const bookId = selected, profiles = [...$('backups').querySelectorAll('input:checked')].map(n => n.value);
  savingBackups = true; $('save-backups').disabled = true; $('backup-status').textContent = 'Comprobando sesión y permisos…';
  act(async () => { await api(`/api/books/${bookId}/accounts`, { method: 'PUT', data: { profiles } }); notice('Respaldos verificados. Habilita las cuentas en «Cuentas y cuota» para que la cola pueda utilizarlas.'); }).finally(() => { savingBackups = false; backupStamp = ''; lastRender = ''; render(); });
});
$('check-connection').addEventListener('click',()=>{
  $('check-connection').disabled=true;
  act(async()=>{showHealth(await api('/api/health/check',{method:'POST'}));}).finally(()=>{$('check-connection').disabled=false;});
});
$('open-folder-btn')?.addEventListener('click', () => {
  if (!selected) return;
  act(async () => {
    const res = await api(`/api/books/${selected}/open-folder`, { method: 'POST' });
    notice(`Carpeta abierta en el Explorador de Windows: ${res.path}`);
  });
});
$('open-exports-btn')?.addEventListener('click', () => {
  act(async () => {
    const res = await api('/api/exports/open', { method: 'POST' });
    notice(`Carpeta exports abierta en el Explorador de Windows: ${res.path}`);
  });
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
