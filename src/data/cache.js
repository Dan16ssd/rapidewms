// A small key-value store in IndexedDB, which (unlike localStorage) holds a
// whole shop's data and survives the browser being closed. Three stores:
//   snap    the last copy of each shop from the server, so the app opens offline
//   queue   work done on this device that the server doesn't have yet
//   failed  queued work the server refused, kept for the owner to decide
// Without IndexedDB (the unit tests run in Node) it falls back to memory.
const STORES = ["snap", "queue", "failed"];

let opening = null;
const open = () =>
  (opening ||= new Promise((res, rej) => {
    const r = indexedDB.open("rapidewms", 1);
    r.onupgradeneeded = () => STORES.forEach((s) => r.result.objectStoreNames.contains(s) || r.result.createObjectStore(s));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));

const mem = Object.fromEntries(STORES.map((s) => [s, new Map()]));
const idb = typeof indexedDB != "undefined";

async function tx(store, mode, fn) {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode),
      r = fn(t.objectStore(store));
    t.oncomplete = () => res(r?.result);
    t.onerror = t.onabort = () => rej(t.error);
  });
}

// Structured copies, as IndexedDB makes, so a caller can't change what is stored.
const copy = (v) => (v === undefined ? v : structuredClone(v));

export const get = (store, key) =>
  idb ? tx(store, "readonly", (s) => s.get(key)) : Promise.resolve(copy(mem[store].get(key)));
export const put = (store, key, value) =>
  idb ? tx(store, "readwrite", (s) => s.put(value, key)) : (mem[store].set(key, copy(value)), Promise.resolve());
export const del = (store, key) =>
  idb ? tx(store, "readwrite", (s) => s.delete(key)) : (mem[store].delete(key), Promise.resolve());
export const all = (store) =>
  idb ? tx(store, "readonly", (s) => s.getAll()) : Promise.resolve([...mem[store].values()].map(copy));
