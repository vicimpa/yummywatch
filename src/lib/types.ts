export interface Anime {
  anime_id: number;
  anime_url: string;
  title: string;
  description?: string;
  poster?: { medium?: string; big?: string; huge?: string; fullsize?: string; mega?: string };
  rating?: { average: number; counters?: number };
  user?: { rating?: number; list?: { is_fav?: boolean; list?: { id?: number } | null } };
  year?: number;
  type?: { name?: string; shortname?: string; alias?: string };
  anime_status?: { title: string; alias: string };
  genres?: { title: string; id: number; alias: string }[];
  episodes?: { aired: number; count: number; next_date?: number; prev_date?: number };
  min_age?: { title: string; title_long?: string };
  studios?: { title: string }[];
  videos?: Video[];
  random_screenshots?: {
    episode?: string;
    time?: number;
    sizes: { small: string; full: string };
  }[];
  comments_count?: number;
  viewing_order?: Anime[];
}

export interface Video {
  video_id: number;
  iframe_url: string;
  data: { dubbing: string; player: string; player_id: number };
  number: string;
  index: number;
  duration?: number;
  watched?: { end_time: number; date: number };
  skips?: {
    opening?: { time: number; length: number } | null;
    ending?: { time: number; length: number } | null;
  };
}

export interface WatchEntry {
  anime: Anime;
  episode: string;
  group: string;
  videoId: number;
  updatedAt: number;
  position?: number;
  duration?: number;
  preview?: string;
  playing?: boolean;
  completed?: boolean;
}

export interface Library {
  favorites: Anime[];
  history: WatchEntry[];
  lists?: Partial<Record<import('./lists').WatchListId, Anime[]>>;
  rated?: Anime[];
}

export interface Result<T> {
  data: T;
  cached: boolean;
  savedAt: number;
  revalidate?: Promise<Result<T>>;
}

export type Params = Record<string, string | number | boolean | undefined>;
