// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import {
  apiFetch,
  desktopInvoke,
  exitDesktopFullscreen,
  exitPlayerFullscreen,
  initializeDesktop,
  isDesktopWindow,
  syncDesktopFullscreen,
  toggleDesktopFullscreen,
} from '~/lib/desktop';
import { resolveStream } from '~/lib/streams';
import { WindowChrome } from '~/components/WindowChrome';
import { video } from './fixtures';
import { setPlayerChrome, resetPlayerChrome } from '~/lib/player-chrome';
import { InterfaceEffects } from '~/components/InterfaceEffects';
import { VideoControls } from '~/components/VideoControls';
import { useRef } from 'preact/hooks';

function DesktopPlayer() {
  const media = useRef<HTMLVideoElement>(null),
    frame = useRef<HTMLDivElement>(null);

  return (
    <div ref={frame}>
      <video ref={media} />
      <VideoControls
        media={media}
        frame={frame}
        title="Тест"
        position={0}
        loading={false}
        failed={false}
        settings={null}
        onVisibility={() => {}}
      />
    </div>
  );
}

const native = vi.hoisted(() => ({
  enabled: true,
  invoke: vi.fn(),
  convertFileSrc: vi.fn(),
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  startDragging: vi.fn(),
  isMaximized: vi.fn(),
  isFullscreen: vi.fn(),
  setFullscreen: vi.fn(),
  setFocus: vi.fn(),
  setWebviewFocus: vi.fn(),
  onResized: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => native.enabled,
  invoke: native.invoke,
  convertFileSrc: native.convertFileSrc,
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => native }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ setFocus: native.setWebviewFocus }),
}));

beforeEach(() => {
  native.enabled = true;
  localStorage.clear();
  native.invoke.mockReset();
  native.convertFileSrc.mockReturnValue('yumiwatch-media://localhost/');
  for (const action of [
    native.minimize,
    native.toggleMaximize,
    native.close,
    native.startDragging,
    native.setFullscreen,
    native.setFocus,
    native.setWebviewFocus,
  ])
    action.mockReset().mockResolvedValue(undefined);
  native.isMaximized.mockReset().mockResolvedValue(false);
  native.isFullscreen.mockReset().mockResolvedValue(false);
  native.onResized.mockReset().mockResolvedValue(vi.fn());
  document.documentElement.dataset.desktop = 'windows';
  delete document.documentElement.dataset.desktopFullscreen;
  delete document.documentElement.dataset.desktopFullscreenChanging;
  delete document.documentElement.dataset.playerChrome;
  delete document.documentElement.dataset.mobile;
});
afterEach(() => {
  cleanup();
  resetPlayerChrome();
  vi.unstubAllGlobals();
});

describe('desktop IPC and application chrome', () => {
  it('does not wait for resize or animation notifications to release fullscreen controls', async () => {
    document.documentElement.dataset.desktop = 'macos';
    native.isFullscreen.mockResolvedValue(true);
    await toggleDesktopFullscreen();
    expect(native.setFullscreen).toHaveBeenCalledExactlyOnceWith(false);
    expect(document.documentElement.dataset.desktopFullscreenChanging).toBeUndefined();
    expect(document.documentElement.dataset.desktopFullscreen).toBe('false');
    expect(native.setWebviewFocus).toHaveBeenCalledOnce();
    expect(native.onResized).not.toHaveBeenCalled();
    await toggleDesktopFullscreen();
    expect(native.setFullscreen).toHaveBeenCalledTimes(2);
  });

  it('uses AppKit fullscreen events without querying window state on every macOS resize', async () => {
    const { dataset } = document.documentElement;
    dataset.desktop = 'macos';
    const { container } = render(<WindowChrome />);
    await waitFor(() => expect(dataset.desktopFullscreen).toBe('false'));
    expect(native.isMaximized).not.toHaveBeenCalled();
    expect(native.onResized).not.toHaveBeenCalled();

    for (let step = 0; step < 12; step++) window.dispatchEvent(new Event('resize'));
    expect(native.isFullscreen).toHaveBeenCalledOnce();

    native.isFullscreen.mockResolvedValue(true);
    window.dispatchEvent(new Event('yumiwatch:native-fullscreen'));
    await waitFor(() => expect(dataset.desktopFullscreen).toBe('true'));
    expect(container.querySelector('.window-chrome')).toBeNull();

    native.isFullscreen.mockResolvedValue(false);
    window.dispatchEvent(new Event('yumiwatch:native-fullscreen'));
    await waitFor(() => expect(dataset.desktopFullscreen).toBe('false'));
    expect(container.querySelector('.window-chrome')).not.toBeNull();
  });
  it('does not let an old resize query overwrite the most recent native fullscreen state', async () => {
    let old!: (value: boolean) => void, resized!: () => void;

    native.isFullscreen
      .mockImplementationOnce(
        () =>
          new Promise<boolean>(resolve => {
            old = resolve;
          })
      )
      .mockResolvedValue(false);
    native.onResized.mockImplementation(callback => {
      resized = callback;

      return Promise.resolve(vi.fn());
    });
    render(<WindowChrome />);
    await act(async () => {});
    await act(async () => {
      resized();
    });
    await waitFor(() => expect(document.documentElement.dataset.desktopFullscreen).toBe('false'));
    await act(async () => {
      old(true);
    });
    expect(document.documentElement.dataset.desktopFullscreen).toBe('false');
    expect(screen.getByRole('button', { name: 'Закрыть окно' })).toBeTruthy();
  });
  it('does not broadcast a fullscreen change for every resize with the same state', () => {
    const changed = vi.fn();

    window.addEventListener('yumiwatch:fullscreen', changed);
    try {
      syncDesktopFullscreen(true);
      syncDesktopFullscreen(true);
      syncDesktopFullscreen(true);
      expect(changed).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener('yumiwatch:fullscreen', changed);
    }
  });
  it('preserves native Mac fullscreen animation and restores keyboard focus before another F', async () => {
    native.setFullscreen.mockImplementation(async value => {
      native.isFullscreen.mockResolvedValue(value);
    });
    document.documentElement.dataset.desktop = 'macos';

    const { container } = render(
      <>
        <WindowChrome />
        <DesktopPlayer />
      </>
    );
    const media = container.querySelector('video'),
      settings = screen.getByRole('button', { name: 'Настройки плеера' });

    settings.focus();
    await act(async () => {
      await toggleDesktopFullscreen();
    });
    expect(native.setFullscreen).toHaveBeenLastCalledWith(true);
    expect(await native.isFullscreen()).toBe(true);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'f', code: 'KeyF' });
    });
    await waitFor(() => expect(native.setFocus).toHaveBeenCalledTimes(2));
    expect(native.setFullscreen).toHaveBeenLastCalledWith(false);
    expect(native.setFocus).toHaveBeenCalledTimes(2);
    expect(native.setWebviewFocus).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(settings);
    expect(container.querySelector('video')).toBe(media);
    expect(await native.isFullscreen()).toBe(false);
    // A subsequent F works immediately; no pointer gesture is needed.
    await act(async () => {
      fireEvent.keyDown(window, { key: 'f', code: 'KeyF' });
    });
    await waitFor(() => expect(native.setFullscreen).toHaveBeenLastCalledWith(true));
    await waitFor(() => expect(native.setFocus).toHaveBeenCalledTimes(3));
    expect(native.setFullscreen).toHaveBeenCalledTimes(3);
  });
  it('restores keyboard focus to the player instead of the full-size hit area', async () => {
    document.documentElement.dataset.desktop = 'macos';
    native.isFullscreen.mockResolvedValue(true);
    const { container } = render(
      <main id="main" tabIndex={-1}>
        <DesktopPlayer />
      </main>
    );
    const hitArea = container.querySelector<HTMLButtonElement>('.video-hit-area')!;
    hitArea.focus();
    expect(document.activeElement).toBe(hitArea);

    await act(async () => {
      await exitDesktopFullscreen();
    });
    expect(document.activeElement).toBe(container.querySelector('.video-controls'));
  });
  it.each(['android', 'ios'])(
    'keeps native IPC on %s without calling desktop window APIs',
    async platform => {
      native.invoke.mockResolvedValue({ platform });
      await initializeDesktop();
      expect(document.documentElement.dataset.mobile).toBe(platform);
      expect(document.documentElement.dataset.desktop).toBeUndefined();
      expect(isDesktopWindow()).toBe(false);
      render(
        <>
          <WindowChrome />
          <DesktopPlayer />
        </>
      );
      expect(screen.queryByRole('button', { name: 'Полный экран' })).toBeNull();
      await toggleDesktopFullscreen();
      expect(native.onResized).not.toHaveBeenCalled();
      expect(native.setFullscreen).not.toHaveBeenCalled();
      native.invoke.mockResolvedValue({ status: 200, body: '{}' });
      await apiFetch('https://api.yani.tv/anime', {});
      expect(native.invoke).toHaveBeenLastCalledWith('yummy_request', expect.any(Object));
    }
  );
  it.each(['macos', 'windows', 'linux'])(
    'toggles app fullscreen globally on %s, including the Russian keyboard layout',
    async platform => {
      document.documentElement.dataset.desktop = platform;
      native.setFullscreen.mockImplementation(async value => {
        native.isFullscreen.mockResolvedValue(value);
      });
      render(<WindowChrome />);
      await act(async () => {
        fireEvent.keyDown(window, { key: 'f', code: 'KeyF' });
      });
      expect(native.setFullscreen).toHaveBeenCalledExactlyOnceWith(true);
      await waitFor(() => expect(document.documentElement.dataset.desktopFullscreen).toBe('true'));
      await waitFor(() => expect(document.querySelector('.window-chrome')).toBeNull());
      await act(async () => {
        fireEvent.keyDown(window, { key: 'а', code: 'KeyF' });
      });
      await waitFor(() => expect(native.setFullscreen).toHaveBeenLastCalledWith(false));
      await waitFor(() => expect(document.documentElement.dataset.desktopFullscreen).toBe('false'));
    }
  );
  it('closes player settings, then exits fullscreen, then goes back on separate Escape presses', async () => {
    native.isFullscreen.mockResolvedValue(true);
    let finishExit!: () => void;
    native.setFullscreen.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finishExit = () => {
            native.isFullscreen.mockResolvedValue(false);
            resolve();
          };
        })
    );

    const back = vi.fn();

    render(
      <>
        <WindowChrome />
        <InterfaceEffects onBack={back} />
        <DesktopPlayer />
      </>
    );
    await waitFor(() => expect(document.documentElement.dataset.desktopFullscreen).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'Настройки плеера' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Настройки плеера' })).toBeNull();
    expect(back).not.toHaveBeenCalled();
    expect(native.setFullscreen).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.desktopFullscreen).toBe('true');

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(native.setFullscreen).toHaveBeenCalledExactlyOnceWith(false));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(back).not.toHaveBeenCalled();
    await act(async () => finishExit());
    expect(document.documentElement.dataset.desktopFullscreen).toBe('false');

    fireEvent.keyDown(window, { key: 'Escape', repeat: true });
    expect(back).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(back).toHaveBeenCalledOnce();
    expect(native.setFullscreen).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('uses the same toggle for the global key and player button without toggling twice', async () => {
    native.setFullscreen.mockImplementation(async value => {
      native.isFullscreen.mockResolvedValue(value);
    });
    render(
      <>
        <WindowChrome />
        <DesktopPlayer />
      </>
    );
    await act(async () => {
      fireEvent.keyDown(window, { key: 'f', code: 'KeyF' });
    });
    expect(native.setFullscreen).toHaveBeenCalledExactlyOnceWith(true);

    const exit = await screen.findByRole('button', {
      name: 'Выйти из полного экрана',
    });

    await act(async () => {
      fireEvent.click(exit);
    });
    await waitFor(() => expect(native.setFullscreen).toHaveBeenCalledTimes(2));
    expect(native.setFullscreen).toHaveBeenLastCalledWith(false);
  });
  it('toggles app fullscreen on video double click without changing playback or reacting to toolbar double clicks', async () => {
    native.setFullscreen.mockImplementation(async value => {
      native.isFullscreen.mockResolvedValue(value);
    });

    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const { container } = render(
      <>
        <WindowChrome />
        <DesktopPlayer />
      </>
    );
    const surface = container.querySelector('.video-hit-area')!;

    fireEvent.click(surface, { detail: 1 });
    fireEvent.click(surface, { detail: 2 });
    fireEvent.dblClick(surface);
    await screen.findByRole('button', { name: 'Выйти из полного экрана' });
    expect(native.setFullscreen).toHaveBeenCalledExactlyOnceWith(true);
    expect(pause).not.toHaveBeenCalled();
    fireEvent.dblClick(screen.getByRole('button', { name: 'Настройки плеера' }));
    expect(native.setFullscreen).toHaveBeenCalledTimes(1);
    fireEvent.dblClick(surface);
    await waitFor(() => expect(native.setFullscreen).toHaveBeenLastCalledWith(false));
    pause.mockRestore();
  });
  it('ignores editing, composition, modifiers and key repeat for the global shortcut', async () => {
    render(
      <>
        <WindowChrome />
        <input />
        <textarea />
        <select />
        <div contentEditable />
        <div role="textbox" />
      </>
    );
    for (const target of document.querySelectorAll(
      'input,textarea,select,[contenteditable],[role=textbox]'
    ))
      fireEvent.keyDown(target, { key: 'f', code: 'KeyF' });
    for (const options of [
      { repeat: true },
      { isComposing: true },
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
    ])
      fireEvent.keyDown(window, { key: 'f', code: 'KeyF', ...options });
    await act(async () => {});
    expect(native.setFullscreen).not.toHaveBeenCalled();
  });
  it('coalesces simultaneous fullscreen requests while the native window is changing', async () => {
    let finish!: () => void;

    native.setFullscreen.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    );

    const first = toggleDesktopFullscreen(),
      second = toggleDesktopFullscreen();

    expect(first).toBe(second);
    await Promise.resolve();
    expect(native.setFullscreen).toHaveBeenCalledExactlyOnceWith(true);
    finish();
    await first;
  });
  it('keeps app fullscreen when leaving playback, but exits browser player fullscreen', async () => {
    const exit = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(document, 'fullscreenElement', {
      value: document.body,
      configurable: true,
    });
    Object.defineProperty(document, 'exitFullscreen', {
      value: exit,
      configurable: true,
    });
    try {
      document.documentElement.dataset.desktopFullscreen = 'true';
      await exitPlayerFullscreen();
      expect(exit).not.toHaveBeenCalled();
      expect(native.setFullscreen).not.toHaveBeenCalled();
      native.enabled = false;
      await exitPlayerFullscreen();
      expect(exit).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(document, 'fullscreenElement', {
        value: null,
        configurable: true,
      });
    }
  });
  it('hides Windows controls with the player without removing the chrome layout', () => {
    const { container } = render(<WindowChrome />);
    const chrome = container.querySelector('.window-chrome')!;

    act(() => setPlayerChrome(false));
    expect(chrome.classList.contains('is-hidden')).toBe(true);
    expect(chrome.hasAttribute('inert')).toBe(true);
    expect(screen.queryByRole('group', { name: 'Управление окном' })).toBeNull();
    act(() => setPlayerChrome(true));
    expect(container.querySelector('.window-chrome')).toBe(chrome);
    expect(screen.getByRole('button', { name: 'Закрыть окно' })).toBeTruthy();
  });
  it('synchronizes native macOS traffic lights and restores them when the chrome unmounts', async () => {
    document.documentElement.dataset.desktop = 'macos';
    native.invoke.mockResolvedValue(undefined);

    const { unmount } = render(<WindowChrome />);

    act(() => setPlayerChrome(false));
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith('set_window_controls_visible', { visible: false })
    );
    act(() => setPlayerChrome(true));
    await waitFor(() =>
      expect(native.invoke).toHaveBeenLastCalledWith('set_window_controls_visible', {
        visible: true,
      })
    );
    act(() => setPlayerChrome(false));
    unmount();
    expect(native.invoke).toHaveBeenLastCalledWith('set_window_controls_visible', {
      visible: true,
    });
  });
  it('uses native API requests with authentication and preserves HTTP errors', async () => {
    native.invoke.mockResolvedValue({
      status: 401,
      body: '{"error":"expired"}',
    });

    const fetcher = vi.fn();

    vi.stubGlobal('fetch', fetcher);

    const response = await apiFetch('https://api.yani.tv/profile?limit=1', {
      method: 'GET',
      headers: { Authorization: 'Yummy token', Lang: 'ru' },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'expired' });
    expect(native.invoke).toHaveBeenCalledWith('yummy_request', {
      request: {
        origin: 'https://api.yani.tv',
        path: '/profile?limit=1',
        method: 'GET',
        headers: { authorization: 'Yummy token', lang: 'ru' },
        body: null,
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(apiFetch('https://evil.example/profile', {})).rejects.toThrow('адрес API');
  });

  it('cancels waiting for an IPC result and ignores late responses', async () => {
    native.invoke.mockReturnValue(new Promise(() => {}));

    const controller = new AbortController();
    const request = desktopInvoke('resolve_candidates', {}, controller.signal);

    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('preserves Rust error messages instead of leaving the player on an empty error state', async () => {
    native.invoke.mockRejectedValue('Источник вернул HTTP 403.');
    await expect(desktopInvoke('resolve_candidates', {})).rejects.toThrow(
      'Источник вернул HTTP 403.'
    );
  });

  it.each(['yumiwatch-media://localhost/', 'http://yumiwatch-media.localhost/'])(
    'resolves media over IPC into the private protocol %s without HTTP',
    async root => {
      native.convertFileSrc.mockReturnValue(root);

      const path = `alloha/${'a'.repeat(32)}/${'b'.repeat(32)}`;

      native.invoke.mockResolvedValue({
        provider: 'Alloha',
        relay: true,
        videoId: 1,
        streams: [{ quality: 360, type: 'hls', url: path }],
        caption: { url: path, label: 'Russian', language: 'ru' },
      });

      const fetcher = vi.fn();

      vi.stubGlobal('fetch', fetcher);

      const result = await resolveStream(
        [{ ...video('1'), iframe_url: 'https://alloha.yani.tv/?token=public' }],
        new AbortController().signal
      );

      expect(result.streams[0].url).toBe(`${root}${path}`);
      expect(result.caption?.url).toBe(`${root}${path}`);
      expect(native.invoke.mock.calls[0][0]).toBe('resolve_candidates');
      expect(fetcher).not.toHaveBeenCalled();
    }
  );

  it('prioritizes the history source over CVH through IPC and ignores legacy server settings', async () => {
    localStorage.setItem(
      'yumiwatch:playback-settings',
      JSON.stringify({ resolver: 'http://127.0.0.1:8788' })
    );

    const preferred = {
      ...video('1', 'AniLibria', 4),
      iframe_url: 'https://alloha.yani.tv/?token=public',
    };
    const cvh = {
      ...video('1'),
      iframe_url: 'https://ru.yummyani.me/iframeCVH.html?anime_id=10531',
    };

    native.invoke.mockResolvedValue({
      provider: 'Alloha',
      videoId: preferred.video_id,
      duration: 1400,
      skips: { opening: { time: 12, length: 90 } },
      streams: [{ quality: 360, type: 'hls', url: 'https://cdn.example/video.m3u8' }],
    });

    const fetcher = vi.fn();

    vi.stubGlobal('fetch', fetcher);

    const result = await resolveStream([cvh, preferred], new AbortController().signal, {
      preferredVideoId: preferred.video_id,
    });

    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('resolve_candidates', {
      candidates: [
        {
          url: preferred.iframe_url,
          videoId: preferred.video_id,
          dubbing: 'AniLibria',
          episode: '1',
        },
        {
          url: cvh.iframe_url,
          videoId: cvh.video_id,
          dubbing: 'AniLibria',
          episode: '1',
        },
      ],
    });
    expect(result.skips).toEqual({ opening: { time: 12, length: 90 } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects arbitrary native media paths returned as relays', async () => {
    native.invoke.mockResolvedValue({
      relay: true,
      videoId: 1,
      streams: [
        {
          quality: 360,
          type: 'hls',
          url: 'yumiwatch-media://localhost/private',
        },
      ],
    });
    await expect(resolveStream([video('1')], new AbortController().signal)).rejects.toThrow(
      'не предоставил видео'
    );
  });
  it('validates the optional native MP4 fallback without losing a safe HLS stream', async () => {
    const stream = {
      quality: 720,
      type: 'hls',
      url: 'https://cdn.example/video.m3u8',
    };
    for (const raw of [
      'javascript:alert(1)',
      'https://user:password@cdn.example/video.mp4',
      'http://cdn.example/video.mp4',
    ]) {
      native.invoke.mockResolvedValue({
        provider: 'Kodik',
        videoId: 1,
        streams: [{ ...stream, fallback: { type: 'mp4', url: raw } }],
      });
      const result = await resolveStream([video('1')], new AbortController().signal);
      expect(result.streams[0].url).toBe(stream.url);
      expect(result.streams[0].fallback).toBeUndefined();
    }
    native.invoke.mockResolvedValue({
      provider: 'Kodik',
      videoId: 1,
      streams: [
        {
          ...stream,
          fallback: { type: 'mp4', url: 'https://cdn.example/video.mp4' },
        },
      ],
    });
    expect(
      (await resolveStream([video('1')], new AbortController().signal)).streams[0].fallback
    ).toEqual({ type: 'mp4', url: 'https://cdn.example/video.mp4' });
  });

  it('loads the registered CVH transport under the same private protocol', async () => {
    const path = `media/${'a'.repeat(32)}/${'b'.repeat(32)}`;

    native.invoke.mockResolvedValue({
      provider: 'CVH',
      relay: true,
      videoId: 1,
      streams: [{ quality: 360, type: 'hls', url: path }],
    });

    const result = await resolveStream([video('1')], new AbortController().signal);

    expect(result.streams[0].url).toBe(`yumiwatch-media://localhost/${path}`);
  });

  it('dispatches Windows controls to the current native window', async () => {
    render(
      <>
        <WindowChrome />
        <aside class="media-nav">
          <span>Свободное место</span>
        </aside>
      </>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Свернуть окно' }));
    fireEvent.click(screen.getByRole('button', { name: 'Развернуть окно' }));
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть окно' }));
    fireEvent.mouseDown(screen.getByText('Свободное место'), {
      button: 0,
      detail: 1,
    });
    await waitFor(() => expect(native.minimize).toHaveBeenCalledOnce());
    expect(native.toggleMaximize).toHaveBeenCalledOnce();
    expect(native.close).toHaveBeenCalledOnce();
    expect(native.startDragging).toHaveBeenCalledOnce();
  });
  it('drags free titlebar and sidebar space while leaving controls and cards clickable', async () => {
    const click = vi.fn();
    const { container, unmount } = render(
      <>
        <WindowChrome />
        <aside class="media-nav">
          <span>Свободное место</span>
          <button>В сайдбаре</button>
        </aside>
        <button onClick={click}>Под заголовком</button>
        <a href="#/search">Поиск</a>
        <input aria-label="Ввод" />
        <article>
          <span>Карточка аниме</span>
        </article>
        <div data-gallery-item>
          <span>Карточка галереи</span>
        </div>
      </>
    );
    vi.spyOn(container.querySelector('.window-chrome')!, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      right: 1000,
      bottom: 44,
    } as DOMRect);
    const options = {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 200,
      clientY: 20,
    };
    for (const target of [
      screen.getByRole('button', { name: 'Под заголовком' }),
      screen.getByRole('link'),
      screen.getByRole('textbox'),
      screen.getByRole('button', { name: 'В сайдбаре' }),
      screen.getByText('Карточка аниме'),
      screen.getByText('Карточка галереи'),
    ]) {
      const down = new MouseEvent('mousedown', options);
      fireEvent(target, down);
      expect(down.defaultPrevented).toBe(false);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Под заголовком' }));
    expect(click).toHaveBeenCalledOnce();
    expect(native.startDragging).not.toHaveBeenCalled();
    const blank = new MouseEvent('mousedown', options);
    const free = screen.getByText('Свободное место');
    fireEvent(free, blank);
    expect(blank.defaultPrevented).toBe(true);
    await waitFor(() => expect(native.startDragging).toHaveBeenCalledOnce());
    fireEvent.mouseDown(free, { ...options, detail: 2 });
    expect(native.toggleMaximize).toHaveBeenCalledOnce();
    const titlebar = new MouseEvent('mousedown', options);
    fireEvent(document.body, titlebar);
    expect(titlebar.defaultPrevented).toBe(true);
    expect(native.startDragging).toHaveBeenCalledTimes(2);
    const content = new MouseEvent('mousedown', { ...options, clientY: 80 });
    fireEvent(document.body, content);
    expect(content.defaultPrevented).toBe(false);
    expect(native.startDragging).toHaveBeenCalledTimes(2);
    unmount();
    fireEvent.mouseDown(document.body, options);
    expect(native.startDragging).toHaveBeenCalledTimes(2);
  });

  it('leaves macOS controls to the OS and removes the inset in fullscreen', async () => {
    native.invoke.mockResolvedValue({ platform: 'macos' });
    await initializeDesktop();
    native.isFullscreen.mockResolvedValue(true);

    const { container } = render(<WindowChrome />);

    expect(screen.queryByRole('group', { name: 'Управление окном' })).toBeNull();
    await waitFor(() => expect(document.documentElement.dataset.desktopFullscreen).toBe('true'));
    expect(container.querySelector('.window-chrome')).toBeNull();
  });
  it('keeps a player drag strip after the playback controls hide and removes it in fullscreen', async () => {
    const { container } = render(<WindowChrome watching />);
    const strip = container.querySelector('.player-window-drag-region')!;

    expect(strip).toBeTruthy();
    act(() => setPlayerChrome(false));
    expect(container.querySelector('.window-chrome')?.hasAttribute('inert')).toBe(true);
    fireEvent.mouseDown(strip, { button: 0, detail: 1, clientY: 20 });
    await waitFor(() => expect(native.startDragging).toHaveBeenCalledOnce());
    act(() => syncDesktopFullscreen(true));
    expect(container.querySelector('.player-window-drag-region')).toBeNull();
  });

  it('leaves browser requests and chrome untouched', async () => {
    native.enabled = false;

    const fetcher = vi.fn().mockResolvedValue(new Response('{}'));

    vi.stubGlobal('fetch', fetcher);
    render(<WindowChrome />);
    await apiFetch('https://api.yani.tv/anime', {});
    expect(fetcher).toHaveBeenCalledOnce();
    expect(native.invoke).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Управление окном' })).toBeNull();
  });
});

describe('native Yummy API mirror allowlist', () => {
  it.each([
    ['https://api.yani.tv', '/profile'],
    ['https://old.yummyani.me', '/api/profile'],
    ['https://ru.yummyani.me', '/api/profile'],
  ])('forwards the selected API origin %s and its prefix to Rust', async (origin, path) => {
    native.invoke.mockResolvedValue({
      status: 200,
      body: '{"response":true}',
    });
    const response = await apiFetch(`${origin}${path}?limit=1`, {
      headers: { Authorization: 'Yummy token' },
    });
    expect(await response.json()).toEqual({ response: true });
    expect(native.invoke).toHaveBeenCalledWith('yummy_request', {
      request: {
        origin,
        path: `${path}?limit=1`,
        method: 'GET',
        headers: { authorization: 'Yummy token' },
        body: null,
      },
    });
  });

  it.each([
    'https://old.yummyani.me.evil.test/api/profile',
    'https://user:password@ru.yummyani.me/api/profile',
    'http://ru.yummyani.me/api/profile',
    'https://ru.yummyani.me:444/api/profile',
    'https://old.yummyani.me/profile',
    'https://ru.yummyani.me/api/../profile',
    'https://old.yummyani.me/api/%2e%2e/profile',
    'https://ru.yummyani.me/api/profile#token',
  ])('rejects %s before sending credentials to the native transport', async url => {
    await expect(apiFetch(url, { headers: { Authorization: 'Yummy token' } })).rejects.toThrow(
      'адрес API'
    );
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
