import type { ComponentChildren, FunctionalComponent as FC, JSX } from 'preact';

export type TSettingsCardProps = Omit<JSX.HTMLAttributes<HTMLElement>, 'title' | 'class'> & {
  title: ComponentChildren;
  description?: ComponentChildren;
  icon: ComponentChildren;
  iconClass?: string;
  class?: string;
};

export const SettingsCard: FC<TSettingsCardProps> = ({
  title,
  description,
  icon,
  iconClass,
  class: className,
  children,
  ...props
}) => (
  <section
    data-tv-focus-group
    {...props}
    class={['settings-card', className].filter(Boolean).join(' ')}
  >
    <div class={['settings-icon', iconClass].filter(Boolean).join(' ')}>{icon}</div>
    <div>
      <h2>{title}</h2>
      {description != null && <p>{description}</p>}
      {children}
    </div>
  </section>
);
