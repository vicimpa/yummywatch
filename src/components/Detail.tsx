import { animeSiteUrl } from '~/lib/content-links';
import { AppLink } from '~/ui/AppLink';
import type { FunctionalComponent as FC, RefObject } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { animeDetail, animeVideos, peekAnimeDetail, peekAnimeVideos } from '~/lib/api';
import {
  downloadable,
  downloadAnimePath,
  downloadError,
  downloadHistory,
  downloadPath,
  downloads,
  downloadsAvailable,
  matchesDownloadHistory,
  preferredReadyDownload,
  storedPlayback,
  useDownloads,
} from '~/lib/downloads';
import { isContinueHidden } from '~/lib/continue-cache';
import { exitPlayerFullscreen } from '~/lib/desktop';
import { useLibrary, useResource, useSession } from '~/lib/hooks';
import { leavePlayback } from '~/lib/navigation';
import type { PlaybackMedia } from '~/lib/playback-media';
import {
  setPictureInPictureUnavailable,
  type PictureInPictureControls,
} from '~/lib/native-playback';
import { readPlaybackRecovery } from '~/lib/playback-recovery';
import { playbackSettings } from '~/lib/playback-settings';
import { readJSON } from '~/lib/storage';
import { canStartAnime, formatTime, groupKey, latestWatchEntry, resumeVideo } from '~/lib/player';
import { preferredStreamQuality, voiceKey } from '~/lib/streams';
import type { WatchEntry } from '~/lib/types';
import { useAnimeDiscordContext } from '~/hooks/useAnimeDiscordContext';

import { AnimeAbout } from './AnimeAbout';
import { Comments } from './Comments';
import { DownloadPicker } from './Downloads';
import { FavoriteButton } from './FavoriteButton';
import { AnimeListButton } from './Library';
import { Player } from './Player';
import { PictureInPictureButton } from './PictureInPictureButton';
import { type MediaPanel } from './Player.types';
import { Poster } from './Poster';
import { Button, ButtonLink, CachedNotice, Empty, ErrorState, Icon, Sidebar } from '~/ui';

export type TDetailProps = {
  id: string;
  query?: string;
  returnTo?: string;
  background?: boolean;
  watchMedia?: RefObject<PlaybackMedia>;
  pip?: PictureInPictureControls;
};

export const Detail: FC<TDetailProps> = ({
  id,
  query = '',
  returnTo = '/',
  background = false,
  watchMedia,
  pip,
}) => {
  const params = new URLSearchParams(query);
  const watching = params.get('view') === 'watch' || params.has('watch');
  const downloadId = watching ? params.get('download') || '' : '';
  useDownloads(!!downloadId);
  const queue = downloadId ? downloads.value : undefined;
  const local = queue?.find(
    entry =>
      entry.id === downloadId &&
      entry.animeId === Number(id) &&
      entry.status === 'ready' &&
      entry.stream
  );
  const localKey =
    local &&
    queue
      ?.filter(entry => entry.animeId === local.animeId && entry.status === 'ready')
      .map(entry => entry.id)
      .join(',');
  const offline = useMemo(
    () => (local && queue ? storedPlayback(local, queue) : undefined),
    [local?.id, localKey]
  );
  const localError =
    downloadId && !offline && (downloadError.value || (queue ? 'Скачанная серия недоступна.' : ''));
  const library = useLibrary(),
    session = useSession();
  const resource = useResource(
    signal =>
      downloadId
        ? Promise.resolve({ data: offline?.anime, cached: false, savedAt: 0 })
        : animeDetail(id, signal),
    [id, params.get('view') || 'about', session?.token, session?.verified, downloadId, offline],
    () =>
      downloadId
        ? offline && { data: offline.anime, cached: false, savedAt: 0 }
        : peekAnimeDetail(id)
  );
  const videos = useResource(
    signal =>
      downloadId
        ? Promise.resolve({ data: offline?.videos || [], cached: false, savedAt: 0 })
        : animeVideos(Number(id), signal),
    [id, session?.token, session?.verified, downloadId, offline],
    () =>
      downloadId
        ? offline && { data: offline.videos, cached: false, savedAt: 0 }
        : peekAnimeVideos(Number(id))
  );
  const checkpoint = useRef<{ token: string | null; entry: WatchEntry }>();
  const room = useRef<HTMLDivElement>(null);
  const [pickingDownloads, setPickingDownloads] = useState(false);

  useEffect(() => {
    if (checkpoint.current?.token !== (session?.token || null)) checkpoint.current = undefined;
  }, [session?.token]);

  const anime = downloadId ? offline?.anime : resource.value?.data;
  const loading = downloadId ? !queue && !localError : resource.loading;
  const [panel, setPanel] = useState<MediaPanel>(() =>
    params.get('view') === 'comments' || params.get('panel') === 'comments' ? 'comments' : null
  );
  const loadingPlayer = watching && (loading || !!localError || !!resource.error || !anime);
  useEffect(() => {
    if (pip?.active && loadingPlayer)
      void setPictureInPictureUnavailable(!!resource.error).catch(() => {});
  }, [pip?.active, loadingPlayer, !!resource.error]);

  useAnimeDiscordContext(
    anime,
    watching
      ? undefined
      : panel === 'comments'
        ? 'Читает комментарии'
        : panel === 'episodes'
          ? 'Выбирает серию'
          : 'Читает об аниме'
  );

  useEffect(() => {
    if (background) setPanel(null);
    else if (params.get('view') === 'comments') setPanel('comments');
  }, [query, background]);

  const entries = [
    anime && !downloadId && latestWatchEntry(anime, videos.value?.data || []),
    anime && downloadId
      ? downloadHistory(
          anime,
          library.history.find(entry => entry.anime.anime_id === Number(id))
        )
      : library.history.find(entry => entry.anime.anime_id === Number(id)),
    checkpoint.current?.token === (session?.token || null) ? checkpoint.current.entry : undefined,
    readPlaybackRecovery(Number(id)),
  ].filter((entry): entry is WatchEntry => !!entry && entry.anime.anime_id === Number(id));
  const oldPosition = !session && local && readJSON<number>(`yumiwatch:offline:${local.id}`, 0);
  const oldVideo = local && offline?.videos.find(video => video.video_id === local.stream?.videoId);
  if (anime && oldVideo && oldPosition)
    entries.push({
      anime,
      videoId: oldVideo.video_id,
      episode: oldVideo.number,
      group: groupKey(oldVideo),
      position: oldPosition,
      updatedAt: 0,
    });
  const history = isContinueHidden(Number(id))
    ? undefined
    : entries.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const readyQueue = !watching && downloadsAvailable() ? downloads.value : undefined;
  const availableVideos = videos.value?.data || [];
  const resume = readyQueue && resumeVideo(availableVideos, history);
  const localResume = preferredReadyDownload(
    readyQueue?.filter(
      entry =>
        entry.animeId === Number(id) &&
        (history
          ? matchesDownloadHistory(entry, history)
          : entry.episode === (resume?.number || '1'))
    ),
    preferredStreamQuality(playbackSettings().quality)
  );
  const useLocalRoute =
    localResume &&
    (navigator.onLine === false ||
      !resume ||
      voiceKey(resume.data.dubbing) !== voiceKey(localResume.voice) ||
      !availableVideos.some(video => video.video_id === localResume.stream?.videoId));
  const resumePath = useLocalRoute
    ? downloadPath(localResume, 'about')
    : `#/anime/${id}?view=watch&play=1${history ? '' : '&start=1'}`;

  const openComments = useCallback(
    () => setPanel(current => (current === 'comments' ? null : 'comments')),
    []
  );

  const downloadFromAbout = !!downloadId && params.get('from') === 'about';
  const downloadBack = downloadFromAbout
    ? `#/anime/${id}`
    : local
      ? downloadAnimePath(local.animeId)
      : '#/downloads';
  const backToAbout = useCallback(() => {
    void exitPlayerFullscreen()
      .catch(() => {})
      .then(() => {
        leavePlayback(downloadId ? downloadBack : `/anime/${id}`);
      });
  }, [id, downloadId, downloadBack]);

  useEffect(() => {
    if (background) return;
    const keys = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (event.target instanceof HTMLElement &&
          event.target.closest(
            'input,textarea,select,[contenteditable]:not([contenteditable=false])'
          )) ||
        document.querySelector('dialog[open],.video-settings')
      )
        return;

      const key = event.code || event.key.toLowerCase();

      if (key === 'KeyC' || key === 'c') {
        event.preventDefault();
        openComments();
      }
      if (key === 'KeyE' || key === 'e') {
        event.preventDefault();
        setPanel(current => (current === 'episodes' ? null : 'episodes'));
      }
      if (watching && (key === 'KeyI' || key === 'i')) {
        event.preventDefault();
        backToAbout();
      }
    };

    window.addEventListener('keydown', keys);

    return () => window.removeEventListener('keydown', keys);
  }, [watching, id, background, backToAbout]);

  const shareAnime = useCallback(async () => {
    if (!anime) return;

    const url = animeSiteUrl(anime);

    try {
      if (navigator.share) await navigator.share({ title: anime.title, url });
      else await navigator.clipboard.writeText(url);
    } catch {
      // The user may cancel sharing.
    }
  }, [anime]);

  const returnLabel = returnTo.startsWith('/downloads')
    ? 'Назад к загрузкам'
    : returnTo.startsWith('/search')
      ? 'Результаты поиска'
      : returnTo.startsWith('/profile') || returnTo.startsWith('/users/')
        ? 'Назад к профилю'
        : returnTo.startsWith('/notifications')
          ? 'Уведомления'
          : returnTo.startsWith('/messages')
            ? 'Сообщения'
            : 'Каталог аниме';

  const toggleEpisodes = useCallback(
    () => setPanel(current => (current === 'episodes' ? null : 'episodes')),
    []
  );

  const checkpointPlayback = useCallback(
    (entry: WatchEntry) => {
      checkpoint.current = { token: session?.token || null, entry };
    },
    [session]
  );

  const closePanel = useCallback(() => setPanel(null), []);

  return (
    <section class={`anime-detail-screen ${watching ? 'is-watching' : 'is-about'}`}>
      {loadingPlayer && !background && pip && <PictureInPictureButton pip={pip} floating />}
      {watching ? (
        loadingPlayer &&
        !background && (
          <button type="button" class="watch-state-back" onClick={backToAbout}>
            <Icon name="back" size={18} />
            {downloadId && !downloadFromAbout ? 'Загрузки' : 'Об аниме'}
          </button>
        )
      ) : (
        <AppLink draggable={false} class="back-link" href={`#${returnTo}`}>
          <Icon name="back" size={18} />
          {returnLabel}
        </AppLink>
      )}
      {loading ? (
        <div class="detail-loading">
          <div class="skeleton detail-poster" />
          <div>
            <div class="skeleton line" />
            <div class="skeleton line short" />
          </div>
        </div>
      ) : localError ? (
        <Empty
          title="Не удалось открыть загрузку"
          action={<ButtonLink href="#/downloads">К загрузкам</ButtonLink>}
        >
          {localError}
        </Empty>
      ) : resource.error ? (
        <ErrorState error={resource.error} retry={resource.retry} />
      ) : (
        anime && (
          <>
            {!watching && resource.value?.cached && !resource.refreshing && (
              <CachedNotice savedAt={resource.value.savedAt} />
            )}
            {pickingDownloads && !watching && videos.value && (
              <DownloadPicker
                anime={anime}
                videos={videos.value.data}
                close={() => setPickingDownloads(false)}
              />
            )}
            <div ref={room} class={`anime-room ${watching ? 'is-watch' : 'is-info'} `}>
              <div class="room-main">
                {!watching && (
                  <>
                    <header class="anime-watch-heading overview-heading">
                      <div class="watch-poster">
                        <Poster anime={anime} large />
                      </div>
                      <div class="watch-title">
                        <h1>{anime.title}</h1>
                        <div class="detail-meta">
                          {anime.rating?.average ? (
                            <span class="hero-score">★ {anime.rating.average.toFixed(1)}</span>
                          ) : null}
                          <span>{anime.year}</span>
                          <span>{anime.type?.name}</span>
                          <span>{anime.anime_status?.title}</span>
                          {anime.min_age?.title && <span>{anime.min_age.title}</span>}
                        </div>
                        <div class="watch-title-actions">
                          <Button aria-label="Поделиться аниме" onClick={shareAnime}>
                            <Icon name="share" size={18} />
                          </Button>
                          <FavoriteButton anime={anime} />
                          <Button
                            onClick={toggleEpisodes}
                            aria-haspopup="dialog"
                            aria-expanded={panel === 'episodes'}
                            title="Серии (E)"
                          >
                            <Icon name="list" size={18} />
                            Серии
                          </Button>
                          {downloadsAvailable() && videos.value?.data.some(downloadable) && (
                            <Button
                              onClick={() => setPickingDownloads(true)}
                              aria-haspopup="dialog"
                            >
                              <Icon name="download" size={18} />
                              Скачать
                            </Button>
                          )}
                          <Button
                            onClick={openComments}
                            aria-expanded={panel === 'comments'}
                            title="Комментарии (C)"
                          >
                            <Icon name="comment" size={18} />
                            Комментарии{anime.comments_count ? ` · ${anime.comments_count}` : ''}
                          </Button>
                        </div>
                        <AnimeListButton anime={anime} />
                      </div>
                    </header>
                    {(canStartAnime(anime) || useLocalRoute) && (
                      <AppLink
                        class="anime-resume-row"
                        data-nav-primary
                        href={resumePath}
                        publicHref={animeSiteUrl(anime)}
                      >
                        <span class="resume-row-play">
                          <Icon name="play" size={24} />
                        </span>
                        <span>
                          <strong>{history ? 'Продолжить просмотр' : 'Начать просмотр'}</strong>
                          <small>
                            {history
                              ? `Серия ${history.episode} · ${formatTime(history.position)}${history.duration ? ` / ${formatTime(history.duration)}` : ''}`
                              : 'Озвучку и серию можно сменить в плеере'}
                          </small>
                        </span>
                        <Icon name="arrow" size={22} />
                      </AppLink>
                    )}
                  </>
                )}
                {watching ? (
                  <Player
                    presentation="immersive"
                    modeOverride="universal"
                    onBack={backToAbout}
                    backLabel={downloadFromAbout ? 'Об аниме' : undefined}
                    key={downloadId || anime.anime_id}
                    anime={anime}
                    offline={offline}
                    history={history}
                    startPlaying={params.has('play')}
                    newWatch={params.has('start')}
                    preferredVoice={local?.voice || params.get('voice') || undefined}
                    preferredEpisode={local?.episode || params.get('episode') || undefined}
                    panel={panel}
                    onPanelChange={setPanel}
                    onComments={openComments}
                    fullscreenContainer={room}
                    onCheckpoint={checkpointPlayback}
                    background={background}
                    watchMedia={watchMedia}
                    pip={pip}
                  />
                ) : (
                  <AnimeAbout
                    anime={anime}
                    videos={videos}
                    history={history}
                    episodesOpen={panel === 'episodes'}
                    closeEpisodes={closePanel}
                    onRatingSaved={resource.retry}
                  />
                )}
              </div>
              <Sidebar
                open={!background && panel === 'comments'}
                title="Комментарии"
                subtitle={anime.title}
                close={closePanel}
                className="comments-sidebar"
              >
                <Comments
                  animeId={anime.anime_id}
                  returnTo={`/anime/${id}?view=${watching ? 'watch' : 'anime-about'}&panel=comments`}
                />
              </Sidebar>
            </div>
          </>
        )
      )}
    </section>
  );
};
