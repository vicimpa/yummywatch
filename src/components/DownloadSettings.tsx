import { useCallback, useEffect, useState } from 'preact/hooks';

import { appCacheSizes, clearAppCache } from '~/lib/cache-store';
import {
  clearDownloadStorage,
  downloadsAvailable,
  formatStorageBytes,
  readDownloadSettings,
  readDownloadStorage,
  saveDownloadSettings,
  type DownloadSettings,
  type DownloadStorage,
} from '~/lib/downloads';
import { Button, Dropdown, Field, FormError, Icon, SettingsCard, Sheet } from '~/ui';

const categories = [
  ['ready', 'Скачанные серии'],
  ['partial', 'Незавершённые загрузки'],
  ['video', 'Видеокэш'],
  ['data', 'Кэш данных приложения'],
  ['image', 'Кэш постеров'],
  ['frame', 'Кэш кадров'],
] as const;

type Category = (typeof categories)[number][0];

export function DownloadSettingsCard() {
  const available = downloadsAvailable();
  const [settings, setSettings] = useState<DownloadSettings>();
  const [usage, setUsage] = useState<DownloadStorage>();
  const [appCache, setAppCache] = useState<{ data: number; image: number; frame: number }>();
  const [pending, setPending] = useState<Category>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const [disk, cache] = await Promise.all([readDownloadStorage(), appCacheSizes()]);
    setUsage(disk);
    setAppCache(cache);
  }, []);

  useEffect(() => {
    if (!available) return;
    void Promise.all([readDownloadSettings().then(setSettings), refresh()]).catch(reason =>
      setError(reason.message)
    );
    const timer = setInterval(() => void refresh().catch(() => {}), 10000);
    return () => clearInterval(timer);
  }, [available, refresh]);

  const change = async (patch: Partial<DownloadSettings>) => {
    if (!settings || busy) return;
    setBusy(true);
    setError('');
    try {
      setSettings(await saveDownloadSettings({ ...settings, ...patch }));
      await refresh();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!pending || busy) return;
    setBusy(true);
    setError('');
    try {
      if (pending === 'ready' || pending === 'partial' || pending === 'video')
        await clearDownloadStorage(pending);
      else await clearAppCache(pending);
      setPending(undefined);
      await refresh();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!available) return null;
  const sizes = {
    ready: usage?.ready,
    partial: usage?.partial,
    video: usage?.videoCache,
    data: appCache?.data,
    image: appCache?.image,
    frame: appCache?.frame,
  };

  return (
    <SettingsCard title="Загрузки и место на диске" icon={<Icon name="download" size={25} />}>
      {settings && (
        <>
          <Field class="settings-choice" label="Одновременных загрузок">
            <Dropdown
              aria-label="Одновременных загрузок"
              value={String(settings.concurrent)}
              onChange={value => void change({ concurrent: Number(value) })}
              options={['1', '2', '3', '4', '5'].map(value => ({ value, label: value }))}
              disabled={busy}
            />
          </Field>
          <Field class="settings-choice" label="Серий в видеокэше">
            <Dropdown
              aria-label="Серий в видеокэше"
              value={String(settings.cachedEpisodes)}
              onChange={value => void change({ cachedEpisodes: Number(value) })}
              options={[
                { value: '0', label: 'Выключен' },
                { value: '1', label: '1 серия' },
                { value: '2', label: '2 серии' },
                { value: '3', label: '3 серии' },
              ]}
              disabled={busy}
            />
          </Field>
        </>
      )}
      {usage?.free != null && <p>Свободно на диске · {formatStorageBytes(usage.free)}</p>}
      <ul class="storage-categories">
        {categories.map(([id, label]) => (
          <li key={id}>
            <span>{label}</span>
            {sizes[id] !== undefined && (
              <span>
                {id === 'data' ? '≈ ' : ''}
                {formatStorageBytes(sizes[id]!)}
              </span>
            )}
            <Button
              variant="text"
              disabled={busy || sizes[id] === undefined}
              aria-label={`Удалить: ${label.toLowerCase()}`}
              onClick={() => setPending(id)}
            >
              {id === 'ready' || id === 'partial' ? 'Удалить' : 'Очистить'}
            </Button>
          </li>
        ))}
      </ul>
      {error && !pending && <FormError>{error}</FormError>}
      {pending && (
        <Sheet
          title={categories.find(([id]) => id === pending)?.[1] ?? ''}
          subtitle={
            pending === 'partial'
              ? 'Незавершённые загрузки будут отменены, их файлы будут удалены.'
              : 'Эти данные будут удалены с устройства.'
          }
          close={() => !busy && setPending(undefined)}
        >
          <Button variant="text" disabled={busy} onClick={() => setPending(undefined)}>
            Отмена
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void clear()}>
            Удалить
          </Button>
          {error && <FormError>{error}</FormError>}
        </Sheet>
      )}
    </SettingsCard>
  );
}
