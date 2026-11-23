import type { FunctionalComponent as FC } from 'preact';
import { useCallback, useState } from 'preact/hooks';

import { useLibrary } from '~/lib/hooks';
import { setAnimeList } from '~/lib/library';
import { WATCH_LISTS, type WatchListId } from '~/lib/lists';
import { notify } from '~/lib/notifications';
import type { Anime } from '~/lib/types';
import { FavoriteButton } from './FavoriteButton';
import { Button, FormError, Icon, Sheet } from '~/ui';

export type TAnimeListButtonProps = { anime: Anime; gridAction?: boolean };

export const AnimeListButton: FC<TAnimeListButtonProps> = ({ anime, gridAction }) => {
  const library = useLibrary();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selected = WATCH_LISTS.find(list =>
    library.lists?.[list.id]?.some(value => value.anime_id === anime.anime_id)
  );

  const choose = useCallback(
    async (id: WatchListId | null) => {
      if (busy) return;
      if (id === (selected?.id ?? null)) {
        setOpen(false);

        return;
      }
      setBusy(true);
      setError('');
      try {
        await setAnimeList(anime, id);
        setOpen(false);
        notify(
          id === null
            ? 'Убрано из списка'
            : `Добавлено в «${WATCH_LISTS.find(list => list.id === id)!.title}»`
        );
      } catch (error) {
        setError((error as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [busy, selected, anime]
  );

  const openLists = useCallback(() => {
    setError('');
    setOpen(true);
  }, []);

  const closeLists = useCallback(() => {
    if (!busy) setOpen(false);
  }, [busy]);

  const clearList = useCallback(() => void choose(null), [choose]);

  return (
    <div class="detail-list-control">
      <Button
        aria-haspopup="dialog"
        data-virtual-secondary={gridAction || undefined}
        disabled={library.loading}
        onClick={openLists}
        class="list-status-button"
      >
        <Icon name={selected ? 'check' : 'list'} size={17} />
        <span>{selected?.title || 'Добавить в список'}</span>
        <Icon name="chevron" size={15} />
      </Button>
      {open && (
        <Sheet
          title="В мою коллекцию"
          subtitle={anime.title}
          close={closeLists}
          className="list-picker"
        >
          <p class="filter-help">
            {library.account
              ? 'Сохраним в твоём аккаунте YummyAnime.'
              : 'Сохраним на этом устройстве. Гостевые списки хранятся отдельно от аккаунта.'}
          </p>
          {error && <FormError class="sheet-validation">{error}</FormError>}
          <div class="source-options">
            {WATCH_LISTS.map(list => (
              <button
                key={list.id}
                class={`source-option ${selected?.id === list.id ? 'selected' : ''}`}
                disabled={busy}
                aria-pressed={selected?.id === list.id}
                onClick={() => void choose(list.id)}
              >
                <span>
                  <strong style={{ color: list.color }}>{list.title}</strong>
                  <small>{list.hint}</small>
                </span>
                {selected?.id === list.id && <Icon name="check" size={20} />}
              </button>
            ))}
            {selected && (
              <button class="source-option" disabled={busy} onClick={clearList}>
                <span>
                  <strong>Убрать из списка</strong>
                  <small>Избранное и история останутся</small>
                </span>
                <Icon name="close" size={19} />
              </button>
            )}
          </div>
          <div class="list-picker-favorite">
            <p>Любимые аниме можно сохранить отдельно.</p>
            <FavoriteButton anime={anime} />
          </div>
          {busy && (
            <p role="status" class="filter-help">
              Сохраняем…
            </p>
          )}
        </Sheet>
      )}
    </div>
  );
};
