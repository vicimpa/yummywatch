import { animeSiteUrl } from '~/lib/content-links';
import { AppLink } from '~/ui/AppLink';
import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { cardContext } from '~/lib/card-context';
import { useLibrary, useSession } from '~/lib/hooks';
import { removeContinue, setAnimeList, toggleFavorite } from '~/lib/library';
import { WATCH_LISTS } from '~/lib/lists';
import { canStartAnime } from '~/lib/player';
import { notify } from '~/lib/notifications';
import { downloadPoster, posterUrl } from '~/lib/poster-download';
import { getSession } from '~/lib/session';
import { Icon, type IconName } from '~/ui';
import './CardContextMenu.css';

export function CardContextMenu() {
  const request = cardContext.value;
  const library = useLibrary();
  const session = useSession();
  const menu = useRef<HTMLDivElement>(null);
  const listTrigger = useRef<HTMLButtonElement>(null);
  const returningFromLists = useRef(false);
  const [lists, setLists] = useState(false);
  const returnToMenu = () => {
    returningFromLists.current = true;
    setLists(false);
  };
  const close = (restore = false) => {
    const source = cardContext.value?.source;
    cardContext.value = null;
    if (restore && source?.isConnected) {
      const target = source.matches('a,button')
        ? source
        : source.querySelector<HTMLElement>('a[data-gallery-link]') ||
          source.querySelector<HTMLElement>('a:not([tabindex="-1"]),button:not(:disabled)');
      target?.focus({ preventScroll: true });
    }
  };

  useEffect(() => {
    const suppress = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;

      // Keep editing and copying available in native WebView context menus.
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      if (
        window.getSelection()?.toString() &&
        target?.closest(
          '[data-selectable], .full-synopsis, .comment-text, .card-caption, .watch-title, .anime-facts'
        )
      )
        return;

      event.preventDefault();
    };
    document.addEventListener('contextmenu', suppress);
    return () => {
      document.removeEventListener('contextmenu', suppress);
      cardContext.value = null;
    };
  }, []);
  useEffect(() => {
    close();
  }, [session?.token]);
  useLayoutEffect(() => {
    if (!request || !menu.current) return;
    const element = menu.current;
    const rect = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(request.x, innerWidth - rect.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(request.y, innerHeight - rect.height - 8))}px`;
    const target = returningFromLists.current
      ? listTrigger.current
      : element.querySelector<HTMLElement>('[role=menuitem]:not(:disabled)');
    returningFromLists.current = false;
    target?.focus({ preventScroll: true });
    const dismiss = () => {
      if (lists) returnToMenu();
      else close(true);
    };
    element.addEventListener('yumiwatch:tv-dismiss', dismiss);
    return () => element.removeEventListener('yumiwatch:tv-dismiss', dismiss);
  }, [request, lists]);
  useEffect(() => {
    setLists(false);
  }, [request]);
  useEffect(() => {
    if (!request) return;
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) close();
    };
    const scroll = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) close();
    };
    const dismiss = () => close();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (lists) returnToMenu();
        else close(true);
      }
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('hashchange', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('hashchange', dismiss);
    };
  }, [request, lists]);
  if (!request) return null;
  const { anime } = request;
  const favorite = library.favorites.some(value => value.anime_id === anime.anime_id);
  const continuing = library.history.some(value => value.anime.anime_id === anime.anime_id);
  const selected = WATCH_LISTS.find(list =>
    library.lists?.[list.id]?.some(value => value.anime_id === anime.anime_id)
  );
  const execute = (action: () => void | Promise<void>) => {
    if ((getSession()?.token || null) !== request.owner) {
      close();
      return;
    }
    close(true);
    void Promise.resolve()
      .then(action)
      .catch(error =>
        notify(error instanceof Error ? error.message : 'Не удалось выполнить действие.')
      );
  };
  const action = (
    label: string,
    icon: IconName,
    run: () => void | Promise<void>,
    disabled = false,
    danger = false
  ) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      class={danger ? 'is-danger' : ''}
      onClick={() => execute(run)}
    >
      <Icon name={icon} size={17} />
      <span>{label}</span>
    </button>
  );
  return createPortal(
    <div
      ref={menu}
      class="card-context-menu"
      data-card-context-menu
      role="menu"
      aria-label={`Действия с «${anime.title}»`}
      style={{ left: request.x, top: request.y }}
      onContextMenu={event => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={event => {
        event.stopPropagation();
        const targets = [
          ...menu.current!.querySelectorAll<HTMLElement>('[role=menuitem]:not(:disabled)'),
        ];
        const index = targets.indexOf(document.activeElement as HTMLElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? targets.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + targets.length) % targets.length;
          targets[next]?.focus();
        } else if (event.key === 'Tab') {
          event.preventDefault();
          close(true);
        } else if (event.key === 'ArrowLeft' && lists) {
          event.preventDefault();
          returnToMenu();
        }
      }}
    >
      <div class="card-context-title">{anime.title}</div>
      {lists ? (
        <>
          <button type="button" role="menuitem" onClick={returnToMenu}>
            <Icon name="back" size={17} />
            Назад
          </button>
          {WATCH_LISTS.map(list =>
            action(
              `${selected?.id === list.id ? '✓ ' : ''}${list.title}`,
              list.icon,
              async () => {
                await setAnimeList(anime, list.id);
                notify(`Добавлено в «${list.title}»`);
              },
              library.loading
            )
          )}
          {selected &&
            action(
              'Убрать из списка',
              'close',
              async () => {
                await setAnimeList(anime, null);
                notify('Убрано из списка');
              },
              library.loading
            )}
        </>
      ) : (
        <>
          <AppLink
            role="menuitem"
            href={`#/anime/${anime.anime_id}?view=anime-about`}
            publicHref={animeSiteUrl(anime)}
            onClick={() => close()}
          >
            <Icon name="grid" size={17} />
            Открыть тайтл
          </AppLink>
          {(continuing || canStartAnime(anime)) && (
            <AppLink
              role="menuitem"
              href={`#/anime/${anime.anime_id}?view=watch&play=1${continuing ? '' : '&start=1'}`}
              publicHref={animeSiteUrl(anime)}
              onClick={() => close()}
            >
              <Icon name="play" size={17} />
              {continuing ? 'Продолжить просмотр' : 'Начать просмотр'}
            </AppLink>
          )}
          {anime.anime_url && (
            <AppLink
              role="menuitem"
              href={`https://ru.yummyani.me/catalog/item/${encodeURIComponent(anime.anime_url)}`}
              target="_blank"
              rel="noreferrer"
              onClick={() => close()}
            >
              <Icon name="external" size={17} />
              Открыть на YummyAnime
            </AppLink>
          )}
          <div role="separator" />
          {action(
            favorite ? 'Убрать из избранного' : 'В избранное',
            favorite ? 'check' : 'bookmark',
            async () => {
              const added = await toggleFavorite(anime);
              notify(added ? 'Добавлено в избранное' : 'Удалено из избранного');
            },
            library.loading
          )}
          <button
            ref={listTrigger}
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={lists}
            onClick={() => setLists(true)}
          >
            <Icon name="list" size={17} />
            <span>Изменить список…</span>
            <Icon name="chevron" size={14} />
          </button>
          <div role="separator" />
          {action(
            'Скачать постер',
            'download',
            async () => {
              await downloadPoster(anime);
              notify('Постер сохранён в «Загрузки»');
            },
            !posterUrl(anime)
          )}
          {action('Скопировать название', 'copy', async () => {
            await navigator.clipboard.writeText(anime.title);
            notify('Название скопировано');
          })}
          {action('Скопировать ссылку', 'link', async () => {
            await navigator.clipboard.writeText(animeSiteUrl(anime));
            notify('Ссылка скопирована');
          })}
          {continuing && (
            <>
              <div role="separator" />
              {action(
                'Убрать из «Продолжить просмотр»',
                'trash',
                () => {
                  removeContinue(anime.anime_id);
                  notify('Убрано из «Продолжить просмотр»');
                },
                false,
                true
              )}
            </>
          )}
        </>
      )}
    </div>,
    document.fullscreenElement || document.body
  );
}
