import { animeSiteUrl } from '~/lib/content-links';
import { AppLink } from '~/ui/AppLink';
import type { FunctionalComponent as FC } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { initializeAccount } from '~/lib/account';
import { imageUrl, plainText } from '~/lib/api';
import { cardMenuEvents } from '~/lib/card-context';
import { useLibrary, useResource, useSession } from '~/lib/hooks';
import { syncLibrary } from '~/lib/library';
import { WATCH_LISTS } from '~/lib/lists';
import { notify } from '~/lib/notifications';
import { personalRating } from '~/lib/ratings';
import { formatTime } from '~/lib/player';
import {
  loadProfile,
  peekProfile,
  loadProfileList,
  peekProfileList,
  formatWatchTime,
  libraryAnimes,
  LIST_PRIVACY,
  profileRequestError,
  updateProfile,
  type ListPrivacy,
  type ProfileAnime,
  type UserProfile,
} from '~/lib/profile';
import type { WatchEntry } from '~/lib/types';

import { WatchPreview } from './WatchPreview';
import { AnimeCard } from './AnimeCard';
import { AnimeListButton } from './Library';
import { ProfileFriends } from './ProfileFriends';
import { ProfileHistory, ProfileSubscriptions } from './ProfileLibrary';
import { FriendActions } from './FriendActions';
import { ProfileActivity, ProfileStats, ProfileTaste } from './ProfileStats';
import {
  ArtworkImage,
  Avatar,
  Button,
  ButtonLink,
  CachedNotice,
  Dropdown,
  Empty,
  ErrorState,
  Field,
  Form,
  FormActions,
  FormError,
  Icon,
  Input,
  SEARCH_INPUT_PROPS,
  SectionHeading,
  Sheet,
  Skeleton,
  Textarea,
  VirtualGrid,
} from '~/ui';

const TABS = [
  { id: 'overview', title: 'Обзор', icon: 'home' },
  { id: 'collection', title: 'Коллекция', icon: 'bookmark' },
  { id: 'history', title: 'История', icon: 'clock' },
  { id: 'subscriptions', title: 'Подписки', icon: 'bell' },
  { id: 'stats', title: 'Статистика', icon: 'chart' },
  { id: 'friends', title: 'Люди', icon: 'users' },
] as const;

const EditProfile: FC<{ profile: UserProfile; close: () => void; saved: () => void }> = ({
  profile,
  close,
  saved,
}) => {
  const [about, setAbout] = useState(profile.about || '');
  const [privacy, setPrivacy] = useState<ListPrivacy | ''>(profile.lists_privacy || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController>();
  useEffect(() => () => controller.current?.abort(), []);

  return (
    <Sheet
      title="Твой профиль"
      subtitle="Изменения сохранятся в YummyAnime"
      close={() => {
        if (!busy) close();
      }}
      className="profile-editor"
    >
      <Form
        onSubmit={async event => {
          event.preventDefault();
          if (busy || !privacy) return;
          setBusy(true);
          setError('');
          const request = new AbortController();
          controller.current = request;
          try {
            await updateProfile(about, privacy, request.signal);
            if (!request.signal.aborted) {
              saved();
              close();
              notify('Профиль сохранён в YummyAnime');
            }
          } catch (error) {
            if (!request.signal.aborted) setError((error as Error).message);
          } finally {
            if (!request.signal.aborted) setBusy(false);
          }
        }}
      >
        <Field htmlFor="profile-about" label="О себе">
          <Textarea
            id="profile-about"
            rows={5}
            maxLength={10000}
            value={about}
            disabled={busy}
            placeholder="Любимые истории, настроение или пара слов о себе"
            onInput={event => setAbout(event.currentTarget.value)}
          />
        </Field>
        <Field htmlFor="profile-privacy" label="Кто видит мои списки">
          <Dropdown
            id="profile-privacy"
            aria-label="Кто видит мои списки"
            aria-required
            value={privacy}
            disabled={busy}
            onChange={value => setPrivacy(value as ListPrivacy)}
            options={[
              { value: '', label: 'Выбери видимость списков', disabled: true },
              ...Object.entries(LIST_PRIVACY).map(([value, label]) => ({ value, label })),
            ]}
          />
        </Field>
        <p class="profile-muted">Эта настройка действует и на сайте YummyAnime.</p>
        {error && <FormError>{error}</FormError>}
        <FormActions class="profile-editor-actions">
          <Button type="submit" variant="primary" disabled={busy || !privacy} aria-busy={busy}>
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </Button>
          <Button type="button" disabled={busy} onClick={close} variant="text">
            Отмена
          </Button>
        </FormActions>
      </Form>
    </Sheet>
  );
};

const ProfileCollection: FC<{
  animes: ProfileAnime[];
  selected: string;
  href: string;
  own: boolean;
  loading: boolean;
  error: string;
  retry: () => void;
  initialSort: string;
}> = ({ animes, selected, href, own, loading, error, retry, initialSort }) => {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState(initialSort);
  useEffect(() => setSort(initialSort), [initialSort]);
  const [status, setStatus] = useState('all');
  const list = WATCH_LISTS.find(list => list.alias === selected);
  const values = useMemo(
    () =>
      animes
        .filter(
          anime =>
            (selected === 'rated'
              ? personalRating(anime) > 0
              : selected === 'favorites'
                ? anime.user?.list?.is_fav
                : list
                  ? anime.user?.list?.list?.id === list.id
                  : true) &&
            anime.title.toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru')) &&
            (status === 'all' || anime.anime_status?.alias === status)
        )
        .sort((a, b) =>
          sort === 'user_rating'
            ? personalRating(b) - personalRating(a) || a.title.localeCompare(b.title, 'ru')
            : sort === 'title'
              ? a.title.localeCompare(b.title, 'ru')
              : sort === 'rating'
                ? (b.rating?.average || 0) - (a.rating?.average || 0)
                : sort === 'year'
                  ? (b.year || 0) - (a.year || 0)
                  : (b.date || 0) - (a.date || 0)
        ),
    [animes, selected, search, sort, status]
  );
  const filters = [
    { alias: 'all', title: 'Все', count: animes.length },
    {
      alias: 'rated',
      title: own ? 'Личный топ' : 'Топ по оценкам',
      count: animes.filter(anime => personalRating(anime) > 0).length,
    },
    ...WATCH_LISTS.map(list => ({
      alias: list.alias,
      title: list.title,
      count: animes.filter(anime => anime.user?.list?.list?.id === list.id).length,
    })),
    {
      alias: 'favorites',
      title: 'Избранное',
      count: animes.filter(anime => anime.user?.list?.is_fav).length,
    },
  ];

  const keyFor = (anime: ProfileAnime) => anime.anime_id;
  const renderAnime = (anime: ProfileAnime) => (
    <div class="profile-anime">
      <AnimeCard
        anime={anime}
        rank={
          selected === 'rated' && sort === 'user_rating' ? values.indexOf(anime) + 1 : undefined
        }
      />
      <p class={`profile-personal-score ${personalRating(anime) ? '' : 'is-unrated'}`}>
        {personalRating(anime)
          ? `${own ? 'Моя оценка' : 'Оценка профиля'}: ${personalRating(anime)} / 10`
          : 'Без оценки'}
      </p>
      {own && <AnimeListButton anime={anime} gridAction />}
    </div>
  );

  if (loading) return <Skeleton count={6} />;
  if (error) return <ErrorState error={error} retry={retry} />;

  return (
    <section class="profile-collection">
      <nav class="profile-list-filters" aria-label="Списки аниме">
        {filters.map(filter => (
          <AppLink
            key={filter.alias}
            href={`${href}?tab=collection&list=${filter.alias}${filter.alias === 'rated' ? '&sort=user_rating' : sort === 'added' ? '' : `&sort=${sort}`}`}
            aria-current={
              selected === filter.alias ||
              (!filters.some(f => f.alias === selected) && filter.alias === 'all')
                ? 'page'
                : undefined
            }
          >
            {filter.title}
            <span>{filter.count}</span>
          </AppLink>
        ))}
      </nav>
      <div class="profile-collection-toolbar">
        <div class="collection-search">
          <Icon name="search" size={18} />
          <Input
            type="search"
            {...SEARCH_INPUT_PROPS}
            aria-label="Найти в коллекции профиля"
            placeholder="Найти в коллекции"
            value={search}
            onInput={event => setSearch(event.currentTarget.value)}
          />
          {search && (
            <Button variant="icon" aria-label="Очистить поиск" onClick={() => setSearch('')}>
              <Icon name="close" size={16} />
            </Button>
          )}
        </div>
        <Dropdown
          aria-label="Статус выхода"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: 'Любой статус выхода' },
            { value: 'ongoing', label: 'Онгоинги' },
            { value: 'released', label: 'Вышедшие' },
            { value: 'announcement', label: 'Анонсы' },
          ]}
        />
        <Dropdown
          aria-label="Порядок аниме"
          value={sort}
          onChange={setSort}
          options={[
            {
              value: 'added',
              label: animes.some(anime => anime.date) ? 'По добавлению' : 'Порядок списка',
            },
            { value: 'title', label: 'По названию' },
            { value: 'rating', label: 'По рейтингу сайта' },
            { value: 'user_rating', label: own ? 'По моей оценке' : 'По оценке профиля' },
            { value: 'year', label: 'По году' },
          ]}
        />
      </div>
      <p class="profile-result-count" role="status">
        {values.length.toLocaleString('ru')} аниме{search ? ` по запросу «${search}»` : ''}
      </p>
      {values.length ? (
        <VirtualGrid items={values} itemKey={keyFor} renderItem={renderAnime} />
      ) : (
        <Empty
          icon="search"
          title={
            selected === 'rated'
              ? 'Оценённых аниме пока нет'
              : animes.length
                ? 'Здесь пока пусто'
                : 'Начало новой коллекции'
          }
        >
          {search || status !== 'all'
            ? 'Попробуй другой запрос или сбрось фильтры.'
            : selected === 'rated'
              ? own
                ? 'Поставь оценку на странице аниме — оно появится в твоём личном топе.'
                : 'Здесь появятся аниме с личными оценками этого профиля.'
              : 'Аниме, добавленные в этот список, появятся здесь.'}
          {(search || status !== 'all') && (
            <Button
              onClick={() => {
                setSearch('');
                setStatus('all');
              }}
            >
              Сбросить фильтры
            </Button>
          )}
        </Empty>
      )}
    </section>
  );
};

const ContinueWatching: FC<{ history: WatchEntry[] }> = ({ history }) => (
  <section class="profile-panel profile-continue" data-tv-focus-group>
    <SectionHeading
      title="История продолжается"
      subtitle="Твоё место сохранено"
      href="#/profile?tab=history"
      action="Вся история"
    />
    {history.length ? (
      <div class="profile-continue-list">
        {history.slice(0, 3).map(entry => (
          <AppLink
            key={entry.anime.anime_id}
            href={`#/anime/${entry.anime.anime_id}?view=watch&play=1`}
            publicHref={animeSiteUrl(entry.anime)}
            class="profile-continue-card"
            {...cardMenuEvents(entry.anime)}
          >
            <div class="profile-continue-poster">
              <WatchPreview entry={entry} />
            </div>
            <div class="profile-continue-copy">
              <small>СЕРИЯ {entry.episode || '—'}</small>
              <h3>{entry.anime.title}</h3>
              <p>
                {entry.position
                  ? `${formatTime(entry.position)}${entry.duration ? ` / ${formatTime(entry.duration)}` : ''}`
                  : 'Вернуться к просмотру'}
              </p>
              {!!entry.duration && (
                <span class="profile-bar">
                  <i
                    style={{
                      width: `${Math.min(100, ((entry.position || 0) / entry.duration) * 100)}%`,
                    }}
                  />
                </span>
              )}
            </div>
            <span class="profile-play">
              <Icon name="play" size={19} />
            </span>
          </AppLink>
        ))}
      </div>
    ) : (
      <Empty
        icon="clock"
        title="Выбери свою первую историю"
        action={
          <ButtonLink href="#/catalog" variant="primary">
            Открыть каталог
            <Icon name="arrow" size={16} />
          </ButtonLink>
        }
      >
        После просмотра здесь появится быстрый путь к следующей серии.
      </Empty>
    )}
  </section>
);

export const ProfilePage: FC<{ query: string; userId?: number }> = ({ query, userId }) => {
  const session = useSession();
  const library = useLibrary();
  const own = userId === undefined || userId === session?.user.id;
  const id = userId ?? session?.user.id;
  const allowed = !own || !session || session.verified;
  const [editing, setEditing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const params = new URLSearchParams(query);
  const tabs = TABS.filter(tab => own || !['history', 'subscriptions'].includes(tab.id));
  const tab = tabs.find(tab => tab.id === params.get('tab'))?.id || 'overview';
  const href = userId === undefined ? '#/profile' : `#/users/id${userId}`;
  const resource = useResource(
    async signal => {
      try {
        return id && allowed
          ? await loadProfile(id, signal)
          : { data: undefined, cached: false, savedAt: 0 };
      } catch (error) {
        throw profileRequestError(error);
      }
    },
    [id, session?.token, session?.verified, allowed],
    () => (id && allowed ? peekProfile(id) : undefined)
  );
  const collection = useResource(
    async signal => {
      try {
        return !own && id
          ? await loadProfileList(id, signal)
          : { data: [], cached: false, savedAt: 0 };
      } catch (error) {
        throw profileRequestError(error);
      }
    },
    [id, own, session?.token, session?.verified],
    () => (!own && id ? peekProfileList(id) : undefined)
  );
  const localAnimes = useMemo(
    () => libraryAnimes(library),
    [library.lists, library.favorites, library.rated]
  );
  const animes = own ? localAnimes : collection.value?.data || [];
  const profile = resource.value?.data;
  const name = profile?.nickname || (own ? session?.user.nickname || 'Твой аниме-мир' : 'Профиль');
  const totalTime = profile?.watches?.sum?.reduce(
    (sum, value) => sum + Math.max(0, value.spent_time),
    0
  );
  const completed = own
    ? library.lists?.[2]?.length || 0
    : (profile?.counts?.[2] ?? animes.filter(anime => anime.user?.list?.list?.id === 2).length);
  const favorites = own ? library.favorites : animes.filter(anime => anime.user?.list?.is_fav);
  const counts = WATCH_LISTS.map(list => ({
    ...list,
    count: own
      ? library.lists?.[list.id]?.length || 0
      : (profile?.counts?.[list.id] ??
        animes.filter(anime => anime.user?.list?.list?.id === list.id).length),
  }));
  const collectionLoading = own ? library.loading && !library.syncedAt : collection.loading;
  const collectionError = own ? library.error : collection.error;

  useEffect(() => {
    setEditing(false);
  }, [id, session?.token]);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      if (own && session && !session.verified) await initializeAccount();
      if (own && session) await syncLibrary();
      resource.retry();
      collection.retry();
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  if (!own && resource.loading)
    return (
      <div class="profile-page">
        <Skeleton count={4} />
      </div>
    );
  if (!own && resource.error)
    return (
      <ErrorState
        error={resource.error.includes('не найдено') ? 'Такой профиль не найден.' : resource.error}
        retry={resource.retry}
      />
    );

  return (
    <div class="profile-page" data-tab={tab}>
      <header class="profile-hero">
        <div class="profile-cover" aria-hidden="true">
          {profile?.banner?.full && (
            <ArtworkImage src={imageUrl(profile.banner.full)} alt="" eager />
          )}
          <span class="profile-cover-mark">
            物語<small>У каждого своя история</small>
          </span>
        </div>
        <div class="profile-identity">
          <span class="profile-large-avatar">
            <Avatar
              url={
                profile?.avatars?.big ||
                profile?.avatars?.full ||
                (own ? session?.user.avatar : undefined)
              }
              name={name}
            />
          </span>
          <div class="profile-intro">
            <p class="eyebrow">
              {own ? (session ? 'ТВОЙ ПРОФИЛЬ' : 'ГОСТЕВОЙ ПРОФИЛЬ') : 'ПРОФИЛЬ YUMMYANIME'}
            </p>
            <h1>{name}</h1>
            <p class="profile-metadata">
              {profile?.register_date
                ? `С нами с ${new Date(profile.register_date * 1000).toLocaleDateString('ru', { month: 'long', year: 'numeric' })}`
                : session
                  ? 'Твои истории на всех устройствах'
                  : 'Твои истории на этом устройстве'}
              {profile?.days_online !== undefined && profile.days_online > 0 && (
                <span>
                  <Icon name="spark" size={14} />
                  {profile.days_online} дн. стрик на сайте
                </span>
              )}
            </p>
          </div>
          <div class="profile-hero-actions">
            {!own && id && <FriendActions key={`${id}:${session?.token}`} id={id} />}
            {!own && id && session?.verified && (
              <ButtonLink href={`#/messages?user=${id}`}>
                <Icon name="comment" size={16} />
                Написать
              </ButtonLink>
            )}
            {own && profile && session?.verified && (
              <Button onClick={() => setEditing(true)}>
                <Icon name="edit" size={16} />
                Редактировать
              </Button>
            )}
            {id && (
              <Button
                variant="icon"
                aria-label="Скопировать ссылку на профиль YummyAnime"
                title="Скопировать ссылку на профиль YummyAnime"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(`https://ru.yummyani.me/users/id${id}`);
                    notify('Ссылка на профиль скопирована');
                  } catch {
                    notify('Не удалось скопировать ссылку. Открой профиль на YummyAnime.');
                  }
                }}
              >
                <Icon name="share" size={18} />
              </Button>
            )}
            {own && !session && (
              <ButtonLink href="#/account?next=%2Fprofile" variant="primary">
                Войти в YummyAnime
                <Icon name="arrow" size={16} />
              </ButtonLink>
            )}
            {own && session && (
              <Button
                onClick={() => void refresh()}
                disabled={refreshing || resource.loading}
                variant="icon"
                aria-label="Обновить профиль"
              >
                <Icon name="refresh" size={18} />
              </Button>
            )}
          </div>
        </div>
        {profile?.about && <p class="profile-bio">{plainText(profile.about)}</p>}
        <div class="profile-highlights">
          <AppLink href={`${href}?tab=collection`}>
            <Icon name="bookmark" size={20} />
            <span>
              <strong>
                {collectionLoading
                  ? '…'
                  : collectionError
                    ? '—'
                    : animes.length.toLocaleString('ru')}
              </strong>
              <small>аниме в коллекции</small>
            </span>
          </AppLink>
          <AppLink href={`${href}?tab=collection&list=watched`}>
            <Icon name="check" size={20} />
            <span>
              <strong>{collectionLoading && own ? '…' : completed.toLocaleString('ru')}</strong>
              <small>просмотрено</small>
            </span>
          </AppLink>
          <AppLink href={`${href}?tab=stats`}>
            <Icon name="clock" size={20} />
            <span>
              <strong>{totalTime === undefined ? '—' : formatWatchTime(totalTime)}</strong>
              <small>в историях</small>
            </span>
          </AppLink>
          <AppLink href={`${href}?tab=collection&list=favorites`}>
            <Icon name="heart" size={20} />
            <span>
              <strong>
                {collectionLoading
                  ? '…'
                  : (own
                      ? favorites.length
                      : (profile?.counts?.[4] ?? favorites.length)
                    ).toLocaleString('ru')}
              </strong>
              <small>в избранном</small>
            </span>
          </AppLink>
        </div>
      </header>

      <nav class="profile-tabs" aria-label="Разделы профиля" data-tv-tabs>
        {tabs.map(item => (
          <AppLink
            key={item.id}
            href={`${href}?tab=${item.id}`}
            aria-current={tab === item.id ? 'page' : undefined}
          >
            <Icon name={item.icon} size={18} />
            {item.title}
            {item.id === 'friends' && profile?.friends?.friends ? (
              <span>{profile.friends.friends}</span>
            ) : null}
          </AppLink>
        ))}
      </nav>
      {resource.value?.cached && !resource.refreshing && (
        <CachedNotice savedAt={resource.value.savedAt} refreshing={resource.refreshing} />
      )}
      {own && !session && tab !== 'friends' && (
        <div class="profile-notice">
          <Icon name="bookmark" size={18} />
          <p>
            Пока всё хранится на этом устройстве. Войди, чтобы открыть коллекцию и статистику своего
            аккаунта.
          </p>
        </div>
      )}
      {own && session && !session.verified && (
        <div class="profile-notice">
          <Icon name="refresh" size={18} />
          <p>Проверяем сохранённый вход. После проверки загрузим профиль и коллекцию.</p>
          <Button onClick={() => void refresh()} disabled={refreshing} variant="text">
            Повторить
          </Button>
        </div>
      )}
      {own && resource.error && (
        <FormError>
          {resource.error}
          <Button variant="text" onClick={resource.retry}>
            Повторить
          </Button>
        </FormError>
      )}

      {tab === 'collection' ? (
        <ProfileCollection
          key={`${id || 'guest'}:${session?.token || ''}`}
          animes={animes}
          selected={params.get('list') || 'all'}
          href={href}
          own={own}
          loading={collectionLoading}
          error={collectionError}
          retry={own ? () => void refresh() : collection.retry}
          initialSort={
            ['added', 'title', 'rating', 'year', 'user_rating'].includes(params.get('sort') || '')
              ? params.get('sort')!
              : params.get('list') === 'rated'
                ? 'user_rating'
                : 'added'
          }
        />
      ) : own && tab === 'history' ? (
        <ProfileHistory key={`${id || 'guest'}:${session?.token || ''}`} />
      ) : own && tab === 'subscriptions' ? (
        <section class="profile-panel">
          <SectionHeading title="Подписки на озвучки" subtitle="Твои подписки с YummyAnime." />
          <ProfileSubscriptions />
        </section>
      ) : tab === 'stats' ? (
        <ProfileStats profile={profile} id={allowed ? id : undefined} animes={animes} />
      ) : tab === 'friends' ? (
        session?.verified ? (
          <ProfileFriends key={`${id}:${session.token}`} id={id} />
        ) : session ? null : (
          <Empty
            icon="user"
            title="Войди, чтобы найти друзей"
            action={
              <ButtonLink
                href={`#/account?next=${encodeURIComponent(`${href.slice(1)}?tab=friends`)}`}
                variant="primary"
              >
                Войти в YummyAnime
              </ButtonLink>
            }
          >
            После входа здесь появятся поиск людей и список друзей.
          </Empty>
        )
      ) : (
        <div class="profile-overview">
          <div class="profile-overview-main" data-tv-profile-column>
            {own && <ContinueWatching history={library.history} />}
            <section class="profile-panel" data-tv-focus-group>
              <SectionHeading
                title={own ? 'Всё на своих местах' : 'Коллекция'}
                subtitle="От первой серии до финальных титров"
                href={`${href}?tab=collection`}
                action="Открыть коллекцию"
              />
              {collectionError ? (
                <FormError>
                  {collectionError}
                  <Button variant="text" onClick={own ? () => void refresh() : collection.retry}>
                    Повторить
                  </Button>
                </FormError>
              ) : (
                <div class="profile-status-grid">
                  {counts.map(list => (
                    <AppLink
                      key={list.id}
                      href={`${href}?tab=collection&list=${list.alias}`}
                      style={{ '--list-color': list.color }}
                    >
                      <Icon name={list.icon} size={19} />
                      <span>{list.title}</span>
                      <strong>{collectionLoading ? '…' : list.count.toLocaleString('ru')}</strong>
                    </AppLink>
                  ))}
                </div>
              )}
            </section>
            <ProfileActivity profile={profile} />
            {favorites.length > 0 && (
              <section class="profile-panel" data-tv-focus-group>
                <SectionHeading
                  title="Особое место"
                  subtitle="Истории, которые хочется сохранить"
                  href={`${href}?tab=collection&list=favorites`}
                  action="Всё избранное"
                />
                <div class="profile-favorites">
                  {favorites.slice(0, 6).map(anime => (
                    <AnimeCard key={anime.anime_id} anime={anime} />
                  ))}
                </div>
              </section>
            )}
          </div>
          <aside class="profile-overview-side" data-tv-profile-column>
            <ProfileTaste id={allowed ? id : undefined} animes={animes} />
            <section class="profile-panel profile-shortcuts" data-tv-focus-group>
              <SectionHeading title="Под рукой" />
              {own && (
                <>
                  {session && (
                    <>
                      <ButtonLink href="#/notifications" variant="text">
                        <Icon name="bell" size={19} />
                        Уведомления
                        <Icon name="chevron" size={16} />
                      </ButtonLink>
                      <ButtonLink href="#/messages" variant="text">
                        <Icon name="comment" size={19} />
                        Сообщения
                        <Icon name="chevron" size={16} />
                      </ButtonLink>
                    </>
                  )}
                  <ButtonLink href={`${href}?tab=subscriptions`} variant="text">
                    <Icon name="list" size={19} />
                    Подписки на озвучки
                    <Icon name="chevron" size={16} />
                  </ButtonLink>
                  <ButtonLink href="#/schedule" variant="text">
                    <Icon name="calendar" size={19} />
                    Расписание серий
                    <Icon name="chevron" size={16} />
                  </ButtonLink>
                  <ButtonLink href="#/settings" variant="text">
                    <Icon name="settings" size={19} />
                    Настройки приложения
                    <Icon name="chevron" size={16} />
                  </ButtonLink>
                </>
              )}
              {id && (
                <ButtonLink
                  href={`https://ru.yummyani.me/users/id${id}`}
                  target="_blank"
                  rel="noreferrer"
                  variant="text"
                >
                  <Icon name="external" size={19} />
                  Профиль на YummyAnime
                  <Icon name="chevron" size={16} />
                </ButtonLink>
              )}
              {own && profile?.lists_privacy && (
                <p class="profile-privacy">
                  <Icon name="lock" size={15} />
                  Списки: {LIST_PRIVACY[profile.lists_privacy]}
                </p>
              )}
            </section>
          </aside>
        </div>
      )}
      {editing && profile && (
        <EditProfile
          key={`${id}:${session?.token}`}
          profile={profile}
          close={() => setEditing(false)}
          saved={resource.retry}
        />
      )}
    </div>
  );
};
