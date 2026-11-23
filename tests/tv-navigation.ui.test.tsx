// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InterfaceEffects } from '~/components/InterfaceEffects';
import { useVisualViewport } from '~/lib/hooks';
import { Dropdown, Input, Sheet, VirtualGrid } from '~/ui';

const frame = () =>
  act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
const press = (key: string, repeat = false) =>
  fireEvent.keyDown(document.activeElement!, { key, repeat });

beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.dataset.tv = 'true';
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (
    this: HTMLElement
  ) {
    return { length: this.closest('[hidden]') ? 0 : 1 } as DOMRectList;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const x = Number(this.dataset.x) || 0;
    const y = Number(this.dataset.y) || 0;
    const width = Number(this.dataset.width) || 100;
    return {
      x,
      y,
      left: x,
      top: y,
      right: x + width,
      bottom: y + 40,
      width,
      height: 40,
    } as DOMRect;
  });
});

it('moves down from a full-width search field to the first result in a row', async () => {
  render(
    <>
      <InterfaceEffects onBack={() => {}} />
      <main id="main">
        <Input type="search" aria-label="Поиск" data-width="220" />
        <button data-y="80">Первый результат</button>
        <button data-y="80" data-x="108">
          Второй результат
        </button>
      </main>
    </>
  );
  await frame();
  press('ArrowDown');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Первый результат' }));
});

it('moves between the shelf actions and its closest fully visible card', async () => {
  render(
    <>
      <InterfaceEffects onBack={() => {}} />
      <main id="main">
        <section class="gallery-shelf" data-tv-focus-group>
          <div class="gallery-shelf-actions">
            <a href="#all" data-x="410">
              Все
            </a>
          </div>
          <div class="gallery-rail" data-x="100" data-width="400" data-y="80">
            <article data-gallery-item data-x="340" data-y="80">
              <a href="#first" data-gallery-link>
                Полная карточка
              </a>
            </article>
            <article data-gallery-item data-x="450" data-y="80">
              <a href="#second" data-gallery-link>
                Частично видимая карточка
              </a>
            </article>
          </div>
        </section>
        <button data-x="410" data-y="70">
          Другой блок
        </button>
      </main>
    </>
  );
  await frame();
  const all = screen.getByRole('link', { name: 'Все' });
  all.focus();
  press('ArrowDown');
  expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Полная карточка' }));
  press('ArrowUp');
  expect(document.activeElement).toBe(all);
});

it('visits every settings control in order even when their widths differ', async () => {
  render(
    <>
      <InterfaceEffects onBack={() => {}} />
      <main id="main">
        <div data-tv-vertical>
          <button>Уведомления</button>
          <button data-x="500" data-y="60">
            Воспроизведение
          </button>
          <button data-x="400" data-y="120">
            Загрузки
          </button>
          <button data-y="180">Рейтинг озвучек</button>
        </div>
      </main>
    </>
  );
  await frame();
  for (const name of ['Воспроизведение', 'Загрузки', 'Рейтинг озвучек']) {
    press('ArrowDown');
    expect(document.activeElement).toBe(screen.getByRole('button', { name }));
  }
  press('ArrowUp');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Загрузки' }));
});

it('stays in the profile column and enters the tab row on the selected tab', async () => {
  render(
    <>
      <InterfaceEffects onBack={() => {}} />
      <main id="main">
        <div class="profile-page">
          <nav data-tv-tabs>
            <a href="#one" data-y="60">
              Обзор
            </a>
            <a href="#two" data-y="60" data-x="130" aria-current="page">
              Статистика
            </a>
          </nav>
          <div data-tv-profile-column>
            <button data-y="130" data-width="220">
              Продолжить просмотр
            </button>
            <button data-y="200" data-x="230">
              Всё на своих местах
            </button>
          </div>
          <div data-tv-profile-column>
            <button data-y="185" data-x="340">
              Аниме по душе
            </button>
          </div>
        </div>
      </main>
    </>
  );
  await frame();
  const resume = screen.getByRole('button', { name: 'Продолжить просмотр' });
  resume.focus();
  press('ArrowDown');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Всё на своих местах' }));
  press('ArrowUp');
  expect(document.activeElement).toBe(resume);
  press('ArrowUp');
  expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Статистика' }));
  press('ArrowLeft');
  expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Обзор' }));
});

it('scrolls to the end of read-only content and returns to a visible focus before activating it', async () => {
  const activate = vi.fn();
  render(
    <>
      <InterfaceEffects onBack={() => {}} />
      <main id="main" role="main" style={{ overflowY: 'auto' }}>
        <button data-y="20" onClick={activate}>
          Последний элемент
        </button>
        <p>Статистика без элементов управления</p>
      </main>
    </>
  );
  const main = screen.getByRole('main');
  const button = screen.getByRole('button');
  Object.defineProperties(main, { scrollHeight: { value: 115 }, clientHeight: { value: 40 } });
  Object.defineProperty(button, 'getBoundingClientRect', {
    value: () => ({ top: 20 - main.scrollTop, bottom: 40 - main.scrollTop }),
  });
  await frame();
  press('ArrowDown');
  press('ArrowDown');
  press('ArrowDown');
  expect(main.scrollTop).toBe(75);
  expect(document.activeElement).toBe(button);
  press('Enter');
  fireEvent.keyUp(button, { key: 'Enter' });
  expect(activate).not.toHaveBeenCalled();
  press('ArrowUp');
  expect(main.scrollTop).toBe(15);
  press('Enter');
  expect(activate).toHaveBeenCalledOnce();
});

it('reaches a status below each poster and moves horizontally between statuses', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
  render(
    <>
      <InterfaceEffects onBack={() => {}} />
      <main id="main">
        <style>{'.virtual-grid { grid-template-columns: 180px 180px; }'}</style>
        <VirtualGrid
          items={[1, 2, 3, 4]}
          itemKey={item => item}
          renderItem={item => (
            <>
              <a data-gallery-link href={`#${item}`}>
                Аниме {item}
              </a>
              <button data-virtual-secondary>Смотрю {item}</button>
            </>
          )}
        />
      </main>
    </>
  );
  await frame();
  press('ArrowDown');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Смотрю 1' }));
  press('ArrowRight');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Смотрю 2' }));
  press('ArrowDown');
  expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Аниме 4' }));
  press('ArrowUp');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Смотрю 2' }));
  press('ArrowUp');
  expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Аниме 2' }));
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.tv;
  delete document.documentElement.dataset.inputMode;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('moves past a closed selector and activates the focused button once per OK press', async () => {
  const activate = vi.fn();
  render(
    <>
      <InterfaceEffects onBack={() => {}} />
      <main id="main">
        <Dropdown
          aria-label="Качество"
          value="720"
          options={[{ value: '720', label: '720p' }]}
          onChange={() => {}}
        />
        <button data-y="80" onClick={activate}>
          Готово
        </button>
        <button data-y="87" data-x="112">
          Соседняя кнопка
        </button>
      </main>
    </>
  );
  await frame();
  expect(document.activeElement).toBe(screen.getByRole('combobox'));
  press('Home');
  press('7');
  expect(screen.queryByRole('listbox')).toBeNull();
  press('ArrowDown');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Готово' }));
  expect(screen.queryByRole('listbox')).toBeNull();
  press('ArrowDown');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Готово' }));
  press('Enter');
  press('Enter'); // WebView 91 can omit the repeat flag.
  expect(activate).toHaveBeenCalledTimes(1);
});

it('keeps a focused search field read-only until OK and locks it again when the keyboard closes', async () => {
  const onSubmit = vi.fn();
  render(
    <>
      <InterfaceEffects onBack={() => {}} />
      <main id="main">
        <form onSubmit={onSubmit}>
          <Input type="search" aria-label="Поиск" />
          <button type="button" data-y="80">
            Быстрый выбор
          </button>
        </form>
      </main>
    </>
  );
  await frame();
  const input = screen.getByRole('searchbox') as HTMLInputElement;
  expect(document.activeElement).toBe(input);
  expect(input.readOnly).toBe(true);
  press('Enter');
  expect(input.readOnly).toBe(false);
  expect(document.activeElement).toBe(input);
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.keyUp(input, { key: 'Enter' });

  window.dispatchEvent(new Event('yumiwatch:tv-ime-hidden'));
  expect(input.readOnly).toBe(true);
  press('ArrowDown');
  expect(document.activeElement).toBe(screen.getByRole('button'));
  fireEvent.click(input);
  expect(input.readOnly).toBe(false);
  press('Escape');
  expect(input.readOnly).toBe(true);
  expect(document.activeElement).toBe(input);
});

it('uses horizontal arrows to navigate a focused slider until OK, then adjusts and exits with Back', async () => {
  const adjust = vi.fn();
  render(
    <>
      <InterfaceEffects onBack={() => {}} />
      <main id="main">
        <Input
          type="range"
          min="0"
          max="10"
          step="1"
          defaultValue="5"
          aria-label="Громкость"
          onInput={adjust}
        />
        <button data-x="110">Дальше</button>
      </main>
    </>
  );
  await frame();
  const slider = screen.getByRole('slider') as HTMLInputElement;
  expect(document.activeElement).toBe(slider);
  press('ArrowRight');
  expect(document.activeElement).toBe(screen.getByRole('button'));
  expect(slider.value).toBe('5');
  expect(adjust).not.toHaveBeenCalled();

  press('ArrowLeft');
  press('Enter');
  fireEvent.keyUp(slider, { key: 'Enter' });
  expect(slider.hasAttribute('data-tv-adjusting')).toBe(true);
  press('ArrowRight');
  expect(document.activeElement).toBe(slider);
  expect(slider.value).toBe('6');
  expect(adjust).toHaveBeenCalledOnce();
  press('Escape');
  expect(slider.hasAttribute('data-tv-adjusting')).toBe(false);
  press('ArrowRight');
  expect(document.activeElement).toBe(screen.getByRole('button'));
});

it('opens card actions on a held OK without following the card link on release', async () => {
  const activate = vi.fn();
  const openActions = vi.fn();
  render(
    <>
      <InterfaceEffects onBack={() => {}} />
      <main id="main">
        <article data-gallery-item onContextMenu={openActions}>
          <a href="#card" data-gallery-link onClick={activate}>
            Тайтл
          </a>
        </article>
      </main>
    </>
  );
  await frame();
  const card = screen.getByRole('link');
  press('Enter');
  press('Enter');
  fireEvent.keyUp(card, { key: 'Enter' });
  expect(openActions).toHaveBeenCalledTimes(1);
  expect(activate).not.toHaveBeenCalled();
});

it('cancels an automatic action within a drawer before closing the drawer', async () => {
  const cancel = vi.fn();
  const close = vi.fn();
  render(
    <>
      <InterfaceEffects onBack={() => {}} />
      <main id="main" />
      <aside data-sidebar-open="true">
        <button data-tv-close onClick={close}>
          Закрыть панель
        </button>
        <div data-tv-countdown>
          <button data-nav-primary data-tv-close onClick={cancel}>
            Отмена
          </button>
        </div>
      </aside>
    </>
  );
  await frame();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Отмена' }));
  press('Escape');
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(close).not.toHaveBeenCalled();
});

it('dismisses the selector and dialog in separate Back presses, restoring the opener', async () => {
  const back = vi.fn();
  function Settings() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <InterfaceEffects path="/settings" onBack={back} />
        <main id="main">
          <button onClick={() => setOpen(true)}>Открыть фильтр</button>
        </main>
        {open && (
          <Sheet title="Фильтр" close={() => setOpen(false)}>
            <Dropdown
              aria-label="Качество"
              value="720"
              options={[{ value: '720', label: '720p' }]}
              onChange={() => {}}
            />
          </Sheet>
        )}
      </>
    );
  }
  render(<Settings />);
  await frame();
  const opener = screen.getByRole('button', { name: 'Открыть фильтр' });
  expect(document.activeElement).toBe(opener);
  press('Enter');
  fireEvent.keyUp(document.activeElement!, { key: 'Enter' });
  await frame();
  const dropdown = screen.getByRole('combobox');
  expect(document.activeElement).toBe(dropdown);
  press('Enter');
  expect(screen.getByRole('listbox')).toBeTruthy();
  press('Escape');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(document.activeElement).toBe(dropdown);
  press('Escape');
  await frame();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(back).not.toHaveBeenCalled();
});

it('restores the previous card when returning to a retained route', async () => {
  function Routes({ detail }: { detail: boolean }) {
    return (
      <>
        <InterfaceEffects path={detail ? '/anime/2' : '/catalog'} onBack={() => {}} />
        <main id="main">
          <div hidden={detail}>
            <a href="#a" data-app-href="#/anime/1" data-gallery-link>
              Первый тайтл
            </a>
            <a href="#b" data-app-href="#/anime/2" data-gallery-link data-y="80">
              Второй тайтл
            </a>
          </div>
          {detail && <button data-nav-primary>Начать просмотр</button>}
        </main>
      </>
    );
  }
  const view = render(<Routes detail={false} />);
  await frame();
  press('ArrowDown');
  const second = screen.getByRole('link', { name: 'Второй тайтл' });
  expect(document.activeElement).toBe(second);
  view.rerender(<Routes detail />);
  await frame();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Начать просмотр' }));
  view.rerender(<Routes detail={false} />);
  await frame();
  expect(document.activeElement).toBe(second);
});

it.each([true, false])('handles a keyboard overlay in TV mode %s', tv => {
  if (!tv) delete document.documentElement.dataset.tv;
  const height = window.innerHeight;
  const viewport = Object.assign(new EventTarget(), { height, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);

  function Viewport() {
    useVisualViewport();
    return null;
  }
  render(<Viewport />);
  viewport.height -= 220;
  viewport.offsetTop = 45;
  viewport.dispatchEvent(new Event('resize'));

  const root = document.documentElement;
  expect(root.dataset.keyboard).toBe('open');
  expect(root.style.getPropertyValue('--visual-height')).toBe(`${tv ? height : height - 220}px`);
  expect(root.style.getPropertyValue('--visual-top')).toBe(tv ? '0px' : '45px');
  root.style.removeProperty('--visual-height');
  root.style.removeProperty('--visual-top');
});
