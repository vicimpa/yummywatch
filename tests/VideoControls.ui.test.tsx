// @vitest-environment jsdom
import { chooseOption } from './dropdown-actions';
import { useRef, useState } from 'preact/hooks';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterfaceEffects } from '~/components/InterfaceEffects';
import { CONTROLS_IDLE_MS, VideoControls } from '~/components/VideoControls';
import type { TvEpisodeControl } from '~/lib/tv-mode';
import { Dropdown } from '~/ui';

function Harness({
  failed = false,
  episodes = 1,
  revision = 0,
  manualSkip,
  chooseQuality = false,
}: {
  failed?: boolean;
  episodes?: number;
  revision?: number;
  manualSkip?: () => void;
  chooseQuality?: boolean;
}) {
  const media = useRef<HTMLVideoElement>(null),
    frame = useRef<HTMLDivElement>(null);
  const [episode, setEpisode] = useState(1);
  const tvEpisodeFocus = useRef<TvEpisodeControl>(null);

  return (
    <div ref={frame} data-testid="stage">
      <video ref={media} />
      <VideoControls
        key={`${episode}:${revision}`}
        media={media}
        frame={frame}
        title={`Серия ${episode}`}
        position={42}
        loading={false}
        failed={failed}
        previous={episode > 1 ? () => setEpisode(episode - 1) : undefined}
        next={episode < episodes ? () => setEpisode(episode + 1) : undefined}
        tvEpisodeFocus={tvEpisodeFocus}
        manualSkip={manualSkip ? { label: 'Пропустить опенинг', run: manualSkip } : undefined}
        quality={
          chooseQuality && (
            <Dropdown
              aria-label="Качество видео"
              data-nav-primary
              value="720"
              options={[{ value: '720', label: '720p' }]}
              onChange={() => {}}
            />
          )
        }
        settings={
          <label>
            Качество
            <Dropdown
              aria-label="Качество"
              value="720"
              options={[{ value: '720', label: '720p' }]}
              onChange={() => {}}
            />
          </label>
        }
        onVisibility={() => {}}
      />
    </div>
  );
}

function setup() {
  const result = render(<Harness />);
  const video = result.container.querySelector('video')!;

  Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
  Object.defineProperty(video, 'duration', { value: 1400, configurable: true });
  video.currentTime = 42;

  const playing = (paused: boolean) => {
    Object.defineProperty(video, 'paused', { value: paused, configurable: true });
    fireEvent(video, new Event(paused ? 'pause' : 'playing'));
    fireEvent(video, new Event(paused ? 'pause' : 'play'));
  };

  return {
    ...result,
    video,
    playing,
    controls: result.container.querySelector('.video-controls')!,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.removeItem('yumiwatch:playback-settings');
  delete document.documentElement.dataset.inputMode;
  delete document.documentElement.dataset.tv;
});

const idle = () =>
  act(() => {
    vi.advanceTimersByTime(CONTROLS_IDLE_MS + 1);
  });

describe('custom playback controls', () => {
  it('keeps the controls visible under the pointer and starts a new idle interval on the video', () => {
    const { controls, playing } = setup();
    playing(false);
    fireEvent.pointerMove(screen.getByRole('slider', { name: 'Позиция воспроизведения' }));
    idle();
    expect(controls.classList.contains('is-visible')).toBe(true);

    fireEvent.pointerMove(controls.querySelector('.video-hit-area')!);
    act(() => {
      vi.advanceTimersByTime(CONTROLS_IDLE_MS - 1);
    });
    expect(controls.classList.contains('is-visible')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(controls.classList.contains('is-hidden')).toBe(true);
  });

  it('loads thumbnails in order, displays only the current target, and reuses previous frames', async () => {
    const { controls, video, playing } = setup();
    playing(false);
    const image = new Blob(['jpeg'], { type: 'image/jpeg' });
    let finishFirst: (image: Blob) => void = () => {};
    const previewFrame = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Blob>(resolve => {
            finishFirst = resolve;
          })
      )
      .mockResolvedValueOnce(image)
      .mockResolvedValueOnce(undefined);
    Object.defineProperty(video, 'previewFrame', { value: previewFrame });
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = vi
          .fn()
          .mockReturnValueOnce('blob:first')
          .mockReturnValueOnce('blob:second');
        static revokeObjectURL = vi.fn();
      }
    );
    const timeline = controls.querySelector<HTMLElement>('.video-timeline')!;
    vi.spyOn(timeline, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      width: 200,
    } as DOMRect);
    const move = (clientX: number) =>
      fireEvent(timeline, new MouseEvent('pointermove', { bubbles: true, clientX }));
    const delay = () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
    const src = () => timeline.querySelector('img')?.getAttribute('src');
    const spinner = () => timeline.querySelector('.video-timeline-loading .playback-spinner');

    move(200);
    expect(timeline.querySelector('.video-timeline-time')?.textContent).toBe('11:40');
    expect(spinner()).not.toBeNull();
    await delay();
    expect(previewFrame).toHaveBeenCalledWith(700);

    move(250);
    await delay();
    expect(previewFrame).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishFirst(image);
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(previewFrame).toHaveBeenLastCalledWith(1050);
    expect(src()).toBe('blob:second');
    expect(spinner()).toBeNull();
    expect(video.currentTime).toBe(42);

    move(200);
    expect(src()).toBe('blob:first');
    await delay();
    expect(previewFrame).toHaveBeenCalledTimes(2);
    move(275);
    expect(spinner()).not.toBeNull();
    await delay();
    expect(src()).toBeUndefined();
    expect(spinner()).toBeNull();
    expect(timeline.querySelector('.video-timeline-time')?.textContent).toBe('20:25');
    fireEvent.pointerLeave(timeline);
    expect(timeline.querySelector('.video-timeline-preview')).toBeNull();
  });

  it('does not pin controls after a pointer click even when the browser reports focus-visible', () => {
    const { controls, playing } = setup();
    playing(false);
    const mute = screen.getByRole('button', { name: /[Вв]ыключить звук/ });
    vi.spyOn(mute, 'matches').mockReturnValue(true);
    fireEvent.pointerDown(mute);
    fireEvent.focusIn(mute);
    fireEvent.click(mute);
    idle();
    expect(controls.classList.contains('is-hidden')).toBe(true);
  });
  it('hides after keyboard inactivity and wakes again when the user returns to the pointer', () => {
    const { controls, playing } = setup();
    playing(false);
    fireEvent.keyDown(controls, { key: 'Tab' });
    idle();
    expect(controls.classList.contains('is-hidden')).toBe(true);
    fireEvent.pointerMove(controls);
    expect(controls.classList.contains('is-visible')).toBe(true);
    idle();
    expect(controls.classList.contains('is-hidden')).toBe(true);
  });
  it.each(['ArrowUp', 'ArrowDown'])(
    'auto-hides after %s even with focus and a stationary pointer on the controls',
    key => {
      const { controls, playing } = setup();
      playing(false);
      fireEvent.pointerMove(screen.getByRole('slider', { name: 'Позиция воспроизведения' }));
      document.documentElement.dataset.inputMode = 'keyboard';
      (controls as HTMLElement).focus();
      fireEvent.keyDown(controls, { key });
      const focused = document.activeElement;
      expect(controls.contains(focused)).toBe(true);
      expect(focused).not.toBe(controls);
      fireEvent.pointerOver(focused!);
      idle();
      expect(document.activeElement).toBe(controls);
      expect(controls.classList.contains('is-hidden')).toBe(true);
    }
  );
  it('keeps 2x selected during the decoder buffering and rate transitions', () => {
    const { video } = setup();

    fireEvent.click(screen.getByRole('button', { name: 'Настройки плеера' }));

    const speed = screen.getByRole('combobox', {
      name: 'Скорость воспроизведения',
    }) as HTMLButtonElement;

    chooseOption(speed, '2×');
    expect(video.playbackRate).toBe(2);
    expect(video.defaultPlaybackRate).toBe(2);
    for (const rate of [0, 1, 2]) {
      video.playbackRate = rate;
      fireEvent.rateChange(video);
      fireEvent.timeUpdate(video);
      expect(speed.value).toBe('2');
    }
    fireEvent.click(speed);
    fireEvent.keyDown(speed, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Настройки плеера' })).toBeTruthy();
    fireEvent.keyDown(speed, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Настройки плеера' })).toBeNull();
  });

  it('waits for a single mouse click and cancels pending clicks when the player unmounts', () => {
    const { playing, unmount } = setup();

    playing(false);

    const surface = document.querySelector('.video-hit-area')!;

    fireEvent.click(surface, { detail: 1 });
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce();
    fireEvent.click(surface, { detail: 1 });
    unmount();
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce();
  });
  it('preserves playback even when a slower double click outlasts the single-click delay', async () => {
    const { video, playing } = setup();

    playing(false);

    const request = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(screen.getByTestId('stage'), 'requestFullscreen', {
      value: request,
      configurable: true,
    });
    vi.mocked(HTMLMediaElement.prototype.pause).mockImplementation(() => {
      playing(true);
    });
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(async () => {
      playing(false);
    });

    const surface = document.querySelector('.video-hit-area')!;

    fireEvent.click(surface, { detail: 1 });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(video.paused).toBe(true);
    await act(async () => {
      fireEvent.click(surface, { detail: 2 });
      fireEvent.dblClick(surface);
    });
    expect(video.paused).toBe(false);
    expect(request).toHaveBeenCalledOnce();
  });
  it('wakes the player when the mouse moves over the window chrome', () => {
    const { controls, playing } = setup();

    playing(false);
    idle();
    expect(controls.classList.contains('is-hidden')).toBe(true);

    const chrome = document.createElement('div');

    chrome.className = 'window-chrome';
    document.body.append(chrome);
    fireEvent.pointerMove(chrome);
    expect(controls.classList.contains('is-visible')).toBe(true);
    chrome.remove();
  });
  it('removes stale buffering when decoded time advances without another playing event', () => {
    const { video, playing } = setup();

    playing(false);
    Object.defineProperty(video, 'readyState', { value: 2, configurable: true });
    fireEvent.waiting(video);
    expect(screen.getByText('Буферизация…')).toBeTruthy();
    fireEvent.timeUpdate(video);
    video.currentTime = 43;
    fireEvent.timeUpdate(video);
    expect(screen.queryByText('Буферизация…')).toBeNull();
  });
  it('hides after inactivity, resets on movement, and keeps controls on pause or buffering', () => {
    const { controls, video, playing } = setup();

    playing(false);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    fireEvent.pointerMove(controls);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(controls.classList.contains('is-visible')).toBe(true);
    idle();
    expect(controls.classList.contains('is-hidden')).toBe(true);
    fireEvent.pointerMove(controls);
    expect(controls.classList.contains('is-visible')).toBe(true);
    playing(true);
    idle();
    expect(controls.classList.contains('is-visible')).toBe(true);
    playing(false);
    Object.defineProperty(video, 'readyState', { value: 2, configurable: true });
    fireEvent.waiting(video);
    idle();
    expect(controls.classList.contains('is-visible')).toBe(true);
    fireEvent.playing(video);
    idle();
    expect(controls.classList.contains('is-hidden')).toBe(true);
  });
  it('shows controls on the first tap without pausing playback', () => {
    const { controls, playing } = setup();

    playing(false);
    idle();

    const surface = screen.getByRole('button', { name: 'Показать управление' });

    fireEvent.pointerDown(surface);
    fireEvent.click(surface);
    expect(controls.classList.contains('is-visible')).toBe(true);
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Приостановить видео' }));
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce();
  });
  it('keeps open settings visible and resumes auto-hide after closing them', () => {
    const { controls, playing } = setup();

    playing(false);
    fireEvent.click(screen.getByRole('button', { name: 'Настройки плеера' }));
    idle();
    expect(screen.getByRole('dialog', { name: 'Настройки плеера' })).toBeTruthy();
    expect(controls.classList.contains('is-visible')).toBe(true);
    fireEvent.keyDown(controls, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.pointerMove(controls);
    idle();
    expect(controls.classList.contains('is-hidden')).toBe(true);
  });
  it('dismisses settings on outside clicks and consumes clicks on the player', () => {
    const { playing } = setup();

    playing(false);
    fireEvent.click(screen.getByRole('button', { name: 'Настройки плеера' }));

    const surface = screen.getByRole('button', { name: 'Приостановить видео' });

    expect(fireEvent.click(surface)).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Настройки плеера' }));
    fireEvent.click(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('shows buffering only when playback actually lacks frames, including while offline', () => {
    const { video, playing } = setup();

    playing(false);
    fireEvent.stalled(video);
    expect(screen.queryByText('Буферизация…')).toBeNull();
    window.dispatchEvent(new Event('offline'));
    expect(screen.queryByText('Соединение потеряно')).toBeNull();
    Object.defineProperty(video, 'readyState', { value: 2, configurable: true });
    fireEvent.waiting(video);
    expect(screen.getByText('Соединение потеряно')).toBeTruthy();
    expect(document.querySelector('.playback-spinner')).toBeTruthy();
    Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
    fireEvent.timeUpdate(video);
    expect(screen.queryByText('Соединение потеряно')).toBeNull();
    Object.defineProperty(video, 'readyState', { value: 2, configurable: true });
    fireEvent.waiting(video);
    playing(true);
    expect(screen.queryByText('Соединение потеряно')).toBeNull();
    window.dispatchEvent(new Event('online'));
  });
  it('fullscreens the container with its interface and exits on the next click', async () => {
    setup();

    const stage = screen.getByTestId('stage');
    const request = vi.fn().mockImplementation(async () => {
      Object.defineProperty(document, 'fullscreenElement', { value: stage, configurable: true });
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    const exit = vi.fn().mockImplementation(async () => {
      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    Object.defineProperty(stage, 'requestFullscreen', { value: request, configurable: true });
    Object.defineProperty(document, 'exitFullscreen', { value: exit, configurable: true });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Полный экран' }));
    });
    expect(request).toHaveBeenCalledOnce();
    expect(
      document.fullscreenElement?.contains(screen.getByRole('button', { name: 'Настройки плеера' }))
    ).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Выйти из полного экрана' }));
    });
    expect(exit).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    'uses Enter and arrows consistently at the player surface (TV: %s)',
    tv => {
      document.documentElement.dataset.inputMode = 'keyboard';
      if (tv) document.documentElement.dataset.tv = 'true';
      const { controls, video, playing } = setup();
      playing(false);
      (controls as HTMLElement).focus();
      idle();
      fireEvent.keyDown(controls, { key: 'Enter' });
      expect(video.pause).toHaveBeenCalledOnce();
      expect(controls.classList.contains('is-hidden')).toBe(true);
      fireEvent.keyDown(controls, { key: 'ArrowRight' });
      expect(video.currentTime).toBe(52);

      const timeline = screen.getByRole('slider', { name: 'Позиция воспроизведения' });
      expect(document.activeElement).toBe(timeline);
      fireEvent.keyDown(timeline, { key: 'ArrowDown' });

      const pause = screen.getByRole('button', { name: 'Пауза' });
      expect(document.activeElement).toBe(pause);
      expect(controls.classList.contains('is-visible')).toBe(true);
      fireEvent.keyDown(pause, { key: 'ArrowUp' });
      expect(document.activeElement).toBe(timeline);
      fireEvent.keyDown(timeline, { key: 'ArrowRight' });
      expect(video.currentTime).toBe(62);

      idle();
      expect(document.activeElement).toBe(controls);
      expect(controls.classList.contains('is-hidden')).toBe(true);

      fireEvent.keyDown(controls, { key: 'ArrowLeft' });
      expect(video.currentTime).toBe(52);
      expect(document.activeElement).toBe(timeline);

      (controls as HTMLElement).focus();
      fireEvent.keyDown(controls, { key: 'ArrowLeft' });
      expect(video.currentTime).toBe(42);
      expect(document.activeElement).toBe(timeline);
    }
  );
  it('seeks from the live media position on TV even before the timeline catches up', () => {
    document.documentElement.dataset.tv = 'true';
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
    const { container } = render(
      <>
        <InterfaceEffects onBack={() => {}} />
        <main id="main">
          <Harness />
        </main>
      </>
    );
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
    Object.defineProperty(video, 'duration', { value: 1400, configurable: true });
    video.currentTime = 150;
    fireEvent.loadedMetadata(video);

    const player = container.querySelector<HTMLElement>('.video-controls')!;
    player.focus();
    fireEvent.keyDown(player, { key: 'ArrowUp' });
    const timeline = screen.getByRole<HTMLInputElement>('slider', {
      name: 'Позиция воспроизведения',
    });
    expect(document.activeElement).toBe(timeline);
    expect(timeline.value).toBe('42');

    fireEvent.keyDown(timeline, { key: 'ArrowLeft' });
    expect(video.currentTime).toBe(140);
    fireEvent.keyDown(timeline, { key: 'Enter' });
    fireEvent.keyUp(timeline, { key: 'Enter' });
    expect(timeline.hasAttribute('data-tv-adjusting')).toBe(false);
    fireEvent.keyDown(timeline, { key: 'ArrowLeft' });
    expect(video.currentTime).toBe(130);
    fireEvent.keyDown(timeline, { key: 'ArrowRight' });
    expect(video.currentTime).toBe(140);
  });
  it.each(['Escape', 'BrowserBack'])('uses %s to go back from an open player toolbar', key => {
    document.documentElement.dataset.tv = 'true';
    const originalURL = location.href;
    history.replaceState(null, '', '#/anime/1?view=watch');
    const back = vi.fn();
    try {
      const { container } = render(
        <>
          <InterfaceEffects onBack={back} />
          <main id="main">
            <Harness />
          </main>
        </>
      );
      const player = container.querySelector<HTMLElement>('.video-controls')!;
      player.focus();
      fireEvent.keyDown(player, { key: 'ArrowDown' });
      expect(player.classList.contains('is-visible')).toBe(true);

      fireEvent.keyDown(document.activeElement!, { key });
      expect(back).toHaveBeenCalledOnce();
      expect(player.classList.contains('is-visible')).toBe(true);
    } finally {
      history.replaceState(null, '', originalURL);
    }
  });
  it('lets the TV remote focus and activate a visible skip button', () => {
    document.documentElement.dataset.tv = 'true';
    const skip = vi.fn();
    const { container } = render(<Harness manualSkip={skip} />);
    const player = container.querySelector<HTMLElement>('.video-controls')!;
    player.focus();
    fireEvent.keyDown(player, { key: 'ArrowUp' });
    const button = screen.getByRole('button', { name: 'Пропустить опенинг' });
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(skip).toHaveBeenCalledOnce();
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Воспроизвести' }));
  });
  it('opens TV player settings on quality and navigates between quality and speed', async () => {
    document.documentElement.dataset.tv = 'true';
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
    const view = render(
      <>
        <InterfaceEffects onBack={() => {}} />
        <main id="main">
          <Harness chooseQuality />
        </main>
      </>
    );
    const player = view.container.querySelector<HTMLElement>('.video-controls')!;
    player.focus();
    fireEvent.keyDown(player, { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('button', { name: 'Настройки плеера' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
    });
    const quality = screen.getByRole('combobox', { name: 'Качество видео' });
    expect(document.activeElement).toBe(quality);
    expect(quality.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(quality, { key: 'ArrowDown' });
    const speed = screen.getByRole('combobox', { name: 'Скорость воспроизведения' });
    expect(document.activeElement).toBe(speed);
    fireEvent.keyDown(speed, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(quality);
  });
  it('focuses the timeline for hardware rewind and forward while keeping pause in place', () => {
    document.documentElement.dataset.tv = 'true';
    const { controls, video, playing } = setup();
    playing(false);
    (controls as HTMLElement).focus();
    const dispatch = (detail: string) =>
      fireEvent(window, new CustomEvent('yumiwatch:tv-media', { detail }));
    dispatch('pause');
    expect(video.pause).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(controls);

    dispatch('rewind');
    const timeline = screen.getByRole('slider', { name: 'Позиция воспроизведения' });
    expect(video.currentTime).toBe(32);
    expect(document.activeElement).toBe(timeline);

    fireEvent.keyDown(timeline, { key: 'ArrowDown' });
    expect(document.activeElement).not.toBe(timeline);
    dispatch('forward');
    expect(video.currentTime).toBe(42);
    expect(document.activeElement).toBe(timeline);
  });
  it('lets the remote leave an unavailable episode with the hardware episode keys', () => {
    document.documentElement.dataset.tv = 'true';
    render(<Harness episodes={2} failed />);
    const dispatch = (detail: string) =>
      fireEvent(window, new CustomEvent('yumiwatch:tv-media', { detail }));
    dispatch('next');
    expect(screen.getByText('Серия 2')).toBeTruthy();
    dispatch('previous');
    expect(screen.getByText('Серия 1')).toBeTruthy();
  });
  it.each([2, 3])(
    'keeps right navigation on the toolbar after the episode remounts (%s episodes)',
    episodes => {
      document.documentElement.dataset.tv = 'true';
      vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({
        length: 1,
      } as DOMRectList);
      const { container, rerender } = render(<Harness episodes={episodes} />);
      const video = container.querySelector('video')!;
      Object.defineProperty(video, 'duration', { value: 1400, configurable: true });
      const player = container.querySelector<HTMLElement>('.video-controls')!;
      player.focus();
      fireEvent.keyDown(player, { key: 'ArrowDown' });
      const next = screen.getByRole('button', { name: 'Следующая серия' });
      next.focus();
      fireEvent.click(next);

      expect(container.querySelector('.video-controls')).not.toBe(player);
      expect(screen.getByText('Серия 2')).toBeTruthy();
      rerender(<Harness episodes={episodes} revision={1} />);
      const mute = screen.getByRole('button', { name: /звук/ });
      const volume = screen.getByRole('slider', { name: 'Громкость' });
      expect(document.activeElement).toBe(
        episodes === 2 ? mute : screen.getByRole('button', { name: 'Следующая серия' })
      );
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
      expect(document.activeElement).toBe(episodes === 2 ? volume : mute);
      expect(video.currentTime).toBe(0);
      Object.defineProperty(video, 'paused', { value: false });
      Object.defineProperty(video, 'readyState', { value: 4 });
      const newPlayer = container.querySelector('.video-controls')!;
      expect(container.querySelector('video')).toBe(video);
      fireEvent.playing(video);
      idle();
      expect(newPlayer.classList.contains('is-hidden')).toBe(true);
      rerender(<Harness episodes={episodes} revision={2} />);
      expect(container.querySelector('.video-controls')?.classList.contains('is-hidden')).toBe(
        true
      );
    }
  );
  it('closes settings and disables controls behind a media error', () => {
    const { container, rerender } = render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Настройки плеера' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    const media = container.querySelector('video')!;

    media.currentTime = 42;
    rerender(<Harness failed />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.querySelector('.video-controls')?.hasAttribute('inert')).toBe(true);
    fireEvent.keyDown(document.body, { key: 'l' });
    expect(media.currentTime).toBe(42);
  });
  it('handles global shortcuts without seeking while editing settings', () => {
    const { video } = setup();
    fireEvent.loadedMetadata(video);
    const timeline = screen.getByRole('slider', { name: 'Позиция воспроизведения' });

    fireEvent.keyDown(document.body, { key: 'д', code: 'KeyL' });
    expect(video.currentTime).toBe(52);
    expect(document.activeElement).toBe(timeline);
    fireEvent.keyDown(timeline, { key: 'j' });
    expect(video.currentTime).toBe(42);
    fireEvent.keyDown(timeline, { key: 'm' });
    expect(video.muted).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Настройки плеера' }));
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Качество' }), { key: 'l' });
    expect(video.currentTime).toBe(42);
  });
  it('focuses the timeline when the user changes the range with the pointer', () => {
    const { video } = setup();
    fireEvent.loadedMetadata(video);
    const timeline = screen.getByRole('slider', { name: 'Позиция воспроизведения' });
    screen.getByRole('button', { name: 'Настройки плеера' }).focus();
    fireEvent.input(timeline, { target: { value: '100' } });
    expect(video.currentTime).toBe(100);
    expect(document.activeElement).toBe(timeline);
  });
});
