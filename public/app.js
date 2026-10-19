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
let token, books = [], selected = null, uploading = false, lastRender = '', refreshing = false;
try { selected = localStorage.getItem('selected-book'); } catch (_) {}
let createRequest = crypto.randomUUID();
let accountData = { accounts: [] }, accountStamp = '', backupStamp = '', savingBackups = false;
let viewingExplorer = false, remoteBooks = [], selectedRemoteId = null, remoteDetail = null, selectedArtifacts = new Set(), explorerProfile = null, explorerSeq = 0;
let currentCatalog = null, selectedCatalogSources = new Set(), selectedCatalogArtifacts = new Set(), activeCatalogTab = 'artifacts', pendingDeleteTarget = null;
let catalogRequestSeq = 0, catalogLoadError = null, lastCatalogLoadTime = 0;
let lastCatalogRenderStamp = '';
let recipes = [], recipesLoaded = false, activeViewTab = 'matrix', currentMatrix = null, currentPlanPreview = null;
let matrixRequestSeq = 0, matrixPage = 1, planRequestId = null;
let librarySearchQuery = '', libraryPage = 1, libraryTotal = 0, searchDebounce = null;
let lastFocusedElement = null, lastDialogTrigger = null;
let refreshTimeout = null, consecutiveRefreshErrors = 0, refreshPending = false, refreshStopped = false, refreshPromise = null;
let recipesPromise = null;
const catalogLoads = new Map(), matrixLoads = new Map();
const timedReadControllers = new Set();
let planConfirming = false, planPreviewLoading = false;
let currentNoticeToast = null, noticeDismissTimer = null;
const persistentNotices = new Map();
const date = t => new Intl.DateTimeFormat('es-BO', { dateStyle:'medium', timeStyle:'short', timeZone:'America/La_Paz' }).format(t);
const safeDate = t => {
  if (!t) return '—';
  const n = typeof t === 'string' && /^\d+$/.test(t) ? Number(t) : t;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? '—' : date(d);
};

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

function notice(text, error = false, { persistent = false, source = 'operation' } = {}) {
  const legacyNotice = $('notice');
  if (legacyNotice) {
    legacyNotice.textContent = text || '';
    legacyNotice.className = error ? 'error' : '';
  }

  const container = $('notice-container');
  if (!container) return;

  if (!text) {
    if (source !== 'operation') {
      persistentNotices.get(source)?.remove();
      persistentNotices.delete(source);
      return;
    }
    if (currentNoticeToast && !currentNoticeToast.dataset.error && !currentNoticeToast.dataset.persistent) {
      if (noticeDismissTimer) { clearTimeout(noticeDismissTimer); noticeDismissTimer = null; }
      currentNoticeToast.remove();
      currentNoticeToast = null;
    }
    return;
  }

  const previous = (error || persistent) ? persistentNotices.get(source) : currentNoticeToast;
  if (previous && previous.dataset.message === text) {
    return;
  }

  if (!error && !persistent && noticeDismissTimer) {
    clearTimeout(noticeDismissTimer);
    noticeDismissTimer = null;
  }
  if (previous) {
    previous.remove();
  }

  const toast = el('div', { class: `notice-toast ${error ? 'error' : 'success'}` });
  toast.dataset.message = text;
  toast.dataset.error = error ? '1' : '';
  toast.dataset.persistent = persistent ? '1' : '';

  const content = el('div', { class: 'notice-toast-content' }, text);
  toast.append(content);

  const closeBtn = el('button', {
    type: 'button',
    class: 'notice-close-btn',
    'aria-label': 'Cerrar aviso',
    title: 'Cerrar aviso'
  }, '×');
  closeBtn.addEventListener('click', () => {
    if (currentNoticeToast === toast && noticeDismissTimer) { clearTimeout(noticeDismissTimer); noticeDismissTimer = null; }
    toast.remove();
    if (currentNoticeToast === toast) currentNoticeToast = null;
    if (persistentNotices.get(source) === toast) persistentNotices.delete(source);
  });
  toast.append(closeBtn);

  container.append(toast);
  if (error || persistent) persistentNotices.set(source, toast);
  else currentNoticeToast = toast;

  if (!error && !persistent) {
    const startTimer = () => {
      if (currentNoticeToast !== toast || toast.matches(':hover') || toast.contains(document.activeElement)) return;
      noticeDismissTimer = setTimeout(() => {
        noticeDismissTimer = null;
        if (currentNoticeToast === toast) {
          toast.remove();
          currentNoticeToast = null;
        }
      }, 6000);
    };
    startTimer();

    toast.addEventListener('mouseenter', () => {
      if (noticeDismissTimer) { clearTimeout(noticeDismissTimer); noticeDismissTimer = null; }
    });
    toast.addEventListener('mouseleave', () => {
      if (!noticeDismissTimer) startTimer();
    });
    toast.addEventListener('focusin', () => {
      if (noticeDismissTimer) { clearTimeout(noticeDismissTimer); noticeDismissTimer = null; }
    });
    toast.addEventListener('focusout', () => {
      if (!noticeDismissTimer) startTimer();
    });
  }
}

async function api(path, { method = 'GET', data, binary, timeout, signal } = {}) {
  let timer = null;
  let abortSignal = signal;
  let controller;
  if (timeout && timeout > 0) {
    controller = new AbortController();
    abortSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    timedReadControllers.add(controller);
    timer = setTimeout(() => controller.abort(new Error(`Timeout de red (${timeout}ms)`)), timeout);
  }
  try {
    const response = await fetch(path, {
      method,
      signal: abortSignal,
      headers: {
        ...(method !== 'GET' ? { 'X-Local-Token': token } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {})
      },
      body: binary || (data ? JSON.stringify(data) : undefined)
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'No se pudo completar la operación.');
    return value;
  } finally {
    if (timer) clearTimeout(timer);
    if (controller) timedReadControllers.delete(controller);
  }
}

async function act(fn) {
  try {
    await fn();
    if (typeof scheduleImmediateRefresh === 'function') {
      scheduleImmediateRefresh();
    } else {
      await refresh();
    }
  } catch(e) {
    notice(e.message, true);
  }
}

// --- Studio Player Console Controller ---
const STUDIO_STORAGE_KEY = 'bloqueaudio_studio_player_v1';
const VALID_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];

function formatStudioTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const sStr = String(s).padStart(2, '0');
  if (m < 60) {
    return `${String(m).padStart(2, '0')}:${sStr}`;
  }
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}:${String(remM).padStart(2, '0')}:${sStr}`;
}

const studioPlayer = {
  audio: null,
  container: null,
  currentTrack: null,
  loadSeq: 0,
  isDraggingProgress: false,
  lastAudibleVolume: 1,
  saveDebounceTimer: null,
  initialized: false,

  init() {
    if (this.initialized) return;
    this.container = $('studio-player');
    this.audio = $('studio-audio');
    if (!this.container || !this.audio) return;
    this.initialized = true;

    this.loadPreferences();
    this.wireAudioEvents();
    this.wireUIEvents();
    this.wireKeyboardShortcuts();
  },

  loadPreferences() {
    try {
      const raw = localStorage.getItem(STUDIO_STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        const rate = parseFloat(data.playbackRate);
        if (VALID_RATES.includes(rate)) {
          this.audio.playbackRate = rate;
          this.audio.preservesPitch = true;
          const select = $('player-rate-select');
          if (select) select.value = String(rate);
        }
        const vol = parseFloat(data.volume);
        if (Number.isFinite(vol) && vol >= 0 && vol <= 1) {
          this.audio.volume = vol;
          if (vol > 0) this.lastAudibleVolume = vol;
          const slider = $('player-volume-slider');
          if (slider) slider.value = String(vol);
        }
        if (data.muted !== undefined) {
          this.audio.muted = !!data.muted;
        }
      }
    } catch (e) {
      console.warn('Error reading player preferences:', e);
    }
  },

  savePreferences(updates = {}) {
    try {
      const raw = localStorage.getItem(STUDIO_STORAGE_KEY);
      let data = {};
      if (raw) {
        try { data = JSON.parse(raw); } catch (_) {}
      }
      if (!data || typeof data !== 'object') data = {};
      data.version = 1;
      data.playbackRate = this.audio ? this.audio.playbackRate : 1;
      data.volume = this.audio ? this.audio.volume : 1;
      data.muted = this.audio ? this.audio.muted : false;
      Object.assign(data, updates);
      localStorage.setItem(STUDIO_STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('Error writing player preferences:', e);
    }
  },

  getTrackStorageKey(track = this.currentTrack) {
    if (!track) return null;
    const account = accountData?.current || 'default';
    const bookId = track.bookId || selected || 'unknown';
    const blockId = track.blockId || 'unknown';
    const rev = track.sourceFingerprint || track.revision || 'v1';
    return `${account}:${bookId}:${blockId}:${rev}`;
  },

  getSavedTrackPosition(track = this.currentTrack) {
    const key = this.getTrackStorageKey(track);
    if (!key) return null;
    try {
      const raw = localStorage.getItem(STUDIO_STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      const entry = data?.tracks?.[key];
      if (entry && Number.isFinite(entry.position)) {
        return entry.position;
      }
    } catch (_) {}
    return null;
  },

  saveTrackPosition(track = this.currentTrack, position = this.audio?.currentTime) {
    if (!track || !Number.isFinite(position) || !this.audio) return;
    const key = this.getTrackStorageKey(track);
    if (!key) return;
    try {
      const raw = localStorage.getItem(STUDIO_STORAGE_KEY);
      let data = {};
      if (raw) {
        try { data = JSON.parse(raw); } catch (_) {}
      }
      if (!data || typeof data !== 'object') data = {};
      data.version = 1;
      data.playbackRate = this.audio.playbackRate;
      data.volume = this.audio.volume;
      data.muted = this.audio.muted;
      if (!data.tracks || typeof data.tracks !== 'object') data.tracks = {};

      data.tracks[key] = {
        position: Math.max(0, position),
        duration: Number.isFinite(this.audio.duration) ? this.audio.duration : null,
        updatedAt: Date.now()
      };

      const entries = Object.entries(data.tracks);
      if (entries.length > 100) {
        entries.sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
        data.tracks = Object.fromEntries(entries.slice(0, 100));
      }

      localStorage.setItem(STUDIO_STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('Error saving track position:', e);
    }
  },

  queueThrottledPositionSave() {
    if (this.saveDebounceTimer) return;
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = null;
      this.saveTrackPosition();
    }, 2500);
  },

  updateBufferBar() {
    const bar = $('player-buffer-bar');
    if (!bar) return;
    const audio = this.audio;
    if (!audio || audio.error || !Number.isFinite(audio.duration) || audio.duration <= 0 || !audio.buffered || audio.buffered.length === 0) {
      bar.style.background = 'transparent';
      return;
    }
    const dur = audio.duration;
    const ranges = [];
    for (let i = 0; i < audio.buffered.length; i++) {
      const start = Math.max(0, Math.min(100, (audio.buffered.start(i) / dur) * 100));
      const end = Math.max(0, Math.min(100, (audio.buffered.end(i) / dur) * 100));
      if (end > start) {
        ranges.push({ start, end });
      }
    }
    if (!ranges.length) {
      bar.style.background = 'transparent';
      return;
    }
    const parts = [];
    let last = 0;
    const bufColor = 'rgba(150, 140, 190, 0.45)';
    for (const r of ranges) {
      if (r.start > last) {
        parts.push(`transparent ${last}%`, `transparent ${r.start}%`);
      }
      parts.push(`${bufColor} ${r.start}%`, `${bufColor} ${r.end}%`);
      last = r.end;
    }
    if (last < 100) {
      parts.push(`transparent ${last}%`, `transparent 100%`);
    }
    bar.style.background = `linear-gradient(to right, ${parts.join(', ')})`;
  },

  wireAudioEvents() {
    const audio = this.audio;

    audio.addEventListener('play', () => {
      this.updateBadge('playing', 'Reproduciendo');
      this.updatePlayButton(true);
      this.syncRowIndicators();
    });

    audio.addEventListener('pause', () => {
      if (audio.ended) return;
      this.updateBadge('paused', 'En pausa');
      this.updatePlayButton(false);
      this.saveTrackPosition();
      this.syncRowIndicators();
    });

    audio.addEventListener('progress', () => {
      this.updateBufferBar();
    });
    audio.addEventListener('emptied', () => {
      $('player-buffer-bar')?.style.setProperty('background', 'transparent');
    });

    audio.addEventListener('seeking', () => {
      this.updateBufferBar();
    });

    audio.addEventListener('seeked', () => {
      this.updateBufferBar();
    });

    audio.addEventListener('timeupdate', () => {
      if (!this.isDraggingProgress) {
        const curr = audio.currentTime;
        const dur = audio.duration;
        const currEl = $('player-current-time');
        if (currEl) currEl.textContent = formatStudioTime(curr);
        const progress = $('player-progress');
        if (progress) {
          progress.value = curr;
          progress.setAttribute('aria-valuenow', Math.floor(curr));
          if (Number.isFinite(dur) && dur > 0) {
            progress.setAttribute('aria-valuetext', `${formatStudioTime(curr)} de ${formatStudioTime(dur)}`);
          }
        }
      }
      this.updateBufferBar();
      this.queueThrottledPositionSave();
    });

    audio.addEventListener('loadedmetadata', () => {
      this.updateBufferBar();
      const dur = audio.duration;
      const progress = $('player-progress');
      const durEl = $('player-duration');
      if (durEl) durEl.textContent = formatStudioTime(dur);

      if (progress && Number.isFinite(dur) && dur > 0) {
        progress.max = dur;
        progress.setAttribute('aria-valuemax', Math.floor(dur));
        progress.disabled = false;
        const backBtn = $('player-step-back');
        if (backBtn) backBtn.disabled = false;
        const fwdBtn = $('player-step-forward');
        if (fwdBtn) fwdBtn.disabled = false;
        const playBtn = $('player-play-btn');
        if (playBtn) playBtn.disabled = false;

        const savedPos = this.getSavedTrackPosition();
        if (Number.isFinite(savedPos) && savedPos > 0 && savedPos < dur - 1) {
          audio.currentTime = savedPos;
          const currEl = $('player-current-time');
          if (currEl) currEl.textContent = formatStudioTime(savedPos);
          progress.value = savedPos;
          progress.setAttribute('aria-valuenow', Math.floor(savedPos));
        } else {
          const currEl = $('player-current-time');
          if (currEl) currEl.textContent = formatStudioTime(audio.currentTime || 0);
        }
      }
    });

    audio.addEventListener('durationchange', () => {
      const dur = audio.duration;
      const durEl = $('player-duration');
      if (durEl) durEl.textContent = formatStudioTime(dur);
      const progress = $('player-progress');
      if (progress && Number.isFinite(dur) && dur > 0) {
        progress.max = dur;
        progress.setAttribute('aria-valuemax', Math.floor(dur));
        progress.disabled = false;
        const backBtn = $('player-step-back');
        if (backBtn) backBtn.disabled = false;
        const fwdBtn = $('player-step-forward');
        if (fwdBtn) fwdBtn.disabled = false;
      }
    });

    audio.addEventListener('waiting', () => {
      this.updateBadge('waiting', 'Esperando datos…');
    });

    audio.addEventListener('playing', () => {
      this.updateBadge('playing', 'Reproduciendo');
      this.updatePlayButton(true);
      const msg = $('player-message');
      if (msg) msg.hidden = true;
      const retry = $('player-retry-btn');
      if (retry) retry.hidden = true;
      this.syncRowIndicators();
    });

    audio.addEventListener('ended', () => {
      this.updateBadge('ended', 'Terminado');
      const playBtn = $('player-play-btn');
      if (playBtn) {
        playBtn.disabled = false;
        playBtn.setAttribute('aria-label', 'Reproducir de nuevo');
        playBtn.title = 'Reproducir de nuevo (Espacio)';
      }
      const icon = $('player-play-icon');
      if (icon) icon.textContent = '↺';
      const label = $('player-play-label');
      if (label) label.textContent = 'Reproducir de nuevo';
      this.saveTrackPosition(this.currentTrack, 0);
      this.syncRowIndicators();
    });

    audio.addEventListener('error', () => {
      this.updateBadge('error', 'Error');
      this.updateBufferBar();
      const msg = $('player-message');
      if (msg) {
        msg.textContent = 'No se pudo reproducir este audio.';
        msg.hidden = false;
      }
      const retry = $('player-retry-btn');
      if (retry) retry.hidden = false;
      const playBtn = $('player-play-btn');
      if (playBtn) playBtn.disabled = true;
      const progress = $('player-progress');
      if (progress) progress.disabled = true;
      const backBtn = $('player-step-back');
      if (backBtn) backBtn.disabled = true;
      const fwdBtn = $('player-step-forward');
      if (fwdBtn) fwdBtn.disabled = true;
      this.syncRowIndicators();
    });

    audio.addEventListener('ratechange', () => {
      const select = $('player-rate-select');
      if (select) select.value = String(audio.playbackRate);
      this.savePreferences();
    });

    audio.addEventListener('volumechange', () => {
      const vol = audio.volume;
      const isMuted = audio.muted || vol === 0;
      const slider = $('player-volume-slider');
      if (slider) {
        slider.value = String(vol);
        slider.setAttribute('aria-valuenow', Math.round(vol * 100));
      }
      const icon = $('player-volume-icon');
      if (icon) icon.textContent = isMuted ? '🔇' : '🔊';
      const muteBtn = $('player-mute-btn');
      if (muteBtn) {
        muteBtn.setAttribute('aria-label', isMuted ? 'Restaurar sonido' : 'Silenciar');
        muteBtn.title = isMuted ? 'Restaurar sonido' : 'Silenciar';
      }
      this.savePreferences();
    });
  },

  wireUIEvents() {
    $('player-play-btn')?.addEventListener('click', () => {
      this.togglePlay();
    });

    $('player-step-back')?.addEventListener('click', () => {
      this.seekBy(-15);
    });

    $('player-step-forward')?.addEventListener('click', () => {
      this.seekBy(15);
    });

    const progress = $('player-progress');
    if (progress) {
      progress.addEventListener('input', () => {
        this.isDraggingProgress = true;
        const val = Number(progress.value);
        const currEl = $('player-current-time');
        if (currEl) currEl.textContent = formatStudioTime(val);
      });

      progress.addEventListener('change', () => {
        const target = Number(progress.value);
        if (Number.isFinite(target) && Number.isFinite(this.audio.duration)) {
          this.audio.currentTime = Math.max(0, Math.min(target, this.audio.duration));
          this.saveTrackPosition();
        }
        this.isDraggingProgress = false;
      });

      progress.addEventListener('pointercancel', () => {
        this.isDraggingProgress = false;
      });
      progress.addEventListener('blur', () => {
        this.isDraggingProgress = false;
      });
    }

    $('player-rate-select')?.addEventListener('change', e => {
      const rate = parseFloat(e.target.value);
      if (VALID_RATES.includes(rate)) {
        this.audio.playbackRate = rate;
        this.audio.preservesPitch = true;
      }
    });

    const volSlider = $('player-volume-slider');
    if (volSlider) {
      volSlider.addEventListener('input', () => {
        const val = parseFloat(volSlider.value);
        if (Number.isFinite(val) && val >= 0 && val <= 1) {
          this.audio.volume = val;
          if (val > 0) {
            this.audio.muted = false;
            this.lastAudibleVolume = val;
          }
        }
      });
    }

    $('player-mute-btn')?.addEventListener('click', () => {
      this.toggleMute();
    });

    $('player-retry-btn')?.addEventListener('click', () => {
      if (!this.currentTrack) return;
      const msg = $('player-message');
      if (msg) msg.hidden = true;
      const retry = $('player-retry-btn');
      if (retry) retry.hidden = true;
      this.audio.load();
      this.audio.play().catch(err => {
        console.warn('Retry failed:', err);
      });
    });

    window.addEventListener('beforeunload', () => {
      this.saveTrackPosition();
    });
    window.addEventListener('pagehide', () => {
      this.saveTrackPosition();
    });
  },

  wireKeyboardShortcuts() {
    window.addEventListener('keydown', e => {
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
      if (!this.hasTrack()) return;
      if (document.querySelector('dialog[open]')) return;

      const target = e.target;
      const active = document.activeElement;
      const tag = (target?.tagName || '').toUpperCase();
      const activeTag = (active?.tagName || '').toUpperCase();
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable ||
                      activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT' || active?.isContentEditable;
      const isButton = tag === 'BUTTON' || (typeof target?.getAttribute === 'function' && target.getAttribute('role') === 'button') ||
                       activeTag === 'BUTTON' || (typeof active?.getAttribute === 'function' && active.getAttribute('role') === 'button');
      if (isInput || isButton || tag === 'A' || activeTag === 'A') return;

      if (e.code === 'Space' || e.key === ' ') {
        if (isInput) return;
        if (isButton) return;
        e.preventDefault();
        this.togglePlay();
        return;
      }

      if (e.code === 'ArrowLeft' || e.key === 'ArrowLeft') {
        if (isInput) return;
        e.preventDefault();
        this.seekBy(-15);
        return;
      }

      if (e.code === 'ArrowRight' || e.key === 'ArrowRight') {
        if (isInput) return;
        e.preventDefault();
        this.seekBy(15);
        return;
      }
    });
  },

  hasTrack() {
    return !!this.currentTrack;
  },

  isPaused() {
    return !this.audio || this.audio.paused;
  },

  isCurrentTrack(trackCandidate) {
    if (!this.currentTrack || !trackCandidate) return false;
    if (trackCandidate.audioUrl && this.currentTrack.audioUrl === trackCandidate.audioUrl) return true;
    if (trackCandidate.blockId && this.currentTrack.blockId === trackCandidate.blockId) return true;
    return false;
  },

  updateBadge(statusClass, text) {
    const badge = $('player-badge');
    if (!badge) return;
    badge.className = `player-badge ${statusClass}`;
    badge.textContent = text;
  },

  updatePlayButton(isPlaying) {
    const btn = $('player-play-btn');
    if (!btn) return;
    const icon = $('player-play-icon');
    const label = $('player-play-label');
    if (isPlaying) {
      if (icon) icon.textContent = '⏸';
      if (label) label.textContent = 'Pausar';
      btn.setAttribute('aria-label', 'Pausar');
      btn.title = 'Pausar (Espacio)';
    } else {
      if (icon) icon.textContent = '▶';
      if (label) label.textContent = 'Reproducir';
      btn.setAttribute('aria-label', 'Reproducir');
      btn.title = 'Reproducir (Espacio)';
    }
  },

  togglePlay() {
    if (!this.audio || !this.currentTrack) return;
    if (this.audio.ended) {
      this.audio.currentTime = 0;
      this.audio.play().catch(err => console.warn('Play ended error:', err));
    } else if (this.audio.paused) {
      this.audio.play().catch(err => console.warn('Play error:', err));
    } else {
      this.audio.pause();
    }
  },

  seekBy(delta) {
    if (!this.audio || !Number.isFinite(this.audio.duration) || this.audio.duration <= 0) return;
    const dur = this.audio.duration;
    const curr = Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0;
    const target = Math.max(0, Math.min(dur, curr + delta));
    this.audio.currentTime = target;
    this.saveTrackPosition();
  },

  toggleMute() {
    if (!this.audio) return;
    if (this.audio.muted || this.audio.volume === 0) {
      this.audio.muted = false;
      this.audio.volume = (this.lastAudibleVolume > 0 && this.lastAudibleVolume <= 1) ? this.lastAudibleVolume : 1;
    } else {
      if (this.audio.volume > 0) this.lastAudibleVolume = this.audio.volume;
      this.audio.muted = true;
    }
  },

  selectTrack(track) {
    this.init();
    if (!track || !track.audioUrl) return;

    if (this.isCurrentTrack(track)) {
      this.togglePlay();
      return;
    }

    if (this.currentTrack) {
      this.saveTrackPosition();
    }

    const thisLoadSeq = ++this.loadSeq;
    this.currentTrack = track;

    if (this.container) {
      this.container.hidden = false;
    }
    document.body.classList.add('has-studio-player');

    const titleEl = $('player-title');
    if (titleEl) {
      titleEl.textContent = `${track.number ? `Capítulo ${track.number}: ` : ''}${track.blockTitle || 'Audio'}`;
    }
    const bookEl = $('player-book');
    if (bookEl) {
      bookEl.textContent = track.bookTitle ? `· ${track.bookTitle}` : '';
    }
    this.updateBadge('loading', 'Cargando…');
    const msg = $('player-message');
    if (msg) msg.hidden = true;
    const retry = $('player-retry-btn');
    if (retry) retry.hidden = true;
    const revBtn = $('player-revision-btn');
    if (revBtn) revBtn.hidden = true;

    const dl = $('player-download-btn');
    if (dl) {
      dl.href = track.downloadUrl || `${track.audioUrl}?download=1`;
      dl.download = track.outputName || 'audio.mp3';
      dl.hidden = false;
    }

    const currEl = $('player-current-time');
    if (currEl) currEl.textContent = '--:--';
    const durEl = $('player-duration');
    if (durEl) durEl.textContent = '--:--';
    const progress = $('player-progress');
    if (progress) {
      progress.value = 0;
      progress.max = 0;
      progress.disabled = true;
    }
    $('player-buffer-bar')?.style.setProperty('background', 'transparent');
    const backBtn = $('player-step-back');
    if (backBtn) backBtn.disabled = true;
    const fwdBtn = $('player-step-forward');
    if (fwdBtn) fwdBtn.disabled = true;

    this.audio.src = track.audioUrl;
    this.audio.load();

    const playPromise = this.audio.play();
    if (playPromise !== undefined) {
      playPromise.catch(err => {
        if (this.loadSeq !== thisLoadSeq) {
          return;
        }
        if (err.name === 'AbortError') return;
        console.warn('Playback error:', err);
        this.updateBadge('error', 'Error');
        const msg = $('player-message');
        if (msg) {
          msg.textContent = 'No se pudo reproducir este audio.';
          msg.hidden = false;
        }
        const retry = $('player-retry-btn');
        if (retry) retry.hidden = false;
        this.syncRowIndicators();
      });
    }

    this.syncRowIndicators();
  },

  checkRevision(blockId, newFingerprint, newAudioUrl, newOutputName) {
    if (!this.currentTrack || this.currentTrack.blockId !== blockId) return;
    if (newFingerprint && this.currentTrack.sourceFingerprint && newFingerprint !== this.currentTrack.sourceFingerprint) {
      const msg = $('player-message');
      const revBtn = $('player-revision-btn');
      if (msg && revBtn) {
        msg.textContent = 'Hay una nueva versión de este audio.';
        msg.hidden = false;
        revBtn.hidden = false;
        revBtn.onclick = () => {
          this.selectTrack({
            ...this.currentTrack,
            sourceFingerprint: newFingerprint,
            audioUrl: newAudioUrl || this.currentTrack.audioUrl,
            downloadUrl: newAudioUrl ? `${newAudioUrl}?download=1` : this.currentTrack.downloadUrl,
            outputName: newOutputName || this.currentTrack.outputName
          });
        };
      }
    }
  },

  syncRowIndicators() {
    const isPlaying = this.audio && !this.audio.paused;
    const currentUrl = this.currentTrack?.audioUrl;
    const currentBlockId = this.currentTrack?.blockId;

    document.querySelectorAll('.audio-listen-btn').forEach(btn => {
      const btnUrl = btn.dataset.audioUrl;
      const btnBlockId = btn.dataset.blockId;
      const isMatch = (currentUrl && btnUrl === currentUrl) || (currentBlockId && btnBlockId === currentBlockId);

      btn.classList.toggle('is-active-track', isMatch);
      btn.textContent = (isMatch && isPlaying) ? 'Pausar' : 'Escuchar';
      btn.setAttribute('aria-label', `${(isMatch && isPlaying) ? 'Pausar' : 'Escuchar'} audio`);

      const tag = btn.parentElement?.querySelector('.audio-track-tag');
      if (tag) {
        tag.hidden = !isMatch;
        if (isMatch) {
          tag.className = `audio-track-tag ${isPlaying ? 'playing' : 'paused'}`;
          tag.textContent = isPlaying ? 'Sonando' : 'En pausa';
        }
      }
    });
  }
};

function showHealth(h) {
  if (h.token) token = h.token;
  if (h.appVersion) $('app-version').textContent = `BloqueAudio ${h.appVersion} · ${h.mode === 'development' ? 'Desarrollo' : 'Distribución'}`;
  $('health-label').textContent = h.error || (h.ready ? 'NotebookLM conectado' : 'Comprobando conexión…');
  $('profile-label').textContent = `Perfil: ${h.profile || 'default'}${h.version ? ` · ${h.version.replace('nlm version ','')}` : ''}`;
  $('login-hint').hidden = h.auth || !h.cli || h.errorCode !== 'AUTH_REQUIRED';
  $('login-hint').textContent = `nlm login -p ${h.profile || 'default'}`;
}
function hasPendingActivity() {
  if (uploading || accountData.loginProfile) return true;
  if (books.some(b => ['creating', 'upload_pending', 'uploading', 'source_processing', 'submitting', 'queued', 'generating', 'download', 'convert'].includes(b.state) ||
                      (b.running && (b.materialSummary?.pending > 0 || (b.blocks || []).some(bl => !['done', 'canceled', 'error', 'review', 'auth', 'quota'].includes(bl.state)))) ||
                      (b.blocks || []).some(bl => ['download', 'convert', 'generating', 'submitting', 'uploading', 'source_processing', 'queued'].includes(bl.state)))) {
    return true;
  }
  if (currentCatalog?.artifacts?.some(a => ['generating', 'queued', 'submitting', 'downloading'].includes(a.status))) {
    return true;
  }
  return false;
}

function getNextRefreshDelay() {
  if (consecutiveRefreshErrors > 0) {
    return Math.min(30000, 2000 * Math.pow(2, consecutiveRefreshErrors - 1));
  }
  if (typeof document !== 'undefined' && document.hidden) {
    return 30000;
  }
  if (hasPendingActivity()) {
    return 2000;
  }
  return 15000;
}

function scheduleNextRefresh(overrideDelay) {
  if (refreshTimeout) {
    clearTimeout(refreshTimeout);
    refreshTimeout = null;
  }
  if (refreshStopped) return;
  const delay = typeof overrideDelay === 'number' ? overrideDelay : getNextRefreshDelay();
  refreshTimeout = setTimeout(() => {
    refreshTimeout = null;
    refresh();
  }, delay);
}

function scheduleImmediateRefresh() {
  if (refreshStopped) return;
  if (refreshing) { refreshPending = true; return; }
  if (refreshTimeout) {
    clearTimeout(refreshTimeout);
    refreshTimeout = null;
  }
  refreshTimeout = setTimeout(() => {
    refreshTimeout = null;
    refresh();
  }, 30);
}

function refresh() {
  if (refreshStopped) return Promise.resolve();
  if (refreshing) { refreshPending = true; return refreshPromise; }
  if (refreshTimeout) { clearTimeout(refreshTimeout); refreshTimeout = null; }
  refreshing = true;
  refreshPromise = (async () => {
  try {
    const results = await Promise.allSettled(['/api/health', '/api/books', '/api/accounts'].map(path => api(path, { timeout: 15000 })));
    const failed = results.find(r => r.status === 'rejected');
    if (failed) throw failed.reason;
    const [health, current, profiles] = results.map(r => r.value);
    if (refreshStopped) return;
    consecutiveRefreshErrors = 0;
    notice('', false, { source: 'connection' });
    accountData = profiles; renderAccounts();
    showHealth(health); books = current;
    if (!viewingExplorer && !books.some(b=>b.id === selected)) choose(books[0]?.id);
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
    const reads = [];
    if (!recipesLoaded) reads.push(loadRecipes());
    if (!viewingExplorer && selected) {
      if (!currentCatalog || currentCatalog.bookId !== selected) {
        reads.push(loadCatalog(selected));
      } else if (hasPendingActivity() || Date.now() - lastCatalogLoadTime > 30000) {
        reads.push(loadCatalog(selected));
      }
      if (activeViewTab === 'matrix') {
        reads.push(loadMatrix(selected));
      }
    }
    render();
    await Promise.allSettled(reads);
  } catch(e) {
    if (refreshStopped) return;
    consecutiveRefreshErrors++;
    notice(`No se pudo conectar a la aplicación. ${e.message}`, true, { source: 'connection' });
  } finally {
    refreshing = false;
    const pending = refreshPending;
    refreshPending = false;
    scheduleNextRefresh(pending ? 0 : undefined);
  }
  })();
  return refreshPromise;
}
function renderAccounts() {
  const stamp = JSON.stringify(accountData);
  if (stamp === accountStamp) return;
  accountStamp = stamp;
  renderQuotaPreview();
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
function renderQuotaPreview() {
  const panel = $('quota-preview');
  if (!panel) return;
  const accounts = accountData.accounts || [];
  panel.hidden = !accounts.length;
  $('quota-preview-accounts').replaceChildren(...accounts.map(account => {
    const windows = account.health?.usage?.windows || [];
    const known = windows.length > 0 && windows.every(w => Number.isFinite(w.percent_remaining));
    const limited = account.errorCode === 'QUOTA';
    const remaining = known && !limited ? Math.max(0, Math.min(100, ...windows.map(w => w.percent_remaining))) : null;
    const value = limited ? 'En espera' : remaining === null ? 'Sin datos' : `${new Intl.NumberFormat('es-BO', { maximumFractionDigits: 1 }).format(remaining)}%`;
    const level = limited || remaining !== null && remaining < 20 ? 'low' : remaining === null ? 'unknown' : remaining < 50 ? 'medium' : 'high';
    const details = [account.id, account.email, !account.enabled ? 'Deshabilitada para la cola' : null,
      ...windows.map(w => `${w.window || 'Ventana'}: ${Number.isFinite(w.percent_remaining) ? `${w.percent_remaining}%` : 'sin datos'}${w.resets_at && Number.isFinite(Date.parse(w.resets_at)) ? ` · Se restablece: ${date(Date.parse(w.resets_at))}` : ''}`)
    ].filter(Boolean).join('\n');
    const row = el('div', { class: `quota-preview-row ${level}`, title: details, tabIndex: 0 });
    const bar = el('div', { class: 'quota-preview-track', role: 'progressbar', 'aria-label': `Cuota disponible de ${account.id}`,
      'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuetext': value });
    if (remaining !== null) bar.setAttribute('aria-valuenow', String(remaining));
    bar.append(el('span', { style: `width: ${remaining ?? 0}%` }));
    row.append(el('span', { class: 'quota-preview-name' }, account.id), bar, el('span', { class: 'quota-preview-value' }, value));
    return row;
  }));
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
  if (selected !== id) {
    currentMatrix = null;
    matrixPage = 1;
    currentPlanPreview = null;
    planRequestId = null;
    currentCatalog = null;
    selectedCatalogSources = new Set();
    selectedCatalogArtifacts = new Set();
    catalogRequestSeq++;
    matrixRequestSeq++;
    catalogLoadError = null;
  }
  selected = id;
  try {
    if (id) localStorage.setItem('selected-book', id);
    else localStorage.removeItem('selected-book');
  } catch (_) {}
  lastRender = '';
  render();
  loadCatalog(id);
  loadMatrix(id);
}

async function openExplorer() {
  lastFocusedElement = document.activeElement;
  viewingExplorer = true;
  catalogRequestSeq++;
  matrixRequestSeq++;
  renderCatalogStatus();
  lastRender = '';
  render();
  if (viewingExplorer) $('explorer-title')?.focus();
  await loadRemoteBooks();
}
function closeExplorer() {
  viewingExplorer = false;
  if (!selected && books.length) selected = books[0].id;
  lastRender = '';
  render();
  if (selected) loadCatalog(selected);
  if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
    lastFocusedElement.focus();
    lastFocusedElement = null;
  }
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
    try { localStorage.setItem('selected-book', selected); } catch (_) {}
    notice(`${artifactIds.length} audios añadidos a la cola. Se descargarán y convertirán a MP3 uno a uno.`);
    lastRender = '';
    await refresh();
  } catch (e) {
    notice(`Error al programar descargas: ${e.message}`, true);
  } finally {
    $('remote-download-btn').disabled = false;
  }
}

function bookProgress(book) {
  const multimodal = book.materialSummary?.nonAudio > 0;
  const total = multimodal ? book.materialSummary.total : book.blocks.length;
  const done = multimodal ? book.materialSummary.ready : book.blocks.filter(b => b.state === 'done').length;
  return { total, done, percent: total ? Math.round(done / total * 100) : 0, multimodal };
}

function getActiveStatus() {
  const selectedBook = books.find(b => b.id === selected);
  const processingBook = books.find(b => (b.blocks || []).some(bl => ['download', 'convert', 'generating', 'submitting', 'uploading', 'source_processing', 'queued'].includes(bl.state)));
  const runningBook = books.find(b => b.running && (b.materialSummary?.pending > 0 || (b.blocks || []).some(bl => bl.state !== 'done')));
  
  const book = processingBook || runningBook || selectedBook;
  if (!book || !book.blocks || !book.blocks.length) return null;
  
  const { total, done, percent, multimodal } = bookProgress(book);
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
      : 'Generando';
    action = `${book.title} · ${verb} audio ${activeBlock.number} de ${book.blocks.length}: «${activeBlock.title}»`;
    dotClass += ' active';
    isLive = true;
  } else if (book.quotaError || book.blocks.some(b => b.state === 'quota')) {
    action = `${book.title} · Esperando cuota (Generar más tarde) (${done} de ${total} listos)`;
    dotClass += ' waiting';
    isLive = true;
  } else if (done === total && total > 0) {
    action = multimodal ? `${book.title} · Todos los materiales completados (${total} listos)` : `${book.title} · Todos los audios completados (${total} MP3 listos)`;
    dotClass += ' done';
    isLive = false;
  } else if (book.running) {
    action = `${book.title} · Procesando cola (${done} de ${total} ${multimodal ? 'materiales ' : ''}listos)`;
    dotClass += ' active';
    isLive = true;
  } else {
    action = `${book.title} · ${done} de ${total} ${multimodal ? 'materiales' : 'audios'} listos`;
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
  const { done: doneCount, total: totalCount, percent, multimodal } = bookProgress(book);
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
      : 'Generando';
    actionText = `${verb} audio ${activeBlock.number} de ${book.blocks.length}: «${activeBlock.title}»`;
    pulseClass += ' active';
  } else if (book.quotaError || book.blocks.some(b => b.state === 'quota')) {
    actionText = `Esperando cuota (Generar más tarde) (${doneCount} de ${totalCount} listos)`;
    pulseClass += ' waiting';
  } else if (doneCount === totalCount && totalCount > 0) {
    actionText = multimodal ? `Todos los materiales completados (${totalCount} listos)` : `Todos los audios completados (${totalCount} MP3 listos)`;
    pulseClass += ' done';
  } else if (!book.running) {
    actionText = `Cola pausada (${doneCount} de ${totalCount} listos)`;
    pulseClass += ' paused';
  } else {
    actionText = `${doneCount} de ${totalCount} ${multimodal ? 'materiales' : 'audios'} listos`;
  }

  $('progress-label').textContent = actionText;
  $('progress-percent').textContent = `${percent}%`;
  $('progress-bar-fill').style.width = `${percent}%`;
  $('pulse-indicator').className = pulseClass;

  $('book-numbering').checked = book.numbering !== false;
  if ($('generation-mode')) $('generation-mode').value = book.generation_mode || 'immediate';
  $('generate').textContent = book.running ? 'Cola en marcha' : multimodal ? 'Iniciar producción pendiente' : book.blocks.some(b=>b.locked && b.state !== 'done') ? 'Reanudar pendientes' : 'Generar audios pendientes';
  $('generate').disabled = book.running || (book.blocks.every(b=>b.state === 'done') && !book.materialSummary?.pending) || !book.remoteId || uploading;
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
    const audio = el('td');
    if (block.audioUrl) {
      const isCurrent = studioPlayer.isCurrentTrack({ audioUrl: block.audioUrl, blockId: block.id });
      const isPlaying = isCurrent && !studioPlayer.isPaused();
      const listenBtn = el('button', {
        type: 'button',
        class: `action-btn audio-listen-btn${isCurrent ? ' is-active-track' : ''}`,
        'data-audio-url': block.audioUrl,
        'data-block-id': block.id,
        'aria-label': `${isPlaying ? 'Pausar' : 'Escuchar'} audio del bloque ${block.number}: ${block.title}`,
        onclick: () => {
          studioPlayer.selectTrack({
            bookId: book.id,
            bookTitle: book.title,
            blockId: block.id,
            blockTitle: block.title,
            number: String(block.number).padStart(2, '0'),
            sourceFingerprint: block.hash,
            audioUrl: block.audioUrl,
            downloadUrl: `${block.audioUrl}?download=1`,
            outputName: block.outputName || `${String(block.number).padStart(2, '0')} - ${block.title}.mp3`
          });
        }
      }, isPlaying ? 'Pausar' : 'Escuchar');

      const tag = el('span', {
        class: `audio-track-tag ${isPlaying ? 'playing' : 'paused'}`,
        hidden: !isCurrent
      }, isPlaying ? 'Sonando' : 'En pausa');

      audio.append(listenBtn, tag, el('a', { class: 'download-link', href: `${block.audioUrl}?download=1`, download: block.outputName }, 'Descargar MP3'));
    } else audio.append(el('span', { class: 'audio-wait' }, 'Disponible al terminar'));

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
  studioPlayer.syncRowIndicators();
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
    viewingExplorer = false; selected=book.id;
    try { localStorage.setItem('selected-book',selected); } catch (_) {}
    $('book-title').value=''; createRequest=crypto.randomUUID(); notice('Libro registrado. Se está creando en NotebookLM.');
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
function uploadFileWithProgress(url, file, authToken, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    if (authToken) {
      xhr.setRequestHeader('X-Local-Token', authToken);
    }
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Source-Filename', encodeURIComponent(file.name));

    if (xhr.upload && typeof onProgress === 'function') {
      xhr.upload.addEventListener('progress', e => {
        if (e.lengthComputable && e.total > 0) {
          const percent = Math.min(100, Math.round((e.loaded / e.total) * 100));
          onProgress(percent, e.loaded, e.total);
        } else onProgress(null);
      });
      xhr.upload.addEventListener('load', () => onProgress(100));
    }

    xhr.onload = () => {
      let data;
      try { data = JSON.parse(xhr.responseText); }
      catch (_) { reject(new Error('Respuesta JSON inválida al guardar el archivo.')); return; }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (!data || typeof data.id !== 'string' || !data.id) {
          reject(new Error('El servidor no confirmó el archivo guardado.'));
        } else resolve(data);
      } else {
        reject(new Error(data?.error || `Error ${xhr.status} al subir el archivo.`));
      }
    };

    xhr.onerror = () => reject(new Error('Error de red al subir el archivo.'));
    xhr.onabort = () => reject(new Error('Subida cancelada.'));
    xhr.send(file);
  });
}

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MiB (209715200 bytes)

async function addFiles(list) {
  if (uploading || !selected) return;
  const bookId = selected;
  const rawFiles = [...list].sort((a,b) => a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' }));
  if (!rawFiles.length) return;

  const validFiles = [];
  const rejectedFiles = [];

  for (const file of rawFiles) {
    if (!/\.(md|pdf)$/i.test(file.name)) {
      rejectedFiles.push({ file, reason: 'Formato no compatible (solo .md y .pdf).' });
      continue;
    }
    if (file.size === 0) {
      rejectedFiles.push({ file, reason: 'El archivo está vacío (0 bytes).' });
      continue;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      rejectedFiles.push({ file, reason: `El archivo supera el límite de 200 MiB (${(file.size / (1024 * 1024)).toFixed(1)} MiB).` });
      continue;
    }
    validFiles.push(file);
  }

  const card = $('upload-progress-card');
  const titleEl = $('upload-progress-title');
  const progressList = $('upload-progress-list');
  const rejectedCard = $('upload-rejected-card');
  const rejectedList = $('upload-rejected-list');

  if (rejectedFiles.length > 0) {
    if (rejectedCard && rejectedList) {
      rejectedCard.hidden = false;
      rejectedList.replaceChildren(...rejectedFiles.map(r => {
        const item = el('div', { class: 'upload-rejected-item' });
        item.append(
          el('span', { class: 'upload-file-name' }, r.file.name),
          el('span', { class: 'upload-reason' }, ` — ${r.reason}`)
        );
        return item;
      }));
    }
  } else if (rejectedCard) {
    rejectedCard.hidden = true;
  }

  if (!validFiles.length) {
    if (card) card.hidden = true;
    if ($('files')) $('files').value = '';
    notice(`No se subieron archivos. ${rejectedFiles.length} archivo(s) descartado(s) por validación.`, true);
    return;
  }

  uploading = true;
  render();

  if (card && progressList) {
    card.hidden = false;
    if (titleEl) titleEl.textContent = `Guardando ${validFiles.length} archivo(s) en «${books.find(b => b.id === bookId)?.title || bookId}»…`;
  }

  const rowEls = [];
  if (progressList) {
    progressList.replaceChildren(...validFiles.map((file, idx) => {
      const row = el('div', { class: 'upload-item-row' });
      row.dataset.fileName = file.name;
      const meta = el('div', { class: 'upload-item-meta' });
      meta.append(
        el('span', { class: 'upload-item-name' }, file.name),
        el('span', { class: 'upload-item-status' }, idx === 0 ? 'Iniciando…' : 'En espera…')
      );
      const barWrap = el('div', { class: 'upload-item-progress', role: 'progressbar', 'aria-label': `Transferencia local de ${file.name}`, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' });
      const fill = el('div', { class: 'upload-item-progress-fill' });
      barWrap.append(fill);
      row.append(meta, barWrap);
      rowEls.push({ row, meta, statusEl: meta.lastChild, fill, barWrap });
      return row;
    }));
  }

  let added = 0, duplicates = 0;
  const errors = [];

  try {
    for (let i = 0; i < validFiles.length; i++) {
      const file = validFiles[i];
      const ui = rowEls[i];
      if (ui) {
        ui.statusEl.textContent = 'Subiendo… 0%';
        ui.row.classList.add('uploading');
      }

      notice(`Subiendo archivo ${i + 1} de ${validFiles.length}: ${file.name}`);
      try {
        const uploadUrl = `/api/books/${bookId}/files?filename=${encodeURIComponent(file.name)}&requestId=${crypto.randomUUID()}`;
        const result = await uploadFileWithProgress(uploadUrl, file, token, (percent) => {
          if (ui) {
            ui.fill.style.width = `${percent ?? 0}%`;
            if (percent === null) ui.barWrap.removeAttribute('aria-valuenow');
            else ui.barWrap.setAttribute('aria-valuenow', String(percent));
            ui.statusEl.textContent = percent === 100 ? 'Confirmando guardado local…' : percent === null ? 'Transfiriendo…' : `Transfiriendo… ${percent}%`;
          }
        });

        if (result.duplicate || result.existing) duplicates++; else added++;
        if (ui) {
          ui.fill.style.width = '100%';
          ui.barWrap.setAttribute('aria-valuenow', '100');
          ui.row.classList.remove('uploading');
          if (result.duplicate || result.existing) {
            ui.row.classList.add('duplicate');
            ui.statusEl.textContent = 'Duplicado (omitido)';
          } else {
            ui.row.classList.add('done');
            ui.statusEl.textContent = 'Guardado localmente';
          }
        }
      } catch (err) {
        if (ui) {
          ui.row.classList.remove('uploading');
          ui.row.classList.add('error');
          ui.statusEl.textContent = `Error: ${err.message}`;
        }
        errors.push(`${file.name}: ${err.message}`);
      }
    }
  } finally {
    uploading = false;
    if ($('files')) $('files').value = '';
    lastRender = '';
    render();
    if (card && titleEl) {
      titleEl.textContent = `Carga finalizada: ${added} añadido(s)${duplicates ? `, ${duplicates} duplicado(s)` : ''}${errors.length ? `, ${errors.length} error(es)` : ''}.`;
    }
    notice(
      `${added} archivos añadidos.${duplicates ? ` ${duplicates} duplicados omitidos.` : ''}${rejectedFiles.length ? ` ${rejectedFiles.length} descartados.` : ''}${errors.length ? ` ${errors.join(' ')}` : ' Se cargarán automáticamente en NotebookLM.'}`,
      errors.length > 0
    );
    scheduleImmediateRefresh();
  }
}

$('upload-progress-close')?.addEventListener('click', () => {
  $('upload-progress-card').hidden = true;
});
$('files').addEventListener('change',event=>addFiles(event.target.files));
const drop=$('drop-zone');
for(const event of ['dragenter','dragover']) drop.addEventListener(event,e=>{e.preventDefault();drop.classList.add('dragging');});
for(const event of ['dragleave','drop']) drop.addEventListener(event,e=>{e.preventDefault();drop.classList.remove('dragging');});
drop.addEventListener('drop',event=>addFiles(event.dataTransfer.files));
function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function openDeleteModal(book, artifactId, title) {
  lastDialogTrigger = document.activeElement;
  pendingDeleteTarget = { book, artifactId, title };
  $('delete-modal-details').innerHTML = `
    <p><strong>Cuaderno:</strong> ${escapeHtml(book.title)}</p>
    <p><strong>Cuenta de acceso:</strong> ${escapeHtml(book.profile)}</p>
    <p><strong>Elemento:</strong> ${escapeHtml(title)}</p>
    <p><strong>ID remoto:</strong> <code>${escapeHtml(artifactId)}</code></p>
  `;
  $('delete-modal').showModal();
}

function normalizeCatalogResponse(data, expectedBookId) {
  if (!data?.book?.id || data.book.id !== expectedBookId || !Array.isArray(data.items)) {
    throw new Error('Respuesta de catálogo inválida o de otro libro.');
  }
  const book = data.book;
  const bookId = book.id;
  const rawItems = data.items;

  const artifacts = [];
  const sources = [];
  const notes = [];

  for (const item of rawItems) {
    if (!item || !['artifact', 'source', 'note'].includes(item.kind)) continue;
    let sourceIds = item.sourceIds || [];
    if (item.source_ids_json) {
      try { sourceIds = JSON.parse(item.source_ids_json); } catch (_) { sourceIds = []; }
    }
    const normalized = {
      id: item.id,
      remoteId: item.remote_id || item.remoteId,
      kind: item.kind,
      type: item.type || (item.kind === 'note' ? 'note' : item.kind === 'source' ? 'source' : 'unknown'),
      title: item.title || (item.kind === 'note' ? 'Nota' : item.kind === 'source' ? 'Fuente' : 'Contenido'),
      status: item.status,
      createdAt: item.created_time || item.createdAt || item.createdTime || null,
      modifiedAt: item.modified_time || item.modifiedAt || item.modifiedTime || null,
      notVisible: !!(item.not_visible ?? item.notVisible),
      errorReason: item.error_reason || item.errorReason || null,
      sourceIds: Array.isArray(sourceIds) ? sourceIds : []
    };

    if (item.kind === 'source') {
      sources.push(normalized);
    } else if (item.kind === 'note') {
      notes.push(normalized);
    } else {
      artifacts.push(normalized);
    }
  }

  return {
    bookId,
    book,
    artifacts,
    sources,
    notes,
    rawItems
  };
}

function catalogItemAvailable(item) {
  return !!item.remoteId && !item.notVisible && !['deleted_confirmed', 'delete_uncertain', 'reappeared'].includes(item.status);
}
function catalogItemReady(item) {
  return catalogItemAvailable(item) && ['ready', 'completed', 2, '2'].includes(item.status);
}
function renderCatalogStatus() {
  const box = $('catalog-error');
  if (!box) return;
  box.hidden = viewingExplorer || !catalogLoadError;
  $('catalog-error-text').textContent = catalogLoadError ? `No se pudo actualizar el catálogo. ${catalogLoadError}${currentCatalog?.bookId === selected ? ' Se muestran datos anteriores.' : ''}` : '';
}
$('catalog-retry')?.addEventListener('click', () => loadCatalog(selected));

async function loadCatalog(bookId) {
  renderCatalogStatus();
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

  const pending = catalogLoads.get(bookId);
  if (pending?.seq === catalogRequestSeq) return pending.promise;
  const seq = ++catalogRequestSeq;
  const operation = (async () => {
  try {
    const data = await api(`/api/books/${bookId}/catalog`, { timeout: 15000 });
    if (seq !== catalogRequestSeq || selected !== bookId || viewingExplorer || refreshStopped) return;
    currentCatalog = normalizeCatalogResponse(data, bookId);
    catalogLoadError = null;
    lastCatalogLoadTime = Date.now();

    const validArtIds = new Set(currentCatalog.artifacts.filter(catalogItemReady).map(a => a.id));
    for (const id of selectedCatalogArtifacts) {
      if (!validArtIds.has(id)) selectedCatalogArtifacts.delete(id);
    }
    const validSrcIds = new Set(currentCatalog.sources.filter(catalogItemReady).map(s => s.remoteId));
    for (const id of selectedCatalogSources) {
      if (!validSrcIds.has(id)) selectedCatalogSources.delete(id);
    }

    renderCatalog();
  } catch (e) {
    if (seq !== catalogRequestSeq || selected !== bookId || viewingExplorer || refreshStopped) return;
    catalogLoadError = e.message;
    if (!currentCatalog) {
      $('catalog-section').hidden = true;
    }
  } finally {
    if (catalogLoads.get(bookId)?.seq === seq) catalogLoads.delete(bookId);
    renderCatalogStatus();
  }
  })();
  catalogLoads.set(bookId, { seq, promise: operation });
  return operation;
}

function renderCatalog() {
  renderCatalogStatus();
  if (!currentCatalog || currentCatalog.bookId !== selected || viewingExplorer) {
    $('catalog-section').hidden = true;
    return;
  }
  const book = books.find(b => b.id === selected);
  if (!book || !book.remoteId) {
    $('catalog-section').hidden = true;
    return;
  }
  $('catalog-section').hidden = false;
  const stamp = JSON.stringify([currentCatalog, [...selectedCatalogSources], [...selectedCatalogArtifacts]]);
  if (stamp === lastCatalogRenderStamp) return;
  lastCatalogRenderStamp = stamp;
  const focused = document.activeElement;
  const focusedRow = focused?.closest('#catalog-section tr');
  const focusedItem = focusedRow?.dataset.catalogId;
  const focusedControl = focusedRow ? [...focusedRow.querySelectorAll('input,button,a')].indexOf(focused) : -1;

  const artifacts = currentCatalog.artifacts || [];
  const sources = currentCatalog.sources || [];
  const notes = currentCatalog.notes || [];

  $('count-artifacts').textContent = artifacts.length;
  $('count-sources').textContent = sources.length;
  $('count-notes').textContent = notes.length;

  // 1. Pestaña Artefactos
  const artTbody = $('catalog-artifacts-list');
  const artEmpty = $('catalog-artifacts-empty');
  artEmpty.hidden = artifacts.length > 0;
  artTbody.hidden = artifacts.length === 0;

  const readyArtifacts = artifacts.filter(catalogItemReady);
  $('select-all-artifacts').checked = readyArtifacts.length > 0 && readyArtifacts.every(a => selectedCatalogArtifacts.has(a.id));
  $('select-all-artifacts').disabled = readyArtifacts.length === 0;
  $('download-selected-artifacts-btn').disabled = selectedCatalogArtifacts.size === 0;
  $('download-selected-artifacts-btn').textContent = selectedCatalogArtifacts.size > 0
    ? `Descargar seleccionados (${selectedCatalogArtifacts.size})`
    : 'Descargar seleccionados';

  artTbody.replaceChildren(...artifacts.map(a => {
    const tr = el('tr');
    tr.dataset.catalogId = a.id;
    if (a.notVisible) tr.classList.add('item-not-visible');

    const tdCheck = el('td');
    const cb = el('input', {
      type: 'checkbox',
      checked: selectedCatalogArtifacts.has(a.id),
      disabled: !catalogItemReady(a),
      'aria-label': `Seleccionar artefacto ${a.title}`
    });
    cb.addEventListener('change', () => {
      if (cb.checked) selectedCatalogArtifacts.add(a.id);
      else selectedCatalogArtifacts.delete(a.id);
      renderCatalog();
    });
    tdCheck.append(cb);

    const tdTitle = el('td');
    tdTitle.append(el('strong', {}, a.title || 'Sin título'));
    if (a.createdAt) tdTitle.append(el('small', { class: 'source-name' }, `Creado: ${safeDate(a.createdAt)}`));

    const tdType = el('td');
    tdType.append(el('span', { class: `badge ${a.type}` }, a.type || 'desconocido'));

    const tdRemoteId = el('td');
    if (a.remoteId) {
      tdRemoteId.append(el('code', { class: 'remote-id-tag' }, a.remoteId));
    } else {
      tdRemoteId.append(el('span', { class: 'muted' }, '—'));
    }

    const tdState = el('td');
    if (a.notVisible) {
      tdState.append(el('span', { class: 'badge waiting_quota' }, 'No visible en la última sincronización'));
    } else {
      const isReady = a.status === 'completed' || a.status === 'ready';
      const isFailed = a.status === 'failed';
      tdState.append(el('span', { class: `badge ${isReady ? 'done' : isFailed ? 'error' : 'generating'}` },
        isReady ? 'Completado' : isFailed ? 'Error' : (['generating', 'queued', 'submitting', 'processing'].includes(a.status) ? 'Generando' : String(a.status || 'Estado desconocido'))));
    }
    if (a.errorReason) tdState.append(el('div', { class: 'block-error' }, a.errorReason));

    const tdAction = el('td');
    const canDownload = catalogItemReady(a);
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

    const deleteTargetId = a.remoteId;
    tdAction.append(el('button', {
      class: 'quiet retry',
      style: 'color: #dc2626; margin-top: 4px;',
      type: 'button',
      disabled: !catalogItemAvailable(a),
      onclick: () => openDeleteModal(book, deleteTargetId, a.title)
    }, 'Eliminar de NotebookLM…'));

    tr.append(tdCheck, tdTitle, tdType, tdRemoteId, tdState, tdAction);
    return tr;
  }));

  // 2. Pestaña Fuentes
  const srcTbody = $('catalog-sources-list');
  const srcEmpty = $('catalog-sources-empty');
  srcEmpty.hidden = sources.length > 0;
  srcTbody.hidden = sources.length === 0;

  const validSources = sources.filter(catalogItemReady);
  $('select-all-sources').disabled = validSources.length === 0;
  $('select-all-sources').checked = validSources.length > 0 && validSources.every(s => selectedCatalogSources.has(s.remoteId));
  $('generate-from-sources-btn').disabled = selectedCatalogSources.size === 0;
  $('generate-from-sources-btn').textContent = selectedCatalogSources.size > 0
    ? `Generar audios de fuentes seleccionadas (${selectedCatalogSources.size})`
    : 'Generar audios de fuentes seleccionadas';

  srcTbody.replaceChildren(...sources.map(s => {
    const tr = el('tr');
    tr.dataset.catalogId = s.id;
    if (s.notVisible) tr.classList.add('item-not-visible');

    const tdCheck = el('td');
    const srcKey = s.remoteId || s.id;
    const cb = el('input', {
      type: 'checkbox',
      checked: selectedCatalogSources.has(srcKey),
      disabled: !catalogItemReady(s),
      'aria-label': `Seleccionar fuente ${s.title}`
    });
    cb.addEventListener('change', () => {
      if (cb.checked) selectedCatalogSources.add(srcKey);
      else selectedCatalogSources.delete(srcKey);
      renderCatalog();
    });
    tdCheck.append(cb);

    const tdTitle = el('td');
    tdTitle.append(el('strong', {}, s.title || 'Fuente'));
    if (s.createdAt) tdTitle.append(el('small', { class: 'source-name' }, `Creado: ${safeDate(s.createdAt)}`));

    const tdId = el('td');
    tdId.append(el('code', {}, s.remoteId || s.id || '—'));

    const tdState = el('td');
    if (s.notVisible) {
      tdState.append(el('span', { class: 'badge waiting_quota' }, 'No visible en la última sincronización'));
    } else {
      const isReady = ['ready', 'completed', 2, '2'].includes(s.status);
      const isFailed = ['failed', 3, '3'].includes(s.status);
      tdState.append(el('span', { class: `badge ${isReady ? 'done' : isFailed ? 'error' : 'generating'}` },
        isReady ? 'Lista' : isFailed ? 'Error' : (['processing', 'queued'].includes(s.status) ? 'Procesando' : String(s.status || 'Estado desconocido'))));
    }

    tr.append(tdCheck, tdTitle, tdId, tdState);
    return tr;
  }));

  // 3. Pestaña Notas
  const notesTbody = $('catalog-notes-list');
  const notesEmpty = $('catalog-notes-empty');
  notesEmpty.hidden = notes.length > 0;
  notesTbody.hidden = notes.length === 0;

  notesTbody.replaceChildren(...notes.map(n => {
    const tr = el('tr');
    if (n.notVisible) tr.classList.add('item-not-visible');

    const tdTitle = el('td', {}, n.title || 'Nota');
    const tdId = el('td');
    tdId.append(el('code', {}, n.remoteId || n.id || '—'));
    const tdContent = el('td', {}, 'Contenido no disponible en la caché');
    tr.append(tdTitle, tdId, tdContent);
    return tr;
  }));
  if (focusedItem && focusedControl >= 0) {
    const row = [...$('catalog-section').querySelectorAll('tr')].find(row => row.dataset.catalogId === focusedItem);
    row?.querySelectorAll('input,button,a')[focusedControl]?.focus();
  }
}

$('sync-content-btn')?.addEventListener('click', () => {
  if (!selected) return;
  const bookId = selected;
  act(async () => {
    notice('Sincronizando catálogo con NotebookLM…');
    await api(`/api/books/${bookId}/sync`, { method: 'POST' });
    notice('Catálogo sincronizado.');
    if (selected === bookId && !viewingExplorer) await loadCatalog(bookId);
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
  const artifacts = currentCatalog?.bookId === selected ? currentCatalog.artifacts.filter(catalogItemReady) : [];
  if (e.target.checked) selectedCatalogArtifacts = new Set(artifacts.map(a => a.id));
  else selectedCatalogArtifacts.clear();
  renderCatalog();
});
$('download-selected-artifacts-btn')?.addEventListener('click', () => {
  if (!selected || currentCatalog?.bookId !== selected || viewingExplorer) return;
  const bookId = selected;
  const selection = selectedCatalogArtifacts;
  const items = currentCatalog.artifacts.filter(a => selection.has(a.id) && catalogItemReady(a)).map(a => ({ itemId: a.id }));
  if (!items.length) return;
  act(async () => {
    notice(`Solicitando descarga de ${selectedCatalogArtifacts.size} contenidos…`);
    const res = await api(`/api/books/${bookId}/downloads`, {
      method: 'POST',
      data: { items }
    });
    notice(`${res.accepted.length} descargas aceptadas.${res.rejected.length ? ` ${res.rejected.length} rechazadas.` : ''}`);
    if (selected === bookId && selectedCatalogArtifacts === selection) {
      for (const item of [...(res.accepted || []), ...(res.existing || [])]) selection.delete(item.id);
      renderCatalog();
    }
  });
});

$('select-all-sources')?.addEventListener('change', (e) => {
  const sources = currentCatalog?.bookId === selected ? currentCatalog.sources.filter(catalogItemReady) : [];
  if (e.target.checked) selectedCatalogSources = new Set(sources.map(s => s.remoteId));
  else selectedCatalogSources.clear();
  renderCatalog();
});
$('generate-from-sources-btn')?.addEventListener('click', () => {
  if (!selected || currentCatalog?.bookId !== selected || viewingExplorer) return;
  const bookId = selected;
  const selection = selectedCatalogSources;
  const sourceIds = currentCatalog.sources.filter(s => selection.has(s.remoteId) && catalogItemReady(s)).map(s => s.remoteId);
  if (!sourceIds.length) return;
  act(async () => {
    notice(`Generando audios para ${selectedCatalogSources.size} fuentes seleccionadas…`);
    const res = await api(`/api/books/${bookId}/generations`, {
      method: 'POST',
      data: { sourceIds, mode: $('generation-mode')?.value || 'immediate' }
    });
    notice(`${res.queued.length} bloques añadidos a la cola de generación.`);
    if (selected === bookId && selectedCatalogSources === selection) {
      for (const id of sourceIds) selection.delete(id);
      renderCatalog();
    }
  });
});

$('delete-modal-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!$('delete-modal').open || !pendingDeleteTarget) return;
  const { book, artifactId, title } = pendingDeleteTarget;
  pendingDeleteTarget = null;
  $('delete-modal').close();
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
$('delete-modal')?.addEventListener('close', () => {
  pendingDeleteTarget = null;
  if (lastDialogTrigger?.isConnected && typeof lastDialogTrigger.focus === 'function') {
    lastDialogTrigger.focus();
    lastDialogTrigger = null;
  }
});
$('delete-modal')?.addEventListener('cancel', () => { pendingDeleteTarget = null; });

async function loadRecipes() {
  if (recipesPromise) return recipesPromise;
  recipesPromise = (async () => {
  try {
    const res = await api('/api/recipes', { timeout: 15000 });
    recipes = res.recipes || [];
    recipesLoaded = true;
    renderRecipes();
  } catch (e) {
    console.error('Error cargando recetas:', e);
    recipesLoaded = false;
  }
  })();
  try { await recipesPromise; } finally { recipesPromise = null; }
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
    matrixRequestSeq++;
    currentMatrix = null;
    return;
  }
  const page = matrixPage;
  const key = `${bookId}:${page}`;
  const pending = matrixLoads.get(key);
  if (pending?.seq === matrixRequestSeq) return pending.promise;
  const seq = ++matrixRequestSeq;
  const operation = (async () => {
  try {
    const data = await api(`/api/books/${bookId}/matrix?page=${page}`, { timeout: 15000 });
    if (seq !== matrixRequestSeq || selected !== bookId || matrixPage !== page || viewingExplorer || refreshStopped) return;
    currentMatrix = data;
    renderMatrix();
  } catch (e) {
    if (seq !== matrixRequestSeq || selected !== bookId || matrixPage !== page || viewingExplorer || refreshStopped) return;
    notice(`No se pudo actualizar la matriz. ${e.message}`, true);
  } finally {
    if (matrixLoads.get(key)?.seq === seq) matrixLoads.delete(key);
  }
  })();
  matrixLoads.set(key, { seq, promise: operation });
  return operation;
}

function renderMatrix() {
  if (activeViewTab !== 'matrix' || !selected || !books.some(b => b.id === selected)) return;
  const bar = $('material-metrics-bar');
  const reasonBox = $('waiting-reason-box');
  const tbody = $('matrix-body');
  const empty = $('empty-matrix');
  const pagination = $('matrix-pagination');

  if (!currentMatrix || currentMatrix.bookId !== selected || !currentMatrix.matrix?.length) {
    if (empty) empty.hidden = false;
    if (tbody) tbody.replaceChildren();
    if (bar) bar.hidden = true;
    if (reasonBox) reasonBox.hidden = true;
    if (pagination) pagination.hidden = true;
    return;
  }

  if (empty) empty.hidden = true;
  const page = currentMatrix.pagination;
  if (pagination && page) {
    const maxPage = Math.max(1, Math.ceil(page.total / page.limit));
    pagination.hidden = maxPage <= 1;
    $('matrix-page-info').textContent = `${page.page} de ${maxPage}`;
    $('matrix-prev-page').disabled = page.page <= 1;
    $('matrix-next-page').disabled = page.page >= maxPage;
  }
  if (bar) {
    bar.hidden = false;
    const s = currentMatrix.summary || {};
    $('metric-required').textContent = s.totalRequirements || 0;
    $('metric-ready').textContent = s.ready || 0;
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

  const visibleIds = new Set(currentMatrix.matrix.map(row => row.blockId));
  for (const tr of [...tbody.children]) {
    if (!visibleIds.has(tr.dataset.blockId)) tr.remove();
  }
  currentMatrix.matrix.forEach((row, index) => {
    const rowStamp = JSON.stringify(row);
    const existing = [...tbody.children].find(tr => tr.dataset.blockId === row.blockId);
    // Keep unchanged players mounted while other materials progress.
    if (existing?.dataset.rowStamp === rowStamp) {
      if (tbody.children[index] !== existing) tbody.insertBefore(existing, tbody.children[index] || null);
      return;
    }
    const tr = el('tr');
    tr.dataset.blockId = row.blockId;
    tr.dataset.rowStamp = rowStamp;

    const tdNum = el('td');
    tdNum.append(el('span', { class: 'number' }, String(row.blockNumber).padStart(2, '0')));
    const tdTitle = el('td');
    tdTitle.append(el('strong', {}, row.title || `Bloque ${row.blockNumber}`));
    if (row.sourceId) tdTitle.append(el('div', { class: 'source-name' }, `Fuente: ${row.sourceId}`));

    const tdAudio = el('td');
    tdAudio.append(renderMaterialCell(row.materials?.audio, row, 'audio'));

    const tdInfo = el('td');
    tdInfo.append(renderMaterialCell(row.materials?.infographic, row, 'infographic'));

    tr.append(tdNum, tdTitle, tdAudio, tdInfo);
    if (existing) existing.replaceWith(tr);
    if (tbody.children[index] !== tr) tbody.insertBefore(tr, tbody.children[index] || null);
  });
  studioPlayer.syncRowIndicators();
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

  container.append(badgeRow);

  if (mat.assigned_profile) {
    container.append(el('small', { class: 'account-tag' }, `Cuenta: ${mat.assigned_profile}`));
  }

  if (mat.error) {
    container.append(el('div', { class: 'block-error' }, mat.error));
  }

  if (mat.state === 'ready') {
    if (kind === 'audio' && mat.output_path) {
      const audioUrl = `/api/materials/${mat.id}/file`;
      const isCurrent = studioPlayer.isCurrentTrack({ audioUrl, blockId: row.blockId || row.id });
      const isPlaying = isCurrent && !studioPlayer.isPaused();
      const listenBtn = el('button', {
        type: 'button',
        class: `action-btn audio-listen-btn${isCurrent ? ' is-active-track' : ''}`,
        'data-audio-url': audioUrl,
        'data-block-id': row.blockId || row.id,
        'aria-label': `${isPlaying ? 'Pausar' : 'Escuchar'} audio del bloque ${row.blockNumber || row.number || ''}: ${row.title}`,
        onclick: () => {
          studioPlayer.selectTrack({
            bookId: currentMatrix?.bookId || selected,
            bookTitle: books.find(b => b.id === (currentMatrix?.bookId || selected))?.title || 'Libro actual',
            blockId: row.blockId || row.id,
            blockTitle: row.title,
            number: String(row.blockNumber || row.number || '').padStart(2, '0'),
            sourceFingerprint: mat.source_fingerprint || row.hash,
            audioUrl,
            downloadUrl: `${audioUrl}?download=1`,
            outputName: mat.output_name || `${String(row.blockNumber || row.number || '').padStart(2, '0')} - ${row.title}.mp3`,
            materialId: mat.id
          });
        }
      }, isPlaying ? 'Pausar' : 'Escuchar');

      const tag = el('span', {
        class: `audio-track-tag ${isPlaying ? 'playing' : 'paused'}`,
        hidden: !isCurrent
      }, isPlaying ? 'Sonando' : 'En pausa');

      const downloadLink = el('a', {
        class: 'download-link',
        href: `${audioUrl}?download=1`,
        download: mat.output_name || `${String(row.blockNumber || row.number || '').padStart(2, '0')} - ${row.title}.mp3`
      }, 'Descargar MP3');

      container.append(listenBtn, tag, downloadLink);
    } else if (kind === 'infographic' && mat.output_path) {
      const imgUrl = `/api/materials/${mat.id}/file`;
      const preview = el('button', {
        type: 'button', class: 'infographic-preview',
        'aria-label': `Ampliar infografía de ${row.title || 'este bloque'}`,
        onclick: () => openInfographicPreview(imgUrl, row.title)
      });
      const error = el('small', { class: 'block-error', hidden: true }, 'No se pudo cargar la vista previa.');
      const image = el('img', {
        src: imgUrl, alt: `Infografía de ${row.title || 'este bloque'}`, loading: 'lazy', decoding: 'async',
        onerror: () => { image.hidden = true; error.hidden = false; }
      });
      preview.append(image, error, el('span', {}, 'Ampliar'));
      container.append(preview);
    }
  }

  const actions = el('div', { class: 'cell-actions' });
  if (mat.state === 'canceled') {
    const restore = mat.can_restore;
    actions.append(el('button', {
      type: 'button', class: 'quiet action-btn',
      onclick: () => act(async () => {
        await api(`/api/materials/${mat.id}/action`, { method: 'POST', data: { action: restore ? 'restore' : 'restart' } });
        notice(restore ? 'Se recuperó el archivo anterior sin generar de nuevo.' : 'Se ha iniciado la generación de este material.');
        await loadMatrix(selected);
      })
    }, restore ? (kind === 'audio' ? 'Recuperar audio anterior' : 'Recuperar infografía anterior') : (kind === 'audio' ? 'Generar audio' : 'Generar infografía')));
  }
  if (['failed', 'review_required'].includes(mat.state)) {
    actions.append(el('button', {
      class: 'quiet retry action-btn',
      onclick: () => act(async () => {
        await api(`/api/materials/${mat.id}/action`, { method: 'POST', data: { action: 'retry' } });
        notice('Reintento solicitado.');
        await loadMatrix(selected);
      })
    }, 'Reintentar'));
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

function openInfographicPreview(url, title) {
  const dialog = $('infographic-modal');
  const image = $('infographic-full-image');
  $('infographic-title').textContent = title || 'Infografía';
  $('infographic-preview-error').hidden = true;
  image.hidden = false;
  image.alt = `Infografía de ${title || 'este bloque'}`;
  image.src = url;
  $('infographic-download').href = `${url}?download=1`;
  if (!dialog.open) dialog.showModal();
}

$('infographic-close')?.addEventListener('click', () => $('infographic-modal').close());
$('infographic-full-image')?.addEventListener('error', () => {
  $('infographic-full-image').hidden = true;
  $('infographic-preview-error').hidden = false;
});
$('infographic-modal')?.addEventListener('close', () => $('infographic-full-image').removeAttribute('src'));

async function openPlanPreview() {
  if (!selected || planConfirming || planPreviewLoading || $('plan-modal').open) return;
  planPreviewLoading = true;
  lastDialogTrigger = document.activeElement;
  const bookId = selected;
  const recipeId = $('recipe-selector')?.value || 'study-book';
  notice('Calculando plan de producción multimodal…');
  try {
    const plan = await api(`/api/books/${bookId}/plan/preview`, {
      method: 'POST',
      data: { recipeId }
    });
    if (selected !== bookId || viewingExplorer) return;
    currentPlanPreview = plan;
    planRequestId = crypto.randomUUID();
    renderPlanModal(plan);
    $('plan-modal').showModal();
    notice('');
  } catch (e) {
    notice(`Error al calcular plan: ${e.message}`, true);
  } finally {
    planPreviewLoading = false;
  }
}

function renderPlanModal(plan) {
  const summaryEl = $('plan-modal-summary');
  const detailsEl = $('plan-modal-details');
  if (!summaryEl || !detailsEl) return;

  const s = plan.summary || {};
  summaryEl.innerHTML = `
    <div class="summary-card"><strong>${escapeHtml(plan.recipeName || 'Receta')}</strong><small>Receta seleccionada</small></div>
    <div class="summary-card"><strong>${s.totalRequirements || 0}</strong><small>Materiales requeridos</small></div>
    <div class="summary-card"><strong>${s.toCreate || 0}</strong><small>Nuevas tareas</small></div>
    <div class="summary-card"><strong>${s.ready || 0}</strong><small>Ya listos</small></div>
    <div class="summary-card"><strong>${s.reusable || 0}</strong><small>Ya planificados</small></div>
  `;

  const tasks = plan.requirements || [];
  if (!tasks.length) {
    detailsEl.innerHTML = '<p class="muted">Todos los materiales requeridos para los bloques existentes ya están planificados o completados.</p>';
  } else {
    detailsEl.innerHTML = `
      <div class="table-wrap" style="max-height: 240px; overflow-y: auto;">
        <table>
          <thead>
            <tr><th>#</th><th>Material</th><th>Título del bloque</th><th>Motivo</th></tr>
          </thead>
          <tbody>
            ${tasks.map(t => `
              <tr>
                <td>${t.blockNumber}</td>
                <td>${t.type === 'audio' ? 'Audio' : 'Infografía'}</td>
                <td>${escapeHtml(t.blockTitle)}</td>
                <td><small>${escapeHtml(t.type === 'audio' && t.status === 'ready' ? 'Se conserva el audio existente' : ({ to_create: 'Nuevo requisito', ready: 'Ya listo', reusable: 'Ya planificado', restore: 'Se recupera el archivo anterior sin regenerar', outdated: 'Desactualizado (se conserva; no se regenera)', review_required: 'Revisión necesaria', canceled: 'Nueva generación de este material cancelado' })[t.status] || t.status)}</small></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }
}

async function confirmPlan() {
  if (planConfirming || !selected || !currentPlanPreview || currentPlanPreview.bookId !== selected) return;
  const plan = currentPlanPreview;
  const requestId = planRequestId;
  planConfirming = true;
  $('plan-modal-confirm').disabled = true;
  $('plan-modal-cancel').disabled = true;
  notice('Confirmando plan de producción…');
  try {
    const res = await api(`/api/books/${plan.bookId}/plan/confirm`, {
      method: 'POST',
      data: {
        recipeId: plan.recipeId,
        recipeVersion: plan.recipeVersion,
        requestId
      }
    });
    $('plan-modal').close();
    notice(res.running ? 'Plan confirmado. La producción pendiente se ha iniciado; los audios existentes se conservan.' : 'Plan confirmado. No hay materiales pendientes de generar.');
    currentPlanPreview = null;
    planRequestId = null;
    await refresh();
    await loadMatrix(selected);
  } catch (e) {
    notice(`Error al confirmar plan: ${e.message}`, true);
  } finally {
    planConfirming = false;
    $('plan-modal-confirm').disabled = false;
    $('plan-modal-cancel').disabled = false;
  }
}

$('prepare-plan-btn')?.addEventListener('click', openPlanPreview);
$('plan-modal-confirm')?.addEventListener('click', confirmPlan);
$('plan-modal-cancel')?.addEventListener('click', () => {
  if (planConfirming) return;
  $('plan-modal').close();
  currentPlanPreview = null;
  planRequestId = null;
});
$('plan-modal')?.addEventListener('close', () => {
  currentPlanPreview = null;
  planRequestId = null;
  if (lastDialogTrigger?.isConnected && typeof lastDialogTrigger.focus === 'function') {
    lastDialogTrigger.focus();
    lastDialogTrigger = null;
  }
});
$('plan-modal')?.addEventListener('cancel', e => {
  if (planConfirming) e.preventDefault();
  else { currentPlanPreview = null; planRequestId = null; }
});

for (const [id, delta] of [['matrix-prev-page', -1], ['matrix-next-page', 1]]) {
  $(id)?.addEventListener('click', () => {
    matrixPage = Math.max(1, matrixPage + delta);
    loadMatrix(selected);
  });
}

$('tab-view-matrix')?.addEventListener('click', () => {
  activeViewTab = 'matrix';
  lastRender = '';
  render();
  loadMatrix(selected);
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

const THEME_STORAGE_KEY = 'bloqueaudio_theme_v1';

$('sidebar-toggle')?.addEventListener('click', () => {
  const open = document.querySelector('.sidebar').classList.toggle('is-open');
  $('sidebar-toggle').setAttribute('aria-expanded', String(open));
});

function applyTheme(theme) {
  theme = ['system', 'light', 'dark'].includes(theme) ? theme : 'system';
  const root = document.documentElement;
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.removeProperty('color-scheme');
  if ($('theme-selector')) $('theme-selector').value = theme;
}

function initTheme() {
  const selector = $('theme-selector');
  let saved = 'system';
  try {
    saved = localStorage.getItem(THEME_STORAGE_KEY) || 'system';
  } catch (_) {}

  applyTheme(saved);

  if (selector) {
    selector.value = saved;
    selector.addEventListener('change', () => {
      const val = selector.value || 'system';
      try {
        localStorage.setItem(THEME_STORAGE_KEY, val);
      } catch (_) {}
      applyTheme(val);
    });
  }

  window.addEventListener('storage', e => {
    if (e.key === THEME_STORAGE_KEY) {
      const newTheme = e.newValue || 'system';
      if (selector) selector.value = newTheme;
      applyTheme(newTheme);
    }
  });

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  if (typeof media?.addEventListener === 'function') {
    media.addEventListener('change', () => {
      let cur = 'system';
      try { cur = localStorage.getItem(THEME_STORAGE_KEY) || 'system'; } catch (_) {}
      if (cur === 'system') {
        applyTheme('system');
      }
    });
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    scheduleImmediateRefresh();
  } else if (!refreshing) scheduleNextRefresh();
});

window.addEventListener('online', () => {
  consecutiveRefreshErrors = 0;
  scheduleImmediateRefresh();
});
window.addEventListener('pagehide', () => {
  refreshStopped = true;
  refreshPending = false;
  clearTimeout(refreshTimeout);
  refreshTimeout = null;
  clearTimeout(noticeDismissTimer);
  noticeDismissTimer = null;
  for (const controller of timedReadControllers) controller.abort();
});
window.addEventListener('pageshow', () => {
  refreshStopped = false;
  scheduleImmediateRefresh();
});

initTheme();
scheduleImmediateRefresh();

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
studioPlayer.init();
window.studioPlayer = studioPlayer;
