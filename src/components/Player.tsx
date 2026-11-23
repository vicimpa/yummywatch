import type { FunctionalComponent as FC } from 'preact';
import { useCallback, useMemo, useRef } from 'preact/hooks';

import { isContinueHidden } from '~/lib/continue-cache';
import { useSession } from '~/lib/hooks';
import { readPlaybackRecovery } from '~/lib/playback-recovery';
import { PLAYBACK_FLUSH, savePlaybackSettings, usePlaybackSettings } from '~/lib/playback-settings';
import { groupKey } from '~/lib/player';
import { writeJSON } from '~/lib/storage';
import type { WatchEntry } from '~/lib/types';

import type { TPlayerProps } from './Player.types';
import { SourcePlayer } from './SourcePlayer';
import { UniversalPlayer } from './UniversalPlayer';

export type { TPlayerProps } from './Player.types';

export const Player: FC<TPlayerProps> = ({
  anime,
  history,
  onCheckpoint,
  onPlayback,
  ...options
}) => {
  const session = useSession();
  const settings = usePlaybackSettings();
  const mode = options.modeOverride || settings.mode;
  const saved = useRef<{ token: string | null; entry: WatchEntry }>();
  const handoff = useRef<{
    token: string | null;
    mode: 'source' | 'universal';
    entry: WatchEntry;
  }>();
  const recovered = useMemo(
    () => readPlaybackRecovery(anime.anime_id),
    [anime.anime_id, session?.token]
  );
  const latest = [
    saved.current?.token === (session?.token || null) ? saved.current.entry : undefined,
    recovered,
    history,
  ].filter((entry): entry is WatchEntry => entry?.anime.anime_id === anime.anime_id);
  const requested =
    handoff.current?.token === (session?.token || null) && handoff.current.mode === mode
      ? handoff.current.entry
      : undefined;
  const entry =
    requested ||
    (!isContinueHidden(anime.anime_id)
      ? latest.sort((a, b) => b.updatedAt - a.updatedAt)[0]
      : undefined);

  const checkpoint = useCallback(
    (entry: WatchEntry) => {
      saved.current = { token: session?.token || null, entry };
      if (handoff.current?.mode === mode) handoff.current = undefined;
      onCheckpoint?.(entry);
    },
    [session, mode, onCheckpoint]
  );

  const selectPlayer = useCallback<NonNullable<TPlayerProps['onSelectPlayer']>>(
    (video, mode, position, duration) => {
      window.dispatchEvent(new Event(PLAYBACK_FLUSH));
      saved.current = {
        token: session?.token || null,
        entry: {
          anime,
          episode: video.number,
          videoId: video.video_id,
          group: groupKey(video),
          position,
          duration,
          updatedAt: Date.now(),
        },
      };
      handoff.current = { ...saved.current, mode };
      if (mode === 'source')
        writeJSON('yumiwatch:player-preference', {
          dubbing: video.data.dubbing,
          player: video.data.player_id,
        });
      savePlaybackSettings({ mode });
    },
    [session, anime]
  );

  return mode === 'universal' ? (
    <UniversalPlayer
      key={session?.token || 'guest'}
      {...options}
      anime={anime}
      history={entry}
      onCheckpoint={checkpoint}
      onPlayback={onPlayback}
      onSelectPlayer={selectPlayer}
    />
  ) : (
    <SourcePlayer
      key={session?.token || 'guest'}
      {...options}
      anime={anime}
      history={entry}
      onCheckpoint={checkpoint}
      onSelectPlayer={selectPlayer}
    />
  );
};
