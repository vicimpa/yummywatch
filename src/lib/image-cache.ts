import { clearedAt, getCache, hasCache, putCache } from './cache-store';
import { desktopInvoke, isDesktop } from './desktop';

const urls = new Map<string, { blob: Blob; url: string }>(),
  listeners = new Map<string, Set<() => void>>();

interface ImageRequest {
  url: string;
  priority: boolean;
  started: boolean;
  generation: number;
  consumers: Set<symbol>;
  promise: Promise<void>;
  finish: () => void;
}

const pending = new Map<string, ImageRequest>(),
  checked = new Map<string, number>();
let generation = 0,
  active = 0,
  background = 0;
const queue: ImageRequest[] = [];

export const canCacheImages = () =>
  typeof indexedDB !== 'undefined' && typeof URL.createObjectURL === 'function';

export function normalizeImage(url?: string) {
  try {
    const value = new URL(url || '', 'https://static.yani.tv');

    return url && value.protocol === 'https:' ? value.href : '';
  } catch {
    return '';
  }
}

export function beginImageRefresh() {
  generation++;
  for (const [key, epoch] of checked) if (epoch < generation - 1) checked.delete(key);
}

export function cachedImage(url: string, kind: 'image' | 'frame' = 'image') {
  if (!canCacheImages()) return url;

  const entry = getCache<Blob>(kind, url);

  if (!entry) return '';

  const previous = urls.get(url);

  if (previous?.blob === entry.data) return previous.url;

  const value = URL.createObjectURL(entry.data);

  urls.set(url, { blob: entry.data, url: value });
  if (previous) {
    const revoke = URL.revokeObjectURL.bind(URL);

    setTimeout(() => revoke(previous.url), 1000);
  }
  for (const [key, entry] of urls)
    if (!hasCache('image', key) && !hasCache('frame', key) && !listeners.get(key)?.size) {
      urls.delete(key);
      URL.revokeObjectURL(entry.url);
    }

  return value;
}

export function subscribeImage(url: string, listener: () => void) {
  const group = listeners.get(url) || new Set();

  group.add(listener);
  listeners.set(url, group);

  return () => {
    group.delete(listener);
    if (!group.size) listeners.delete(url);
  };
}

export function storeWatchFrame(key: string, image: Blob, savedAt: number) {
  if (savedAt < clearedAt.frame) return;
  putCache('frame', key, image, savedAt);
  for (const listener of listeners.get(key) || []) listener();
}

async function fetchImage(url: string) {
  if (isDesktop()) {
    const result = await desktopInvoke<{ data: string; mime: string }>('fetch_image', { url });

    return new Blob([Uint8Array.from(atob(result.data), value => value.charCodeAt(0))], {
      type: result.mime,
    });
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    credentials: 'omit',
    cache: 'no-cache',
  });

  if (!response.ok) throw new Error('Image unavailable');

  return response.blob();
}

export async function posterBlob(url: string): Promise<Blob> {
  return getCache<Blob>('image', url)?.data || fetchImage(url);
}

async function execute(request: ImageRequest) {
  const started = Date.now();
  try {
    const blob = await fetchImage(request.url);

    if (!blob.type.startsWith('image/') || blob.size > 8 * 1024 * 1024) return;

    const old = getCache<Blob>('image', request.url)?.data;
    let same = false;

    if (old?.size === blob.size && old.type === blob.type) {
      const [a, b] = await Promise.all([old.arrayBuffer(), blob.arrayBuffer()]);
      const bytes = new Uint8Array(b);

      same = new Uint8Array(a).every((value, index) => value === bytes[index]);
    }
    if (!same && started >= clearedAt.image) {
      putCache('image', request.url, blob);
      for (const listener of listeners.get(request.url) || []) listener();
    }
  } catch {
    /* A saved image remains usable when its background refresh fails. */
  } finally {
    checked.set(request.url, request.generation);
    pending.delete(request.url);
    request.finish();
  }
}

function run() {
  // Reserve capacity for cold visible images; revalidation uses at most two slots.
  while (active < 6 && queue.length) {
    const foreground = queue.findIndex(request => request.priority);

    if (foreground < 0 && background >= 2) return;

    const request = queue.splice(foreground < 0 ? 0 : foreground, 1)[0];

    request.started = true;
    active++;
    if (!request.priority) background++;
    void execute(request).finally(() => {
      active--;
      if (!request.priority) background--;
      run();
    });
  }
}

export function refreshImage(url: string, priority = false, signal?: AbortSignal): Promise<void> {
  if (!url || !canCacheImages() || signal?.aborted) return Promise.resolve();

  let request = pending.get(url);

  if (!request) {
    if (checked.get(url) === generation) return Promise.resolve();

    let finish!: () => void;
    const promise = new Promise<void>(resolve => {
      finish = resolve;
    });

    request = { url, priority, started: false, generation, consumers: new Set(), promise, finish };
    pending.set(url, request);
    queue.push(request);
  } else if (priority && !request.started) {
    request.priority = true;
  }

  const current = request,
    consumer = Symbol();

  current.consumers.add(consumer);

  const cancel = () => {
    current.consumers.delete(consumer);
    if (!current.started && !current.consumers.size) {
      const index = queue.indexOf(current);

      if (index >= 0) queue.splice(index, 1);
      pending.delete(url);
      current.finish();
    }
  };

  signal?.addEventListener('abort', cancel, { once: true });
  void current.promise.then(() => signal?.removeEventListener('abort', cancel));
  // A started IPC request finishes under the cap: aborting its JS promise
  // would not cancel Rust's network request and would falsely free a slot.
  run();

  return current.promise;
}
