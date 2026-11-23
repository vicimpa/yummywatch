import type { FunctionalComponent as FC, JSX } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { browserFullscreenElement } from '~/lib/desktop';
import { Icon } from './Icon';
import './Dropdown.css';

type Props = {
  value: string;
  options: readonly { value: string; label: string; disabled?: boolean }[];
  onChange: (value: string) => void;
  'aria-label': string;
  'aria-describedby'?: string;
  'aria-invalid'?: JSX.AriaAttributes['aria-invalid'];
  'aria-required'?: JSX.AriaAttributes['aria-required'];
  'data-nav-primary'?: boolean;
  id?: string;
  disabled?: boolean;
};

export const Dropdown: FC<Props> = ({ value, options, onChange, disabled, ...props }) => {
  const id = useId();
  const buttonId = props.id || `${id}-trigger`;
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const selected = options.findIndex(option => option.value === value);
  const enabled = options.flatMap((option, index) => (option.disabled ? [] : [index]));
  const initial = enabled.includes(selected) ? selected : enabled[0];
  const [expanded, setExpanded] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const open = expanded && !disabled && enabled.length > 0;
  const active = enabled.includes(highlighted) ? highlighted : initial;
  const dialog = open ? trigger.current?.closest<HTMLDialogElement>('dialog[open]') : undefined;
  const [position, setPosition] = useState<JSX.CSSProperties>({});
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    setExpanded(false);
    trigger.current?.focus({ preventScroll: true });
    if (option.value !== value) onChange(option.value);
  };

  useLayoutEffect(() => {
    if (!open) {
      if (expanded) setExpanded(false);
      return;
    }
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const bounds = dialog?.getBoundingClientRect();
      const left = bounds?.width ? Math.max(8, bounds.left + 8) : 8;
      const right = bounds?.width
        ? Math.min(window.innerWidth - 8, bounds.right - 8)
        : window.innerWidth - 8;
      const below = (bounds?.height ? bounds.bottom : window.innerHeight) - rect.bottom - 12;
      const above = rect.top - (bounds?.height ? bounds.top : 0) - 12;
      const upwards = below < 220 && above > below;
      const width = Math.max(0, Math.min(Math.max(rect.width, 132), right - left));
      setPosition({
        left: Math.max(left, Math.min(rect.left, right - width)),
        width,
        maxHeight: Math.max(0, Math.min(280, upwards ? above : below)),
        ...(upwards ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
      });
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) setExpanded(false);
    };
    const fullscreenChange = () => setExpanded(false);
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('fullscreenchange', fullscreenChange);
    document.addEventListener('webkitfullscreenchange', fullscreenChange);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('fullscreenchange', fullscreenChange);
      document.removeEventListener('webkitfullscreenchange', fullscreenChange);
    };
  }, [open, expanded, dialog]);

  useEffect(() => {
    if (open) menu.current?.children[active]?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  const keydown = (event: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => {
    if (disabled || !enabled.length || event.isComposing) return;
    if (!open && event.key !== 'Enter' && event.key !== ' ') return;
    if (open && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === 'Tab') {
      setExpanded(false);
      return;
    }
    if (event.key === 'Escape' || event.key === 'Backspace') {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        setExpanded(false);
      }
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (!open) {
        setHighlighted(
          event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1)! : initial
        );
        setExpanded(true);
      } else if (event.key === 'Enter' || event.key === ' ') choose(active);
      else if (event.key === 'Home') setHighlighted(enabled[0]);
      else if (event.key === 'End') setHighlighted(enabled.at(-1)!);
      else {
        const offset = event.key === 'ArrowDown' ? 1 : -1;
        const index = enabled.indexOf(active) + offset;
        setHighlighted(enabled[Math.max(0, Math.min(index, enabled.length - 1))]);
      }
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const match = enabled.find(index =>
        options[index].label.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase())
      );
      if (match !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        setHighlighted(match);
        setExpanded(true);
      }
    }
  };

  return (
    <>
      <button
        {...props}
        id={buttonId}
        type="button"
        value={value}
        disabled={disabled || !enabled.length}
        class="settings-dropdown"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        ref={trigger}
        onMouseDown={event => {
          // Keep focus on the open trigger until click toggles the list.
          if (open && event.button === 0) event.preventDefault();
        }}
        onClick={() => {
          trigger.current?.focus({ preventScroll: true });
          setHighlighted(initial);
          setExpanded(!open);
        }}
        onBlur={event => {
          if (!menu.current?.contains(event.relatedTarget as Node)) setExpanded(false);
        }}
        onKeyDown={keydown}
      >
        <span>{options[selected]?.label ?? options[0]?.label}</span>
        <Icon name="chevron" size={16} />
      </button>
      {open &&
        createPortal(
          <div
            id={id}
            ref={menu}
            role="listbox"
            aria-labelledby={buttonId}
            class="settings-dropdown-menu"
            style={position}
          >
            {options.map((option, index) => (
              <button
                type="button"
                role="option"
                id={`${id}-${index}`}
                key={option.value}
                tabIndex={-1}
                value={option.value}
                disabled={option.disabled}
                aria-selected={option.value === value}
                class={active === index ? 'is-active' : ''}
                onPointerDown={event => event.preventDefault()}
                onPointerMove={() => !option.disabled && setHighlighted(index)}
                onClick={() => choose(index)}
              >
                <span>{option.label}</span>
                {option.value === value && <Icon name="check" size={16} />}
              </button>
            ))}
          </div>,
          dialog || browserFullscreenElement() || document.body
        )}
    </>
  );
};
