import { AppLink } from '~/ui/AppLink';
import type { ComponentChildren, FunctionalComponent as FC } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { downloadsAvailable } from '~/lib/downloads';
import { useMediaQuery, useSession } from '~/lib/hooks';
import { focusTarget, keyboardTargets } from '~/lib/keyboard-navigation';
import { isTvMode } from '~/lib/tv-mode';
import { social } from '~/lib/social';
import { UnreadBadge } from './Social';

import { Avatar, ButtonLink, Icon, Sidebar, type IconName } from '~/ui';

const sections: { href: string; icon: IconName; title: string }[] = [
  { href: '/', icon: 'home', title: 'Каталог' },
  { href: '/catalog', icon: 'grid', title: 'Все аниме' },
  { href: '/search', icon: 'search', title: 'Поиск' },
  { href: '/schedule', icon: 'calendar', title: 'Расписание' },
];
const downloadsSection = { href: '/downloads', icon: 'download' as const, title: 'Загрузки' };
const phoneSections = [
  ...sections.filter(section => section.href !== '/catalog'),
  { href: '/profile', icon: 'user' as const, title: 'Профиль' },
];

export type TMediaNavigationProps = {
  path: string;
  selected: string;
  watching?: boolean;
  history?: ComponentChildren;
  updateNotice?: ComponentChildren;
};

export const MediaNavigation: FC<TMediaNavigationProps> = ({
  path,
  selected,
  watching = false,
  history,
  updateNotice,
}) => {
  const narrow = useMediaQuery('(max-width: 760px), (max-width: 1000px) and (pointer: coarse)'),
    mobile = narrow && !isTvMode(),
    session = useSession(),
    [open, setOpen] = useState(false);
  const root = useRef<HTMLElement>(null);
  const showDownloads = downloadsAvailable();
  const downloadsSelected = selected === '/downloads' || selected.startsWith('/downloads/');

  useEffect(() => setOpen(false), [path]);

  useEffect(() => {
    const menu = () => {
      if (mobile) setOpen(true);
      else if (root.current) {
        const targets = keyboardTargets(root.current),
          target = targets.find(node => node.matches('[aria-current=page],.active')) || targets[0];

        if (target) focusTarget(target);
      }
    };

    window.addEventListener('yumiwatch:menu', menu);

    return () => window.removeEventListener('yumiwatch:menu', menu);
  }, [mobile]);

  const content = (
    <>
      <AppLink class="media-brand" tabIndex={-1} href="#/" aria-label="YummyWatch — каталог">
        <img src={`${import.meta.env.BASE_URL}icons/icon.svg`} alt="" width="38" height="38" />
        <span>
          Yummy<span>Watch</span>
          <small>АНИМЕ ПОД РУКОЙ</small>
        </span>
      </AppLink>
      <nav class="media-navigation" aria-label="Разделы медиакаталога">
        {(showDownloads ? [...sections, downloadsSection] : sections).map(section => {
          const active =
            section === downloadsSection ? downloadsSelected : selected === section.href;

          return (
            <AppLink
              key={section.href}
              href={`#${section.href}`}
              class={active ? 'active' : ''}
              aria-current={active ? 'page' : undefined}
            >
              <Icon name={section.icon} size={22} />
              <span>{section.title}</span>
            </AppLink>
          );
        })}
      </nav>
      <div class="media-system-links">
        {session && (
          <>
            <AppLink
              href="#/notifications"
              class={selected === '/notifications' ? 'active' : ''}
              aria-current={selected === '/notifications' ? 'page' : undefined}
            >
              <Icon name="bell" size={22} />
              <span>Уведомления</span>
              <UnreadBadge
                count={social.value.userId === session.user.id ? social.value.notificationCount : 0}
              />
            </AppLink>
            <AppLink
              href="#/messages"
              class={selected === '/messages' ? 'active' : ''}
              aria-current={selected === '/messages' ? 'page' : undefined}
            >
              <Icon name="comment" size={22} />
              <span>Сообщения</span>
              <UnreadBadge
                count={social.value.userId === session.user.id ? social.value.messageCount : 0}
              />
            </AppLink>
          </>
        )}
        <div class="media-settings-row">
          <AppLink class={path.startsWith('/settings') ? 'active' : ''} href="#/settings">
            <Icon name="settings" size={22} />
            <span>Настройки</span>
          </AppLink>
          {updateNotice}
        </div>
        <AppLink
          class={`media-account ${selected === '/profile' || selected === '/account' ? 'active' : ''}`}
          href="#/profile"
          aria-current={selected === '/profile' || selected === '/account' ? 'page' : undefined}
          aria-label={
            session
              ? `${session.verified ? 'Аккаунт' : 'Проверяем аккаунт'} ${session.user.nickname}`
              : 'Твой профиль'
          }
        >
          <span class="media-account-avatar">
            {session ? (
              <Avatar url={session.user.avatar} name={session.user.nickname} />
            ) : (
              <Icon name="user" size={20} />
            )}
          </span>
          <span>{session?.user.nickname || 'Твой профиль'}</span>
        </AppLink>
      </div>
    </>
  );

  const openMenu = useCallback(() => setOpen(true), []);

  const closeMenu = useCallback(() => setOpen(false), []);

  return mobile ? (
    <>
      <header class="phone-header" hidden={watching}>
        {history && <div class="media-sidebar-chrome">{history}</div>}
        <AppLink href="#/" class="phone-brand" aria-label="YummyWatch — каталог">
          <img src={`${import.meta.env.BASE_URL}icons/icon.svg`} width="30" height="30" alt="" />
          Yummy<span>Watch</span>
        </AppLink>
        {showDownloads && (
          <ButtonLink
            href="#/downloads"
            variant="icon"
            aria-label="Загрузки"
            aria-current={downloadsSelected ? 'page' : undefined}
            title="Загрузки"
            class="phone-downloads"
          >
            <Icon name="download" size={22} />
          </ButtonLink>
        )}
        {session && (
          <ButtonLink
            href="#/notifications"
            variant="icon"
            aria-label="Уведомления"
            class="phone-notifications"
          >
            <Icon name="bell" size={22} />
            <UnreadBadge
              count={social.value.userId === session.user.id ? social.value.notificationCount : 0}
            />
          </ButtonLink>
        )}
        <ButtonLink
          href="#/profile"
          aria-label={session ? `Аккаунт ${session.user.nickname}` : 'Твой профиль'}
          variant="icon"
          class="phone-account"
        >
          {session ? (
            <Avatar url={session.user.avatar} name={session.user.nickname} />
          ) : (
            <Icon name="user" size={22} />
          )}
        </ButtonLink>
      </header>
      <nav class="phone-nav" aria-label="Основные разделы" hidden={watching}>
        {phoneSections.map(section => {
          const active =
            selected === section.href || (section.href === '/' && selected === '/catalog');

          return (
            <AppLink
              key={section.href}
              href={`#${section.href}`}
              class={active ? 'active' : ''}
              aria-current={active ? 'page' : undefined}
            >
              <Icon name={section.icon} size={22} />
              <span>{section.title}</span>
            </AppLink>
          );
        })}
        <button
          class={`media-menu-trigger ${/^\/(settings|account|users|notifications|messages)(\/|\?|$)/.test(path) ? 'active' : ''}`}
          aria-label={updateNotice ? 'Открыть меню · доступно обновление' : 'Открыть меню'}
          data-update-available={updateNotice ? '' : undefined}
          aria-expanded={open}
          onClick={openMenu}
        >
          <Icon name="list" size={22} />
          <span>Ещё</span>
        </button>
      </nav>
      <Sidebar
        open={open && !watching}
        title="Меню"
        close={closeMenu}
        className="navigation-sidebar"
      >
        {content}
      </Sidebar>
    </>
  ) : (
    <aside
      ref={root}
      class={`media-nav ${watching ? 'is-away' : ''}`}
      aria-hidden={watching}
      inert={watching}
      aria-label="Навигация медиакаталога"
    >
      {history && <div class="media-sidebar-chrome">{history}</div>}
      {content}
    </aside>
  );
};
