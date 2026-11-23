// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { Detail } from '~/components/Detail';
import { InterfaceEffects } from '~/components/InterfaceEffects';
import { clearSession, saveSession } from '~/lib/session';
import { resolveStream } from '~/lib/streams';
import { savePlaybackSettings } from '~/lib/playback-settings';
import { savePlaybackRecovery } from '~/lib/playback-recovery';
import { readLibrary } from '~/lib/storage';
import { initializeNavigation, recordNavigation } from '~/lib/navigation';
import { anime, video } from './fixtures';

vi.mock('~/lib/streams', async original => ({
  ...(await original<typeof import('~/lib/streams')>()),
  resolveStream: vi.fn(),
}));

const current = {
  ...video('1'),
  iframe_url: 'https://player.aksor.tv/video/example',
  duration: 1400,
};
const sample = {
  ...anime,
  description: 'Описание аниме',
  studios: [{ title: 'Тестовая студия' }],
  random_screenshots: [
    {
      episode: '1',
      sizes: {
        small: 'https://static.yani.tv/one.webp',
        full: 'https://static.yani.tv/one-full.webp',
      },
    },
    {
      episode: '2',
      sizes: {
        small: 'https://static.yani.tv/two.webp',
        full: 'https://static.yani.tv/two-full.webp',
      },
    },
  ],
  viewing_order: [{ ...anime, anime_id: 10532, title: 'Второй сезон' }],
};

beforeEach(() => {
  clearSession();
  localStorage.clear();
  savePlaybackSettings({ mode: 'source' });
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.mocked(resolveStream).mockImplementation(async candidates => ({
    provider: 'Test',
    videoId: candidates[0].video_id,
    duration: 1400,
    streams: [
      { quality: 360, type: 'mp4', url: `https://cdn.example/${candidates[0].number}.mp4` },
    ],
  }));
  vi.stubGlobal(
    'matchMedia',
    vi
      .fn()
      .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  );
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      const path = new URL(url).pathname;

      return Promise.resolve(
        new Response(
          JSON.stringify({
            response:
              path === '/anime/10531'
                ? sample
                : path.endsWith('/rates')
                  ? [
                      { rating: 9, count: 3 },
                      { rating: 7, count: 1 },
                    ]
                  : path.endsWith('/videos')
                    ? [current, video('2'), video('1', 'AniDub')]
                    : { comments: [] },
          })
        )
      );
    })
  );
});
afterEach(() => {
  cleanup();
  clearSession();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('anime media center screens', () => {
  it.each([
    ['/', 'Каталог аниме'],
    ['/catalog?sort=top', 'Каталог аниме'],
    ['/profile?tab=collection', 'Назад к профилю'],
    ['/notifications', 'Уведомления'],
  ])(
    'keeps the labeled return link directed to %s after leaving the player',
    async (returnTo, label) => {
      history.replaceState(null, '', `#${returnTo}`);
      initializeNavigation();
      history.pushState(null, '', '#/anime/10531?view=watch');
      recordNavigation();
      history.pushState(null, '', '#/anime/10531');
      recordNavigation();
      const back = vi.spyOn(history, 'back').mockImplementation(() => {});

      render(<Detail id="10531" returnTo={returnTo} />);
      const link = await screen.findByRole('link', { name: label });
      const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });

      expect(link.getAttribute('data-app-href')).toBe(`#${returnTo}`);
      fireEvent(link, click);
      expect(click.defaultPrevented).toBe(true);
      expect(location.hash).toBe(`#${returnTo}`);
      expect(back).not.toHaveBeenCalled();
    }
  );
  it('places screenshots between the description and facts, then groups ratings', async () => {
    const { container } = render(<Detail id="10531" />);
    const resume = await screen.findByRole('link', { name: /Начать просмотр/ });
    const overview = container.querySelector('.overview-heading')!;
    const description = await screen.findByRole('heading', { name: 'Об аниме' });
    const screenshots = container.querySelector('.about-screenshots')!;
    const facts = container.querySelector('.anime-facts')!;
    const ratings = container.querySelector('.about-ratings')!;
    const personal = container.querySelector('.personal-rating')!;
    expect(
      overview.compareDocumentPosition(resume) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      resume.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      description.compareDocumentPosition(screenshots) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      screenshots.compareDocumentPosition(facts) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(facts.compareDocumentPosition(ratings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(ratings.contains(personal)).toBe(true);
    expect(screen.queryByRole('heading', { name: 'Скриншоты' })).toBeNull();
  });
  it('marks only the current title in viewing order by ID even when titles match', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          response: {
            ...sample,
            viewing_order: [{ ...anime, anime_id: 10530 }, anime, { ...anime, anime_id: 10532 }],
          },
        })
      )
    );

    const { container } = render(<Detail id="10531" />);

    await screen.findByText('Текущий тайтл');

    const links = within(container.querySelector('.viewing-order') as HTMLElement).getAllByRole(
      'link'
    );

    expect(links.map(link => link.getAttribute('aria-current'))).toEqual([null, 'page', null]);
    expect(links[1].getAttribute('data-app-href')).toBe('#/anime/10531');
  });
  it('opens the anime page with an overview, resume row, screenshots, facts and available voices', async () => {
    const { container } = render(<Detail id="10531" />);

    await screen.findByText('Описание аниме');
    const episodes = await screen.findByRole('region', { name: 'Серии и озвучки' });
    expect(container.querySelector('.room-main')?.firstElementChild?.className).toBe(
      'anime-watch-heading overview-heading'
    );
    expect(container.querySelector('.room-main')?.children[1]?.className).toBe('anime-resume-row');
    expect(screen.getByText('Тестовая студия')).toBeTruthy();
    await screen.findByRole('region', { name: 'Оценки аниме' });
    await screen.findByRole('img', { name: /Распределение 4 оценок/ });
    expect(screen.getByRole('button', { name: 'Открыть скриншот 1' })).toBeTruthy();

    fireEvent.click(await within(episodes).findByRole('button', { name: 'AniDub' }));
    const voice = within(episodes).getByRole('link', { name: 'Серия 1' });

    expect(voice.getAttribute('data-app-href')).toContain('voice=AniDub');
    expect(screen.getByRole('heading', { name: 'Порядок просмотра' })).toBeTruthy();
    expect(container.querySelector('iframe,video')).toBeNull();
    expect(vi.mocked(fetch).mock.calls.every(([url]) => !String(url).includes('/resolver'))).toBe(
      true
    );
  });
  it('opens episodes from the anime page without resolving streams, and links to the chosen episode and voice', async () => {
    vi.mocked(resolveStream).mockClear();

    const { container } = render(
      <>
        <InterfaceEffects onBack={() => {}} />
        <main id="main">
          <Detail id="10531" />
        </main>
      </>
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Серии' }));

    const panel = screen.getByRole('dialog', { name: 'Серии' });
    const episode = await within(panel).findByRole('link', { name: 'Серия 2' });

    expect(episode.getAttribute('data-app-href')).toContain('episode=2');
    expect(episode.getAttribute('data-app-href')).toContain('voice=AniLibria');
    expect(container.querySelector('video,iframe')).toBeNull();
    expect(resolveStream).not.toHaveBeenCalled();
    fireEvent.input(within(panel).getByRole('searchbox', { name: 'Найти серию' }), {
      target: { value: '2' },
    });
    expect(within(panel).queryByRole('link', { name: 'Серия 1' })).toBeNull();
    fireEvent.input(within(panel).getByRole('searchbox', { name: 'Найти серию' }), {
      target: { value: '' },
    });
    const dubbing = within(panel).getByRole('group', { name: 'Озвучка серий' });
    fireEvent.click(within(dubbing).getByRole('button', { name: 'AniDub' }));
    expect(
      within(panel).getByRole('link', { name: 'Серия 1' }).getAttribute('data-app-href')
    ).toContain('voice=AniDub');
    expect(within(panel).queryByRole('link', { name: 'Серия 2' })).toBeNull();
    expect(within(panel).getByText('Нет в этой озвучке')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Серии' })).toBeNull();
    const inline = screen.getByRole('region', { name: 'Серии и озвучки' });
    expect(within(inline).getByRole('button', { name: 'AniDub', pressed: true })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'e', code: 'KeyE' });
    expect(screen.getByRole('dialog', { name: 'Серии' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'c', code: 'KeyC' });
    expect(screen.getByRole('dialog', { name: 'Комментарии' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Серии' })).toBeNull();
  });
  it('restores remote per-episode history on the overview and in our player without a recent-history entry', async () => {
    saveSession({
      token: 'history-viewer',
      user: { id: 42, nickname: 'Viewer' },
      verified: true,
      remember: false,
      refreshedAt: Date.now(),
    });
    const first = { ...current, duration: 1441, watched: { date: 100, end_time: 1441 } };
    const second = { ...video('2'), duration: 1441, watched: { date: 200, end_time: 30 } };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        const path = new URL(url).pathname;

        return Promise.resolve(
          new Response(
            JSON.stringify({
              response:
                path === '/anime/10531'
                  ? sample
                  : path.endsWith('/videos')
                    ? [first, second, video('1', 'AniLiberty', 2), video('2', 'AniLiberty', 2)]
                    : [],
            })
          )
        );
      })
    );
    const { container, rerender } = render(<Detail id="10531" />);

    await screen.findByText('Продолжить просмотр');
    expect(container.querySelector('.anime-resume-row')?.textContent).toContain(
      'Серия 2 · 00:30 / 24:01'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Серии' }));
    const overview = screen.getByRole('dialog', { name: 'Серии' });
    const completed = await within(overview).findByRole('link', { name: 'Серия 1' });

    expect(completed.querySelector<HTMLElement>('.episode-progress')?.style.width).toBe('100%');
    expect(within(overview).getByRole('link', { name: 'Серия 2' }).textContent).toContain('00:30');

    rerender(<Detail id="10531" query="view=watch" />);
    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain('/2.mp4')
    );
    expect(container.querySelector('video')?.currentTime).toBe(30);
    const episodes = screen.getByRole('dialog', { name: 'Серии' });

    expect(
      within(episodes)
        .getByRole('button', { name: 'Серия 1' })
        .querySelector<HTMLElement>('.episode-progress')?.style.width
    ).toBe('100%');
    expect(within(episodes).getByRole('button', { name: 'Серия 2' }).textContent).toContain(
      'Просмотрено 00:30'
    );
  });
  it('starts the requested episode instead of returning to a different saved episode', async () => {
    savePlaybackRecovery(
      {
        anime,
        episode: '1',
        videoId: current.video_id,
        group: '',
        position: 123,
        duration: 1400,
        updatedAt: Date.now(),
      },
      null
    );

    const { container } = render(
      <Detail id="10531" query="view=watch&play=1&episode=2&voice=AniLibria" />
    );

    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain('/2.mp4')
    );
    expect(screen.getByText('Монолог фармацевта — серия 2')).toBeTruthy();
    expect(container.querySelector('video')?.currentTime).toBe(0);
    fireEvent.loadedMetadata(container.querySelector('video')!);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });
  it('shares poster skeletons with screenshots and resets loading when navigating between frames', async () => {
    render(<Detail id="10531" />);

    const thumbnail = await screen.findByRole('button', { name: 'Открыть скриншот 1' });

    expect(thumbnail.querySelector('.poster-placeholder.skeleton')).toBeTruthy();
    fireEvent.load(within(thumbnail).getByRole('img'));
    expect(thumbnail.querySelector('.poster-artwork.is-loaded')).toBeTruthy();
    fireEvent.click(thumbnail);
    expect(screen.getByRole('dialog', { name: 'Скриншот 1 из 2' })).toBeTruthy();

    const first = screen.getByRole('img', { name: /Скриншот 1 —/ });

    expect(first.getAttribute('src')).toContain('one-full');
    expect(first.closest('.poster-artwork')?.classList.contains('is-loaded')).toBe(false);
    fireEvent.load(first);
    expect(first.closest('.poster-artwork')?.classList.contains('is-loaded')).toBe(true);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    expect(screen.getByRole('dialog', { name: 'Скриншот 2 из 2' })).toBeTruthy();

    const second = screen.getByRole('img', { name: /Скриншот 2 —/ });

    expect(second.closest('.poster-artwork')?.classList.contains('is-loaded')).toBe(false);
    fireEvent.error(second);
    expect(screen.getByRole('dialog').querySelector('.poster-placeholder.skeleton')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('uses only our player on the watch screen and preserves playback through comments', async () => {
    const { container, rerender } = render(<Detail id="10531" query="view=watch" />);

    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    expect(
      container.querySelector(
        'iframe,.room-header,.watch-source-buttons,.watch-preferences,.episode-launcher,.watch-now'
      )
    ).toBeNull();

    const media = container.querySelector('video')!;

    Object.defineProperty(media, 'paused', { value: false, configurable: true });
    Object.defineProperty(media, 'duration', { value: 1400, configurable: true });
    fireEvent.loadedMetadata(media);
    fireEvent.playing(media);
    media.currentTime = 143;
    fireEvent.timeUpdate(media);
    fireEvent.click(screen.getByRole('button', { name: 'Комментарии' }));
    await screen.findByText('Пока тихо');
    expect(
      screen
        .getByRole('dialog', { name: 'Комментарии' })
        .closest('.sidebar-presence')
        ?.classList.contains('is-overlay')
    ).toBe(true);
    expect(container.querySelector('video')).toBe(media);
    media.currentTime = 150;
    fireEvent.timeUpdate(media);
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть панель' }));
    expect(container.querySelector('video')).toBe(media);
    rerender(<Detail id="10531" />);
    await screen.findByText('Описание аниме');
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('.anime-resume-row')?.textContent).toContain('02:30');
    expect(readLibrary().history[0].position).toBe(150);
  });
  it('opens series over the video and changes the episode without adding page blocks', async () => {
    const { container } = render(<Detail id="10531" query="view=watch" />);

    await screen.findByRole('button', { name: 'Серии' });
    fireEvent.click(screen.getByRole('button', { name: 'Серии' }));

    const sidebar = screen.getByRole('dialog', { name: 'Серии' });

    expect(
      within(sidebar).getByRole('checkbox', { name: 'Следующая серия автоматически' })
    ).toBeTruthy();
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Серия 2' }));
    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain('/2.mp4')
    );
    expect(screen.queryByRole('dialog', { name: 'Серии' })).toBeNull();
    expect(container.querySelector('.room-header')).toBeNull();
  });
  it('uses the same sidebars for comments, episodes and voices with global keyboard control', async () => {
    const { container } = render(
      <>
        <InterfaceEffects onBack={() => {}} />
        <main id="main">
          <Detail id="10531" query="view=watch" />
        </main>
      </>
    );

    await screen.findByRole('button', { name: 'Серии' });

    const media = container.querySelector('video');

    fireEvent.keyDown(window, { key: 'c', code: 'KeyC' });
    await screen.findByRole('dialog', { name: 'Комментарии' });
    fireEvent.keyDown(window, { key: 'e', code: 'KeyE' });
    expect(screen.getByRole('dialog', { name: 'Серии' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Комментарии' })).toBeNull();
    expect(container.querySelector('video')).toBe(media);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Серии' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Озвучка:/ }));

    const voice = screen.getByRole('dialog', { name: 'Озвучка' });

    expect(voice.closest('.sidebar-presence')?.classList.contains('is-overlay')).toBe(true);
    fireEvent.click(within(voice).getByRole('button', { name: /AniDub/ }));
    expect(screen.queryByRole('dialog', { name: 'Озвучка' })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Озвучка: AniDub' })).toBeTruthy()
    );
  });
});
