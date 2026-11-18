import {assertFreshEnough, validateSnapshot} from './source.js';

const key = 'published-demand';
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
    const request = db.transaction('snapshots').objectStore('snapshots').get(key);
    request.onsuccess = () => {
      try { resolve(request.result ? validateSnapshot(request.result) : null); }
      catch (error) { reject(error); }
    };
    request.onerror = () => reject(request.error);
  });
}

export async function saveSnapshot(snapshot) {
  const db = await openCache();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('snapshots', 'readwrite');
    const store = transaction.objectStore('snapshots');
    const current = store.get(key);
    let validationError;
    current.onsuccess = () => {
      try { assertFreshEnough(snapshot, current.result); }
      catch (error) { validationError = error; transaction.abort(); return; }
      store.put(snapshot, key);
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(validationError ?? transaction.error ?? new Error('Кеш не сохранился.'));
  });
}
