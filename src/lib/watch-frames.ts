import { getCache } from './cache-store';
import { cachedImage, canCacheImages, storeWatchFrame } from './image-cache';
import type { PlaybackMedia } from './playback-media';

const FRAME_INTERVAL = 10000;
let lastRequest = 0;

export function watchFrameKey(animeId: number, episode: string | undefined, accountId?: number) {
  const number = episode?.trim();

  return number ? `watch-frame:${accountId ?? 'guest'}:${animeId}:${number}` : undefined;
}

export const cachedWatchFrame = (key?: string) =>
  key && canCacheImages() ? cachedImage(key, 'frame') : undefined;

export function encodeWatchFrame(
  source: CanvasImageSource,
  width: number,
  height: number
): Promise<Blob | undefined> {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 640 / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  return new Promise(resolve => {
    try {
      const context = canvas.getContext('2d');
      if (!context) return resolve(undefined);
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => resolve(blob || undefined), 'image/jpeg', 0.76);
    } catch {
      // The source may allow playback without granting pixel access.
      resolve(undefined);
    }
  });
}

function videoFrame(video: PlaybackMedia): Promise<Blob | undefined> {
  if (!(video instanceof HTMLVideoElement) || !video.videoWidth || !video.videoHeight)
    return Promise.resolve(undefined);
  return encodeWatchFrame(video, video.videoWidth, video.videoHeight);
}

export function trackWatchFrames(video: PlaybackMedia, activeKey: () => string | undefined) {
  let watched = false;
  let pending = false;
  let nextSample = 0;
  let sampledPosition = -Infinity;

  const save = (force: boolean, close = false) => {
    const key = activeKey();

    if (
      !watched ||
      !key ||
      !canCacheImages() ||
      video.readyState < 2 ||
      video.seeking ||
      video.error
    )
      return false;
    if (Math.abs(video.currentTime - sampledPosition) < 0.1) return false;
    if (!close && (pending || (!force && Date.now() < nextSample))) return false;

    sampledPosition = video.currentTime;
    nextSample = Date.now() + FRAME_INTERVAL;
    const requested = (lastRequest = Math.max(Date.now(), lastRequest + 1));
    const capture = video.captureFrame?.(close) ?? videoFrame(video);

    pending = true;
    void capture
      .then(frame => {
        if (
          frame?.size &&
          frame.size <= 256 * 1024 &&
          (getCache('frame', key)?.savedAt || 0) < requested
        )
          storeWatchFrame(key, frame, requested);
      })
      .catch(() => {})
      .finally(() => {
        pending = false;
      });

    return close && !!video.captureFrame;
  };

  const progress = () => {
    if (!activeKey() || video.paused || video.seeking) return;
    watched = true;
    save(false);
  };
  const checkpoint = () => save(true);
  const progressEvents = ['playing', 'timeupdate'];
  const checkpointEvents = ['pause', 'seeked', 'ended'];

  for (const event of progressEvents) video.addEventListener(event, progress);
  for (const event of checkpointEvents) video.addEventListener(event, checkpoint);
  window.addEventListener('pagehide', checkpoint);

  return () => {
    for (const event of progressEvents) video.removeEventListener(event, progress);
    for (const event of checkpointEvents) video.removeEventListener(event, checkpoint);
    window.removeEventListener('pagehide', checkpoint);

    return save(true, true);
  };
}
