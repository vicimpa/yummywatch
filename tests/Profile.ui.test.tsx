// @vitest-environment jsdom
import { chooseOption } from './dropdown-actions';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfilePage } from '~/components/Profile';
import { clearSession, saveSession } from '~/lib/session';
import { resetAccountLibrary } from '~/lib/library';
import { recordWatch, readLibrary, setAnimeList, toggleFavorite } from '~/lib/storage';
import { anime, video } from './fixtures';

const reply = (response: unknown) => new Response(JSON.stringify({ response }));
beforeEach(() => {
  clearSession();
  localStorage.clear();
  sessionStorage.clear();
  resetAccountLibrary();
});
afterEach(() => {
  cleanup();
  clearSession();
  resetAccountLibrary();
  vi.unstubAllGlobals();
});

describe('profile experience', () => {
  it('makes a guest’s collection usable without login or network access', async () => {
    setAnimeList(anime, 2);
    toggleFavorite(anime);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const { container } = render(<ProfilePage query="" />);
    expect(screen.getByRole('heading', { name: 'Твой аниме-мир' })).toBeTruthy();
    expect(
      container.querySelector('a[data-app-href="#/profile?tab=collection&list=watched"]')
    ).toBeTruthy();
    await screen.findByText('Детектив');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('shows full guest history with search, resume links and confirmed clearing', async () => {
    for (let index = 0; index < 5; index++)
      recordWatch(
        { ...anime, anime_id: 100 + index, title: `История ${index}` },
        video('2'),
        'StudioBand',
        30,
        1441
      );
    const { container } = render(<ProfilePage query="tab=history" />);
    expect(container.querySelectorAll('.history-card')).toHaveLength(5);
    expect(
      container.querySelector('a[data-app-href="#/anime/104?view=watch&play=1"]')
    ).toBeTruthy();
    expect(container.querySelector('.history-copy')?.textContent).toContain('00:30 / 24:01');
    fireEvent.input(screen.getByLabelText('Найти в истории'), { target: { value: 'История 3' } });
    expect(container.querySelectorAll('.history-card')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Очистить поиск в истории' }));
    fireEvent.click(screen.getByRole('button', { name: 'Очистить историю' }));
    expect(readLibrary().history).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(readLibrary().history).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Очистить историю' }));
    fireEvent.click(screen.getByRole('button', { name: 'Удалить историю' }));
    await screen.findByText('Здесь продолжится твоя история');
    expect(readLibrary().history).toEqual([]);
  });

  it('offers login back to profile subscriptions for guests', () => {
    const { container } = render(<ProfilePage query="tab=subscriptions" />);
    expect(container.querySelector('.profile-panel a.button')?.getAttribute('data-app-href')).toBe(
      '#/account?next=%2Fprofile%3Ftab%3Dsubscriptions'
    );
  });

  it('offers login on the People tab without requesting guests-only data', () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const { container } = render(<ProfilePage query="tab=friends" />);
    expect(screen.getByRole('heading', { name: 'Войди, чтобы найти друзей' })).toBeTruthy();
    expect(
      container.querySelector('[data-app-href="#/account?next=%2Fprofile%3Ftab%3Dfriends"]')
    ).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('searches, sorts and filters the collection while favorites stay independent of status', async () => {
    setAnimeList(anime, 2);
    toggleFavorite(anime);
    setAnimeList({ ...anime, anime_id: 10, title: 'Атака титанов', year: 2013 }, 1);
    render(<ProfilePage query="tab=collection" />);
    expect(screen.getAllByRole('article')).toHaveLength(2);
    chooseOption(screen.getByLabelText('Порядок аниме'), 'По названию');
    expect(document.querySelector('.card-title')?.textContent).toBe('Атака титанов');
    fireEvent.input(screen.getByLabelText('Найти в коллекции профиля'), {
      target: { value: 'фарм' },
    });
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(1));
    chooseOption(screen.getByLabelText('Статус выхода'), 'Онгоинги');
    expect(screen.getByText('Здесь пока пусто')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить фильтры' }));
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });

  it('keeps a public profile visible when its lists are private and does not offer editing', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async (url: string) =>
          url.includes('/lists')
            ? new Response(JSON.stringify({ error: true }), { status: 403 })
            : url.includes('/stats/')
              ? reply([])
              : reply({ id: 8, nickname: 'Закрытый профиль', about: '<b>Привет</b>' })
        )
    );
    render(<ProfilePage userId={8} query="tab=history" />);
    await screen.findByRole('heading', { name: 'Закрытый профиль' });
    await screen.findByText(/Владелец ограничил доступ/);
    expect(screen.getByText('Привет').querySelector('b')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Редактировать' })).toBeNull();
    const tabs = screen.getByRole('navigation', { name: 'Разделы профиля' });
    expect(tabs.textContent).not.toContain('История');
    expect(tabs.textContent).not.toContain('Подписки');
    expect(screen.queryByRole('heading', { name: 'История просмотра' })).toBeNull();
  });

  it('saves about and privacy only on form submit and keeps the editor open on failure', async () => {
    saveSession({
      token: 'test-owner',
      user: { id: 42, nickname: 'Viewer' },
      remember: false,
      refreshedAt: Date.now(),
      verified: true,
    });
    const fetcher = vi
      .fn()
      .mockImplementation(async (url: string, options: RequestInit) =>
        options.method === 'PATCH'
          ? reply(false)
          : url.includes('/stats/')
            ? reply([])
            : reply({ id: 42, nickname: 'Viewer', about: 'До изменения', lists_privacy: 'none' })
      );
    vi.stubGlobal('fetch', fetcher);
    render(<ProfilePage query="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Редактировать' }));
    fireEvent.input(screen.getByLabelText('О себе'), { target: { value: 'Новое описание' } });
    chooseOption(screen.getByLabelText('Кто видит мои списки'), 'Только друзья');
    expect(fetcher.mock.calls.filter(([, options]) => options.method === 'PATCH')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await screen.findByText('Yummy не подтвердил сохранение профиля.');
    expect(screen.getByRole('dialog')).toBeTruthy();
    const patch = fetcher.mock.calls.find(([, options]) => options.method === 'PATCH');
    expect(JSON.parse(patch![1].body as string)).toEqual({
      about: 'Новое описание',
      lists_privacy: 'friends',
    });
    fetcher.mockImplementation(async (url: string, options: RequestInit) =>
      options.method === 'PATCH'
        ? reply(true)
        : url.includes('/stats/')
          ? reply([])
          : reply({ id: 42, nickname: 'Viewer', about: 'Новое описание', lists_privacy: 'friends' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await screen.findByText('Новое описание');
  });
});

it('sorts a personal top by personal scores and excludes unrated anime while showing ranks', async () => {
  const { setPersonalRating } = await import('~/lib/library');
  const first = { ...anime, anime_id: 1, title: 'Личный фаворит', rating: { average: 5 } };
  const second = { ...anime, anime_id: 2, title: 'Рейтинг сайта выше', rating: { average: 10 } };
  const unrated = { ...anime, anime_id: 3, title: 'Без личной оценки', rating: { average: 10 } };
  setAnimeList(first, 2);
  setAnimeList(unrated, 2);
  await setPersonalRating(first, 10);
  await setPersonalRating(second, 7);
  const { container } = render(<ProfilePage query="tab=collection&list=rated&sort=user_rating" />);
  expect([...container.querySelectorAll('.card-title')].map(node => node.textContent)).toEqual([
    'Личный фаворит',
    'Рейтинг сайта выше',
  ]);
  expect([...container.querySelectorAll('.rank')].map(node => node.textContent)).toEqual([
    '01',
    '02',
  ]);
  expect(screen.getByText('Моя оценка: 10 / 10')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Без личной оценки' })).toBeNull();
  expect((screen.getByLabelText('Порядок аниме') as HTMLButtonElement).value).toBe('user_rating');
});

it('allows sorting the whole collection by personal score with unrated anime at the end', async () => {
  const { setPersonalRating } = await import('~/lib/library');
  const high = { ...anime, anime_id: 1, title: 'Первое', rating: { average: 5 } };
  const low = { ...anime, anime_id: 2, title: 'Второе', rating: { average: 10 } };
  setAnimeList({ ...anime, anime_id: 3, title: 'Не оценено' }, 2);
  setAnimeList(high, 2);
  setAnimeList(low, 2);
  await setPersonalRating(high, 10);
  await setPersonalRating(low, 7);
  const { container, rerender } = render(<ProfilePage query="tab=collection" />);
  chooseOption(screen.getByLabelText('Порядок аниме'), 'По моей оценке');
  expect([...container.querySelectorAll('.card-title')].map(node => node.textContent)).toEqual([
    'Первое',
    'Второе',
    'Не оценено',
  ]);
  expect(screen.getByRole('link', { name: /Личный топ/ }).getAttribute('data-app-href')).toContain(
    'list=rated&sort=user_rating'
  );
  rerender(<ProfilePage query="tab=collection&list=rated&sort=user_rating" />);
  expect(container.querySelectorAll('.card-title')).toHaveLength(2);
});

it('shows a public profile’s top using that profile’s scores', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string) =>
      reply(
        raw.includes('/lists')
          ? [
              { ...anime, anime_id: 1, title: 'Выбор профиля', rating: 5, user: { rating: 10 } },
              { ...anime, anime_id: 2, title: 'Другой выбор', rating: 10, user: { rating: 6 } },
              { ...anime, anime_id: 3, title: 'Не оценено', rating: 10, user: { rating: 0 } },
            ]
          : raw.includes('/stats/')
            ? []
            : { id: 8, nickname: 'Друг' }
      )
    )
  );
  const { container } = render(<ProfilePage userId={8} query="tab=collection&list=rated" />);
  await screen.findByRole('link', { name: 'Выбор профиля' });
  expect([...container.querySelectorAll('.card-title')].map(node => node.textContent)).toEqual([
    'Выбор профиля',
    'Другой выбор',
  ]);
  expect(screen.getByText('Оценка профиля: 10 / 10')).toBeTruthy();
  expect(screen.getByRole('combobox', { name: 'Порядок аниме' }).textContent).toBe(
    'По оценке профиля'
  );
});
