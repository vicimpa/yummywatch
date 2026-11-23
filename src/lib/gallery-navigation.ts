import type { JSX } from 'preact';

import { focusTarget, keyboardTargets } from './keyboard-navigation';

export function navigateGallery(event: JSX.TargetedKeyboardEvent<HTMLElement>) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    !['Home', 'End'].includes(event.key)
  )
    return;

  const target = event.target as HTMLElement;
  const current =
    target.closest('[data-gallery-link]') ||
    target.closest('[data-gallery-item]')?.querySelector('[data-gallery-link]');
  if (!current) return;

  const row = current.closest('[data-gallery-row]');
  const links = keyboardTargets(event.currentTarget).filter(
    node => node.matches('[data-gallery-link]') && node.closest('[data-gallery-row]') === row
  );
  const next = event.key === 'Home' ? links[0] : links.at(-1);
  if (!next) return;

  event.preventDefault();
  focusTarget(next);
}
