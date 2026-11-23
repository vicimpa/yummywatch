import type { FunctionalComponent as FC } from 'preact';
import { useMemo } from 'preact/hooks';

import { imageUrl } from '~/lib/api';
import { useSession } from '~/lib/hooks';
import { formatTime, groupVideos, videoPosition } from '~/lib/player';
import { groupVoices, voiceKey } from '~/lib/streams';
import type { Anime, Video, WatchEntry } from '~/lib/types';
import { watchFrameKey } from '~/lib/watch-frames';

import { EpisodeCaption, EpisodePreview, OptionButton } from '~/ui';
import { EpisodeWithDownload, type EpisodeDownloads } from './EpisodeDownload';

type TVoiceOptionsProps = {
  videos: Video[];
  voice: string;
  episode: string;
  query: string;
  onSelect: (episode: string, voice: string) => void;
};

export const VoiceOptions: FC<TVoiceOptionsProps> = ({
  videos,
  voice,
  episode,
  query,
  onSelect,
}) => {
  const groups = useMemo(
    () =>
      groupVoices(videos).map(group => ({
        ...group,
        episodes: new Set(group.videos.map(video => video.number)),
      })),
    [videos]
  );
  const voices = useMemo(
    () => groups.filter(group => group.name.toLowerCase().includes(query.toLowerCase())),
    [groups, query]
  );

  return (
    <div class="source-options">
      {voices.map(group => {
        const selected = group.key === voiceKey(voice);

        return (
          <OptionButton
            key={group.key}
            selected={selected}
            label={group.name}
            description={`${group.episodes.size} серий`}
            disabled={!group.episodes.has(episode)}
            onClick={() => onSelect(episode, group.name)}
          />
        );
      })}
    </div>
  );
};

type TSourceOptionsProps = {
  videos: Video[];
  voice: string;
  episode: string;
  query: string;
  onSelect: (video: Video) => void;
  onUniversal: () => void;
};

export const SourceOptions: FC<TSourceOptionsProps> = ({
  videos,
  voice,
  episode,
  query,
  onSelect,
  onUniversal,
}) => {
  const sources = useMemo(() => [...groupVideos(videos)], [videos]);
  const groups = useMemo(
    () =>
      sources.filter(
        ([, group]) =>
          voiceKey(group.videos[0].data.dubbing) === voiceKey(voice) &&
          group.videos[0].data.player.toLowerCase().includes(query.toLowerCase())
      ),
    [sources, voice, query]
  );

  return (
    <div class="source-options">
      {'наш плеер'.includes(query.toLowerCase()) && (
        <OptionButton
          selected
          label="Наш плеер"
          description="Единое управление · автопропуск"
          onClick={onUniversal}
        />
      )}
      {groups.map(([key, group]) => {
        const video = group.videos.find(video => video.number === episode);

        return (
          <OptionButton
            key={key}
            label={group.videos[0].data.player}
            description={video ? `${group.videos.length} серий` : `Серия ${episode} недоступна`}
            disabled={!video}
            onClick={() => video && onSelect(video)}
          />
        );
      })}
    </div>
  );
};

type TEpisodeOptionsProps = {
  anime: Anime;
  videos: Video[];
  episode: string;
  query: string;
  history?: WatchEntry;
  checkpoints?: WatchEntry[];
  cacheOnly?: boolean;
  downloads?: EpisodeDownloads;
  onOpenSaved?: () => void;
  onSelect: (episode: string) => void;
};

export const EpisodeOptions: FC<TEpisodeOptionsProps> = ({
  anime,
  videos,
  episode,
  query,
  history,
  checkpoints = [],
  cacheOnly,
  downloads,
  onOpenSaved,
  onSelect,
}) => {
  const accountId = useSession()?.user.id;
  const poster = imageUrl(anime.poster?.medium || anime.poster?.big);
  const frames = useMemo(
    () =>
      new Map(anime.random_screenshots?.map(frame => [frame.episode, frame] as const).reverse()),
    [anime.random_screenshots]
  );
  const episodes = useMemo(
    () =>
      videos
        .filter(video => video.number.includes(query))
        .map(video => {
          const frame = frames.get(video.number);

          return { video, preview: imageUrl(frame?.sizes.small) || poster };
        }),
    [videos, query, frames, poster]
  );

  return (
    <div class="episode-cards">
      {episodes.map(({ video, preview }) => {
        const selected = episode === video.number;
        const entry = [history, ...checkpoints]
          .filter((entry): entry is WatchEntry => !!entry && entry.episode === video.number)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
        const saved = videoPosition(
          video,
          entry ? { ...entry, videoId: video.video_id } : undefined
        );
        const percent = saved.duration > 0 ? (saved.position / saved.duration) * 100 : 0;

        return (
          <EpisodeWithDownload
            key={video.number}
            episode={video.number}
            selected={selected}
            downloads={downloads}
            onOpenSaved={onOpenSaved}
          >
            <button
              aria-label={`Серия ${video.number}`}
              aria-pressed={selected}
              class={`episode-card ${selected ? 'selected' : ''}`}
              onClick={() => onSelect(video.number)}
            >
              <EpisodePreview
                src={preview}
                frameKey={watchFrameKey(anime.anime_id, video.number, accountId)}
                cacheOnly={cacheOnly}
                fallbackSrc={poster}
                progress={percent}
                duration={saved.duration > 0 ? formatTime(saved.duration) : undefined}
                icon={percent >= 95 ? 'check' : 'play'}
              />
              <EpisodeCaption title={`Серия ${video.number}`}>
                {saved.position > 0 ? `Просмотрено ${formatTime(saved.position)}` : 'Смотреть'}
              </EpisodeCaption>
            </button>
          </EpisodeWithDownload>
        );
      })}
    </div>
  );
};
