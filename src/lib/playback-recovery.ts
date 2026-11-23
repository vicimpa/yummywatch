import { isContinueHidden, rememberContinue } from './continue-cache';
import { getSession } from './session';
import { readJSON, writeJSON } from './storage';
import type { WatchEntry } from './types';

// Account IDs isolate local recovery without persisting authentication tokens.
function recoveryKey() {
  const session = getSession();

  return `yumiwatch:playback-recovery:v1:${session ? `account:${session.user.id}` : 'guest'}`;
}

export function readPlaybackRecovery(
  animeId: number,
  includeHidden = false
): WatchEntry | undefined {
  if (!includeHidden && isContinueHidden(animeId)) return;
  const entry = readJSON<Record<string, WatchEntry>>(recoveryKey(), {})[animeId];

  return entry?.anime?.anime_id === animeId &&
    Number.isFinite(entry.position) &&
    entry.position! >= 0 &&
    Number.isFinite(entry.updatedAt)
    ? entry
    : undefined;
}

const episodeKey = (animeId: number, episode: string) => JSON.stringify([animeId, episode.trim()]);

export function episodePlaybackIndex(animeId: number, ...fallbacks: (WatchEntry | undefined)[]) {
  const episodes = readJSON<Record<string, WatchEntry>>(recoveryKey() + ':episodes', {});
  const entries = new Map<string, WatchEntry>();
  for (const entry of [
    readPlaybackRecovery(animeId, true),
    ...fallbacks,
    ...Object.values(episodes),
  ]) {
    if (
      !entry ||
      entry.anime?.anime_id !== animeId ||
      typeof entry.episode !== 'string' ||
      !Number.isFinite(entry.position) ||
      entry.position! < 0 ||
      !Number.isFinite(entry.updatedAt)
    )
      continue;
    const episode = entry.episode.trim();
    if (entry.updatedAt >= (entries.get(episode)?.updatedAt ?? -1)) entries.set(episode, entry);
  }
  return entries;
}

export function episodePlayback(
  animeId: number,
  episode: string,
  ...fallbacks: (WatchEntry | undefined)[]
) {
  return episodePlaybackIndex(animeId, ...fallbacks).get(episode.trim());
}

export function savePlaybackRecovery(entry: WatchEntry, token: string | null, startedAt?: number) {
  if ((getSession()?.token || null) !== token) return;

  const key = recoveryKey();
  const episodes = readJSON<Record<string, WatchEntry>>(key + ':episodes', {});
  const episode = episodeKey(entry.anime.anime_id, entry.episode);
  if ((episodes[episode]?.updatedAt ?? -1) <= entry.updatedAt) {
    const { videos: _videos, random_screenshots: _frames, ...anime } = entry.anime;
    episodes[episode] = { ...entry, anime };
    writeJSON(
      key + ':episodes',
      Object.fromEntries(
        Object.entries(episodes)
          .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
          .slice(0, 250)
      )
    );
  }
  const entries = readJSON<Record<string, WatchEntry>>(key, {});
  if ((entries[entry.anime.anime_id]?.updatedAt ?? -1) > entry.updatedAt) return;

  entries[entry.anime.anime_id] = entry;
  writeJSON(
    key,
    Object.fromEntries(
      Object.entries(entries)
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .slice(0, 50)
    )
  );
  rememberContinue(entry, token, startedAt);
}
