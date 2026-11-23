// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { WatchPreview } from '~/components/WatchPreview';
import { EpisodeOptions } from '~/components/PlayerOptions';
import { getCache, putCache } from '~/lib/cache-store';
import { storeWatchFrame } from '~/lib/image-cache';
import type { PlaybackMedia } from '~/lib/playback-media';
import type { Video } from '~/lib/types';
import { clearSession, saveSession } from '~/lib/session';
import { trackWatchFrames, watchFrameKey } from '~/lib/watch-frames';
import { anime } from './fixtures';

beforeEach(() => {
  vi.stubGlobal('indexedDB', {});
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:saved-watch-frame');
      static revokeObjectURL = vi.fn();
    }
  );
});

afterEach(() => {
  cleanup();
  clearSession();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('captures the last watched frame even when an earlier request is still pending', async () => {
  const first = new Blob(['earlier frame'], { type: 'image/jpeg' });
  const last = new Blob(['frame at exit'], { type: 'image/jpeg' });
  let reply!: (image: Blob) => void;
  const capture = vi
    .fn<(close: boolean) => Promise<Blob>>()
    .mockReturnValueOnce(
      new Promise<Blob>(resolve => {
        reply = resolve;
      })
    )
    .mockResolvedValueOnce(last);
  const video = Object.assign(new EventTarget(), {
    captureFrame: capture,
    readyState: 4,
    paused: true,
    seeking: false,
    currentTime: 1,
  });
  const key = watchFrameKey(anime.anime_id, '1', 42)!;
  const stop = trackWatchFrames(video as unknown as PlaybackMedia, () => key);

  video.dispatchEvent(new Event('timeupdate'));
  expect(capture).not.toHaveBeenCalled();
  video.paused = false;
  video.dispatchEvent(new Event('playing'));
  expect(capture).toHaveBeenNthCalledWith(1, false);
  video.currentTime = 5;
  expect(stop()).toBe(true);
  expect(capture).toHaveBeenNthCalledWith(2, true);
  await Promise.resolve();
  reply(first);
  await Promise.resolve();

  expect(getCache('frame', key)?.data).toBe(last);
  expect(getCache('frame', watchFrameKey(anime.anime_id, '1')!)).toBeUndefined();
  expect(getCache('frame', watchFrameKey(anime.anime_id, '2', 42)!)).toBeUndefined();
});

it('uses the account frame in history and falls back to the episode screenshot for guests', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  const account = {
    token: 'account',
    user: { id: 42, nickname: 'Viewer' },
    remember: false,
    verified: true,
    refreshedAt: Date.now(),
  };
  saveSession(account);
  const entry = {
    anime,
    episode: '1',
    videoId: 1,
    group: '',
    updatedAt: Date.now(),
    preview: 'https://static.yani.tv/screenshot.jpg',
  };
  storeWatchFrame(
    watchFrameKey(anime.anime_id, '1', account.user.id)!,
    new Blob(['frame'], { type: 'image/jpeg' }),
    Date.now()
  );
  const { container } = render(<WatchPreview entry={entry} />);
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:saved-watch-frame');

  await act(async () => {
    clearSession();
  });
  await waitFor(() =>
    expect(container.querySelector('img')?.getAttribute('src')).toBe(entry.preview)
  );
});

it('shows watched and cached provider frames in the offline episode list without fetching missing images', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const watched = new Blob(['watch frame'], { type: 'image/jpeg' });
  const screenshot = new Blob(['episode screenshot'], { type: 'image/jpeg' });
  vi.mocked(URL.createObjectURL).mockImplementation(blob =>
    blob === watched ? 'blob:watched-offline' : 'blob:cached-screenshot'
  );
  const title = {
    ...anime,
    anime_id: 505,
    poster: { medium: 'https://static.yani.tv/offline-poster.jpg' },
    random_screenshots: ['1', '2', '3'].map(episode => {
      const url = `https://static.yani.tv/offline-preview-${episode}.jpg`;
      return { episode, sizes: { small: url, full: url } };
    }),
  };
  storeWatchFrame(watchFrameKey(title.anime_id, '1')!, watched, Date.now());
  putCache('image', title.random_screenshots[1].sizes.small, screenshot);
  const videos: Video[] = ['1', '2', '3'].map((number, index) => ({
    number,
    index,
    video_id: 500 + index,
    iframe_url: '',
    data: { dubbing: 'Озвучка', player: 'CVH', player_id: 0 },
  }));
  render(
    <EpisodeOptions
      anime={title}
      videos={videos}
      episode="1"
      query=""
      cacheOnly
      onSelect={vi.fn()}
    />
  );
  expect(
    screen.getByRole('button', { name: 'Серия 1' }).querySelector('img')?.getAttribute('src')
  ).toBe('blob:watched-offline');
  expect(
    screen.getByRole('button', { name: 'Серия 2' }).querySelector('img')?.getAttribute('src')
  ).toBe('blob:cached-screenshot');
  expect(screen.getByRole('button', { name: 'Серия 3' }).querySelector('img')).toBeNull();
  await act(async () => {});
  expect(fetch).not.toHaveBeenCalled();
});
