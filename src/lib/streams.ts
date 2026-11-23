import { selectCvhItem } from '../../shared/cvh.mjs';
import { normalizeSkips, providerSkips, type SkipMarkers } from '../../shared/skips.mjs';

import { desktopInvoke, desktopMediaRoot, isDesktop } from './desktop';
import type { Video } from './types';

export interface Stream {
  quality: number;
  url: string;
  type: 'mp4' | 'hls' | 'dash';
  sourceHost?: string;
  legacyUrl?: string;
  captionUrl?: string;
  offline?: boolean;
  fallback?: { url: string; type: 'mp4'; legacyUrl?: string };
}

export interface StreamCaption {
  url: string;
  label: string;
  language: string;
}

export interface StreamResult {
  provider: string;
  videoId: number;
  duration: number;
  streams: Stream[];
  relay?: boolean;
  caption?: StreamCaption;
  skips?: SkipMarkers;
}

const voiceName = (name: string) =>
  name
    .toLowerCase()
    .replace(/(?:озвучка|субтитры)|[^a-zа-яё0-9]/g, '')
    .replace(/aniliberty|anilibriatv/g, 'anilibria');

export const voiceKey = (name: string) =>
  `${/субтитры/i.test(name) ? 'sub' : 'dub'}:${voiceName(name)}`;

export function groupVoices(videos: Video[]) {
  const groups = new Map<string, { key: string; name: string; videos: Video[] }>();

  for (const video of videos) {
    const key = voiceKey(video.data.dubbing);
    const group = groups.get(key);

    if (group) group.videos.push(video);
    else groups.set(key, { key, name: video.data.dubbing, videos: [video] });
  }

  return [...groups.values()];
}

export function voiceVideos(videos: Video[], voice: string) {
  const sorted = videos.filter(video => voiceKey(video.data.dubbing) === voiceKey(voice));

  const episodes = new Map<string, Video>();

  for (const video of sorted.sort((a, b) =>
    a.number.localeCompare(b.number, 'ru', { numeric: true })
  )) {
    const previous = episodes.get(video.number);

    if (!previous || (video.watched?.date || 0) >= (previous.watched?.date || 0))
      episodes.set(video.number, video);
  }

  return [...episodes.values()];
}

export const preferredStreamQuality = (quality: string) =>
  quality === 'auto' ? 480 : Number(quality);

export function selectStream(streams: Stream[], preferred: string) {
  const sorted = [...streams].sort((a, b) => a.quality - b.quality);

  if (!sorted.length) throw new Error('Источник не предоставил видео.');

  const limit = preferredStreamQuality(preferred);

  return sorted.filter(stream => stream.quality <= limit).at(-1) || sorted[0];
}

export function streamSourceFamily(raw: string) {
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return;
    if (
      ['ru.yummyani.me', 'yummyani.me'].includes(url.hostname) &&
      url.pathname.endsWith('/iframeCVH.html')
    )
      return 'CVH';
    if (['kodikplayer.com', 'kodikplayer.org', 'kodik.info', 'kodik.cc'].includes(url.hostname))
      return 'Kodik';
    if (['alloha.yani.tv', 'alloha.tv', 'streamalloha.live'].includes(url.hostname))
      return 'Alloha';
    if (url.hostname === 'player.aksor.tv') return 'Aksor';
  } catch {
    return undefined;
  }
}

export function kodikMp4(result: StreamResult): StreamResult | undefined {
  if (result.provider !== 'Kodik') return;
  const streams = result.streams.flatMap(stream =>
    stream.type === 'mp4'
      ? [stream]
      : stream.fallback
        ? [
            {
              ...stream,
              ...stream.fallback,
              legacyUrl: stream.fallback.legacyUrl,
              fallback: undefined,
            },
          ]
        : []
  );
  if (streams.length) return { ...result, streams };
}

async function getJSON(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, credentials: 'omit', cache: 'no-store' });

  if (!response.ok) throw new Error(`Источник вернул HTTP ${response.status}.`);

  return response.json();
}

function validate(result: StreamResult, relayRoot?: URL): StreamResult {
  if (!result || !Array.isArray(result.streams) || !Number.isInteger(result.videoId))
    throw new Error('Некорректные данные потока.');

  const streamUrl = (raw: string) => {
    const relayed =
      result.relay &&
      relayRoot &&
      /^(?:(?:alloha|media)\/[a-f0-9]{32}\/[a-f0-9]{32}|downloads\/[a-f0-9]{32}\/(?:index\.(?:m3u8|mpd)|video\.mp4|caption\.vtt))$/.test(
        raw
      );
    const url = relayed ? new URL(raw, relayRoot) : new URL(raw);

    if (
      (url.protocol !== 'https:' && !(relayed && url.origin === relayRoot!.origin)) ||
      url.username ||
      url.password
    )
      throw new Error('Некорректный адрес видео.');

    return url.href;
  };

  const streams = result.streams.flatMap(stream => {
    try {
      let fallback: Stream['fallback'];

      if (stream.type === 'hls' && stream.fallback?.type === 'mp4') {
        try {
          fallback = {
            type: 'mp4',
            url: streamUrl(stream.fallback.url),
            ...(stream.fallback.legacyUrl && { legacyUrl: streamUrl(stream.fallback.legacyUrl) }),
          };
        } catch {
          // A bad optional fallback must not discard a valid primary stream.
        }
      }

      return Number.isFinite(stream.quality) &&
        stream.quality > 0 &&
        ['mp4', 'hls', 'dash'].includes(stream.type)
        ? [
            {
              ...stream,
              url: streamUrl(stream.url),
              ...(stream.legacyUrl && { legacyUrl: streamUrl(stream.legacyUrl) }),
              ...(stream.captionUrl && { captionUrl: streamUrl(stream.captionUrl) }),
              fallback,
            },
          ]
        : [];
    } catch {
      return [];
    }
  });

  if (!streams.length) throw new Error('Источник не предоставил видео.');

  return {
    ...result,
    streams,
    skips: normalizeSkips(result.skips),
    ...(result.caption
      ? { caption: { ...result.caption, url: streamUrl(result.caption.url) } }
      : {}),
  };
}

function sourcePriority(url: string) {
  if (url.includes('iframeCVH')) return 0;
  if (url.includes('kodik')) return 1;
  if (url.includes('aksor')) return 2;

  return 3;
}

export const streamCandidates = (videos: Video[]) =>
  videos.map(video => ({
    url: video.iframe_url.startsWith('//') ? `https:${video.iframe_url}` : video.iframe_url,
    videoId: video.video_id,
    dubbing: video.data.dubbing,
    episode: video.number,
  }));

const MAX_CANDIDATES = 12;

export async function inspectStreamQualities(videos: Video[], signal: AbortSignal) {
  const desktop = isDesktop();
  const supported = videos.filter(video => {
    const family = streamSourceFamily(video.iframe_url);
    return desktop ? !!family : family === 'CVH';
  });
  const requests: Promise<number[]>[] = [];
  if (desktop) {
    const candidates = streamCandidates(supported);
    for (let i = 0; i < candidates.length; i += MAX_CANDIDATES)
      requests.push(
        desktopInvoke<number[]>(
          'inspect_stream_qualities',
          { candidates: candidates.slice(i, i + MAX_CANDIDATES) },
          signal
        )
      );
  } else {
    for (const candidate of supported)
      requests.push(
        resolveStream([candidate], signal).then(result =>
          result.streams.map(stream => stream.quality)
        )
      );
  }
  const results = await Promise.allSettled(requests);
  return results.flatMap(result =>
    result.status === 'fulfilled' && Array.isArray(result.value)
      ? result.value.filter(quality => Number.isInteger(quality) && quality > 0)
      : []
  );
}

export async function resolveStream(
  videos: Video[],
  signal: AbortSignal,
  options: { preferredVideoId?: number; quality?: number; animeId?: number } = {}
): Promise<StreamResult> {
  const timeout = AbortSignal.timeout(30000);
  const combined = AbortSignal.any([signal, timeout]);

  const sorted = streamCandidates(videos)
    .sort(
      (a, b) =>
        (a.videoId === options.preferredVideoId ? -1 : sourcePriority(a.url)) -
        (b.videoId === options.preferredVideoId ? -1 : sourcePriority(b.url))
    )
    .slice(0, MAX_CANDIDATES);

  if (isDesktop()) {
    const result = await desktopInvoke<StreamResult>(
      'resolve_candidates',
      {
        candidates: sorted,
        ...(options.quality && { quality: options.quality }),
        ...(options.animeId && { animeId: options.animeId }),
      },
      combined
    );

    return validate(result, desktopMediaRoot());
  }

  let directError = '';
  let reserve: { result: StreamResult; rank: number } | undefined;

  for (const candidate of sorted.filter(value => streamSourceFamily(value.url) === 'CVH')) {
    try {
      const url = new URL(candidate.url);
      const id = url.searchParams.get('anime_id');

      if (!/^\d+$/.test(id || '')) continue;

      const playlist = await getJSON(
        `https://plapi.cdnvideohub.com/api/v1/player/sv/playlist?pub=745&aggr=mali&id=${id}`,
        combined
      );
      const item = selectCvhItem(
        playlist,
        candidate.dubbing,
        candidate.episode,
        url.searchParams.get('dubbing_code')
      );

      if (!item?.vkId || !/^\d+$/.test(String(item.vkId)))
        throw new Error('В CVH нет этой серии в выбранной озвучке.');

      const data = await getJSON(
        `https://plapi.cdnvideohub.com/api/v1/player/sv/video/${item.vkId}`,
        combined
      );

      const result = validate({
        provider: 'CVH',
        videoId: candidate.videoId,
        duration: data.duration || 0,
        skips: providerSkips(data),
        streams: Object.entries({
          mpegTinyUrl: 144,
          mpegLowestUrl: 240,
          mpegLowUrl: 360,
          mpegMediumUrl: 480,
          mpegHighUrl: 720,
          mpegFullHdUrl: 1080,
        })
          .filter(([key]) => data.sources?.[key])
          .map(([key, quality]) => ({ quality, url: data.sources[key], type: 'mp4' })),
      });
      if (!options.quality) return result;
      const selected = selectStream(result.streams, String(options.quality));
      if (selected.quality === options.quality) return result;
      const rank = selected.quality <= options.quality ? -selected.quality : selected.quality;
      if (!reserve || rank < reserve.rank) reserve = { result, rank };
    } catch (error) {
      if (combined.aborted) throw error;
      directError = (error as Error).message;
    }
  }
  if (reserve) return reserve.result;
  throw new Error(
    directError || 'Прямой поток недоступен в браузере. Открой приложение или плеер источника.'
  );
}
