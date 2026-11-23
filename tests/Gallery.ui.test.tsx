// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { Gallery } from '~/components/Gallery';
import { InterfaceEffects } from '~/components/InterfaceEffects';
import { navigateGallery } from '~/lib/gallery-navigation';
import { clearSession } from '~/lib/session';
import { anime } from './fixtures';
import { readLibrary, recordWatch } from '~/lib/storage';
import { video } from './fixtures';

beforeEach(() => {
  clearSession();
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            response: [anime, { ...anime, anime_id: 10532, title: 'Второе аниме' }],
          })
        )
      )
    )
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('catalog gallery', () => {
  it('removes a continue card with its close button without navigating to playback', () => {
    recordWatch(anime, video('1'), 'group', 123);
    recordWatch({ ...anime, anime_id: 10532, title: 'Второе аниме' }, video('1'), 'group');
    render(<Gallery />);
    const shelf = screen.getByRole('region', { name: 'Продолжить просмотр' });
    const before = location.hash;
    const remove = within(shelf).getByRole('button', {
      name: `Убрать «${anime.title}» из «Продолжить просмотр»`,
    });
    expect(remove.closest('a')).toBeNull();
    fireEvent.click(remove);
    expect(readLibrary().history.map(entry => entry.anime.anime_id)).toEqual([10532]);
    expect(location.hash).toBe(before);
    expect(within(shelf).queryByRole('link', { name: anime.title })).toBeNull();
    expect(within(shelf).getByRole('link', { name: /Второе аниме/ })).toBeTruthy();
  });
  it('does not mistake a wrapped neighboring title for the row above', () => {
    render(
      <main id="main">
        <InterfaceEffects onBack={() => {}} />
        <div data-gallery-row>
          {['Коротко', 'Длинное название в две строки'].map(name => (
            <article data-gallery-item key={name}>
              <a data-gallery-link href={`#${name}`}>
                {name}
              </a>
            </article>
          ))}
        </div>
      </main>
    );

    const links = screen.getAllByRole('link');

    links.forEach((link, index) => {
      vi.spyOn(link, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
      vi.spyOn(link.closest('article')!, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(index * 200, 0, 180, 330)
      );
      vi.spyOn(link, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(index * 200, 300 - index * 25, 180, 30 + index * 25)
      );
    });
    links[1].focus();
    fireEvent.keyDown(links[1], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(links[1]);
  });
  it('shows a random feature, keeps it stable on hover and switches to another title on request', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    recordWatch(anime, video('1'), 'group', 123);
    const { container } = render(<Gallery />);
    const resume = screen.getByRole('region', { name: 'Продолжить просмотр' });
    const resumeLink = within(resume).getByRole('link', { name: new RegExp(anime.title) });
    resumeLink.focus();
    const feature = await screen.findByRole('region', { name: 'Выбранное аниме' });
    expect(resume.compareDocumentPosition(feature) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.activeElement).toBe(resumeLink);
    const title = within(feature).getByRole('heading');
    expect(title.textContent).toBe(anime.title);
    const rail = await screen.findByRole('region', { name: 'Лучшие аниме' });
    const link = await within(rail).findByRole('link', { name: 'Второе аниме' });
    expect(link.getAttribute('href')).toBe(
      `https://ru.yummyani.me/catalog/item/${anime.anime_url}`
    );
    expect(link.getAttribute('data-app-href')).toBe('#/anime/10532?view=anime-about');
    fireEvent.focusIn(link);
    fireEvent.pointerEnter(link.closest('article')!);
    expect(title.textContent).toBe(anime.title);
    fireEvent.click(within(feature).getByRole('button', { name: 'Другое аниме' }));
    expect(title.textContent).toBe('Второе аниме');
    expect(container.querySelector('iframe,video')).toBeNull();
  });
  it('moves by poster position and keeps Home and End within the row', () => {
    render(
      <>
        <InterfaceEffects onBack={() => {}} />
        <main id="main">
          <section onKeyDown={navigateGallery}>
            <div data-gallery-row>
              {['A', 'B', 'C', 'D'].map(name => (
                <a key={name} data-gallery-link href={`#${name}`}>
                  {name}
                </a>
              ))}
            </div>
          </section>
        </main>
      </>
    );

    const links = screen.getAllByRole('link');

    links.forEach((link, index) => {
      vi.spyOn(link, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
      vi.spyOn(link, 'getBoundingClientRect').mockReturnValue(
        new DOMRect((index % 2) * 200, Math.floor(index / 2) * 300, 180, 30)
      );
    });
    links[0].focus();
    fireEvent.keyDown(links[0], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(links[1]);
    fireEvent.keyDown(links[1], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(links[3]);
    fireEvent.keyDown(links[3], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(links[2]);
    fireEvent.keyDown(links[2], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(links[0]);
    fireEvent.keyDown(links[0], { key: 'End' });
    expect(document.activeElement).toBe(links[3]);
  });
});
