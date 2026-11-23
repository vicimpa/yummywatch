import type { JSX, RefObject } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

import type { PlaybackMedia } from '~/lib/playback-media';
import { formatTime } from '~/lib/player';
import { Input } from '~/ui';

const SAMPLE_SECONDS = 2;
const HOVER_DELAY_MS = 140;
const CACHE_LIMIT = 32;

type PreviewSession = {
  frames: Map<number, string>;
  pending?: Promise<void>;
  disposed: boolean;
};

type Props = {
  media: RefObject<PlaybackMedia>;
  mediaVersion: string;
  position: number;
  duration: number;
  buffered: number;
  visible: boolean;
  onPointerDown: JSX.PointerEventHandler<HTMLInputElement>;
  onInput: JSX.InputEventHandler<HTMLInputElement>;
};

export function VideoTimeline({
  media,
  mediaVersion,
  position,
  duration,
  buffered,
  visible,
  onPointerDown,
  onInput,
}: Props) {
  const [point, setHover] = useState<{ session: PreviewSession; fraction: number }>();
  const [failedSample, setFailedSample] = useState<number>();
  const [, updateFrames] = useState(0);
  const session = useMemo<PreviewSession>(
    () => ({ frames: new Map(), disposed: false }),
    [mediaVersion]
  );
  const hover = point?.session === session ? point.fraction : undefined;
  const time = visible && hover !== undefined && duration > 0 ? hover * duration : undefined;
  const sample =
    time === undefined
      ? undefined
      : Math.floor(Math.min(time, Math.max(0, duration - 0.1)) / SAMPLE_SECONDS) * SAMPLE_SECONDS;

  useEffect(() => {
    return () => {
      session.disposed = true;
      for (const url of session.frames.values()) URL.revokeObjectURL(url);
      session.frames.clear();
    };
  }, [session]);

  useEffect(() => {
    if (!visible) setHover(undefined);
  }, [visible]);

  useEffect(() => {
    setFailedSample(undefined);
    const video = media.current;
    if (sample === undefined || !video?.previewFrame) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      // Pointer movement can replace the target while a previous seek is pending.
      await session.pending;
      if (cancelled || media.current !== video) return;
      const cache = session.frames;
      const cached = cache.get(sample);
      if (cached) {
        cache.delete(sample);
        cache.set(sample, cached);
        return;
      }
      const request = video.previewFrame?.(sample);
      if (!request) return;
      const task = request
        .catch(() => undefined)
        .then(image => {
          if (session.disposed) return;
          if (!image?.size) {
            if (!cancelled) setFailedSample(sample);
            return;
          }
          cache.set(sample, URL.createObjectURL(image));
          if (cache.size > CACHE_LIMIT) {
            const oldest = cache.keys().next().value!;
            URL.revokeObjectURL(cache.get(oldest)!);
            cache.delete(oldest);
          }
          updateFrames(value => value + 1);
        });
      session.pending = task;
      await task;
      if (session.pending === task) session.pending = undefined;
    }, HOVER_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sample, media, session]);

  const move: JSX.PointerEventHandler<HTMLDivElement> = event => {
    if (event.pointerType === 'touch' || !visible || !(duration > 0)) return;
    const { left, width } = event.currentTarget.getBoundingClientRect();
    if (width > 0)
      setHover({
        session,
        fraction: Math.min(1, Math.max(0, (event.clientX - left) / width)),
      });
  };
  const url = sample === undefined ? undefined : session.frames.get(sample);
  const loading =
    sample !== undefined && !url && sample !== failedSample && !!media.current?.previewFrame;

  return (
    <div
      class="video-timeline"
      onPointerMove={move}
      onPointerLeave={() => setHover(undefined)}
      onPointerCancel={() => setHover(undefined)}
    >
      {time !== undefined && hover !== undefined && (
        <div
          aria-hidden="true"
          class="video-timeline-preview"
          style={{ '--pointer': `${hover * 100}%` }}
        >
          {url ? (
            <img src={url} alt="" />
          ) : loading ? (
            <div class="video-timeline-loading">
              <span class="playback-spinner" />
            </div>
          ) : null}
          <span class="video-timeline-time">{formatTime(time)}</span>
        </div>
      )}
      <div class="video-timeline-track">
        <span
          class="video-buffered"
          style={{ width: `${duration ? (buffered / duration) * 100 : 0}%` }}
        />
        <span
          class="video-progress"
          style={{ width: `${duration ? Math.min(100, (position / duration) * 100) : 0}%` }}
        />
      </div>
      <Input
        type="range"
        min="0"
        max={duration || 0}
        step="0.1"
        data-tv-timeline
        value={Math.min(position, duration)}
        disabled={!duration}
        aria-label="Позиция воспроизведения"
        aria-valuetext={`${formatTime(position)} из ${formatTime(duration)}`}
        onPointerDown={onPointerDown}
        onInput={onInput}
      />
    </div>
  );
}
