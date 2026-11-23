import type { SkipKind } from '../../shared/skips.mjs';

import { recordWatch, watchActivity } from './library';
import { savePlaybackRecovery } from './playback-recovery';
import { groupKey } from './player';
import { getSession } from './session';
import type { Stream } from './streams';
import { trackVoice, type VoiceChoice } from './voice-ranking';
import type { Anime, Video, WatchEntry } from './types';

export const PLAYER_EVENT = 'yumiwatch:playback';

export type PlaybackReason =
  | 'ratechange'
  | 'sourcechange'
  | 'loadedmetadata'
  | 'play'
  | 'playing'
  | 'timeupdate'
  | 'pause'
  | 'seeking'
  | 'seeked'
  | 'buffering'
  | 'offline'
  | 'ended'
  | 'error'
  | 'skip'
  | 'dispose'
  | 'saved'
  | 'saveerror';

export interface MediaUpdate {
  reason: PlaybackReason;
  position: number;
  duration: number;
  playing: boolean;
  seeking?: boolean;
  completed?: boolean;
  playbackRate?: number;
  skip?: { kind: SkipKind; from: number; to: number; automatic: boolean };
}

export interface PlaybackSnapshot {
  animeId: number;
  videoId: number;
  episode: string;
  playerId: number;
  provider: string;
  dubbing: string;
  sourceHost: string;
  quality: number | null;
  format: Stream['type'] | 'iframe';
  relay: boolean;
  position: number;
  duration: number;
  watchedSeconds: number;
  playing: boolean;
  playbackRate: number;
  reason: PlaybackReason;
  sync: 'idle' | 'pending' | 'saving' | 'saved' | 'error';
}

export interface PlaybackReport {
  version: 1;
  reason: PlaybackReason;
  timestamp: number;
  playback: PlaybackSnapshot;
  skip?: MediaUpdate['skip'];
}

const finite = (value: number, fallback = 0) =>
  Number.isFinite(value) && value >= 0 && value <= 86400 ? value : fallback;

// One video_id and account for its whole lifetime, including late writes.
export function createPlaybackSession(options: {
  anime: Anime;
  video: Video;
  token: string | null;
  position: number;
  duration: number;
  run?: number;
  voiceChoice?: VoiceChoice;
  voiceVote?: () => boolean;
  onCheckpoint?: (entry: WatchEntry) => void;
  onReport?: (event: PlaybackReport) => void;
  onChange?: (snapshot: PlaybackSnapshot) => void;
}) {
  const { anime, video, token } = options;
  const run = options.run ?? Date.now();
  const state: PlaybackSnapshot = {
    animeId: anime.anime_id,
    videoId: video.video_id,
    episode: video.number,
    playerId: video.data.player_id,
    provider: video.data.player,
    dubbing: video.data.dubbing,
    sourceHost: '',
    quality: null,
    format: 'iframe',
    relay: false,
    position: finite(options.position),
    duration: finite(options.duration),
    watchedSeconds: 0,
    playing: false,
    playbackRate: 1,
    reason: 'sourcechange',
    sync: 'idle',
  };
  let started = false,
    dirty = false,
    intendedPlaying = false,
    sequence = 0,
    lastReport = -Infinity,
    recordedTime = 0,
    nextActivity = 0,
    voted = false,
    completed = false;
  let last: { now: number; position: number; playing: boolean; seeking: boolean } | undefined;

  const snapshot = () => ({ ...state });

  const publish = (reason: PlaybackReason, skip?: MediaUpdate['skip']) => {
    const now = performance.now();

    if (reason === 'timeupdate' && now - lastReport < 1000) return;
    lastReport = now;

    const report: PlaybackReport = {
      version: 1,
      reason,
      timestamp: Date.now(),
      playback: snapshot(),
      ...(skip ? { skip } : {}),
    };

    options.onReport?.(report);
    window.dispatchEvent(new CustomEvent<PlaybackReport>(PLAYER_EVENT, { detail: report }));
  };

  const saveVoice = () => {
    const elapsed = state.watchedSeconds - recordedTime;
    if (elapsed <= 0 || (getSession()?.token || null) !== token) return;
    trackVoice(
      video.data.dubbing,
      elapsed,
      options.voiceChoice || 'default',
      !voted && (options.voiceVote?.() ?? true)
    );
    voted = true;
    recordedTime = state.watchedSeconds;
  };

  const flush = () => {
    saveVoice();
    if (!started || !dirty || (getSession()?.token || null) !== token) return;
    dirty = false;

    const attempt = ++sequence;
    const position = state.position,
      duration = state.duration;
    const entry = {
      anime,
      videoId: video.video_id,
      episode: video.number,
      group: groupKey(video),
      updatedAt: Date.now(),
      position,
      duration,
      playing: intendedPlaying,
      completed,
    };

    savePlaybackRecovery(entry, token, run);
    options.onCheckpoint?.(entry);
    state.sync = 'saving';
    options.onChange?.(snapshot());
    // Enqueue immediately, preserving old-source -> new-source ordering.
    void recordWatch(anime, video, groupKey(video), position, duration, token, run)
      .then(() => {
        if (attempt !== sequence || (getSession()?.token || null) !== token) return;
        state.sync = dirty ? 'pending' : 'saved';
        options.onChange?.(snapshot());
        publish('saved');
      })
      .catch(() => {
        if (attempt !== sequence) return;
        dirty = true;
        state.sync = 'error';
        options.onChange?.(snapshot());
        publish('saveerror');
      });
  };

  return {
    snapshot,
    setStream(stream: Stream, provider: string, relay = false) {
      state.provider = provider;
      state.quality = stream.quality;
      state.format = stream.type;
      state.relay = relay;
      try {
        state.sourceHost = stream.sourceHost || new URL(stream.url).hostname;
      } catch {
        state.sourceHost = '';
      }
    },
    update(update: MediaUpdate) {
      const position = finite(update.position, state.position),
        duration = finite(update.duration, state.duration) || state.duration;
      const now = performance.now(),
        rate =
          Number.isFinite(update.playbackRate) && update.playbackRate! > 0
            ? update.playbackRate!
            : 1;

      if (
        last?.playing &&
        !last.seeking &&
        !update.seeking &&
        update.reason !== 'seeking' &&
        update.reason !== 'skip' &&
        update.reason !== 'sourcechange'
      ) {
        const elapsed = Math.max(0, (now - last.now) / 1000),
          advanced = position - last.position;

        if (advanced > 0 && advanced <= elapsed * rate + 1) {
          state.watchedSeconds += Math.min(elapsed, advanced / rate);
          if (started && now >= nextActivity) {
            watchActivity(anime, video, token, run, 'progress');
            nextActivity = now + 60000;
          }
          if (state.watchedSeconds - recordedTime >= 15) saveVoice();
        }
      }
      last = { now, position, playing: update.playing, seeking: !!update.seeking };

      const wasStarted = started;
      const wasPlaying = intendedPlaying;

      if (
        ['play', 'playing'].includes(update.reason) ||
        (update.reason === 'timeupdate' && update.playing)
      )
        intendedPlaying = true;
      else if (['pause', 'ended'].includes(update.reason)) intendedPlaying = false;
      if (
        update.playing &&
        (update.reason === 'playing' || (update.reason === 'timeupdate' && position > 0))
      )
        started = true;
      if (started && !wasStarted) watchActivity(anime, video, token, run, 'start');
      if (started && update.completed && !completed) {
        completed = true;
        dirty = true;
        watchActivity(anime, video, token, run, 'complete');
      }
      if (
        started &&
        (position !== state.position ||
          duration !== state.duration ||
          !wasStarted ||
          intendedPlaying !== wasPlaying)
      )
        dirty = true;
      state.position = position;
      state.duration = duration;
      state.playing = update.playing;
      state.playbackRate = rate;
      state.reason = update.reason;
      if (dirty && state.sync !== 'saving') state.sync = 'pending';
      options.onChange?.(snapshot());
      publish(update.reason, update.skip);
      if (
        update.completed ||
        (started && !wasStarted) ||
        ['pause', 'seeked', 'ended', 'dispose', 'error', 'buffering', 'offline'].includes(
          update.reason
        )
      )
        flush();
    },
    flush,
  };
}
