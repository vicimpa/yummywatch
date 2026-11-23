import { signal } from '@preact/signals';
import { normalizeSkips, type SkipMarkers } from '../../shared/skips.mjs';
import { useEffect } from 'preact/hooks';

import { imageUrl, peekAnimeDetail, peekAnimeVideos } from './api';
import { desktopInvoke, desktopMediaRoot, isDesktopWindow } from './desktop';
import { cachedImage, refreshImage } from './image-cache';
import { isContinueHidden } from './continue-cache';
import { readPlaybackRecovery } from './playback-recovery';
import { latestWatchEntry, watchMatchesVideo } from './player';
import { streamCandidates, streamSourceFamily, type Stream, type StreamResult } from './streams';
import type { Anime, Video, WatchEntry } from './types';

type Candidate = ReturnType<typeof streamCandidates>[number];

export type DownloadRequest = {
  animeId: number;
  title: string;
  anime?: {
    poster?: string;
    year?: number;
    kind?: string;
    kindAlias?: string;
    status?: Anime['anime_status'];
    episodes?: Anime['episodes'];
  };
  episode: string;
  preview?: string;
  voice: string;
  quality: number;
  candidates: Candidate[];
  markers?: Record<number, SkipMarkers>;
  active?: string;
};

export type Download = DownloadRequest & {
  id: string;
  status: 'queued' | 'downloading' | 'waiting' | 'paused' | 'failed' | 'ready';
  done: number;
  total: number;
  error?: string;
  waitingFor?: 'storage' | 'connection';
  savedBytes?: number;
  actualQuality?: number;
  stream?: {
    provider: string;
    videoId: number;
    quality: number;
    entry: string;
    caption?: string;
    skips?: SkipMarkers;
  };
};

export const downloads = signal<Download[] | undefined>(undefined);
export const downloadError = signal('');
let revision = 0;
let mutations = 0;

export const downloadsAvailable = () => isDesktopWindow();

export const downloadPercent = (entry: Download) =>
  entry.total > 0
    ? Math.min(100, Math.max(0, Math.floor((100 * entry.done) / entry.total)))
    : undefined;

export function downloadSourceFamily(video: Video) {
  const family = streamSourceFamily(video.iframe_url);
  if (family === 'CVH' || family === 'Alloha' || family === 'Kodik' || family === 'Aksor')
    return family;
}

export const downloadable = (video: Video) => !!downloadSourceFamily(video);

export function createDownloadRequest(
  anime: Anime,
  videos: Video[],
  episode: string,
  voice: string,
  quality: number,
  active?: { stream: Stream; video: Video }
): DownloadRequest {
  const selected = videos
    .filter(
      video => video.number === episode && video.data.dubbing === voice && downloadable(video)
    )
    .slice(0, 12);
  const candidates = streamCandidates(selected);
  const markers = Object.fromEntries(
    selected.flatMap(video => (video.skips ? [[video.video_id, normalizeSkips(video.skips)]] : []))
  );
  const local =
    active &&
    active.video.number === episode &&
    active.video.data.dubbing === voice &&
    active.stream.quality === quality &&
    candidates.some(candidate => candidate.videoId === active.video.video_id)
      ? new URL(active.stream.url).pathname
      : undefined;
  const poster = imageUrl(anime.poster?.medium || anime.poster?.big || anime.poster?.huge);
  const preview = imageUrl(
    anime.random_screenshots?.find(frame => frame.episode === episode)?.sizes.small
  );
  const metadata = {
    poster: poster || undefined,
    year: anime.year,
    kind: anime.type?.name,
    kindAlias: anime.type?.alias,
    status: anime.anime_status,
    episodes: anime.episodes,
  };
  return {
    animeId: anime.anime_id,
    title: anime.title,
    ...((poster || metadata.year || metadata.kind || metadata.status || metadata.episodes) && {
      anime: metadata,
    }),
    episode,
    ...(preview && { preview }),
    voice,
    quality,
    candidates,
    ...(Object.keys(markers).length && { markers }),
    active: local,
  };
}

async function load() {
  if (mutations) return;
  const request = revision;
  try {
    const entries = await desktopInvoke<Download[]>('list_downloads', {});
    if (request !== revision) return;
    if (!Array.isArray(entries)) throw new Error('Не удалось прочитать список загрузок.');
    downloadError.value = '';
    downloads.value = entries;
  } catch (error) {
    if (request === revision) downloadError.value = (error as Error).message;
  }
}

export function useDownloads(enabled = true) {
  useEffect(() => {
    if (!enabled || !downloadsAvailable()) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      await load();
      if (!disposed) timer = setTimeout(refresh, 850);
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [enabled]);
}

async function update(command: string, args: Record<string, unknown>) {
  const request = ++revision;
  mutations++;
  try {
    const entries = await desktopInvoke<Download[]>(command, args);
    if (!Array.isArray(entries)) throw new Error('Не удалось обновить список загрузок.');
    if (request === revision) {
      downloadError.value = '';
      downloads.value = entries;
    }
    return entries;
  } finally {
    mutations--;
  }
}

export async function enqueueDownloads(requests: DownloadRequest[]) {
  await update('enqueue_downloads', { requests });
  const images = new Set(requests.flatMap(request => [request.preview, request.anime?.poster]));
  for (const image of images) if (image && !cachedImage(image)) void refreshImage(image);
}
export const changeDownload = (id: string, action: 'pause' | 'retry' | 'cancel' | 'remove') =>
  update('change_download', { id, action });
export const removeDownloads = (ids: string[]) => update('remove_downloads', { ids });

export type DownloadSettings = { concurrent: number; cachedEpisodes: number };
export type DownloadStorage = {
  free: number | null;
  ready: number;
  partial: number;
  videoCache: number;
};
export const readDownloadSettings = () => desktopInvoke<DownloadSettings>('download_settings', {});
export const saveDownloadSettings = (settings: DownloadSettings) =>
  desktopInvoke<DownloadSettings>('download_settings', { settings });
export const readDownloadStorage = () => desktopInvoke<DownloadStorage>('download_storage', {});
export async function clearDownloadStorage(category: 'ready' | 'partial' | 'video') {
  await desktopInvoke('clear_download_storage', { category });
  await load();
}

export function prefetchDownloadEpisode(
  request: Pick<DownloadRequest, 'animeId' | 'episode' | 'quality' | 'candidates'> & {
    ticket: string;
  }
) {
  return desktopInvoke<void>('prefetch_download_episode', { request });
}
export const cancelDownloadPrefetch = (ticket: string) =>
  desktopInvoke<void>('cancel_download_prefetch', { ticket });

export function formatStorageBytes(bytes: number) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024;
    unit++;
  }
  return `${new Intl.NumberFormat('ru', { maximumFractionDigits: unit > 0 ? 1 : 0 }).format(bytes)} ${units[unit]}`;
}

const storedMediaUrl = (path: string) => new URL(path, desktopMediaRoot()).href;

export const downloadQualities = [144, 240, 360, 480, 720, 1080, 1440, 2160];

export const downloadedQuality = (entry: Download) =>
  entry.stream?.quality ?? entry.actualQuality ?? entry.quality;

export function preferredReadyDownload(entries: Download[] | undefined, quality: number) {
  return entries
    ?.filter(entry => entry.status === 'ready' && entry.stream)
    .sort((a, b) => {
      const first = downloadedQuality(a);
      const second = downloadedQuality(b);
      return (
        Number(first > quality) - Number(second > quality) ||
        Math.abs(quality - first) - Math.abs(quality - second)
      );
    })[0];
}

export const downloadAnimePath = (animeId: number) => `#/downloads/anime/${animeId}`;

export function downloadedAnime(entry: Download, cached?: Anime): Anime {
  const local = peekAnimeDetail(entry.animeId)?.data || cached;
  return {
    anime_id: entry.animeId,
    anime_url: local?.anime_url || '',
    title: entry.title,
    year: entry.anime?.year ?? local?.year,
    type: entry.anime?.kind
      ? {
          ...local?.type,
          name: entry.anime.kind,
          alias: entry.anime.kindAlias || local?.type?.alias,
        }
      : local?.type,
    anime_status: local?.anime_status || entry.anime?.status,
    episodes: local?.episodes || entry.anime?.episodes,
    poster: entry.anime?.poster ? { medium: entry.anime.poster } : local?.poster,
  };
}

export function downloadHistory(anime: Anime, history?: WatchEntry) {
  if (isContinueHidden(anime.anime_id)) return;
  return [
    readPlaybackRecovery(anime.anime_id),
    history,
    latestWatchEntry(anime, peekAnimeVideos(anime.anime_id)?.data || []),
  ].sort((a, b) => (b?.updatedAt ?? -1) - (a?.updatedAt ?? -1))[0];
}

export function matchesDownloadHistory(entry: Download, history?: WatchEntry) {
  return (
    !!entry.stream &&
    !!history &&
    watchMatchesVideo(history, {
      number: entry.episode,
      video_id: entry.stream.videoId,
      data: { dubbing: entry.voice },
    })
  );
}

export const downloadPath = (entry: Download, from?: 'about') => {
  const params = new URLSearchParams({
    view: 'watch',
    play: '1',
    episode: entry.episode,
    voice: entry.voice,
    download: entry.id,
  });
  if (from) params.set('from', from);
  return `#/anime/${entry.animeId}?${params}`;
};

export type StoredPlayback = {
  anime: Anime;
  videos: Video[];
  sources: Map<number, StreamResult>;
  selectedVideoId?: number;
};

export function storedPlayback(selected: Download, queue: Download[]): StoredPlayback {
  const videos = new Map<number, Video>();
  const sources = new Map<number, StreamResult>();
  const frames = new Map<string | undefined, NonNullable<Anime['random_screenshots']>[number]>();
  const entries = queue
    .filter(entry => entry.animeId === selected.animeId && entry.status === 'ready' && entry.stream)
    .sort((a, b) => Number(b.id === selected.id) - Number(a.id === selected.id));
  for (const entry of entries) {
    if (entry.preview && !frames.has(entry.episode))
      frames.set(entry.episode, {
        episode: entry.episode,
        sizes: { small: entry.preview, full: entry.preview },
      });
    const saved = entry.stream!;
    if (videos.has(saved.videoId)) continue;
    videos.set(saved.videoId, {
      video_id: saved.videoId,
      iframe_url:
        entry.candidates.find(candidate => candidate.videoId === saved.videoId)?.url || '',
      data: { dubbing: entry.voice, player: saved.provider, player_id: 0 },
      index: Number(entry.episode) || 0,
      number: entry.episode,
    });
    sources.set(saved.videoId, {
      provider: saved.provider,
      videoId: saved.videoId,
      duration: 0,
      relay: true,
      skips: saved.skips,
      streams: [
        {
          quality: saved.quality,
          url: storedMediaUrl(saved.entry),
          type: saved.entry.endsWith('.mp4')
            ? 'mp4'
            : saved.entry.endsWith('.mpd')
              ? 'dash'
              : 'hls',
          offline: true,
        },
      ],
      ...(saved.caption && {
        caption: { url: storedMediaUrl(saved.caption), label: 'Субтитры', language: 'ru' },
      }),
    });
  }
  // Keep the explicitly selected copy as the representative of its episode/voice.
  const ordered = [...videos.values()];
  const video = ordered.shift();
  if (video) ordered.push(video);
  const cachedFrames = peekAnimeDetail(selected.animeId)?.data.random_screenshots;
  for (const frame of cachedFrames || [])
    if (!frames.has(frame.episode)) frames.set(frame.episode, frame);
  return {
    anime: {
      ...downloadedAnime(entries.find(entry => entry.anime) || selected),
      random_screenshots: [...frames.values()],
    },
    videos: ordered,
    sources,
    selectedVideoId: selected.stream?.videoId,
  };
}
