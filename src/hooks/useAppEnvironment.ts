import { useEffect, useState } from 'preact/hooks';

export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const connect = () => setOnline(true);
    const disconnect = () => setOnline(false);
    window.addEventListener('online', connect);
    window.addEventListener('offline', disconnect);
    return () => {
      window.removeEventListener('online', connect);
      window.removeEventListener('offline', disconnect);
    };
  }, []);

  return online;
}

export function useAppEnvironment() {
  const online = useOnline();

  useEffect(() => {
    let focusTimer: ReturnType<typeof setTimeout>;

    const focusSearch = () => document.getElementById('anime-search')?.focus();

    const keyboard = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== 'k') return;

      event.preventDefault();

      if (location.hash.startsWith('#/search')) {
        focusSearch();

        return;
      }

      location.hash = '/search';
      clearTimeout(focusTimer);
      focusTimer = setTimeout(focusSearch, 100);
    };

    window.addEventListener('keydown', keyboard);

    return () => {
      clearTimeout(focusTimer);
      window.removeEventListener('keydown', keyboard);
    };
  }, []);

  return online;
}
