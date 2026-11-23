import type { FunctionalComponent as FC, JSX } from 'preact';
import { forwardRef } from 'preact/compat';
import { isTvTextInput } from '~/lib/tv-mode';

export type TInputProps = JSX.InputHTMLAttributes<HTMLInputElement>;

export const Input: FC<TInputProps> = forwardRef<HTMLInputElement, TInputProps>((props, ref) => {
  const type = typeof props.type === 'object' ? props.type.value : props.type;
  const readOnly = typeof props.readOnly === 'object' ? props.readOnly.value : props.readOnly;
  const tvEditor = !readOnly && isTvTextInput(type);
  return (
    <input
      {...props}
      readOnly={tvEditor || props.readOnly}
      data-tv-editor={tvEditor || undefined}
      ref={ref}
    />
  );
});
