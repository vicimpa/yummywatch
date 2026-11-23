// Real controls and browser focus; a deterministic media element keeps this test offline.
import { render } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { VideoControls } from '~/components/VideoControls';
import { InterfaceEffects } from '~/components/InterfaceEffects';

function Probe() {
  const media = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const video = media.current!;
    Object.defineProperties(video, {
      paused: { value: false, configurable: true },
      duration: { value: 1400, configurable: true },
      readyState: { value: 4, configurable: true },
    });
  }, []);
  return (
    <div ref={frame} class="player-frame universal-frame" style={{ height: '100vh' }}>
      <InterfaceEffects onBack={() => {}} />
      <video ref={media} />
      <VideoControls
        media={media}
        frame={frame}
        title="Проверка управления"
        position={42}
        loading={false}
        failed={false}
        settings={null}
        onVisibility={() => {}}
      />
    </div>
  );
}
render(<Probe />, document.getElementById('app')!);
