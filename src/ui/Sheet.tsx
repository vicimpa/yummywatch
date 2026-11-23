import type { ComponentChildren, ComponentProps, FunctionalComponent as FC, JSX } from 'preact';
import { useCallback, useId, useLayoutEffect, useRef } from 'preact/hooks';

import { lockPageScroll } from '~/lib/page-scroll';

import { Button } from './Button';
import { Icon } from './Icon';

export type TSheetProps = {
  title: string;
  subtitle?: string;
  close: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
  actions?: ComponentChildren;
  navigation?: ComponentChildren;
  className?: string;
  onKeyDown?: ComponentProps<'dialog'>['onKeyDown'];
};

export const Sheet: FC<TSheetProps> = ({
  title,
  subtitle,
  close,
  children,
  footer,
  actions,
  navigation,
  className = '',
  onKeyDown,
}) => {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const element = dialog.current!;
    const unlock = lockPageScroll();

    if (element.showModal) element.showModal();
    else element.setAttribute('open', '');

    return () => {
      if (element.open && element.close) element.close();
      unlock();
    };
  }, []);

  const cancel = useCallback(
    (event: JSX.TargetedEvent<HTMLDialogElement>) => {
      event.preventDefault();
      close();
    },
    [close]
  );

  const closeBackdrop = useCallback<NonNullable<ComponentProps<'dialog'>['onClick']>>(
    event => {
      if (event.target === dialog.current) close();
    },
    [close]
  );

  return (
    <dialog
      ref={dialog}
      class={`mobile-sheet ${className}`}
      aria-labelledby={id}
      onCancel={cancel}
      onClick={closeBackdrop}
      onKeyDown={onKeyDown}
    >
      <div class="mobile-sheet-layout">
        <header class="mobile-sheet-header">
          <Button type="button" onClick={close} aria-label="Закрыть" variant="icon" data-tv-close>
            <Icon name="close" />
          </Button>
          <div>
            <h2 id={id}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions && <div class="sheet-header-actions">{actions}</div>}
        </header>
        {navigation}
        <div class="modal-scroll">{children}</div>
        {footer && <footer class="mobile-sheet-footer">{footer}</footer>}
      </div>
    </dialog>
  );
};
