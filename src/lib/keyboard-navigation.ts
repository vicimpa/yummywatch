import { interfaceSettings } from './interface-settings';
import { isTvMode } from './tv-mode';

export function keyboardTargets(scope: ParentNode): HTMLElement[] {
  return [
    ...scope.querySelectorAll<HTMLElement>(
      'a[href],button,input,select,textarea,summary,[tabindex]'
    ),
  ].filter(
    node =>
      node.tabIndex >= 0 &&
      !node.matches(':disabled,input[type=hidden]') &&
      !node.closest('[hidden],[inert],[aria-hidden=true],.video-hit-area') &&
      node.getClientRects().length > 0 &&
      !['hidden', 'collapse'].includes(getComputedStyle(node).visibility)
  );
}

/** Reveal the focused control, its card, and any group that fits in the scrollport. */
export function revealFocus(node: HTMLElement, instant = false) {
  if (!node.isConnected || node.closest('[hidden],[inert],[aria-hidden=true]')) return;

  const inset =
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--window-inset')) || 0;
  const tv = isTvMode();
  const rect = node.getBoundingClientRect();
  const card = node.closest<HTMLElement>('[data-gallery-item]');
  const cardRect = card?.getBoundingClientRect();
  const group = node.closest<HTMLElement>('[data-tv-focus-group]');
  const groupRect = group?.getBoundingClientRect();
  let shiftX = 0;
  let shiftY = 0;
  let cardShiftX = 0;
  let cardShiftY = 0;
  let groupShiftY = 0;
  const behavior =
    !instant &&
    interfaceSettings().animations &&
    !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ? 'smooth'
      : 'instant';

  const delta = (start: number, end: number, min: number, max: number, padding: number) => {
    // Leave as much space as fits without cutting off a large control or card.
    const margin = Math.min(padding, Math.max(0, (max - min - (end - start)) / 2));
    const first = min + margin;
    const last = max - margin;
    return start < first ? start - first : end > last ? Math.min(end - last, start - first) : 0;
  };

  for (
    let parent = node.parentElement;
    parent && parent !== document.body;
    parent = parent.parentElement
  ) {
    const style = getComputedStyle(parent),
      box = parent.getBoundingClientRect();
    const scrollX =
      /auto|scroll/.test(style.overflowX) && parent.scrollWidth > parent.clientWidth + 1;
    const scrollY =
      /auto|scroll/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 1;

    if (!scrollX && !scrollY) continue;

    const x = box.left + parent.clientLeft,
      y = box.top + parent.clientTop;
    const ceiling = parent.matches('.media-scroll,.media-nav') ? inset : 0;
    const height = parent.clientHeight - ceiling;
    const containsCard = card && parent !== card && parent.contains(card);
    const containsGroup = group && parent !== group && parent.contains(group);
    const horizontal =
      containsCard && cardRect && cardRect.right - cardRect.left <= parent.clientWidth
        ? cardRect
        : rect;
    let vertical =
      containsCard && cardRect && cardRect.bottom - cardRect.top <= height ? cardRect : rect;
    if (containsGroup && groupRect && groupRect.bottom - groupRect.top <= height)
      vertical = groupRect;
    const offsetX = horizontal === cardRect ? cardShiftX : shiftX;
    const offsetY =
      vertical === groupRect ? groupShiftY : vertical === cardRect ? cardShiftY : shiftY;
    const dx = scrollX
      ? delta(
          horizontal.left + offsetX,
          horizontal.right + offsetX,
          x,
          x + parent.clientWidth,
          tv ? 24 : 8
        )
      : 0;
    const dy = scrollY
      ? delta(
          vertical.top + offsetY,
          vertical.bottom + offsetY,
          y + ceiling,
          y + parent.clientHeight,
          tv ? 40 : 12
        )
      : 0;
    const nextX = Math.max(
      0,
      Math.min(parent.scrollWidth - parent.clientWidth, parent.scrollLeft + dx)
    );
    const nextY = Math.max(
      0,
      Math.min(parent.scrollHeight - parent.clientHeight, parent.scrollTop + dy)
    );

    const scrollDeltaX = parent.scrollLeft - nextX;
    const scrollDeltaY = parent.scrollTop - nextY;
    shiftX += scrollDeltaX;
    shiftY += scrollDeltaY;
    if (containsCard) {
      cardShiftX += scrollDeltaX;
      cardShiftY += scrollDeltaY;
    }
    if (containsGroup) groupShiftY += scrollDeltaY;
    if (Math.abs(nextX - parent.scrollLeft) > 1 || Math.abs(nextY - parent.scrollTop) > 1)
      parent.scrollTo?.({ left: nextX, top: nextY, behavior });
  }
}

export function focusTarget(node: HTMLElement, instant = false) {
  node.focus({ preventScroll: true });
  if (document.activeElement === node) revealFocus(node, instant);
}
