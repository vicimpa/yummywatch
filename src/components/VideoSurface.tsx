import {
  createRef,
  type ComponentChildren,
  type FunctionalComponent as FC,
  type RefObject,
} from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import { activeSkip, mergeSkips, metadataSkips, type SkipMarkers } from '../../shared/skips.mjs';
import { usePlaybackWakeLock } from '~/hooks/usePlaybackWakeLock';
import {
  NativePlayback,
  setPictureInPictureUnavailable,
  usesAndroidNativePlayback,
  usesDesktopNativeSurface,
  usesMacNativePlayback,
  type PictureInPictureControls,
} from '~/lib/native-playback';
import type { PlaybackMedia } from '~/lib/playback-media';
import { mediaAtEnd } from '~/lib/media-state';
import { selectedPlaybackRate, setPlaybackRate } from '~/lib/playback-rate';
import type { MediaUpdate, PlaybackReason } from '~/lib/playback-session';
import { resetPlayerChrome, setPlayerChrome } from '~/lib/player-chrome';
import { warmQualitySwitch } from '~/lib/quality-switch';
import type { Stream, StreamCaption } from '~/lib/streams';
import type { TvEpisodeControl } from '~/lib/tv-mode';

import { AutoActionCountdown } from './AutoActionCountdown';
import { NativeStreamMedia } from './NativeStreamMedia';
import { PlaybackLoader, PlaybackPreview } from './PlaybackLoader';
import { PictureInPictureButton } from './PictureInPictureButton';
import { StreamMedia } from './StreamMedia';
import { VideoControls } from './VideoControls';
import { Button } from '~/ui';

export const STREAM_STALL_TIMEOUT_MS = 20000;
export const STREAM_ERROR_DELAY_MS = 1500;
// Alloha's relay expires after three idle minutes. Refresh before that boundary.
export const STREAM_RESUME_REFRESH_MS = 120000;

export type TVideoSurfaceProps = {
  stream: Stream;
  previewStream?: Stream;
  caption?: StreamCaption;
  identity: number;
  start: number;
  autoplay: boolean;
  background?: boolean;
  pip?: PictureInPictureControls;
  media: RefObject<PlaybackMedia>;
  onUpdate: (event: MediaUpdate, stream: Stream) => void;
  onEnded?: () => void;
  autoNext?: boolean;
  retry: () => void;
  title: string;
  poster: string;
  loadingImage?: string;
  frameKey?: string;
  provider?: string;
  skips: SkipMarkers;
  autoOpening: boolean;
  autoEnding: boolean;
  settings?: ComponentChildren;
  previous?: () => void;
  next?: () => void;
  tvEpisodeFocus?: RefObject<TvEpisodeControl>;
  quality?: ComponentChildren;
  sourcePicker?: ComponentChildren;
  streamInfo?: ComponentChildren;
  syncStatus?: ComponentChildren;
  onBack?: () => void;
  backLabel?: string;
  onVoice?: () => void;
  onRecoveryVoice?: () => void;
  voiceLabel?: string;
  onEpisodes?: () => void;
  onComments?: () => void;
  fullscreenFrame?: RefObject<HTMLDivElement>;
  onQualityError?: (stream: Stream) => void;
  onStreamError?: (playing: boolean) => boolean | void;
  onResume?: () => boolean;
};

export const VideoSurface: FC<TVideoSurfaceProps> = ({
  stream,
  previewStream,
  caption,
  identity,
  start,
  autoplay,
  background = false,
  pip,
  media,
  onUpdate,
  onEnded,
  autoNext = false,
  onStreamError,
  onResume,
  retry,
  title,
  poster,
  loadingImage,
  frameKey,
  provider,
  skips,
  autoOpening,
  autoEnding,
  settings,
  quality,
  sourcePicker,
  streamInfo,
  syncStatus,
  previous,
  next,
  tvEpisodeFocus,
  fullscreenFrame,
  onQualityError,
  onEpisodes,
  onComments,
  onBack,
  backLabel,
  onVoice,
  onRecoveryVoice,
  voiceLabel,
}) => {
  const frame = useRef<HTMLDivElement>(null);
  const [controlsVisible, setControlsVisible] = useState(true);

  useEffect(() => {
    if (!background && frame.current?.closest('.media-app.is-playback'))
      setPlayerChrome(controlsVisible);
  }, [controlsVisible, background]);

  useEffect(
    () => () => {
      if (!background && document.documentElement.dataset.playerChrome) resetPlayerChrome();
    },
    [background]
  );

  const [reload, setReload] = useState(0);
  const macNative = import.meta.env.VITE_NATIVE_VIDEO_ONLY === 'true' || usesMacNativePlayback();
  const native = macNative || usesDesktopNativeSurface() || usesAndroidNativePlayback();
  useLayoutEffect(() => {
    if (!native || background) return;
    const root = document.documentElement;
    root.dataset.nativeVideo = 'true';

    return () => {
      delete root.dataset.nativeVideo;
    };
  }, [native, background]);

  const webVideos = useMemo(
    () => [createRef<HTMLVideoElement>(), createRef<HTMLVideoElement>()],
    []
  );
  const nativeVideos = useMemo(
    () => [createRef<NativePlayback>(), createRef<NativePlayback>()],
    []
  );
  const videos = native ? nativeVideos : webVideos;
  const [layers, setLayers] = useState<[Stream | undefined, Stream | undefined]>([
    stream,
    undefined,
  ]);
  const [active, setActive] = useState(0),
    [switching, setSwitching] = useState(false);
  const mediaVersion = JSON.stringify([native, active, reload, layers[active]?.url, caption?.url]);
  const activeSlot = useRef(0),
    actualStream = useRef(stream);
  const cancelSwitch = useRef<() => void>();
  const readySlots = useRef(new Set<number>());
  const pendingSlots = useRef(new Set<number>());
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const [position, setPosition] = useState(start),
    [discovered, setDiscovered] = useState<SkipMarkers>({});
  const [notice, setNotice] = useState('');
  const [completed, setCompleted] = useState(false),
    [playing, setPlaying] = useState(false),
    [seeking, setSeeking] = useState(false),
    [cancelledNext, setCancelledNext] = useState(false);
  const [keepAwake, setKeepAwake] = useState(false);
  usePlaybackWakeLock(keepAwake && (!background || !!pip?.active || !!pip?.pending));

  useEffect(() => {
    if (!autoNext) setCancelledNext(false);
  }, [autoNext]);

  const completion = useRef(false);
  const [, refreshAction] = useState(0);
  const saved = useRef({ time: start, playing: autoplay });
  const skipped = useRef(new Set<string>());
  const callbacks = useRef({ onUpdate, onEnded, onStreamError, onResume });

  callbacks.current = { onUpdate, onEnded, onStreamError, onResume };

  const rules = useRef({ skips, autoOpening, autoEnding });

  const markers = useMemo(() => mergeSkips(skips, discovered), [skips, discovered]);

  rules.current = { skips: markers, autoOpening, autoEnding };

  useLayoutEffect(() => {
    const video = videos[active].current;
    media.current = video;
    return () => {
      if (media.current === video) media.current = null;
    };
  }, [media, mediaVersion]);

  useEffect(() => {
    cancelSwitch.current?.();
    cancelSwitch.current = undefined;

    const slot = activeSlot.current;

    if (stream.quality === actualStream.current.quality) {
      if (stream.url !== actualStream.current.url) {
        readySlots.current.delete(slot);
        setLoading(true);
        setError('');
      }
      actualStream.current = stream;
      setSwitching(false);
      setLayers(slot === 0 ? [stream, undefined] : [undefined, stream]);
      media.current?.dispatchEvent(new Event('yumiwatch:quality'));
    } else {
      setSwitching(true);
      setLayers(slot === 0 ? [actualStream.current, stream] : [stream, actualStream.current]);
    }
  }, [stream.url, stream.quality]);

  useEffect(() => () => cancelSwitch.current?.(), []);

  const layerFailed = useCallback(
    (slot: number, failure: Error) => {
      if (slot === activeSlot.current) {
        videos[slot].current?.dispatchEvent(
          new CustomEvent('yumiwatch:stream-error', {
            detail: { message: failure.message, cause: failure.cause },
          })
        );

        return;
      }
      cancelSwitch.current?.();
      cancelSwitch.current = undefined;
      setSwitching(false);
      setLayers(
        activeSlot.current === 0
          ? [actualStream.current, undefined]
          : [undefined, actualStream.current]
      );
      setNotice('Не удалось сменить качество. Продолжаем в текущем.');
      onQualityError?.(actualStream.current);
    },
    [videos, onQualityError]
  );

  const layerReady = useCallback(
    (slot: number) => {
      readySlots.current.add(slot);
      if (slot === activeSlot.current) {
        const video = videos[slot].current;
        setLoading(false);
        if (saved.current.playing) void video?.play().catch(() => {});

        return;
      }
      if (cancelSwitch.current) return;

      const live = videos[activeSlot.current].current!,
        next = videos[slot].current!,
        target = layers[slot]!;

      let cancelled = false;
      let stop = () => {};
      cancelSwitch.current = () => {
        cancelled = true;
        stop();
      };
      const commit = () => {
        if (cancelled) return;
        const muted = live.muted,
          playing = !live.paused;

        live.muted = true;
        next.muted = muted;
        next.volume = live.volume;
        setPlaybackRate(next, selectedPlaybackRate(live));
        saved.current = { time: next.currentTime, playing };
        activeSlot.current = slot;
        actualStream.current = target;
        media.current = next;
        cancelSwitch.current = undefined;
        setActive(slot);
        setSwitching(false);
        setLayers(slot === 0 ? [target, undefined] : [undefined, target]);
      };
      stop = warmQualitySwitch(live, next, commit, () =>
        layerFailed(slot, new Error('Не удалось подготовить выбранное качество.'))
      );
    },
    [videos, layers, media, layerFailed]
  );

  useEffect(() => {
    if (pip?.active) void setPictureInPictureUnavailable(!!error).catch(() => {});
  }, [pip?.active, !!error]);

  useEffect(() => {
    if (!switching) return;

    // Bound the whole preparation, including sources that never emit onReady.
    const slot = 1 - activeSlot.current;
    const timer = setTimeout(
      () => layerFailed(slot, new Error('Истекло время подготовки качества.')),
      STREAM_STALL_TIMEOUT_MS
    );

    return () => clearTimeout(timer);
  }, [switching, stream.url, stream.quality]);

  useEffect(() => {
    if (!notice) return;

    const timer = setTimeout(() => setNotice(''), 3000);

    return () => clearTimeout(timer);
  }, [notice]);

  useLayoutEffect(() => {
    saved.current = { time: start, playing: autoplay };
    skipped.current.clear();
    completion.current = false;
    setCompleted(false);
    setCancelledNext(false);
    setDiscovered({});
    setNotice('');
  }, [identity]);

  useEffect(() => {
    if (!autoplay) return;
    saved.current.playing = true;
    if (media.current && media.current.readyState >= 2)
      void media.current.play().catch(() => {
        saved.current.playing = false;
      });
  }, [autoplay, identity]);

  useEffect(() => {
    const video = media.current;
    if (!video) return;
    let disposed = false,
      ready = video.readyState >= 2 && readySlots.current.has(active),
      broken = false;
    let lastMediaTime = video.currentTime;
    let lastAdvancingAt = 0;
    let naturalPosition: number | undefined;
    let creditsReached = false;
    let pausedAt = video.paused ? Date.now() : undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let errorTimer: ReturnType<typeof setTimeout> | undefined;

    const clearStall = () => {
      clearTimeout(stallTimer);
      stallTimer = undefined;
    };

    const recovered = () => {
      if (disposed || video.error || activeSlot.current !== active) return;
      broken = false;
      ready = true;
      readySlots.current.add(active);
      clearStall();
      clearTimeout(errorTimer);
      setError('');
      setLoading(false);
    };

    const armStall = () => {
      if (stallTimer !== undefined || broken || completion.current) return;

      const stalledAt = video.currentTime;

      stallTimer = setTimeout(() => {
        stallTimer = undefined;
        // An offline device says nothing about the availability of a provider.
        if (!actualStream.current.offline && navigator.onLine === false) {
          armStall();

          return;
        }
        // The decoder owns its request retries; a slow manifest is not yet
        // an exhausted source. Its terminal error ends this pending state.
        if (pendingSlots.current.has(active)) {
          armStall();

          return;
        }
        if (mediaAtEnd(video)) finish();
        else if (
          !video.error &&
          video.readyState >= 2 &&
          (video.paused || (!video.seeking && video.currentTime > stalledAt + 0.05))
        ) {
          recovered();
          emit('playing');
        } else failed();
      }, STREAM_STALL_TIMEOUT_MS);
    };

    const onMediaUpdate = callbacks.current.onUpdate;

    setError('');
    setLoading(!ready);

    const emit = (reason: PlaybackReason, skip?: MediaUpdate['skip'], completed = false) => {
      if (disposed || activeSlot.current !== active) return;

      const time =
        ready && !video.error && reason !== 'error' && Number.isFinite(video.currentTime)
          ? video.currentTime
          : saved.current.time;

      if (ready && !video.error && reason !== 'error') saved.current.time = time;
      setPosition(time);

      const ongoingPlayback =
        !video.paused &&
        !completion.current &&
        !mediaAtEnd(video) &&
        ready &&
        !['dispose', 'error', 'offline', 'ended'].includes(reason);

      const isPlaying = ongoingPlayback && reason !== 'buffering';
      setKeepAwake(ongoingPlayback);
      setPlaying(isPlaying);
      setSeeking(video.seeking);
      onMediaUpdate(
        {
          reason,
          position: time,
          duration: Number.isFinite(video.duration) ? video.duration : 0,
          playing: isPlaying,
          seeking: video.seeking,
          playbackRate: video.playbackRate,
          ...(skip ? { skip } : {}),
          ...(completed && { completed }),
        },
        actualStream.current
      );
    };

    const finish = (natural = false) => {
      if (disposed || activeSlot.current !== active || completion.current) return;
      completion.current = true;
      broken = false;
      saved.current.playing = false;
      clearStall();
      clearTimeout(errorTimer);
      setLoading(false);
      setCompleted(true);
      setError('');
      video.pause();
      emit('ended', undefined, natural && !rules.current.skips?.ending);
      video.dispatchEvent(new Event('yumiwatch:complete'));
      callbacks.current.onEnded?.();
    };

    const checkEnd = (natural = false) => {
      if (mediaAtEnd(video)) {
        finish(natural);

        return true;
      }
      if (completion.current) {
        completion.current = false;
        setCompleted(false);
        setCancelledNext(false);
      }

      return false;
    };

    const discover = (value: SkipMarkers) => {
      if (!disposed && Object.keys(value).length)
        setDiscovered(previous => {
          const next = mergeSkips(previous, value);

          return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
        });
    };

    const inspectTracks = () => {
      for (const track of Array.from(video.textTracks || [])) {
        if (track.kind !== 'chapters' && track.kind !== 'metadata') continue;
        for (const raw of Array.from(track.cues || [])) {
          const cue = raw as TextTrackCue & { text?: string; value?: unknown };
          let metadata: unknown = cue.value;

          if (cue.text && cue.text.length < 10000) {
            try {
              metadata = JSON.parse(cue.text);
            } catch {
              metadata = { title: cue.text };
            }
          }
          if (metadata && typeof metadata === 'object')
            discover(
              metadataSkips({ ...metadata, startTime: cue.startTime, endTime: cue.endTime })
            );
        }
      }
    };

    const tracked = new Set<TextTrack>();

    const tracksChanged = () => {
      for (const track of Array.from(video.textTracks || []))
        if (!tracked.has(track) && ['chapters', 'metadata'].includes(track.kind)) {
          tracked.add(track);
          track.addEventListener('cuechange', inspectTracks);
        }
      inspectTracks();
    };

    const seekSkip = (automatic: boolean) => {
      const marker = activeSkip(rules.current.skips, video.currentTime, video.duration);

      if (!marker) return;
      if (
        automatic &&
        (video.paused ||
          video.seeking ||
          completion.current ||
          !(marker.kind === 'opening' ? rules.current.autoOpening : rules.current.autoEnding))
      )
        return;

      const key = `${marker.kind}:${marker.time}:${marker.length}`;

      if (automatic && skipped.current.has(key)) return;
      skipped.current.add(key);

      const from = video.currentTime,
        to = marker.time + marker.length;

      try {
        video.currentTime = to;
        saved.current.time = to;
      } catch {
        return;
      }
      setNotice(marker.kind === 'opening' ? 'Опенинг пропущен' : 'Титры пропущены');
      emit(
        'skip',
        { kind: marker.kind, from, to, automatic },
        marker.kind === 'ending' && creditsReached
      );
      if (marker.kind === 'ending' && mediaAtEnd(video)) finish();
    };

    const update = (event: Event) => {
      if (disposed || media.current !== video || activeSlot.current !== active) return;
      if (event.type === 'pause') {
        pausedAt ??= Date.now();
        if (!video.error) saved.current.playing = false;
        setKeepAwake(false);
      }
      if (event.type === 'play') {
        saved.current.playing = true;
        const longPause =
          pausedAt !== undefined && Date.now() - pausedAt >= STREAM_RESUME_REFRESH_MS;
        pausedAt = undefined;
        if (longPause && callbacks.current.onResume) {
          emit('play');
          if (callbacks.current.onResume()) {
            setLoading(true);
            return;
          }
        }
      }
      // A progressing decoder is authoritative even if a prior network error
      // was terminal at the time. Never leave a stale alert over live frames.
      if (
        event.type === 'timeupdate' &&
        !video.paused &&
        !video.seeking &&
        !video.error &&
        video.readyState >= 2 &&
        video.currentTime > lastMediaTime + 0.01
      )
        recovered();
      let crossedCredits = false;
      let advancing = false;
      if (event.type === 'seeking' || event.type === 'seeked' || video.seeking) {
        naturalPosition = undefined;
        lastAdvancingAt = 0;
      } else if (event.type === 'timeupdate' && !video.paused && ready && !video.error) {
        const time = video.currentTime;
        const elapsed = (performance.now() - lastAdvancingAt) / 1000;
        const marker = rules.current.skips?.ending;
        advancing =
          naturalPosition !== undefined &&
          time > naturalPosition &&
          time - naturalPosition <= Math.max(1, elapsed * video.playbackRate + 0.5);
        crossedCredits = !!(
          advancing &&
          marker &&
          marker.time > 0 &&
          naturalPosition! < marker.time &&
          time >= marker.time
        );
        naturalPosition = time;
        lastAdvancingAt = performance.now();
      }
      if (crossedCredits) creditsReached = true;
      lastMediaTime = video.currentTime;
      if (!ready) return;
      if (crossedCredits) emit('timeupdate', undefined, true);
      if (checkEnd(advancing)) return;
      if (video.readyState >= 3 || event.type === 'pause') clearStall();
      if (!video.error && video.readyState >= 2) saved.current.playing = !video.paused;
      emit(event.type as PlaybackReason);
    };

    const restore = () => {
      if (disposed || activeSlot.current !== active) return;
      ready = true;
      // StreamMedia owns startup seeks. Metadata updates only refresh the UI;
      // another seek here can fight the streaming engine or rewind playback.
      if (video.readyState >= 2) setLoading(false);
      if (video.readyState >= 2) clearStall();
      emit('loadedmetadata');
      tracksChanged();
      if (checkEnd()) return;
      if (saved.current.playing) void video.play().catch(() => {});
    };

    const failed = () => {
      if (disposed || broken || activeSlot.current !== active) return;
      if (completion.current || mediaAtEnd(video)) {
        finish();

        return;
      }
      broken = true;
      clearStall();
      emit('error');
      ready = false;

      const recovering = callbacks.current.onStreamError?.(saved.current.playing) === true;

      setLoading(true);
      if (!recovering)
        errorTimer = setTimeout(() => {
          if (disposed || !broken || activeSlot.current !== active) return;
          setLoading(false);
          setError(
            'Поток прервался или не загрузился. Повтори загрузку — продолжим с сохранённого места.'
          );
        }, STREAM_ERROR_DELAY_MS);
    };

    const decoderFailed = (event: Event) => {
      if (disposed || activeSlot.current !== active) return;
      if (event.type === 'error' && pendingSlots.current.has(active)) return;
      // Shaka can fail a request while buffered video still plays. Give it the
      // ordinary stall deadline before replacing a source or covering it.
      if (!video.error && video.readyState >= 2) {
        armStall();

        return;
      }
      failed();
    };

    const ended = () => {
      if (!disposed && activeSlot.current === active)
        finish(
          !video.seeking &&
            naturalPosition !== undefined &&
            Math.abs(video.currentTime - naturalPosition) <= 2
        );
    };

    const buffering = () => {
      if (ready && checkEnd()) return;
      if (ready) emit('buffering');
      if (!video.paused && video.readyState < 3) armStall();
    };

    const visibleFrame = () => {
      if (!disposed && !video.error && video.readyState >= 2 && activeSlot.current === active) {
        if (!ready && !broken) restore();
        recovered();
      }
    };

    const lost = () => {
      if (completion.current || mediaAtEnd(video)) return;
      if (video.readyState < 2) {
        ready = false;
        setLoading(true);
        armStall();
      }
    };

    const offline = () => {
      if (ready && !actualStream.current.offline) emit('offline');
    };

    const leaving = () => emit('dispose');

    const manualSkip = () => seekSkip(false);

    const automaticSkip = () => seekSkip(true);

    const qualityChanged = () => emit('sourcechange');

    video.addEventListener('loadedmetadata', restore);
    video.addEventListener('error', decoderFailed);
    video.addEventListener('yumiwatch:stream-error', decoderFailed);
    video.addEventListener('ended', ended);
    video.addEventListener('waiting', buffering);
    video.addEventListener('stalled', buffering);
    video.addEventListener('abort', lost);
    video.addEventListener('emptied', lost);
    window.addEventListener('offline', offline);
    video.addEventListener('loadeddata', visibleFrame);
    video.addEventListener('canplay', visibleFrame);
    video.addEventListener('playing', visibleFrame);
    window.addEventListener('pagehide', leaving);

    const events = [
      'timeupdate',
      'play',
      'playing',
      'pause',
      'seeking',
      'seeked',
      'ratechange',
    ] as const;

    for (const event of events) video.addEventListener(event, update);
    video.addEventListener('yumiwatch:skip', manualSkip);
    video.addEventListener('yumiwatch:auto-skip', automaticSkip);
    video.addEventListener('yumiwatch:quality', qualityChanged);
    video.textTracks?.addEventListener?.('addtrack', tracksChanged);
    emit('sourcechange');
    if (video.readyState >= 1 && (video.currentSrc || video.getAttribute?.('src'))) restore();
    if (!ready) armStall();

    return () => {
      clearStall();
      clearTimeout(errorTimer);
      if (activeSlot.current === active) {
        saved.current = {
          time: ready && !video.error ? video.currentTime : saved.current.time,
          playing:
            !completion.current && (ready && !video.error ? !video.paused : saved.current.playing),
        };
        emit('dispose');
      }
      disposed = true;
      video.removeEventListener('loadedmetadata', restore);
      video.removeEventListener('error', decoderFailed);
      video.removeEventListener('yumiwatch:stream-error', decoderFailed);
      video.removeEventListener('ended', ended);
      video.removeEventListener('waiting', buffering);
      video.removeEventListener('stalled', buffering);
      video.removeEventListener('abort', lost);
      video.removeEventListener('emptied', lost);
      window.removeEventListener('offline', offline);
      video.removeEventListener('loadeddata', visibleFrame);
      video.removeEventListener('canplay', visibleFrame);
      video.removeEventListener('playing', visibleFrame);
      window.removeEventListener('pagehide', leaving);
      for (const event of events) video.removeEventListener(event, update);
      video.removeEventListener('yumiwatch:skip', manualSkip);
      video.removeEventListener('yumiwatch:auto-skip', automaticSkip);
      video.removeEventListener('yumiwatch:quality', qualityChanged);
      video.textTracks?.removeEventListener?.('addtrack', tracksChanged);
      for (const track of tracked) track.removeEventListener('cuechange', inspectTracks);
    };
  }, [media, mediaVersion, identity]);

  const marker = activeSkip(rules.current.skips, position, media.current?.duration);
  const skipKey = marker ? `${marker.kind}:${marker.time}:${marker.length}` : '';
  const autoSkip =
    !!marker &&
    !completed &&
    !loading &&
    !error &&
    playing &&
    !seeking &&
    (marker.kind === 'opening' ? autoOpening : autoEnding) &&
    !skipped.current.has(skipKey);
  const nextAction = completed && autoNext && !!next && !cancelledNext;

  const cancelNext = useCallback(() => setCancelledNext(true), []);

  const advanceNow = useCallback(() => {
    setCancelledNext(true);
    next?.();
  }, [next]);

  const advanceAutomatically = useCallback(() => {
    if (completion.current && autoNext && media.current && mediaAtEnd(media.current)) {
      setCancelledNext(true);
      next?.();
    }
  }, [autoNext, media, next]);

  const cancelSkip = useCallback(() => {
    skipped.current.add(skipKey);
    refreshAction(value => value + 1);
    setNotice('Автопропуск отменён');
  }, [skipKey]);

  const skipNow = useCallback(
    () => media.current?.dispatchEvent(new Event('yumiwatch:skip')),
    [media]
  );

  const skipAutomatically = useCallback(
    () => media.current?.dispatchEvent(new Event('yumiwatch:auto-skip')),
    [media]
  );

  const reloadStream = useCallback(() => {
    readySlots.current.clear();
    setReload(value => value + 1);
    retry();
  }, [retry]);
  const skipLabel =
    marker && !loading && !error
      ? marker.kind === 'opening'
        ? 'Пропустить опенинг'
        : 'Пропустить титры'
      : undefined;

  return (
    <div
      ref={frame}
      class={`player-frame universal-frame ${native ? 'native-video-frame' : ''} ${controlsVisible ? '' : 'controls-idle'}`}
    >
      {layers.map((layer, slot) => {
        if (!layer) return null;

        const props = {
          stream: layer,
          caption,
          active: slot === active,
          provider,
          title,
          poster: loadingImage ? '' : poster,
          frameKey,
          start: () =>
            slot === activeSlot.current
              ? saved.current.time
              : media.current?.currentTime || saved.current.time,
          onPending: (pending: boolean) => {
            if (pending) pendingSlots.current.add(slot);
            else pendingSlots.current.delete(slot);
          },
          onReady: () => layerReady(slot),
          onError: (failure: Error) => layerFailed(slot, failure),
          onSkips: (value: SkipMarkers) => setDiscovered(previous => mergeSkips(previous, value)),
        };
        const key = `${slot}:${reload}`;

        return native ? (
          <NativeStreamMedia
            key={key}
            {...props}
            video={nativeVideos[slot]}
            previewStream={previewStream}
          />
        ) : (
          <StreamMedia key={key} {...props} video={webVideos[slot]} />
        );
      })}
      {(loading || error) && loadingImage && <PlaybackPreview src={loadingImage} />}
      {!background && (
        <VideoControls
          native={macNative}
          localMedia={stream.offline}
          onBack={onBack}
          backLabel={backLabel}
          onVoice={onVoice}
          voiceLabel={voiceLabel}
          onEpisodes={onEpisodes}
          onComments={onComments}
          mediaVersion={mediaVersion}
          media={media}
          frame={fullscreenFrame || frame}
          title={title}
          position={position}
          loading={loading}
          failed={!!error}
          pip={pip}
          settings={
            <>
              {sourcePicker}
              {settings}
            </>
          }
          quality={quality}
          streamInfo={streamInfo}
          syncStatus={syncStatus}
          previous={previous}
          next={next}
          tvEpisodeFocus={tvEpisodeFocus}
          manualSkip={
            skipLabel && !nextAction && !autoSkip ? { label: skipLabel, run: skipNow } : undefined
          }
          onVisibility={setControlsVisible}
        />
      )}
      {!background && !!error && pip && <PictureInPictureButton pip={pip} floating />}
      {switching && (
        <span class="video-quality-switch" role="status">
          Готовим {stream.quality}p…
        </span>
      )}
      {(loading || error) && (
        <PlaybackLoader
          failed={!!error}
          label={error ? 'Не удалось загрузить видео' : 'Загружаем видео…'}
          detail={error || (saved.current.time > 0 ? 'Продолжим с сохранённого места' : undefined)}
        >
          {error && (
            <>
              {sourcePicker}
              <Button onClick={reloadStream} variant="primary" data-nav-primary>
                Повторить загрузку
              </Button>
              {onRecoveryVoice && <Button onClick={onRecoveryVoice}>Сменить озвучку</Button>}
              {onBack && (
                <Button onClick={onBack} variant="text">
                  {backLabel || 'Вернуться к аниме'}
                </Button>
              )}
            </>
          )}
        </PlaybackLoader>
      )}
      {nextAction ? (
        <AutoActionCountdown
          key={`next:${identity}`}
          background={background}
          label="Следующая серия"
          onCancel={cancelNext}
          onNow={advanceNow}
          onComplete={advanceAutomatically}
        />
      ) : autoSkip ? (
        <AutoActionCountdown
          key={`${identity}:${skipKey}`}
          background={background}
          label={marker!.kind === 'opening' ? 'Пропуск опенинга' : 'Пропуск титров'}
          onCancel={cancelSkip}
          onNow={skipNow}
          onComplete={skipAutomatically}
        />
      ) : null}
      {notice && !marker && (
        <span class="native-skip-notice" role="status">
          {notice}
        </span>
      )}
    </div>
  );
};
