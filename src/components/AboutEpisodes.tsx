import { animeSiteUrl } from '~/lib/content-links';
import { AppLink } from '~/ui/AppLink';
import type { ComponentChildren, FunctionalComponent as FC } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

import { imageUrl } from '~/lib/api';
import { useOnline } from '~/hooks/useAppEnvironment';
import { downloadPath, preferredReadyDownload } from '~/lib/downloads';
import { useSession } from '~/lib/hooks';
import { useInterfaceSettings } from '~/lib/interface-settings';
import { usePlaybackSettings } from '~/lib/playback-settings';
import { formatTime, videoPosition } from '~/lib/player';
import { groupVoices, preferredStreamQuality, voiceKey, voiceVideos } from '~/lib/streams';
import type { Anime, Video, WatchEntry } from '~/lib/types';
import { watchFrameKey } from '~/lib/watch-frames';
import {
  EpisodeDownloadToolbar,
  EpisodeWithDownload,
  useEpisodeDownloads,
  type EpisodeDownloads,
} from './EpisodeDownload';
import { EpisodeVoiceTabs } from './EpisodeVoiceTabs';
import { EpisodeListControls } from './EpisodeListControls';

import { Empty, EpisodeCaption, EpisodePreview, ErrorState, Sidebar } from '~/ui';

export type TAboutEpisodesProps = {
  anime: Anime;
  videos: Video[];
  history?: WatchEntry;
  open: boolean;
  close: () => void;
  loading: boolean;
  error: string;
  retry: () => void;
  selectedVoice?: string;
  onVoiceChange?: (key: string) => void;
  renderSubscription?: (key: string) => ComponentChildren;
};

type TAboutEpisodeCardProps = {
  anime: Anime;
  video: Video;
  history?: WatchEntry;
  savedVoice?: string;
  accountId?: number;
  downloads?: EpisodeDownloads;
  knownVideoIds: Set<number>;
  quality: number;
  online: boolean;
  voice: string;
  close?: () => void;
};

const AboutEpisodeCard: FC<TAboutEpisodeCardProps> = ({
  anime,
  video,
  history,
  savedVoice,
  accountId,
  downloads,
  knownVideoIds,
  quality,
  online,
  voice,
  close,
}) => {
  const frame = anime.random_screenshots?.find(image => image.episode === video.number);
  const preview = imageUrl(frame?.sizes.small || anime.poster?.medium);
  const sameVoice = savedVoice && voiceKey(savedVoice) === voiceKey(voice);
  const entry =
    sameVoice && history?.episode === video.number
      ? { ...history, videoId: video.video_id }
      : history;
  const saved = videoPosition(video, entry);
  const current = history?.episode === video.number && !!saved.position;
  const local = preferredReadyDownload(downloads?.(video.number).entries, quality);
  const preferDirect = local?.stream && (!online || !knownVideoIds.has(local.stream.videoId));
  const href = preferDirect
    ? downloadPath(local, 'about')
    : `#/anime/${anime.anime_id}?view=watch&play=1&episode=${encodeURIComponent(video.number)}&voice=${encodeURIComponent(voice)}`;

  const content = (
    <>
      <EpisodePreview
        src={preview}
        frameKey={watchFrameKey(anime.anime_id, video.number, accountId)}
        cacheOnly={!online}
        icon={online || local ? 'play' : null}
        progress={saved.duration > 0 ? (saved.position / saved.duration) * 100 : 0}
        duration={saved.duration > 0 ? formatTime(saved.duration) : undefined}
      />
      <EpisodeCaption title={`Серия ${video.number}`}>
        {!online && !local
          ? 'Нужен интернет'
          : saved.position
            ? `Продолжить · ${formatTime(saved.position)}`
            : local
              ? 'Смотреть офлайн'
              : 'Смотреть'}
      </EpisodeCaption>
    </>
  );
  return (
    <EpisodeWithDownload
      episode={video.number}
      selected={current}
      downloads={downloads}
      onOpenSaved={close}
      savedFrom="about"
      primarySavedId={local?.id}
    >
      {!online && !local ? (
        <div class="episode-card episode-unavailable">{content}</div>
      ) : (
        <AppLink
          class={`episode-card ${current ? 'selected' : ''}`}
          aria-label={`Серия ${video.number}`}
          aria-current={current ? 'true' : undefined}
          href={href}
          publicHref={animeSiteUrl(anime)}
          onClick={close}
        >
          {content}
        </AppLink>
      )}
    </EpisodeWithDownload>
  );
};

type EpisodeListProps = Omit<TAboutEpisodesProps, 'open' | 'close'> & {
  active: boolean;
  close?: () => void;
  renderSources?: (key: string) => ComponentChildren;
};

export const AnimeEpisodeList: FC<EpisodeListProps> = ({
  anime,
  videos,
  history,
  active,
  close,
  loading,
  error,
  retry,
  selectedVoice,
  onVoiceChange,
  renderSources,
  renderSubscription,
}) => {
  const accountId = useSession()?.user.id;
  const online = useOnline();
  const { episodeLayout } = useInterfaceSettings();
  const cards = episodeLayout === 'cards';
  const [localVoice, setLocalVoice] = useState(''),
    [query, setQuery] = useState('');

  useEffect(() => {
    if (active && close) setQuery('');
  }, [active]);

  const voices = useMemo(() => groupVoices(videos), [videos]);
  const knownVideoIds = useMemo(() => new Set(videos.map(video => video.video_id)), [videos]);
  const savedVoice = useMemo(
    () => videos.find(video => video.video_id === history?.videoId)?.data.dubbing,
    [videos, history?.videoId]
  );
  const voice =
    voices.find(group => group.key === (selectedVoice ?? localVoice))?.name ||
    savedVoice ||
    voices[0]?.name ||
    '';
  const videoByNumber = useMemo(
    () => new Map(voiceVideos(videos, voice).map(video => [video.number, video])),
    [videos, voice]
  );
  const episodes = useMemo(
    () =>
      [...new Set(videos.map(video => video.number))]
        .filter(number => number.includes(query.trim()))
        .sort((a, b) => a.localeCompare(b, 'ru', { numeric: true })),
    [videos, query]
  );

  const settings = usePlaybackSettings();
  const quality = preferredStreamQuality(settings.quality);
  const episodeDownloads = useEpisodeDownloads({
    open: active,
    anime,
    videos,
    voice,
    quality,
    online,
  });

  return (
    <div class="anime-episode-list" data-tv-focus-group>
      {loading && !voices.length ? (
        <p class="collection-note" role="status">
          Загружаем серии…
        </p>
      ) : error && !voices.length ? (
        <ErrorState error={error} retry={retry} />
      ) : !voices.length ? (
        <Empty title="Серии пока не появились">Попробуй вернуться позже.</Empty>
      ) : (
        <>
          <EpisodeVoiceTabs
            voices={voices}
            value={voiceKey(voice)}
            onChange={onVoiceChange ?? setLocalVoice}
          />
          {renderSubscription?.(voiceKey(voice))}
          <EpisodeListControls layout={episodeLayout} query={query} onQuery={setQuery} />
          <EpisodeDownloadToolbar controls={episodeDownloads} onClick={close} />
          {episodes.length ? (
            <div class={`episode-cards${cards ? ' episode-cards-grid' : ''}`}>
              {episodes.map(number => {
                const video = videoByNumber.get(number);
                return video ? (
                  <AboutEpisodeCard
                    key={number}
                    anime={anime}
                    video={video}
                    history={history}
                    savedVoice={savedVoice}
                    accountId={accountId}
                    downloads={episodeDownloads?.forEpisode}
                    knownVideoIds={knownVideoIds}
                    quality={quality}
                    online={online}
                    voice={voice}
                    close={close}
                  />
                ) : (
                  <div class="episode-card episode-unavailable" key={number}>
                    {cards && <EpisodePreview icon={null} />}
                    <EpisodeCaption title={`Серия ${number}`}>Нет в этой озвучке</EpisodeCaption>
                  </div>
                );
              })}
            </div>
          ) : (
            <p class="collection-note">Такая серия не найдена.</p>
          )}
          {renderSources?.(voiceKey(voice))}
        </>
      )}
    </div>
  );
};

export const AboutEpisodes: FC<TAboutEpisodesProps> = ({ open, close, ...props }) => (
  <Sidebar
    open={open}
    title="Серии"
    subtitle={props.anime.title}
    close={close}
    className="episodes-sidebar about-episodes-sidebar"
  >
    <AnimeEpisodeList {...props} active={open} close={close} />
  </Sidebar>
);
