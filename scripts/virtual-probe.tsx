import { render } from 'preact';
import { InterfaceEffects } from '~/components/InterfaceEffects';
import { CardTitleTooltip, VirtualGrid } from '~/ui';

import { AnimeCard } from '~/components/AnimeCard';

const titles = Array.from({ length: 10000 }, (_, index) => ({
  anime_id: index + 1,
  anime_url: `test-${index}`,
  title:
    index === 0
      ? 'Очень длинное название аниме, которое нужно ограничить двумя строками и показать целиком во всплывающей подсказке поверх остального содержимого'
      : `Тайтл ${index + 1}`,
  year: 2026,
  type: { name: 'Сериал', shortname: 'ТВ' },
}));

render(
  <div class="media-app">
    <InterfaceEffects onBack={() => {}} />
    <div class="media-workspace" style={{ paddingLeft: 0 }}>
      <main id="main" class="media-scroll" tabIndex={-1}>
        <div class="media-scroll-content">
          <h1>10 000 карточек</h1>
          <VirtualGrid
            items={titles}
            itemKey={item => item.anime_id}
            renderItem={anime => <AnimeCard anime={anime} />}
          />
        </div>
      </main>
    </div>
    <CardTitleTooltip />
  </div>,
  document.getElementById('app')!
);
