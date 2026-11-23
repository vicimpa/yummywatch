// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { InterfaceEffects } from '~/components/InterfaceEffects';
import { InterfaceSettingsCard } from '~/components/InterfaceSettings';
import { ProxySettingsCard } from '~/components/ProxySettings';
import { interfaceSettings, saveInterfaceSettings } from '~/lib/interface-settings';
import type { ProxyPoolReport } from '~/lib/proxy-settings';

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.motion;
  delete document.documentElement.dataset.interfaceStyle;
  delete document.documentElement.dataset.tv;
});
describe('media center preferences and sound', () => {
  it('turns off the native proxy pool and reads the saved value when settings reopen', async () => {
    let enabled = true;
    const invoke = vi.fn(async (_command: string, args: { enabled?: boolean }) => {
      if (args.enabled !== undefined) enabled = args.enabled;
      return enabled;
    });
    vi.stubGlobal('isTauri', true);
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    const view = render(<ProxySettingsCard />);
    const toggle = () =>
      screen.getByRole<HTMLInputElement>('checkbox', {
        name: 'Использовать прокси для источников видео',
      });
    await waitFor(() => expect(toggle().checked).toBe(true));
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().checked).toBe(false));
    expect(invoke).toHaveBeenCalledWith('proxy_settings', { enabled: false }, undefined);
    view.unmount();
    render(<ProxySettingsCard />);
    await waitFor(() => expect(toggle().disabled).toBe(false));
    expect(toggle().checked).toBe(false);
  });

  it('saves the selected feeds and displays the actual reading and playback counters', async () => {
    const report: ProxyPoolReport = {
      preferences: { intervalSeconds: 4, concurrentChecks: 4, feeds: [true, true] },
      customProxies: [],
      feeds: [
        ['ProxMint', { addresses: 12, updatedAt: 1700000000, error: null }],
        ['ProxyFly', { addresses: 23, updatedAt: 1700000000, error: null }],
      ],
      working: 3,
      queued: 20,
      probes: { checked: 12, passed: 3, completedAt: 1700000000 },
      manualPending: false,
      lastManual: null,
      players: [
        ['Kodik', 5, 2, 1700000000],
        ['Alloha', 0, 0, null],
      ],
    };
    const invoke = vi.fn(async (command, args) => {
      if (command === 'proxy_settings') return true;
      if (command === 'edit_custom_proxy')
        report.customProxies =
          args.change.action === 'add'
            ? [{ id: 17, address: 'http://192.168.1.7:3128', authenticated: true, reachable: null }]
            : [];
      if (args.preferences) report.preferences = args.preferences;
      if (args.checkNow) report.lastManual = { checked: 4, passed: 1, completedAt: 1700000000 };
      return { ...report };
    });
    vi.stubGlobal('isTauri', true);
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    render(<ProxySettingsCard />);

    const feed = await screen.findByRole<HTMLInputElement>('checkbox', { name: 'ProxyFly' });
    fireEvent.click(feed);
    await waitFor(() => expect(feed.checked).toBe(false));
    expect(invoke).toHaveBeenCalledWith(
      'proxy_pool_report',
      { preferences: { intervalSeconds: 4, concurrentChecks: 4, feeds: [true, false] } },
      undefined
    );
    fireEvent.click(screen.getByRole('button', { name: 'Проверить сейчас' }));
    expect(await screen.findByText(/прошли 1 из 4/)).toBeTruthy();
    expect(screen.getByText(/2 из 5 успешно/)).toBeTruthy();
    expect(screen.getByText('Попыток пока не было')).toBeTruthy();

    const address = screen.getByRole<HTMLInputElement>('textbox', { name: 'Адрес прокси' });
    const custom = 'http://user:secret@192.168.1.7:3128';
    fireEvent.input(address, { target: { value: custom } });
    fireEvent.submit(address.form!);
    expect(await screen.findByText('http://192.168.1.7:3128')).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith(
      'edit_custom_proxy',
      { change: { action: 'add', address: custom } },
      undefined
    );
    await waitFor(() => expect(address.value).toBe(''));
    expect(screen.getByText('С авторизацией · Ожидает проверки')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Удалить прокси http://192.168.1.7:3128' }));
    await waitFor(() => expect(screen.queryByText('http://192.168.1.7:3128')).toBeNull());
  });

  it('disables transitions on TV even when animations are saved as enabled', () => {
    saveInterfaceSettings({ animations: true });
    document.documentElement.dataset.tv = 'true';
    render(
      <>
        <InterfaceEffects onBack={() => {}} />
        <InterfaceSettingsCard />
      </>
    );

    const animations = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'Анимации переходов и боковых панелей',
    });
    expect(animations.disabled).toBe(true);
    expect(animations.checked).toBe(false);
    expect(document.documentElement.dataset.motion).toBe('off');
    expect(interfaceSettings().sounds).toBe(false);

    saveInterfaceSettings({ volume: 0.5 });
    delete document.documentElement.dataset.tv;
    expect(interfaceSettings().animations).toBe(true);
  });

  it('persists master volume, effects volume, animation and appearance and applies master volume to video', () => {
    render(
      <>
        <InterfaceEffects onBack={() => {}} />
        <video />
        <InterfaceSettingsCard />
      </>
    );
    fireEvent.input(screen.getByRole('slider', { name: 'Общая громкость' }), {
      target: { value: '.25' },
    });
    fireEvent.input(screen.getByRole('slider', { name: 'Громкость интерфейса' }), {
      target: { value: '.5' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Анимации переходов и боковых панелей' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Стиль интерфейса' }));
    fireEvent.click(screen.getByRole('option', { name: 'Контрастный' }));
    expect(interfaceSettings()).toMatchObject({
      volume: 0.25,
      effectsVolume: 0.5,
      animations: false,
      style: 'contrast',
    });
    expect(document.querySelector('video')!.volume).toBe(0.25);
    expect(document.documentElement.dataset.motion).toBe('off');
    expect(document.documentElement.dataset.interfaceStyle).toBe('contrast');
  });
  it('plays a short focus sound after a gesture and respects the sound toggle and zero master volume', () => {
    const start = vi.fn(),
      close = vi.fn().mockResolvedValue(undefined);

    const parameter = () => ({
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    });

    vi.stubGlobal(
      'AudioContext',
      class {
        state = 'running';
        currentTime = 0;
        destination = {};
        close = close;
        resume = vi.fn().mockResolvedValue(undefined);

        createOscillator() {
          return {
            type: 'sine',
            frequency: parameter(),
            connect: vi.fn(),
            start,
            stop: vi.fn(),
            disconnect: vi.fn(),
          };
        }

        createGain() {
          return { gain: parameter(), connect: vi.fn(), disconnect: vi.fn() };
        }
      }
    );
    render(
      <>
        <InterfaceEffects onBack={() => {}} />
        <button>Первый</button>
        <button>Второй</button>
      </>
    );

    const first = screen.getByRole('button', { name: 'Первый' }),
      second = screen.getByRole('button', { name: 'Второй' });

    fireEvent.pointerOver(first);
    expect(start).not.toHaveBeenCalled();
    fireEvent.pointerDown(first);
    fireEvent.pointerOver(second);
    expect(start).toHaveBeenCalledOnce();
    act(() => {
      saveInterfaceSettings({ sounds: false });
    });
    fireEvent.pointerOver(first);
    expect(start).toHaveBeenCalledOnce();
    act(() => {
      saveInterfaceSettings({ sounds: true, volume: 0 });
    });
    fireEvent.pointerOver(second);
    expect(start).toHaveBeenCalledOnce();
    cleanup();
    expect(close).toHaveBeenCalledOnce();
  });
  it('uses Escape for back only when no panel or field consumes it', () => {
    const back = vi.fn();

    render(
      <>
        <InterfaceEffects onBack={back} />
        <input aria-label="Поле" />
        <aside data-sidebar-open="true">
          <button>Закрыть</button>
        </aside>
      </>
    );
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(back).not.toHaveBeenCalled();
    document.querySelector('aside')!.remove();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Поле' }), { key: 'Escape' });
    expect(back).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(back).toHaveBeenCalledOnce();
  });
  it.each([
    ['fullscreenElement', 'exitFullscreen'],
    ['webkitFullscreenElement', 'webkitExitFullscreen'],
  ])('exits browser fullscreen before navigating back (%s)', (elementKey, exitKey) => {
    let fullscreen: Element | null = document.body;
    const exit = vi.fn(() => {
      fullscreen = null;
    });
    const back = vi.fn();
    Object.defineProperty(document, elementKey, { configurable: true, get: () => fullscreen });
    Object.defineProperty(document, exitKey, { configurable: true, value: exit });
    try {
      render(<InterfaceEffects onBack={back} />);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(exit).toHaveBeenCalledOnce();
      expect(back).not.toHaveBeenCalled();
      fireEvent.keyDown(document.body, { key: 'Escape', repeat: true });
      expect(back).not.toHaveBeenCalled();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(back).toHaveBeenCalledOnce();
    } finally {
      Reflect.deleteProperty(document, elementKey);
      Reflect.deleteProperty(document, exitKey);
    }
  });
  it('keeps the video surface silent while retaining sounds on player buttons', () => {
    const start = vi.fn();

    const parameter = () => ({
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    });

    vi.stubGlobal(
      'AudioContext',
      class {
        state = 'running';
        currentTime = 0;
        destination = {};
        close = vi.fn().mockResolvedValue(undefined);

        createOscillator() {
          return {
            frequency: parameter(),
            connect: vi.fn(),
            start,
            stop: vi.fn(),
            disconnect: vi.fn(),
          };
        }

        createGain() {
          return { gain: parameter(), connect: vi.fn(), disconnect: vi.fn() };
        }
      }
    );
    render(
      <>
        <InterfaceEffects onBack={() => {}} />
        <div class="video-controls">
          <button class="video-hit-area" aria-label="Поверхность видео" />
          <div class="video-toolbar">
            <button>Пауза</button>
          </div>
        </div>
      </>
    );

    const surface = screen.getByRole('button', { name: 'Поверхность видео' }),
      control = screen.getByRole('button', { name: 'Пауза' });

    fireEvent.pointerDown(document.body);
    fireEvent.pointerOver(surface);
    fireEvent.focusIn(surface);
    fireEvent.click(surface);
    expect(start).not.toHaveBeenCalled();
    fireEvent.pointerOver(control);
    expect(start).toHaveBeenCalledOnce();
    fireEvent.pointerOver(surface, { relatedTarget: control });
    expect(start).toHaveBeenCalledOnce();
    fireEvent.click(control);
    expect(start).toHaveBeenCalledTimes(2);
  });
  it('validates stored values instead of passing invalid volume to media elements', () => {
    localStorage.setItem(
      'yumiwatch:interface-settings',
      JSON.stringify({ volume: 3, effectsVolume: -1, style: 'unknown' })
    );
    expect(interfaceSettings()).toMatchObject({ volume: 1, effectsVolume: 0, style: 'classic' });
  });
});
