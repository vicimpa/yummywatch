import { AppLink } from '~/ui/AppLink';
import type { FunctionalComponent as FC, RefObject } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { CURRENT_SEASONS } from '~/data/catalog';
import { animeList, peekAnimeList, plainText } from '~/lib/api';
import { animeSiteUrl } from '~/lib/content-links';
import { navigateGallery } from '~/lib/gallery-navigation';
import { useLibrary, useResource } from '~/lib/hooks';
import { formatTime } from '~/lib/player';
import type { PlaybackMedia } from '~/lib/playback-media';
import type { Anime, WatchEntry } from '~/lib/types';
import { cardMenuEvents } from '~/lib/card-context';
import { usePictureInPictureCard } from '~/hooks/usePictureInPictureCard';
import { removeContinue } from '~/lib/library';
import { notify } from '~/lib/notifications';

import { WatchPreview } from './WatchPreview';
import { AnimeCard } from './AnimeCard';
import { FavoriteButton } from './FavoriteButton';
import { GalleryShelf } from './GalleryShelf';
import { Poster } from './Poster';
import { Button, ButtonLink, CachedNotice, CardSkeleton, ErrorState, Icon } from '~/ui';

type LiveWatch = { path: string; media: RefObject<PlaybackMedia> };
export type TGalleryProps = { active?: boolean; liveWatch?: LiveWatch };

export const Gallery: FC<TGalleryProps> = ({ active = true, liveWatch }) => {
  const now = new Date(),
    seasonIndex = Math.floor(now.getMonth() / 3),
    season = CURRENT_SEASONS[seasonIndex].value;
  const seasonName = CURRENT_SEASONS[seasonIndex].title;
  const ongoing = useResource(
    signal =>
      animeList(
        {
          status: 'ongoing',
          from_year: now.getFullYear(),
          to_year: now.getFullYear(),
          season,
          sort: 'views',
          sort_forward: false,
          limit: 12,
        },
        signal
      ),
    [],
    () =>
      peekAnimeList({
        status: 'ongoing',
        from_year: now.getFullYear(),
        to_year: now.getFullYear(),
        season,
        sort: 'views',
        sort_forward: false,
        limit: 12,
      })
  );
  const popular = useResource(
    signal => animeList({ sort: 'top', sort_forward: true, limit: 12 }, signal),
    [],
    () => peekAnimeList({ sort: 'top', sort_forward: true, limit: 12 })
  );
  const announces = useResource(
    signal =>
      animeList({ status: 'announcement', sort: 'views', sort_forward: false, limit: 12 }, signal),
    [],
    () => peekAnimeList({ status: 'announcement', sort: 'views', sort_forward: false, limit: 12 })
  );
  const wasActive = useRef(active);
  const library = useLibrary();
  const [feature, setFeature] = useState<Anime>();
  const liveAnime = Number(liveWatch?.path.split('?')[0]?.split('/')[2]);

  useEffect(() => {
    const returning = active && !wasActive.current;

    wasActive.current = active;
    if (returning) {
      ongoing.retry();
      popular.retry();
      announces.retry();
    }
  }, [active]);

  const choices = [
    ...new Map(
      [ongoing.value, popular.value, announces.value]
        .flatMap(result => result?.data || [])
        .map(anime => [anime.anime_id, anime] as const)
    ).values(),
  ];
  const chooseRandom = () => {
    const others = choices.filter(anime => anime.anime_id !== feature?.anime_id);
    if (others.length) setFeature(others[Math.floor(Math.random() * others.length)]);
  };
  const choicesKey = choices.map(anime => anime.anime_id).join(',');
  useEffect(() => {
    if (!feature && choices.length) chooseRandom();
  }, [choicesKey]);

  const resume =
    feature && library.history.find(entry => entry.anime.anime_id === feature.anime_id);

  const shelf = useCallback(
    (resource: typeof popular, title: string, href: string, subtitle?: string) => (
      <>
        {resource.error ? (
          <section class="section">
            <h2>{title}</h2>
            <ErrorState error={resource.error} retry={resource.retry} />
          </section>
        ) : (
          <GalleryShelf
            title={title}
            href={href}
            subtitle={subtitle}
            count={resource.value?.data.length || 0}
          >
            {resource.loading
              ? Array.from({ length: 6 }, (_, index) => <CardSkeleton key={index} />)
              : resource.value?.data.map(anime => <AnimeCard key={anime.anime_id} anime={anime} />)}
          </GalleryShelf>
        )}
        {resource.value?.cached && !resource.refreshing && (
          <CachedNotice savedAt={resource.value.savedAt} />
        )}
      </>
    ),
    []
  );

  return (
    <section class="gallery-screen" aria-label="Галерея аниме" onKeyDown={navigateGallery}>
      <header class="gallery-heading">
        <div>
          <h1>Каталог</h1>
          <p>Твои истории и новые открытия</p>
        </div>
      </header>
      {!!library.history.length && (
        <GalleryShelf
          title="Продолжить просмотр"
          className="continue-watching"
          href="#/profile?tab=history"
          count={library.history.length}
        >
          {library.history.slice(0, 12).map(entry => {
            const live = entry.anime.anime_id === liveAnime ? liveWatch : undefined;
            return (
              <article
                class="gallery-continue-card"
                data-gallery-item
                key={entry.anime.anime_id}
                {...cardMenuEvents(entry.anime)}
              >
                <AppLink
                  class="gallery-continue"
                  data-gallery-link
                  href={
                    live ? '#' + live.path : `#/anime/${entry.anime.anime_id}?view=watch&play=1`
                  }
                  publicHref={animeSiteUrl(entry.anime)}
                >
                  <ContinuePreview entry={entry} live={live} />
                  <h3>{entry.anime.title}</h3>
                </AppLink>
                <button
                  type="button"
                  class="continue-remove"
                  data-tv-skip
                  aria-label={`Убрать «${entry.anime.title}» из «Продолжить просмотр»`}
                  title="Убрать из «Продолжить просмотр»"
                  onClick={event => {
                    event.preventDefault();
                    event.stopPropagation();
                    try {
                      removeContinue(entry.anime.anime_id);
                      notify('Убрано из «Продолжить просмотр»');
                    } catch (error) {
                      notify((error as Error).message);
                    }
                  }}
                >
                  <Icon name="close" size={18} />
                </button>
              </article>
            );
          })}
        </GalleryShelf>
      )}
      {feature && (
        <section
          class="gallery-feature"
          aria-label="Выбранное аниме"
          data-tv-focus-group
          {...cardMenuEvents(feature)}
        >
          <div class="gallery-feature-poster">
            <Poster key={feature.anime_id} anime={feature} large />
          </div>
          <div class="gallery-feature-copy">
            <p class="eyebrow">СЛУЧАЙНОЕ АНИМЕ</p>
            <h2 aria-live="polite">{feature.title}</h2>
            <div class="gallery-feature-meta">
              {feature.rating?.average ? (
                <span class="hero-score">★ {feature.rating.average.toFixed(1)}</span>
              ) : null}
              <span>{feature.year}</span>
              <span>{feature.type?.name}</span>
              {feature.episodes?.aired ? <span>{feature.episodes.aired} серий</span> : null}
            </div>
            <p class="gallery-feature-description">
              {plainText(feature.description) ||
                feature.genres?.map(genre => genre.title).join(' · ') ||
                'Открой карточку, чтобы узнать больше об аниме.'}
            </p>
            <div class="gallery-feature-actions">
              <ButtonLink
                href={`#/anime/${feature.anime_id}?view=${resume ? 'watch&play=1' : 'anime-about'}`}
                publicHref={animeSiteUrl(feature)}
                variant="primary"
              >
                <Icon name={resume ? 'play' : 'arrow'} size={18} />
                {resume ? `Продолжить · серия ${resume.episode}` : 'Подробнее'}
              </ButtonLink>
              <Button
                class="gallery-random"
                aria-label="Другое аниме"
                onClick={chooseRandom}
                disabled={choices.length < 2}
              >
                <Icon name="refresh" size={18} />
                <span>Другое аниме</span>
              </Button>
              <FavoriteButton anime={feature} />
            </div>
          </div>
        </section>
      )}
      {shelf(
        ongoing,
        `${seasonName} сезон`,
        `#/catalog?status=ongoing&season=${season}&from_year=${now.getFullYear()}&to_year=${now.getFullYear()}`,
        String(now.getFullYear())
      )}
      {shelf(popular, 'Лучшие аниме', '#/catalog?sort=top', 'Рейтинг YummyAnime')}
      {shelf(announces, 'Скоро на экранах', '#/catalog?status=announcement')}
    </section>
  );
};

function ContinuePreview({ entry, live }: { entry: WatchEntry; live?: LiveWatch }) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const time = usePictureInPictureCard(canvas, live?.path, live?.media);
  const { position, duration } = time ?? entry;
  return (
    <div class="continue-image">
      <WatchPreview entry={entry} />
      {live && <canvas ref={setCanvas} class="continue-video" aria-hidden="true" hidden />}
      <span class="continue-series">Серия {entry.episode}</span>
      <span class="continue-time">
        {formatTime(position)}
        {duration ? ` / ${formatTime(duration)}` : ''}
      </span>
      <span class="continue-play">
        <Icon name="play" size={22} />
      </span>
      {duration ? (
        <span
          class="continue-progress"
          style={{ width: `${Math.min(100, ((position || 0) / duration) * 100)}%` }}
        />
      ) : null}
    </div>
  );
}
