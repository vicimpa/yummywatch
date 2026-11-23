import type { ComponentChildren, FunctionalComponent as FC, JSX } from 'preact';

import { useCachedImage } from '~/hooks/useCachedImage';
import { useWatchFrame } from '~/hooks/useWatchFrame';

import { CachedImage } from './CachedImage';
import { Icon, type IconName } from './Icon';

export type TEpisodePreviewProps = {
  src?: string;
  frameKey?: string;
  cacheOnly?: boolean;
  fallbackSrc?: string;
  alt?: string;
  poster?: boolean;
  progress?: number;
  duration?: string;
  icon?: IconName | null;
  hideBrokenImage?: boolean;
};

const hideImage = (event: JSX.TargetedEvent<HTMLImageElement>) => {
  event.currentTarget.style.visibility = 'hidden';
};

export const EpisodePreview: FC<TEpisodePreviewProps> = ({
  src,
  frameKey,
  cacheOnly,
  fallbackSrc,
  alt = '',
  poster,
  progress = 0,
  duration,
  icon = 'play',
  hideBrokenImage,
}) => {
  const frame = useWatchFrame(frameKey);
  const cached = useCachedImage(cacheOnly && !frame ? src : undefined, false);
  const fallback = useCachedImage(
    cacheOnly && !frame && !cached && fallbackSrc !== src ? fallbackSrc : undefined,
    false
  );
  const local = frame || cached || fallback;
  const onError = hideBrokenImage ? hideImage : undefined;
  return (
    <div class={poster && !frame ? 'episode-preview poster-preview' : 'episode-preview'}>
      {local ? (
        <img src={local} alt={alt} loading="lazy" decoding="async" onError={onError} />
      ) : !cacheOnly && src ? (
        <CachedImage src={src} alt={alt} onError={onError} />
      ) : null}
      {icon && (
        <span class="episode-play">
          <Icon name={icon} size={20} />
        </span>
      )}
      {duration && <span class="episode-duration">{duration}</span>}
      {progress > 0 && (
        <span class="episode-progress" style={{ width: `${Math.min(100, progress)}%` }} />
      )}
    </div>
  );
};

export type TEpisodeCaptionProps = { title: string; children?: ComponentChildren };

export const EpisodeCaption: FC<TEpisodeCaptionProps> = ({ title, children }) => (
  <span class="episode-caption">
    <strong>{title}</strong>
    {children && <small>{children}</small>}
  </span>
);
