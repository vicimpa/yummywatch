import type { RefObject } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import { hlsSkips } from '../../shared/skips.mjs';
import { useCachedImage } from '~/hooks/useCachedImage';
import { isDesktopMedia } from '~/lib/desktop';
import { interfaceSettings } from '~/lib/interface-settings';
import { NativePlayback, usesCanvasPlayback } from '~/lib/native-playback';
import { setPlaybackRate } from '~/lib/playback-rate';
import { PLAYBACK_EVENT, playbackSettings } from '~/lib/playback-settings';
import type { Stream } from '~/lib/streams';
import { trackWatchFrames } from '~/lib/watch-frames';

import {
  STREAM_LOAD_TIMEOUT_MS,
  STREAM_STARTUP_TIMEOUT_MS,
  type TStreamMediaProps,
} from './StreamMedia';

type Props = Omit<TStreamMediaProps, 'video'> & {
  video: RefObject<NativePlayback>;
  previewStream?: Stream;
};

export function NativeStreamMedia(props: Props) {
  const { stream, previewStream, caption, active, title, poster, video } = props;
  const image = useCachedImage(poster);
  const element = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const playback = useMemo(() => new NativePlayback(stream.url), [stream.url, caption?.url]);
  const [readyId, setReadyId] = useState<number>();
  useLayoutEffect(() => playback.setActive(active), [active, playback]);
  // As with a DOM ref, the parent needs the playback object during its layout effect.
  video.current = playback;

  useEffect(() => {
    const anchor = element.current!;
    const stopRecording = trackWatchFrames(playback, () =>
      callbacks.current.active ? callbacks.current.frameKey : undefined
    );
    const controller = new AbortController();
    let ready = false;
    let failed = false;
    const settings = playbackSettings();
    playback.volume = interfaceSettings().volume;
    playback.muted = !active || settings.muted;
    if (settings.rate !== 1) setPlaybackRate(playback, settings.rate);
    playback.setUpscale(settings);
    const updateUpscale = () => playback.setUpscale(playbackSettings());
    window.addEventListener(PLAYBACK_EVENT, updateUpscale);

    const fail = (message: string) => {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      playback.close();
      callbacks.current.onPending?.(false);
      callbacks.current.onError(new Error(message));
    };

    const startupTimeout = stream.fallback ? STREAM_STARTUP_TIMEOUT_MS : STREAM_LOAD_TIMEOUT_MS;
    const checkStartup = () => {
      if (!stream.offline && navigator.onLine === false)
        timer = setTimeout(checkStartup, startupTimeout);
      else fail('Источник не подготовил видео вовремя.');
    };
    let timer = setTimeout(checkStartup, startupTimeout);

    const loaded = () => {
      if (failed || ready) return;
      ready = true;
      setReadyId(playback.id);
      clearTimeout(timer);
      callbacks.current.onPending?.(false);
      callbacks.current.onReady();
    };
    const error = () => fail(playback.error?.message || 'Не удалось загрузить видеопоток.');

    playback.addEventListener('loadeddata', loaded);
    playback.addEventListener('error', error);
    callbacks.current.onPending?.(true);
    void playback.open(
      anchor,
      stream,
      caption,
      callbacks.current.start(),
      previewStream,
      canvas.current || undefined
    );

    if (stream.type === 'hls' && isDesktopMedia(stream.url)) {
      void fetch(stream.url, { signal: controller.signal })
        .then(response => (response.ok ? response.text() : ''))
        .then(text => {
          if (!controller.signal.aborted && text.startsWith('#EXTM3U'))
            callbacks.current.onSkips(hlsSkips(text));
        })
        .catch(() => {});
    }

    return () => {
      clearTimeout(timer);
      controller.abort();
      window.removeEventListener(PLAYBACK_EVENT, updateUpscale);
      playback.removeEventListener('loadeddata', loaded);
      playback.removeEventListener('error', error);
      if (!stopRecording()) playback.close();
    };
  }, [playback]);

  return (
    <div
      ref={element}
      class={`stream-layer native-stream-layer ${active ? 'is-active' : 'is-standby'}${readyId === playback.id ? ' native-stream-ready' : ''}`}
      data-active={active}
      aria-hidden={!active}
      aria-label={active ? title : undefined}
      style={image ? { backgroundImage: `url("${image}")` } : undefined}
    >
      {usesCanvasPlayback() && <canvas ref={canvas} width={640} height={360} />}
    </div>
  );
}
