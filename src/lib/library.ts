import { cachePersonalRating, yummyFetch } from './api';
import { personalRating, PERSONAL_RATING_EVENT } from './ratings';
import { invalidateProfileData } from './profile-cache';
import {
  confirmContinue,
  mergeContinueHistory,
  readContinueHistory,
  syncContinueHistory,
  hideContinue,
  isContinueHidden,
  restoreContinue,
} from './continue-cache';
import { isWatchList, WATCH_LISTS, type WatchListId } from './lists';
import { getSession } from './session';
import {
  clearHistory as clearGuestHistory,
  LIBRARY_EVENT,
  readLibrary,
  readJSON,
  writeJSON,
  recordWatch as recordGuestWatch,
  removeHistoryEntry,
  setAnimeList as setGuestList,
  toggleFavorite as toggleGuestFavorite,
  setPersonalRating as setGuestRating,
} from './storage';
import type { Anime, Library, Video, WatchEntry } from './types';

export interface LibraryState extends Library {
  account: boolean;
  loading: boolean;
  error: string;
  syncedAt: number;
  hasMore: boolean;
  loadingMore: boolean;
}

interface RemoteAnime extends Omit<Anime, 'rating'> {
  rating?: number | Anime['rating'];
}

interface RemoteWatch extends RemoteAnime {
  video_id?: number;
  ep_title?: string;
  number?: string;
  date?: number;
  end_time?: number;
  duration?: number;
  data?: Video['data'];
  screenshot?: { sizes?: { small?: string } };
}

let owner = '';
let accountState: LibraryState = emptyState();
let revision = 0;
let historyOffset = 0;
let inFlight: { token: string; promise: Promise<void> } | undefined;

const emit = () => window.dispatchEvent(new Event(LIBRARY_EVENT));

function emptyState(): LibraryState {
  return {
    favorites: [],
    history: [],
    lists: {},
    rated: [],
    account: true,
    loading: true,
    error: '',
    syncedAt: 0,
    hasMore: false,
    loadingMore: false,
  };
}

function stateFor(token: string) {
  if (owner !== token) {
    owner = token;
    accountState = emptyState();
    historyOffset = 0;
    revision++;
  }

  return accountState;
}

export function getLibraryState(): LibraryState {
  const session = getSession();
  const state = session ? stateFor(session.token) : undefined;

  const guest = state ? undefined : readLibrary();
  const pending = state
    ? Object.values(readWatchActivity()).filter(entry => entry.pending !== undefined)
    : [];
  const lists =
    state && pending.length
      ? Object.fromEntries(
          WATCH_LISTS.map(({ id }) => [
            id,
            [
              ...pending.filter(entry => entry.pending === id).map(entry => entry.anime),
              ...(state.lists?.[id] || []).filter(
                anime => !pending.some(entry => entry.anime.anime_id === anime.anime_id)
              ),
            ],
          ])
        )
      : state?.lists;

  return state
    ? {
        ...state,
        lists,
        history: mergeContinueHistory(readContinueHistory(), state.history).filter(
          entry => !isContinueHidden(entry.anime.anime_id)
        ),
      }
    : {
        ...guest!,
        history: guest!.history.filter(entry => !isContinueHidden(entry.anime.anime_id)),
        account: false,
        loading: false,
        error: '',
        syncedAt: 0,
        hasMore: false,
        loadingMore: false,
      };
}

export function resetAccountLibrary() {
  owner = '';
  accountState = emptyState();
  historyOffset = 0;
  revision++;
  emit();
}

export function normalizeAnime(value: RemoteAnime): Anime {
  return {
    ...value,
    rating: typeof value.rating === 'number' ? { average: value.rating } : value.rating,
  };
}

export function normalizeHistory(values: RemoteWatch[]): WatchEntry[] {
  const result = new Map<number, WatchEntry>();

  for (const value of [...values].sort((a, b) => (b.date || 0) - (a.date || 0))) {
    if (!value?.anime_id || !value.title || result.has(value.anime_id)) continue;
    result.set(value.anime_id, {
      anime: normalizeAnime(value),
      episode: String(value.number || value.ep_title || ''),
      group: value.data
        ? JSON.stringify([value.data.player_id, value.data.player, value.data.dubbing])
        : '',
      videoId: value.video_id || 0,
      updatedAt: (value.date || 0) * 1000,
      position: Math.max(0, value.end_time || 0),
      duration: value.duration || 0,
      preview: value.screenshot?.sizes?.small,
    });
  }

  return [...result.values()];
}

export function syncLibrary(): Promise<void> {
  const session = getSession();

  if (!session?.verified) return Promise.resolve();
  if (inFlight?.token === session.token) return inFlight.promise;

  const token = session.token;
  const state = stateFor(token);

  state.loading = true;
  state.error = '';
  emit();

  const capturedRevision = revision;
  const promise = (async () => {
    try {
      const [animes, history] = await Promise.all([
        yummyFetch<RemoteAnime[]>(`/users/${session.user.id}/lists`, { token }),
        yummyFetch<RemoteWatch[]>('/video/watch-history', {
          token,
          params: { limit: 100, offset: 0 },
        }),
      ]);

      if (getSession()?.token !== token || owner !== token) return;
      if (!Array.isArray(animes) || !Array.isArray(history))
        throw new Error('Yummy вернул неожиданный формат коллекции.');
      if (revision === capturedRevision) {
        accountState = {
          rated: animes.filter(value => personalRating(normalizeAnime(value))).map(normalizeAnime),
          favorites: animes.filter(value => value.user?.list?.is_fav).map(normalizeAnime),
          lists: Object.fromEntries(
            WATCH_LISTS.map(({ id }) => [
              id,
              animes.filter(value => value.user?.list?.list?.id === id).map(normalizeAnime),
            ])
          ),
          history: normalizeHistory(history),
          account: true,
          loading: false,
          error: '',
          syncedAt: Date.now(),
          hasMore: history.length === 100,
          loadingMore: false,
        };
        accountState.history = syncContinueHistory(accountState.history, token);
        historyOffset = history.length;
        queueMicrotask(() => runWatchMaintenance());
      }
    } catch (error) {
      if (getSession()?.token === token && owner === token)
        accountState.error = (error as Error).message;
    } finally {
      if (owner === token && getSession()?.token === token) {
        accountState.loading = false;
        emit();
      }
      if (inFlight?.token === token) inFlight = undefined;
      if (owner === token && getSession()?.token === token && capturedRevision !== revision)
        queueMicrotask(() => void syncLibrary());
    }
  })();

  inFlight = { token, promise };

  return promise;
}

export async function loadMoreHistory() {
  const session = getSession();

  if (!session?.verified) return;

  const state = stateFor(session.token);

  if (state.loadingMore || !state.hasMore) return;
  state.loadingMore = true;
  state.error = '';
  emit();
  try {
    const values = await yummyFetch<RemoteWatch[]>('/video/watch-history', {
      token: session.token,
      params: { limit: 100, offset: historyOffset },
    });

    if (getSession()?.token !== session.token || owner !== session.token) return;
    if (!Array.isArray(values)) throw new Error('Не удалось прочитать историю Yummy.');

    const entries = normalizeHistory(values);
    const ids = new Set(accountState.history.map(entry => entry.anime.anime_id));

    accountState.history.push(...entries.filter(entry => !ids.has(entry.anime.anime_id)));
    accountState.history = syncContinueHistory(accountState.history, session.token);
    historyOffset += values.length;
    accountState.hasMore = values.length === 100;
  } catch (error) {
    if (owner === session.token) accountState.error = (error as Error).message;
  } finally {
    if (owner === session.token) {
      accountState.loadingMore = false;
      emit();
    }
  }
}

const favoritePending = new Set<string>();

const ratingPending = new Set<string>();
export async function setPersonalRating(anime: Anime, rating: number | null) {
  if (!Number.isSafeInteger(anime.anime_id) || anime.anime_id <= 0)
    throw new Error('Неизвестное аниме.');
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 10))
    throw new Error('Выбери оценку от 1 до 10.');
  const session = getSession();
  if (!session) {
    setGuestRating(anime, rating);
    return;
  }
  if (!session.verified) throw new Error('Дождись проверки аккаунта или повтори вход.');
  const key = `${session.token}:${anime.anime_id}`;
  if (ratingPending.has(key)) throw new Error('Оценка уже сохраняется.');
  stateFor(session.token);
  ratingPending.add(key);
  try {
    const result = await yummyFetch<{ rating: number; votes: number }>(
      `/anime/${anime.anime_id}/rate`,
      {
        token: session.token,
        method: rating === null ? 'DELETE' : 'PUT',
        ...(rating !== null ? { body: { rate: rating } } : {}),
      }
    );
    if (
      !result ||
      !Number.isFinite(result.rating) ||
      result.rating < 0 ||
      result.rating > 10 ||
      !Number.isSafeInteger(result.votes) ||
      result.votes < 0
    )
      throw new Error('Yummy не подтвердил сохранение оценки.');
    if (getSession()?.token !== session.token || owner !== session.token)
      throw new DOMException('Сессия изменилась.', 'AbortError');
    const state = stateFor(session.token);
    revision++;
    const update = (value: Anime) =>
      value.anime_id === anime.anime_id
        ? {
            ...value,
            user: { ...value.user, rating: rating || 0 },
            rating: { average: result.rating, counters: result.votes },
          }
        : value;
    const rated = (state.rated || []).filter(value => value.anime_id !== anime.anime_id);
    if (rating) rated.unshift(update(anime));
    state.rated = rated;
    state.favorites = state.favorites.map(update);
    state.lists = Object.fromEntries(
      Object.entries(state.lists || {}).map(([id, values]) => [id, values.map(update)])
    );
    state.history = state.history.map(entry => ({ ...entry, anime: update(entry.anime) }));
    cachePersonalRating(anime, rating || 0, result);
    invalidateProfileData(`ratings:${session.user.id}`);
    emit();
    window.dispatchEvent(
      new CustomEvent(PERSONAL_RATING_EVENT, {
        detail: { animeId: anime.anime_id, userId: session.user.id },
      })
    );
  } finally {
    ratingPending.delete(key);
  }
}

export async function toggleFavorite(anime: Anime) {
  const session = getSession();

  if (!session) return toggleGuestFavorite(anime);
  if (!session.verified) throw new Error('Дождись проверки аккаунта или повтори вход.');

  const state = stateFor(session.token);

  if (!state.syncedAt) throw new Error('Сначала обнови коллекцию аккаунта.');

  const key = `${session.token}:${anime.anime_id}`;

  if (favoritePending.has(key)) throw new Error('Изменение уже сохраняется.');

  const exists = state.favorites.some(value => value.anime_id === anime.anime_id);

  favoritePending.add(key);
  try {
    const success = await yummyFetch<boolean>(`/anime/${anime.anime_id}/list/fav`, {
      token: session.token,
      method: exists ? 'DELETE' : 'PUT',
      ...(!exists ? { body: { date: Math.floor(Date.now() / 1000) } } : {}),
    });

    if (success !== true) throw new Error('Yummy не подтвердил изменение избранного.');
    if (getSession()?.token !== session.token || owner !== session.token) return !exists;
    revision++;
    accountState.favorites = exists
      ? accountState.favorites.filter(value => value.anime_id !== anime.anime_id)
      : [anime, ...accountState.favorites];
    emit();

    return !exists;
  } finally {
    favoritePending.delete(key);
  }
}

const watchQueues = new Map<string, Promise<void>>();

export async function recordWatch(
  anime: Anime,
  video: Video,
  group: string,
  position?: number,
  duration?: number,
  expectedToken: string | null = getSession()?.token || null,
  startedAt?: number
) {
  const session = getSession();

  // A player belonging to a previous session must never write to the new account.
  if ((session?.token || null) !== expectedToken) return;
  restoreContinue(anime.anime_id, startedAt);
  if (!session) {
    if (isContinueHidden(anime.anime_id)) return;
    recordGuestWatch(anime, video, group, position, duration);

    return;
  }
  if (!session.verified) throw new Error('Войди снова, чтобы сохранить просмотр в Yummy.');
  const state = stateFor(session.token);
  const previous = state.history.find(entry => entry.anime.anime_id === anime.anime_id);
  const same =
    previous?.videoId === video.video_id ||
    (!previous?.videoId && previous?.episode === video.number);
  const time = Math.floor(
    Math.max(0, position ?? video.watched?.end_time ?? (same ? previous?.position : 0) ?? 0)
  );
  const length = Math.floor(
    Math.max(0, duration ?? video.duration ?? (same ? previous?.duration : 0) ?? 0)
  );
  const recordedAt = Date.now();
  const queueKey = `${session.token}:${anime.anime_id}`;
  const previousWrite = watchQueues.get(queueKey) || Promise.resolve();
  const write = previousWrite
    .catch(() => {})
    .then(async () => {
      if (getSession()?.token !== session.token) return;

      const success = await yummyFetch<boolean>(`/video/${video.video_id}`, {
        token: session.token,
        method: 'PUT',
        body: { time, duration: length, date: Math.floor(recordedAt / 1000) },
        keepalive: true,
      });

      if (success !== true) throw new Error('Yummy не подтвердил сохранение просмотра.');
      if (getSession()?.token !== session.token || owner !== session.token) return;
      revision++;
      accountState.history = [
        {
          anime,
          videoId: video.video_id,
          episode: video.number,
          group,
          updatedAt: recordedAt,
          position: time,
          duration: length,
          preview: anime.random_screenshots?.find(frame => frame.episode === video.number)?.sizes
            .small,
        },
        ...accountState.history.filter(entry => entry.anime.anime_id !== anime.anime_id),
      ];
      confirmContinue(accountState.history[0], session.token);
      emit();
    });

  watchQueues.set(queueKey, write);
  try {
    await write;
  } finally {
    if (watchQueues.get(queueKey) === write) watchQueues.delete(queueKey);
  }
}

export function clearHistory() {
  if (getSession()) throw new Error('Историю аккаунта можно управлять на YummyAnime.');
  clearGuestHistory();
}

export function removeContinue(animeId: number) {
  if (!Number.isSafeInteger(animeId) || animeId <= 0) throw new Error('Неизвестное аниме.');
  const library = getLibraryState();
  const active = library.history.find(entry => entry.anime.anime_id === animeId)?.anime;
  const activity = readWatchActivity()[animeId];
  const anime = active || activity?.anime;
  hideContinue(animeId);
  if (!getSession()) removeHistoryEntry(animeId);
  else emit();
  if (anime) {
    if (activity?.status === 2 || selectedList(library, animeId) === 2) return;
    queueWatchList(anime, 5, Date.now());
  }
}

type WatchActivity = {
  anime: Anime;
  last: number;
  begun?: number;
  manualAt?: number;
  status?: WatchListId;
  from?: WatchListId;
  baseKnown?: boolean;
  pending?: WatchListId;
};

const activityKey = () => {
  const user = getSession()?.user.id;
  return `yumiwatch:watch-activity:v1:${user ? `account:${user}` : 'guest'}`;
};
const readWatchActivity = () => readJSON<Record<number, WatchActivity>>(activityKey(), {});
const automaticWrites = new Map<string, Promise<void>>();
const inactiveTime = 30 * 24 * 60 * 60 * 1000;

function selectedList(library: Library, id: number) {
  return WATCH_LISTS.find(list => library.lists?.[list.id]?.some(anime => anime.anime_id === id))
    ?.id;
}

function storeActivity(anime: Anime, patch: Partial<WatchActivity>) {
  const entries = readWatchActivity();
  const compact: Anime = {
    anime_id: anime.anime_id,
    anime_url: anime.anime_url,
    title: anime.title,
    poster: anime.poster,
    year: anime.year,
    type: anime.type,
    anime_status: anime.anime_status,
    episodes: anime.episodes,
  };
  const previous = entries[anime.anime_id] || { anime: compact, last: 0 };
  const next = { ...previous, ...patch };
  next.anime = {
    ...next.anime,
    ...compact,
    anime_status: anime.anime_status || next.anime.anime_status,
    episodes: anime.episodes || next.anime.episodes,
  };
  entries[anime.anime_id] = next;
  writeJSON(activityKey(), entries);
}

function queueWatchList(anime: Anime, status: WatchListId, at: number) {
  const activity = readWatchActivity()[anime.anime_id];
  if ((activity?.manualAt ?? 0) > at) return;
  const session = getSession();
  const library = session ? stateFor(session.token) : readLibrary();
  const from = selectedList(library, anime.anime_id);
  if (!session) {
    storeActivity(anime, { status, pending: undefined });
    if (from !== status) setGuestList(anime, status);
    return;
  }
  const pending = from !== status || automaticWrites.has(`${activityKey()}:${anime.anime_id}`);
  storeActivity(anime, {
    status,
    pending: pending ? status : undefined,
    from,
    baseKnown: !!accountState.syncedAt,
  });
  applyWatchLists();
  if (pending) emit();
}

function applyWatchLists() {
  const session = getSession();
  if (!session?.verified || !stateFor(session.token).syncedAt || navigator.onLine === false) return;
  const token = session.token;
  const scope = activityKey();
  for (const entry of Object.values(readWatchActivity())) {
    const target = entry.pending;
    if (target === undefined) continue;
    const id = entry.anime.anime_id;
    const key = `${scope}:${id}`;
    if (automaticWrites.has(key)) continue;
    const current = selectedList(stateFor(session.token), id);
    if (current === target || (entry.baseKnown && current !== entry.from)) {
      storeActivity(entry.anime, { pending: undefined, status: current });
      continue;
    }
    const write = commitAnimeList(entry.anime, target);
    automaticWrites.set(key, write);
    void write
      .then(() => {
        if ((getSession()?.token || null) !== token) return;
        const latest = readWatchActivity()[id];
        if (latest?.pending === target) storeActivity(entry.anime, { pending: undefined });
        else if (latest?.pending !== undefined)
          storeActivity(entry.anime, { from: target, baseKnown: true });
      })
      .catch(() => {})
      .finally(() => {
        automaticWrites.delete(key);
        if (
          (getSession()?.token || null) === token &&
          readWatchActivity()[id]?.pending !== target
        ) {
          applyWatchLists();
          emit();
        }
      });
  }
}

type WatchActivityKind = 'start' | 'progress' | 'complete';

export function watchActivity(
  anime: Anime,
  video: Video,
  token: string | null,
  run: number,
  kind: WatchActivityKind
) {
  if ((getSession()?.token || null) !== token) return;
  try {
    updateWatchActivity(anime, video, token, run, kind);
  } catch {
    // Recording progress remains usable if list changes cannot be saved.
  }
}

function updateWatchActivity(
  anime: Anime,
  video: Video,
  token: string | null,
  run: number,
  kind: WatchActivityKind
) {
  const current = readWatchActivity()[anime.anime_id];
  if ((current?.begun ?? 0) > run || (current?.manualAt ?? 0) > run) return;
  const now = Date.now();
  if (kind === 'progress' && current?.last && now - current.last < 60000) return;
  if (kind === 'start') {
    if (current?.begun === run) return;
    restoreContinue(anime.anime_id, run);
    if (isContinueHidden(anime.anime_id)) return;
    storeActivity(anime, { last: now, begun: run });
    queueWatchList(anime, 0, run);
  } else if (kind === 'progress') {
    if (!isContinueHidden(anime.anime_id)) storeActivity(anime, { last: now, begun: run });
  } else {
    const title = anime.anime_status ? anime : current?.anime || anime;
    const count = title.episodes?.count;
    const film = title.type?.alias === 'movie' || title.type?.alias === 'shortfilm';
    const lastEpisode =
      count &&
      title.episodes?.aired === count &&
      /^\d+$/.test(video.number) &&
      Number(video.number) === count;
    const onlyFilm = film && (!count || count === 1) && ['0', '1'].includes(video.number);
    const finale = title.anime_status?.alias === 'released' && (lastEpisode || onlyFilm);
    if (!finale) return;
    hideContinue(anime.anime_id, Math.max(now, run));
    if (!token) removeHistoryEntry(anime.anime_id);
    else emit();
    storeActivity(anime, { last: now, begun: run });
    queueWatchList(anime, 2, run);
  }
}

export function runWatchMaintenance() {
  const library = getLibraryState();
  if (library.account && (!library.syncedAt || library.loading)) return;
  if (library.account && Date.now() - library.syncedAt > 60000) {
    applyWatchLists();
    return;
  }
  const entries = readWatchActivity();
  for (const anime of library.lists?.[0] || []) {
    const id = anime.anime_id;
    const entry = entries[id];
    const history = library.history.find(value => value.anime.anime_id === id);
    const last = Math.max(entry?.last || 0, entry?.manualAt || 0, history?.updatedAt || 0);
    if (!last || Date.now() - last < inactiveTime || entry?.pending !== undefined) continue;
    const metadata = anime.anime_status ? anime : entry?.anime || anime;
    if (
      metadata.anime_status?.alias === 'ongoing' &&
      (!metadata.episodes?.aired || !history || Number(history.episode) >= metadata.episodes.aired)
    )
      continue;
    queueWatchList(anime, 3, Date.now());
  }
  applyWatchLists();
}

const listPending = new Set<string>();

export async function setAnimeList(anime: Anime, selected: WatchListId | null) {
  if (selected !== null && !isWatchList(selected)) throw new Error('Неизвестный список.');
  const token = getSession()?.token || null;
  const pending = automaticWrites.get(`${activityKey()}:${anime.anime_id}`);
  if (pending) await pending.catch(() => {});
  if ((getSession()?.token || null) !== token) return;
  await commitAnimeList(anime, selected);
  if ((getSession()?.token || null) === token)
    storeActivity(anime, {
      manualAt: Date.now(),
      status: selected ?? undefined,
      pending: undefined,
    });
}

async function commitAnimeList(anime: Anime, selected: WatchListId | null) {
  if (selected !== null && !isWatchList(selected)) throw new Error('Неизвестный список.');

  const session = getSession();

  if (!session) {
    setGuestList(anime, selected);

    return;
  }
  if (!session.verified) throw new Error('Дождись проверки аккаунта или повтори вход.');

  const state = stateFor(session.token);

  if (!state.syncedAt) throw new Error('Сначала обнови коллекцию аккаунта.');

  const key = `${session.token}:${anime.anime_id}`;

  if (listPending.has(key)) throw new Error('Изменение списка уже сохраняется.');
  listPending.add(key);
  try {
    const result = await yummyFetch<boolean | { success: boolean; list?: { id: number } }>(
      `/anime/${anime.anime_id}/list`,
      {
        token: session.token,
        method: selected === null ? 'DELETE' : 'PUT',
        ...(selected !== null
          ? { body: { list: selected, date: Math.floor(Date.now() / 1000) } }
          : {}),
      }
    );

    if (
      selected === null
        ? result !== true && !(typeof result === 'object' && result?.success)
        : typeof result !== 'object' || !result?.success || result.list?.id !== selected
    )
      throw new Error('Yummy не подтвердил изменение списка.');
    if (getSession()?.token !== session.token || owner !== session.token) return;
    revision++;

    const lists = Object.fromEntries(
      WATCH_LISTS.map(({ id }) => [
        id,
        (accountState.lists?.[id] || []).filter(value => value.anime_id !== anime.anime_id),
      ])
    ) as NonNullable<Library['lists']>;

    if (selected !== null) lists[selected]!.unshift(anime);
    accountState.lists = lists;
    emit();
  } finally {
    listPending.delete(key);
  }
}
