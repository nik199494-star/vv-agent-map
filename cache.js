import {validateSnapshot} from './source.js';
import {publicationIdentity, selectRelease} from './rollback.js';

const key = 'published-demand';
const recoveryKey = 'published-demand-recovery';
let opening;

function openCache() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const scope = new URL('.', location.href).pathname;
      const request = indexedDB.open(`vv-agent:${scope}`, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Локальное хранилище заблокировано.'));
    });
    opening.catch(() => { opening = undefined; });
  }
  return opening;
}

export async function readSnapshot() {
  const db = await openCache();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('snapshots');
    const store = transaction.objectStore('snapshots');
    const snapshot = store.get(key), recovery = store.get(recoveryKey);
    transaction.oncomplete = () => {
      try { resolve(cachedRelease(snapshot.result, recovery.result)); }
      catch (error) { reject(error); }
    };
    transaction.onabort = () => reject(transaction.error ?? new Error('Кеш недоступен.'));
  });
}

function cachedRelease(value, recovery) {
  if (!value) return null;
  const snapshot = validateSnapshot(value);
  const applies = recovery?.publication === publicationIdentity(snapshot);
  return {snapshot, restoredAt: applies ? recovery.restoredAt : 0, locations: applies ? recovery.locations : null};
}

export async function saveSnapshot(candidate) {
  const db = await openCache();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('snapshots', 'readwrite');
    const store = transaction.objectStore('snapshots');
    const current = store.get(key), recovery = store.get(recoveryKey);
    let validationError, selected;
    recovery.onsuccess = () => {
      try { selected = selectRelease(candidate, cachedRelease(current.result, recovery.result)); }
      catch (error) { validationError = error; transaction.abort(); return; }
      store.put(selected.snapshot, key);
      if (selected.restoredAt) {
        store.put({publication: publicationIdentity(selected.snapshot), restoredAt: selected.restoredAt, locations: selected.locations}, recoveryKey);
      } else store.delete(recoveryKey);
    };
    transaction.oncomplete = () => resolve(selected);
    transaction.onabort = () => reject(validationError ?? transaction.error ?? new Error('Кеш не сохранился.'));
  });
}
