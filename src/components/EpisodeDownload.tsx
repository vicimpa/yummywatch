import type { ComponentChildren, FunctionalComponent as FC } from 'preact';
import { useId, useMemo, useState } from 'preact/hooks';

import {
  changeDownload,
  createDownloadRequest,
  downloadSourceFamily,
  downloadError,
  downloadPercent,
  downloadPath,
  downloadQualities,
  downloadedQuality,
  downloads,
  downloadsAvailable,
  enqueueDownloads,
  useDownloads,
  type Download,
  type DownloadRequest,
} from '~/lib/downloads';
import { notify } from '~/lib/notifications';
import { voiceKey, type Stream } from '~/lib/streams';
import type { Anime, Video } from '~/lib/types';
import { Button, ButtonLink, Dropdown, Icon } from '~/ui';
import './Downloads.css';

type EpisodeActions = {
  entries: Download[];
  request?: DownloadRequest;
};

export type EpisodeDownloads = (episode: string) => EpisodeActions;

type Options = {
  open: boolean;
  anime: Anime;
  videos: Video[];
  voice: string;
  quality: number;
  entries?: Download[];
  online?: boolean;
  active?: { stream: Stream; video: Video };
};

export function useEpisodeDownloads({
  open,
  anime,
  videos,
  voice,
  quality,
  active,
  entries,
  online = true,
}: Options) {
  const enabled = open && downloadsAvailable();
  const [source, setSource] = useState('');
  const [maxQuality, setMaxQuality] = useState('');
  useDownloads(enabled && entries === undefined);
  const queue = enabled ? (entries ?? downloads.value) : undefined;
  const dubbingKey = voiceKey(voice);
  const { byEpisode, sourceFamilies } = useMemo(() => {
    const grouped = new Map<string, Video[]>();
    const families = new Set<string>();
    if (enabled) {
      for (const video of videos) {
        if (voiceKey(video.data.dubbing) !== dubbingKey) continue;
        const family = downloadSourceFamily(video);
        if (!family) continue;
        families.add(family);
        const candidates = grouped.get(video.number);
        if (candidates) candidates.push(video);
        else grouped.set(video.number, [video]);
      }
    }
    return { byEpisode: grouped, sourceFamilies: [...families] };
  }, [enabled, videos, dubbingKey]);
  const jobs = useMemo(() => {
    const grouped = new Map<string, Download[]>();
    for (const job of queue || []) {
      if (job.animeId !== anime.anime_id || voiceKey(job.voice) !== dubbingKey) continue;
      const entries = grouped.get(job.episode);
      if (entries) entries.push(job);
      else grouped.set(job.episode, [job]);
    }
    return grouped;
  }, [queue, anime.anime_id, dubbingKey]);

  if (!enabled) return undefined;

  const selectedSource = sourceFamilies.includes(source) ? source : '';
  const forEpisode: EpisodeDownloads = episode => {
    const entries = jobs.get(episode) || [];
    const all = byEpisode.get(episode) || [];
    const candidates = selectedSource
      ? all.filter(video => downloadSourceFamily(video) === selectedSource)
      : all;
    const requestVoice = candidates.some(video => video.data.dubbing === voice)
      ? voice
      : candidates[0]?.data.dubbing;
    const selected = maxQuality
      ? Number(maxQuality)
      : active?.video.number === episode &&
          candidates.some(video => video.video_id === active.video.video_id)
        ? active.stream.quality
        : quality;
    return {
      entries,
      request:
        online && requestVoice && !entries.length
          ? createDownloadRequest(anime, candidates, episode, requestVoice, selected, active)
          : undefined,
    };
  };
  const season = [...byEpisode.keys()]
    .sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }))
    .flatMap(episode => forEpisode(episode).request ?? []);
  return {
    forEpisode,
    season,
    online,
    sourceFamilies,
    selectedSource,
    setSource,
    maxQuality,
    setMaxQuality,
  };
}

type DownloadControls = NonNullable<ReturnType<typeof useEpisodeDownloads>>;

export const EpisodeDownloadToolbar: FC<{
  controls?: DownloadControls;
  onClick?: () => void;
  showQueueLink?: boolean;
  actions?: ComponentChildren;
}> = ({ controls, onClick, showQueueLink = true, actions }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const fields = useId();
  if (
    !controls ||
    ((!controls.online || !controls.sourceFamilies.length) && !showQueueLink && !actions)
  )
    return null;
  const canSetUp = controls.sourceFamilies.length > 0 && controls.online;
  const addSeason = async () => {
    setBusy(true);
    setError('');
    try {
      await enqueueDownloads(controls.season);
      notify('Серии сезона добавлены в загрузки');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="episode-download-toolbar">
      <div class="episode-download-shortcuts">
        {canSetUp && (
          <>
            <Button
              variant="secondary"
              type="button"
              disabled={busy}
              aria-disabled={!controls.season.length || undefined}
              aria-busy={busy}
              onClick={() => controls.season.length && void addSeason()}
            >
              <Icon name="download" size={16} />
              {busy
                ? 'Добавляем…'
                : controls.season.length
                  ? `Скачать сезон · ${controls.season.length}`
                  : 'Сезон в загрузках'}
            </Button>
            <Button
              variant="text"
              type="button"
              aria-expanded={advanced}
              aria-controls={fields}
              aria-label="Параметры скачивания"
              onClick={() => setAdvanced(value => !value)}
            >
              <Icon name="settings" size={16} /> Параметры
            </Button>
          </>
        )}
        {showQueueLink && (
          <ButtonLink href="#/downloads?status=all" variant="text" onClick={onClick}>
            Управление загрузками
          </ButtonLink>
        )}
        {actions}
      </div>
      {canSetUp && (
        <div class="episode-download-fields" id={fields} hidden={!advanced}>
          <div class="download-source-field">
            <span>Источник</span>
            <Dropdown
              aria-label="Источник загрузки серии"
              value={controls.selectedSource}
              onChange={controls.setSource}
              options={[
                { value: '', label: 'Авто' },
                ...controls.sourceFamilies.map(family => ({ value: family, label: family })),
              ]}
            />
          </div>
          <div class="download-source-field">
            <span>Качество</span>
            <Dropdown
              aria-label="Качество загрузки серии"
              value={controls.maxQuality}
              onChange={controls.setMaxQuality}
              options={[
                { value: '', label: 'Как в плеере' },
                ...downloadQualities.map(quality => ({
                  value: String(quality),
                  label: `До ${quality}p`,
                })),
              ]}
            />
          </div>
        </div>
      )}
      {showQueueLink && downloadError.value && <small role="status">{downloadError.value}</small>}
      {error && (
        <small class="download-error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
};

export const DownloadEpisodeButton: FC<{ request: DownloadRequest; iconOnly?: boolean }> = ({
  request,
  iconOnly,
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      await enqueueDownloads([request]);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant={iconOnly ? 'icon' : 'text'}
        disabled={busy}
        aria-busy={busy || undefined}
        aria-label={`Скачать серию ${request.episode} · ${request.quality}p`}
        title={`Скачать · ${request.quality}p`}
        onClick={() => void start()}
      >
        <Icon name="download" size={16} />
        {!iconOnly && (busy ? 'Добавляем…' : 'Скачать')}
      </Button>
      {error && (
        <small class="download-error" role="alert">
          {error}
        </small>
      )}
    </>
  );
};

export const EpisodeWithDownload: FC<{
  children: ComponentChildren;
  episode: string;
  downloads?: EpisodeDownloads;
  selected?: boolean;
  onOpenSaved?: () => void;
  savedFrom?: 'about';
  primarySavedId?: string;
}> = ({ children, episode, downloads, selected, onOpenSaved, savedFrom, primarySavedId }) => {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState('');
  if (!downloads) return <>{children}</>;
  const { entries, request } = downloads(episode);
  if (!entries.length && !request) return <>{children}</>;
  const saved = entries.some(entry => entry.status === 'ready' && entry.stream);

  const run = async (id: string, action: 'retry' | 'cancel') => {
    setBusy(id);
    setError('');
    try {
      await changeDownload(id, action);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div
      class={`episode-with-download${saved ? ' is-downloaded' : ''}${selected ? ' selected' : ''}`}
    >
      {children}
      <div class="episode-download-actions">
        {request && <DownloadEpisodeButton request={request} />}
        {entries.map(entry => {
          const quality = `${downloadedQuality(entry)}p`;
          const label = `серии ${episode} · ${quality}`;
          if (entry.status === 'ready') {
            const status = (
              <>
                <Icon name="check" size={15} />
                <span>
                  Скачано <small>{quality}</small>
                </span>
              </>
            );
            if (entry.id === primarySavedId)
              return (
                <div key={entry.id} class="episode-download-ready-state">
                  {status}
                </div>
              );
            return (
              <ButtonLink
                key={entry.id}
                href={downloadPath(entry, savedFrom)}
                variant="text"
                class="episode-download-ready"
                aria-label={`Смотреть офлайн серию ${episode} · ${quality}`}
                onClick={onOpenSaved}
              >
                {status}
              </ButtonLink>
            );
          }

          const percent = downloadPercent(entry);
          const downloading = entry.status === 'downloading';
          const retry = entry.status === 'paused' || entry.status === 'failed';
          return (
            <div class="episode-download-job" key={entry.id}>
              <div>
                {retry ? (
                  <Button
                    type="button"
                    variant="text"
                    disabled={!!busy}
                    aria-label={`${entry.status === 'paused' ? 'Возобновить' : 'Повторить'} загрузку ${label}`}
                    title={entry.error || undefined}
                    onClick={() => void run(entry.id, 'retry')}
                  >
                    {entry.status === 'paused' ? 'Возобновить' : 'Повторить'}
                  </Button>
                ) : (
                  <span class="episode-download-state">
                    {downloading
                      ? percent === undefined
                        ? 'Подготовка…'
                        : `${percent}%`
                      : entry.status === 'waiting'
                        ? entry.waitingFor === 'storage'
                          ? 'Ожидает места на диске'
                          : 'Ожидает повтора'
                        : 'В очереди'}
                  </span>
                )}
                <small>{quality}</small>
                {downloading && (
                  <progress value={percent} max={100} aria-label={`Прогресс загрузки ${label}`} />
                )}
              </div>
              <Button
                type="button"
                variant="icon"
                disabled={!!busy}
                aria-label={`Отменить загрузку ${label}`}
                title="Отменить загрузку"
                onClick={() => void run(entry.id, 'cancel')}
              >
                <Icon name="close" size={16} />
              </Button>
            </div>
          );
        })}
        {error && (
          <small class="download-error" role="alert">
            {error}
          </small>
        )}
      </div>
    </div>
  );
};
