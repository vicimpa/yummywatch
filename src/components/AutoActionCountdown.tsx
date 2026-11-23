import type { FunctionalComponent as FC } from 'preact';
import { createPortal } from 'preact/compat';
import { useCallback, useLayoutEffect, useRef, useState } from 'preact/hooks';

import { Button } from '~/ui';

export const AUTO_ACTION_DELAY_MS = 5000;

export type TAutoActionCountdownProps = {
  label: string;
  background?: boolean;
  onComplete: () => void;
  onCancel: () => void;
  onNow: () => void;
};

export const AutoActionCountdown: FC<TAutoActionCountdownProps> = ({
  label,
  background = false,
  onComplete,
  onCancel,
  onNow,
}) => {
  const [seconds, setSeconds] = useState(AUTO_ACTION_DELAY_MS / 1000),
    done = useRef(false),
    timer = useRef<ReturnType<typeof setInterval>>();
  const callbacks = useRef({ onComplete, onCancel, onNow });

  callbacks.current = { onComplete, onCancel, onNow };

  const findHost = useCallback(
    () => document.querySelector<HTMLElement>('[data-sidebar-open=true]'),
    []
  );

  const [host, setHost] = useState(findHost);

  const finish = useCallback((action: 'onComplete' | 'onCancel' | 'onNow') => {
    if (done.current) return;
    done.current = true;
    clearInterval(timer.current);
    callbacks.current[action]();
  }, []);

  useLayoutEffect(() => {
    const deadline = performance.now() + AUTO_ACTION_DELAY_MS;

    timer.current = setInterval(() => {
      const left = deadline - performance.now();

      if (left <= 0) finish('onComplete');
      else setSeconds(Math.ceil(left / 1000));
    }, 100);

    return () => clearInterval(timer.current);
  }, []);

  useLayoutEffect(() => {
    if (background) return;
    const update = () => setHost(findHost());
    update();

    const observer = new MutationObserver(update);

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-sidebar-open'],
    });

    return () => observer.disconnect();
  }, [background, findHost]);

  useLayoutEffect(() => {
    if (background) return;
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        finish('onCancel');
      }
    };

    document.addEventListener('keydown', keyboard, true);

    return () => document.removeEventListener('keydown', keyboard, true);
  }, [background]);

  const cancel = useCallback(() => finish('onCancel'), [finish]);

  const runNow = useCallback(() => finish('onNow'), [finish]);

  if (background) return null;

  const content = (
    <div
      class={`native-auto-action ${host ? 'is-in-sidebar' : ''}`}
      data-tv-countdown
      role="group"
      aria-label={label}
    >
      <span role="status" aria-live="polite">
        {label} через <strong>{seconds}</strong> с
      </span>
      <div>
        <Button aria-keyshortcuts="Escape" onClick={cancel} data-tv-close data-nav-primary>
          Отмена
        </Button>
        <Button onClick={runNow} variant="primary">
          Сейчас
        </Button>
      </div>
    </div>
  );

  return host ? createPortal(content, host) : content;
};
