import { render } from 'preact';
import { Gallery } from '~/components/Gallery';
import { InterfaceEffects } from '~/components/InterfaceEffects';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { VideoControls } from '~/components/VideoControls';
import { setPlayerChrome } from '~/lib/player-chrome';

function CursorProbe() {
  const media = useRef<HTMLVideoElement>(null),
    frame = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    document.documentElement.dataset.screen = 'watch';
    Object.defineProperties(media.current!, {
      paused: { value: false, configurable: true },
      readyState: { value: 4, configurable: true },
      duration: { value: 1400, configurable: true },
    });
  }, []);

  return (
    <div class="media-app is-playback">
      <div class="window-chrome">
        <div class="window-drag-region" />
        <button class="cursor-header">Кнопка окна</button>
      </div>
      <div ref={frame} class="player-frame" style={{ height: '100dvh' }}>
        <video ref={media} />
        <VideoControls
          media={media}
          frame={frame}
          title="Тест"
          position={1}
          loading={false}
          failed={false}
          settings={null}
          onVisibility={setPlayerChrome}
        />
      </div>
    </div>
  );
}

render(
  location.hash === '#/cursor' ? (
    <CursorProbe />
  ) : (
    <div class="media-app">
      <InterfaceEffects onBack={() => {}} />
      <div class="media-workspace" style={{ paddingLeft: 0 }}>
        <main id="main" class="media-scroll" tabIndex={-1}>
          <div class="media-scroll-content">
            <Gallery />
          </div>
        </main>
      </div>
    </div>
  ),
  document.getElementById('app')!
);
