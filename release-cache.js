import {validateSnapshot} from './source.js';
import {selectRelease} from './rollback.js';

const legacyKey = 'published-demand';
const key = 'published-demand-release';
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

function cachedRelease(current, legacy) {
  if (current) return {...current, snapshot: validateSnapshot(current.snapshot)};
  if (!legacy) return null;
  return {snapshot: validateSnapshot(legacy), restoredAt: 0, locations: null};
}

export async function readSnapshot() {
  const db = await openCache();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('snapshots');
    const store = transaction.objectStore('snapshots');
    const current = store.get(key), legacy = store.get(legacyKey);
    transaction.oncomplete = () => {
      try { resolve(cachedRelease(current.result, legacy.result)); }
      catch (error) { reject(error); }
    };
    transaction.onabort = () => reject(transaction.error ?? new Error('Кеш недоступен.'));
  });
}

export async function saveSnapshot(candidate) {
  const db = await openCache();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('snapshots', 'readwrite');
    const store = transaction.objectStore('snapshots');
    const current = store.get(key), legacy = store.get(legacyKey);
    let validationError, selected;
    legacy.onsuccess = () => {
      try { selected = selectRelease(candidate, cachedRelease(current.result, legacy.result)); }
      catch (error) { validationError = error; transaction.abort(); return; }
      store.put(selected, key);
    };
    transaction.oncomplete = () => resolve(selected);
    transaction.onabort = () => reject(validationError ?? transaction.error ?? new Error('Кеш не сохранился.'));
  });
}
