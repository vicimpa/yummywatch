import type { ComponentChildren, FunctionalComponent as FC } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useId, useLayoutEffect, useState } from 'preact/hooks';

import { useMediaQuery } from '~/lib/hooks';
import { interfaceSettings } from '~/lib/interface-settings';
import { lockPageScroll } from '~/lib/page-scroll';

import { Button } from './Button';
import { Icon } from './Icon';

export type TSidebarProps = {
  open: boolean;
  title: string;
  subtitle?: string;
  close: () => void;
  children: ComponentChildren;
  docked?: boolean;
  className?: string;
};

export const Sidebar: FC<TSidebarProps> = ({
  open,
  title,
  subtitle,
  close,
  children,
  docked = false,
  className = '',
}) => {
  const mobile = useMediaQuery('(max-width: 760px), (max-width: 1000px) and (pointer: coarse)'),
    id = useId();
  const [present, setPresent] = useState(open);

  useLayoutEffect(() => {
    if (open) {
      setPresent(true);

      return;
    }

    const duration =
      interfaceSettings().animations &&
      !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? 180
        : 0;

    if (!duration) {
      setPresent(false);

      return;
    }

    const timer = setTimeout(() => setPresent(false), duration);

    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (open && (mobile || !docked)) return lockPageScroll();
  }, [open, mobile, docked]);

  if (!present) return null;

  const content = (
    <div
      class={`sidebar-presence ${docked ? 'is-docked' : 'is-overlay'} ${open ? 'is-open' : 'is-closing'} ${className}`}
    >
      {(!docked || mobile) && (
        <button
          class="sidebar-backdrop"
          tabIndex={-1}
          aria-label={`Закрыть ${title.toLowerCase()}`}
          onClick={close}
        />
      )}
      <aside
        class="media-sidebar"
        role={mobile || !docked ? 'dialog' : 'complementary'}
        aria-modal={mobile || !docked ? true : undefined}
        aria-labelledby={id}
        aria-hidden={!open}
        inert={!open}
        data-sidebar-open={open}
      >
        <header class="sidebar-header">
          <div>
            <h2 id={id}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <Button
            aria-label="Закрыть панель"
            onClick={close}
            variant="icon"
            class="sidebar-close"
            data-tv-close
          >
            <Icon name="close" />
          </Button>
        </header>
        <div class="sidebar-scroll">{children}</div>
      </aside>
    </div>
  );

  return mobile || !docked
    ? createPortal(content, document.fullscreenElement || document.body)
    : content;
};
