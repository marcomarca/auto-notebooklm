import { ProviderError } from './provider.mjs';

export class ConnectorGate {
  constructor({ capacity = 1 } = {}) {
    this.capacity = capacity;
    this.activeCount = 0;
    this.queue = [];
    this.closed = false;
    this.maxConcurrentObserved = 0;
  }

  get active() {
    return this.activeCount;
  }

  get waiting() {
    return this.queue.length;
  }

  acquire({ signal } = {}) {
    if (this.closed) {
      return Promise.reject(new ProviderError('UNAVAILABLE', 'La puerta del conector está cerrada.'));
    }
    if (signal?.aborted) {
      return Promise.reject(new ProviderError('ABORTED', 'Operación cancelada localmente en espera de turno.', true));
    }

    if (this.activeCount < this.capacity) {
      this.activeCount++;
      if (this.activeCount > this.maxConcurrentObserved) {
        this.maxConcurrentObserved = this.activeCount;
      }
      return Promise.resolve(this._createRelease());
    }

    return new Promise((resolve, reject) => {
      const item = { resolve, reject, signal };
      const onAbort = () => {
        const idx = this.queue.indexOf(item);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          signal?.removeEventListener('abort', onAbort);
          reject(new ProviderError('ABORTED', 'Operación cancelada localmente en espera de turno.', true));
        }
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        item.cleanupSignal = () => signal.removeEventListener('abort', onAbort);
      }

      this.queue.push(item);
    });
  }

  _createRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeCount--;
      this._pump();
    };
  }

  _pump() {
    if (this.closed) {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        item.cleanupSignal?.();
        item.reject(new ProviderError('UNAVAILABLE', 'La puerta del conector está cerrada.'));
      }
      return;
    }

    while (this.activeCount < this.capacity && this.queue.length > 0) {
      const item = this.queue.shift();
      item.cleanupSignal?.();
      if (item.signal?.aborted) {
        item.reject(new ProviderError('ABORTED', 'Operación cancelada localmente en espera de turno.', true));
        continue;
      }
      this.activeCount++;
      if (this.activeCount > this.maxConcurrentObserved) {
        this.maxConcurrentObserved = this.activeCount;
      }
      item.resolve(this._createRelease());
      break;
    }
  }

  async withPermit(fn, { signal } = {}) {
    const release = await this.acquire({ signal });
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      item.cleanupSignal?.();
      item.reject(new ProviderError('UNAVAILABLE', 'La aplicación está cerrando y la puerta del conector se ha cerrado.'));
    }
    if (this.activeCount > 0) {
      await new Promise(resolve => {
        const check = setInterval(() => {
          if (this.activeCount === 0) {
            clearInterval(check);
            resolve();
          }
        }, 10);
      });
    }
  }
}
