// @vitest-environment jsdom
import { chooseOption } from './dropdown-actions';
import { useDiscordPresence } from '~/hooks/useDiscordPresence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { AUTO_ACTION_DELAY_MS } from '~/components/AutoActionCountdown';
import { Player } from '~/components/Player';
import { STREAM_RESUME_REFRESH_MS } from '~/components/VideoSurface';
import { resolveStream } from '~/lib/streams';
import { probeAudioPlayback } from '~/lib/autoplay';
import { readPlaybackRecovery } from '~/lib/playback-recovery';
import { savePlaybackSettings } from '~/lib/playback-settings';
import { clearSession, saveSession } from '~/lib/session';
import { getLibraryState, resetAccountLibrary } from '~/lib/library';
import { readLibrary } from '~/lib/storage';
import { anime, video } from './fixtures';
import { putCache } from '~/lib/cache-store';

vi.mock('~/hooks/useDiscordPresence', () => ({ useDiscordPresence: vi.fn() }));

vi.mock('~/lib/autoplay', () => ({ probeAudioPlayback: vi.fn().mockResolvedValue(false) }));
vi.mock('shaka-player', () => ({
  default: {
    polyfill: { installAll: () => {} },
    Player: class {
      static isBrowserSupported() {
        return false;
      }
    },
  },
}));

function mediaError(media: HTMLMediaElement) {
  Object.defineProperty(media, 'error', { value: { code: 2 }, configurable: true });
  fireEvent.error(media);
}

vi.mock('~/lib/streams', async original => ({
  ...(await original<typeof import('~/lib/streams')>()),
  resolveStream: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(probeAudioPlayback).mockReset().mockResolvedValue(false);
  clearSession();
  localStorage.clear();
  sessionStorage.clear();
  resetAccountLibrary();
  savePlaybackSettings({ mode: 'universal' });
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ response: [video('1'), video('2'), video('1', 'AniDub')] }))
        )
      )
  );
  vi.mocked(resolveStream).mockResolvedValue({
    provider: 'Test',
    videoId: video('1').video_id,
    duration: 1400,
    streams: [
      { quality: 360, type: 'mp4', url: 'https://cdn.example/360.mp4' },
      { quality: 720, type: 'mp4', url: 'https://cdn.example/720.mp4' },
    ],
  });
});
afterEach(() => {
  cleanup();
  clearSession();
  resetAccountLibrary();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('our player mode', () => {
  it('keeps the live position and pause state when changing voices', async () => {
    const a = video('1', 'AniLibria', 101);
    const b = video('1', 'AniDub', 102);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => new Response(JSON.stringify({ response: [a, b] })))
    );
    vi.mocked(resolveStream).mockImplementation(async ([selected]) => ({
      provider: 'Test',
      videoId: selected.video_id,
      duration: 1200,
      streams: [{ quality: 720, type: 'mp4', url: `https://cdn.example/${selected.video_id}.mp4` }],
    }));
    const { container } = render(<Player anime={anime} />);
    const first = await waitFor(() => {
      const media = container.querySelector<HTMLVideoElement>(`video[src*="${a.video_id}.mp4"]`);
      expect(media).toBeTruthy();
      return media!;
    });
    fireEvent.loadedMetadata(first);
    first.currentTime = 503;
    fireEvent.timeUpdate(first);
    vi.mocked(HTMLMediaElement.prototype.play).mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Озвучка.*AniLibria/ }));
    fireEvent.click(await screen.findByRole('button', { name: /AniDub/ }));
    const next = await waitFor(() => {
      const media = container.querySelector<HTMLVideoElement>(`video[src*="${b.video_id}.mp4"]`);
      expect(media).toBeTruthy();
      return media!;
    });
    fireEvent.loadedMetadata(next);
    expect(next.currentTime).toBe(503);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it('changes voices from a failed stream and resumes playback at the saved position', async () => {
    const original = video('1', 'Reanimedia', 101);
    const alternate = video('1', 'Первый канал', 102);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(
          async () => new Response(JSON.stringify({ response: [original, alternate] }))
        )
    );
    vi.mocked(resolveStream).mockImplementation(async ([video]) => ({
      provider: 'Test',
      videoId: video.video_id,
      duration: 7149,
      streams: [{ quality: 480, type: 'mp4', url: `https://cdn.example/${video.video_id}.mp4` }],
    }));
    const { container } = render(<Player anime={anime} presentation="immersive" startPlaying />);
    const playingVideo = (id: number) =>
      container.querySelector<HTMLVideoElement>(`video[src$="${id}.mp4"]`);
    const first = await waitFor(() => {
      expect(playingVideo(original.video_id)).toBeTruthy();
      return playingVideo(original.video_id)!;
    });
    Object.defineProperty(first, 'duration', { value: 7149 });
    Object.defineProperty(first, 'paused', { value: false });
    fireEvent.loadedMetadata(first);
    first.currentTime = 131;
    fireEvent.timeUpdate(first);
    mediaError(first);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Сменить озвучку' }, { timeout: 3000 })
    );
    fireEvent.click(await screen.findByRole('button', { name: /Первый канал/ }));
    const next = await waitFor(() => {
      expect(playingVideo(alternate.video_id)).toBeTruthy();
      return playingVideo(alternate.video_id)!;
    });
    vi.mocked(HTMLMediaElement.prototype.play).mockClear();
    fireEvent.loadedMetadata(next);
    expect(next.currentTime).toBe(131);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it('renews a single Alloha source after a long pause and restores position, sound and speed', async () => {
    const source = video('1');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ response: [source] })))
    );
    vi.mocked(resolveStream)
      .mockReset()
      .mockImplementation(async () => ({
        provider: 'Alloha',
        videoId: source.video_id,
        duration: 1400,
        streams: [
          {
            quality: 360,
            type: 'mp4',
            url: `https://cdn.example/session-${vi.mocked(resolveStream).mock.calls.length}.mp4`,
          },
        ],
      }));
    const { container } = render(<Player anime={anime} />);
    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain('session-1')
    );
    const first = container.querySelector('video')!;
    Object.defineProperty(first, 'duration', { value: 1400, configurable: true });
    Object.defineProperty(first, 'paused', { value: false, configurable: true });
    fireEvent.loadedMetadata(first);
    fireEvent.playing(first);
    first.currentTime = 321;
    first.muted = true;
    first.volume = 0.25;
    first.playbackRate = 1.5;
    fireEvent.timeUpdate(first);
    Object.defineProperty(first, 'paused', { value: true, configurable: true });
    fireEvent.pause(first);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + STREAM_RESUME_REFRESH_MS + 61000);
    vi.mocked(HTMLMediaElement.prototype.play).mockClear();
    Object.defineProperty(first, 'paused', { value: false, configurable: true });
    fireEvent.play(first);
    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain('session-2')
    );
    const replacement = container.querySelector('video')!;
    expect(replacement).not.toBe(first);
    Object.defineProperty(replacement, 'duration', { value: 1400, configurable: true });
    fireEvent.loadedMetadata(replacement);
    expect(replacement.currentTime).toBe(321);
    expect(replacement.muted).toBe(true);
    expect(replacement.volume).toBe(0.25);
    expect(replacement.playbackRate).toBe(1.5);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    expect(resolveStream).toHaveBeenCalledTimes(2);
    expect(vi.mocked(resolveStream).mock.calls[1][2]).toEqual({
      preferredVideoId: source.video_id,
    });
    expect(vi.mocked(resolveStream).mock.calls[1][0].map(video => video.video_id)).toEqual([
      source.video_id,
    ]);
  });

  it('restores Alloha sound and speed when an offline error is retried after reconnecting', async () => {
    const source = video('1');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ response: [source] })))
    );
    vi.mocked(resolveStream)
      .mockReset()
      .mockImplementation(async () => ({
        provider: 'Alloha',
        videoId: source.video_id,
        duration: 1400,
        streams: [
          {
            quality: 360,
            type: 'mp4',
            url: `https://cdn.example/offline-${vi.mocked(resolveStream).mock.calls.length}.mp4`,
          },
        ],
      }));
    const { container } = render(<Player anime={anime} />);
    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain('offline-1')
    );
    const first = container.querySelector('video')!;
    Object.defineProperty(first, 'duration', { value: 1400, configurable: true });
    Object.defineProperty(first, 'paused', { value: false, configurable: true });
    fireEvent.loadedMetadata(first);
    fireEvent.playing(first);
    first.currentTime = 321;
    first.muted = true;
    first.volume = 0.25;
    first.playbackRate = 1.5;
    fireEvent.timeUpdate(first);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + STREAM_RESUME_REFRESH_MS + 61000);
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    mediaError(first);
    await screen.findByRole('button', { name: 'Повторить загрузку' }, { timeout: 3000 });
    expect(resolveStream).toHaveBeenCalledTimes(1);
    online.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку' }));
    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain('offline-2')
    );
    const replacement = container.querySelector('video')!;
    expect(replacement).not.toBe(first);
    Object.defineProperty(replacement, 'duration', { value: 1400, configurable: true });
    fireEvent.loadedMetadata(replacement);
    expect(replacement.currentTime).toBe(321);
    expect(replacement.muted).toBe(true);
    expect(replacement.volume).toBe(0.25);
    expect(replacement.playbackRate).toBe(1.5);
  });

  it('shows a retry action if renewing an expired Alloha session fails instead of keeping its old video mounted', async () => {
    const source = video('1');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ response: [source] })))
    );
    vi.mocked(resolveStream)
      .mockReset()
      .mockResolvedValueOnce({
        provider: 'Alloha',
        videoId: source.video_id,
        duration: 1400,
        streams: [{ quality: 360, type: 'mp4', url: 'https://cdn.example/expired-session.mp4' }],
      })
      .mockRejectedValue(new Error('Не удалось обновить сессию Alloha'));
    const { container } = render(<Player anime={anime} />);
    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain('expired-session')
    );
    const first = container.querySelector('video')!;
    Object.defineProperty(first, 'duration', { value: 1400, configurable: true });
    Object.defineProperty(first, 'paused', { value: false, configurable: true });
    fireEvent.loadedMetadata(first);
    fireEvent.playing(first);
    first.currentTime = 123;
    fireEvent.timeUpdate(first);
    Object.defineProperty(first, 'paused', { value: true, configurable: true });
    fireEvent.pause(first);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + STREAM_RESUME_REFRESH_MS + 61000);
    // Expired-session errors can also arrive before the user's next play event.
    mediaError(first);
    await screen.findByRole('button', { name: 'Повторить' }, { timeout: 3000 });
    expect(resolveStream).toHaveBeenCalledTimes(2);
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByText('Не удалось обновить сессию Alloha')).toBeTruthy();
  });
  it('tries a reserve after a renewed Alloha stream fails instead of renewing indefinitely', async () => {
    const source = video('1'),
      reserve = video('1', 'AniLibria', 4);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ response: [source, reserve] })))
    );
    vi.mocked(resolveStream)
      .mockReset()
      .mockImplementation(async candidates => {
        const attempt = vi.mocked(resolveStream).mock.calls.length;
        return {
          provider: attempt < 3 ? 'Alloha' : 'Reserve',
          videoId: attempt < 3 ? source.video_id : candidates[0].video_id,
          duration: 1400,
          streams: [
            { quality: 360, type: 'mp4', url: `https://cdn.example/attempt-${attempt}.mp4` },
          ],
        };
      });
    const { container } = render(<Player anime={anime} />);
    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain('attempt-1')
    );
    const first = container.querySelector('video')!;
    Object.defineProperty(first, 'duration', { value: 1400, configurable: true });
    Object.defineProperty(first, 'paused', { value: false, configurable: true });
    fireEvent.loadedMetadata(first);
    fireEvent.playing(first);
    first.currentTime = 321;
    fireEvent.timeUpdate(first);
    Object.defineProperty(first, 'paused', { value: true, configurable: true });
    fireEvent.pause(first);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + STREAM_RESUME_REFRESH_MS + 61000);
    Object.defineProperty(first, 'paused', { value: false, configurable: true });
    fireEvent.play(first);
    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain('attempt-2')
    );
    mediaError(container.querySelector('video')!);
    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain('attempt-3')
    );
    expect(
      vi
        .mocked(resolveStream)
        .mock.calls.map(([candidates]) => candidates.map(video => video.video_id))
    ).toEqual([
      [source.video_id, reserve.video_id],
      [source.video_id, reserve.video_id],
      [reserve.video_id],
    ]);
    expect(container.querySelector('video')!.currentTime).toBe(321);
    expect(container.querySelector('iframe')).toBeNull();
  });
  it('tries Kodik MP4 when it is the only fallback and keeps the saved position', async () => {
    const source = video('1');
    vi.mocked(resolveStream).mockClear();
    vi.mocked(resolveStream).mockResolvedValue({
      provider: 'Kodik',
      videoId: source.video_id,
      duration: 5971,
      streams: [
        {
          quality: 720,
          type: 'hls',
          url: 'https://cdn.example/video.m3u8',
          fallback: { type: 'mp4', url: 'https://cdn.example/video.mp4' },
        },
      ],
    });
    const ready = vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(0);
    const { container } = render(
      <Player
        anime={anime}
        history={{
          anime,
          videoId: source.video_id,
          episode: '1',
          group: '',
          position: 2110,
          duration: 5971,
          updatedAt: Date.now(),
        }}
      />
    );

    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toBe(
        'https://cdn.example/video.mp4'
      )
    );
    const media = container.querySelector('video')!;
    Object.defineProperty(media, 'duration', { value: 5971, configurable: true });
    ready.mockReturnValue(4);
    fireEvent.loadedMetadata(media);
    fireEvent.loadedData(media);
    expect(media.currentTime).toBe(2110);
    expect(media.getAttribute('crossorigin')).toBeNull();
    expect(resolveStream).toHaveBeenCalledOnce();
    expect(container.querySelector('.playback-loader.is-error')).toBeNull();

    // A failed MP4 must still leave the player recoverable rather than hang
    // behind the old HLS failure flag or repeat the format switch forever.
    mediaError(media);
    await screen.findByRole('button', { name: 'Повторить загрузку' }, { timeout: 3000 });
    expect(resolveStream).toHaveBeenCalledOnce();
  });
  it('tries another provider before the Kodik MP4 fallback and retains the fallback after an error', async () => {
    const kodik = video('1');
    const reserve = video('1', 'AniLibria', 4);
    type Resolution = Awaited<ReturnType<typeof resolveStream>>;
    let resolveReserve!: (result: Resolution) => void;
    const pending = new Promise<Resolution>(resolve => {
      resolveReserve = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ response: [kodik, reserve] })))
    );
    vi.mocked(resolveStream)
      .mockReset()
      .mockResolvedValueOnce({
        provider: 'Kodik',
        videoId: kodik.video_id,
        duration: 1400,
        streams: [
          {
            quality: 360,
            type: 'hls',
            url: 'https://cdn.example/kodik.m3u8',
            fallback: { type: 'mp4', url: 'https://cdn.example/kodik.mp4' },
          },
        ],
      })
      .mockReturnValueOnce(pending);
    const { container } = render(<Player anime={anime} />);
    await waitFor(() =>
      expect(container.querySelector('.video-stream-meta')?.textContent).toContain('Kodik')
    );
    mediaError(container.querySelector('video')!);
    await waitFor(() =>
      expect(useDiscordPresence).toHaveBeenLastCalledWith(
        anime,
        expect.objectContaining({ number: '1' }),
        expect.objectContaining({ playing: false, reason: 'sourcechange' })
      )
    );
    resolveReserve({
      provider: 'CVH',
      videoId: reserve.video_id,
      duration: 1400,
      streams: [{ quality: 360, type: 'mp4', url: 'https://cdn.example/cvh.mp4' }],
    });
    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toBe(
        'https://cdn.example/cvh.mp4'
      )
    );
    const cvh = container.querySelector('video')!;
    Object.defineProperty(cvh, 'duration', { value: 1400, configurable: true });
    fireEvent.loadedMetadata(cvh);
    cvh.currentTime = 321;
    fireEvent.timeUpdate(cvh);
    mediaError(cvh);
    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toBe(
        'https://cdn.example/kodik.mp4'
      )
    );
    const mp4 = container.querySelector('video')!;
    Object.defineProperty(mp4, 'duration', { value: 1400, configurable: true });
    fireEvent.loadedMetadata(mp4);
    expect(mp4.currentTime).toBe(321);
    expect(
      vi.mocked(resolveStream).mock.calls.map(([videos]) => videos.map(item => item.video_id))
    ).toEqual([[kodik.video_id, reserve.video_id], [reserve.video_id]]);
  });

  it('keeps the same Kodik source when switching a failed manual HLS stream to MP4', async () => {
    savePlaybackSettings({ quality: '480' });
    const cvh = video('1');
    const kodik = {
      ...video('1', 'AniLibria', 4),
      iframe_url: 'https://kodikplayer.com/video/1',
    };
    vi.stubGlobal('isTauri', true);
    vi.stubGlobal('__TAURI_INTERNALS__', {
      invoke: vi.fn(async (command, args) => {
        if (command === 'inspect_stream_qualities') return [480];
        if (command !== 'yummy_request') return null;
        const response = args.request.path.includes('/videos') ? [cvh, kodik] : anime;
        return { status: 200, body: JSON.stringify({ response }) };
      }),
    });
    vi.mocked(resolveStream).mockImplementation(async sources =>
      sources.length > 1
        ? {
            provider: 'CVH',
            videoId: cvh.video_id,
            duration: 1400,
            streams: [{ quality: 480, type: 'mp4', url: 'https://cdn.example/cvh.mp4' }],
          }
        : {
            provider: 'Kodik',
            videoId: kodik.video_id,
            duration: 1400,
            streams: [
              {
                quality: 480,
                type: 'hls',
                url: 'https://cdn.example/kodik.m3u8',
                fallback: { type: 'mp4', url: 'https://cdn.example/kodik.mp4' },
              },
            ],
          }
    );
    const { container } = render(<Player anime={anime} />);
    const findVideo = (name: string) =>
      waitFor(() => {
        const media = container.querySelector<HTMLVideoElement>(`video[src$="${name}.mp4"]`);
        expect(media).toBeTruthy();
        return media!;
      });
    const media = await findVideo('cvh');
    Object.defineProperty(media, 'duration', { value: 1400, configurable: true });
    fireEvent.loadedMetadata(media);
    media.currentTime = 321;
    fireEvent.timeUpdate(media);
    fireEvent.click(screen.getByRole('button', { name: 'Настройки плеера' }));
    const ready = vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(0);
    chooseOption(screen.getByRole('combobox', { name: 'Источник потока' }), 'Kodik · HLS');

    const reserve = await findVideo('kodik');
    ready.mockReturnValue(4);
    Object.defineProperty(reserve, 'duration', { value: 1400, configurable: true });
    fireEvent.loadedMetadata(reserve);
    expect(reserve.currentTime).toBe(321);
    expect(vi.mocked(resolveStream).mock.lastCall?.[0]).toEqual([kodik]);
  });

  it('lists qualities across sources and falls back within the manually selected stream', async () => {
    const kodik = { ...video('1'), iframe_url: 'https://kodikplayer.com/video/1' };
    const cvh = {
      ...video('1', 'AniLibria', 4),
      iframe_url: 'https://ru.yummyani.me/iframeCVH.html?anime_id=10531',
    };
    vi.stubGlobal('isTauri', true);
    vi.stubGlobal('__TAURI_INTERNALS__', {
      invoke: vi.fn(async (command, args) => {
        if (command === 'inspect_stream_qualities') return [1080, 720, 360, 480, 360];
        if (command !== 'yummy_request') return null;
        const response = args.request.path.includes('/videos') ? [kodik, cvh] : anime;
        return { status: 200, body: JSON.stringify({ response }) };
      }),
    });
    vi.mocked(resolveStream)
      .mockReset()
      .mockImplementation(async (videos, _signal, options) =>
        videos.length > 1 && options?.quality !== 720
          ? {
              provider: 'CVH',
              videoId: cvh.video_id,
              duration: 1400,
              streams: [360, 1080].map(quality => ({
                quality,
                type: 'mp4',
                url: `https://cdn.example/cvh-${quality}.mp4`,
              })),
            }
          : {
              provider: 'Kodik',
              videoId: kodik.video_id,
              duration: 1400,
              streams: [480, 720].map(quality => ({
                quality,
                type: 'mp4',
                url: `https://cdn.example/kodik-${quality}.mp4`,
              })),
            }
      );
    const { container } = render(<Player anime={anime} />);
    const stream = (name: string) =>
      waitFor(() =>
        expect(container.querySelector('video')?.getAttribute('src')).toBe(
          `https://cdn.example/${name}.mp4`
        )
      );
    const openSettings = () =>
      fireEvent.click(screen.getByRole('button', { name: 'Настройки плеера' }));
    const quality = () =>
      screen.getByRole<HTMLButtonElement>('combobox', { name: 'Качество видео' });
    const source = () =>
      screen.getByRole<HTMLButtonElement>('combobox', { name: 'Источник потока' });

    await stream('cvh-360');
    openSettings();
    expect(source().textContent).toBe('Авто');
    fireEvent.click(quality());
    await waitFor(() =>
      expect(screen.getAllByRole('option').map(option => option.getAttribute('value'))).toEqual([
        'auto',
        '360',
        '480',
        '720',
        '1080',
      ])
    );
    fireEvent.click(screen.getByRole('option', { name: '720p' }));
    await stream('kodik-720');
    expect(vi.mocked(resolveStream).mock.calls.at(-1)?.[2]?.quality).toBe(720);

    openSettings();
    chooseOption(quality(), '1080p');
    await stream('cvh-1080');
    openSettings();
    chooseOption(source(), 'Kodik · MP4');
    await stream('kodik-720');
    expect(vi.mocked(resolveStream).mock.calls.at(-1)?.[0]).toEqual([kodik]);
    expect(vi.mocked(resolveStream).mock.calls.at(-1)?.[2]?.quality).toBeUndefined();
    openSettings();
    expect(quality().value).toBe('1080');
    chooseOption(quality(), '360p');
    expect(await screen.findByText(/В выбранном потоке нет 360p или ниже/)).toBeTruthy();
    chooseOption(quality(), '1080p');
    await stream('kodik-720');

    mediaError(container.querySelector('video')!);
    await screen.findByRole('button', { name: 'Повторить загрузку' }, { timeout: 3000 });
    expect(resolveStream).toHaveBeenCalledTimes(4);
    expect(source().textContent).toBe('Kodik · MP4');
    chooseOption(source(), 'Авто');
    await stream('cvh-1080');
  });
  it('does not rewind on repeated decoder metadata during accelerated playback', async () => {
    const { container } = render(
      <Player
        anime={anime}
        history={{
          anime,
          episode: '1',
          videoId: video('1').video_id,
          group: '',
          updatedAt: Date.now(),
          position: 120,
          duration: 1400,
        }}
      />
    );

    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain('360')
    );

    const media = container.querySelector('video')!;

    Object.defineProperty(media, 'duration', { value: 1400, configurable: true });
    fireEvent.loadedMetadata(media);
    expect(media.currentTime).toBe(120);
    media.playbackRate = 2;
    media.currentTime = 180;
    fireEvent.timeUpdate(media);
    // Metadata can repeat between timeupdate events; neither layer may restore
    // an old history position or even the previous timeupdate's position.
    media.currentTime = 184;
    fireEvent.loadedMetadata(media);
    expect(media.currentTime).toBe(184);
    media.currentTime = 188;
    fireEvent.loadedMetadata(media);
    expect(media.currentTime).toBe(188);
  });

  it('updates cached episodes in the background without resetting the chosen episode or decoder', async () => {
    putCache('data', `/anime/${anime.anime_id}/videos?`, [video('1'), video('2')]);

    let finish!: (response: Response) => void;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        new Promise<Response>(resolve => {
          finish = resolve;
        })
      )
    );
    vi.mocked(resolveStream).mockResolvedValue({
      provider: 'Test',
      videoId: video('2').video_id,
      duration: 1400,
      streams: [{ quality: 360, type: 'mp4', url: 'https://cdn.example/episode-2.mp4' }],
    });

    const { container } = render(
      <Player anime={anime} preferredEpisode="2" preferredVoice="AniLibria" />
    );

    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain('episode-2')
    );

    const media = container.querySelector('video')!;

    Object.defineProperty(media, 'duration', { value: 1400, configurable: true });
    fireEvent.loadedMetadata(media);
    media.currentTime = 123;
    fireEvent.timeUpdate(media);
    finish(new Response(JSON.stringify({ response: [video('1'), video('2'), video('3')] })));
    fireEvent.click(screen.getByRole('button', { name: 'Серии' }));
    await screen.findByRole('button', { name: 'Серия 3' });
    expect(container.querySelector('video')).toBe(media);
    expect(media.currentTime).toBe(123);
    expect(container.querySelector('.video-heading strong')?.textContent).toContain('серия 2');
  });
  it('loads native video without an iframe or an extra Play button, and keeps playback when returning to source mode', async () => {
    const { container } = render(<Player anime={anime} />);

    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toBe(
        'https://cdn.example/360.mp4'
      )
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.queryByRole('button', { name: /Смотреть серию/ })).toBeNull();
    expect(readLibrary().history).toEqual([]);

    const media = container.querySelector('video')!;

    Object.defineProperty(media, 'paused', { value: false, configurable: true });
    Object.defineProperty(media, 'duration', { value: 1400, configurable: true });
    fireEvent.loadedMetadata(media);
    media.currentTime = 123;
    fireEvent.play(media);
    fireEvent.timeUpdate(media);
    fireEvent.click(screen.getByRole('button', { name: 'Плеер: Наш плеер' }));
    fireEvent.click(screen.getByRole('button', { name: /Player 1/ }));
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    expect(readLibrary().history[0].position).toBe(123);
    await waitFor(() =>
      expect(container.querySelector('.resume-notice')?.textContent).toContain('02:03')
    );
  });
  it('lists our player first alongside providers and keeps quality inside its controls', async () => {
    const { container } = render(<Player anime={anime} />);

    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain('360')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Плеер: Наш плеер' }));

    const options = within(screen.getByRole('dialog'))
      .getAllByRole('button')
      .filter(button => button.classList.contains('source-option'));

    expect(options.map(button => button.querySelector('strong')?.textContent)).toEqual([
      'Наш плеер',
      'Player 1',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByRole('combobox', { name: 'Качество видео' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Настройки плеера' }));
    expect(
      within(screen.getByRole('dialog', { name: 'Настройки плеера' })).getByRole('combobox', {
        name: 'Качество видео',
      })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть настройки' }));
    fireEvent.click(screen.getByRole('button', { name: /Озвучка:/ }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: /AniDub/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(document.body.style.overflow).not.toBe('hidden');
  });
  it('keeps only quality, speed and playback toggles in settings', async () => {
    const { container } = render(<Player anime={anime} />);

    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Настройки плеера' }));

    const dialog = screen.getByRole('dialog', { name: 'Настройки плеера' });

    expect(
      within(dialog)
        .getAllByRole('combobox')
        .map(element => element.getAttribute('aria-label'))
    ).toEqual(['Качество видео', 'Скорость воспроизведения']);
    expect(dialog.querySelector('.video-settings-selects')?.children).toHaveLength(2);
    expect(
      within(dialog).queryByRole('checkbox', { name: 'Следующая серия автоматически' })
    ).toBeNull();
    expect(screen.getAllByRole('checkbox', { name: 'Следующая серия автоматически' })).toHaveLength(
      1
    );
  });
  it('preserves the episode and exact position through a stream error, new URL and page reload', async () => {
    const first = render(<Player anime={anime} />);

    await waitFor(() =>
      expect(first.container.querySelector('video')?.getAttribute('src')).toContain('360')
    );

    let media = first.container.querySelector('video')!;

    Object.defineProperty(media, 'duration', { value: 1400, configurable: true });
    Object.defineProperty(media, 'paused', { value: false, configurable: true });
    fireEvent.loadedMetadata(media);
    fireEvent.playing(media);
    media.currentTime = 321;
    fireEvent.timeUpdate(media);
    // Some media engines reset currentTime before notifying about a broken stream.
    media.currentTime = 0;
    mediaError(media);
    expect(readPlaybackRecovery(anime.anime_id)?.position).toBe(321);
    vi.mocked(resolveStream).mockResolvedValue({
      provider: 'Test',
      videoId: video('1').video_id,
      duration: 1400,
      streams: [{ quality: 360, type: 'mp4', url: 'https://cdn.example/refreshed.mp4' }],
    });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Повторить загрузку' }, { timeout: 3000 })
    );
    await waitFor(() =>
      expect(first.container.querySelector('video')?.getAttribute('src')).toContain('refreshed.mp4')
    );
    media = first.container.querySelector('video')!;
    Object.defineProperty(media, 'duration', { value: 1400, configurable: true });
    fireEvent.loadedMetadata(media);
    expect(media.currentTime).toBe(321);
    first.unmount();

    const second = render(<Player anime={anime} />);

    await waitFor(() => expect(second.container.querySelector('video')).not.toBeNull());
    media = second.container.querySelector('video')!;
    Object.defineProperty(media, 'duration', { value: 1400, configurable: true });
    fireEvent.loadedMetadata(media);
    expect(media.currentTime).toBe(321);
  });
  it('checkpoints locally as soon as the network or stream stalls', async () => {
    const { container } = render(<Player anime={anime} />);

    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());

    const media = container.querySelector('video')!;

    Object.defineProperty(media, 'duration', { value: 1400, configurable: true });
    Object.defineProperty(media, 'paused', { value: false, configurable: true });
    fireEvent.loadedMetadata(media);
    fireEvent.playing(media);
    media.currentTime = 222;
    fireEvent.timeUpdate(media);
    window.dispatchEvent(new Event('offline'));
    expect(readPlaybackRecovery(anime.anime_id)?.position).toBe(222);
    media.currentTime = 233;
    fireEvent.timeUpdate(media);
    fireEvent.stalled(media);
    expect(readPlaybackRecovery(anime.anime_id)?.position).toBe(233);
  });
  it('switches to the chosen provider and back without recording an unplayed episode', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            new Response(JSON.stringify({ response: [video('2'), video('2', 'AniLibria', 4)] }))
          )
        )
    );

    const { container } = render(<Player anime={anime} />);

    await screen.findByRole('button', { name: 'Плеер: Наш плеер' });
    fireEvent.click(screen.getByRole('button', { name: 'Плеер: Наш плеер' }));
    fireEvent.click(screen.getByRole('button', { name: /Player 4/ }));
    await waitFor(() => expect(container.querySelector('iframe')?.src).toContain('/4/2'));
    expect(screen.queryByRole('checkbox', { name: 'Автопропуск опенинга' })).toBeNull();
    chooseOption(screen.getByRole('combobox', { name: 'Плеер' }), 'Наш плеер');
    await waitFor(() =>
      expect(container.querySelector('.watch-now')?.textContent).toContain('Серия 2')
    );
    expect(readLibrary().history).toEqual([]);
  });
  it.each([true, false])(
    'restores playing state only after a successful audio permission probe (%s)',
    async allowed => {
      vi.mocked(probeAudioPlayback).mockResolvedValue(allowed);

      const { container } = render(
        <Player
          anime={anime}
          history={{
            anime,
            episode: '1',
            videoId: video('1').video_id,
            group: '',
            updatedAt: Date.now(),
            position: 300,
            duration: 1400,
            playing: true,
          }}
        />
      );

      await waitFor(() =>
        expect(container.querySelector('video')?.getAttribute('src')).toContain('360')
      );

      const media = container.querySelector('video')!;

      Object.defineProperty(media, 'duration', { value: 1400, configurable: true });
      fireEvent.loadedMetadata(media);
      expect(media.currentTime).toBe(300);
      expect(probeAudioPlayback).toHaveBeenCalled();
      if (allowed) expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
      else expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    }
  );
  it('does not probe or autoplay a deliberately paused video after reload', async () => {
    const { container } = render(
      <Player
        anime={anime}
        history={{
          anime,
          episode: '1',
          videoId: video('1').video_id,
          group: '',
          updatedAt: Date.now(),
          position: 300,
          duration: 1400,
          playing: false,
        }}
      />
    );

    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    fireEvent.loadedMetadata(container.querySelector('video')!);
    expect(probeAudioPlayback).not.toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });
  it('keeps playing the original quality until the replacement is ready and retains the open settings', async () => {
    const { container } = render(<Player anime={anime} />);

    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain('360')
    );

    const live = container.querySelector('video')!;

    Object.defineProperty(live, 'duration', { value: 1400, configurable: true });
    Object.defineProperty(live, 'paused', { value: false, configurable: true });
    fireEvent.loadedMetadata(live);
    fireEvent.playing(live);
    fireEvent.canPlay(live);
    live.currentTime = 123;
    fireEvent.timeUpdate(live);

    const pause = vi.fn();

    live.pause = pause;
    live.volume = 0.4;
    live.muted = true;
    live.playbackRate = 1.5;
    fireEvent.click(screen.getByRole('button', { name: 'Настройки плеера' }));
    chooseOption(screen.getByRole('combobox', { name: 'Качество видео' }), '720p');
    await waitFor(() =>
      expect(
        container.querySelector<HTMLVideoElement>('video[data-active=false]')?.getAttribute('src')
      ).toContain('720')
    );
    expect(pause).not.toHaveBeenCalled();
    expect(live.getAttribute('src')).toContain('360');
    expect(container.querySelector('.playback-loader')).toBeNull();

    const next = container.querySelector<HTMLVideoElement>('video[data-active=false]')!;

    Object.defineProperty(next, 'duration', { value: 1400, configurable: true });

    let paused = true;

    Object.defineProperty(next, 'paused', { get: () => paused, configurable: true });
    vi.spyOn(next, 'play').mockImplementation(async () => {
      paused = false;
    });
    fireEvent.loadedMetadata(next);
    fireEvent.canPlay(next);
    await waitFor(() =>
      expect(container.querySelector<HTMLVideoElement>('video[data-active=true]')).toBe(next)
    );
    expect(next.currentTime).toBeCloseTo(123, 0);
    expect(next.volume).toBe(0.4);
    expect(next.muted).toBe(true);
    expect(next.playbackRate).toBe(1.5);
    expect(screen.getByRole('dialog', { name: 'Настройки плеера' })).toBeTruthy();
    expect(container.querySelectorAll('video')).toHaveLength(1);
    expect(container.querySelector('.playback-loader')).toBeNull();
  });
  it('keeps the original quality if the replacement fails or is cancelled', async () => {
    const { container } = render(<Player anime={anime} />);

    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain('360')
    );

    const live = container.querySelector('video')!;

    fireEvent.loadedMetadata(live);
    fireEvent.canPlay(live);

    const pause = vi.fn();

    live.pause = pause;
    fireEvent.click(screen.getByRole('button', { name: 'Настройки плеера' }));

    const quality = screen.getByRole('combobox', { name: 'Качество видео' });

    chooseOption(quality, '720p');
    await waitFor(() =>
      expect(container.querySelector<HTMLVideoElement>('video[data-active=false]')).not.toBeNull()
    );
    mediaError(container.querySelector<HTMLVideoElement>('video[data-active=false]')!);
    await waitFor(() => expect((quality as HTMLButtonElement).value).toBe('360'));
    expect(container.querySelector<HTMLVideoElement>('video[data-active=true]')).toBe(live);
    expect(container.querySelector('.playback-loader.is-error')).toBeNull();
    expect(pause).not.toHaveBeenCalled();
    chooseOption(quality, '720p');
    await waitFor(() => expect(container.querySelectorAll('video')).toHaveLength(2));

    const obsolete = container.querySelector<HTMLVideoElement>('video[data-active=false]')!;

    chooseOption(quality, '360p');
    fireEvent.canPlay(obsolete);
    expect(container.querySelector<HTMLVideoElement>('video[data-active=true]')).toBe(live);
    expect(container.querySelectorAll('video')).toHaveLength(1);
  });
  it('prepares a new decoder even when different qualities share one master playlist', async () => {
    vi.mocked(resolveStream).mockResolvedValue({
      provider: 'CVH',
      videoId: video('1').video_id,
      duration: 1400,
      streams: [360, 720].map(quality => ({
        quality,
        type: 'mp4',
        url: 'https://cdn.example/master.mp4',
      })),
    });

    const { container } = render(<Player anime={anime} />);

    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain('master')
    );

    const live = container.querySelector('video');

    fireEvent.click(screen.getByRole('button', { name: 'Настройки плеера' }));
    chooseOption(screen.getByRole('combobox', { name: 'Качество видео' }), '720p');
    await waitFor(() => expect(container.querySelectorAll('video')).toHaveLength(2));
    expect(container.querySelector('video[data-active=true]')).toBe(live);
  });
  it('abandons a quality that never becomes ready while preserving the live layer', async () => {
    const { container } = render(<Player anime={anime} />);

    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain('360')
    );

    const live = container.querySelector('video');

    try {
      vi.useFakeTimers();
      fireEvent.click(screen.getByRole('button', { name: 'Настройки плеера' }));
      chooseOption(screen.getByRole('combobox', { name: 'Качество видео' }), '720p');
      await act(async () => {});
      expect(container.querySelectorAll('video')).toHaveLength(2);
      await act(async () => {
        vi.advanceTimersByTime(20001);
      });
      expect(container.querySelectorAll('video')).toHaveLength(1);
      expect(container.querySelector('video')).toBe(live);
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it('shows a failure without silently mounting an advertising iframe', async () => {
    vi.mocked(resolveStream).mockRejectedValue(new Error('Нет доступного потока'));

    const { container } = render(<Player anime={anime} />);

    await screen.findByText('Нет доступного потока', {}, { timeout: 3000 });
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy();
  });
  it('suggests enabling a disabled proxy on a Kodik server error and retries after saving', async () => {
    let enabled = false;
    const source = { ...video('1'), iframe_url: 'https://kodikplayer.com/video/1' };
    const invoke = vi.fn(async (command, args) => {
      if (command === 'proxy_settings') {
        if (typeof args.enabled === 'boolean') enabled = args.enabled;
        return enabled;
      }
      if (command !== 'yummy_request') return [];
      const response = args.request.path.includes('/videos') ? [source] : anime;
      return { status: 200, body: JSON.stringify({ response }) };
    });
    vi.stubGlobal('isTauri', true);
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    vi.mocked(resolveStream).mockImplementation(async () => {
      if (!enabled) {
        throw new Error(
          'Kodik · страница плеера. Источник вернул HTTP 500. Aksor · нет манифеста DASH (HTTP 203).'
        );
      }
      return {
        provider: 'Kodik',
        videoId: source.video_id,
        duration: 1400,
        streams: [{ quality: 360, type: 'mp4', url: 'https://cdn.example/recovered.mp4' }],
      };
    });
    const { container } = render(<Player anime={anime} />);

    const enable = await screen.findByRole(
      'button',
      { name: 'Включить прокси и повторить' },
      { timeout: 3000 }
    );
    expect(enabled).toBe(false);
    fireEvent.click(enable);
    await waitFor(() => expect(container.querySelector('video')?.src).toContain('recovered.mp4'));
    expect(invoke).toHaveBeenCalledWith('proxy_settings', { enabled: true }, undefined);
  });
  it('waits for the remaining source and a grace period before showing its final error', async () => {
    const sources = [video('1'), video('1', 'AniLibria', 4)];
    let reject!: (error: Error) => void;

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(new Response(JSON.stringify({ response: sources })))
        )
    );
    vi.mocked(resolveStream)
      .mockReset()
      .mockResolvedValueOnce({
        provider: 'CVH',
        videoId: 1001,
        duration: 1400,
        streams: [{ quality: 360, type: 'mp4', url: 'https://cdn.example/first.mp4' }],
      })
      .mockImplementation(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          })
      );

    const { container } = render(<Player anime={anime} />);

    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain('first.mp4')
    );
    mediaError(container.querySelector('video')!);
    await waitFor(() => expect(typeof reject).toBe('function'));
    await new Promise(resolve => setTimeout(resolve, 1600));
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => reject(new Error('Последний источник недоступен')));
    expect(screen.queryByRole('alert')).toBeNull();
    await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(
      within(screen.getByRole('alert')).getByText(/Последний источник недоступен/)
    ).toBeTruthy();
  });
  it('restarts a failed media request even if resolving again returns the same URL', async () => {
    const { container } = render(<Player anime={anime} />);

    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain('360')
    );

    const calls = vi.mocked(HTMLMediaElement.prototype.load).mock.calls.length;

    mediaError(container.querySelector('video')!);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Повторить загрузку' }, { timeout: 3000 })
    );
    await waitFor(() =>
      expect(vi.mocked(HTMLMediaElement.prototype.load).mock.calls.length).toBeGreaterThan(calls)
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('.playback-loader.is-error')).toBeNull();
  });
  it.each([true, false])(
    'tries another provider for the same episode and voice, preserving position and playback intent (%s)',
    async playing => {
      const sources = [video('1'), video('1', 'AniLibria', 4), video('2'), video('1', 'AniDub')];

      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockImplementation(() =>
            Promise.resolve(new Response(JSON.stringify({ response: sources })))
          )
      );
      vi.mocked(resolveStream)
        .mockClear()
        .mockImplementation(async candidates => ({
          provider: candidates[0].data.player,
          videoId: candidates[0].video_id,
          duration: 1400,
          streams: [
            { quality: 360, type: 'mp4', url: `https://cdn.example/${candidates[0].video_id}.mp4` },
          ],
        }));

      const { container } = render(<Player anime={anime} />);

      await waitFor(() =>
        expect(container.querySelector('video')?.getAttribute('src')).toContain('1001.mp4')
      );

      const first = container.querySelector('video')!;

      Object.defineProperty(first, 'duration', { value: 1400, configurable: true });
      Object.defineProperty(first, 'paused', { value: !playing, configurable: true });
      fireEvent.loadedMetadata(first);
      if (playing) fireEvent.playing(first);
      first.currentTime = 321;
      first.muted = true;
      first.volume = 0.25;
      first.playbackRate = 1.5;
      fireEvent.timeUpdate(first);
      vi.mocked(HTMLMediaElement.prototype.play).mockClear();
      mediaError(first);
      await waitFor(() =>
        expect(container.querySelector('video')?.getAttribute('src')).toContain('4001.mp4')
      );

      const replacement = container.querySelector('video')!;

      Object.defineProperty(replacement, 'duration', { value: 1400, configurable: true });
      fireEvent.loadedMetadata(replacement);
      expect(replacement.currentTime).toBe(321);
      expect(replacement.muted).toBe(true);
      expect(replacement.volume).toBe(0.25);
      expect(replacement.playbackRate).toBe(1.5);
      expect(
        vi
          .mocked(resolveStream)
          .mock.calls.map(([candidates]) => candidates.map(value => value.video_id))
      ).toEqual([[1001, 4001], [4001]]);
      expect(vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length > 0).toBe(playing);
      expect(container.querySelector('iframe')).toBeNull();
    }
  );
  it('stops after exhausting providers and lets an explicit retry start again', async () => {
    const sources = [video('1'), video('1', 'AniLibria', 4), video('1', 'AniLibria', 6)];

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(new Response(JSON.stringify({ response: sources })))
        )
    );
    vi.mocked(resolveStream)
      .mockClear()
      .mockImplementation(async candidates => ({
        provider: candidates[0].data.player,
        videoId: candidates[0].video_id,
        duration: 1400,
        streams: [
          { quality: 360, type: 'mp4', url: `https://cdn.example/${candidates[0].video_id}.mp4` },
        ],
      }));

    const back = vi.fn();
    const { container } = render(<Player anime={anime} presentation="immersive" onBack={back} />);

    for (const id of [1001, 4001, 6001]) {
      await waitFor(() =>
        expect(container.querySelector('video')?.getAttribute('src')).toContain(`${id}.mp4`)
      );
      mediaError(container.querySelector('video')!);
    }
    await screen.findByRole('button', { name: 'Повторить загрузку' }, { timeout: 3000 });
    expect(resolveStream).toHaveBeenCalledTimes(3);
    expect(container.querySelector('iframe')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Вернуться к аниме' }));
    expect(back).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку' }));
    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain('1001.mp4')
    );
    expect(resolveStream).toHaveBeenCalledTimes(4);
  });
  it('does not discard providers when the device itself is offline', async () => {
    const sources = [video('1'), video('1', 'AniLibria', 4)];

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(new Response(JSON.stringify({ response: sources })))
        )
    );
    vi.mocked(resolveStream).mockClear();

    const { container } = render(<Player anime={anime} />);

    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    mediaError(container.querySelector('video')!);
    await screen.findByRole('button', { name: 'Повторить загрузку' }, { timeout: 3000 });
    expect(resolveStream).toHaveBeenCalledTimes(1);
  });
  it('allows leaving while the resolver is still pending or has failed', async () => {
    let reject!: (error: Error) => void;

    vi.mocked(resolveStream).mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        })
    );

    const back = vi.fn();

    render(<Player anime={anime} presentation="immersive" onBack={back} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Об аниме' }));
    expect(back).toHaveBeenCalledOnce();
    await waitFor(() => expect(typeof reject).toBe('function'));
    const loader = screen.getByText('Подбираем видеопоток…').closest('.playback-loader');
    reject(new Error('Нет доступного потока'));
    await screen.findByText('Нет доступного потока', {}, { timeout: 3000 });
    expect(screen.getByRole('alert')).toBe(loader);
    expect(loader?.querySelector('.playback-spinner')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Об аниме' }));
    expect(back).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByText('Подбираем видеопоток…').closest('.playback-loader')).toBe(loader);
  });
  it('syncs the resolved provider rather than the representative episode, including automatic skips', async () => {
    saveSession({
      token: 'test-account',
      user: { id: 42, nickname: 'Test' },
      verified: true,
      remember: false,
      refreshedAt: Date.now(),
    });

    const actual = {
      ...video('1', 'AniLibria', 4),
      skips: { opening: { time: 10, length: 90 }, ending: { time: 1200, length: 90 } },
    };
    const representative = { ...video('1'), skips: { opening: { time: 0, length: 50 } } };
    const fetcher = vi
      .fn()
      .mockImplementation((_url, init) =>
        Promise.resolve(
          new Response(
            JSON.stringify({ response: init?.method === 'PUT' ? true : [actual, representative] })
          )
        )
      );

    vi.stubGlobal('fetch', fetcher);
    vi.mocked(resolveStream).mockResolvedValue({
      provider: 'Alloha',
      videoId: actual.video_id,
      duration: 1400,
      skips: { opening: { time: 15, length: 90 }, ending: { time: 1200, length: 90 } },
      streams: [{ quality: 360, type: 'mp4', url: 'https://cdn.example/actual.mp4' }],
    });

    const onPlayback = vi.fn();
    const { container } = render(<Player anime={anime} onPlayback={onPlayback} />);

    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain('actual.mp4')
    );

    const media = container.querySelector('video')!;

    Object.defineProperty(media, 'duration', { value: 1400, configurable: true });
    Object.defineProperty(media, 'paused', { value: true, configurable: true });
    fireEvent.loadedMetadata(media);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
    media.currentTime = 20;
    fireEvent.timeUpdate(media);
    expect(await screen.findByRole('button', { name: 'Пропустить опенинг' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Настройки плеера' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Автопропуск опенинга' }));
    fireEvent.timeUpdate(media);
    expect(media.currentTime).toBe(20); // A paused player never jumps.
    vi.useFakeTimers();
    Object.defineProperty(media, 'paused', { value: false, configurable: true });
    fireEvent.playing(media);
    expect(media.currentTime).toBe(20);
    act(() => {
      vi.advanceTimersByTime(AUTO_ACTION_DELAY_MS);
    });
    expect(media.currentTime).toBe(105);
    vi.useRealTimers();
    fireEvent.seeked(media);
    await waitFor(() => expect(getLibraryState().history[0]?.position).toBe(105));

    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT');

    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every(([url]) => new URL(url).pathname === `/video/${actual.video_id}`)).toBe(
      true
    );
    expect(onPlayback.mock.calls.find(([event]) => event.reason === 'skip')?.[0]).toMatchObject({
      playback: { videoId: actual.video_id, provider: 'Alloha', position: 105 },
      skip: { kind: 'opening', from: 20, to: 105, automatic: true },
    });
    media.currentTime = 20;
    fireEvent.timeUpdate(media);
    expect(media.currentTime).toBe(20); // Rewind does not trigger a loop.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Автопропуск титров' }));
    vi.useFakeTimers();
    media.currentTime = 1210;
    fireEvent.timeUpdate(media);
    act(() => {
      vi.advanceTimersByTime(AUTO_ACTION_DELAY_MS);
    });
    expect(media.currentTime).toBe(1290);
    vi.useRealTimers();
    fireEvent.seeked(media);
    Object.defineProperty(media, 'paused', { value: true, configurable: true });
    fireEvent.pause(media);
    await waitFor(() => expect(getLibraryState().history[0]?.position).toBe(1290));
    expect(media.currentTime).toBeLessThan(media.duration);
    expect(container.querySelector('.video-stream-meta')?.textContent).toContain('Alloha');
    expect(container.querySelector('.playback-status')).toBeNull();
  });
});

it('passes playback speed, pauses and completion from the universal player to Discord', async () => {
  const { container } = render(<Player anime={anime} />);

  await waitFor(() =>
    expect(container.querySelector('video')?.getAttribute('src')).toContain('360')
  );

  const media = container.querySelector('video')!;

  Object.defineProperty(media, 'duration', { value: 1400, configurable: true });
  vi.spyOn(media, 'paused', 'get').mockReturnValue(false);

  fireEvent.loadedMetadata(media);
  fireEvent.playing(media);
  media.playbackRate = 2;
  fireEvent(media, new Event('ratechange'));
  await waitFor(() =>
    expect(useDiscordPresence).toHaveBeenLastCalledWith(
      anime,
      expect.objectContaining({ number: '1' }),
      expect.objectContaining({ playing: true, playbackRate: 2, reason: 'ratechange' })
    )
  );

  vi.spyOn(media, 'paused', 'get').mockReturnValue(true);
  fireEvent.pause(media);
  await waitFor(() =>
    expect(useDiscordPresence).toHaveBeenLastCalledWith(
      anime,
      expect.objectContaining({ number: '1' }),
      expect.objectContaining({ playing: false, reason: 'pause' })
    )
  );

  fireEvent.ended(media);
  await waitFor(() =>
    expect(useDiscordPresence).toHaveBeenLastCalledWith(
      anime,
      expect.objectContaining({ number: '1' }),
      expect.objectContaining({ playing: false, reason: 'ended' })
    )
  );
});

it('provides the selected episode to Discord while stream resolution is still pending', async () => {
  vi.mocked(resolveStream).mockReturnValue(new Promise(() => {}));
  const { container } = render(<Player anime={anime} preferredEpisode="2" startPlaying />);
  await waitFor(() =>
    expect(useDiscordPresence).toHaveBeenLastCalledWith(
      anime,
      expect.objectContaining({ number: '2' }),
      expect.objectContaining({ playing: false, reason: 'sourcechange' })
    )
  );
  expect(container.querySelector('video')).toBeNull();
});
