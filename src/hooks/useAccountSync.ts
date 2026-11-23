import { useEffect } from 'preact/hooks';

import { initializeAccount } from '~/lib/account';
import { resetAccountLibrary, runWatchMaintenance, syncLibrary } from '~/lib/library';
import { notify } from '~/lib/notifications';
import { SESSION_STORAGE_ERROR, type Session } from '~/lib/session';

export function useAccountSync(session: Session | null) {
  useEffect(() => {
    const error = (event: Event) => notify((event as CustomEvent<string>).detail);

    window.addEventListener(SESSION_STORAGE_ERROR, error);

    return () => window.removeEventListener(SESSION_STORAGE_ERROR, error);
  }, []);

  useEffect(() => {
    runWatchMaintenance();
    const refresh = () => {
      if (document.visibilityState === 'visible') runWatchMaintenance();
    };
    const timer = setInterval(refresh, 60 * 60 * 1000);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [session?.token, session?.verified]);

  useEffect(() => {
    if (!session) {
      resetAccountLibrary();

      return;
    }
    if (!session.verified) {
      const restore = () => {
        void initializeAccount().catch(error => notify(error.message));
      };

      restore();
      window.addEventListener('online', restore);

      return () => window.removeEventListener('online', restore);
    }
    void syncLibrary();

    const refresh = () => {
      if (document.visibilityState === 'visible')
        void initializeAccount()
          .then(() => syncLibrary())
          .catch(error => notify(error.message));
    };

    const timer = setInterval(refresh, 60 * 60 * 1000);

    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);

    return () => {
      clearInterval(timer);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [session?.token, session?.verified]);
}
