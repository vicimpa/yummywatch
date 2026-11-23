import { voiceKey } from './streams';
import type { Anime, Video, WatchEntry } from './types';

export function playerUrl(raw: string) {
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);

    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

export const groupKey = (video: Video) =>
  JSON.stringify([video.data.player_id, video.data.player, video.data.dubbing]);

export function watchMatchesVideo(
  entry: WatchEntry,
  video: Pick<Video, 'video_id' | 'number'> & { data: Pick<Video['data'], 'dubbing'> }
) {
  if (entry.videoId > 0 && entry.videoId === video.video_id) return true;
  if (entry.episode !== video.number) return false;
  try {
    const group: unknown = JSON.parse(entry.group);
    return (
      Array.isArray(group) &&
      typeof group[2] === 'string' &&
      voiceKey(group[2]) === voiceKey(video.data.dubbing)
    );
  } catch {
    return false;
  }
}

export function groupVideos(videos: Video[]) {
  const groups = new Map<string, { label: string; videos: Video[] }>();

  for (const video of videos) {
    if (!video.data || !playerUrl(video.iframe_url)) continue;

    const key = groupKey(video);

    if (!groups.has(key))
      groups.set(key, {
        label: `${video.data.dubbing || 'Оригинал'} · ${video.data.player || 'Плеер'}`,
        videos: [],
      });
    groups.get(key)!.videos.push(video);
  }
  for (const group of groups.values())
    group.videos.sort(
      (a, b) => a.number.localeCompare(b.number, 'ru', { numeric: true }) || a.index - b.index
    );

  return groups;
}

export const canStartAnime = (anime: Anime) =>
  anime.anime_status?.alias !== 'announcement' || (anime.episodes?.aired ?? 0) > 0;

export function resumeVideo(videos: Video[], entry?: WatchEntry) {
  const latest = [...videos]
    .filter(video => video.watched?.date)
    .sort((a, b) => (b.watched?.date || 0) - (a.watched?.date || 0))[0];

  if (latest && (latest.watched?.date || 0) * 1000 > (entry?.updatedAt || 0)) return latest;

  return (
    videos.find(v => v.video_id === entry?.videoId) ||
    videos
      .filter(v => v.number === entry?.episode)
      .sort((a, b) => (b.watched?.date || 0) - (a.watched?.date || 0))[0] ||
    videos[0]
  );
}

export function latestWatchEntry(anime: Anime, videos: Video[]): WatchEntry | undefined {
  const video = [...videos]
    .filter(video => video.watched && (video.watched.date > 0 || video.watched.end_time > 0))
    .sort((a, b) => (b.watched?.date || 0) - (a.watched?.date || 0))[0];

  if (!video) return;

  return {
    anime,
    episode: video.number,
    videoId: video.video_id,
    group: groupKey(video),
    updatedAt: (video.watched?.date || 0) * 1000,
    ...videoPosition(video),
  };
}

export function playbackUrl(video: Video, position: number, exact = false) {
  const raw = playerUrl(video.iframe_url);

  if (!raw) return '';

  const url = new URL(raw);
  const start = Math.max(0, Math.floor(position - (exact ? 0 : 5)));

  if (Number.isFinite(start) && start > 0) {
    if (url.hostname.includes('kodik') || url.pathname.includes('iframeCVH'))
      url.searchParams.set('start_from', String(start));
    else if (url.hostname.includes('alloha')) url.searchParams.set('start', String(start));
  }

  return url.href;
}

export function playbackMessage(data: unknown): { time?: number; duration?: number } | null {
  if (typeof data === 'string') {
    if (data.length > 10000) return null;
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object') return null;

  const message = data as Record<string, unknown>;
  const key = typeof message.key === 'string' ? message.key.replace(/^kodik_/, '') : message.event;
  const value = message.key ? message.value : message.time;

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 86400)
    return null;
  if (key === 'player_time_update' || key === 'timeupdate') return { time: value };
  if (key === 'player_duration_update' || key === 'duration') return { duration: value };

  return null;
}

export function formatTime(seconds = 0) {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const parts = [Math.floor(value / 60) % 60, value % 60].map(number =>
    String(number).padStart(2, '0')
  );

  if (value >= 3600) parts.unshift(String(Math.floor(value / 3600)));

  return parts.join(':');
}

export function videoPosition(video: Video, history?: WatchEntry) {
  const matches =
    history?.videoId === video.video_id || (!history?.videoId && history?.episode === video.number);
  const position =
    matches && (history?.updatedAt || 0) >= (video.watched?.date || 0) * 1000
      ? history?.position || 0
      : video.watched?.end_time || 0;
  const duration = video.duration || (matches ? history?.duration : 0) || 0;

  return { position, duration };
}

export function playerCommand(
  video: Video,
  command: 'play' | 'pause' | 'seek',
  seconds = 0
): unknown | null {
  const raw = playerUrl(video.iframe_url);

  if (!raw) return null;

  const url = new URL(raw);

  if (url.hostname === 'player.aksor.tv')
    return {
      key: `player_${command}`,
      ...(command === 'seek' ? { value: Math.max(0, seconds) } : {}),
    };
  if (url.hostname.includes('kodik'))
    return {
      key: 'kodik_player_api',
      value: { method: command, ...(command === 'seek' ? { seconds: Math.max(0, seconds) } : {}) },
    };
  if (url.hostname.includes('alloha'))
    return JSON.stringify({
      api: command,
      ...(command === 'seek' ? { value: Math.max(0, seconds) } : {}),
    });

  return null;
}

export function playbackEvent(data: unknown): 'play' | 'pause' | 'ended' | null {
  if (typeof data === 'string') {
    if (data.length > 10000) return null;
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object') return null;

  const value = data as { key?: string; event?: string };
  const key = typeof value.key === 'string' ? value.key.replace(/^kodik_/, '') : value.event;

  if (key === 'player_play' || key === 'player_video_started' || key === 'play') return 'play';
  if (key === 'player_pause' || key === 'pause') return 'pause';
  if (key === 'player_video_ended' || key === 'ended') return 'ended';

  return null;
}
