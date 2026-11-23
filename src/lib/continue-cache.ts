import { getSession } from './session';
import { LIBRARY_EVENT, readJSON, writeJSON } from './storage';
import type { WatchEntry } from './types';

interface SavedEntry {
  entry: WatchEntry;
  pending: boolean;
}

const key = () => {
  const session = getSession();

  return session ? `yumiwatch:continue:v1:account:${session.user.id}` : undefined;
};

const hiddenKey = () => {
  const session = getSession();
  return `yumiwatch:continue-hidden:v1:${session ? `account:${session.user.id}` : 'guest'}`;
};

function hiddenEntries(): Record<number, number> {
  const value = readJSON<Record<number, number> | number[]>(hiddenKey(), {});
  return Array.isArray(value)
    ? Object.fromEntries(value.filter(id => Number.isSafeInteger(id) && id > 0).map(id => [id, 1]))
    : value;
}

export const isContinueHidden = (animeId: number) => !!hiddenEntries()[animeId];

export function hideContinue(animeId: number, until = Date.now()) {
  const saved = hiddenEntries();
  if (!writeJSON(hiddenKey(), { ...saved, [animeId]: Math.max(saved[animeId] || 0, until) }))
    throw new Error('Не удалось сохранить изменение на устройстве.');
  write(read().filter(value => value.entry.anime.anime_id !== animeId));
}

export function restoreContinue(animeId: number, startedAt = Infinity) {
  const saved = hiddenEntries();
  if (!saved[animeId] || saved[animeId] >= startedAt) return;
  delete saved[animeId];
  if (!writeJSON(hiddenKey(), saved))
    throw new Error('Не удалось сохранить изменение на устройстве.');
}

function compact(entry: WatchEntry): WatchEntry | undefined {
  if (
    !entry?.anime ||
    !Number.isInteger(entry.anime.anime_id) ||
    typeof entry.anime.title !== 'string' ||
    typeof entry.episode !== 'string' ||
    !Number.isFinite(entry.updatedAt)
  )
    return;

  const anime = entry.anime,
    poster = anime.poster;

  return {
    anime: {
      anime_id: anime.anime_id,
      anime_url: anime.anime_url || '',
      title: anime.title,
      year: anime.year,
      poster: poster ? { medium: poster.medium, big: poster.big } : undefined,
    },
    episode: entry.episode,
    videoId: entry.videoId || 0,
    group: typeof entry.group === 'string' ? entry.group : '',
    updatedAt: entry.updatedAt,
    position: Number.isFinite(entry.position) ? Math.max(0, entry.position!) : 0,
    duration: Number.isFinite(entry.duration) ? Math.max(0, entry.duration!) : 0,
    preview: entry.preview,
    playing: entry.playing,
  };
}

function read(): SavedEntry[] {
  const address = key(),
    values = address ? readJSON<unknown>(address, []) : [];

  return Array.isArray(values)
    ? values
        .flatMap(value => {
          const entry = compact(value?.entry);

          return entry ? [{ entry, pending: value.pending === true }] : [];
        })
        .slice(0, 100)
    : [];
}

function write(values: SavedEntry[]) {
  const address = key();

  if (!address) return;
  writeJSON(address, values.sort((a, b) => b.entry.updatedAt - a.entry.updatedAt).slice(0, 100));
}

export function mergeContinueHistory(...groups: WatchEntry[][]) {
  const entries = new Map<number, WatchEntry>();

  for (const entry of groups.flat()) {
    const previous = entries.get(entry.anime.anime_id);

    if (!previous || entry.updatedAt > previous.updatedAt) entries.set(entry.anime.anime_id, entry);
  }

  return [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export const readContinueHistory = () =>
  read()
    .map(value => value.entry)
    .filter(entry => !isContinueHidden(entry.anime.anime_id));

export function rememberContinue(entry: WatchEntry, token: string | null, startedAt?: number) {
  if (!getSession() || getSession()?.token !== token) return;

  const value = compact(entry);

  if (!value) return;
  restoreContinue(value.anime.anime_id, startedAt);
  if (isContinueHidden(value.anime.anime_id)) return;
  write([
    { entry: value, pending: true },
    ...read().filter(previous => previous.entry.anime.anime_id !== value.anime.anime_id),
  ]);
  window.dispatchEvent(new Event(LIBRARY_EVENT));
}

export function confirmContinue(entry: WatchEntry, token: string) {
  if (getSession()?.token !== token) return;
  if (isContinueHidden(entry.anime.anime_id)) return;

  const value = compact(entry);

  if (!value) return;

  const saved = read(),
    previous = saved.find(item => item.entry.anime.anime_id === value.anime.anime_id);

  if (
    previous &&
    (previous.entry.updatedAt > value.updatedAt ||
      (previous.pending &&
        previous.entry.updatedAt === value.updatedAt &&
        (previous.entry.videoId !== value.videoId ||
          previous.entry.position !== value.position ||
          previous.entry.episode !== value.episode)))
  )
    return;
  if (previous?.entry.videoId === value.videoId) value.playing = previous.entry.playing;
  write([
    { entry: value, pending: false },
    ...saved.filter(item => item.entry.anime.anime_id !== value.anime.anime_id),
  ]);
}

export function syncContinueHistory(entries: WatchEntry[], token: string) {
  if (getSession()?.token !== token) return entries;

  const pending = read().filter(value => value.pending),
    history = mergeContinueHistory(
      pending.map(value => value.entry),
      entries.filter(entry => !isContinueHidden(entry.anime.anime_id))
    );

  write(
    history.flatMap(entry => {
      const value = compact(entry);

      return value
        ? [
            {
              entry: value,
              pending: pending.some(
                item =>
                  item.entry.anime.anime_id === value.anime.anime_id &&
                  item.entry.updatedAt === value.updatedAt
              ),
            },
          ]
        : [];
    })
  );

  return history;
}
