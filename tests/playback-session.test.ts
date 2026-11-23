// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/preact';
import { createPlaybackSession, PLAYER_EVENT, type PlaybackReport } from '~/lib/playback-session';
import {
  getLibraryState,
  normalizeHistory,
  removeContinue,
  resetAccountLibrary,
  runWatchMaintenance,
  setAnimeList,
} from '~/lib/library';
import { clearSession, saveSession } from '~/lib/session';
import { resumeVideo, videoPosition } from '~/lib/player';
import { readPlaybackRecovery } from '~/lib/playback-recovery';
import { anime, video } from './fixtures';

const reply = (value: unknown) => new Response(JSON.stringify({ response: value }));

const user = (id = 42) =>
  saveSession({
    token: `test-${id}`,
    user: { id, nickname: 'Test' },
    verified: true,
    remember: false,
    refreshedAt: Date.now(),
  });

beforeEach(() => {
  clearSession();
  localStorage.clear();
  sessionStorage.clear();
  resetAccountLibrary();
});
afterEach(() => {
  clearSession();
  resetAccountLibrary();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function watch(id = 4, onReport?: (event: PlaybackReport) => void) {
  return createPlaybackSession({
    anime,
    video: video('1', 'AniLibria', id),
    token: 'test-42',
    position: 180,
    duration: 1400,
    onReport,
  });
}

describe('playback progress in the original account', () => {
  it('writes the exact stream ID and position and can restore them from Yummy history', async () => {
    user();

    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(reply(true)));

    vi.stubGlobal('fetch', fetcher);

    const reports: PlaybackReport[] = [];

    const received = (event: Event) => reports.push((event as CustomEvent<PlaybackReport>).detail);

    window.addEventListener(PLAYER_EVENT, received);
    try {
      const session = watch();

      session.setStream(
        {
          quality: 720,
          type: 'hls',
          url: 'https://relay.example/private/session/key',
          sourceHost: 'video.cdn.example',
        },
        'Alloha',
        true
      );
      session.update({ reason: 'loadedmetadata', position: 180, duration: 1400, playing: false });
      session.flush();
      expect(fetcher).not.toHaveBeenCalled();
      session.update({ reason: 'playing', position: 180, duration: 1400, playing: true });
      session.update({ reason: 'seeked', position: 315, duration: 1400, playing: true });
      session.update({ reason: 'pause', position: 316, duration: 1400, playing: false });
      await waitFor(() => expect(session.snapshot().sync).toBe('saved'));
      expect(getLibraryState().history[0]?.position).toBe(316);
      expect(fetcher.mock.calls.every(([url]) => new URL(url).pathname === '/video/4001')).toBe(
        true
      );

      const [, init] = fetcher.mock.calls.at(-1)!;

      expect(init).toMatchObject({
        method: 'PUT',
        keepalive: true,
        headers: { Authorization: 'Yummy test-42' },
      });
      expect(JSON.parse(init.body)).toMatchObject({
        time: 316,
        duration: 1400,
        date: expect.any(Number),
      });
      expect(reports.find(report => report.reason === 'pause')?.playback).toMatchObject({
        videoId: 4001,
        playerId: 4,
        provider: 'Alloha',
        sourceHost: 'video.cdn.example',
        quality: 720,
        position: 316,
        relay: true,
      });
      expect(JSON.stringify(reports)).not.toContain('/private/session');

      const history = normalizeHistory([
        {
          ...anime,
          video_id: 4001,
          ep_title: '1',
          end_time: 316,
          duration: 1400,
          date: 1800000000,
          data: video('1', 'AniLibria', 4).data,
        },
      ])[0];
      const restored = resumeVideo([video('1'), video('1', 'AniLibria', 4)], history);

      expect(restored.video_id).toBe(4001);
      expect(videoPosition(restored, history)).toEqual({ position: 316, duration: 1400 });
    } finally {
      window.removeEventListener(PLAYER_EVENT, received);
    }
  });
  it('counts watched time separately from seeks and automatic skips', async () => {
    user();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(reply(true)))
    );

    let now = 0;

    vi.spyOn(performance, 'now').mockImplementation(() => now);

    const session = watch();

    session.update({ reason: 'playing', position: 180, duration: 1400, playing: true });
    now = 5000;
    session.update({ reason: 'timeupdate', position: 185, duration: 1400, playing: true });
    now = 6000;
    session.update({
      reason: 'skip',
      position: 275,
      duration: 1400,
      playing: true,
      skip: { kind: 'opening', from: 185, to: 275, automatic: true },
    });
    now = 7000;
    session.update({ reason: 'timeupdate', position: 276, duration: 1400, playing: true });
    expect(session.snapshot().watchedSeconds).toBe(6);
    expect(session.snapshot().position).toBe(276);
    session.flush();
    await waitFor(() => expect(getLibraryState().history[0]?.position).toBe(276));
  });
  it('shows failed saves honestly and retries the latest position', async () => {
    user();

    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(reply(false)));

    vi.stubGlobal('fetch', fetcher);

    const session = watch();

    session.update({ reason: 'playing', position: 180, duration: 1400, playing: true });
    await waitFor(() => expect(session.snapshot().sync).toBe('error'));
    expect(getLibraryState().history[0]?.position).toBe(180);
    fetcher.mockImplementation(() => Promise.resolve(reply(true)));
    session.update({ reason: 'pause', position: 200, duration: 1400, playing: false });
    await waitFor(() => expect(session.snapshot().sync).toBe('saved'));
    expect(getLibraryState().history[0].position).toBe(200);
  });
  it('keeps account recovery on disk even when Yummy is unreachable and isolates other accounts', async () => {
    user();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));

    const session = watch();

    session.update({ reason: 'playing', position: 180, duration: 1400, playing: true });
    session.update({ reason: 'error', position: 456, duration: 1400, playing: false });
    expect(readPlaybackRecovery(anime.anime_id)).toMatchObject({
      position: 456,
      episode: '1',
      videoId: 4001,
    });
    await waitFor(() => expect(session.snapshot().sync).toBe('error'));
    expect(getLibraryState().history[0]?.position).toBe(456);
    expect(JSON.stringify(localStorage)).not.toContain('test-42');
    user(99);
    expect(readPlaybackRecovery(anime.anime_id)).toBeUndefined();
    user();
    expect(readPlaybackRecovery(anime.anime_id)?.position).toBe(456);
  });
  it('remembers playback intent across disposal but respects an explicit pause at the same timestamp', () => {
    clearSession();

    const session = createPlaybackSession({
      anime,
      video: video('1'),
      token: null,
      position: 0,
      duration: 1400,
    });

    session.update({ reason: 'playing', position: 120, duration: 1400, playing: true });
    session.update({ reason: 'dispose', position: 121, duration: 1400, playing: false });
    expect(readPlaybackRecovery(anime.anime_id)?.playing).toBe(true);
    session.update({ reason: 'pause', position: 121, duration: 1400, playing: false });
    expect(readPlaybackRecovery(anime.anime_id)?.playing).toBe(false);
  });
  it('keeps final old-source writes ahead of a new source and rejects stale account writes', async () => {
    user();

    let finish!: (value: Response) => void;
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<Response>(resolve => {
          finish = resolve;
        })
      )
      .mockImplementation(() => Promise.resolve(reply(true)));

    vi.stubGlobal('fetch', fetcher);

    const first = watch(1),
      second = watch(4);

    first.update({ reason: 'playing', position: 180, duration: 1400, playing: true });
    first.update({ reason: 'dispose', position: 210, duration: 1400, playing: false });
    second.update({ reason: 'playing', position: 90, duration: 1400, playing: true });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    finish(reply(true));
    await waitFor(() => expect(second.snapshot().sync).toBe('saved'));
    expect(getLibraryState().history[0]?.videoId).toBe(4001);
    expect(fetcher.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/video/1001',
      '/video/1001',
      '/video/4001',
    ]);
    user(99);
    first.update({ reason: 'pause', position: 211, duration: 1400, playing: false });
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('automatic watch lists', () => {
  const title = {
    ...anime,
    anime_status: { alias: 'released', title: 'Вышел' },
    episodes: { aired: 2, count: 2 },
  };
  const progress = { reason: 'playing' as const, position: 42, duration: 80, playing: true };

  it('ignores an incomplete voice as a finale and hides history after the actual finale', () => {
    const episode = (number: string, run: number) =>
      createPlaybackSession({
        anime: title,
        video: video(number),
        token: null,
        position: 0,
        duration: 80,
        run,
      });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const first = episode('1', now - 10);
    first.update(progress);
    expect(getLibraryState().lists?.[0]?.[0].anime_id).toBe(title.anime_id);
    first.update({ ...progress, completed: true });
    expect(getLibraryState().lists?.[0]?.[0].anime_id).toBe(title.anime_id);
    removeContinue(title.anime_id);
    first.update({ ...progress, position: 70, reason: 'pause', playing: false });
    expect(getLibraryState().history).toEqual([]);
    expect(getLibraryState().lists?.[5]?.[0].anime_id).toBe(title.anime_id);

    vi.mocked(Date.now).mockReturnValue(now + 10);
    const finale = episode('2', now + 10);
    finale.update(progress);
    finale.update({ ...progress, position: 72, reason: 'seeked' });
    expect(getLibraryState().lists?.[0]?.[0].anime_id).toBe(title.anime_id);
    finale.update({ ...progress, position: 73, completed: true });
    finale.update({ ...progress, position: 75, reason: 'pause', playing: false });
    expect(getLibraryState().lists?.[2]?.[0].anime_id).toBe(title.anime_id);
    expect(getLibraryState().history).toEqual([]);
  });

  it('moves an inactive series with a confirmed last viewing to abandoned', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now - 31 * 86400 * 1000);
    await setAnimeList(title, 0);
    const playback = createPlaybackSession({
      anime: title,
      video: video('1'),
      token: null,
      position: 0,
      duration: 80,
    });
    playback.update(progress);
    vi.mocked(Date.now).mockReturnValue(now);
    runWatchMaintenance();
    expect(getLibraryState().lists?.[3]?.[0].anime_id).toBe(title.anime_id);
  });
});
