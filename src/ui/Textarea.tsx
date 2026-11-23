import type { FunctionalComponent as FC, JSX } from 'preact';
import { forwardRef } from 'preact/compat';
import { isTvMode } from '~/lib/tv-mode';

export type TTextareaProps = JSX.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea: FC<TTextareaProps> = forwardRef<HTMLTextAreaElement, TTextareaProps>(
  (props, ref) => {
    const readOnly = typeof props.readOnly === 'object' ? props.readOnly.value : props.readOnly;
    const tvEditor = !readOnly && isTvMode();
    return (
      <textarea
        {...props}
        readOnly={tvEditor || props.readOnly}
        data-tv-editor={tvEditor || undefined}
        ref={ref}
      />
    );
  }
);
