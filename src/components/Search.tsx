import { AppLink } from '~/ui/AppLink';
import { isTvMode } from '~/lib/tv-mode';
import type { FunctionalComponent as FC, JSX } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import { useDiscordContext } from '~/hooks/useDiscordContext';
import { searchPresence } from '~/lib/discord-context';

import { animeList, peekAnimeList } from '~/lib/api';
import { navigateGallery } from '~/lib/gallery-navigation';
import { useResource } from '~/lib/hooks';
import { recentSearches, rememberSearch, removeSearch } from '~/lib/search';

import { AnimeCard } from './AnimeCard';
import { Button, ButtonLink, Empty, ErrorState, Form, Icon, Input, SEARCH_INPUT_PROPS } from '~/ui';

export type TSearchProps = { query: string; active?: boolean };

export const Search: FC<TSearchProps> = ({ query, active = true }) => {
  const initial = new URLSearchParams(query).get('q') || '';
  const [text, setText] = useState(initial);
  const [submitted, setSubmitted] = useState(initial);
  const activity = useMemo(
    () => (active ? searchPresence(submitted) : undefined),
    [active, submitted]
  );

  useDiscordContext(activity);
  const [recent, setRecent] = useState(recentSearches);
  const input = useRef<HTMLInputElement>(null);
  const resource = useResource(
    signal =>
      submitted.trim().length >= 2
        ? animeList({ q: submitted.trim(), limit: 20 }, signal)
        : Promise.resolve({ data: [], cached: false, savedAt: Date.now() }),
    [submitted],
    () =>
      submitted.trim().length >= 2 ? peekAnimeList({ q: submitted.trim(), limit: 20 }) : undefined
  );
  const wasActive = useRef(active);

  useEffect(() => {
    if (active && !wasActive.current) resource.retry();
    wasActive.current = active;
  }, [active]);

  const previousQuery = useRef(query);

  useEffect(() => {
    if (previousQuery.current === query) return;
    previousQuery.current = query;
    setText(initial);
    setSubmitted(initial);
  }, [query]);

  useLayoutEffect(() => {
    if (active && !text && !isTvMode()) input.current?.focus({ preventScroll: true });
  }, [active]);

  useEffect(() => {
    const timer = setTimeout(() => setSubmitted(text.trim()), 300);

    return () => clearTimeout(timer);
  }, [text]);

  const choose = useCallback((value: string) => {
    setText(value);
    setSubmitted(value);
    input.current?.focus();
  }, []);

  const submit = useCallback(
    (event: JSX.TargetedSubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      setSubmitted(text.trim());
      rememberSearch(text);
      setRecent(recentSearches());
      input.current?.blur();
    },
    [text]
  );

  const changeText = useCallback(
    (event: JSX.TargetedInputEvent<HTMLInputElement>) => setText(event.currentTarget.value),
    []
  );

  const clearQuery = useCallback(() => {
    choose('');
  }, [choose]);

  const clearRecent = useCallback(() => {
    removeSearch();
    setRecent([]);
  }, []);

  const rememberQuery = useCallback(() => rememberSearch(text), [text]);

  return (
    <section
      class="search-screen gallery-search-screen"
      onKeyDown={navigateGallery}
      aria-label="Поиск аниме"
    >
      <div class="screen-title">
        <div>
          <h1>Найди своё аниме</h1>
          <p>На русском, английском или японском</p>
        </div>
      </div>
      <Form class="search-field" role="search" onSubmit={submit}>
        <Icon name="search" size={22} />
        <Input
          ref={input}
          id="anime-search"
          type="search"
          {...SEARCH_INPUT_PROPS}
          value={text}
          onInput={changeText}
          placeholder="Название аниме"
          aria-label="Поиск аниме"
          maxLength={500}
          enterKeyHint="search"
        />
        {text && (
          <Button type="button" aria-label="Очистить поиск" onClick={clearQuery} variant="icon">
            <Icon name="close" size={20} />
          </Button>
        )}
      </Form>
      {!text.trim() ? (
        <>
          <div class="search-section-title">
            <h2>Недавно искали</h2>
            {recent.length > 0 && (
              <Button onClick={clearRecent} variant="text">
                Очистить
              </Button>
            )}
          </div>
          {recent.length ? (
            <div class="recent-searches">
              {recent.map(value => (
                <div key={value}>
                  <button class="recent-query" onClick={() => choose(value)}>
                    <Icon name="clock" size={18} />
                    <span>{value}</span>
                  </button>
                  <Button
                    aria-label={`Убрать запрос ${value}`}
                    onClick={() => {
                      removeSearch(value);
                      setRecent(recentSearches());
                    }}
                    variant="icon"
                  >
                    <Icon name="close" size={17} />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p class="search-hint">Здесь появятся твои последние запросы.</p>
          )}
          <h2 class="quick-search-title">Быстрый выбор</h2>
          <div class="search-quick-links">
            <AppLink href="#/catalog?status=ongoing">
              <Icon name="play" />
              Онгоинги
              <Icon name="chevron" size={17} />
            </AppLink>
            <AppLink href="#/catalog?types=movie">
              <Icon name="grid" />
              Полнометражные
              <Icon name="chevron" size={17} />
            </AppLink>
            <AppLink href="#/catalog?sort=top">
              <Icon name="spark" />
              Лучшие по рейтингу
              <Icon name="chevron" size={17} />
            </AppLink>
            <AppLink href="#/catalog?translates=subtitles">
              <Icon name="comment" />С субтитрами
              <Icon name="chevron" size={17} />
            </AppLink>
          </div>
        </>
      ) : text.trim().length < 2 ? (
        <p class="search-hint">Введи хотя бы два символа.</p>
      ) : (
        <>
          <div class="search-section-title">
            <h2>
              {resource.loading || text.trim() !== submitted
                ? 'Ищем…'
                : `Найдено ${resource.value?.data.length || 0}${resource.value?.data.length === 20 ? '+' : ''}`}
            </h2>
            <ButtonLink
              href={`#/catalog?q=${encodeURIComponent(text.trim())}`}
              onClick={rememberQuery}
              variant="text"
            >
              Фильтры
              <Icon name="filter" size={16} />
            </ButtonLink>
          </div>
          {text.trim() !== submitted || resource.loading ? (
            <div class="search-loading" role="status" aria-label="Поиск аниме">
              {[1, 2, 3, 4].map(value => (
                <div class="result-skeleton" key={value}>
                  <div class="skeleton" />
                  <div>
                    <div class="skeleton line" />
                    <div class="skeleton line short" />
                  </div>
                </div>
              ))}
            </div>
          ) : resource.error ? (
            <ErrorState error={resource.error} retry={resource.retry} />
          ) : resource.value?.data.length ? (
            <div class="search-results anime-grid gallery-grid" data-gallery-row>
              {resource.value.data.map(anime => (
                <AnimeCard
                  anime={anime}
                  key={anime.anime_id}
                  onOpen={() => {
                    rememberSearch(text);
                    setRecent(recentSearches());
                    input.current?.blur();
                  }}
                />
              ))}
            </div>
          ) : (
            <Empty
              title="Не нашли такое аниме"
              action={
                <ButtonLink href={`#/catalog?q=${encodeURIComponent(text.trim())}`}>
                  Искать в каталоге
                </ButtonLink>
              }
            >
              Попробуй другое написание или короткую часть названия.
            </Empty>
          )}
        </>
      )}
    </section>
  );
};
