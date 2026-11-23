import { AppLink } from '~/ui/AppLink';
import type { FunctionalComponent as FC, JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { useDiscordPresence } from '~/hooks/useDiscordPresence';
import { usePlaybackWakeLock } from '~/hooks/usePlaybackWakeLock';
import { useAnimeDiscordContext } from '~/hooks/useAnimeDiscordContext';
import { useFullscreen } from '~/hooks/useFullscreen';
import { useSourcePlayback } from '~/hooks/useSourcePlayback';
import { isContinueHidden } from '~/lib/continue-cache';
import { firstEpisode, rankedStart, type VoiceChoice } from '~/lib/voice-ranking';
import { animeVideos, imageUrl, peekAnimeVideos } from '~/lib/api';
import { useMediaQuery, useResource, useSession } from '~/lib/hooks';
import { notify } from '~/lib/notifications';
import { usePlaybackSettings } from '~/lib/playback-settings';
import { preferredStreamQuality, voiceKey } from '~/lib/streams';
import {
  formatTime,
  groupKey,
  groupVideos,
  playbackUrl,
  playerCommand,
  playerUrl,
  resumeVideo,
  videoPosition,
} from '~/lib/player';
import { readJSON, writeJSON } from '~/lib/storage';
import type { Video } from '~/lib/types';
import { watchFrameKey } from '~/lib/watch-frames';

import {
  EpisodeDownloadToolbar,
  EpisodeWithDownload,
  useEpisodeDownloads,
} from './EpisodeDownload';
import type { TPlayerProps } from './Player.types';
import { PlayerSelect } from './PlayerSelect';
import { WatchPicker } from './WatchPicker';
import {
  Button,
  ButtonLink,
  CachedNotice,
  Dropdown,
  Empty,
  EpisodeCaption,
  EpisodePreview,
  ErrorState,
  Field,
  Icon,
  Input,
  OptionButton,
  SEARCH_INPUT_PROPS,
  SearchField,
  Sheet,
  Sidebar,
  Toggle,
} from '~/ui';

const EMPTY_VIDEOS: Video[] = [];

export const SourcePlayer: FC<TPlayerProps> = ({
  anime,
  history,
  onCheckpoint,
  onSelectPlayer,
  panel,
  onPanelChange,
  onComments,
  preferredVoice,
  preferredEpisode,
  startPlaying,
  newWatch,
}) => {
  const session = useSession();
  const mobile = useMediaQuery('(max-width: 760px)');
  const [overlay, setOverlay] = useState<'episodes' | 'dubbing' | 'player' | null>(null);
  const episodesOpen = panel === undefined ? overlay === 'episodes' : panel === 'episodes';

  const openEpisodes = useCallback(() => {
    if (onPanelChange) onPanelChange('episodes');
    else setOverlay('episodes');
  }, [onPanelChange]);

  const closeEpisodes = useCallback(() => {
    if (onPanelChange) onPanelChange(null);
    else setOverlay(null);
  }, [onPanelChange]);

  const [sourceQuery, setSourceQuery] = useState('');
  const scope = session?.verified ? session.token : session ? 'restoring' : 'guest';
  const resource = useResource(
    signal => animeVideos(anime.anime_id, signal),
    [anime.anime_id, scope],
    () => peekAnimeVideos(anime.anime_id)
  );
  const groups = useMemo(() => groupVideos(resource.value?.data || []), [resource.value]);
  const [selectedGroup, setSelectedGroup] = useState('');
  const [selectedEpisode, setSelectedEpisode] = useState('');
  const [episodeQuery, setEpisodeQuery] = useState('');
  const [autoNext, setAutoNext] = useState(() => readJSON('yumiwatch:auto-next', false));
  const [showPreviews, setShowPreviews] = useState(() =>
    readJSON('yumiwatch:episode-previews', true)
  );
  const selectionScope = `${anime.anime_id}:${scope}:${preferredVoice || ''}:${preferredEpisode || ''}`;
  const initialized = useRef(selectionScope);
  const voiceChoice = useRef<VoiceChoice>('default');
  const transfer = useRef<{
    scope: string;
    videoId: number;
    position: number;
    duration: number;
    playing: boolean;
  }>();

  useEffect(() => {
    if (!groups.size) return;
    if (
      initialized.current === selectionScope &&
      groups.get(selectedGroup)?.videos.some(video => video.number === selectedEpisode)
    )
      return;
    initialized.current = selectionScope;

    const videos = [...groups.values()].flatMap(group => group.videos);
    const all =
      newWatch && !history ? videos.map(video => ({ ...video, watched: undefined })) : videos;
    const ranked = newWatch && !history && !preferredVoice && !preferredEpisode && rankedStart(all);
    voiceChoice.current = preferredVoice ? 'explicit' : ranked ? 'ranked' : 'default';
    let resume =
      resumeVideo(
        preferredVoice ? all.filter(video => video.data.dubbing === preferredVoice) : all,
        history
      ) || resumeVideo(all, history);

    if (ranked) resume = ranked;
    else if (newWatch && !history && !preferredVoice && !preferredEpisode)
      resume = firstEpisode(all) || resume;
    else if (!preferredVoice && !history && !all.some(video => video.watched?.date)) {
      const preferred = readJSON<{ dubbing?: string; player?: number }>(
        'yumiwatch:player-preference',
        {}
      );

      resume =
        all.find(
          video =>
            video.data.dubbing === preferred.dubbing && video.data.player_id === preferred.player
        ) ||
        all.find(video => video.data.dubbing === preferred.dubbing) ||
        resume;
    }
    resume =
      all.find(
        video => video.number === preferredEpisode && groupKey(video) === groupKey(resume)
      ) || resume;
    setSelectedGroup(groupKey(resume));
    setSelectedEpisode(resume.number);
  }, [groups, preferredVoice, preferredEpisode, selectionScope]);

  const videos = groups.get(selectedGroup)?.videos || [];
  const current = videos.find(video => video.number === selectedEpisode) || videos[0];

  const settings = usePlaybackSettings();
  const episodeDownloads = useEpisodeDownloads({
    open: episodesOpen,
    anime,
    videos: resource.value?.data || EMPTY_VIDEOS,
    voice: current?.data.dubbing || '',
    quality: preferredStreamQuality(settings.quality),
  });

  const index = current ? videos.findIndex(video => video.video_id === current.video_id) : -1;
  const selectVideo = useCallback((video: Video) => {
    writeJSON('yumiwatch:player-preference', {
      dubbing: video.data.dubbing,
      player: video.data.player_id,
    });
    setSelectedGroup(groupKey(video));
    setSelectedEpisode(video.number);
  }, []);

  const playbackRun = useMemo(() => Date.now(), [scope, anime.anime_id, current?.number]);
  const positionTransfer =
    transfer.current?.scope === selectionScope && transfer.current.videoId === current?.video_id
      ? transfer.current
      : undefined;
  const {
    iframe,
    initial,
    position,
    duration,
    progress,
    presence,
    send,
    flush,
    requestPlay,
    loaded,
  } = useSourcePlayback({
    anime,
    video:
      current && isContinueHidden(anime.anime_id) ? { ...current, watched: undefined } : current,
    history,
    run: playbackRun,
    voiceChoice: voiceChoice.current,
    transfer: positionTransfer,
    scope,
    token: session?.token || null,
    startPlaying,
    autoNext,
    next: videos[index + 1],
    onEnded: video => {
      if (voiceChoice.current === 'explicit') voiceChoice.current = 'default';
      transfer.current = undefined;
      selectVideo(video);
    },
    onCheckpoint,
  });
  const { error: fullscreenError, toggle: toggleFullscreen } = useFullscreen(iframe);

  useEffect(() => {
    if (fullscreenError) notify(fullscreenError);
  }, [fullscreenError]);

  const playback = presence?.videoId === current?.video_id ? presence : undefined;
  useDiscordPresence(anime, current, playback);
  usePlaybackWakeLock(playback?.playing === true);

  useAnimeDiscordContext(
    anime,
    overlay === 'dubbing'
      ? 'Выбирает озвучку'
      : overlay === 'player'
        ? 'Выбирает плеер'
        : episodesOpen
          ? 'Выбирает серию'
          : panel === 'comments'
            ? 'Читает комментарии'
            : !current && !resource.error && (resource.loading || groups.size > 0)
              ? 'Смотрит · Загрузка'
              : undefined,
    episodesOpen ? episodeQuery : sourceQuery,
    200
  );

  const choose = useCallback(
    (video: Video | undefined, closeOverlay = true, changeVoice = false) => {
      if (!video) return;
      flush();
      if (closeOverlay) {
        if (panel === 'episodes') onPanelChange?.(null);
        setOverlay(null);
        if (mobile)
          requestAnimationFrame(() =>
            document
              .getElementById('watch')
              ?.scrollIntoView?.({ block: 'start', behavior: 'instant' })
          );
      }
      if (
        changeVoice &&
        current &&
        video.number === current.number &&
        video.video_id !== current.video_id
      ) {
        const saved = presence?.videoId === current.video_id ? presence : positionTransfer;
        transfer.current = {
          scope: selectionScope,
          videoId: video.video_id,
          position: saved?.position ?? position,
          duration: saved?.duration ?? duration,
          playing: saved?.playing ?? false,
        };
        voiceChoice.current = 'explicit';
        requestPlay(transfer.current.playing);
      } else {
        transfer.current = undefined;
        if (current?.number !== video.number && voiceChoice.current === 'explicit')
          voiceChoice.current = 'default';
        requestPlay();
      }
      selectVideo(video);
      if (current?.video_id === video.video_id) send('play');
    },
    [
      panel,
      onPanelChange,
      mobile,
      current,
      send,
      flush,
      requestPlay,
      selectVideo,
      presence,
      positionTransfer,
      position,
      duration,
      selectionScope,
    ]
  );

  const dubbings = useMemo(
    () => [...new Set([...groups.values()].map(group => group.videos[0].data.dubbing))],
    [groups]
  );
  const providers = useMemo(
    () => [...groups].filter(([, group]) => group.videos[0].data.dubbing === current?.data.dubbing),
    [groups, current?.data.dubbing]
  );
  const sourceOptions = useMemo(() => {
    if (!current) return [];

    const voices = new Map<string, Video[]>();

    for (const group of groups.values()) {
      const name = group.videos[0].data.dubbing;
      const old =
        [...voices.keys()].find(existing => voiceKey(existing) === voiceKey(name)) || name;
      voices.set(old, [...(voices.get(old) || []), ...group.videos]);
    }

    const choices =
      overlay === 'dubbing'
        ? [...voices].map(([label, videos]) => ({
            label,
            videos,
            selected: label === current.data.dubbing,
          }))
        : providers.map(([, group]) => ({
            label: group.videos[0].data.player,
            videos: group.videos,
            selected: group.videos[0].data.player_id === current.data.player_id,
          }));

    return choices
      .filter(option => option.label.toLocaleLowerCase().includes(sourceQuery.toLocaleLowerCase()))
      .map(option => ({
        ...option,
        video:
          option.videos.find(video => video.number === current.number) ||
          (overlay === 'dubbing' ? undefined : option.videos[0]),
      }));
  }, [groups, providers, overlay, current, sourceQuery]);

  const chooseOption = useCallback(
    (video: Video) => {
      if (current && video.number !== current.number)
        notify(`Серия ${current.number} здесь недоступна. Выбрана серия ${video.number}.`);
      choose(video, true, overlay === 'dubbing');
    },
    [current, choose, overlay]
  );

  const episodeCards = useMemo(() => {
    const frames = new Map(
      anime.random_screenshots?.map(frame => [frame.episode, frame] as const).reverse()
    );

    return videos
      .filter(video => !episodeQuery || video.number.includes(episodeQuery))
      .map(video => {
        const frame = frames.get(video.number);
        const saved = progress[video.video_id] || videoPosition(video, history);
        const percent =
          saved.duration > 0 ? Math.min(100, (saved.position / saved.duration) * 100) : 0;
        const preview = imageUrl(frame?.sizes.small || anime.poster?.medium || anime.poster?.big);

        return { video, frame, saved, percent, preview };
      });
  }, [
    videos,
    episodeQuery,
    anime.random_screenshots,
    anime.poster?.medium,
    anime.poster?.big,
    progress,
    history,
  ]);

  const changePreviews = useCallback((event: JSX.TargetedEvent<HTMLInputElement>) => {
    setShowPreviews(event.currentTarget.checked);
    writeJSON('yumiwatch:episode-previews', event.currentTarget.checked);
  }, []);

  const changeEpisodeQuery = useCallback(
    (event: JSX.TargetedInputEvent<HTMLInputElement>) => setEpisodeQuery(event.currentTarget.value),
    []
  );

  const previousEpisode = useCallback(() => choose(videos[index - 1]), [choose, videos, index]);

  const seekBack = useCallback(() => send('seek', Math.max(0, position - 10)), [send, position]);

  const seekForward = useCallback(
    () => send('seek', Math.min(duration || Infinity, position + 10)),
    [send, duration, position]
  );

  const nextEpisode = useCallback(() => choose(videos[index + 1]), [choose, videos, index]);

  const restartEpisode = useCallback(() => send('seek', 0), [send]);

  const openVoices = useCallback(() => {
    setSourceQuery('');
    setOverlay('dubbing');
  }, []);

  const openPlayers = useCallback(() => {
    setSourceQuery('');
    setOverlay('player');
  }, []);

  const changeVoice = useCallback(
    (value: string) => {
      if (!current) return;
      const video = [...groups.values()]
        .flatMap(group => group.videos)
        .find(
          video =>
            voiceKey(video.data.dubbing) === voiceKey(value) && video.number === current.number
        );
      if (!video) {
        notify(`Серия ${current.number} недоступна в этой озвучке.`);
        return;
      }
      choose(video, true, voiceKey(value) !== voiceKey(current.data.dubbing));
    },
    [groups, choose, current]
  );

  const changePlayer = useCallback(
    (video?: Video) => {
      if (video) choose(video);
      else onSelectPlayer?.(current, 'universal', position, duration);
    },
    [choose, onSelectPlayer, current, position, duration]
  );

  const changeAutoNext = useCallback((event: JSX.TargetedEvent<HTMLInputElement>) => {
    setAutoNext(event.currentTarget.checked);
    writeJSON('yumiwatch:auto-next', event.currentTarget.checked);
  }, []);

  const closeOverlay = useCallback(() => setOverlay(null), []);

  const switchToUniversal = useCallback(
    () => onSelectPlayer?.(current, 'universal', position, duration),
    [onSelectPlayer, current, position, duration]
  );

  const skip = [current?.skips?.opening, current?.skips?.ending].find(
    segment => segment && position >= segment.time && position < segment.time + segment.length
  );

  const skipSegment = useCallback(() => {
    if (skip) send('seek', skip.time + skip.length);
  }, [skip, send]);

  if (session && !session.verified)
    return (
      <div class="account-loading" role="status">
        Проверяем аккаунт для восстановления просмотра.
        <br />
        <ButtonLink href="#/account" variant="text">
          Проверить вход
        </ButtonLink>
      </div>
    );
  if (resource.loading || (groups.size > 0 && !current))
    return <div class="player-skeleton skeleton" role="status" aria-label="Загрузка серий" />;
  if (resource.error) return <ErrorState error={resource.error} retry={resource.retry} />;
  if (!groups.size || !current)
    return (
      <Empty
        icon="calendar"
        title="Серии пока не появились"
        action={
          <ButtonLink
            href={`https://ru.yummyani.me/catalog/item/${encodeURIComponent(anime.anime_url)}`}
            target="_blank"
            rel="noreferrer"
          >
            Проверить на YummyAnime
            <Icon name="external" size={16} />
          </ButtonLink>
        }
      >
        Здесь появятся доступные озвучки и плееры, когда их добавят в Yummy.
      </Empty>
    );

  const canSeek = playerCommand(current, 'seek', 0) !== null;
  const episodePanel = (
    <>
      <div class="episode-toolbar">
        <h2>
          Серии <span>{videos.length}</span>
        </h2>
        <Toggle checked={showPreviews} onChange={changePreviews}>
          Кадры
        </Toggle>
      </div>
      {videos.length > 24 && (
        <Input
          class="episode-search"
          type="search"
          {...SEARCH_INPUT_PROPS}
          inputMode="numeric"
          placeholder="Номер серии"
          aria-label="Найти серию"
          value={episodeQuery}
          onInput={changeEpisodeQuery}
        />
      )}
      <EpisodeDownloadToolbar controls={episodeDownloads} onClick={closeEpisodes} />
      <div
        class={`episode-cards${showPreviews ? '' : ' numbers-only'}${episodeDownloads ? ' episodes-with-downloads' : ''}`}
        aria-label="Выбор серии"
      >
        {episodeCards.map(({ video, frame, saved, percent, preview }) => (
          <EpisodeWithDownload
            key={video.video_id}
            episode={video.number}
            selected={current.video_id === video.video_id}
            downloads={episodeDownloads?.forEpisode}
            onOpenSaved={closeEpisodes}
          >
            <button
              class={current.video_id === video.video_id ? 'episode-card selected' : 'episode-card'}
              aria-label={`Серия ${video.number}`}
              aria-pressed={current.video_id === video.video_id}
              onClick={() => choose(video)}
            >
              {showPreviews && (
                <EpisodePreview
                  src={preview}
                  frameKey={watchFrameKey(anime.anime_id, video.number, session?.user.id)}
                  alt={frame ? `Кадр серии ${video.number}` : ''}
                  poster={!frame}
                  progress={percent}
                  duration={saved.duration > 0 ? formatTime(saved.duration) : undefined}
                  icon={current.video_id !== video.video_id && percent >= 95 ? 'check' : 'play'}
                  hideBrokenImage
                />
              )}
              <EpisodeCaption title={showPreviews ? `Серия ${video.number}` : video.number}>
                {showPreviews &&
                  (saved.position > 0
                    ? `Просмотрено ${formatTime(saved.position)}`
                    : current.video_id === video.video_id
                      ? 'Выбрана'
                      : 'Смотреть')}
              </EpisodeCaption>
            </button>
          </EpisodeWithDownload>
        ))}
      </div>
    </>
  );

  return (
    <section class="watch-area mobile-watch" id="watch" aria-label="Просмотр аниме">
      <div class="watch-sticky">
        <div class="watch-now">
          <span>
            <strong>Серия {current.number}</strong>
            <span> · {current.data.dubbing.replace(/^Озвучка /, '')}</span>
          </span>
          <span class="watch-clock">
            {formatTime(position)}
            {duration > 0 && ` / ${formatTime(duration)}`}
          </span>
        </div>
        <div class="player-frame">
          <iframe
            ref={iframe}
            key={current.video_id}
            src={playbackUrl(current, initial.position, !!positionTransfer)}
            title={`${anime.title} — серия ${current.number}, ${current.data.dubbing}`}
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            allowFullScreen
            sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"
            referrerPolicy="strict-origin-when-cross-origin"
            onLoad={loaded}
          />
        </div>
        <div class="watch-transport">
          <button disabled={index <= 0} onClick={previousEpisode} aria-label="Предыдущая серия">
            <Icon name="back" size={18} />
            <span>Пред.</span>
          </button>
          <button disabled={!canSeek} onClick={seekBack} aria-label="Назад на 10 секунд">
            −10 с
          </button>
          <button disabled={!canSeek} onClick={seekForward} aria-label="Вперёд на 10 секунд">
            +10 с
          </button>
          {skip && canSeek ? (
            <button class="skip-opening" onClick={skipSegment}>
              Пропустить
            </button>
          ) : (
            <button onClick={toggleFullscreen} aria-label="Полный экран">
              <Icon name="external" size={18} />
            </button>
          )}
          <button
            disabled={index >= videos.length - 1}
            onClick={nextEpisode}
            aria-label="Следующая серия"
          >
            <span>След.</span>
            <Icon name="arrow" size={18} />
          </button>
        </div>
      </div>
      {resource.value?.cached && <CachedNotice savedAt={resource.value.savedAt} />}
      {initial.position > 5 && (
        <div class="resume-notice">
          <Icon name="clock" size={17} />
          <span>
            Остановились на <strong>{formatTime(initial.position)}</strong> · серия {current.number}
          </span>
          <button onClick={restartEpisode} disabled={!canSeek}>
            Сначала
          </button>
        </div>
      )}
      {mobile ? (
        <div class="watch-source-buttons">
          <WatchPicker label="Озвучка" value={current.data.dubbing} onClick={openVoices} />
          <WatchPicker label="Плеер" value={current.data.player} onClick={openPlayers} />
        </div>
      ) : (
        <div class="watch-selectors">
          <Field label="Озвучка">
            <Dropdown
              aria-label="Озвучка"
              value={current.data.dubbing}
              onChange={changeVoice}
              options={dubbings.map(dubbing => ({ value: dubbing, label: dubbing }))}
            />
          </Field>
          <PlayerSelect
            videos={resource.value!.data}
            current={current}
            universal={false}
            onChange={changePlayer}
          />
        </div>
      )}
      <div class="watch-preferences">
        <Toggle checked={autoNext} onChange={changeAutoNext}>
          Следующая серия автоматически
        </Toggle>
      </div>
      <div class="watch-room-buttons">
        <button class="episode-launcher" aria-haspopup="dialog" onClick={openEpisodes}>
          <Icon name="list" size={23} />
          <span>
            <strong>Все серии</strong>
            <small>
              Выбрана {current.number} из {videos.length}
            </small>
          </span>
          <Icon name="chevron" size={19} />
        </button>
        {onComments && (
          <Button onClick={onComments} class="watch-comments">
            <Icon name="comment" size={20} />
            Комментарии
          </Button>
        )}
      </div>
      <Sidebar
        open={episodesOpen}
        title="Серии"
        subtitle={anime.title}
        close={closeEpisodes}
        className="episodes-sidebar"
      >
        {episodePanel}
      </Sidebar>
      {overlay && overlay !== 'episodes' && (
        <Sheet
          title={overlay === 'dubbing' ? 'Выбрать озвучку' : 'Выбрать плеер'}
          subtitle={`Серия ${current.number} · ${current.data.dubbing.replace(/^Озвучка /, '')}`}
          close={closeOverlay}
          className="sources-screen"
        >
          <>
            <SearchField
              value={sourceQuery}
              onValueChange={setSourceQuery}
              label="Поиск варианта просмотра"
              placeholder={overlay === 'dubbing' ? 'Название озвучки' : 'Название плеера'}
            />
            <div class="source-options">
              {overlay === 'player' && 'наш плеер'.includes(sourceQuery.toLocaleLowerCase()) && (
                <button class="source-option" onClick={switchToUniversal}>
                  <span>
                    <strong>Наш плеер</strong>
                    <small>Единое управление · автопропуск</small>
                  </span>
                </button>
              )}
              {sourceOptions.map(option => (
                <OptionButton
                  key={option.label}
                  label={option.label}
                  description={`${option.videos.length} серий`}
                  selected={option.selected}
                  disabled={!option.video}
                  onClick={() => option.video && chooseOption(option.video)}
                />
              ))}
            </div>
          </>
        </Sheet>
      )}
      <p class="player-note">
        Нажми Play прямо в плеере. Позиция восстанавливается у совместимых плееров.
        {
          <AppLink href={playerUrl(current.iframe_url)} target="_blank" rel="noreferrer">
            {' '}
            Открыть отдельно ↗
          </AppLink>
        }
      </p>
    </section>
  );
};
