import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { PresencePlayback } from '~/core/DiscordPresence';
import { recordWatch, watchActivity } from '~/lib/library';
import { savePlaybackRecovery } from '~/lib/playback-recovery';
import { trackVoice, type VoiceChoice } from '~/lib/voice-ranking';
import { getSession } from '~/lib/session';
import { notify } from '~/lib/notifications';
import { PLAYBACK_FLUSH } from '~/lib/playback-settings';
import {
  groupKey,
  playbackEvent,
  playbackMessage,
  playerCommand,
  playerUrl,
  videoPosition,
} from '~/lib/player';
import type { Anime, Video, WatchEntry } from '~/lib/types';

type TSourcePlaybackOptions = {
  anime: Anime;
  video?: Video;
  history?: WatchEntry;
  token: string | null;
  scope: string;
  startPlaying?: boolean;
  run: number;
  voiceChoice: VoiceChoice;
  transfer?: { position: number; duration: number };
  autoNext: boolean;
  next?: Video;
  onEnded: (video: Video) => void;
  onCheckpoint?: (entry: WatchEntry) => void;
};

const noop = () => {};

export function useSourcePlayback({
  anime,
  video: current,
  history,
  token,
  scope,
  startPlaying,
  run,
  voiceChoice,
  transfer,
  ...callbacks
}: TSourcePlaybackOptions) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const flushProgress = useRef(noop);
  const playOnLoad = useRef(startPlaying === true);
  const options = useRef(callbacks);

  options.current = callbacks;

  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [progress, setProgress] = useState<Record<number, { position: number; duration: number }>>(
    {}
  );
  const [presence, setPresence] = useState<PresencePlayback & { videoId: number }>();

  const initial = useMemo(() => {
    if (transfer) return transfer;
    const saved = current ? videoPosition(current, history) : { position: 0, duration: 0 };

    return saved.duration > 0 && saved.duration - saved.position <= 20
      ? { ...saved, position: 0 }
      : saved;
  }, [current?.video_id, scope]);

  const send = useCallback(
    (command: 'play' | 'pause' | 'seek', seconds = 0) => {
      if (!current) return;

      const value = playerCommand(current, command, seconds);

      if (value !== null)
        iframe.current?.contentWindow?.postMessage(
          value,
          new URL(playerUrl(current.iframe_url)).origin
        );
    },
    [current]
  );

  useLayoutEffect(() => {
    if (!current) return;

    const onCheckpoint = options.current.onCheckpoint;
    const origin = new URL(playerUrl(current.iframe_url)).origin;
    const observesPlayback = playerCommand(current, 'play') !== null;
    let time = initial.position;
    let length = initial.duration;
    let dirty = false;
    let started = false;
    let active = false;
    let restored = false;
    let failed = false;
    let completed = false;
    let watched = 0;
    let nextActivity = 0;
    let voted = false;

    setPosition(time);
    setDuration(length);

    let playing = false;
    let lastProgress = Date.now();

    setPresence(undefined);

    const flush = () => {
      if ((getSession()?.token || null) !== token) return;
      if (watched > 0) {
        trackVoice(current.data.dubbing, watched, voiceChoice, !voted);
        voted = true;
        watched = 0;
      }
      if (!dirty) return;
      dirty = false;
      const entry = {
        anime,
        episode: current.number,
        videoId: current.video_id,
        group: groupKey(current),
        updatedAt: Date.now(),
        position: time,
        duration: length,
        completed,
      };
      savePlaybackRecovery(entry, token, run);
      onCheckpoint?.(entry);
      void recordWatch(anime, current, groupKey(current), time, length, token, run)
        .then(() => {
          failed = false;
        })
        .catch(error => {
          dirty = true;
          if (!failed) {
            notify(error.message);
            failed = true;
          }
        });
    };

    flushProgress.current = flush;

    const message = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow || event.origin !== origin) return;

      const playback = playbackEvent(event.data);

      if (playback === 'play') {
        playing = true;
        if (!started) {
          started = true;
          dirty = true;
          flush();
        }
      }
      if (playback === 'pause' || playback === 'ended') playing = false;

      const value = playbackMessage(event.data);

      if (value?.duration !== undefined) {
        length = value.duration;
        setDuration(length);
        if (length > 0 && !restored && initial.position > (transfer ? 0 : 5)) {
          restored = true;
          send('seek', Math.max(0, Math.min(length - 1, initial.position - (transfer ? 0 : 5))));
        }
      }
      if (value?.time !== undefined) {
        const now = Date.now();
        const delta = value.time - time;
        const elapsed = (now - lastProgress) / 1000;
        const advanced = delta > 0 && delta <= Math.max(1, elapsed * 2 + 0.5);
        if (!observesPlayback && advanced) playing = true;
        if (playing && advanced) {
          if (!active) {
            active = true;
            watchActivity(anime, current, token, run, 'start');
          }
          watched += Math.min(elapsed, delta);
          if (now >= nextActivity) {
            watchActivity(anime, current, token, run, 'progress');
            nextActivity = now + 60000;
          }
          const ending = current.skips?.ending?.time;
          if (!completed && ending && time < ending && value.time >= ending) {
            completed = true;
            watchActivity(anime, current, token, run, 'complete');
          }
        }
        lastProgress = now;
        time = value.time;
        setPosition(Math.floor(time));
        if (started) dirty = true;
        else if (!observesPlayback && time > 0) {
          started = true;
          dirty = true;
          flush();
        }
        setProgress(previous => ({
          ...previous,
          [current.video_id]: { position: time, duration: length },
        }));
        if (!length && typeof event.data === 'string')
          iframe.current?.contentWindow?.postMessage('{"api":"duration"}', origin);
      }
      if (playback || value)
        setPresence({
          videoId: current.video_id,
          position: time,
          duration: length,
          playing,
          reason: playback || 'timeupdate',
        });
      if (playback === 'pause') flush();
      if (playback === 'ended') {
        if (active && !completed && !current.skips?.ending && length > 0 && length - time <= 3) {
          completed = true;
          watchActivity(anime, current, token, run, 'complete');
        }
        if (length) time = length;
        dirty = true;
        flush();
        if (options.current.autoNext && options.current.next) {
          playOnLoad.current = true;
          options.current.onEnded(options.current.next);
        }
      }
    };

    const hidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };

    const timer = setInterval(() => {
      flush();
      if (!observesPlayback && playing && Date.now() - lastProgress > 15000) {
        playing = false;
        setPresence({
          videoId: current.video_id,
          position: time,
          duration: length,
          playing,
          reason: 'pause',
        });
      }
    }, 10000);

    window.addEventListener('message', message);
    window.addEventListener(PLAYBACK_FLUSH, flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);

    return () => {
      clearInterval(timer);
      flush();
      if (flushProgress.current === flush) flushProgress.current = () => {};
      window.removeEventListener('message', message);
      window.removeEventListener(PLAYBACK_FLUSH, flush);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [current?.video_id, scope]);

  const flush = useCallback(() => flushProgress.current(), []);
  const requestPlay = useCallback((playing = true) => {
    playOnLoad.current = playing;
  }, []);
  const loaded = useCallback(() => {
    if (!playOnLoad.current) return;
    playOnLoad.current = false;
    send('play');
  }, [send]);

  return {
    iframe,
    initial,
    position,
    duration,
    progress,
    presence,
    send,
    flush,
    requestPlay,
    loaded,
  };
}
