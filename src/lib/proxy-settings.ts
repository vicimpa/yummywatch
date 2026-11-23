import { useEffect, useState } from 'preact/hooks';

import { desktopInvoke, isDesktop } from './desktop';

const PROXY_SETTINGS_EVENT = 'yumiwatch:proxy-settings';

export type ProxyPoolPreferences = {
  intervalSeconds: number;
  concurrentChecks: number;
  feeds: boolean[];
};

type ProxyChecks = { checked: number; passed: number; completedAt: number | null };

export type ProxyPoolReport = {
  preferences: ProxyPoolPreferences;
  customProxies: {
    id: number;
    address: string;
    authenticated: boolean;
    reachable: boolean | null;
  }[];
  feeds: [
    name: string,
    status: { addresses: number; updatedAt: number | null; error: string | null },
  ][];
  working: number;
  queued: number;
  probes: ProxyChecks;
  manualPending: boolean;
  lastManual: ProxyChecks | null;
  players: [name: string, attempts: number, successes: number, lastSuccessAt: number | null][];
};

export const loadProxyPool = (
  args: { preferences?: ProxyPoolPreferences; checkNow?: boolean },
  signal?: AbortSignal
) => desktopInvoke<ProxyPoolReport>('proxy_pool_report', args, signal);

export const editCustomProxy = (
  change: { action: 'add'; address: string } | { action: 'remove'; id: number }
) => desktopInvoke<ProxyPoolReport>('edit_custom_proxy', { change });

export async function saveProxyEnabled(enabled: boolean) {
  const saved = await desktopInvoke<boolean>('proxy_settings', { enabled });
  if (saved !== enabled) throw new Error('Не удалось сохранить настройки прокси.');
  window.dispatchEvent(new CustomEvent(PROXY_SETTINGS_EVENT, { detail: saved }));
}

export function useProxyEnabled() {
  const [enabled, setEnabled] = useState<boolean>();
  useEffect(() => {
    if (!isDesktop()) return;
    const controller = new AbortController();
    const update = (event: Event) => {
      // A newly saved preference takes precedence over the initial read.
      controller.abort();
      setEnabled((event as CustomEvent<boolean>).detail);
    };
    window.addEventListener(PROXY_SETTINGS_EVENT, update);
    void desktopInvoke<boolean>('proxy_settings', {}, controller.signal)
      .then(value => {
        if (typeof value === 'boolean' && !controller.signal.aborted) setEnabled(value);
      })
      .catch(() => {});
    return () => {
      controller.abort();
      window.removeEventListener(PROXY_SETTINGS_EVENT, update);
    };
  }, []);
  return enabled;
}

export const isProxyEligibleError = (message: string) =>
  /(?:Aksor|Alloha|CVH|Kodik) · (?:[^.]+\. )?(?:Источник вернул HTTP (?:403|451|5\d\d)|Нет связи с источником|Источник прервал ответ|Источник не ответил вовремя)\./.test(
    message
  ) ||
  /Aksor · (?:нет манифеста DASH \(HTTP 203\)|видеопоток недоступен \(HTTP (?:403|451|5\d\d)\))\./.test(
    message
  );
