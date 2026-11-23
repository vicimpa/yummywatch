import type { FunctionalComponent as FC } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';

import { useInterfaceSettings } from '~/lib/interface-settings';
import { revealFocus } from '~/lib/keyboard-navigation';
import { installDirectionalNavigation } from '~/lib/directional-navigation';
import { installSelectionPolicy } from '~/lib/text-selection';
import { isTvMode } from '~/lib/tv-mode';

export type TInterfaceEffectsProps = { path?: string; onBack: () => void };

export const InterfaceEffects: FC<TInterfaceEffectsProps> = ({ path = '/', onBack }) => {
  const settings = useInterfaceSettings(),
    context = useRef<AudioContext>();
  const latest = useRef({ settings, onBack, path });
  const navigation = useRef<ReturnType<typeof installDirectionalNavigation>>();

  latest.current = { settings, onBack, path };

  useLayoutEffect(() => navigation.current?.navigate(path), [path]);

  useEffect(() => {
    document.documentElement.dataset.motion = settings.animations ? 'on' : 'off';
    document.documentElement.dataset.interfaceStyle = settings.style;
    for (const video of document.querySelectorAll('video')) video.volume = settings.volume;
  }, [settings]);

  useEffect(() => {
    const releaseSelection = installSelectionPolicy();
    let lastTarget: Element | null = null,
      pointerHoverArmed = true,
      hoverMutedUntil = 0,
      pointerX = -1,
      pointerY = -1,
      focusFrame = 0;

    const root = document.documentElement;
    const keyboardInput = () => root.dataset.inputMode === 'keyboard';
    root.dataset.inputMode = isTvMode() ? 'keyboard' : 'pointer';

    const reveal = () => {
      cancelAnimationFrame(focusFrame);
      if (keyboardInput())
        focusFrame = requestAnimationFrame(() => {
          if (document.activeElement instanceof HTMLElement) revealFocus(document.activeElement);
        });
    };

    const pointerMode = () => {
      if (!keyboardInput()) return;
      root.dataset.inputMode = 'pointer';
      navigation.current?.suspend();
      lastTarget = null;
      cancelAnimationFrame(focusFrame);
    };

    const pointer = () => {
      pointerMode();
      unlock();
    };

    const muteScrollHover = () => {
      pointerHoverArmed = false;
      hoverMutedUntil = performance.now() + 180;
    };

    const scrollInput = (event: Event) => {
      pointerMode();
      if (event instanceof MouseEvent) {
        pointerX = event.clientX;
        pointerY = event.clientY;
      }
      muteScrollHover();
    };

    const pointerMove = (event: PointerEvent) => {
      if (event.clientX === pointerX && event.clientY === pointerY) return;
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (event.pointerType !== 'touch') pointerMode();
      if (!pointerHoverArmed && performance.now() >= hoverMutedUntil) {
        pointerHoverArmed = true;
        lastTarget = null;
        hover(event);
      }
    };

    const unlock = () => {
      if (!latest.current.settings.sounds) return;

      const Context =
        window.AudioContext ||
        (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

      if (!Context) return;
      try {
        context.current ??= new Context();
        if (context.current.state === 'suspended') void context.current.resume().catch(() => {});
      } catch {
        /* Sound is optional. */
      }
    };

    const sound = (kind: 'focus' | 'activate') => {
      const preferences = latest.current.settings,
        audio = context.current;

      if (
        !audio ||
        audio.state !== 'running' ||
        !preferences.sounds ||
        !preferences.volume ||
        !preferences.effectsVolume
      )
        return;

      const now = audio.currentTime,
        oscillator = audio.createOscillator(),
        gain = audio.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(kind === 'focus' ? 720 : 980, now);
      oscillator.frequency.exponentialRampToValueAtTime(kind === 'focus' ? 520 : 1240, now + 0.035);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(
        0.045 * preferences.volume * preferences.effectsVolume,
        now + 0.004
      );
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.05);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
    };

    const hover = (event: Event) => {
      if (event.type === 'focusin' ? !keyboardInput() : !pointerHoverArmed) return;
      const target =
        event.target instanceof Element
          ? event.target.closest('button,a[href],[role=button]')
          : null;

      if (!target || target.hasAttribute('disabled') || target.matches('.video-hit-area')) return;

      const related = (event as PointerEvent).relatedTarget;

      if (related instanceof Node && target.contains(related)) return;

      if (target === lastTarget) return;
      lastTarget = target;
      sound('focus');
    };

    const activate = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('.video-hit-area,video')) return;
      sound('activate');
    };

    navigation.current = installDirectionalNavigation(() => latest.current.onBack(), unlock);
    navigation.current.navigate(latest.current.path);

    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('wheel', scrollInput, { passive: true, capture: true });
    document.addEventListener('touchstart', scrollInput, { passive: true, capture: true });
    document.addEventListener('scroll', muteScrollHover, { passive: true, capture: true });
    document.addEventListener('pointermove', pointerMove, { passive: true });
    document.addEventListener('pointerover', hover);
    document.addEventListener('focusin', hover);
    document.addEventListener('focusin', reveal);
    document.addEventListener('click', activate);
    window.addEventListener('resize', reveal);
    document.addEventListener('load', reveal, true);

    return () => {
      navigation.current?.dispose();
      navigation.current = undefined;
      releaseSelection();
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('wheel', scrollInput, true);
      document.removeEventListener('touchstart', scrollInput, true);
      document.removeEventListener('scroll', muteScrollHover, true);
      document.removeEventListener('pointermove', pointerMove);
      document.removeEventListener('pointerover', hover);
      document.removeEventListener('focusin', hover);
      document.removeEventListener('focusin', reveal);
      document.removeEventListener('click', activate);
      window.removeEventListener('resize', reveal);
      document.removeEventListener('load', reveal, true);
      void context.current?.close().catch(() => {});
    };
  }, []);

  return null;
};
