import { useEffect, useState } from 'preact/hooks';

import { useSession } from '~/lib/hooks';
import { formatTime } from '~/lib/player';
import {
  resetVoiceRanking,
  setVoiceRanking,
  VOICE_RANKING_EVENT,
  voiceRanking,
} from '~/lib/voice-ranking';
import { Button, Icon, SettingsCard, Toggle } from '~/ui';

export function VoiceRankingSettings() {
  const session = useSession();
  const [ranking, setRanking] = useState(voiceRanking);
  useEffect(() => {
    const update = () => setRanking(voiceRanking());
    update();
    window.addEventListener(VOICE_RANKING_EVENT, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(VOICE_RANKING_EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, [session?.user.id]);
  return (
    <SettingsCard title="Рейтинг озвучек" icon={<Icon name="list" size={25} />}>
      <Toggle
        checked={ranking.enabled}
        onChange={event => setVoiceRanking(event.currentTarget.checked)}
      >
        Подбирать озвучку при начале просмотра
      </Toggle>
      {ranking.voices.length ? (
        <>
          <ol class="voice-ranking">
            {ranking.voices.map(voice => (
              <li key={voice.name}>
                <strong>{voice.name}</strong>
                <small>
                  {formatTime(voice.watched)} просмотра · {voice.choices} выбрано вручную
                </small>
              </li>
            ))}
          </ol>
          <Button variant="text" onClick={resetVoiceRanking}>
            Сбросить рейтинг
          </Button>
        </>
      ) : (
        <p>Рейтинг появится после просмотра.</p>
      )}
    </SettingsCard>
  );
}
