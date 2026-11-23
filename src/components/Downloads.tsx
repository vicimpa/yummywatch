import type { FunctionalComponent as FC } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { useOnline } from '~/hooks/useAppEnvironment';

import { animeVideos, imageUrl, peekAnimeDetail, peekAnimeVideos } from '~/lib/api';
import {
  changeDownload,
  createDownloadRequest,
  downloadable,
  downloadAnimePath,
  downloadError,
  downloadHistory,
  downloadPercent,
  downloadPath,
  downloadQualities,
  downloadedAnime,
  downloadedQuality,
  downloadSourceFamily,
  downloads,
  downloadsAvailable,
  enqueueDownloads,
  formatStorageBytes,
  matchesDownloadHistory,
  removeDownloads,
  useDownloads,
  type Download,
} from '~/lib/downloads';
import { isContinueHidden } from '~/lib/continue-cache';
import { useLibrary, useResource, useSession } from '~/lib/hooks';
import { useInterfaceSettings } from '~/lib/interface-settings';
import { notify } from '~/lib/notifications';
import { formatTime } from '~/lib/player';
import { episodePlaybackIndex } from '~/lib/playback-recovery';
import {
  groupVoices,
  preferredStreamQuality,
  voiceKey,
  voiceVideos,
  type Stream,
} from '~/lib/streams';
import { usePlaybackSettings } from '~/lib/playback-settings';
import type { Anime, Video, WatchEntry } from '~/lib/types';
import { watchFrameKey } from '~/lib/watch-frames';

import {
  Button,
  ButtonLink,
  ChoiceTabs,
  Dropdown,
  Empty,
  EpisodePreview,
  Icon,
  SearchField,
  Sheet,
  Sidebar,
} from '~/ui';
import { AppLink } from '~/ui/AppLink';
import {
  DownloadEpisodeButton,
  EpisodeDownloadToolbar,
  useEpisodeDownloads,
} from './EpisodeDownload';
import { EpisodeVoiceTabs } from './EpisodeVoiceTabs';
import { EpisodeListControls } from './EpisodeListControls';
import { Poster } from './Poster';
import './Downloads.css';

type PickerProps = {
  anime: Anime;
  videos: Video[];
  close: () => void;
  episode?: string;
  voice?: string;
  quality?: number;
  active?: { stream: Stream; video: Video };
};

const episodeOrder = (a: string, b: string) => a.localeCompare(b, 'ru', { numeric: true });
const NO_VIDEOS: Video[] = [];

function peekDownloadVideos(animeId: number) {
  const saved = peekAnimeVideos(animeId);
  if (saved) return saved;
  const anime = peekAnimeDetail(animeId);
  if (anime?.data.videos?.length)
    return { data: anime.data.videos, cached: anime.cached, savedAt: anime.savedAt };
}

export const DownloadPicker: FC<PickerProps> = ({
  anime,
  videos,
  close,
  episode,
  voice: initialVoice,
  quality: initialQuality = 480,
  active,
}) => {
  const voices = [...new Set(videos.filter(downloadable).map(video => video.data.dubbing))];
  const numbers = [...new Set(videos.map(video => video.number))].sort(episodeOrder);
  const [voice, setVoice] = useState(
    initialVoice && voices.includes(initialVoice)
      ? initialVoice
      : initialVoice
        ? ''
        : voices[0] || ''
  );
  const [quality, setQuality] = useState(String(initialQuality));
  const [source, setSource] = useState('');
  const [checked, setChecked] = useState(() => new Set(episode ? [episode] : []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useDownloads();

  const voiceVideos = videos.filter(video => video.data.dubbing === voice && downloadable(video));
  const sourceFamilies = [
    ...new Set(voiceVideos.flatMap(video => downloadSourceFamily(video) || [])),
  ];
  const selectedSource = sourceFamilies.find(family => family === source);
  const candidates = selectedSource
    ? voiceVideos.filter(video => downloadSourceFamily(video) === selectedSource)
    : voiceVideos;
  const available = new Set(candidates.map(video => video.number));
  const contains = (number: string) =>
    downloads.value?.some(
      entry =>
        entry.animeId === anime.anime_id &&
        entry.episode === number &&
        entry.voice === voice &&
        entry.quality === Number(quality)
    ) ?? false;
  const selection = numbers.filter(
    number => checked.has(number) && available.has(number) && !contains(number)
  );
  const season = numbers.filter(
    number =>
      available.has(number) &&
      !downloads.value?.some(
        entry =>
          entry.animeId === anime.anime_id && entry.episode === number && entry.voice === voice
      )
  );
  const next = numbers.slice(episode ? numbers.indexOf(episode) + 1 : 0).slice(0, 3);
  const qualities = [...new Set([...downloadQualities, initialQuality])].sort((a, b) => a - b);

  const submit = async (episodes: string[]) => {
    setBusy(true);
    setError('');
    try {
      await enqueueDownloads(
        episodes.map(number =>
          createDownloadRequest(anime, candidates, number, voice, Number(quality), active)
        )
      );
      close();
      notify(episodes.length === 1 ? 'Серия добавлена в загрузки' : 'Серии добавлены в загрузки');
    } catch (reason) {
      setError((reason as Error).message);
      setBusy(false);
    }
  };

  return (
    <Sidebar
      open
      title="Скачать серии"
      subtitle={anime.title}
      close={close}
      className="download-picker"
    >
      {voices.length ? (
        <div class="download-picker-layout">
          <div class="download-fields">
            <div>
              <span>Озвучка</span>
              <Dropdown
                aria-label="Озвучка для скачивания"
                value={voice}
                onChange={setVoice}
                options={voices.map(label => ({ value: label, label }))}
              />
            </div>
            <div>
              <span>Качество</span>
              <Dropdown
                aria-label="Качество для скачивания"
                value={quality}
                onChange={setQuality}
                options={qualities.map(value => ({ value: String(value), label: `До ${value}p` }))}
              />
            </div>
          </div>
          {sourceFamilies.length > 0 && (
            <label class="download-source-field">
              <span>Источник</span>
              <Dropdown
                aria-label="Источник для скачивания"
                value={selectedSource ?? ''}
                onChange={setSource}
                options={[
                  { value: '', label: 'Авто' },
                  ...sourceFamilies.map(family => ({ value: family, label: family })),
                ]}
              />
            </label>
          )}
          <div class="download-episode-tools">
            <strong>Серии</strong>
            {!!season.length && (
              <Button
                onClick={() => void submit(season)}
                disabled={busy}
                aria-label="Скачать сезон"
                aria-busy={busy}
              >
                Скачать сезон · {season.length}
              </Button>
            )}
            {next.some(number => available.has(number) && !contains(number)) && (
              <Button variant="text" onClick={() => setChecked(new Set(next))}>
                {episode ? 'Следующие 3' : 'Первые 3'}
              </Button>
            )}
          </div>
          <div class="download-episode-list">
            {numbers.map(number => {
              const saved = contains(number);
              const supported = available.has(number);
              return (
                <label key={number} class="download-episode">
                  <input
                    type="checkbox"
                    disabled={busy || !supported || saved}
                    checked={supported && !saved && checked.has(number)}
                    onChange={event => {
                      const updated = new Set(checked);
                      if (event.currentTarget.checked) updated.add(number);
                      else updated.delete(number);
                      setChecked(updated);
                    }}
                  />
                  <span>Серия {number}</span>
                  <small>
                    {saved
                      ? 'В загрузках'
                      : voice && !supported
                        ? selectedSource
                          ? `Нет у ${selectedSource}`
                          : 'Нет в этой озвучке'
                        : ''}
                  </small>
                </label>
              );
            })}
          </div>
          {error && (
            <p class="download-error" role="alert">
              {error}
            </p>
          )}
          <div class="download-picker-actions">
            <ButtonLink href="#/downloads" onClick={close} variant="text">
              Открыть загрузки
            </ButtonLink>
            <Button
              variant="primary"
              onClick={() => void submit(selection)}
              disabled={busy || !selection.length}
              aria-busy={busy}
            >
              <Icon name="download" size={17} />
              {busy ? 'Добавляем…' : selection.length ? `Скачать · ${selection.length}` : 'Скачать'}
            </Button>
          </div>
        </div>
      ) : (
        <p>Скачивание доступно для серий из CVH, Alloha, Kodik и Aksor.</p>
      )}
    </Sidebar>
  );
};

const statuses = {
  queued: 'В очереди',
  downloading: 'Скачивается',
  waiting: 'Ожидает повтора',
  paused: 'На паузе',
  failed: 'Не удалось скачать',
  ready: 'Скачано',
};

function groupDownloads<K>(entries: Download[], key: (entry: Download) => K) {
  const groups = new Map<K, Download[]>();
  for (const entry of entries) {
    const id = key(entry);
    const group = groups.get(id);
    if (group) group.push(entry);
    else groups.set(id, [entry]);
  }
  return groups;
}

const isReady = (entry: Download) => entry.status === 'ready' && !!entry.stream;
const inProgress = (entry: Download) => entry.status !== 'ready' && entry.status !== 'failed';
const episodeQualityOrder = (a: Download, b: Download) =>
  episodeOrder(a.episode, b.episode) || downloadedQuality(b) - downloadedQuality(a);

const DownloadRow: FC<{
  entry: Download;
  showTitle: boolean;
  episodePosition?: number;
}> = ({ entry, showTitle, episodePosition }) => {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const change = async (action: 'pause' | 'retry' | 'cancel' | 'remove') => {
    setBusy(true);
    try {
      await changeDownload(entry.id, action);
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  const format = entry.stream?.entry.endsWith('.mp4')
    ? 'MP4'
    : entry.stream?.entry.endsWith('.mpd')
      ? 'DASH'
      : 'HLS';
  const percent = downloadPercent(entry);
  const position = isReady(entry) ? episodePosition : undefined;
  const viewed = position || episodePosition;
  const playLabel = position
    ? showTitle
      ? 'Продолжить просмотр'
      : 'Продолжить'
    : showTitle
      ? 'Смотреть офлайн'
      : 'Смотреть';
  return (
    <div class="download-row">
      <div class="download-row-main">
        <div class="download-row-title">
          {showTitle && <strong>Серия {entry.episode}</strong>}
          <span
            class={
              entry.status === 'failed'
                ? 'download-error'
                : isReady(entry)
                  ? 'download-saved-status'
                  : 'download-status'
            }
          >
            {isReady(entry) && <Icon name="check" size={15} />}
            {entry.waitingFor === 'storage' && entry.status === 'waiting'
              ? 'Ожидает места на диске'
              : statuses[entry.status]}
            {entry.status === 'downloading' && percent !== undefined ? ` · ${percent}%` : ''}
          </span>
          <span class="download-quality">{downloadedQuality(entry)}p</span>
          {entry.stream && <span class="download-format">{format}</span>}
        </div>
        {!!viewed && (
          <small class="download-resume-status">
            {position ? 'Продолжить ·' : 'Просмотрено'} {formatTime(viewed)}
          </small>
        )}
        {entry.error && <small class="download-error">{entry.error}</small>}
        {entry.status === 'downloading' && (
          <progress
            value={entry.total ? entry.done : undefined}
            max={entry.total || undefined}
            aria-label={`Прогресс загрузки серии ${entry.episode} · ${downloadedQuality(entry)}p`}
          />
        )}
      </div>
      <div class={`download-row-actions${confirm ? '' : ' download-row-controls'}`}>
        {isReady(entry) && (
          <ButtonLink
            variant="secondary"
            href={downloadPath(entry)}
            aria-current={position ? 'true' : undefined}
            aria-label={`${position ? 'Продолжить просмотр серии' : 'Смотреть офлайн серию'} ${entry.episode} · ${downloadedQuality(entry)}p`}
          >
            <Icon name="play" size={17} />
            <span>{playLabel}</span>
          </ButtonLink>
        )}
        {(entry.status === 'queued' ||
          entry.status === 'downloading' ||
          entry.status === 'waiting') && (
          <Button disabled={busy} onClick={() => void change('pause')}>
            Пауза
          </Button>
        )}
        {(entry.status === 'paused' || entry.status === 'failed') && (
          <Button disabled={busy} onClick={() => void change('retry')}>
            {entry.status === 'paused' ? 'Возобновить загрузку' : 'Повторить загрузку'}
          </Button>
        )}
        {entry.status !== 'ready' ? (
          <Button
            disabled={busy}
            variant="icon"
            aria-label={`Отменить загрузку серии ${entry.episode} · ${downloadedQuality(entry)}p`}
            title="Отменить загрузку"
            onClick={() => void change('cancel')}
          >
            <Icon name="close" size={16} />
          </Button>
        ) : confirm ? (
          <>
            <Button disabled={busy} onClick={() => void change('remove')}>
              Удалить серию
            </Button>
            <Button disabled={busy} variant="text" onClick={() => setConfirm(false)}>
              Отмена
            </Button>
          </>
        ) : (
          <Button
            disabled={busy}
            variant="icon"
            aria-label={`Удалить скачанную серию ${entry.episode} · ${downloadedQuality(entry)}p`}
            title="Удалить скачанную серию"
            onClick={() => setConfirm(true)}
          >
            <Icon name="trash" size={16} />
          </Button>
        )}
      </div>
    </div>
  );
};

const episodePlural = new Intl.PluralRules('ru');
const savedEpisodesLabel = (count: number) => {
  const form = episodePlural.select(count);
  if (form === 'one') return `Скачана ${count} серия`;
  if (form === 'few') return `Скачаны ${count} серии`;
  return `Скачано ${count} серий`;
};

const DownloadCard: FC<{ anime: Anime; entries: Download[] }> = ({ anime, entries }) => {
  const ready = new Set(entries.filter(isReady).map(entry => entry.episode)).size;
  const pending = entries.filter(inProgress).length;
  const readyBytes = entries
    .filter(isReady)
    .reduce((sum, entry) => sum + (entry.savedBytes ?? 0), 0);
  const partialBytes = entries
    .filter(entry => !isReady(entry))
    .reduce((sum, entry) => sum + (entry.savedBytes ?? 0), 0);
  const failed = entries.filter(entry => entry.status === 'failed').length;
  const details = [
    ready && `download-count-${anime.anime_id}`,
    `download-meta-${anime.anime_id}`,
    (pending || failed) && `download-status-${anime.anime_id}`,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <li class="anime-card download-card">
      <AppLink
        href={downloadAnimePath(anime.anime_id)}
        aria-label={anime.title}
        aria-describedby={details}
      >
        <div class="card-image">
          <div class="download-card-poster" aria-hidden="true">
            <Poster anime={anime} />
          </div>
          {ready > 0 && (
            <span class="download-card-count" id={`download-count-${anime.anime_id}`}>
              {savedEpisodesLabel(ready)}
            </span>
          )}
        </div>
        <div class="card-caption">
          <h2 class="card-title" title={anime.title}>
            {anime.title}
          </h2>
          <p id={`download-meta-${anime.anime_id}`}>
            {[anime.year, anime.type?.name, readyBytes > 0 && formatStorageBytes(readyBytes)]
              .filter(Boolean)
              .join(' · ')}
            {partialBytes > 0 && <span> · В работе {formatStorageBytes(partialBytes)}</span>}
          </p>
          <p class="download-card-status" id={`download-status-${anime.anime_id}`}>
            {pending > 0 && <span>В работе · {pending}</span>}
            {failed > 0 && <span class="download-error">С ошибкой · {failed}</span>}
          </p>
        </div>
      </AppLink>
    </li>
  );
};

const DownloadsTitle: FC<{ anime: Anime; entries: Download[]; history?: WatchEntry }> = ({
  anime,
  entries,
  history,
}) => {
  const [selectedVoice, setSelectedVoice] = useState('');
  const [query, setQuery] = useState('');
  const [removing, setRemoving] = useState<{ voice?: string }>();
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const session = useSession();
  const online = useOnline();
  const settings = usePlaybackSettings();
  const { episodeLayout } = useInterfaceSettings();
  const cards = episodeLayout === 'cards';
  const id = anime.anime_id;
  const resource = useResource(
    signal =>
      navigator.onLine === false
        ? Promise.resolve(peekDownloadVideos(id) || { data: NO_VIDEOS, cached: false, savedAt: 0 })
        : animeVideos(id, signal),
    [id, session?.token, session?.verified],
    () => peekDownloadVideos(id)
  );
  useEffect(() => {
    window.addEventListener('online', resource.retry);
    return () => window.removeEventListener('online', resource.retry);
  }, [resource.retry]);

  const saved = entries.filter(isReady).sort(episodeQualityOrder);
  const shared = episodePlaybackIndex(id, history);
  const checkpointFor = (episode: string) => {
    const checkpoint = shared.get(episode.trim());
    return checkpoint?.completed ? undefined : checkpoint;
  };
  const continuing =
    saved.find(entry => entry.stream?.videoId === history?.videoId) ||
    saved.find(entry => matchesDownloadHistory(entry, history)) ||
    saved.find(entry => entry.episode === history?.episode && history.position) ||
    [...saved]
      .sort(
        (a, b) =>
          (checkpointFor(b.episode)?.updatedAt ?? -1) - (checkpointFor(a.episode)?.updatedAt ?? -1)
      )
      .find(entry => !!checkpointFor(entry.episode)?.position);
  const preferred = continuing || saved[0];
  const selected =
    saved.find(
      entry =>
        selectedVoice &&
        voiceKey(entry.voice) === selectedVoice &&
        entry.episode === preferred?.episode
    ) || preferred;
  const position = selected && !isContinueHidden(id) && checkpointFor(selected.episode)?.position;
  const episodeData = resource.value?.data ?? peekDownloadVideos(id)?.data;
  const videos = Array.isArray(episodeData) ? episodeData : NO_VIDEOS;
  const groups = useMemo(() => groupVoices(videos), [videos]);
  const voices = new Map(groups.map(({ key, name }) => [key, name]));
  for (const entry of entries) {
    const key = voiceKey(entry.voice);
    if (!voices.has(key)) voices.set(key, entry.voice);
  }
  const activeVoice =
    voices.get(selectedVoice) ??
    voices.get(voiceKey(selected?.voice ?? entries[0].voice)) ??
    entries[0].voice;
  const voiceEntries = entries.filter(entry => voiceKey(entry.voice) === voiceKey(activeVoice));
  const openRemoval = (voice?: string) => {
    setRemoveError('');
    setRemoving({ voice });
  };
  const confirmRemoval = async () => {
    if (!removing || removeBusy) return;
    const voice = removing.voice;
    const target = voice
      ? entries.filter(entry => voiceKey(entry.voice) === voiceKey(voice))
      : entries;
    setRemoveBusy(true);
    setRemoveError('');
    try {
      const remaining = await removeDownloads(target.map(entry => entry.id));
      setRemoving(undefined);
      if (!remaining.some(entry => entry.animeId === id)) {
        if (location.hash.split('?')[0] === downloadAnimePath(id)) location.replace('#/downloads');
      } else if (voice) {
        setSelectedVoice('');
      }
      notify(voice ? 'Загрузки озвучки удалены' : 'Загрузки сериала удалены');
    } catch (error) {
      setRemoveError((error as Error).message);
    } finally {
      setRemoveBusy(false);
    }
  };
  const videoByNumber = new Map(
    voiceVideos(videos, activeVoice).map(video => [video.number, video])
  );
  const allEpisodes = new Set([
    ...videos.map(video => video.number),
    ...entries.map(entry => entry.episode),
  ]);
  const episodes = [...allEpisodes]
    .filter(number => number.includes(query.trim()))
    .sort(episodeOrder);
  const detail = peekAnimeDetail(id)?.data || anime;
  const snapshots = useMemo(
    () =>
      new Map(
        detail.random_screenshots
          ?.map(frame => [frame.episode, frame.sizes.small] as const)
          .reverse()
      ),
    [detail.random_screenshots]
  );
  const poster = imageUrl(anime.poster?.medium || anime.poster?.big);
  const controls = useEpisodeDownloads({
    open: true,
    anime: detail,
    entries,
    videos,
    voice: activeVoice,
    online,
    quality: preferredStreamQuality(settings.quality),
  });

  return (
    <>
      <header class="downloads-title">
        <div class="card-image" aria-hidden="true">
          <Poster anime={anime} />
        </div>
        <div class="downloads-title-info">
          <h1>{anime.title}</h1>
          <p>
            {[
              anime.year,
              anime.type?.name,
              saved.length
                ? savedEpisodesLabel(new Set(saved.map(entry => entry.episode)).size)
                : 'Серии в загрузках',
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {selected && (
            <div class="downloads-title-resume">
              <ButtonLink variant="primary" href={downloadPath(selected)}>
                <Icon name="play" size={18} />
                {position ? 'Продолжить просмотр' : 'Смотреть'}
              </ButtonLink>
              <span>
                Серия {selected.episode} · {selected.voice}
                {position ? ` · ${formatTime(position)}` : ''}
              </span>
            </div>
          )}
          <div class="downloads-title-actions">
            <ButtonLink variant="text" href={`#/anime/${id}`}>
              Об аниме
            </ButtonLink>
            <Button variant="text" onClick={() => openRemoval()}>
              <Icon name="trash" size={16} /> Удалить загрузки сериала
            </Button>
          </div>
        </div>
      </header>
      <section class="downloads-title-episodes" aria-label="Серии" data-tv-focus-group>
        <EpisodeVoiceTabs
          voices={[...voices].map(([key, name]) => ({ key, name }))}
          value={voiceKey(activeVoice)}
          onChange={setSelectedVoice}
        />
        <EpisodeListControls layout={episodeLayout} query={query} onQuery={setQuery} />
        <EpisodeDownloadToolbar
          controls={controls}
          showQueueLink={false}
          actions={
            voiceEntries.length > 0 && (
              <Button variant="text" onClick={() => openRemoval(activeVoice)}>
                <Icon name="trash" size={16} /> Удалить загрузки озвучки
              </Button>
            )
          }
        />
        {resource.loading && (
          <p class="collection-note" role="status">
            Загружаем список серий…
          </p>
        )}
        {resource.error && (
          <div class="download-episodes-message" role="status">
            <span>Не удалось обновить список серий.</span>
            <Button variant="text" onClick={resource.retry}>
              Повторить
            </Button>
          </div>
        )}
        {episodes.length ? (
          <ul class={`download-rows${cards ? ' download-episodes-grid' : ''}`}>
            {episodes.map(number => {
              const actions = controls?.forEpisode(number);
              const jobs = [...(actions?.entries || [])].sort(episodeQualityOrder);
              const [job, ...variants] = jobs;
              const video = videoByNumber.get(number);
              const saved = jobs.some(isReady);
              const checkpoint = checkpointFor(number);
              const watching = checkpoint?.position ? checkpoint : undefined;
              const preview = imageUrl(
                job?.preview ||
                  variants.find(entry => entry.preview)?.preview ||
                  snapshots.get(number)
              );
              return (
                <li
                  class={`download-episode-item${saved ? ' is-downloaded' : ''}${watching ? ' is-current' : ''}`}
                  key={number}
                >
                  {cards && (
                    <div class="download-episode-cover" aria-hidden="true">
                      <EpisodePreview
                        src={preview || poster}
                        fallbackSrc={poster}
                        poster={!preview}
                        cacheOnly={saved || !online}
                        progress={
                          watching?.duration && watching.position
                            ? (watching.position / watching.duration) * 100
                            : undefined
                        }
                        frameKey={watchFrameKey(id, number, session?.user.id)}
                        icon={null}
                      />
                    </div>
                  )}
                  {cards && <strong class="download-episode-title">Серия {number}</strong>}
                  {job ? (
                    <DownloadRow
                      key={job.id}
                      entry={job}
                      showTitle={!cards}
                      episodePosition={watching?.position}
                    />
                  ) : (
                    <div class="download-row">
                      <div class="download-row-main">
                        {!cards && <strong>Серия {number}</strong>}
                        <span>
                          {!video && videos.length
                            ? 'Нет в этой озвучке'
                            : video && !online
                              ? 'Нужен интернет'
                              : 'Не скачана'}
                        </span>
                        {!!watching?.position && (
                          <small class="download-resume-status">
                            Продолжить · {formatTime(watching.position)}
                          </small>
                        )}
                      </div>
                      {video && online && (
                        <div class={`download-row-actions${cards ? ' download-row-controls' : ''}`}>
                          {!cards && actions?.request && (
                            <DownloadEpisodeButton request={actions.request} />
                          )}
                          <ButtonLink
                            variant={cards ? 'secondary' : 'text'}
                            href={`#/anime/${id}?view=watch&play=1&episode=${encodeURIComponent(number)}&voice=${encodeURIComponent(activeVoice)}`}
                            aria-label={`Смотреть онлайн серию ${number}`}
                            aria-current={watching ? 'true' : undefined}
                          >
                            {cards && <Icon name="play" size={17} />}
                            <span>
                              {watching ? 'Продолжить' : cards ? 'Смотреть' : 'Смотреть онлайн'}
                            </span>
                          </ButtonLink>
                          {cards && actions?.request && (
                            <DownloadEpisodeButton request={actions.request} iconOnly />
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  {!!variants.length && (
                    <div class="download-episode-variants">
                      {variants.map(entry => (
                        <DownloadRow
                          key={entry.id}
                          entry={entry}
                          showTitle={!cards}
                          episodePosition={watching?.position}
                        />
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p class="collection-note">Такая серия не найдена.</p>
        )}
      </section>
      {removing && (
        <Sheet
          className="download-removal-sheet"
          title={removing.voice ? 'Удалить загрузки озвучки?' : 'Удалить загрузки сериала?'}
          subtitle={[anime.title, removing.voice].filter(Boolean).join(' · ')}
          close={() => !removeBusy && setRemoving(undefined)}
          footer={
            <div class="download-removal-actions">
              <Button disabled={removeBusy} onClick={() => setRemoving(undefined)}>
                Отмена
              </Button>
              <Button variant="primary" disabled={removeBusy} onClick={() => void confirmRemoval()}>
                {removeBusy ? 'Удаляем…' : 'Удалить загрузки'}
              </Button>
            </div>
          }
        >
          <p>
            {removing.voice
              ? 'Удалим скачанные серии и отменим загрузки выбранной озвучки.'
              : 'Удалим скачанные серии и отменим загрузки всех озвучек сериала.'}
          </p>
          {removeError && (
            <p class="download-error" role="alert">
              {removeError}
            </p>
          )}
        </Sheet>
      )}
    </>
  );
};

const catalogStatuses = [
  { value: 'ready', label: 'Скачано', matches: isReady },
  { value: 'pending', label: 'В работе', matches: inProgress },
  { value: 'failed', label: 'С ошибками', matches: (entry: Download) => entry.status === 'failed' },
  { value: '', label: 'Все' },
];
const catalogSort = [
  { value: 'recent', label: 'Недавние' },
  { value: 'title', label: 'По названию' },
];

export const DownloadsPage: FC<{ id?: string; animeId?: number; query?: string }> = ({
  id,
  animeId,
  query: routeQuery = '',
}) => {
  useDownloads();
  const library = useLibrary();
  const [query, setQuery] = useState('');
  const initialStatus = new URLSearchParams(routeQuery).get('status') === 'all' ? '' : 'ready';
  const [status, setStatus] = useState(initialStatus);
  useEffect(() => setStatus(initialStatus), [initialStatus]);
  const [sort, setSort] = useState('recent');
  const entries = downloads.value;
  const error = downloadError.value;
  const selected = id ? entries?.find(item => item.id === id && isReady(item)) : undefined;
  const redirect = selected ? downloadPath(selected) : '';
  useEffect(() => {
    if (redirect) location.replace(redirect);
  }, [redirect]);
  if (!downloadsAvailable())
    return <Empty title="Загрузки недоступны">Открой настольное приложение.</Empty>;
  if (id) {
    return (
      <Empty title={entries && !selected ? 'Серия недоступна' : 'Открываем загрузку'}>
        <ButtonLink href="#/downloads" variant="text">
          К загрузкам
        </ButtonLink>
      </Empty>
    );
  }

  const groups = groupDownloads([...(entries || [])].reverse(), entry => entry.animeId);
  const choices = catalogStatuses.map(({ value, label, matches }) => {
    const count = matches
      ? [...groups.values()].filter(group => group.some(matches)).length
      : groups.size;
    return [value, `${label} · ${count}`] as const;
  });
  const fromHistory = new Map(library.history.map(entry => [entry.anime.anime_id, entry]));
  const animeOf = (group: Download[]) =>
    downloadedAnime(
      group.find(entry => entry.anime) || group[0],
      fromHistory.get(group[0].animeId)?.anime
    );
  const titleEntries = animeId && groups.get(animeId);
  const queryTerm = query.trim().toLocaleLowerCase('ru').replaceAll('ё', 'е');
  const matchesStatus = catalogStatuses.find(option => option.value === status)?.matches;
  const cards =
    !animeId && entries?.length
      ? [...groups.values()]
          .map(group => ({ anime: animeOf(group), entries: group }))
          .filter(
            ({ anime, entries }) =>
              anime.title.toLocaleLowerCase('ru').replaceAll('ё', 'е').includes(queryTerm) &&
              (!matchesStatus || entries.some(matchesStatus))
          )
      : [];
  if (sort === 'title')
    cards.sort((a, b) => a.anime.title.localeCompare(b.anime.title, 'ru', { numeric: true }));
  const anime = titleEntries ? animeOf(titleEntries) : undefined;

  return (
    <section class="downloads-page">
      {animeId ? (
        <AppLink class="back-link" href="#/downloads">
          <Icon name="back" size={18} /> К загрузкам
        </AppLink>
      ) : (
        <header class="page-heading">
          <h1>Загрузки</h1>
        </header>
      )}
      {error && (
        <p class="download-error" role="alert">
          {error}
        </p>
      )}
      {!entries ? (
        !error && <p role="status">Открываем загрузки…</p>
      ) : anime && titleEntries ? (
        <DownloadsTitle
          key={anime.anime_id}
          anime={anime}
          entries={titleEntries}
          history={downloadHistory(anime, fromHistory.get(anime.anime_id))}
        />
      ) : animeId ? (
        <Empty title="Загрузок для этого аниме нет">
          Серии можно скачать на странице аниме или в плеере.
        </Empty>
      ) : entries.length ? (
        <>
          <div class="downloads-catalog-tools">
            <SearchField
              value={query}
              onValueChange={setQuery}
              label="Поиск по загрузкам"
              placeholder="Название аниме"
            />
            <Dropdown
              aria-label="Сортировка загрузок"
              value={sort}
              onChange={setSort}
              options={catalogSort}
            />
          </div>
          <ChoiceTabs
            class="downloads-status-tabs"
            value={status}
            onChange={setStatus}
            choices={choices}
            label="Статус загрузок"
          />
          {cards.length ? (
            <ul class="anime-grid gallery-grid downloads-catalog">
              {cards.map(card => (
                <DownloadCard key={card.anime.anime_id} {...card} />
              ))}
            </ul>
          ) : (
            <Empty
              title={
                status === 'ready' && !queryTerm ? 'Скачанных аниме пока нет' : 'Ничего не найдено'
              }
              action={
                <Button
                  onClick={() => {
                    setQuery('');
                    setStatus('');
                  }}
                >
                  Показать все загрузки
                </Button>
              }
            >
              {status === 'ready' && !queryTerm
                ? 'Загрузки в очереди и с ошибками доступны по фильтру статуса.'
                : 'Попробуй другой запрос или статус.'}
            </Empty>
          )}
        </>
      ) : (
        <Empty
          title="Загрузок пока нет"
          action={
            <ButtonLink href="#/catalog" variant="primary">
              Открыть каталог аниме
            </ButtonLink>
          }
        >
          Выбери серии и озвучку на странице аниме или в плеере.
        </Empty>
      )}
    </section>
  );
};
