import { readJSON, writeJSON } from './storage';
import type { Result } from './types';

export const dataRequests = new Map<string, Promise<Result<unknown>>>();
export let cacheGeneration = 0;

export function resetRequests() {
  cacheGeneration++;
  dataRequests.clear();
}

export interface CacheEntry<T = unknown> {
  key: string;
  kind: 'data' | 'image' | 'frame';
  data: T;
  savedAt: number;
  bytes: number;
}

const entries = new Map<string, CacheEntry>();
const limits = { data: 16 * 1024 * 1024, image: 128 * 1024 * 1024, frame: 24 * 1024 * 1024 };
let legacyRead = false,
  db: IDBDatabase | undefined,
  opening: Promise<void> | undefined;
const dirty = new Set<string>();
let diskUnavailable = typeof indexedDB === 'undefined';

const id = (kind: CacheEntry['kind'], key: string) => `${kind}:${key}`;

function legacy() {
  if (legacyRead) return;
  legacyRead = true;

  const saved = {
    ...readJSON<Record<string, { data: unknown; savedAt: number }>>('yumiwatch:api:v1', {}),
    ...readJSON<Record<string, { data: unknown; savedAt: number }>>('yumiwatch:api:private:v1', {}),
  };

  for (const [key, value] of Object.entries(saved))
    if (value && Number.isFinite(value.savedAt)) {
      const split = key.indexOf('?'),
        params = new URLSearchParams(key.slice(split + 1));

      params.sort();
      putCache(
        'data',
        split < 0 ? key : `${key.slice(0, split)}?${params}`,
        value.data,
        value.savedAt,
        false
      );
    }
}

function persist(entry: CacheEntry) {
  if (db) {
    const database = db;

    const write = (data: unknown) => {
      try {
        database
          .transaction('entries', 'readwrite')
          .objectStore('entries')
          .put({ ...entry, data, id: id(entry.kind, entry.key) });
        dirty.delete(id(entry.kind, entry.key));
      } catch {
        /* Caching never blocks a screen. */
      }
    };

    // WebKit's ephemeral stores can reject Blob records. Raw bytes are portable
    // and restore into an ordinary in-memory Blob before rendering the app.
    if (entry.kind !== 'data')
      void (entry.data as Blob)
        .arrayBuffer()
        .then(bytes => {
          if (entries.get(id(entry.kind, entry.key))?.data === entry.data)
            write({ bytes, mime: (entry.data as Blob).type });
        })
        .catch(() => {});
    else write(entry.data);
  } else if (entry.kind === 'data' && diskUnavailable) {
    const privateEntry = entry.key.startsWith('account:');
    const saved = Object.fromEntries(
      [...entries.values()]
        .filter(e => e.kind === 'data' && e.key.startsWith('account:') === privateEntry)
        .slice(-35)
        .map(e => [e.key, { data: e.data, savedAt: e.savedAt }])
    );

    writeJSON(privateEntry ? 'yumiwatch:api:private:v1' : 'yumiwatch:api:v1', saved);
  }
}

export function getCache<T>(kind: CacheEntry['kind'], key: string): CacheEntry<T> | undefined {
  legacy();

  const address = id(kind, key),
    entry = entries.get(address);

  if (entry) {
    entries.delete(address);
    entries.set(address, entry);
  }

  return entry as CacheEntry<T> | undefined;
}

export const hasCache = (kind: CacheEntry['kind'], key: string) => entries.has(id(kind, key));

export function putCache<T>(
  kind: CacheEntry['kind'],
  key: string,
  data: T,
  savedAt = Date.now(),
  save = true
) {
  const bytes = kind !== 'data' ? (data as Blob).size : (JSON.stringify(data)?.length || 0) * 2;

  if (bytes > limits[kind]) return;

  const entry = { key, kind, data, savedAt, bytes };
  const address = id(kind, key);

  entries.delete(address);
  entries.set(address, entry);

  let total = 0;
  const recent = [...entries.values()].filter(e => e.kind === kind).reverse();

  for (let index = 0; index < recent.length; index++) {
    const value = recent[index];

    total += value.bytes;
    if (total > limits[kind] || index >= (kind === 'frame' ? 128 : 512))
      deleteCache(kind, value.key);
  }
  if (save) {
    dirty.add(address);
    persist(entry);
  }
}

export function deleteCache(kind: CacheEntry['kind'], key: string) {
  entries.delete(id(kind, key));
  if (db) {
    try {
      db.transaction('entries', 'readwrite').objectStore('entries').delete(id(kind, key));
    } catch {
      /* Best effort. */
    }
  } else if (kind === 'data' && typeof indexedDB === 'undefined') {
    const address = key.startsWith('account:') ? 'yumiwatch:api:private:v1' : 'yumiwatch:api:v1';
    const saved = readJSON<Record<string, unknown>>(address, {});

    delete saved[key];
    writeJSON(address, saved);
  }
}

export function initializeCache(): Promise<void> {
  legacy();
  if (opening) return opening;
  opening = new Promise(resolve => {
    if (typeof indexedDB === 'undefined') {
      resolve();

      return;
    }

    let request: IDBOpenDBRequest;

    try {
      request = indexedDB.open('yumiwatch-cache-v1', 1);
    } catch {
      resolve();

      return;
    }
    request.onupgradeneeded = () => request.result.createObjectStore('entries', { keyPath: 'id' });
    request.onerror = () => {
      diskUnavailable = true;
      for (const entry of entries.values()) persist(entry);
      resolve();
    };
    request.onblocked = () => resolve();
    request.onsuccess = () => {
      db = request.result;
      db.onversionchange = () => {
        db?.close();
        db = undefined;
      };

      const load = db.transaction('entries', 'readonly').objectStore('entries').getAll();

      load.onerror = () => resolve();
      load.onsuccess = () => {
        const saved = (load.result as CacheEntry[])
          .flatMap(e => {
            if (
              !['data', 'image', 'frame'].includes(e.kind) ||
              typeof e.key !== 'string' ||
              !Number.isFinite(e.savedAt)
            )
              return [];
            if (e.kind !== 'data' && !(e.data instanceof Blob)) {
              const image = e.data as { bytes?: ArrayBuffer; mime?: string };

              if (!(image?.bytes instanceof ArrayBuffer) || !image.mime?.startsWith('image/'))
                return [];

              return [{ ...e, data: new Blob([image.bytes], { type: image.mime }) }];
            }

            return [e];
          })
          .sort((a, b) => a.savedAt - b.savedAt);
        const diskKeys = new Set(saved.map(entry => id(entry.kind, entry.key)));

        for (const entry of saved) {
          const previous = entries.get(id(entry.kind, entry.key));

          if (!previous || previous.savedAt <= entry.savedAt)
            putCache(entry.kind, entry.key, entry.data, entry.savedAt, false);
        }
        for (const entry of entries.values())
          if (!diskKeys.has(id(entry.kind, entry.key)) || dirty.has(id(entry.kind, entry.key)))
            persist(entry);
        resolve();
      };
    };
  });

  return opening;
}

const isPreservedData = (entry: Pick<CacheEntry, 'kind' | 'key'>) =>
  entry.kind === 'data' && /:chat:v1:thread:/.test(entry.key);

export const clearedAt = { data: 0, image: 0, frame: 0 };

export async function appCacheSizes() {
  await initializeCache();
  const sizes = { data: 0, image: 0, frame: 0 };
  for (const entry of entries.values())
    if (!isPreservedData(entry)) sizes[entry.kind] += entry.bytes;
  return sizes;
}

export async function clearAppCache(kind: CacheEntry['kind']) {
  await initializeCache();
  resetRequests();
  clearedAt[kind] = Date.now();
  if (db) {
    await new Promise<void>((resolve, reject) => {
      const transaction = db!.transaction('entries', 'readwrite');
      const request = transaction.objectStore('entries').openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (cursor.value.kind === kind && !isPreservedData(cursor.value)) cursor.delete();
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new Error('Не удалось очистить кэш.'));
    });
  }
  for (const [key, entry] of entries) {
    if (entry.kind !== kind || isPreservedData(entry)) continue;
    entries.delete(key);
    dirty.delete(key);
  }
  if (kind === 'data') {
    for (const key of ['yumiwatch:api:v1', 'yumiwatch:api:private:v1']) {
      const saved = readJSON<Record<string, unknown>>(key, {});
      const preserve = Object.fromEntries(
        Object.entries(saved).filter(([key]) => isPreservedData({ kind, key }))
      );
      if (Object.keys(preserve).length) writeJSON(key, preserve);
      else localStorage.removeItem(key);
    }
  }
}

export function resetMemoryCache() {
  resetRequests();
  entries.clear();
  dirty.clear();
  diskUnavailable = typeof indexedDB === 'undefined';
  legacyRead = false;
  opening = undefined;
  db?.close();
  db = undefined;
}
