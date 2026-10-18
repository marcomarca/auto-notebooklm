import { Provider, ProviderError, redact } from './provider.mjs';
import { quotaRetry } from './queue.mjs';

export function profileId(value) {
  if (typeof value !== 'string' || !/^[\w-]{1,80}$/.test(value)) throw new Error('Nombre de perfil inválido. Usa letras, números, guion o guion bajo (máximo 80).');
  return value;
}

export class Accounts {
  constructor(store, primary, { factory, gate, now = Date.now } = {}) {
    this.store = store; this.primary = primary; this.now = now;
    this.gate = gate || primary?.gate;
    if (primary && this.gate && !primary.gate) primary.gate = this.gate;
    this.factory = factory || (profile => (primary.forProfile ? primary.forProfile(profile) : new Provider({ profile, gate: this.gate, nlm: primary.nlm, ffmpeg: primary.ffmpeg })));
    this.providers = new Map([[primary.profile, primary]]); this.checks = new Map(); this.tasks = new Set();
    this.ensure(primary.profile);
    this.current = store.get("SELECT value FROM settings WHERE key='profile'")?.value || primary.profile;
    this.ensure(this.current);
  }
  ensure(id, email) {
    profileId(id);
    this.store.db.prepare('INSERT OR IGNORE INTO accounts(id,enabled) VALUES(?,?)').run(id, id === this.primary.profile ? 1 : 0);
    if (email !== undefined) this.store.update('accounts', id, { email });
    return this.store.get('SELECT * FROM accounts WHERE id=?', id);
  }
  get(id) {
    this.ensure(id);
    if (!this.providers.has(id)) this.providers.set(id, this.factory(id));
    return this.providers.get(id);
  }
  async discover() {
    for (const p of this.providers.values()) {
      if (p.profiles) {
        try {
          const list = await p.profiles();
          if (Array.isArray(list)) {
            for (const item of list) this.ensure(item.id, item.email);
          }
        } catch {}
      }
    }
    for (const id of ['default', 'cuenta2', 'cuenta3', 'cuenta4']) this.ensure(id);
    return this.snapshot();
  }
  snapshot() {
    return { current: this.current, loginProfile: this.loginProfile || null,
      accounts: this.store.all('SELECT * FROM accounts ORDER BY id').map(a => ({
        id: a.id, email: a.email, enabled: !!a.enabled, nextAt: a.retry_at || null,
        error: a.error, errorCode: a.error_code, health: this.providers.get(a.id)?.health || { ready: false, auth: false }
      })) };
  }
  select(id) {
    this.ensure(id); this.current = id;
    this.store.db.prepare("INSERT INTO settings(key,value) VALUES('profile',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(id);
  }
  enable(id, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('enabled debe ser booleano.');
    this.ensure(id); this.store.update('accounts', id, { enabled: enabled ? 1 : 0 });
  }
  async check(id) {
    if (this.closed) throw new Error('La aplicación está cerrando.');
    if (this.loginProfile === id) {
      return { ready: false, auth: false, profile: id, error: 'Inicio de sesión en curso en el navegador…' };
    }
    if (this.checks.has(id)) return this.checks.get(id);
    const task = (async () => {
      const p = this.get(id); const h = await p.check();
      let errorMsg = h.error || null;
      if (h.errorCode === 'AUTH_REQUIRED') {
        errorMsg = errorMsg && errorMsg.length < 100 ? errorMsg : 'Sesión expirada. Pulsa «Iniciar sesión» para renovarla.';
      }
      this.store.update('accounts', id, { retry_at: h.ready ? quotaRetry(h.usage, this.now()) : this.now() + 1800000,
        error: errorMsg, error_code: h.ready ? null : h.errorCode || 'UNAVAILABLE' });
      if (h.ready && !this.closed) this.onReady?.(id);
      return h;
    })();
    this.checks.set(id, task);
    try { return await task; } finally { this.checks.delete(id); }
  }
  async checkWriteAccess(book) {
    const id = book.profile;
    const h = await this.check(id);
    if (!h.ready) throw new ProviderError(h.errorCode || 'UNAVAILABLE', h.error || 'Cuenta sin conexión.');
    if (!book.remote_id) return true;
    const account = this.ensure(id);
    const p = this.get(id);
    if (!account.email && p.profiles) {
      try {
        const list = await p.profiles();
        const me = list.find(x => x.id === id);
        if (me?.email) account.email = me.email;
      } catch {}
    }
    if (p.access) {
      try {
        await p.access(book.remote_id, account.email);
      } catch (err) {
        throw new ProviderError('ACCESS_DENIED', 'Esta cuenta no tiene permisos de edición en este cuaderno remoto. Se requiere permiso de editor para añadir material.');
      }
    }
    return true;
  }
  async verify(book, id) {
    const h = await this.check(id);
    if (!h.ready) throw new ProviderError(h.errorCode || 'UNAVAILABLE', h.error || 'Cuenta sin conexión.');
    const account = this.ensure(id);
    if (id !== book.profile) {
      if (account.email) {
        const owner = this.get(book.profile);
        if (owner.shareInvite) {
          try { await owner.shareInvite(book.remote_id, account.email, 'editor'); }
          catch {}
        }
      }
      await this.get(id).access(book.remote_id, account.email);
    }
    return true;
  }
  async configure(book, profiles) {
    if (!book.remote_id) throw new Error('Espera a que se cree el cuaderno.');
    if (!Array.isArray(profiles) || profiles.length > 50 || new Set(profiles).size !== profiles.length) throw new Error('Lista de respaldos inválida.');
    const emails = new Set([this.ensure(book.profile).email?.toLowerCase()].filter(Boolean));
    for (const id of profiles) {
      profileId(id); if (id === book.profile) throw new Error('La cuenta propietaria ya está incluida.');
      await this.verify(book, id);
      const email = this.ensure(id).email?.toLowerCase();
      if (emails.has(email)) throw new Error('Dos perfiles de la misma cuenta no aportan otra cuota. Selecciona cuentas distintas.');
      emails.add(email);
    }
    this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM book_accounts WHERE book_id=?').run(book.id);
      for (const id of profiles) this.store.db.prepare('INSERT INTO book_accounts(book_id,profile) VALUES(?,?)').run(book.id, id);
      this.store.update('books', book.id, { quota_at: 0, quota_error: null });
      this.store.db.prepare("UPDATE blocks SET next_at=0,state='ready',error=NULL,error_code=NULL WHERE book_id=? AND stage='generate' AND state='quota' AND baseline IS NULL").run(book.id);
    });
  }
  async candidate(book, sourceId) {
    const hasUncertainBlock = this.store.get(
      'SELECT id FROM blocks WHERE book_id=? AND baseline IS NOT NULL LIMIT 1',
      book.id
    );
    const hasUncertainMaterial = this.store.get(
      `SELECT ma.id FROM material_attempts ma
       JOIN material_tasks mt ON ma.task_id = mt.id
       WHERE mt.book_id = ? AND ma.baseline_json IS NOT NULL AND ma.resolved_at IS NULL AND ma.state NOT IN ('failed', 'canceled', 'resolved') AND ma.artifact_id IS NULL
       LIMIT 1`,
      book.id
    );
    if (hasUncertainBlock || hasUncertainMaterial) {
      return { barrier: true, retryAt: this.now() + 15000 };
    }

    const rawProfiles = [book.profile, ...this.store.all('SELECT profile FROM book_accounts WHERE book_id=? ORDER BY profile', book.id).map(a => a.profile)];
    const seenEmails = new Set();
    const candidateProfiles = [];
    for (const id of rawProfiles) {
      const a = this.ensure(id);
      if (!a.enabled) continue;
      let email = a.email ? a.email.trim().toLowerCase() : null;
      if (!email && id !== book.profile) {
        const p = this.get(id);
        if (p.profiles) {
          try {
            const list = await p.profiles();
            const me = list.find(x => x.id === id);
            if (me?.email) {
              email = me.email.trim().toLowerCase();
              a.email = me.email;
              this.store.update('accounts', id, { email: me.email });
            }
          } catch {}
        }
      }
      if (email) {
        if (seenEmails.has(email)) continue;
        seenEmails.add(email);
      } else if (id !== book.profile) {
        continue;
      }
      candidateProfiles.push(id);
    }

    if (!candidateProfiles.length) {
      return { retryAt: this.now() + 1800000 };
    }

    const lastProfileKey = `book_last_profile:${book.id}`;
    const lastProfile = this.store.get('SELECT value FROM settings WHERE key=?', lastProfileKey)?.value;
    let startIndex = 0;
    if (lastProfile) {
      const lastIdx = candidateProfiles.indexOf(lastProfile);
      if (lastIdx !== -1) {
        startIndex = (lastIdx + 1) % candidateProfiles.length;
      }
    }

    const orderedProfiles = [];
    for (let i = 0; i < candidateProfiles.length; i++) {
      orderedProfiles.push(candidateProfiles[(startIndex + i) % candidateProfiles.length]);
    }

    let earliest = Infinity;
    for (const id of orderedProfiles) {
      let a = this.ensure(id);
      if (!a.enabled) continue;
      if (a.retry_at > this.now()) { earliest = Math.min(earliest, a.retry_at); continue; }
      const p = this.get(id);
      try {
        if (!p.health.ready) {
          await this.check(id);
          if (!p.health.ready) throw new ProviderError(p.health.errorCode || 'UNAVAILABLE', p.health.error || 'Cuenta sin conexión.');
        }
        let usage;
        try {
          usage = await p.usage();
          p.health.usage = usage;
        } catch (e) {
          if (['AUTH_REQUIRED', 'TEMPORARY', 'UNAVAILABLE', 'QUOTA'].includes(e.code)) throw e;
          p.health.usageWarning = redact(e.message);
        }
        const retry = quotaRetry(usage, this.now());
        if (retry) {
          this.exhausted(id, retry);
          earliest = Math.min(earliest, retry);
          continue;
        }
        if (id !== book.profile) {
          await p.access(book.remote_id, a.email);
          if (sourceId) {
            const source = (await p.sources(book.remote_id)).find(s => (s.id || s.source_id) === sourceId);
            if (!source || ![2, 'ready', 'completed'].includes(source.status)) {
              throw new ProviderError('ACCESS', 'La fuente del bloque no está lista en este cuaderno para la cuenta de respaldo.');
            }
          }
        }
        this.store.update('accounts', id, { retry_at: 0, error: null, error_code: null });
        this.store.db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(lastProfileKey, id);
        return { provider: p };
      } catch (e) {
        const retry = this.now() + (e.code === 'TEMPORARY' ? 60000 : 1800000);
        this.store.update('accounts', id, { retry_at: e.code === 'ACCESS' ? 0 : retry, error: redact(e.message), error_code: e.code || 'PROVIDER' });
        if (e.code === 'AUTH_REQUIRED') p.health = { ...p.health, ready: false, auth: false, error: redact(e.message), errorCode: e.code };
        earliest = Math.min(earliest, retry);
      }
    }
    return { retryAt: Number.isFinite(earliest) ? earliest : this.now() + 1800000 };
  }
  exhausted(id, retryAt, message = 'Cuota agotada.') {
    this.store.update('accounts', id, { retry_at: retryAt, error: message, error_code: 'QUOTA' });
  }
  login(id) {
    if (this.closed) throw new Error('La aplicación está cerrando.');
    if (this.loginProfile) throw new Error('Completa primero el inicio de sesión en curso.');
    this.ensure(id); this.loginProfile = id;
    const task = (async () => {
      try {
        await this.get(id).login();
        this.loginProfile = null;
        await this.discover();
        await this.check(id);
      } catch (e) {
        this.loginProfile = null;
        if (!this.closed) {
          const raw = e.message;
          this.store.update('accounts', id, { error: redact(raw), error_code: e.code || 'PROVIDER' });
          const p = this.get(id);
          p.health = { ...p.health, ready: false, auth: false, error: redact(raw), errorCode: e.code || 'PROVIDER' };
        }
      } finally {
        this.loginProfile = null;
      }
    })();
    this.tasks.add(task); task.finally(() => this.tasks.delete(task));
  }
  async close() {
    this.closed = true;
    await Promise.all([...this.providers.values()].map(p => p.close()));
    await Promise.allSettled([...this.tasks, ...this.checks.values()]);
  }
}
