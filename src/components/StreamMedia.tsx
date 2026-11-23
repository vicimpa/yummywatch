import type { FunctionalComponent as FC, RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type shaka from 'shaka-player';

import { hlsSkips, mergeSkips, metadataSkips, type SkipMarkers } from '../../shared/skips.mjs';
import { useCachedImage } from '~/hooks/useCachedImage';
import { isDesktopMedia } from '~/lib/desktop';
import { interfaceSettings } from '~/lib/interface-settings';
import { bindPlaybackRate, setPlaybackRate } from '~/lib/playback-rate';
import { playbackSettings } from '~/lib/playback-settings';
import { trackWatchFrames } from '~/lib/watch-frames';
import type { Stream, StreamCaption } from '~/lib/streams';

const readyEvents = ['loadeddata', 'canplay', 'seeked', 'playing', 'resize', 'timeupdate'];
export const STREAM_STARTUP_TIMEOUT_MS = 8000;
export const STREAM_LOAD_TIMEOUT_MS = 25000;

export function nativeHls(element: HTMLVideoElement) {
  if (!element.canPlayType('application/vnd.apple.mpegurl')) return false;

  const safari =
    /Safari/i.test(navigator.userAgent) &&
    !/(Chrome|Chromium|CriOS|FxiOS|Edg|OPR)/i.test(navigator.userAgent);

  // Desktop Chromium can advertise "maybe" while its native HLS path cannot recover segment errors.
  return safari || typeof MediaSource === 'undefined';
}

export function selectQuality(player: shaka.Player, quality: number, clearBuffer = false) {
  const tracks = player
    .getVariantTracks()
    .filter(track => track.height)
    .sort((a, b) => a.height! - b.height!);
  const language = tracks.find(track => track.active)?.language;
  const compatible = language ? tracks.filter(track => track.language === language) : tracks;
  const track = compatible.filter(track => track.height! <= quality).at(-1) || compatible[0];

  if (track) {
    player.configure({ abr: { enabled: false } });
    player.selectVariantTrack(track, clearBuffer);
  }

  return track?.height;
}

// Each layer owns its decoder. Preparing another layer never unloads the live one.
export type TStreamMediaProps = {
  stream: Stream;
  caption?: StreamCaption;
  video: RefObject<HTMLVideoElement>;
  active: boolean;
  title: string;
  poster: string;
  frameKey?: string;
  provider?: string;
  start: () => number;
  onReady: () => void;
  onError: (error: Error) => void;
  onSkips: (skips: SkipMarkers) => void;
  onPending?: (pending: boolean) => void;
};

export const StreamMedia: FC<TStreamMediaProps> = ({
  stream,
  caption,
  video,
  active,
  title,
  poster,
  frameKey,
  provider,
  start,
  onReady,
  onError,
  onSkips,
  onPending,
}) => {
  const cachedPoster = useCachedImage(poster);
  const callbacks = useRef({ start, onReady, onError, onSkips, onPending, frameKey, active });

  callbacks.current = { start, onReady, onError, onSkips, onPending, frameKey, active };

  const engine = useRef<shaka.Player>();
  const desiredQuality = useRef(stream.quality);

  desiredQuality.current = stream.quality;

  const closing = useRef<Promise<unknown>>(Promise.resolve());
  const relayed = isDesktopMedia(stream.url);
  const native =
    stream.type === 'mp4' ||
    (provider !== 'Kodik' &&
      !relayed &&
      stream.type === 'hls' &&
      !!video.current &&
      nativeHls(video.current));

  useEffect(() => {
    if (engine.current) selectQuality(engine.current, stream.quality);
  }, [stream.quality]);

  useEffect(() => {
    const element = video.current!;
    const stopRecording = trackWatchFrames(element, () =>
      callbacks.current.active ? callbacks.current.frameKey : undefined
    );

    const settings = playbackSettings();
    element.volume = interfaceSettings().volume;
    element.muted = !callbacks.current.active || settings.muted;
    if (settings.rate !== 1) setPlaybackRate(element, settings.rate);

    let disposed = false,
      notified = false,
      prepared = false,
      targetHeight = 0;

    callbacks.current.onPending?.(false);

    let player: shaka.Player | undefined, releaseRate: (() => void) | undefined;
    let restored = false;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let reportedFailure = false;
    let networkRetries = 0,
      retryPosition = -Infinity;

    const discover = (skips: SkipMarkers) => {
      if (!disposed) callbacks.current.onSkips(skips);
    };

    const ready = () => {
      if (
        !disposed &&
        prepared &&
        element.readyState >= 2 &&
        !element.seeking &&
        (!targetHeight || element.videoHeight >= targetHeight)
      ) {
        callbacks.current.onPending?.(false);
        if (!notified) {
          clearTimeout(startupTimer);
          notified = true;
          callbacks.current.onReady();
        }
      }
    };

    const restore = () => {
      // Metadata can be emitted again after a decoder/rate reconfiguration.
      // Resume is a startup operation, never a reason to rewind a running video.
      // Managed streams already receive the resume position in player.load().
      if (restored || player) return;
      restored = true;

      const time = callbacks.current.start();

      if (time > 0 && Math.abs(element.currentTime - time) > 0.01)
        element.currentTime = Math.min(
          time,
          Number.isFinite(element.duration) && time > element.duration
            ? Math.max(0, element.duration - 0.25)
            : time
        );
    };

    const failed = (event?: Event) => {
      if (reportedFailure) return;
      const detail = (
        event as (Event & { detail?: { severity?: number; category?: number } }) | undefined
      )?.detail;

      if (!prepared && !detail && player) return; // Shaka's load promise owns setup failures.
      // Shaka retries recoverable segment/network errors itself. They are not a failed source.
      if (detail?.severity === 1) return;
      // VOD network failures stop Shaka's streaming engine; explicitly allow a bounded retry.
      if (!disposed && detail?.category === 1 && player && !element.error) {
        if (Math.abs(element.currentTime - retryPosition) > 1) networkRetries = 0;
        if (networkRetries < 2 && player.retryStreaming(1)) {
          networkRetries++;
          retryPosition = element.currentTime;

          return;
        }
      }
      if (!disposed) {
        reportedFailure = true;
        clearTimeout(startupTimer);
        callbacks.current.onPending?.(false);
        callbacks.current.onError(new Error('Не удалось загрузить видеопоток.', { cause: detail }));
      }
    };

    element.addEventListener('loadedmetadata', restore, true);
    for (const event of readyEvents) element.addEventListener(event, ready);
    element.addEventListener('error', failed);
    {
      const startupTimeout = stream.fallback ? STREAM_STARTUP_TIMEOUT_MS : STREAM_LOAD_TIMEOUT_MS;
      const checkStartup = () => {
        if (disposed || notified || reportedFailure) return;
        if (navigator.onLine === false) {
          startupTimer = setTimeout(checkStartup, startupTimeout);

          return;
        }
        reportedFailure = true;
        callbacks.current.onPending?.(false);
        callbacks.current.onError(new Error('Источник не подготовил видео вовремя.'));
      };

      startupTimer = setTimeout(checkStartup, startupTimeout);
    }
    void (async () => {
      try {
        await closing.current;
        if (disposed || reportedFailure) return;

        // WebKit's AVFoundation HLS loader cannot load an application scheme. Shaka
        // requests these bounded segments through WebView's in-process protocol.
        // AVFoundation repeatedly stalls Kodik HLS while seeking a hidden
        // replacement. Use the same bounded, timestamp-aware engine as Windows.
        const useNative =
          stream.type === 'mp4' ||
          (provider !== 'Kodik' && !relayed && stream.type === 'hls' && nativeHls(element));

        if (useNative) {
          prepared = true;
          // Reset the actual attribute when reusing an HLS element: an empty
          // crossorigin attribute still enables anonymous CORS for native MP4.
          if (stream.type === 'mp4') element.removeAttribute('crossorigin');
          element.src = stream.url;
          element.load();
          releaseRate = bindPlaybackRate(element);
          if (element.readyState >= 1) restore();
        } else {
          callbacks.current.onPending?.(true);

          const { default: shaka } = await import('shaka-player');

          if (disposed || reportedFailure) return;
          shaka.polyfill.installAll();
          if (relayed)
            shaka.net.NetworkingEngine.registerScheme(
              'yumiwatch-media',
              shaka.net.HttpFetchPlugin.parse
            );
          if (!shaka.Player.isBrowserSupported())
            throw new Error('Этот браузер не поддерживает поток.');
          player = new shaka.Player();
          await player.attach(element);
          if (disposed || reportedFailure) {
            await player.destroy();

            return;
          }
          engine.current = player;
          player.configure({
            abr: {
              defaultBandwidthEstimate: 350000,
              restrictions: { maxHeight: desiredQuality.current },
            },
            streaming: {
              bufferingGoal: 15,
              rebufferingGoal: 2,
              bufferBehind: 15,
              // Fetch the preceding segment when rounded HLS times put a seek
              // just before the real segment start (WebKit defaults to zero).
              ...(provider === 'Alloha' || provider === 'Kodik'
                ? { inaccurateManifestTolerance: 2 }
                : {}),
              ...(relayed ? { preferNativeHls: false, fallbackToNativeHlsOnMseError: false } : {}),
              retryParameters: { maxAttempts: 3, baseDelay: 1000, timeout: 20000 },
            },
            manifest: {
              // Episodes are VOD even when a provider omits ENDLIST. Keep the
              // whole presentation seekable instead of moving its start forward
              // as Shaka refreshes what would otherwise look like a live playlist.
              availabilityWindowOverride: Infinity,
              // Kodik and Alloha round EXTINF durations despite continuous TS timestamps.
              // Re-aligning every segment to the playlist introduces artificial gaps and skips whole seconds.
              hls:
                provider === 'Kodik' || provider === 'Alloha'
                  ? { sequenceMode: false, ignoreManifestTimestampsInSegmentsMode: true }
                  : {},
              retryParameters: { maxAttempts: 3, timeout: 20000 },
            },
          });
          player.getNetworkingEngine()?.registerResponseFilter((type, response) => {
            if (
              !disposed &&
              type === shaka.net.NetworkingEngine.RequestType.MANIFEST &&
              response.data.byteLength <= 512000
            ) {
              const text = new TextDecoder().decode(response.data);

              if (text.startsWith('#EXTM3U')) discover(hlsSkips(text));
            }
          });

          const region = (event: Event) => {
            const data = event as Event & { detail?: unknown; region?: unknown };

            discover(
              mergeSkips(
                metadataSkips(data.detail),
                metadataSkips(data.region),
                metadataSkips(data)
              )
            );
          };

          player.addEventListener('timelineregionadded', region);
          player.addEventListener('metadataadded', region);
          player.addEventListener('metadata', region);
          player.addEventListener('error', failed);
          await player.load(
            stream.url,
            callbacks.current.start(),
            stream.type === 'hls' ? 'application/vnd.apple.mpegurl' : 'application/dash+xml'
          );
          if (disposed || reportedFailure) {
            await player.destroy();
            if (engine.current === player) engine.current = undefined;

            return;
          }
          releaseRate = bindPlaybackRate(element, player);
          // Only the standby decoder loses its startup buffer. The live layer
          // continues until the requested variant actually decodes a frame.
          targetHeight = selectQuality(player, desiredQuality.current, true) || 0;
          prepared = true;
          callbacks.current.onPending?.(false);
          for (const track of player.getChaptersTracks()) {
            try {
              for (const chapter of await player.getChaptersAsync(track.language))
                discover(metadataSkips(chapter));
            } catch {
              /* Optional chapters. */
            }
          }
          if (caption && !disposed) {
            const track = await player.addTextTrackAsync(
              caption.url,
              caption.language,
              'subtitles',
              'text/vtt',
              undefined,
              caption.label
            );

            player.selectTextTrack(track);
          }
          ready();
        }
      } catch (error) {
        if (!disposed && !reportedFailure) {
          reportedFailure = true;
          clearTimeout(startupTimer);
          callbacks.current.onPending?.(false);
          callbacks.current.onError(error as Error);
        }
      }
    })();

    return () => {
      disposed = true;
      clearTimeout(startupTimer);
      releaseRate?.();
      element.removeEventListener('loadedmetadata', restore, true);
      for (const event of readyEvents) element.removeEventListener(event, ready);
      element.removeEventListener('error', failed);
      stopRecording();
      element.pause();
      engine.current = undefined;
      if (player) closing.current = player.destroy();
      else {
        element.removeAttribute('src');
        element.load();
      }
    };
  }, [stream.url, caption?.url, provider]);

  // CVH's MP4 CDN rejects Origin instead of implementing CORS. Native media
  // needs no CORS mode; setting it here makes an otherwise playable URL fail.
  return (
    <video
      ref={video}
      class={`stream-layer ${active ? 'is-active' : 'is-standby'}`}
      data-active={active}
      aria-hidden={!active}
      crossOrigin={stream.type === 'mp4' ? undefined : 'anonymous'}
      playsInline
      preload="auto"
      poster={cachedPoster || undefined}
      aria-label={active ? title : undefined}
    >
      {caption && native && (
        <track
          key={caption.url}
          kind="subtitles"
          src={caption.url}
          srcLang={caption.language}
          label={caption.label}
          default
        />
      )}
    </video>
  );
};
