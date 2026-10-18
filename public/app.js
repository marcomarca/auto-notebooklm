const $ = id => document.getElementById(id);
const labels = { pending:'Pendiente', creating:'Creando libro', ready:'Fuente lista', upload_pending:'Por cargar', uploading:'Cargando fuente', source_processing:'Procesando fuente', submitting:'Solicitando audio', queued:'En cola de Google', deferred:'En cola diferida (ahorra cuota)', generating:'Generando', download:'Descargando', convert:'Convirtiendo a MP3', done:'MP3 listo', quota:'Esperando cuota (Generar más tarde)', review:'Revisión necesaria', auth:'Iniciar sesión', error:'Error', canceled:'Cancelado' };
const materialLabels = {
  planned: 'Planeado',
  queued: 'En cola',
  submitting: 'Enviando a Google',
  remote_pending: 'Google procesando',
  download_pending: 'Descarga pendiente',
  downloading: 'Descargando',
  ready: 'Listo',
  waiting_quota: 'Esperando cuota',
  waiting_auth: 'Esperando sesión',
  retry_wait: 'Reintentando',
  review_required: 'Revisión requerida',
  failed: 'Fallido',
  canceled: 'Cancelado'
};
const editorialLabels = {
  unreviewed: 'Sin revisar',
  approved: 'Aprobado',
  rejected: 'Rechazado'
};
let token, books = [], selected = localStorage.getItem('selected-book'), uploading = false, lastRender = '', refreshing = false;
let createRequest = crypto.randomUUID();
let accountData = { accounts: [] }, accountStamp = '', backupStamp = '', savingBackups = false;
let viewingExplorer = false, remoteBooks = [], selectedRemoteId = null, remoteDetail = null, selectedArtifacts = new Set(), explorerProfile = null, explorerSeq = 0;
let currentCatalog = null, selectedCatalogSources = new Set(), selectedCatalogArtifacts = new Set(), activeCatalogTab = 'artifacts', pendingDeleteTarget = null;
let recipes = [], activeViewTab = 'matrix', currentMatrix = null, currentPlanPreview = null;
let librarySearchQuery = '', libraryPage = 1, libraryTotal = 0, searchDebounce = null;
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
  if (h.appVersion) $('app-version').textContent = `BloqueAudio ${h.appVersion} · ${h.mode === 'development' ? 'Desarrollo' : 'Distribución'}`;
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
      const targetProfile = remoteDetail.profile || explorerProfile;
      const localBook = books.find(b => (b.remoteId === selectedRemoteId && b.profile === targetProfile) || (remoteDetail.localBookId && b.id === remoteDetail.localBookId));
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
    if (!recipes.length) loadRecipes();
    if (!viewingExplorer && selected) {
      if (!currentCatalog || currentCatalog.bookId !== selected) {
        loadCatalog(selected);
      }
      loadMatrix(selected);
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
    const emailLabel = a.email ? `Identidad: ${a.email}` : 'Identidad no verificada';
    const quotaLabel = remaining.length ? `Cuota mínima restante: ${Math.min(...remaining)}%` : (isLoggingIn ? '' : 'Cuota: no disponible (desconocida)');
    card.append(el('strong', {}, `${a.id}${a.id === accountData.current ? ' · Para nuevos libros' : ''}`),
      el('small', {}, emailLabel),
      el('small', {}, `${status} · ${quotaLabel}`));
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
function choose(id) {
  viewingExplorer = false;
  selected = id;
  localStorage.setItem('selected-book', id);
  lastRender = '';
  render();
  loadCatalog(id);
  loadMatrix(id);
}

async function openExplorer() {
  viewingExplorer = true; lastRender = ''; render();
  await loadRemoteBooks();
}
function closeExplorer() {
  viewingExplorer = false; if (!selected && books.length) selected = books[0].id;
  lastRender = ''; render();
  if (selected) loadCatalog(selected);
}
async function loadRemoteBooks() {
  const profile = $('explorer-profile')?.value || explorerProfile || accountData.current || 'default';
  explorerProfile = profile;
  const seq = ++explorerSeq;
  selectedRemoteId = null;
  remoteDetail = null;
  selectedArtifacts.clear();
  $('remote-detail-empty').hidden = false;
  $('remote-detail').hidden = true;
  notice(`Cargando lista de cuadernos desde NotebookLM (${profile})…`);
  try {
    const list = await api(`/api/remote/notebooks?profile=${encodeURIComponent(profile)}`);
    if (seq !== explorerSeq || explorerProfile !== profile) return;
    remoteBooks = list;
    notice(`Se encontraron ${remoteBooks.length} cuadernos en la cuenta ${profile}.`);
    renderRemoteBooks();
  } catch(e) {
    if (seq !== explorerSeq || explorerProfile !== profile) return;
    notice(`Error al listar cuadernos: ${e.message}`, true);
  }
}
function renderRemoteBooks() {
  const list = $('remote-books');
  if (!remoteBooks.length) {
    list.replaceChildren(el('div', { class: 'remote-empty-state' }, 'No hay cuadernos disponibles en esta cuenta.'));
    return;
  }
  const curProfile = explorerProfile || 'default';
  list.replaceChildren(...remoteBooks.map(b => {
    const item = el('button', {
      class: `remote-book-item${b.id === selectedRemoteId ? ' active' : ''}`,
      onclick: () => selectRemoteBook(b.id)
    }, b.title);
    item.append(el('small', { class: 'account-tag' }, `Cuenta: ${curProfile}`));
    const localBook = books.find(lb => lb.remoteId === b.id && lb.profile === curProfile);
    if (localBook) {
      item.append(el('small', { style: 'color: #166534; font-weight: 600;' }, localBook.lastSyncedAt ? `Sincronizado (${date(localBook.lastSyncedAt)})` : 'Sincronizado'));
    } else {
      item.append(el('small', {}, 'No sincronizado en biblioteca'));
    }
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
  const seq = ++explorerSeq;
  selectedArtifacts.clear();
  notice(`Consultando audios del cuaderno seleccionado (${profile})…`);
  try {
    const detail = await api(`/api/remote/notebooks/${encodeURIComponent(id)}?profile=${encodeURIComponent(profile)}`);
    if (seq !== explorerSeq || explorerProfile !== profile || selectedRemoteId !== id) return;
    remoteDetail = detail;
    const bookTitle = remoteDetail.title || remoteBooks.find(b => b.id === id)?.title || 'Cuaderno';
    $('remote-book-title').textContent = `${bookTitle} (${profile})`;
    $('remote-book-link').href = `https://notebooklm.google.com/notebook/${encodeURIComponent(id)}`;

    const existingSyncBtn = $('explorer-sync-book-btn');
    if (existingSyncBtn) existingSyncBtn.remove();
    const syncBtn = el('button', {
      id: 'explorer-sync-book-btn',
      class: 'quiet link-button',
      type: 'button',
      onclick: () => act(async () => {
        notice(`Sincronizando «${bookTitle}» con la biblioteca local…`);
        const res = await api(`/api/remote/notebooks/${encodeURIComponent(id)}/sync`, {
          method: 'POST',
          data: { profile }
        });
        notice('Cuaderno sincronizado.');
        viewingExplorer = false;
        choose(res.bookId);
      })
    }, '🔄 Sincronizar con biblioteca');
    $('remote-book-link').after(syncBtn);

    selectedArtifacts = new Set((remoteDetail.artifacts || []).map(a => a.id));
    $('remote-detail-empty').hidden = true;
    $('remote-detail').hidden = false;
    renderRemoteDetail();
    notice('');
  } catch (e) {
    if (seq !== explorerSeq || explorerProfile !== profile) return;
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
  const stamp = JSON.stringify({ books, selected, uploading, viewingExplorer, profiles: accountData.accounts.map(a => [a.id, a.email]), librarySearchQuery, libraryPage, activeViewTab });
  if (stamp === lastRender) return;
  lastRender = stamp;

  const filteredBooks = books.filter(b => {
    if (!librarySearchQuery) return true;
    const q = librarySearchQuery.toLowerCase();
    return (b.title && b.title.toLowerCase().includes(q)) || (b.profile && b.profile.toLowerCase().includes(q));
  });
  const pageSize = 8;
  libraryTotal = filteredBooks.length;
  const maxPage = Math.max(1, Math.ceil(libraryTotal / pageSize));
  if (libraryPage > maxPage) libraryPage = maxPage;
  const pagedBooks = filteredBooks.slice((libraryPage - 1) * pageSize, libraryPage * pageSize);
  const pageIndicator = $('library-page-info') || $('library-page-indicator');
  if (pageIndicator) pageIndicator.textContent = `${libraryPage} de ${maxPage}`;
  if ($('library-pagination')) $('library-pagination').hidden = maxPage <= 1;
  if ($('library-prev-page')) $('library-prev-page').disabled = libraryPage <= 1;
  if ($('library-next-page')) $('library-next-page').disabled = libraryPage >= maxPage;

  $('library').replaceChildren(...pagedBooks.map(b => {
    const button = el('button',{class:`book-button${!viewingExplorer && b.id === selected ? ' active' : ''}`,onclick:()=>{ viewingExplorer=false; choose(b.id); }},b.title);
    button.append(el('small',{},`Cuenta: ${b.profile} · ${b.blocks.filter(x=>x.state === 'done').length} de ${b.blocks.length} audios listos`));
    return button;
  }));

  if (viewingExplorer) {
    $('welcome').hidden = true; $('workspace').hidden = true; $('explorer').hidden = false;
    $('current-title').textContent = 'Explorador de cuadernos';
    $('subtitle').textContent = 'Revisa tus libros de NotebookLM y descarga sus audios en lote con un clic.';
    $('remote-link').hidden = true;
    $('open-folder-btn').hidden = true;
    $('sync-content-btn').hidden = true;
    $('cancel-pending-btn').hidden = true;
    $('book-meta-info').hidden = true;
    $('catalog-section').hidden = true;
    return;
  }

  $('explorer').hidden = true;
  $('welcome').hidden = !!book; $('workspace').hidden = !book;
  $('current-title').textContent = book?.title || 'Del libro al podcast';
  $('subtitle').textContent = book ? 'Un podcast independiente por fuente, dentro del mismo libro.' : 'Una fuente. Un audio. Cada bloque conserva su lugar.';
  $('remote-link').hidden = !book?.url; if (book?.url) $('remote-link').href=book.url;
  $('open-folder-btn').hidden = !book;
  if (!book) {
    $('book-meta-info').hidden = true;
    $('sync-content-btn').hidden = true;
    $('cancel-pending-btn').hidden = true;
    $('catalog-section').hidden = true;
    $('material-metrics-bar').hidden = true;
    $('waiting-reason-box').hidden = true;
    return;
  }
  $('book-meta-info').hidden = false;
  $('book-account-badge').textContent = `Cuenta de acceso: ${book.profile}`;
  if (book.remoteRole) {
    $('book-role-badge').hidden = false;
    $('book-role-badge').textContent = `Rol: ${book.remoteRole}`;
  } else {
    $('book-role-badge').hidden = true;
  }
  $('book-sync-status').textContent = book.lastSyncedAt
    ? `Última sincronización: ${date(book.lastSyncedAt)}`
    : 'No sincronizado';
  $('sync-content-btn').hidden = !book.remoteId;
  $('cancel-pending-btn').hidden = !book.remoteId;
  renderBackups(book);
  renderRecipes();

  if (activeViewTab === 'matrix') {
    $('matrix-section').hidden = false;
    $('blocks-section').hidden = true;
    $('tab-view-matrix').className = 'tab-btn active';
    $('tab-view-blocks').className = 'tab-btn';
    renderMatrix();
  } else {
    $('matrix-section').hidden = true;
    $('blocks-section').hidden = false;
    $('tab-view-matrix').className = 'tab-btn';
    $('tab-view-blocks').className = 'tab-btn active';
  }

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
  if ($('generation-mode')) $('generation-mode').value = book.generation_mode || 'immediate';
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
    if (block.generation_mode === 'later' || block.state === 'deferred') state.append(el('span', { class: 'mode-tag' }, '⏳ Diferido'));
    if (block.generationProfile) state.append(el('div', { class: 'account-tag' }, `Cuenta: ${block.generationProfile}`));
    if (block.error) state.append(el('div',{class:'block-error'},block.error));
    if (block.nextAt) state.append(el('div',{class:'next-at'},`Próximo intento: ${date(block.nextAt)}`));
    if (['error','review','auth','quota'].includes(block.state)) state.append(el('button',{class:'quiet retry',onclick:()=>act(()=>api(`/api/blocks/${block.id}/retry`,{method:'POST'}))},block.state === 'review' ? 'Comprobar de nuevo' : block.errorCode === 'ARTIFACT_FAILED' ? 'Generar de nuevo' : 'Reintentar'));
    const audio=el('td');
    if (block.audioUrl) {
      const player=el('audio',{controls:true,preload:'none',src:block.audioUrl,'aria-label':`Audio del bloque ${block.number}`});
      audio.append(player,el('a',{class:'download-link',href:`${block.audioUrl}?download=1`,download:block.outputName},'Descargar MP3'));
    } else audio.append(el('span',{class:'audio-wait'},'Disponible al terminar'));

    const control = el('td');
    if (block.state !== 'done' && block.state !== 'canceled') {
      control.append(el('button', {
        class: 'quiet retry',
        onclick: () => act(async () => {
          const r = await api(`/api/blocks/${block.id}/cancel`, { method: 'POST' });
          notice(r.alreadyRemote
            ? 'Cancelado localmente. La generación remota puede continuar en Google.'
            : 'Cancelado localmente antes de enviar a Google.');
        })
      }, 'Cancelar este bloque'));
    }
    if (block.artifactId) {
      control.append(el('button', {
        class: 'quiet retry',
        style: 'color: #dc2626; margin-top: 4px;',
        onclick: () => openDeleteModal(book, block.artifactId, block.title)
      }, 'Eliminar de NotebookLM…'));
    }

    row.append(number,source,state,audio,control); return row;
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
$('explorer-profile').addEventListener('change', e => {
  explorerProfile = e.target.value;
  explorerSeq++;
  selectedRemoteId = null;
  remoteDetail = null;
  selectedArtifacts.clear();
  remoteBooks = [];
  renderRemoteBooks();
  $('remote-detail-empty').hidden = false;
  $('remote-detail').hidden = true;
  act(loadRemoteBooks);
});
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
$('generation-mode')?.addEventListener('change', () => {
  if (!selected) return;
  act(() => api(`/api/books/${selected}/mode`, { method: 'PATCH', data: { mode: $('generation-mode').value } }));
});
$('generate').addEventListener('click',()=>act(()=>api(`/api/books/${selected}/queue`,{method:'POST',data:{action:'start',mode:$('generation-mode')?.value || 'immediate'}})));
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
function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function openDeleteModal(book, artifactId, title) {
  pendingDeleteTarget = { book, artifactId, title };
  $('delete-modal-details').innerHTML = `
    <p><strong>Cuaderno:</strong> ${escapeHtml(book.title)}</p>
    <p><strong>Cuenta de acceso:</strong> ${escapeHtml(book.profile)}</p>
    <p><strong>Elemento:</strong> ${escapeHtml(title)}</p>
    <p><strong>ID de artefacto:</strong> <code>${escapeHtml(artifactId)}</code></p>
  `;
  $('delete-modal').showModal();
}

async function loadCatalog(bookId) {
  if (!bookId) {
    $('catalog-section').hidden = true;
    currentCatalog = null;
    return;
  }
  const book = books.find(b => b.id === bookId);
  if (!book?.remoteId) {
    $('catalog-section').hidden = true;
    currentCatalog = null;
    return;
  }
  try {
    const data = await api(`/api/books/${bookId}/catalog`);
    currentCatalog = data;
    renderCatalog();
  } catch (e) {
    currentCatalog = null;
    $('catalog-section').hidden = true;
  }
}

function renderCatalog() {
  if (!currentCatalog || !selected) {
    $('catalog-section').hidden = true;
    return;
  }
  const book = books.find(b => b.id === selected);
  if (!book || !book.remoteId) {
    $('catalog-section').hidden = true;
    return;
  }
  $('catalog-section').hidden = false;

  const artifacts = currentCatalog.artifacts || [];
  const sources = currentCatalog.sources || [];
  const notes = currentCatalog.notes || [];

  $('count-artifacts').textContent = artifacts.length;
  $('count-sources').textContent = sources.length;
  $('count-notes').textContent = notes.length;

  const artTbody = $('catalog-artifacts-list');
  const artEmpty = $('catalog-artifacts-empty');
  artEmpty.hidden = artifacts.length > 0;
  artTbody.hidden = artifacts.length === 0;

  $('select-all-artifacts').checked = artifacts.length > 0 && artifacts.every(a => selectedCatalogArtifacts.has(a.id));
  $('download-selected-artifacts-btn').disabled = selectedCatalogArtifacts.size === 0;
  $('download-selected-artifacts-btn').textContent = selectedCatalogArtifacts.size > 0
    ? `Descargar seleccionados (${selectedCatalogArtifacts.size})`
    : 'Descargar seleccionados';

  artTbody.replaceChildren(...artifacts.map(a => {
    const tr = el('tr');
    const tdCheck = el('td');
    const cb = el('input', { type: 'checkbox', checked: selectedCatalogArtifacts.has(a.id) });
    cb.addEventListener('change', () => {
      if (cb.checked) selectedCatalogArtifacts.add(a.id);
      else selectedCatalogArtifacts.delete(a.id);
      renderCatalog();
    });
    tdCheck.append(cb);

    const tdTitle = el('td');
    tdTitle.append(el('strong', {}, a.title || 'Sin título'));
    if (a.createdAt) tdTitle.append(el('small', { class: 'source-name' }, `Creado: ${date(a.createdAt)}`));

    const tdType = el('td');
    tdType.append(el('span', { class: `badge ${a.type}` }, a.type || 'desconocido'));

    const tdState = el('td');
    tdState.append(el('span', { class: `badge ${a.status === 'completed' || a.status === 'ready' ? 'done' : a.status === 'failed' ? 'error' : 'generating'}` },
      a.status === 'completed' || a.status === 'ready' ? 'Completado' : a.status === 'failed' ? 'Error' : 'Generando'));
    if (a.errorReason) tdState.append(el('div', { class: 'block-error' }, a.errorReason));

    const tdAction = el('td');
    const canDownload = ['completed', 'ready'].includes(a.status);
    if (canDownload) {
      tdAction.append(el('button', {
        class: 'quiet link-button',
        type: 'button',
        onclick: () => act(async () => {
          notice(`Solicitando descarga de «${a.title}»…`);
          await api(`/api/books/${book.id}/downloads`, {
            method: 'POST',
            data: { items: [{ itemId: a.id }] }
          });
          notice(`Descarga programada para «${a.title}».`);
        })
      }, 'Descargar'));
    }
    tdAction.append(el('button', {
      class: 'quiet retry',
      style: 'color: #dc2626; margin-top: 4px;',
      type: 'button',
      onclick: () => openDeleteModal(book, a.id, a.title)
    }, 'Eliminar de NotebookLM…'));

    tr.append(tdCheck, tdTitle, tdType, tdState, tdAction);
    return tr;
  }));

  const srcTbody = $('catalog-sources-list');
  const srcEmpty = $('catalog-sources-empty');
  srcEmpty.hidden = sources.length > 0;
  srcTbody.hidden = sources.length === 0;

  $('select-all-sources').checked = sources.length > 0 && sources.every(s => selectedCatalogSources.has(s.id));
  $('generate-from-sources-btn').disabled = selectedCatalogSources.size === 0;
  $('generate-from-sources-btn').textContent = selectedCatalogSources.size > 0
    ? `Generar audios de fuentes seleccionadas (${selectedCatalogSources.size})`
    : 'Generar audios de fuentes seleccionadas';

  srcTbody.replaceChildren(...sources.map(s => {
    const tr = el('tr');
    const tdCheck = el('td');
    const cb = el('input', { type: 'checkbox', checked: selectedCatalogSources.has(s.id) });
    cb.addEventListener('change', () => {
      if (cb.checked) selectedCatalogSources.add(s.id);
      else selectedCatalogSources.delete(s.id);
      renderCatalog();
    });
    tdCheck.append(cb);

    const tdTitle = el('td');
    tdTitle.append(el('strong', {}, s.title || 'Fuente'));

    const tdId = el('td');
    tdId.append(el('code', {}, s.id));

    const tdState = el('td');
    tdState.append(el('span', { class: `badge ${s.status === 2 || s.status === 'ready' ? 'done' : s.status === 3 ? 'error' : 'generating'}` },
      s.status === 2 || s.status === 'ready' ? 'Lista' : s.status === 3 ? 'Error' : 'Procesando'));

    tr.append(tdCheck, tdTitle, tdId, tdState);
    return tr;
  }));

  const notesTbody = $('catalog-notes-list');
  const notesEmpty = $('catalog-notes-empty');
  notesEmpty.hidden = notes.length > 0;
  notesTbody.hidden = notes.length === 0;

  notesTbody.replaceChildren(...notes.map(n => {
    const tr = el('tr');
    const tdTitle = el('td', {}, n.title || 'Nota');
    const tdId = el('td', {}, n.id || '—');
    const tdContent = el('td', {}, n.content ? (n.content.slice(0, 100) + (n.content.length > 100 ? '…' : '')) : '—');
    tr.append(tdTitle, tdId, tdContent);
    return tr;
  }));
}

$('sync-content-btn')?.addEventListener('click', () => {
  if (!selected) return;
  act(async () => {
    notice('Sincronizando catálogo con NotebookLM…');
    await api(`/api/books/${selected}/sync`, { method: 'POST' });
    notice('Catálogo sincronizado.');
    await loadCatalog(selected);
  });
});

$('cancel-pending-btn')?.addEventListener('click', () => {
  if (!selected) return;
  act(async () => {
    const res = await api(`/api/books/${selected}/cancel-pending`, { method: 'POST' });
    notice(res.message);
  });
});

$('tab-artifacts')?.addEventListener('click', () => {
  activeCatalogTab = 'artifacts';
  $('tab-artifacts').classList.add('active');
  $('tab-sources').classList.remove('active');
  $('tab-notes').classList.remove('active');
  $('catalog-pane-artifacts').hidden = false;
  $('catalog-pane-sources').hidden = true;
  $('catalog-pane-notes').hidden = true;
});
$('tab-sources')?.addEventListener('click', () => {
  activeCatalogTab = 'sources';
  $('tab-artifacts').classList.remove('active');
  $('tab-sources').classList.add('active');
  $('tab-notes').classList.remove('active');
  $('catalog-pane-artifacts').hidden = true;
  $('catalog-pane-sources').hidden = false;
  $('catalog-pane-notes').hidden = true;
});
$('tab-notes')?.addEventListener('click', () => {
  activeCatalogTab = 'notes';
  $('tab-artifacts').classList.remove('active');
  $('tab-sources').classList.remove('active');
  $('tab-notes').classList.add('active');
  $('catalog-pane-artifacts').hidden = true;
  $('catalog-pane-sources').hidden = true;
  $('catalog-pane-notes').hidden = false;
});

$('select-all-artifacts')?.addEventListener('change', (e) => {
  const artifacts = currentCatalog?.artifacts || [];
  if (e.target.checked) selectedCatalogArtifacts = new Set(artifacts.map(a => a.id));
  else selectedCatalogArtifacts.clear();
  renderCatalog();
});
$('download-selected-artifacts-btn')?.addEventListener('click', () => {
  if (!selected || !selectedCatalogArtifacts.size) return;
  act(async () => {
    notice(`Solicitando descarga de ${selectedCatalogArtifacts.size} contenidos…`);
    const items = [...selectedCatalogArtifacts].map(id => ({ itemId: id }));
    const res = await api(`/api/books/${selected}/downloads`, {
      method: 'POST',
      data: { items }
    });
    notice(`${res.accepted.length} descargas aceptadas.${res.rejected.length ? ` ${res.rejected.length} rechazadas.` : ''}`);
    selectedCatalogArtifacts.clear();
    renderCatalog();
  });
});

$('select-all-sources')?.addEventListener('change', (e) => {
  const sources = currentCatalog?.sources || [];
  if (e.target.checked) selectedCatalogSources = new Set(sources.map(s => s.id));
  else selectedCatalogSources.clear();
  renderCatalog();
});
$('generate-from-sources-btn')?.addEventListener('click', () => {
  if (!selected || !selectedCatalogSources.size) return;
  act(async () => {
    notice(`Generando audios para ${selectedCatalogSources.size} fuentes seleccionadas…`);
    const sourceIds = [...selectedCatalogSources];
    const res = await api(`/api/books/${selected}/generations`, {
      method: 'POST',
      data: { sourceIds, mode: $('generation-mode')?.value || 'immediate' }
    });
    notice(`${res.queued.length} bloques añadidos a la cola de generación.`);
    selectedCatalogSources.clear();
    renderCatalog();
  });
});

$('delete-modal-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('delete-modal').close();
  if (!pendingDeleteTarget) return;
  const { book, artifactId, title } = pendingDeleteTarget;
  pendingDeleteTarget = null;
  notice(`Solicitando eliminación de «${title}» de NotebookLM…`);
  try {
    const res = await api(`/api/books/${book.id}/artifacts/${encodeURIComponent(artifactId)}/delete`, {
      method: 'POST',
      data: { confirm: true, requestId: crypto.randomUUID() }
    });
    if (res.status === 'confirmed') {
      notice(`«${title}» eliminado de NotebookLM.`);
    } else {
      notice(`La solicitud de eliminación finalizó pero el estado remoto es incierto.`, true);
    }
    await refresh();
    if (book.id === selected) await loadCatalog(selected);
  } catch (err) {
    notice(`Error al eliminar: ${err.message}`, true);
  }
});
$('delete-modal-cancel')?.addEventListener('click', () => {
  pendingDeleteTarget = null;
  $('delete-modal').close();
});

async function loadRecipes() {
  try {
    const res = await api('/api/recipes');
    recipes = res.recipes || [];
    renderRecipes();
  } catch (e) {
    console.error('Error cargando recetas:', e);
  }
}

function renderRecipes() {
  const sel = $('recipe-selector');
  if (!sel) return;
  const currentVal = sel.value;
  sel.replaceChildren(...recipes.map(r => {
    const opt = el('option', { value: r.id }, `${r.name} (v${r.version || 1})`);
    return opt;
  }));
  if (currentVal && recipes.some(r => r.id === currentVal)) {
    sel.value = currentVal;
  }
  const hasBook = !!selected;
  if ($('prepare-plan-btn')) $('prepare-plan-btn').disabled = !hasBook || !recipes.length;
}

async function loadMatrix(bookId) {
  if (!bookId) {
    currentMatrix = null;
    return;
  }
  try {
    const data = await api(`/api/books/${bookId}/matrix`);
    currentMatrix = data;
    renderMatrix();
  } catch (e) {
    currentMatrix = null;
  }
}

function renderMatrix() {
  if (activeViewTab !== 'matrix' || !selected) return;
  const bar = $('material-metrics-bar');
  const reasonBox = $('waiting-reason-box');
  const tbody = $('matrix-body');
  const empty = $('empty-matrix');

  if (!currentMatrix || !currentMatrix.matrix || !currentMatrix.matrix.length) {
    if (empty) empty.hidden = false;
    if (tbody) tbody.replaceChildren();
    if (bar) bar.hidden = true;
    if (reasonBox) reasonBox.hidden = true;
    return;
  }

  if (empty) empty.hidden = true;
  if (bar) {
    bar.hidden = false;
    const s = currentMatrix.summary || {};
    $('metric-required').textContent = s.totalRequirements || 0;
    $('metric-ready').textContent = s.ready || 0;
    $('metric-approved').textContent = s.approved || 0;
    $('metric-waiting').textContent = s.waiting || 0;
    $('metric-outdated').textContent = s.outdated || 0;
    $('metric-issues').textContent = (s.failed || 0) + (s.reviewRequired || 0);
  }

  const book = books.find(b => b.id === selected);
  if (reasonBox) {
    const waitingReason = currentMatrix.waitingReason || (book?.quotaError ? `Esperando cuota en ${book.profile || 'cuenta principal'}: ${book.quotaError}` : null);
    if (waitingReason) {
      reasonBox.hidden = false;
      reasonBox.textContent = `⏳ ${waitingReason}`;
    } else {
      reasonBox.hidden = true;
    }
  }

  tbody.replaceChildren(...currentMatrix.matrix.map(row => {
    const tr = el('tr');
    tr.dataset.blockId = row.blockId;

    const tdNum = el('td', {}, el('span', { class: 'number' }, String(row.blockNumber).padStart(2, '0')));
    const tdTitle = el('td');
    tdTitle.append(el('strong', {}, row.title || `Bloque ${row.blockNumber}`));
    if (row.sourceId) tdTitle.append(el('div', { class: 'source-name' }, `Fuente: ${row.sourceId}`));

    const tdAudio = el('td');
    tdAudio.append(renderMaterialCell(row.materials?.audio, row, 'audio'));

    const tdInfo = el('td');
    tdInfo.append(renderMaterialCell(row.materials?.infographic, row, 'infographic'));

    tr.append(tdNum, tdTitle, tdAudio, tdInfo);
    return tr;
  }));
}

function renderMaterialCell(mat, row, kind) {
  const container = el('div', { class: 'material-cell' });
  if (!mat) {
    container.append(el('span', { class: 'muted' }, '—'));
    return container;
  }

  const badgeRow = el('div', { class: 'badge-row' });
  const isPulsing = ['submitting', 'remote_pending', 'download_pending', 'downloading'].includes(mat.state);
  const stBadge = el('span', { class: `badge ${mat.state}${isPulsing ? ' active-pulse' : ''}` });
  if (isPulsing) {
    stBadge.append(el('span', { class: 'mini-dot' }), document.createTextNode(` ${materialLabels[mat.state] || mat.state}…`));
  } else {
    stBadge.textContent = materialLabels[mat.state] || mat.state;
  }
  badgeRow.append(stBadge);

  if (mat.editorial_state) {
    const edBadge = el('span', { class: `editorial-badge ${mat.editorial_state}` }, editorialLabels[mat.editorial_state] || mat.editorial_state);
    badgeRow.append(edBadge);
  }
  container.append(badgeRow);

  if (mat.assigned_profile) {
    container.append(el('small', { class: 'account-tag' }, `Cuenta: ${mat.assigned_profile}`));
  }

  if (mat.error_reason) {
    container.append(el('div', { class: 'block-error' }, mat.error_reason));
  }

  if (mat.state === 'ready') {
    if (kind === 'audio' && mat.output_path) {
      const audioUrl = `/api/downloads/${mat.download_job_id || mat.id}/file`;
      container.append(el('audio', { controls: true, preload: 'none', src: audioUrl }));
    } else if (kind === 'infographic' && mat.output_path) {
      const imgUrl = `/api/downloads/${mat.download_job_id || mat.id}/file`;
      const imgLink = el('a', { href: `${imgUrl}?download=1`, target: '_blank', class: 'download-link' }, '👁️ Ver infografía (PNG)');
      container.append(imgLink);
    }
  }

  const actions = el('div', { class: 'cell-actions' });
  if (mat.state === 'ready') {
    if (mat.editorial_state !== 'approved') {
      actions.append(el('button', {
        class: 'quiet link-button action-btn',
        onclick: () => act(async () => {
          await api(`/api/materials/${mat.id}/action`, { method: 'POST', data: { action: 'approve' } });
          notice('Material aprobado.');
          await loadMatrix(selected);
        })
      }, 'Aprobar'));
    }
    if (mat.editorial_state !== 'rejected') {
      actions.append(el('button', {
        class: 'quiet retry action-btn',
        onclick: () => act(async () => {
          await api(`/api/materials/${mat.id}/action`, { method: 'POST', data: { action: 'reject' } });
          notice('Material rechazado.');
          await loadMatrix(selected);
        })
      }, 'Rechazar'));
    }
  }

  if (['failed', 'review_required'].includes(mat.state) || mat.editorial_state === 'rejected') {
    actions.append(el('button', {
      class: 'quiet retry action-btn',
      onclick: () => act(async () => {
        await api(`/api/materials/${mat.id}/action`, { method: 'POST', data: { action: 'retry' } });
        notice('Reintento solicitado.');
        await loadMatrix(selected);
      })
    }, 'Reintentar'));
  }

  if (mat.editorial_state === 'rejected' || mat.state === 'ready') {
    actions.append(el('button', {
      class: 'quiet link-button action-btn',
      onclick: () => act(async () => {
        await api(`/api/materials/${mat.id}/action`, { method: 'POST', data: { action: 'revision' } });
        notice('Nueva revisión creada.');
        await loadMatrix(selected);
      })
    }, 'Nueva revisión'));
  }

  if (!['ready', 'failed', 'canceled'].includes(mat.state)) {
    actions.append(el('button', {
      class: 'quiet retry action-btn',
      onclick: () => act(async () => {
        await api(`/api/materials/${mat.id}/action`, { method: 'POST', data: { action: 'cancel' } });
        notice('Tarea cancelada.');
        await loadMatrix(selected);
      })
    }, 'Cancelar'));
  }

  if (actions.children.length) container.append(actions);
  return container;
}

async function openPlanPreview() {
  if (!selected) return;
  const recipeId = $('recipe-selector')?.value || 'study-book';
  notice('Calculando plan de producción multimodal…');
  try {
    const plan = await api(`/api/books/${selected}/plan/preview`, {
      method: 'POST',
      data: { recipeId }
    });
    currentPlanPreview = plan;
    renderPlanModal(plan);
    $('plan-modal').showModal();
    notice('');
  } catch (e) {
    notice(`Error al calcular plan: ${e.message}`, true);
  }
}

function renderPlanModal(plan) {
  const summaryEl = $('plan-modal-summary');
  const detailsEl = $('plan-modal-details');
  if (!summaryEl || !detailsEl) return;

  const s = plan.summary || {};
  summaryEl.innerHTML = `
    <div class="summary-card"><strong>${escapeHtml(plan.recipe?.name || 'Receta')}</strong><small>Receta seleccionada</small></div>
    <div class="summary-card"><strong>${s.total || 0}</strong><small>Total tareas estimadas</small></div>
    <div class="summary-card"><strong>${s.audio || 0}</strong><small>Audios a planear</small></div>
    <div class="summary-card"><strong>${s.infographic || 0}</strong><small>Infografías a planear</small></div>
    <div class="summary-card"><strong>${s.existing || 0}</strong><small>Ya existentes (omitidas)</small></div>
  `;

  const tasks = plan.tasks || [];
  if (!tasks.length) {
    detailsEl.innerHTML = '<p class="muted">Todos los materiales requeridos para los bloques existentes ya están planificados o completados.</p>';
  } else {
    detailsEl.innerHTML = `
      <p><strong>Hash de sincronización canónico:</strong> <code>${escapeHtml(plan.canonicalHash)}</code></p>
      <div class="table-wrap" style="max-height: 240px; overflow-y: auto;">
        <table>
          <thead>
            <tr><th>#</th><th>Material</th><th>Título del bloque</th><th>Motivo</th></tr>
          </thead>
          <tbody>
            ${tasks.map(t => `
              <tr>
                <td>${t.blockNumber}</td>
                <td><span class="badge ${t.kind}">${t.kind}</span></td>
                <td>${escapeHtml(t.title)}</td>
                <td><small>${escapeHtml(t.reason || 'Nuevo requisito')}</small></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }
}

async function confirmPlan() {
  if (!selected || !currentPlanPreview) return;
  $('plan-modal-confirm').disabled = true;
  notice('Confirmando plan de producción…');
  try {
    const res = await api(`/api/books/${selected}/plan/confirm`, {
      method: 'POST',
      data: {
        recipeId: currentPlanPreview.recipe?.id,
        recipeVersion: currentPlanPreview.recipe?.version,
        requestId: crypto.randomUUID()
      }
    });
    $('plan-modal').close();
    notice(`Plan confirmado. ${res.createdCount || 0} nuevas tareas de material preparadas.`);
    currentPlanPreview = null;
    await refresh();
    await loadMatrix(selected);
  } catch (e) {
    notice(`Error al confirmar plan: ${e.message}`, true);
  } finally {
    $('plan-modal-confirm').disabled = false;
  }
}

$('prepare-plan-btn')?.addEventListener('click', openPlanPreview);
$('plan-modal-confirm')?.addEventListener('click', confirmPlan);
$('plan-modal-cancel')?.addEventListener('click', () => {
  $('plan-modal').close();
  currentPlanPreview = null;
});

$('tab-view-matrix')?.addEventListener('click', () => {
  activeViewTab = 'matrix';
  lastRender = '';
  render();
});
$('tab-view-blocks')?.addEventListener('click', () => {
  activeViewTab = 'blocks';
  lastRender = '';
  render();
});

$('library-search-input')?.addEventListener('input', e => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    librarySearchQuery = e.target.value.trim();
    libraryPage = 1;
    lastRender = '';
    render();
  }, 200);
});
$('library-prev-page')?.addEventListener('click', () => {
  if (libraryPage > 1) {
    libraryPage--;
    lastRender = '';
    render();
  }
});
$('library-next-page')?.addEventListener('click', () => {
  libraryPage++;
  lastRender = '';
  render();
});

refresh(); setInterval(refresh,2000);

function initDesktopUpdates() {
  if (!window.desktop) return;
  const banner = $('desktop-update-banner');
  const text = $('update-banner-text');
  const btn = $('update-install-button');
  if (!banner || !text || !btn) return;

  function renderUpdateState(state) {
    if (!state || state.status === 'idle' || state.status === 'not-available') {
      banner.hidden = true;
      btn.hidden = true;
      return;
    }
    banner.hidden = false;
    if (state.status === 'checking') {
      text.textContent = 'Buscando actualización…';
      btn.hidden = true;
    } else if (state.status === 'available') {
      text.textContent = `Actualización ${state.version || ''} disponible…`;
      btn.hidden = true;
    } else if (state.status === 'downloading') {
      text.textContent = `Descargando ${state.version || ''} — ${state.percent || 0} %`;
      btn.hidden = true;
    } else if (state.status === 'downloaded') {
      text.textContent = `Actualización ${state.version || ''} lista`;
      btn.hidden = false;
    } else if (state.status === 'error') {
      text.textContent = `Error buscando actualización: ${state.error || 'Desconocido'}`;
      btn.hidden = true;
    }
  }

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Cerrando y aplicando…';
    try {
      await window.desktop.installUpdate();
    } catch (err) {
      alert(`Error al reiniciar: ${err.message}`);
      btn.disabled = false;
      btn.textContent = 'Reiniciar y actualizar';
    }
  });

  window.desktop.getUpdateState?.().then(renderUpdateState).catch(() => {});
  window.desktop.onUpdateState?.(renderUpdateState);
}
initDesktopUpdates();

