import type { FunctionalComponent as FC } from 'preact';

import { ChoiceTabs } from '~/ui';

type Props = {
  voices: { key: string; name: string }[];
  value: string;
  onChange: (value: string) => void;
};

export const EpisodeVoiceTabs: FC<Props> = ({ voices, value, onChange }) => (
  <ChoiceTabs
    label="Озвучка серий"
    class="episode-voice-tabs"
    value={value}
    onChange={onChange}
    choices={voices.map(({ key, name }) => [key, name.replace(/^Озвучка\s+/i, '') || 'Оригинал'])}
  />
);
