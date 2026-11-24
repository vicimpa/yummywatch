// @vitest-environment jsdom
import { chooseOption } from './dropdown-actions';
import { useRef } from 'preact/hooks';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_ACTION_DELAY_MS } from '~/components/AutoActionCountdown';
import {
  STREAM_ERROR_DELAY_MS,
  STREAM_STALL_TIMEOUT_MS,
  STREAM_RESUME_REFRESH_MS,
  VideoSurface,
} from '~/components/VideoSurface';
import { CONTROLS_IDLE_MS } from '~/components/VideoControls';
import type { PictureInPictureControls } from '~/lib/native-playback';
import { playbackSettings } from '~/lib/playback-settings';
import type { Stream } from '~/lib/streams';

function Harness({
  url = 'https://cdn.example/test.mp4',
  quality = 360,
  poster = '',
  loadingImage,
  previewStream,
  failure = () => {},
  autoOpening = false,
  autoEnding = false,
  autoNext = false,
  next,
  ended,
  skips = {},
  resume,
  background,
  pip,
}: {
  url?: string;
  quality?: number;
  poster?: string;
  loadingImage?: string;
  previewStream?: Stream;
  failure?: (playing: boolean) => void;
  autoOpening?: boolean;
  autoEnding?: boolean;
  autoNext?: boolean;
  next?: () => void;
  ended?: () => void;
  skips?: { opening?: { time: number; length: number }; ending?: { time: number; length: number } };
  resume?: () => boolean;
  background?: boolean;
  pip?: PictureInPictureControls;
}) {
  const media = useRef<HTMLVideoElement>(null);

  return (
    <VideoSurface
      stream={{ quality, type: 'mp4', url }}
      previewStream={previewStream}
      identity={1}
      start={0}
      autoplay={false}
      background={background}
      pip={pip}
      media={media}
      onUpdate={() => {}}
      onEnded={ended}
      autoNext={autoNext}
      next={next}
      onStreamError={failure}
      onResume={resume}
      retry={() => {}}
      title="Тест"
      poster={poster}
      loadingImage={loadingImage}
      skips={skips}
      autoOpening={autoOpening}
      autoEnding={autoEnding}
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.removeItem('yumiwatch:playback-settings');
  localStorage.removeItem('yumiwatch:interface-settings');
  delete document.documentElement.dataset.desktop;
});

const advance = () =>
  act(() => {
    vi.advanceTimersByTime(STREAM_STALL_TIMEOUT_MS + STREAM_ERROR_DELAY_MS + 1);
  });

it('shows only the selected preview while the video is loading', () => {
  const { container } = render(
    <Harness poster="https://static.yani.tv/poster.jpg" loadingImage="blob:watch-frame" />
  );
  expect(container.querySelector('video')?.hasAttribute('poster')).toBe(false);
  const images = container.querySelectorAll('.playback-preview img');
  expect(images).toHaveLength(1);
  expect(images[0].getAttribute('src')).toBe('blob:watch-frame');
});

it('keeps the device awake while playing or buffering in PiP and releases on pause', async () => {
  vi.useRealTimers();
  const invoke = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('isTauri', true);
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
  const { container, rerender } = render(<Harness />);
  const video = container.querySelector('video')!;
  const paused = vi.spyOn(video, 'paused', 'get').mockReturnValue(false);
  const powerRequests = () =>
    invoke.mock.calls.filter(([command]) => command === 'set_playback_awake');

  await act(async () => {
    fireEvent.loadedMetadata(video);
    fireEvent.playing(video);
  });
  await waitFor(() =>
    expect(powerRequests()).toEqual([['set_playback_awake', { playing: true }, undefined]])
  );
  await act(async () => {
    rerender(<Harness background pip={{ active: true, pending: false, error: '', toggle() {} }} />);
    fireEvent.waiting(video);
  });
  expect(powerRequests()).toHaveLength(1);
  paused.mockReturnValue(true);
  await act(async () => {
    fireEvent.pause(video);
  });
  await waitFor(() =>
    expect(powerRequests()).toEqual([
      ['set_playback_awake', { playing: true }, undefined],
      ['set_playback_awake', { playing: false }, undefined],
    ])
  );
});

it('runs the macOS controls through the native surface without mounting HTML video', async () => {
  const snapshot = {
    ready: true,
    seeking: false,
    buffering: false,
    ended: false,
    failure: false,
    position: 9,
    duration: 90,
    buffered: 24,
  };
  const invoke = vi.fn(async (command, args) => {
    if (command === 'native_video' && args.request.action === 'poll') return { ...snapshot };
    return null;
  });
  vi.stubGlobal('isTauri', true);
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  document.documentElement.dataset.desktop = 'macos';
  localStorage.setItem(
    'yumiwatch:playback-settings',
    JSON.stringify({ upscale: 'fsr', upscaleSharpen: true })
  );

  const preview = { quality: 144, url: 'https://cdn.example/low.m3u8', type: 'hls' } as const;
  const { container, unmount } = render(<Harness previewStream={preview} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(container.querySelector('video')).toBeNull();
  const surface = container.querySelector('.native-stream-ready');
  expect(surface).not.toBeNull();
  expect(invoke).toHaveBeenCalledWith(
    'native_video',
    {
      request: expect.objectContaining({
        action: 'open',
        kind: 'mp4',
        preview: { url: preview.url, kind: 'hls' },
        upscale: 'fsr',
        sharpen: 'moderate',
      }),
    },
    undefined
  );
  expect(invoke).toHaveBeenCalledWith(
    'native_video',
    { request: expect.objectContaining({ action: 'poll', active: true }) },
    undefined
  );
  fireEvent.click(screen.getByRole('button', { name: 'Настройки плеера' }));
  const upscale = screen.getByRole<HTMLButtonElement>('combobox', { name: 'Апскейл видео' });
  const speed = screen.getByRole('combobox', { name: 'Скорость воспроизведения' });
  const sharpen = screen.getByRole<HTMLButtonElement>('combobox', { name: 'Резкость контуров' });
  expect(upscale.closest('label')?.previousElementSibling).toBe(speed.closest('label'));
  expect(upscale.value).toBe('fsr');
  expect(sharpen.value).toBe('moderate');
  chooseOption(sharpen, 'Сильно');
  expect(playbackSettings().upscaleSharpness).toBe('strong');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(invoke).toHaveBeenCalledWith(
    'native_video',
    { request: expect.objectContaining({ action: 'poll', upscale: 'fsr', sharpen: 'strong' }) },
    undefined
  );
  chooseOption(upscale, 'Стандартный');
  expect(playbackSettings().upscale).toBe('default');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(invoke).toHaveBeenCalledWith(
    'native_video',
    { request: expect.objectContaining({ action: 'poll', upscale: 'default', sharpen: 'strong' }) },
    undefined
  );
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть настройки' }));
  fireEvent.click(screen.getByRole('button', { name: 'Воспроизвести' }));
  fireEvent.input(screen.getByRole('slider', { name: 'Позиция воспроизведения' }), {
    target: { value: '24' },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(invoke).toHaveBeenCalledWith(
    'native_video',
    {
      request: expect.objectContaining({ action: 'poll', controls: { pause: false, seconds: 24 } }),
    },
    undefined
  );
  expect(
    invoke.mock.calls.filter(
      ([command, args]) => command === 'native_video' && args.request.action === 'open'
    )
  ).toHaveLength(1);
  unmount();
  expect(invoke).toHaveBeenCalledWith(
    'native_video',
    { request: expect.objectContaining({ action: 'close' }) },
    undefined
  );
});

it('updates every control after a new URL replaces the native player at the same quality', async () => {
  const sources = new Map<number, string>();
  const paused = new Map<number, boolean>();
  const invoke = vi.fn(async (command, { request }) => {
    if (command !== 'native_video') return null;
    if (request.action === 'open') sources.set(request.id, request.url);
    if (request.action !== 'poll') return null;
    if (request.controls.pause !== undefined) paused.set(request.id, request.controls.pause);

    const replacement = sources.get(request.id)?.includes('replacement');

    return {
      ready: true,
      seeking: false,
      buffering: false,
      ended: false,
      failure: false,
      paused: paused.get(request.id) ?? true,
      position: 9,
      duration: replacement ? 180 : 90,
      buffered: 24,
    };
  });
  vi.stubGlobal('isTauri', true);
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  document.documentElement.dataset.desktop = 'macos';

  const { rerender } = render(<Harness />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(screen.getByRole('slider', { name: 'Позиция воспроизведения' }).getAttribute('max')).toBe(
    '90'
  );
  fireEvent.click(screen.getByRole('button', { name: 'Воспроизвести' }));
  fireEvent.input(screen.getByRole('slider', { name: 'Громкость' }), { target: { value: '0.4' } });
  fireEvent.click(screen.getByRole('button', { name: 'Выключить звук' }));
  fireEvent.click(screen.getByRole('button', { name: 'Настройки плеера' }));
  chooseOption(screen.getByRole('combobox', { name: 'Скорость воспроизведения' }), '1.5×');

  rerender(<Harness url="https://cdn.example/replacement.mp4" />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(screen.getByRole('slider', { name: 'Позиция воспроизведения' }).getAttribute('max')).toBe(
    '180'
  );
  expect(screen.getByRole('button', { name: 'Пауза' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Включить звук' })).toBeTruthy();
  expect(
    (screen.getByRole('combobox', { name: 'Скорость воспроизведения' }) as HTMLButtonElement).value
  ).toBe('1.5');
  const replacement = [...sources].find(([, url]) => url.includes('replacement'))?.[0];
  expect(replacement).toBeDefined();
  expect(invoke).toHaveBeenCalledWith(
    'native_video',
    { request: expect.objectContaining({ action: 'open', id: replacement, start: 9 }) },
    undefined
  );
  expect(invoke).toHaveBeenCalledWith(
    'native_video',
    {
      request: expect.objectContaining({
        action: 'poll',
        id: replacement,
        controls: expect.objectContaining({ volume: 0.4, speed: 1.5 }),
      }),
    },
    undefined
  );
});

it('keeps the prepared native layer transparent when a new quality becomes active', async () => {
  const sources = new Map<number, string>();
  const playing = new Map<number, boolean>();
  let aligned = false;
  const invoke = vi.fn(async (command, { request }) => {
    if (command !== 'native_video') return null;
    if (request.action === 'open') sources.set(request.id, request.url);
    if (request.action !== 'poll') return null;
    if (request.controls.pause !== undefined) playing.set(request.id, !request.controls.pause);
    const replacement = sources.get(request.id)?.endsWith('/720.mp4');
    return {
      ready: true,
      seeking: !!replacement && !aligned,
      buffering: false,
      ended: false,
      failure: false,
      paused: !playing.get(request.id),
      position: !replacement || aligned ? 9 : 6,
      duration: 90,
      buffered: 24,
    };
  });
  vi.stubGlobal('isTauri', true);
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  document.documentElement.dataset.desktop = 'macos';
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 640, 360)
  );

  const { container, rerender } = render(<Harness />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Воспроизвести' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  const original = container.querySelector('.native-stream-layer.is-active');
  expect(original?.classList.contains('native-stream-ready')).toBe(true);

  rerender(<Harness url="https://cdn.example/720.mp4" quality={720} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  const prepared = container.querySelector('.native-stream-layer.is-standby');
  expect(prepared?.classList.contains('native-stream-ready')).toBe(true);
  expect(container.querySelector('.native-stream-layer.is-active')).toBe(original);

  aligned = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(240);
  });
  expect(prepared).toBe(container.querySelector('.native-stream-layer.is-active'));
  expect(prepared?.classList.contains('native-stream-ready')).toBe(true);
  expect(original?.isConnected).toBe(false);
  expect(screen.getByRole('button', { name: 'Пауза' })).toBeTruthy();
  const replacement = [...sources].find(([, url]) => url.endsWith('/720.mp4'))?.[0];
  expect(invoke).toHaveBeenCalledWith(
    'native_video',
    {
      request: expect.objectContaining({
        action: 'poll',
        id: replacement,
        active: true,
        visible: true,
      }),
    },
    undefined
  );
});

it('keeps a newer Play request while a poll is in flight and then follows the native pause state', async () => {
  const snapshot = {
    ready: true,
    seeking: false,
    buffering: false,
    ended: false,
    failure: false,
    paused: true,
    position: 9,
    duration: 90,
    buffered: 24,
  };
  let finishPoll: (value: typeof snapshot) => void = () => {};
  let block = false;
  const invoke = vi.fn(async (command, { request }) => {
    if (command !== 'native_video' || request.action !== 'poll') return null;
    if (block) {
      return new Promise<typeof snapshot>(resolve => {
        finishPoll = resolve;
      });
    }
    if (request.controls.pause !== undefined) {
      snapshot.paused = request.controls.pause;
      return { ...snapshot, paused: null };
    }

    return { ...snapshot };
  });
  vi.stubGlobal('isTauri', true);
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  document.documentElement.dataset.desktop = 'macos';

  render(<Harness />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  block = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(80);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Воспроизвести' }));
  await act(async () => {
    block = false;
    finishPoll({ ...snapshot });
  });
  expect(screen.getByRole('button', { name: 'Пауза' })).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(80);
  });
  expect(snapshot.paused).toBe(false);
  expect(screen.getByRole('button', { name: 'Пауза' })).toBeTruthy();
  snapshot.paused = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(80);
  });
  expect(screen.getByRole('button', { name: 'Воспроизвести' })).toBeTruthy();
});

it.each([
  ['ArrowRight', 10],
  ['ArrowLeft', -10],
] as const)(
  'accumulates held %s seeks while native snapshots are catching up',
  async (key, step) => {
    const snapshot = {
      ready: true,
      seeking: false,
      buffering: false,
      ended: false,
      failure: false,
      paused: false,
      position: 100,
      duration: 200,
      buffered: 120,
    };
    const requested: number[] = [];
    const invoke = vi.fn(async (command, { request }) => {
      if (command !== 'native_video' || request.action !== 'poll') return null;
      if (request.controls.seconds !== undefined) requested.push(request.controls.seconds);
      return { ...snapshot };
    });
    vi.stubGlobal('isTauri', true);
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    document.documentElement.dataset.desktop = 'macos';
    const { container } = render(<Harness />);
    const poll = (ms = 80) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    await poll();
    const controls = container.querySelector<HTMLElement>('.video-controls')!;
    const timeline = screen.getByRole<HTMLInputElement>('slider', {
      name: 'Позиция воспроизведения',
    });
    controls.focus();
    fireEvent.keyDown(controls, { key });
    expect(document.activeElement).toBe(timeline);
    expect(timeline.valueAsNumber).toBe(100 + step);

    await poll(); // libmpv can still report the old position with seeking=false.
    expect(timeline.valueAsNumber).toBe(100 + step);
    fireEvent.keyDown(timeline, { key, repeat: true });
    snapshot.position = 100 + step; // completion of the first seek arrives late
    await poll();
    expect(timeline.valueAsNumber).toBe(100 + 2 * step);
    fireEvent.keyDown(timeline, { key, repeat: true });
    snapshot.position = 100 + 2 * step;
    await poll();
    expect(requested).toEqual([100 + step, 100 + 2 * step, 100 + 3 * step]);
    expect(timeline.valueAsNumber).toBe(100 + 3 * step);

    snapshot.position = 100 + 3 * step;
    await poll();
    snapshot.position += 1;
    await poll();
    expect(timeline.valueAsNumber).toBe(101 + 3 * step);

    fireEvent.keyDown(timeline, { key });
    snapshot.seeking = true;
    await poll(1600);
    expect(timeline.valueAsNumber).toBe(101 + 4 * step);
    snapshot.seeking = false;
    await poll();
    expect(timeline.valueAsNumber).toBe(101 + 4 * step);
    await poll(1600);
    expect(timeline.valueAsNumber).toBe(101 + 3 * step);
  }
);

describe('unresponsive media sources', () => {
  it('renews an opted-in source on play after a long pause, without renewing during the pause', () => {
    const resume = vi.fn(() => true);
    const { container } = render(<Harness resume={resume} />);
    const media = container.querySelector('video')!;
    playing(media, 42);
    Object.defineProperty(media, 'paused', { value: true, configurable: true });
    fireEvent.pause(media);
    act(() => {
      vi.advanceTimersByTime(STREAM_RESUME_REFRESH_MS + 1);
    });
    expect(resume).not.toHaveBeenCalled();
    Object.defineProperty(media, 'paused', { value: false, configurable: true });
    fireEvent.play(media);
    expect(resume).toHaveBeenCalledOnce();
    expect(media.currentTime).toBe(42);
    fireEvent.play(media);
    expect(resume).toHaveBeenCalledOnce();
  });
  it('keeps short pauses on the existing source', () => {
    const resume = vi.fn(() => true);
    const { container } = render(<Harness resume={resume} />);
    const media = container.querySelector('video')!;
    playing(media, 42);
    Object.defineProperty(media, 'paused', { value: true, configurable: true });
    fireEvent.pause(media);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    Object.defineProperty(media, 'paused', { value: false, configurable: true });
    fireEvent.play(media);
    expect(resume).not.toHaveBeenCalled();
  });
  it('also renews when the initial paused player has been left open for a long time', () => {
    const resume = vi.fn(() => true);
    const { container } = render(<Harness resume={resume} />);
    const media = container.querySelector('video')!;
    act(() => {
      vi.advanceTimersByTime(STREAM_RESUME_REFRESH_MS + 1);
    });
    Object.defineProperty(media, 'paused', { value: false, configurable: true });
    fireEvent.play(media);
    expect(resume).toHaveBeenCalledOnce();
  });
  it('publishes immersive idle state and restores window controls when leaving playback', () => {
    const { container, unmount } = render(
      <div class="media-app is-playback">
        <Harness />
      </div>
    );
    const media = container.querySelector('video')!;

    playing(media, 10);
    act(() => {
      vi.advanceTimersByTime(CONTROLS_IDLE_MS + 1);
    });
    expect(document.documentElement.dataset.playerChrome).toBe('hidden');
    fireEvent.pointerMove(document.body);
    expect(document.documentElement.dataset.playerChrome).toBe('visible');
    act(() => {
      vi.advanceTimersByTime(CONTROLS_IDLE_MS + 1);
    });
    unmount();
    expect(document.documentElement.dataset.playerChrome).toBeUndefined();
  });
  it('delays the final alert and cancels it when frames recover during the grace period', () => {
    const { container } = render(<Harness />);
    const media = container.querySelector('video')!;

    Object.defineProperty(media, 'error', {
      value: { code: 2 },
      writable: true,
      configurable: true,
    });
    fireEvent.error(media);
    act(() => {
      vi.advanceTimersByTime(STREAM_ERROR_DELAY_MS - 1);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    Object.defineProperty(media, 'error', { value: null, configurable: true });
    playing(media, 10);
    act(() => {
      vi.advanceTimersByTime(STREAM_ERROR_DELAY_MS);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('keeps an alert hidden while another provider is being tried', () => {
    const failure = vi.fn().mockReturnValue(true);
    const { container } = render(<Harness failure={failure} />);
    const media = container.querySelector('video')!;

    Object.defineProperty(media, 'error', { value: { code: 2 }, configurable: true });
    fireEvent.error(media);
    advance();
    expect(failure).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('clears a failure overlay when decoded playback resumes', () => {
    const failure = vi.fn();
    const { container } = render(<Harness failure={failure} />);
    const media = container.querySelector('video')!;

    playing(media, 10);
    Object.defineProperty(media, 'error', {
      value: { code: 2 },
      writable: true,
      configurable: true,
    });
    fireEvent.error(media);
    act(() => {
      vi.advanceTimersByTime(STREAM_ERROR_DELAY_MS);
    });
    expect(screen.getByRole('alert')).toBeTruthy();
    Object.defineProperty(media, 'error', { value: null, configurable: true });
    media.currentTime = 11;
    fireEvent.playing(media);
    fireEvent.timeUpdate(media);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.querySelector('.video-controls')?.hasAttribute('inert')).toBe(false);
  });
  it.each(['yumiwatch:stream-error', 'error'])(
    'does not cover progressing video or discard its source after %s',
    event => {
      const failure = vi.fn();
      const { container } = render(<Harness failure={failure} />);
      const media = container.querySelector('video')!;

      playing(media, 10);
      fireEvent(media, new Event(event));
      expect(screen.queryByRole('alert')).toBeNull();
      expect(failure).not.toHaveBeenCalled();
      media.currentTime = 11;
      fireEvent.timeUpdate(media);
      advance();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(failure).not.toHaveBeenCalled();
    }
  );
  it('still fails a decoder error when buffered frames stop advancing', () => {
    const failure = vi.fn();
    const { container } = render(<Harness failure={failure} />);
    const media = container.querySelector('video')!;

    playing(media, 10);
    fireEvent(media, new Event('yumiwatch:stream-error'));
    advance();
    expect(failure).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert')).toBeTruthy();
  });
  it('fails a source that never delivers frames, only once', () => {
    const failure = vi.fn();
    const { container } = render(<Harness failure={failure} />);
    const loader = container.querySelector('.playback-loader');
    expect(loader?.getAttribute('role')).toBe('status');

    advance();
    expect(failure).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Повторить загрузку' })).toBeTruthy();
    expect(screen.getByRole('alert')).toBe(loader);
    expect(container.querySelectorAll('.playback-loader')).toHaveLength(1);
    expect(loader?.querySelector('.playback-spinner')).toBeNull();
    fireEvent.error(container.querySelector('video')!);
    advance();
    expect(failure).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.querySelector('.playback-loader')).toBe(loader);
    expect(loader?.getAttribute('role')).toBe('status');
    expect(loader?.querySelector('.playback-spinner')).toBeTruthy();
  });
  it('does not treat an offline device as a failed provider or fire after leaving', () => {
    const failure = vi.fn();
    const { unmount } = render(<Harness failure={failure} />);
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    advance();
    expect(failure).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    unmount();
    advance();
    expect(failure).not.toHaveBeenCalled();
  });
  it('times out a real playback stall but cancels the timeout on recovery or intentional pause', () => {
    const failure = vi.fn();
    const { container } = render(<Harness failure={failure} />);
    const media = container.querySelector('video')!;

    Object.defineProperty(media, 'readyState', { value: 4, writable: true, configurable: true });
    Object.defineProperty(media, 'paused', { value: false, writable: true, configurable: true });
    fireEvent.loadedMetadata(media);
    fireEvent.playing(media);
    advance();
    expect(failure).not.toHaveBeenCalled();
    Object.defineProperty(media, 'readyState', { value: 2, writable: true, configurable: true });
    fireEvent.waiting(media);
    fireEvent.playing(media);
    advance();
    expect(failure).not.toHaveBeenCalled();
    fireEvent.waiting(media);
    Object.defineProperty(media, 'paused', { value: true, writable: true, configurable: true });
    fireEvent.pause(media);
    advance();
    expect(failure).not.toHaveBeenCalled();
    Object.defineProperty(media, 'paused', { value: false, writable: true, configurable: true });
    fireEvent.playing(media);
    fireEvent.waiting(media);
    advance();
    expect(failure).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledWith(true);
  });
});

function playing(media: HTMLVideoElement, time: number, duration = 100) {
  Object.defineProperty(media, 'readyState', { value: 4, writable: true, configurable: true });
  Object.defineProperty(media, 'duration', { value: duration, writable: true, configurable: true });
  Object.defineProperty(media, 'paused', { value: false, writable: true, configurable: true });
  media.currentTime = time;
  fireEvent.loadedMetadata(media);
  fireEvent.playing(media);
  fireEvent.timeUpdate(media);
}

const countdown = () =>
  act(() => {
    vi.advanceTimersByTime(AUTO_ACTION_DELAY_MS);
  });

describe('completion and cancellable automatic actions', () => {
  it('finishes a credits skip without waiting for native ended, never buffers at the end, and starts the next timer when enabled later', () => {
    const next = vi.fn(),
      ended = vi.fn(),
      failure = vi.fn();
    const props = { failure, ended, next, skips: { ending: { time: 90, length: 10 } } };
    const { container, rerender } = render(<Harness {...props} />);
    const media = container.querySelector('video')!;

    playing(media, 95);
    fireEvent.click(screen.getByRole('button', { name: 'Пропустить титры' }));
    expect(media.currentTime).toBe(100);
    expect(ended).toHaveBeenCalledOnce();
    Object.defineProperty(media, 'readyState', { value: 0, writable: true, configurable: true });
    fireEvent.waiting(media);
    advance();
    expect(container.querySelector('.playback-loader')).toBeNull();
    expect(failure).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    rerender(<Harness {...props} autoNext />);
    expect(screen.getByRole('group', { name: 'Следующая серия' })).toBeTruthy();
    countdown();
    expect(next).toHaveBeenCalledOnce();
    fireEvent.ended(media);
    fireEvent.timeUpdate(media);
    countdown();
    expect(next).toHaveBeenCalledOnce();
    expect(ended).toHaveBeenCalledOnce();
  });
  it('cancels the automatic next episode and rearms after a rewind and a new completion', () => {
    const next = vi.fn();
    const { container } = render(<Harness autoNext next={next} />);
    const media = container.querySelector('video')!;

    playing(media, 100);
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    countdown();
    expect(next).not.toHaveBeenCalled();
    fireEvent.ended(media);
    expect(screen.queryByRole('group', { name: 'Следующая серия' })).toBeNull();
    media.currentTime = 50;
    fireEvent.seeking(media);
    fireEvent.seeked(media);
    media.currentTime = 100;
    fireEvent.timeUpdate(media);
    expect(screen.getByRole('group', { name: 'Следующая серия' })).toBeTruthy();
    countdown();
    expect(next).toHaveBeenCalledOnce();
  });
  it('counts three seconds of video for the opening skip instead of elapsed wall time', () => {
    const { container } = render(
      <Harness autoOpening skips={{ opening: { time: 10, length: 20 } }} />
    );
    const media = container.querySelector('video')!;

    playing(media, 15);
    countdown();
    expect(media.currentTime).toBe(15);
    expect(screen.getByRole('group', { name: 'Пропуск опенинга' }).textContent).toContain('3 с');
    media.currentTime = 17;
    fireEvent.timeUpdate(media);
    expect(media.currentTime).toBe(17);
    expect(screen.getByRole('group', { name: 'Пропуск опенинга' }).textContent).toContain('1 с');
    media.currentTime = 18;
    fireEvent.timeUpdate(media);
    expect(media.currentTime).toBe(30);
  });
  it('supports cancelling the opening countdown and keeps manual skipping instant', () => {
    const { container } = render(
      <Harness autoOpening skips={{ opening: { time: 10, length: 20 } }} />
    );
    const media = container.querySelector('video')!;

    playing(media, 15);
    media.currentTime = 17;
    fireEvent.timeUpdate(media);
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    countdown();
    media.currentTime = 20;
    fireEvent.timeUpdate(media);
    expect(media.currentTime).toBe(20);
    expect(screen.queryByRole('group', { name: 'Пропуск опенинга' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Пропустить опенинг' }));
    expect(media.currentTime).toBe(30);
    expect(document.activeElement).toBe(
      screen.getByRole('slider', { name: 'Позиция воспроизведения' })
    );
  });
  it('preserves elapsed video time through pause and buffering and restarts after seeking', () => {
    const { container } = render(
      <Harness autoOpening skips={{ opening: { time: 10, length: 20 } }} />
    );
    const media = container.querySelector('video')!;

    playing(media, 15);
    media.currentTime = 16;
    fireEvent.timeUpdate(media);
    Object.defineProperty(media, 'paused', { value: true, writable: true, configurable: true });
    fireEvent.pause(media);
    countdown();
    expect(media.currentTime).toBe(16);
    expect(screen.getByRole('group', { name: 'Пропуск опенинга' }).textContent).toContain('2 с');
    Object.defineProperty(media, 'paused', { value: false, writable: true, configurable: true });
    fireEvent.playing(media);
    fireEvent.waiting(media);
    countdown();
    expect(media.currentTime).toBe(16);
    expect(screen.getByRole('group', { name: 'Пропуск опенинга' }).textContent).toContain('2 с');
    fireEvent.playing(media);
    media.currentTime = 17;
    fireEvent.timeUpdate(media);
    expect(screen.getByRole('group', { name: 'Пропуск опенинга' }).textContent).toContain('1 с');

    media.currentTime = 22;
    fireEvent.seeking(media);
    fireEvent.seeked(media);
    expect(media.currentTime).toBe(22);
    expect(screen.getByRole('group', { name: 'Пропуск опенинга' }).textContent).toContain('3 с');
    media.currentTime = 25;
    fireEvent.timeUpdate(media);
    expect(media.currentTime).toBe(30);
  });
  it('preserves post-credit scenes and starts the next timer only at the real end', () => {
    const next = vi.fn();
    const { container } = render(
      <Harness autoEnding autoNext next={next} skips={{ ending: { time: 80, length: 10 } }} />
    );
    const media = container.querySelector('video')!;

    playing(media, 85);
    media.currentTime = 88;
    fireEvent.timeUpdate(media);
    expect(media.currentTime).toBe(90);
    expect(next).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Следующая серия' })).toBeNull();
    media.currentTime = 100;
    fireEvent.timeUpdate(media);
    countdown();
    expect(next).toHaveBeenCalledOnce();
  });
  it('does not schedule a nonexistent next episode and can recover readiness without a metadata event', () => {
    const failure = vi.fn();
    const { container } = render(<Harness autoNext failure={failure} />);
    const media = container.querySelector('video')!;

    playing(media, 42);
    Object.defineProperty(media, 'readyState', { value: 0, writable: true, configurable: true });
    fireEvent.emptied(media);
    expect(failure).not.toHaveBeenCalled();
    Object.defineProperty(media, 'readyState', { value: 4, writable: true, configurable: true });
    fireEvent.loadedData(media);
    advance();
    expect(container.querySelector('.playback-loader')).toBeNull();
    expect(failure).not.toHaveBeenCalled();
    expect(media.currentTime).toBe(42);
    media.currentTime = 100;
    fireEvent.timeUpdate(media);
    expect(screen.queryByRole('group', { name: 'Следующая серия' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Смотреть заново' }).length).toBeGreaterThan(0);
  });
});
