import type { ComponentChildren, FunctionalComponent as FC, JSX, RefObject } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { PlaybackMedia } from '~/lib/playback-media';
import { useFullscreen } from '~/hooks/useFullscreen';
import { useMediaStatus } from '~/hooks/useMediaStatus';
import { isDesktop, isDesktopWindow } from '~/lib/desktop';
import { focusTarget, keyboardTargets } from '~/lib/keyboard-navigation';
import { saveInterfaceSettings } from '~/lib/interface-settings';
import { mediaAtEnd } from '~/lib/media-state';
import type { PictureInPictureControls } from '~/lib/native-playback';
import { PLAYBACK_RATES, setPlaybackRate } from '~/lib/playback-rate';
import { savePlaybackSettings } from '~/lib/playback-settings';
import { formatTime } from '~/lib/player';
import { isTvMode, type TvEpisodeControl } from '~/lib/tv-mode';

import { PlaybackLoader } from './PlaybackLoader';
import { VideoUpscaleSetting } from './PlaybackSettings';
import { PictureInPictureButton } from './PictureInPictureButton';
import { VideoTimeline } from './VideoTimeline';
import { Dropdown, Icon, Input } from '~/ui';

const physical: Partial<Record<string, string>> = {
  KeyK: 'k',
  KeyJ: 'j',
  KeyL: 'l',
  KeyM: 'm',
  KeyF: 'f',
  Space: ' ',
};

const keyboardMode = () => document.documentElement.dataset.inputMode === 'keyboard';
const timelineControl = (root: HTMLElement | null) =>
  root?.querySelector<HTMLInputElement>('[data-tv-timeline]:not(:disabled)');

export const CONTROLS_IDLE_MS = 3000;

export type TVideoControlsProps = {
  native?: boolean;
  localMedia?: boolean;
  mediaVersion?: string;
  media: RefObject<PlaybackMedia>;
  frame: RefObject<HTMLDivElement>;
  title: string;
  position: number;
  loading: boolean;
  failed: boolean;
  pip?: PictureInPictureControls;
  settings: ComponentChildren;
  previous?: () => void;
  next?: () => void;
  tvEpisodeFocus?: RefObject<TvEpisodeControl>;
  manualSkip?: { label: string; run: () => void };
  quality?: ComponentChildren;
  streamInfo?: ComponentChildren;
  syncStatus?: ComponentChildren;
  onBack?: () => void;
  backLabel?: string;
  onVoice?: () => void;
  voiceLabel?: string;
  onVisibility: (visible: boolean) => void;
  onEpisodes?: () => void;
  onComments?: () => void;
};

export const VideoControls: FC<TVideoControlsProps> = ({
  native,
  localMedia = false,
  mediaVersion = '',
  media,
  frame,
  title,
  position,
  loading,
  failed,
  pip,
  settings,
  quality,
  streamInfo,
  syncStatus,
  previous,
  next,
  tvEpisodeFocus,
  manualSkip,
  onVisibility,
  onEpisodes,
  onComments,
  onBack,
  backLabel = 'Об аниме',
  onVoice,
  voiceLabel,
}) => {
  const { ended, paused, buffering, offline, duration, buffered, muted, volume, rate } =
    useMediaStatus(media, mediaVersion);
  const tv = isTvMode();
  const pendingFocus = tvEpisodeFocus?.current && (keyboardMode() || tv);
  const [visible, setVisible] = useState((!tv && !keyboardMode()) || !!pendingFocus),
    [menu, setMenu] = useState(false);
  const [activity, setActivity] = useState(0),
    [dragging, setDragging] = useState(false);
  const [pointerOnControls, setPointerOnControls] = useState(false);
  const keyboard = useRef(false);
  const controls = useRef<HTMLDivElement>(null);
  const tvEntry = useRef<'skip' | 'timeline' | 'play'>();
  const tvToolbarFocus = useRef<HTMLElement>();
  const skipButton = useRef<HTMLButtonElement>(null);
  const surfaceClickTimer = useRef<ReturnType<typeof setTimeout>>();
  const surfaceClickPlayback = useRef<{ video: PlaybackMedia; paused: boolean }>();

  useEffect(
    () => () => {
      clearTimeout(surfaceClickTimer.current);
      surfaceClickPlayback.current = undefined;
    },
    [mediaVersion, failed]
  );

  const menuElement = useRef<HTMLDivElement>(null),
    menuButton = useRef<HTMLButtonElement>(null);

  const wake = useCallback(() => {
    setVisible(true);
    setActivity(value => value + 1);
  }, []);

  useEffect(() => {
    if (tv) return;
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || keyboardMode()) return;
      if (event.type === 'pointerover' && keyboard.current) return;
      if (event.type !== 'pointerover') {
        keyboard.current = false;
        if (tvEpisodeFocus) tvEpisodeFocus.current = null;
      }

      const target = event.target;
      setPointerOnControls(
        target instanceof Element &&
          !!controls.current?.contains(target) &&
          !!target.closest('[data-controls-hover]')
      );

      if (
        document.querySelector('.media-app.is-playback') ||
        (target instanceof Node && frame.current?.contains(target)) ||
        (target instanceof Element && target.closest('.window-chrome'))
      )
        wake();
    };

    const leave = (event: PointerEvent) => {
      if (event.relatedTarget === null) setPointerOnControls(false);
    };
    const blur = () => setPointerOnControls(false);

    const pointerInteraction = () => {
      if (!keyboard.current) return;
      keyboard.current = false;
      if (tvEpisodeFocus) tvEpisodeFocus.current = null;
      wake();
    };

    window.addEventListener('pointerdown', pointerInteraction, { passive: true });
    window.addEventListener('wheel', pointerInteraction, { passive: true });
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerover', move, { passive: true });
    window.addEventListener('pointerout', leave, { passive: true });
    window.addEventListener('blur', blur);

    return () => {
      window.removeEventListener('pointerdown', pointerInteraction);
      window.removeEventListener('wheel', pointerInteraction);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerover', move);
      window.removeEventListener('pointerout', leave);
      window.removeEventListener('blur', blur);
    };
  }, [frame, tv, tvEpisodeFocus, wake]);

  const focusTimeline = useCallback(() => {
    if (tvEpisodeFocus) tvEpisodeFocus.current = null;
    const timeline = visible && timelineControl(controls.current);
    if (timeline) {
      if (document.activeElement !== timeline) focusTarget(timeline);
    } else tvEntry.current = 'timeline';
    wake();
  }, [tvEpisodeFocus, visible, wake]);

  useEffect(() => {
    const video = media.current;
    video?.addEventListener('yumiwatch:manual-seek', focusTimeline);
    return () => video?.removeEventListener('yumiwatch:manual-seek', focusTimeline);
  }, [media, mediaVersion, focusTimeline]);

  const seek = useCallback(
    (time: number) => {
      const video = media.current;
      if (failed || loading || !video || !Number.isFinite(video.duration) || video.duration <= 0)
        return;
      video.currentTime = Math.max(0, Math.min(video.duration, time));
      focusTimeline();
    },
    [failed, loading, media, focusTimeline]
  );

  const togglePlay = useCallback(
    (showControls = true) => {
      const video = media.current;

      if (!video) return;
      if (mediaAtEnd(video)) {
        video.currentTime = 0;
        void video.play().catch(() => {});
      } else if (video.paused) void video.play().catch(() => {});
      else video.pause();
      if (showControls) wake();
    },
    [media, wake]
  );

  const toggleMute = useCallback(() => {
    if (media.current) {
      media.current.muted = !media.current.muted;
      savePlaybackSettings({ muted: media.current.muted });
    }
    wake();
  }, [media, wake]);

  const changeEpisode = useCallback(
    (control: TvEpisodeControl, action?: () => void) => {
      if (!action) return;
      if (visible && tvEpisodeFocus) tvEpisodeFocus.current = tv || keyboardMode() ? control : null;
      action();
    },
    [tv, visible, tvEpisodeFocus]
  );

  useEffect(() => {
    if (!tv) return;
    const transport = (event: Event) => {
      const action = (event as CustomEvent<string>).detail;
      if (action === 'previous') return changeEpisode('previous', previous);
      if (action === 'next') return changeEpisode('next', next);
      const video = media.current;
      if (!video || loading || failed) return;
      if (action === 'toggle' || (action === 'play' && (video.paused || mediaAtEnd(video))))
        togglePlay(false);
      else if (action === 'pause' && !video.paused) video.pause();
      else if (action === 'forward' || action === 'rewind')
        seek(video.currentTime + (action === 'forward' ? 10 : -10));
    };
    window.addEventListener('yumiwatch:tv-media', transport);
    return () => window.removeEventListener('yumiwatch:tv-media', transport);
  }, [tv, failed, loading, media, togglePlay, seek, changeEpisode, previous, next]);

  const {
    fullscreen,
    error: fullError,
    toggle: toggleFullscreen,
  } = useFullscreen(frame, tv ? undefined : wake);

  const surfaceClick = useCallback(
    (event: MouseEvent) => {
      if (tv) {
        togglePlay(false);
        return;
      }
      clearTimeout(surfaceClickTimer.current);
      if (event.detail > 1) return;
      surfaceClickPlayback.current = undefined;
      if (!visible) {
        wake();

        return;
      }
      // Keyboard activation stays immediate. Wait briefly before a mouse click so
      // a double click can change fullscreen without pausing the video.
      if (!event.detail) {
        togglePlay();

        return;
      }

      const video = media.current;

      if (!video) return;
      surfaceClickPlayback.current = { video, paused: video.paused };
      surfaceClickTimer.current = setTimeout(() => {
        if (media.current === video) togglePlay();
      }, 250);
    },
    [tv, visible, wake, togglePlay, media]
  );

  const surfaceDoubleClick = useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      clearTimeout(surfaceClickTimer.current);

      const before = surfaceClickPlayback.current;

      surfaceClickPlayback.current = undefined;
      // Respect slower double clicks too, after the single-click delay elapsed.
      if (before && before.video === media.current && before.video.paused !== before.paused) {
        if (before.paused) before.video.pause();
        else void before.video.play().catch(() => {});
      }
      void toggleFullscreen();
    },
    [media, toggleFullscreen]
  );

  useEffect(() => {
    const up = () => setDragging(false);

    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);

    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, []);

  useEffect(() => {
    const pointerMode = !tv && !keyboard.current && !keyboardMode();
    if (
      paused ||
      loading ||
      failed ||
      buffering ||
      menu ||
      dragging ||
      (pointerMode && pointerOnControls)
    ) {
      if (pointerMode || menu || dragging) setVisible(true);

      return;
    }
    if (!visible) return;

    const timer = setTimeout(() => {
      const root = controls.current;
      const active = document.activeElement;
      if (active !== root && root?.contains(active)) {
        if (tv || keyboard.current || keyboardMode()) root.focus({ preventScroll: true });
        else if (active instanceof HTMLElement) active.blur();
      }
      if (tvEpisodeFocus) tvEpisodeFocus.current = null;
      setVisible(false);
    }, CONTROLS_IDLE_MS);

    return () => clearTimeout(timer);
  }, [
    tv,
    paused,
    loading,
    failed,
    buffering,
    menu,
    dragging,
    pointerOnControls,
    activity,
    visible,
    tvEpisodeFocus,
  ]);

  useEffect(() => {
    onVisibility(visible);
  }, [visible]);

  useEffect(() => {
    if (failed) setMenu(false);
  }, [failed]);

  useEffect(() => {
    if (!menu) return;

    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      const listbox = target instanceof Element ? target.closest('.settings-dropdown-menu') : null;
      const ownerId = listbox?.getAttribute('aria-labelledby');
      const owner = ownerId ? document.getElementById(ownerId) : null;

      if (
        menuElement.current?.contains(target) ||
        menuButton.current?.contains(target) ||
        (owner && menuElement.current?.contains(owner))
      )
        return;
      setMenu(false);
      wake();
      if (
        !(target instanceof HTMLElement && target.closest('.native-auto-action')) &&
        (controls.current?.closest('.universal-frame') || frame.current)?.contains(target)
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    document.addEventListener('click', outside, true);

    return () => document.removeEventListener('click', outside, true);
  }, [menu]);

  useLayoutEffect(() => {
    if (!visible || failed) return;
    const root = controls.current;
    const pending =
      document.documentElement.dataset.inputMode !== 'pointer' && tvEpisodeFocus?.current;
    if (pending) {
      // The source may replace the player again before the controls hide.
      const target =
        root?.querySelector<HTMLElement>(`[data-tv-episode-control="${pending}"]:not(:disabled)`) ||
        root?.querySelector<HTMLElement>(
          pending === 'next' ? '.video-volume button' : '.video-toolbar button'
        );
      if (target) focusTarget(target);
      return;
    }
    if (!tvEntry.current) return;
    const skip = tvEntry.current === 'skip' ? skipButton.current : null;
    const timeline = tvEntry.current !== 'play' && timelineControl(root);
    const target = skip || timeline || root?.querySelector<HTMLElement>('.video-toolbar button');
    tvEntry.current = undefined;
    if (target) focusTarget(target);
  }, [visible, failed, tvEpisodeFocus]);

  const surfaceKey = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!event.repeat && !loading) togglePlay(false);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        keyboard.current = true;
        setPointerOnControls(false);
        seek((media.current?.currentTime || 0) + (event.key === 'ArrowLeft' ? -10 : 10));
      }
    },
    [loading, media, seek, togglePlay]
  );

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        failed ||
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      )
        return;

      const target = event.target instanceof HTMLElement ? event.target : null;
      const panel = document.querySelector(
        'dialog[open],[data-sidebar-open=true],[data-card-context-menu],.app-update-popover'
      );
      if (panel && !frame.current?.contains(panel)) return;
      if (event.key === 'Escape') {
        if (menuElement.current) {
          event.preventDefault();
          menuButton.current?.focus({ preventScroll: true });
          setMenu(false);
        }
        return;
      }
      if (
        !target?.matches('[data-tv-timeline]') &&
        target?.closest(
          'input,select,textarea,[role=combobox],[contenteditable]:not([contenteditable=false]),[role=textbox]'
        )
      )
        return;

      if (
        (!target || target === document.body || target.id === 'main') &&
        !panel &&
        !menuElement.current &&
        (event.key === 'Enter' || event.key === 'ArrowLeft' || event.key === 'ArrowRight')
      ) {
        if (controls.current && keyboardMode()) controls.current.focus({ preventScroll: true });
        surfaceKey(event);
        return;
      }

      const key = physical[event.code] || event.key.toLowerCase();
      if (key === ' ' && target?.closest('button,a')) return;
      if (![' ', 'k', 'j', 'l', 'm', 'f'].includes(key)) return;
      if ((key === 'j' || key === 'l') && menuElement.current) return;
      event.preventDefault();
      if (event.repeat && [' ', 'k', 'm', 'f'].includes(key)) return;
      if (key === ' ' || key === 'k') togglePlay();
      else if (key === 'j') seek((media.current?.currentTime || 0) - 10);
      else if (key === 'l') seek((media.current?.currentTime || 0) + 10);
      else if (key === 'm') toggleMute();
      else if (key === 'f' && !isDesktopWindow()) void toggleFullscreen();
    };

    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [failed, frame, media, seek, surfaceKey, toggleFullscreen, toggleMute, togglePlay]);

  const activatePointer = useCallback(
    (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
      keyboard.current = false;
      if (!tv && !(event.target as HTMLElement).closest('.video-hit-area')) wake();
    },
    [tv, wake]
  );

  const activateKeyboard: JSX.KeyboardEventHandler<HTMLDivElement> = event => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    keyboard.current = true;
    setPointerOnControls(false);
    if (event.key === 'Tab') wake();
    else if (visible) setActivity(value => value + 1);
    const target = event.target as HTMLElement;
    const surface = target === controls.current;
    const timeline = target.matches('.video-timeline input');
    const toolbar = target.closest('.video-toolbar');
    const skip = target === skipButton.current;
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    if (horizontal && toolbar) {
      event.preventDefault();
      const buttons = keyboardTargets(toolbar);
      const next = buttons[buttons.indexOf(target) + (event.key === 'ArrowRight' ? 1 : -1)];
      if (next) focusTarget(next);
    } else if ((timeline && horizontal) || (surface && (horizontal || event.key === 'Enter'))) {
      surfaceKey(event);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const root = controls.current;
      const up = event.key === 'ArrowUp';
      if (!surface) {
        const top = target.closest('.video-top-actions');
        if (!toolbar && !timeline && !top && !skip) return;
        event.preventDefault();
        if (!visible) {
          tvEntry.current = up ? 'skip' : 'timeline';
          setVisible(true);
          return;
        }
        if (toolbar) tvToolbarFocus.current = target;
        const seekBar = timelineControl(root);
        const header = root?.querySelector<HTMLElement>('.video-top-actions button');
        const play = root?.querySelector<HTMLElement>('.video-toolbar button');
        const last = tvToolbarFocus.current;
        const bottom = last?.isConnected && !last.matches(':disabled') ? last : play;
        let destination: HTMLElement | null | undefined;
        if (skip) destination = up ? header : seekBar || bottom;
        else if (timeline) destination = up ? skipButton.current || header : bottom;
        else if (toolbar && up) destination = seekBar || header;
        else if (top && !up) destination = seekBar || bottom;
        if (destination) focusTarget(destination);
        return;
      }
      event.preventDefault();
      if (visible) {
        const timelineButton = up && (skipButton.current || timelineControl(root));
        const button = timelineButton || root?.querySelector<HTMLElement>('.video-toolbar button');
        if (button) focusTarget(button);
      } else {
        tvEntry.current = up ? (skipButton.current ? 'skip' : 'timeline') : 'play';
        setVisible(true);
      }
    }
  };

  const focusControls = useCallback(
    (event: JSX.TargetedFocusEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget && (keyboard.current || keyboardMode())) {
        keyboard.current = true;
        wake();
      }
    },
    [wake]
  );

  const closeSettings = useCallback(() => {
    if (tv || keyboardMode()) menuButton.current?.focus({ preventScroll: true });
    setMenu(false);
  }, [tv]);

  const changeRate = useCallback(
    (value: string) => {
      const rate = Number(value);
      if (media.current && PLAYBACK_RATES.includes(rate)) {
        setPlaybackRate(media.current, rate);
        savePlaybackSettings({ rate });
      }
      wake();
    },
    [media, wake]
  );

  const startDragging = useCallback(() => setDragging(true), []);

  const seekInput = useCallback(
    (event: JSX.TargetedInputEvent<HTMLInputElement>) => seek(Number(event.currentTarget.value)),
    [seek]
  );

  const changeVolume = useCallback(
    (event: JSX.TargetedInputEvent<HTMLInputElement>) => {
      if (media.current) {
        media.current.volume = Number(event.currentTarget.value);
        saveInterfaceSettings({ volume: media.current.volume });
        if (media.current.muted) {
          media.current.muted = false;
          savePlaybackSettings({ muted: false });
        }
      }
      wake();
    },
    [media, wake]
  );

  const toggleSettings = useCallback(() => {
    setMenu(value => !value);
    wake();
  }, [wake]);

  const fullscreenAction = useCallback(() => void toggleFullscreen(), [toggleFullscreen]);

  const controlError = pip?.error || fullError;

  return (
    <div
      ref={controls}
      inert={failed}
      aria-hidden={failed}
      class={`video-controls ${visible ? 'is-visible' : 'is-hidden'}`}
      tabIndex={0}
      aria-label="Видеоплеер"
      data-tv-player
      data-tv-controls-open={visible ? 'true' : undefined}
      onPointerDown={activatePointer}
      onKeyDown={activateKeyboard}
      onFocusIn={focusControls}
    >
      <button
        class="video-hit-area"
        tabIndex={-1}
        aria-label={
          visible ? (paused ? 'Воспроизвести видео' : 'Приостановить видео') : 'Показать управление'
        }
        onClick={surfaceClick}
        onDblClick={tv ? undefined : surfaceDoubleClick}
      />
      {manualSkip && (
        <button ref={skipButton} class="button native-skip-overlay" onClick={manualSkip.run}>
          {manualSkip.label}
        </button>
      )}
      {(onBack || onVoice) && (
        <div class="video-chrome video-top-actions" inert={!visible} data-controls-hover>
          {onBack && (
            <button aria-label={backLabel} title={`${backLabel} (I)`} onClick={onBack}>
              <Icon name="back" size={21} />
              <span>{backLabel}</span>
            </button>
          )}
          {onVoice && (
            <button aria-label={`Озвучка: ${voiceLabel || 'Выбрать'}`} onClick={onVoice}>
              <Icon name="volume" size={19} />
              <span>{voiceLabel || 'Озвучка'}</span>
              <Icon name="chevron" size={15} />
            </button>
          )}
        </div>
      )}
      <div class="video-chrome video-heading">
        <span class="video-brand">YUMMYWATCH</span>
        <strong>{title}</strong>
        {streamInfo}
      </div>
      {syncStatus && (
        <span class="video-chrome video-save-status" role="status">
          {syncStatus}
        </span>
      )}
      {pip?.active && !loading && !failed && !buffering && (
        <button
          class="video-pip-return"
          data-controls-hover
          disabled={pip.pending}
          onClick={pip.toggle}
        >
          <Icon name="pictureInPicture" size={22} />
          Вернуть видео в плеер
        </button>
      )}
      {!pip?.active && paused && !loading && !failed && !buffering && (!tv || !visible) && (
        <button
          class="video-center-play"
          data-controls-hover
          aria-label={ended ? 'Смотреть заново' : 'Продолжить просмотр'}
          tabIndex={-1}
          onClick={surfaceClick}
          onDblClick={tv ? undefined : surfaceDoubleClick}
        >
          <Icon name="play" size={32} />
        </button>
      )}
      {buffering && !paused && !loading && !failed && (
        <PlaybackLoader
          label={offline && !localMedia ? 'Соединение потеряно' : 'Буферизация…'}
          detail={offline && !localMedia ? 'Ждём сеть. Позиция сохранена.' : 'Подгружаем видео'}
        />
      )}
      {menu && (
        <div
          ref={menuElement}
          class="video-settings"
          role="dialog"
          aria-label="Настройки плеера"
          data-controls-hover
          data-tv-vertical
        >
          <div class="video-settings-heading">
            <strong>Настройки плеера</strong>
            <button aria-label="Закрыть настройки" onClick={closeSettings} data-tv-close>
              <Icon name="close" />
            </button>
          </div>
          <div class="video-settings-selects">
            {quality}
            <label class="video-setting-field">
              <span>Скорость</span>
              <Dropdown
                aria-label="Скорость воспроизведения"
                data-nav-primary
                value={String(rate)}
                onChange={changeRate}
                options={PLAYBACK_RATES.map(rate => ({ value: String(rate), label: `${rate}×` }))}
              />
            </label>
            {native && <VideoUpscaleSetting />}
          </div>
          {settings}
          <p class="video-shortcuts">
            {tv
              ? 'OK — пауза · ← / → — 10 секунд · ↑ / ↓ — управление'
              : 'Enter / Пробел — пауза · ← / → — 10 секунд · ↑ / ↓ — управление · M — звук · F — полный экран'}
          </p>
        </div>
      )}
      <div
        class="video-chrome video-bottom"
        role="group"
        aria-label="Управление воспроизведением"
        inert={!visible}
        data-controls-hover
      >
        <VideoTimeline
          mediaVersion={mediaVersion}
          media={media}
          duration={duration}
          position={position}
          buffered={buffered}
          visible={visible && !loading && !failed}
          onPointerDown={startDragging}
          onInput={seekInput}
        />
        <div class="video-toolbar">
          <button
            aria-label={ended ? 'Смотреть заново' : paused ? 'Воспроизвести' : 'Пауза'}
            title="Пауза / воспроизведение (K)"
            onClick={() => togglePlay()}
          >
            <Icon name={paused ? 'play' : 'pause'} size={22} />
          </button>
          <button
            class="video-previous"
            aria-label="Предыдущая серия"
            disabled={!previous}
            data-tv-episode-control="previous"
            onClick={() => changeEpisode('previous', previous)}
          >
            <Icon name="skipBack" />
          </button>
          <button
            aria-label="Следующая серия"
            disabled={!next}
            data-tv-episode-control="next"
            onClick={() => changeEpisode('next', next)}
          >
            <Icon name="skipNext" />
          </button>
          <span class="video-time">
            {formatTime(position)}
            <span> / {formatTime(duration)}</span>
          </span>
          <div class="video-volume">
            <button
              aria-label={muted || !volume ? 'Включить звук' : 'Выключить звук'}
              title="Звук (M)"
              onClick={toggleMute}
            >
              <Icon name={muted || !volume ? 'volumeOff' : 'volume'} />
            </button>
            <Input
              aria-label="Громкость"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={muted ? 0 : volume}
              onPointerDown={startDragging}
              onInput={changeVolume}
            />
          </div>
          {onEpisodes && (
            <button aria-label="Серии" title="Серии (E)" onClick={onEpisodes}>
              <Icon name="list" />
            </button>
          )}
          {onComments && (
            <button aria-label="Комментарии" title="Комментарии (C)" onClick={onComments}>
              <Icon name="comment" />
            </button>
          )}
          <button
            ref={menuButton}
            aria-label="Настройки плеера"
            aria-expanded={menu}
            title="Настройки"
            onClick={toggleSettings}
          >
            <Icon name="settings" />
          </button>
          {pip && !failed && <PictureInPictureButton pip={pip} />}
          {(!isDesktop() || isDesktopWindow()) && (
            <button
              aria-label={fullscreen ? 'Выйти из полного экрана' : 'Полный экран'}
              title="Полный экран (F)"
              onClick={fullscreenAction}
            >
              <Icon name={fullscreen ? 'minimize' : 'fullscreen'} />
            </button>
          )}
        </div>
      </div>
      {controlError && (
        <p class="video-fullscreen-error" role="status">
          {controlError}
        </p>
      )}
    </div>
  );
};
