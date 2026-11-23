import type { ComponentChildren, JSX } from 'preact';
import { useCallback, useLayoutEffect, useRef, useState } from 'preact/hooks';

import { focusTarget } from '~/lib/keyboard-navigation';

const OVERSCAN = 3,
  SMALL_LIST = 60;
const secondaryAction = '[data-virtual-secondary]:not(:disabled)';

export type TVirtualGridProps<T> = {
  items: readonly T[];
  itemKey: (item: T) => string | number;
  renderItem: (item: T) => ComponentChildren;
  active?: boolean;
  layout?: 'grid' | 'list';
};

type TVirtualGrid = <T>(props: TVirtualGridProps<T>) => JSX.Element;

export const VirtualGrid: TVirtualGrid = ({
  items,
  itemKey,
  renderItem,
  active = true,
  layout = 'grid',
}) => {
  const root = useRef<HTMLDivElement>(null),
    pendingFocus = useRef<{ index: number; secondary: boolean } | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [window, setWindow] = useState({
    columns: 1,
    pitch: 360,
    columnWidth: 180,
    gap: 20,
    start: 0,
    end: 30,
  });
  const latest = useRef({ items, window });

  latest.current = { items, window };

  const totalRows = Math.ceil(items.length / window.columns),
    virtual = items.length > SMALL_LIST;
  const start = virtual ? Math.min(window.start, Math.max(0, totalRows - 1)) : 0;
  const end = virtual ? Math.max(start + 1, Math.min(totalRows, window.end)) : totalRows;
  const first = start * window.columns,
    last = Math.min(items.length, end * window.columns);
  const pinned =
    focus !== null && focus < items.length && (focus < first || focus >= last) ? focus : null;

  useLayoutEffect(() => {
    const grid = root.current,
      scroll = grid?.closest<HTMLElement>('.media-scroll');

    if (!grid || !active) return;

    let frame = 0;

    const measure = () => {
      if (!grid.getClientRects().length || grid.clientWidth < 1) return;

      const style = getComputedStyle(grid),
        columns =
          layout === 'list'
            ? 1
            : Math.max(1, style.gridTemplateColumns.split(' ').filter(Boolean).length);
      const gap = parseFloat(style.columnGap) || 0,
        rowGap = parseFloat(style.rowGap) || 0;
      const item = grid.querySelector<HTMLElement>('.virtual-item');
      const height = item?.getBoundingClientRect().height || 300,
        pitch = height + rowGap;
      const offset =
        grid.getBoundingClientRect().top -
        (scroll?.getBoundingClientRect().top || 0) +
        (scroll?.scrollTop || 0);
      const top = Math.max(0, (scroll?.scrollTop || 0) - offset),
        viewport = scroll?.clientHeight || innerHeight;
      const start = Math.max(0, Math.floor(top / pitch) - OVERSCAN),
        end = Math.ceil((top + viewport) / pitch) + OVERSCAN;
      const next = {
        columns,
        pitch,
        columnWidth: (grid.clientWidth - gap * (columns - 1)) / columns,
        gap,
        start,
        end,
      };

      setWindow(previous =>
        Object.keys(next).every(
          key => Math.abs(previous[key as keyof typeof next] - next[key as keyof typeof next]) < 0.5
        )
          ? previous
          : next
      );
    };

    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);

    observer?.observe(grid);
    measure();
    scroll?.addEventListener('scroll', schedule, { passive: true });
    globalThis.window.addEventListener('resize', schedule);

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      scroll?.removeEventListener('scroll', schedule);
      globalThis.window.removeEventListener('resize', schedule);
    };
  }, [active, layout, items.length]);

  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;

    const item = root.current?.querySelector(`[data-virtual-index="${pending.index}"]`);
    const node =
      (pending.secondary && item?.querySelector<HTMLElement>(secondaryAction)) ||
      item?.querySelector<HTMLElement>('[data-gallery-link],a:not([tabindex="-1"])');

    if (node) {
      pendingFocus.current = null;
      // The intermediate rows do not exist while jumping the render window.
      focusTarget(node, virtual);
    }
  });

  const keyboard = useCallback((event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;

    const target = event.target as HTMLElement;
    const item = target.closest<HTMLElement>('[data-virtual-index]');
    const index = Number(item?.dataset.virtualIndex);

    if (!Number.isInteger(index) || target.closest('input,select,textarea')) return;

    const { columns } = latest.current.window,
      count = latest.current.items.length;
    let next = index;
    const secondary = target.matches(secondaryAction);
    let focusSecondary = secondary;
    if (event.key === 'ArrowDown' && !secondary) {
      const action = item?.querySelector<HTMLElement>(secondaryAction);
      if (action) {
        event.preventDefault();
        focusTarget(action);
        return;
      }
    }
    if (secondary && event.key === 'ArrowUp') {
      const poster = item?.querySelector<HTMLElement>('[data-gallery-link]');
      if (poster) {
        event.preventDefault();
        focusTarget(poster);
        return;
      }
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (index % columns === columns - 1 || index + 1 >= count) return;
      next++;
    } else if (event.key === 'ArrowLeft') {
      if (index % columns === 0) return;
      event.preventDefault();
      next--;
    } else if (event.key === 'ArrowDown') {
      if (Math.floor(index / columns) === Math.floor((count - 1) / columns)) return;
      event.preventDefault();
      next = Math.min(count - 1, index + columns);
      focusSecondary = false;
    } else if (event.key === 'ArrowUp') {
      if (index < columns) return;
      event.preventDefault();
      next -= columns;
      focusSecondary = true;
    } else if (event.key === 'Home') {
      event.preventDefault();
      next = 0;
    } else if (event.key === 'End') {
      event.preventDefault();
      next = count - 1;
    } else return;
    if (next === index) return;
    pendingFocus.current = { index: next, secondary: focusSecondary };
    setFocus(next);

    const row = Math.floor(next / columns);

    setWindow(previous => ({
      ...previous,
      start: Math.max(0, row - OVERSCAN),
      end: row + OVERSCAN + 1,
    }));
  }, []);

  const item = useCallback(
    (index: number, pin = false) => (
      <div
        class="virtual-item"
        data-virtual-index={index}
        key={itemKey(items[index])}
        style={
          pin
            ? {
                position: 'absolute',
                top: 5 + Math.floor(index / window.columns) * window.pitch,
                left: (index % window.columns) * (window.columnWidth + window.gap),
                width: window.columnWidth,
              }
            : undefined
        }
      >
        {renderItem(items[index])}
      </div>
    ),
    [itemKey, items, window, renderItem]
  );

  const indices = Array.from({ length: Math.max(0, last - first) }, (_, offset) => first + offset);

  if (pinned !== null) {
    if (pinned < first) indices.unshift(pinned);
    else indices.push(pinned);
  }

  const focusItem = useCallback((event: JSX.TargetedFocusEvent<HTMLDivElement>) => {
    const index = (event.target as HTMLElement).closest<HTMLElement>('[data-virtual-index]')
      ?.dataset.virtualIndex;

    if (index !== undefined) setFocus(Number(index));
  }, []);

  const blurItem = useCallback((event: JSX.TargetedFocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node)) setFocus(null);
  }, []);

  return (
    <div
      ref={root}
      class={`${layout === 'grid' ? 'anime-grid gallery-grid' : 'anime-results-list is-list'} virtual-grid`}
      data-gallery-row
      data-virtual-grid
      data-total-items={items.length}
      style={{
        paddingTop: 5 + start * window.pitch,
        paddingBottom: 5 + Math.max(0, totalRows - end) * window.pitch,
      }}
      onKeyDown={keyboard}
      onFocusIn={focusItem}
      onFocusOut={blurItem}
    >
      {indices.map(index => item(index, index === pinned))}
    </div>
  );
};
