import { animeSiteUrl } from '~/lib/content-links';
import { AppLink } from '~/ui/AppLink';
import type { FunctionalComponent as FC } from 'preact';
import { useCallback, useMemo, useState } from 'preact/hooks';

import { imageUrl, plainText } from '~/lib/api';
import { cardMenuEvents } from '~/lib/card-context';
import { playbackUrl, videoPosition } from '~/lib/player';
import { groupVoices } from '~/lib/streams';
import type { Anime, Result, Video, WatchEntry } from '~/lib/types';

import { AboutEpisodes, AnimeEpisodeList } from './AboutEpisodes';
import { AnimeRatingStats } from './AnimeRatingStats';
import { PersonalRating } from './PersonalRating';
import { EpisodeSubscriptionButton, useEpisodeSubscriptions } from './EpisodeSubscription';
import { ArtworkImage, Button, ButtonLink, Icon, Sheet } from '~/ui';

export type TAnimeAboutProps = {
  anime: Anime;
  videos: {
    value?: Result<Video[]>;
    loading: boolean;
    error: string;
    retry: () => void;
  };
  history?: WatchEntry;
  episodesOpen?: boolean;
  closeEpisodes?: () => void;
  onRatingSaved?: () => void;
};

const EMPTY_VIDEOS: Video[] = [];

const closeNothing = () => {};
const saveNothing = () => {};

export const AnimeAbout: FC<TAnimeAboutProps> = ({
  anime,
  videos,
  history,
  episodesOpen = false,
  closeEpisodes = closeNothing,
  onRatingSaved = saveNothing,
}) => {
  const subscriptions = useEpisodeSubscriptions(anime.anime_id);
  const all = Array.isArray(videos.value?.data) ? videos.value.data : EMPTY_VIDEOS;
  const groups = useMemo(
    () =>
      groupVoices(all).map(group => {
        const providers = new Map<number, Video[]>();

        for (const video of group.videos) {
          const choices = providers.get(video.data.player_id);

          if (choices) choices.push(video);
          else providers.set(video.data.player_id, [video]);
        }

        return {
          ...group,
          providers: [...providers.values()].map(choices =>
            choices.sort((a, b) => a.number.localeCompare(b.number, 'ru', { numeric: true }))
          ),
        };
      }),
    [all]
  );
  const voices = useMemo(
    () =>
      groups.map(group => ({
        ...group,
        providers: group.providers.map(choices => {
          const video = choices.find(video => video.number === history?.episode) || choices[0];

          return { video, href: playbackUrl(video, videoPosition(video, history).position) };
        }),
      })),
    [groups, history]
  );
  const frames = useMemo(
    () =>
      (anime.random_screenshots || []).filter(frame =>
        imageUrl(frame.sizes.full || frame.sizes.small)
      ),
    [anime.random_screenshots]
  );
  const description = useMemo(() => plainText(anime.description), [anime.description]);
  const [selectedVoice, setSelectedVoice] = useState('');
  const episodeList = {
    anime,
    videos: all,
    history,
    loading: videos.loading,
    error: videos.error,
    retry: videos.retry,
    selectedVoice,
    onVoiceChange: setSelectedVoice,
    renderSubscription: (key: string) => {
      const group = voices.find(voice => voice.key === key);
      if (!group?.providers.length) return;
      if (group.providers.length === 1)
        return (
          <EpisodeSubscriptionButton
            video={group.providers[0].video}
            subscription={subscriptions}
          />
        );
      return (
        <details key={key} class="episode-original-players">
          <summary>
            <Icon name="bell" size={15} /> Уведомлять о сериях
          </summary>
          {group.providers.map(({ video }) => (
            <div class="voice-subscription" key={video.data.player_id}>
              <span>{video.data.player.replace(/^Плеер /, '')}</span>
              <EpisodeSubscriptionButton video={video} subscription={subscriptions} />
            </div>
          ))}
        </details>
      );
    },
  };
  const [frame, setFrame] = useState<number>();
  const closeFrame = useCallback(() => setFrame(undefined), []);
  const previousFrame = useCallback(
    () => setFrame(previous => ((previous || 0) - 1 + frames.length) % frames.length),
    [frames.length]
  );
  const nextFrame = useCallback(
    () => setFrame(previous => ((previous || 0) + 1) % frames.length),
    [frames.length]
  );

  return (
    <div class="anime-about-content">
      <section class="about-description" aria-labelledby="anime-description">
        <div class="section-heading">
          <h2 id="anime-description">Об аниме</h2>
        </div>
        <div class="detail-genres">
          {anime.genres?.map(genre => (
            <AppLink key={genre.id} href={`#/catalog?genres=${encodeURIComponent(genre.alias)}`}>
              {genre.title}
            </AppLink>
          ))}
        </div>
        <p class="full-synopsis">{description || 'Описание ещё не добавлено.'}</p>
        {!!frames.length && (
          <section class="about-screenshots" aria-label="Скриншоты аниме">
            <div class="screenshot-rail">
              {frames.map((image, index) => (
                <button
                  key={`${image.sizes.small}:${index}`}
                  aria-label={`Открыть скриншот ${index + 1}`}
                  onClick={() => setFrame(index)}
                >
                  <ArtworkImage
                    src={imageUrl(image.sizes.small || image.sizes.full)}
                    alt={image.episode ? `Кадр серии ${image.episode}` : `Кадр ${index + 1}`}
                    tone={index}
                  />
                  <span class="screenshot-open">
                    <Icon name="external" size={18} />
                  </span>
                  {image.episode && <small>Серия {image.episode}</small>}
                </button>
              ))}
            </div>
          </section>
        )}
        <dl class="anime-facts">
          <div>
            <dt>Год</dt>
            <dd>{anime.year || '—'}</dd>
          </div>
          <div>
            <dt>Формат</dt>
            <dd>{anime.type?.name || '—'}</dd>
          </div>
          <div>
            <dt>Статус</dt>
            <dd>{anime.anime_status?.title || '—'}</dd>
          </div>
          <div>
            <dt>Серии</dt>
            <dd>
              {anime.episodes?.aired || 0}
              {anime.episodes?.count ? ` / ${anime.episodes.count}` : ''}
            </dd>
          </div>
          {anime.studios?.length ? (
            <div>
              <dt>Студия</dt>
              <dd>{anime.studios.map(studio => studio.title).join(', ')}</dd>
            </div>
          ) : null}
          {anime.min_age?.title && (
            <div>
              <dt>Возраст</dt>
              <dd>{anime.min_age.title_long || anime.min_age.title}</dd>
            </div>
          )}
          {anime.episodes?.next_date && (
            <div>
              <dt>Следующая серия</dt>
              <dd>
                {new Date(anime.episodes.next_date * 1000).toLocaleString('ru', {
                  day: 'numeric',
                  month: 'long',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </dd>
            </div>
          )}
        </dl>
      </section>
      <AnimeRatingStats animeId={anime.anime_id}>
        <PersonalRating anime={anime} saved={onRatingSaved} />
      </AnimeRatingStats>
      <section class="about-voices" aria-label="Серии и озвучки">
        <div class="section-heading">
          <h2>Серии и озвучки</h2>
        </div>
        <div class="episodes-sidebar about-inline-episodes">
          <AnimeEpisodeList
            {...episodeList}
            active={!episodesOpen}
            renderSources={key => {
              const group = voices.find(voice => voice.key === key);
              return (
                group && (
                  <details key={group.key} class="episode-original-players">
                    <summary>Оригинальные плееры и подписки</summary>
                    <div class="voice-original-players">
                      {group.providers.map(({ video, href }) => (
                        <div key={video.data.player_id} class="voice-subscription">
                          <AppLink href={href} target="_blank" rel="noreferrer">
                            {video.data.player.replace(/^Плеер /, '')}
                            <Icon name="external" size={13} />
                          </AppLink>
                        </div>
                      ))}
                    </div>
                  </details>
                )
              );
            }}
          />
        </div>
      </section>
      {!!anime.viewing_order?.length && (
        <section class="about-order" id="viewing-order">
          <div class="section-heading">
            <h2>Порядок просмотра</h2>
          </div>
          <div class="viewing-order">
            {anime.viewing_order.map((item, index) => {
              const current = Number(item.anime_id) === Number(anime.anime_id);

              return (
                <AppLink
                  key={item.anime_id}
                  href={`#/anime/${item.anime_id}`}
                  publicHref={animeSiteUrl(item)}
                  aria-current={current ? 'page' : undefined}
                  {...cardMenuEvents(item)}
                >
                  <span>{index + 1}</span>
                  <strong>
                    {item.title}
                    {current && <span class="viewing-order-current">Текущий тайтл</span>}
                  </strong>
                  <small>{item.year}</small>
                  <Icon name="chevron" size={16} />
                </AppLink>
              );
            })}
          </div>
        </section>
      )}
      <ButtonLink
        href={`https://ru.yummyani.me/catalog/item/${encodeURIComponent(anime.anime_url)}`}
        target="_blank"
        rel="noreferrer"
        variant="text"
        class="about-original"
      >
        Открыть на YummyAnime
        <Icon name="external" size={16} />
      </ButtonLink>
      <AboutEpisodes {...episodeList} open={episodesOpen} close={closeEpisodes} />
      {frame !== undefined && frames[frame] && (
        <Sheet
          title={`Скриншот ${frame + 1} из ${frames.length}`}
          subtitle={anime.title}
          close={closeFrame}
          className="screenshot-viewer"
          onKeyDown={event => {
            if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
            if (event.key === 'ArrowRight') nextFrame();
            else if (event.key === 'ArrowLeft') previousFrame();
            else return;
            event.preventDefault();
          }}
          footer={
            <div class="screenshot-viewer-actions">
              <Button aria-label="Предыдущий скриншот" onClick={previousFrame}>
                <Icon name="back" />
                Назад
              </Button>
              <span>
                {frame + 1} / {frames.length}
              </span>
              <Button aria-label="Следующий скриншот" onClick={nextFrame}>
                Далее
                <Icon name="arrow" />
              </Button>
            </div>
          }
        >
          <ArtworkImage
            className="screenshot-artwork"
            imageClass="screenshot-full"
            src={imageUrl(frames[frame].sizes.full || frames[frame].sizes.small)}
            alt={`Скриншот ${frame + 1} — ${anime.title}`}
            eager
            tone={frame}
          />
        </Sheet>
      )}
    </div>
  );
};
