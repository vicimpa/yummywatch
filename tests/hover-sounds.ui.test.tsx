// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InterfaceEffects } from '~/components/InterfaceEffects';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('intentional interface sounds', () => {
  it('ignores hover and pointer focus caused by scrolling until the mouse actually moves again', () => {
    localStorage.clear();
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('PointerEvent', MouseEvent);
    const oscillators = vi.fn(() => ({
      type: '',
      frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {},
      disconnect() {},
      start() {},
      stop() {},
    }));
    class Audio {
      state = 'running';
      currentTime = 0;
      destination = {};
      createOscillator = oscillators;
      createGain() {
        return {
          gain: {
            setValueAtTime() {},
            linearRampToValueAtTime() {},
            exponentialRampToValueAtTime() {},
          },
          connect() {},
          disconnect() {},
        };
      }
      close() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal('AudioContext', Audio);
    render(
      <>
        <InterfaceEffects onBack={() => {}} />
        <main>
          <button>Первый</button>
          <button>Второй</button>
        </main>
      </>
    );
    const first = screen.getByText('Первый'),
      second = screen.getByText('Второй');
    fireEvent.pointerDown(first);
    fireEvent.pointerOver(first, { clientX: 20, clientY: 20 });
    expect(oscillators).toHaveBeenCalledTimes(1);
    fireEvent.wheel(first, { clientX: 20, clientY: 20, deltaY: 200 });
    fireEvent.scroll(first.closest('main')!);
    fireEvent.pointerOver(second, { clientX: 20, clientY: 20 });
    fireEvent.focusIn(second);
    expect(oscillators).toHaveBeenCalledTimes(1);
    now += 1000;
    fireEvent.pointerMove(second, { clientX: 20, clientY: 20 });
    expect(oscillators).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(second, { clientX: 25, clientY: 22 });
    expect(oscillators).toHaveBeenCalledTimes(2);
    fireEvent.pointerOver(second, { clientX: 25, clientY: 22 });
    expect(oscillators).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    fireEvent.focusIn(first);
    expect(oscillators).toHaveBeenCalledTimes(3);
  });
});
