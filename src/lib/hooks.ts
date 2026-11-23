import { flushSync } from 'preact/compat';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import { ApiError } from './api';
import { beginImageRefresh } from './image-cache';
import { INTERFACE_EVENT, interfaceSettings } from './interface-settings';
import { getLibraryState } from './library';
import { rememberPageScroll, restorePageScroll } from './page-scroll';
import { pageDirection, pageSlide } from './page-transitions';
import { canonicalPath, initializeNavigation, recordNavigation } from './navigation';
import { getSession, restoreStoredSession, SESSION_EVENT, SESSION_KEY } from './session';
import { LIBRARY_EVENT } from './storage';
import { isTvMode } from './tv-mode';
import type { Result } from './types';

export function useResource<T>(
  loader: (signal: AbortSignal) => Promise<Result<T>>,
  deps: unknown[],
  peek?: () => Result<T> | undefined
) {
  const [value, setValue] = useState<Result<T> | undefined>(() => peek?.());
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!value);
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision(n => n + 1), []);
  const [refreshing, setRefreshing] = useState(!!value);
  const previousDeps = useRef<unknown[]>();
  const latest = useRef(value);

  latest.current = value;

  const different =
    !!previousDeps.current &&
    deps.some((dep, index) => !Object.is(dep, previousDeps.current![index]));
  const visible = different ? peek?.() : value;

  useEffect(() => {
    const controller = new AbortController();
    const changed =
      !previousDeps.current ||
      deps.some((dep, index) => !Object.is(dep, previousDeps.current![index]));

    previousDeps.current = [...deps];

    const seed = changed ? peek?.() : latest.current;

    setError('');
    setRefreshing(!!seed);
    setLoading(!seed);
    if (changed) setValue(seed);
    void (async () => {
      try {
        const result = await loader(controller.signal);

        if (controller.signal.aborted) return;
        setValue(result);
        setLoading(false);
        setRefreshing(!!result.revalidate);
        if (result.revalidate) {
          const fresh = await result.revalidate;

          if (!controller.signal.aborted) setValue(fresh);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && [401, 403, 404].includes(error.status))
          setValue(undefined);
        setError((error as Error).message);
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })();

    return () => controller.abort();
  }, [...deps, revision]);

  return {
    value: visible,
    error: different ? '' : error,
    loading: different ? !visible : loading,
    refreshing,
    retry,
  };
}

export function useLibrary() {
  const [library, setLibrary] = useState(getLibraryState);

  useEffect(() => {
    const update = () => setLibrary({ ...getLibraryState() });

    window.addEventListener(LIBRARY_EVENT, update);
    window.addEventListener(SESSION_EVENT, update);
    window.addEventListener('storage', update);
    update(); // A fast account restore may finish between render and subscribing.

    return () => {
      window.removeEventListener(LIBRARY_EVENT, update);
      window.removeEventListener(SESSION_EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, []);

  return library;
}

export function useSession() {
  const [session, setSession] = useState(getSession);

  useEffect(() => {
    const update = () => setSession(getSession());

    const storage = (event: StorageEvent) => {
      if (event.key === SESSION_KEY || event.key === null) restoreStoredSession();
    };

    window.addEventListener(SESSION_EVENT, update);
    window.addEventListener('storage', storage);
    update();

    return () => {
      window.removeEventListener(SESSION_EVENT, update);
      window.removeEventListener('storage', storage);
    };
  }, []);

  return session;
}

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches || false);

  useEffect(() => {
    const media = window.matchMedia?.(query);

    if (!media) return;

    const update = () => setMatches(media.matches);

    update();
    media.addEventListener('change', update);

    return () => media.removeEventListener('change', update);
  }, [query]);

  return matches;
}

function readPath() {
  const raw = location.hash.slice(1) || '/';
  const path = canonicalPath(raw);
  if (path !== raw) history.replaceState(history.state, '', `#${path}`);
  return path;
}

export function useHash() {
  const [path, setPath] = useState(readPath);
  const current = useRef(path);
  const cancelScrollRestore = useRef<() => void>(() => {});

  useEffect(() => {
    const previousRestoration = history.scrollRestoration;
    initializeNavigation();

    history.scrollRestoration = 'manual';

    let sequence = 0,
      transition: ViewTransition | undefined,
      arrival: Animation | undefined,
      arrivalFrame = 0;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

    const motion = () => interfaceSettings().animations && !reducedMotion?.matches;

    const update = () => {
      const next = readPath();
      const travel = recordNavigation();
      beginImageRefresh();

      const navigation = ++sequence;

      transition?.skipTransition();
      arrival?.cancel();
      arrival = undefined;
      cancelAnimationFrame(arrivalFrame);
      delete document.documentElement.dataset.pageFallback;
      rememberPageScroll(current.current);
      cancelScrollRestore.current();

      const direction =
          travel === 'back' && pageDirection(current.current, next)
            ? 'back'
            : pageDirection(current.current, next),
        animate = !!direction && motion();

      if (direction) document.documentElement.dataset.pageDirection = direction;

      const commit = () => {
        // A skipped transition still runs its callback; only the latest navigation may commit.
        if (navigation !== sequence) return;
        current.current = next;
        flushSync(() => setPath(next));
        cancelScrollRestore.current = restorePageScroll(next);
      };

      // WebKitGTK can abort the web process when a view transition starts with
      // the DMA-BUF renderer disabled. Use the slide below on Linux desktop.
      if (
        animate &&
        document.documentElement.dataset.desktop !== 'linux' &&
        document.startViewTransition
      ) {
        try {
          document.documentElement.dataset.pageTransition = 'active';

          const active = document.startViewTransition(commit);

          transition = active;
          void active.ready.catch(() => {});
          void active.finished
            .catch(() => {})
            .then(() => {
              if (transition === active) {
                transition = undefined;
                delete document.documentElement.dataset.pageTransition;
              }
            });

          return;
        } catch {
          delete document.documentElement.dataset
            .pageTransition; /* Older browsers still navigate and slide in the new screen. */
        }
      }
      commit();
      if (animate)
        arrivalFrame = requestAnimationFrame(() => {
          const element =
            document.querySelector<HTMLElement>('.media-workspace') ||
            document.getElementById('main');

          if (navigation !== sequence || !motion() || !element?.animate) return;
          document.documentElement.dataset.pageFallback = 'active';

          const active = element.animate(
            [
              { opacity: 0, transform: pageSlide(direction!) },
              { opacity: 1, transform: 'none' },
            ],
            { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' }
          );

          arrival = active;
          void active.finished
            .catch(() => {})
            .then(() => {
              if (arrival === active) {
                arrival = undefined;
                delete document.documentElement.dataset.pageFallback;
              }
            });
        });
    };

    const stopMotion = () => {
      if (!motion()) {
        transition?.skipTransition();
        arrival?.cancel();
        delete document.documentElement.dataset.pageFallback;
      }
    };

    window.addEventListener('hashchange', update);
    window.addEventListener(INTERFACE_EVENT, stopMotion);
    reducedMotion?.addEventListener('change', stopMotion);

    return () => {
      ++sequence;
      transition?.skipTransition();
      arrival?.cancel();
      cancelAnimationFrame(arrivalFrame);
      window.removeEventListener('hashchange', update);
      window.removeEventListener(INTERFACE_EVENT, stopMotion);
      reducedMotion?.removeEventListener('change', stopMotion);
      delete document.documentElement.dataset.pageFallback;
      delete document.documentElement.dataset.pageTransition;
      history.scrollRestoration = previousRestoration;
    };
  }, []);

  useLayoutEffect(() => {
    cancelScrollRestore.current = restorePageScroll(current.current);

    return () => cancelScrollRestore.current();
  }, []);

  return path;
}

export function useVisualViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const tv = isTvMode();

    const update = () => {
      const height = tv ? window.innerHeight : viewport?.height || window.innerHeight;
      const top = tv ? 0 : viewport?.offsetTop || 0;
      document.documentElement.style.setProperty('--visual-height', `${height}px`);
      document.documentElement.style.setProperty('--visual-top', `${top}px`);
      document.documentElement.dataset.keyboard =
        viewport && window.innerHeight - viewport.height > 140 ? 'open' : 'closed';
    };

    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    if (tv) window.addEventListener('resize', update);

    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      if (tv) window.removeEventListener('resize', update);
      delete document.documentElement.dataset.keyboard;
    };
  }, []);
}
