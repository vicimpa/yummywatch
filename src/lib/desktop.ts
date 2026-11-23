import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { isApiUrl } from './api-endpoints';

// Kept for existing IPC consumers: the Rust backend also runs on phones.
export const isDesktop = () => isTauri();

export interface DesktopInfo {
  platform: 'macos' | 'windows' | 'linux' | 'android' | 'ios';
  nativeMpv?: boolean;
}

export const isDesktopWindow = () => isDesktop() && !document.documentElement.dataset.mobile;

let desktop: DesktopInfo | undefined;

export const hasAndroidMpv = () => desktop?.platform === 'android' && desktop.nativeMpv === true;

export function desktopMediaRoot() {
  const url = new URL(convertFileSrc('', 'yumiwatch-media'));

  return new URL(`${url.protocol}//${url.host}/`);
}

export const isDesktopMedia = (url: string) =>
  isDesktop() &&
  (url.startsWith('yumiwatch-media:') || /^https?:\/\/yumiwatch-media\.localhost\//.test(url));

export function handleDesktopLinkClick(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0) return;

  const link =
    event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;

  if (!link || link.hasAttribute('download')) return;
  if (link.getAttribute('href')?.startsWith('#')) return;

  const url = new URL(link.href, location.href);
  const current = new URL(location.href);

  // WKWebView's Location and URL disagree about custom-scheme origins and
  // empty root paths. Compare parsed addresses instead of opaque origins.
  if (
    url.protocol === current.protocol &&
    url.host === current.host &&
    (url.pathname || '/') === (current.pathname || '/') &&
    url.search === current.search &&
    url.username === current.username &&
    url.password === current.password
  )
    return;
  event.preventDefault();
  if (url.protocol !== 'https:') return;
  void import('@tauri-apps/plugin-opener')
    .then(({ openUrl }) => openUrl(url.href))
    .catch(() => {
      window.dispatchEvent(new CustomEvent('yumiwatch:external-error'));
    });
}

export async function initializeDesktop() {
  if (!isDesktop()) return;
  if (/\bYummyWatchTV\b/.test(navigator.userAgent)) {
    Object.assign(document.documentElement.dataset, {
      tv: 'true',
      motion: 'off',
      inputMode: 'keyboard',
    });
  }

  // Set the inset before the first paint, including the startup/error screen.
  const mobile = /Android/i.test(navigator.userAgent)
    ? 'android'
    : /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
      ? 'ios'
      : undefined;

  if (mobile) document.documentElement.dataset.mobile = mobile;
  else
    document.documentElement.dataset.desktop = navigator.platform.startsWith('Mac')
      ? 'macos'
      : navigator.platform.startsWith('Win')
        ? 'windows'
        : 'linux';
  desktop = await invoke<DesktopInfo>('desktop_info');
  if (desktop.platform === 'android' || desktop.platform === 'ios') {
    delete document.documentElement.dataset.desktop;
    document.documentElement.dataset.mobile = desktop.platform;
  } else {
    delete document.documentElement.dataset.mobile;
    document.documentElement.dataset.desktop = desktop.platform;
  }
  document.addEventListener('click', handleDesktopLinkClick);
}

/** Keep API requests independent of WebView CORS policies. */
export async function apiFetch(url: string, options: RequestInit): Promise<Response> {
  if (!isDesktop()) return fetch(url, options);

  const parsed = new URL(url);

  if (!isApiUrl(parsed)) throw new Error('Некорректный адрес API.');

  const result = await desktopInvoke<{ status: number; body: string }>(
    'yummy_request',
    {
      request: {
        origin: parsed.origin,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method || 'GET',
        headers: Object.fromEntries(new Headers(options.headers).entries()),
        body: typeof options.body === 'string' ? options.body : null,
      },
    },
    options.signal
  );

  return new Response([204, 205, 304].includes(result.status) ? null : result.body, {
    status: result.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function desktopInvoke<T>(
  command: string,
  args: Record<string, unknown>,
  signal?: AbortSignal | null
): Promise<T> {
  signal?.throwIfAborted();

  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
  });

  try {
    return await Promise.race([invoke<T>(command, args), cancelled]);
  } catch (error) {
    // Tauri serializes Rust Result::Err(String) as a rejected string. Consumers
    // expect Error.message; losing it leaves the player on an endless loader.
    if (error instanceof Error || error instanceof DOMException) throw error;
    throw new Error(typeof error === 'string' ? error : 'Не удалось выполнить запрос приложения.');
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

export const desktopFullscreen = () =>
  document.documentElement.dataset.desktopFullscreen === 'true';

export const desktopFullscreenChanging = () =>
  document.documentElement.dataset.desktopFullscreenChanging === 'true';

export function syncDesktopFullscreen(fullscreen: boolean) {
  if (document.documentElement.dataset.desktopFullscreen === String(fullscreen)) return;
  document.documentElement.dataset.desktopFullscreen = String(fullscreen);
  window.dispatchEvent(new Event('yumiwatch:fullscreen'));
}

let fullscreenChange: Promise<void> | undefined;

/** One window owns fullscreen across every route and player. */
export function toggleDesktopFullscreen(): Promise<void> {
  return changeDesktopFullscreen();
}

export function exitDesktopFullscreen(): Promise<void> {
  return changeDesktopFullscreen(false);
}

function changeDesktopFullscreen(target?: boolean): Promise<void> {
  if (!isDesktopWindow()) return Promise.resolve();

  return (fullscreenChange ??= (async () => {
    document.documentElement.dataset.desktopFullscreenChanging = 'true';
    const appWindow = getCurrentWindow();
    const current = await appWindow.isFullscreen();
    const fullscreen = target ?? !current;
    if (fullscreen === current) {
      syncDesktopFullscreen(current);
      return;
    }
    const focused = document.activeElement;

    if (document.documentElement.dataset.desktop === 'macos') {
      // Never wait for an animation notification in the keyboard handler. The Rust
      // observer repairs first-responder focus when AppKit actually finishes.
      await appWindow.setFullscreen(fullscreen);
      syncDesktopFullscreen(fullscreen);
      // Also keep compatibility with a running backend during frontend HMR.
      await appWindow.setFocus();
      await getCurrentWebview().setFocus();
      const target =
        focused instanceof HTMLElement &&
        focused !== document.body &&
        focused.isConnected &&
        !focused.matches('.video-hit-area,.sidebar-backdrop') &&
        !focused.closest('[inert]')
          ? focused
          : (document.querySelector<HTMLElement>('.video-controls:not([inert])') ??
            document.getElementById('main'));

      target?.focus({ preventScroll: true });
    } else await appWindow.setFullscreen(fullscreen);
    syncDesktopFullscreen(fullscreen);
  })().finally(() => {
    delete document.documentElement.dataset.desktopFullscreenChanging;
    fullscreenChange = undefined;
  }));
}

type BrowserFullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
};

export function browserFullscreenElement() {
  const doc = document as BrowserFullscreenDocument;
  return doc.fullscreenElement || doc.webkitFullscreenElement;
}

export async function exitBrowserFullscreen() {
  const doc = document as BrowserFullscreenDocument;
  if (doc.fullscreenElement) await doc.exitFullscreen();
  else if (doc.webkitFullscreenElement) doc.webkitExitFullscreen?.();
}

export async function exitPlayerFullscreen() {
  // Browser fullscreen belongs to the player; desktop fullscreen belongs to the app.
  if (!isDesktopWindow()) await exitBrowserFullscreen();
}
