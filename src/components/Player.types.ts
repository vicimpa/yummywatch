import type { RefObject } from 'preact';

import type { StoredPlayback } from '~/lib/downloads';
import type { PlaybackMedia } from '~/lib/playback-media';
import type { PictureInPictureControls } from '~/lib/native-playback';
import type { PlaybackReport } from '~/lib/playback-session';
import type { Anime, Video, WatchEntry } from '~/lib/types';

export type MediaPanel = 'comments' | 'episodes' | null;

export type TPlayerProps = {
  presentation?: 'immersive';
  modeOverride?: 'source' | 'universal';
  onBack?: () => void;
  backLabel?: string;
  panel?: MediaPanel;
  onPanelChange?: (panel: MediaPanel) => void;
  onComments?: () => void;
  fullscreenContainer?: RefObject<HTMLDivElement>;
  background?: boolean;
  watchMedia?: RefObject<PlaybackMedia>;
  pip?: PictureInPictureControls;
  preferredVoice?: string;
  preferredEpisode?: string;
  startPlaying?: boolean;
  newWatch?: boolean;
  onSelectPlayer?: (
    video: Video,
    mode: 'source' | 'universal',
    position: number,
    duration: number
  ) => void;
  anime: Anime;
  offline?: StoredPlayback;
  history?: WatchEntry;
  resumePending?: boolean;
  onCheckpoint?: (entry: WatchEntry) => void;
  onPlayback?: (event: PlaybackReport) => void;
};
