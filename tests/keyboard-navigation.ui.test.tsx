// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { InterfaceEffects } from '~/components/InterfaceEffects';
import { focusTarget, keyboardTargets } from '~/lib/keyboard-navigation';

function layout() {
  for (const node of document.querySelectorAll<HTMLElement>(
    'a,button,input,select,main,aside,article,div'
  )) {
    vi.spyOn(node, 'getClientRects').mockImplementation(
      () => ({ length: node.closest('[hidden]') ? 0 : 1 }) as DOMRectList
    );
  }
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.tv;
  delete document.documentElement.dataset.inputMode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('keyboard focus and scroll visibility', () => {
  it('moves vertically out of form fields without changing values and keeps Right in the same row', () => {
    render(
      <div id="app">
        <InterfaceEffects onBack={() => {}} />
        <main id="main">
          <input aria-label="Число" type="number" value="7" />
          <select aria-label="Вариант">
            <option>A</option>
            <option>B</option>
          </select>
          <button>Ниже</button>
        </main>
      </div>
    );
    layout();

    const number = screen.getByRole('spinbutton') as HTMLInputElement,
      select = screen.getByRole('combobox') as HTMLSelectElement,
      button = screen.getByRole('button');

    [number, select, button].forEach((node, index) =>
      vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, index * 80, 200, 40))
    );
    number.focus();
    expect(fireEvent.keyDown(number, { key: 'ArrowDown' })).toBe(false);
    expect(document.activeElement).toBe(select);
    expect(number.value).toBe('7');
    expect(fireEvent.keyDown(select, { key: 'ArrowDown' })).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(select.value).toBe('A');
    button.focus();
    fireEvent.keyDown(button, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(button);
  });
  it('starts on the visible route instead of a retained hidden gallery or a poster marked tabindex=-1', () => {
    render(
      <div id="app">
        <InterfaceEffects onBack={() => {}} />
        <main id="main" tabIndex={-1}>
          <div hidden>
            <a data-gallery-link href="#old">
              Старая карточка
            </a>
            <div data-tv-player tabIndex={0}>
              Фоновый плеер
            </div>
          </div>
          <a href="#image" tabIndex={-1} aria-hidden="true">
            Постер
          </a>
          <a data-gallery-link href="#new">
            Новая карточка
          </a>
        </main>
      </div>
    );
    layout();
    document.getElementById('main')!.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Новая карточка' }));
    expect(keyboardTargets(document.getElementById('main')!)).toHaveLength(1);
  });
  it.each([false, true])(
    'suspends button focus on mouse input and restores it with arrows (TV: %s)',
    tv => {
      if (tv) document.documentElement.dataset.tv = 'true';
      render(
        <>
          <InterfaceEffects onBack={() => {}} />
          <main id="main">
            <button>Первый</button>
            <button>Второй</button>
            <input aria-label="Поиск" />
          </main>
        </>
      );
      layout();
      const [first, second] = screen.getAllByRole('button');
      vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 40));
      vi.spyOn(second, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 70, 100, 40));

      fireEvent.keyDown(document.body, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(first);
      fireEvent.keyDown(first, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(second);

      fireEvent.pointerOver(second, { clientX: 20, clientY: 10, pointerType: 'mouse' });
      fireEvent.pointerMove(second, { clientX: 20, clientY: 10, pointerType: 'mouse' });
      expect(document.documentElement.dataset.inputMode).toBe('pointer');
      expect(document.activeElement).toBe(document.body);
      fireEvent.keyDown(document.body, { key: 'ArrowUp' });
      expect(document.documentElement.dataset.inputMode).toBe('keyboard');
      expect(document.activeElement).toBe(second);

      fireEvent.pointerDown(second);
      expect(document.activeElement).toBe(document.body);
      const field = screen.getByRole('textbox');
      field.focus();
      if (!tv) expect(fireEvent.keyDown(field, { key: 'ArrowLeft' })).toBe(true);
      fireEvent.pointerMove(field, { clientX: 25, clientY: 10, pointerType: 'mouse' });
      expect(document.activeElement).toBe(field);
    }
  );

  it('moves up and down through menu links and leaves the menu with Right', () => {
    render(
      <div id="app">
        <InterfaceEffects onBack={() => {}} />
        <aside class="media-nav">
          <a href="#catalog">Каталог</a>
          <a href="#search">Поиск</a>
          <a href="#settings">Настройки</a>
        </aside>
        <main id="main">
          <button data-nav-primary>Открыть карточку</button>
        </main>
      </div>
    );
    layout();
    screen.getByRole('link', { name: 'Каталог' }).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Поиск' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Каталог' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Открыть карточку' }));
  });
  it('keeps Tab inside the active dialog and leaves Enter to native link/button activation', () => {
    render(
      <div id="app">
        <InterfaceEffects onBack={() => {}} />
        <button>Фон</button>
        <dialog open>
          <button>Старый диалог</button>
        </dialog>
        <dialog open>
          <button>Первый</button>
          <input aria-label="Текст" />
          <button>Последний</button>
        </dialog>
      </div>
    );
    layout();
    screen.getByRole('button', { name: 'Последний' }).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Первый' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Последний' }));
    expect(fireEvent.keyDown(document.activeElement!, { key: 'Enter' })).toBe(true);
  });
  it.each([false, true])(
    'reveals a whole card in its own scroll panel (reduced motion: %s)',
    reduced => {
      vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: reduced }));

      const { container } = render(
        <main class="media-scroll" style={{ overflowY: 'auto' }}>
          <article data-gallery-item>
            <a href="#anime">Название</a>
          </article>
        </main>
      );
      const panel = container.querySelector('main')!,
        card = container.querySelector('article')!,
        link = container.querySelector('a')!;

      const box = (x: number, y: number, width: number, height: number) =>
        ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height }) as DOMRect;

      vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(box(200, 0, 800, 500));
      vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(box(240, 700, 180, 300));
      vi.spyOn(link, 'getBoundingClientRect').mockReturnValue(box(240, 970, 180, 30));
      Object.defineProperties(panel, {
        clientHeight: { value: 500 },
        scrollHeight: { value: 2000 },
        clientWidth: { value: 800 },
        scrollWidth: { value: 800 },
        scrollTo: { value: vi.fn() },
      });
      focusTarget(link);
      expect(document.activeElement).toBe(link);
      expect(panel.scrollTo).toHaveBeenCalledWith({
        left: 0,
        top: 512,
        behavior: reduced ? 'instant' : 'smooth',
      });
      expect(document.documentElement.scrollTop).toBe(0);
    }
  );

  it('keeps a TV focus margin above and below controls while respecting the scroll limit', () => {
    document.documentElement.dataset.tv = 'true';
    const { container } = render(
      <main style={{ overflowY: 'auto' }}>
        <button>Верхняя</button>
        <button>Нижняя</button>
        <button>Последняя</button>
      </main>
    );
    const panel = container.querySelector('main')!;
    panel.scrollTop = 250;
    Object.defineProperties(panel, {
      clientHeight: { value: 500 },
      scrollHeight: { value: 820 },
      scrollTo: {
        value: vi.fn(({ top }) => {
          panel.scrollTop = top;
        }),
      },
    });
    const controls = screen.getAllByRole('button');
    [266, 730, 775].forEach((position, index) => {
      vi.spyOn(controls[index], 'getBoundingClientRect').mockImplementation(() => {
        const top = position - panel.scrollTop;
        return { top, bottom: top + 40 } as DOMRect;
      });
    });
    focusTarget(controls[0]);
    expect(controls[0].getBoundingClientRect().top).toBe(40);
    focusTarget(controls[1]);
    expect(500 - controls[1].getBoundingClientRect().bottom).toBe(40);
    focusTarget(controls[2]);
    expect(panel.scrollTop).toBe(320);
    expect(controls[2].getBoundingClientRect().bottom).toBe(495);
  });

  it.each([true, false])('reveals a TV group from its heading if it fits: %s', fits => {
    document.documentElement.dataset.tv = 'true';
    const { container } = render(
      <main style={{ overflowY: 'auto' }}>
        <section data-tv-focus-group>
          <button type="button">Все</button>
          <div>Связанный список</div>
        </section>
      </main>
    );
    const panel = container.querySelector('main')!;
    const group = container.querySelector('section')!;
    const button = screen.getByRole('button', { name: 'Все' });
    Object.defineProperties(panel, {
      clientHeight: { value: 400 },
      scrollHeight: { value: 1200 },
      scrollTo: { value: vi.fn() },
    });
    vi.spyOn(group, 'getBoundingClientRect').mockReturnValue({
      top: 210,
      bottom: fits ? 490 : 810,
    } as DOMRect);
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      top: 220,
      bottom: 260,
    } as DOMRect);
    focusTarget(button, true);
    if (fits)
      expect(panel.scrollTo).toHaveBeenCalledWith({ top: 130, left: 0, behavior: 'instant' });
    else expect(panel.scrollTo).not.toHaveBeenCalled();
  });

  it('measures the whole TV group independently of scrolling inside it', () => {
    document.documentElement.dataset.tv = 'true';
    const { container } = render(
      <main style={{ overflowY: 'auto' }}>
        <section data-tv-focus-group>
          <div style={{ overflowY: 'auto' }}>
            <button type="button">Последний в списке</button>
          </div>
        </section>
      </main>
    );
    const panel = container.querySelector('main')!;
    const group = container.querySelector('section')!;
    const list = group.firstElementChild!;
    const button = screen.getByRole('button');
    for (const [element, height] of [
      [panel, 400],
      [list, 170],
    ] as const)
      Object.defineProperties(element, {
        clientHeight: { value: height },
        scrollHeight: { value: 1200 },
        scrollTo: { value: vi.fn() },
      });
    vi.spyOn(group, 'getBoundingClientRect').mockReturnValue({ top: 210, bottom: 490 } as DOMRect);
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ top: 310 } as DOMRect);
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ top: 540, bottom: 580 } as DOMRect);
    focusTarget(button, true);
    expect(list.scrollTo).toHaveBeenCalledWith({ top: 140, left: 0, behavior: 'instant' });
    expect(panel.scrollTo).toHaveBeenCalledWith({ top: 130, left: 0, behavior: 'instant' });
  });
});
