import type { FunctionalComponent as FC } from 'preact';
import { useCallback, useState } from 'preact/hooks';

import { useLibrary } from '~/lib/hooks';
import { toggleFavorite } from '~/lib/library';
import { notify } from '~/lib/notifications';
import type { Anime } from '~/lib/types';

import { Icon } from '~/ui';

export type TFavoriteButtonProps = { anime: Anime; compact?: boolean };

export const FavoriteButton: FC<TFavoriteButtonProps> = ({ anime, compact = false }) => {
  const library = useLibrary();
  const [busy, setBusy] = useState(false);
  const favorite = library.favorites.some(a => a.anime_id === anime.anime_id);

  const saveFavorite = useCallback(async () => {
    setBusy(true);
    try {
      const added = await toggleFavorite(anime);

      notify(added ? 'Добавлено в избранное' : 'Удалено из избранного');
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, [anime]);

  return (
    <button
      class={`${compact ? 'save-button' : 'button secondary'} ${favorite ? 'saved' : ''}`}
      data-tv-skip={compact || undefined}
      disabled={busy || library.loading}
      aria-busy={busy}
      aria-label={
        favorite ? `Убрать «${anime.title}» из избранного` : `Добавить «${anime.title}» в избранное`
      }
      aria-pressed={favorite}
      onClick={saveFavorite}
    >
      <Icon name={favorite ? 'check' : 'bookmark'} size={compact ? 17 : 19} />
      {!compact && <span>{favorite ? 'В избранном' : 'В избранное'}</span>}
    </button>
  );
};
