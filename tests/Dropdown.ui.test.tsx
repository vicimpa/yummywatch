// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, expect, it, vi } from 'vitest';
import { PlaybackSettingsCard } from '~/components/PlaybackSettings';
import { playbackSettings } from '~/lib/playback-settings';
import { Dropdown, Sheet } from '~/ui';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.desktop;
});

it('offers and persists all upscaling modes on the native macOS player', () => {
  const web = render(<PlaybackSettingsCard />);
  expect(screen.queryByRole('combobox', { name: 'Апскейл видео' })).toBeNull();
  web.unmount();
  vi.stubGlobal('isTauri', true);
  document.documentElement.dataset.desktop = 'macos';
  render(<PlaybackSettingsCard />);
  const trigger = screen.getByRole('combobox', { name: 'Апскейл видео' });
  expect(trigger.textContent).toContain('Стандартный');
  fireEvent.click(trigger);
  expect(screen.getAllByRole('option').map(option => option.textContent?.trim())).toEqual([
    'Стандартный',
    'EWA Lanczos',
    'AMD FSR 1.0',
    'Anime4K CNN x2 S',
    'FSRCNNX x2 8-0-4-1',
  ]);
  fireEvent.click(screen.getByRole('option', { name: 'Anime4K CNN x2 S' }));
  expect(playbackSettings().upscale).toBe('anime4k');
  expect(trigger.textContent).toContain('Anime4K CNN x2 S');
});

it('selects and persists quality using an app menu instead of a native select', () => {
  const { container } = render(<PlaybackSettingsCard />);
  const trigger = screen.getByRole('combobox', { name: 'Предпочитаемое качество' });
  expect(container.querySelector('select')).toBeNull();
  fireEvent.click(trigger);
  expect(screen.getByRole('listbox').parentElement).toBe(document.body);
  fireEvent.click(screen.getByRole('option', { name: '720p' }));
  expect(playbackSettings().quality).toBe('720');
  expect(trigger.textContent).toContain('720p');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('supports keyboard selection, cancel, Tab and outside clicks', () => {
  render(<PlaybackSettingsCard />);
  const trigger = screen.getByRole('combobox', { name: 'Предпочитаемое качество' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.keyDown(trigger, { key: 'End' });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  expect(playbackSettings().quality).toBe('auto');
  fireEvent.click(trigger);
  fireEvent.keyDown(trigger, { key: 'Home' });
  fireEvent.keyDown(trigger, { key: 'Escape' });
  expect(playbackSettings().quality).toBe('auto');
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.click(trigger);
  fireEvent.keyDown(trigger, { key: 'Tab' });
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('closes a focused dropdown on a second mouse click', () => {
  render(
    <>
      <PlaybackSettingsCard />
      <button type="button">Дальше</button>
    </>
  );
  const trigger = screen.getByRole('combobox', { name: 'Предпочитаемое качество' });
  const label = trigger.querySelector('span')!;
  fireEvent.click(label);
  expect(screen.getByRole('listbox')).toBeTruthy();
  expect(document.activeElement).toBe(trigger);

  fireEvent.pointerDown(label, { button: 0 });
  // Mirror browsers that normally blur a focused button on mousedown.
  if (fireEvent.mouseDown(label, { button: 0 })) act(() => trigger.blur());
  fireEvent.mouseUp(label, { button: 0 });
  fireEvent.click(label);

  expect(screen.queryByRole('listbox')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(label);
  expect(screen.getByRole('listbox')).toBeTruthy();
  act(() => screen.getByRole('button', { name: 'Дальше' }).focus());
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('keeps the list inside its modal and skips disabled options', () => {
  const close = vi.fn();
  const change = vi.fn();
  render(
    <Sheet title="Настройки" close={close}>
      <Dropdown
        aria-label="Качество"
        value="480"
        options={[
          { value: '360', label: '360p' },
          { value: '480', label: '480p · недоступно', disabled: true },
          { value: '720', label: '720p' },
        ]}
        onChange={change}
      />
    </Sheet>
  );
  const trigger = screen.getByRole('combobox', { name: 'Качество' });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.keyDown(trigger, { key: 'Home' });
  const list = screen.getByRole('listbox', { name: 'Качество' });
  expect(list.parentElement).toBe(screen.getByRole('dialog'));
  expect(
    (screen.getByRole('option', { name: '480p · недоступно' }) as HTMLButtonElement).disabled
  ).toBe(true);
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  expect(change).toHaveBeenCalledExactlyOnceWith('720');
  expect(close).not.toHaveBeenCalled();
});

it('portals the list into the fullscreen element and dismisses it on exit', () => {
  const fullscreen = document.createElement('div');
  document.body.append(fullscreen);
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: fullscreen });
  try {
    const { unmount } = render(<PlaybackSettingsCard />, { container: fullscreen });
    fireEvent.click(screen.getByRole('combobox', { name: 'Предпочитаемое качество' }));
    expect(screen.getByRole('listbox').parentElement).toBe(fullscreen);
    fireEvent(document, new Event('fullscreenchange'));
    expect(screen.queryByRole('listbox')).toBeNull();
    unmount();
  } finally {
    Reflect.deleteProperty(document, 'fullscreenElement');
    fullscreen.remove();
  }
});
