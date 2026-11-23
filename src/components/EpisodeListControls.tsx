import type { FunctionalComponent as FC } from 'preact';

import { saveInterfaceSettings, type InterfaceSettings } from '~/lib/interface-settings';
import { notify } from '~/lib/notifications';
import { Button, SearchField } from '~/ui';

type Props = {
  layout: InterfaceSettings['episodeLayout'];
  query: string;
  onQuery: (value: string) => void;
};

const layouts = [
  ['cards', 'Карточки'],
  ['list', 'Список'],
] as const;

export const EpisodeListControls: FC<Props> = ({ layout, query, onQuery }) => (
  <div class="episode-list-controls">
    <SearchField
      value={query}
      onValueChange={onQuery}
      label="Найти серию"
      placeholder="Номер серии"
    />
    <div class="episode-layout-switch" role="group" aria-label="Вид списка серий">
      {layouts.map(([value, label]) => (
        <Button
          key={value}
          type="button"
          variant="text"
          aria-pressed={layout === value}
          onClick={() => {
            if (layout === value) return;
            try {
              saveInterfaceSettings({ episodeLayout: value });
            } catch (reason) {
              notify((reason as Error).message);
            }
          }}
        >
          {label}
        </Button>
      ))}
    </div>
  </div>
);
