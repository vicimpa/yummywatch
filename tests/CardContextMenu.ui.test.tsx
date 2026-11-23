// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AnimeCard, AnimeRow } from '~/components/AnimeCard';
import { CardContextMenu } from '~/components/CardContextMenu';
import { ProfilePage } from '~/components/Profile';
import { AnimeAbout } from '~/components/AnimeAbout';
import { cardContext } from '~/lib/card-context';
import { getLibraryState } from '~/lib/library';
import { clearSession } from '~/lib/session';
import { recordWatch } from '~/lib/storage';
import { anime as sampleAnime, video } from './fixtures';

const anime = { ...sampleAnime, poster: { big: 'https://static.yani.tv/poster.png' } };

const poster = vi.hoisted(() => ({ download: vi.fn().mockResolvedValue(undefined) }));
vi.mock('~/lib/poster-download', async original => ({
  ...(await original<typeof import('~/lib/poster-download')>()),
  downloadPoster: poster.download,
}));
beforeEach(() => {
  clearSession();
  localStorage.clear();
  poster.download.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {}))
  );
});
afterEach(() => {
  cleanup();
  cardContext.value = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const mount = () =>
  render(
    <>
      <AnimeCard anime={anime} />
      <CardContextMenu />
    </>
  );
const open = () =>
  fireEvent.contextMenu(screen.getByRole('link', { name: anime.title }), {
    clientX: 30,
    clientY: 40,
  });

it('replaces the native card menu with title, poster and library actions', async () => {
  const { container } = mount();
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 30,
    clientY: 40,
  });
  container.querySelector('.anime-card')!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  await screen.findByRole('menu');
  expect(
    screen.getByRole('menuitem', { name: 'Открыть тайтл' }).getAttribute('data-app-href')
  ).toContain(`#/anime/${anime.anime_id}?view=anime-about`);
  fireEvent.click(screen.getByRole('menuitem', { name: 'В избранное' }));
  await waitFor(() => expect(getLibraryState().favorites).toHaveLength(1));
  expect(screen.queryByRole('menu')).toBeNull();
  open();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Изменить список…' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'В планах' }));
  await waitFor(() => expect(getLibraryState().lists?.[1]?.[0].anime_id).toBe(anime.anime_id));
});

it('removes one title from continue watching and downloads its poster on request', async () => {
  recordWatch(anime, video('1'), 'group', 123);
  mount();
  open();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Убрать из «Продолжить просмотр»' }));
  await waitFor(() => expect(getLibraryState().history).toHaveLength(0));
  open();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Скачать постер' }));
  await waitFor(() => expect(poster.download).toHaveBeenCalledWith(anime));
});

it('opens with Shift+F10, navigates by arrows and returns focus on Escape', async () => {
  mount();
  const source = screen.getByRole('link', { name: anime.title });
  source.focus();
  fireEvent.keyDown(source, { key: 'F10', shiftKey: true });
  await screen.findByRole('menu');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Открыть тайтл' }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Начать просмотр' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(source);
});

it('returns from the list submenu to its trigger before closing the card menu', async () => {
  mount();
  open();
  const menu = await screen.findByRole('menu');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Изменить список…' }));
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Назад' }));
  fireEvent(menu, new Event('yumiwatch:tv-dismiss'));
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Изменить список…' }));
  fireEvent(menu, new Event('yumiwatch:tv-dismiss'));
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('link', { name: anime.title }));
});

it('dismisses on outside interaction and prevents the generic WebView context menu', async () => {
  render(
    <>
      <AnimeRow anime={anime} />
      <CardContextMenu />
    </>
  );
  fireEvent.contextMenu(screen.getByRole('link'), { clientX: 20, clientY: 20 });
  await screen.findByRole('menu');
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('menu')).toBeNull();
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
});

it('keeps the native context menu available in editable fields', () => {
  render(
    <>
      <input aria-label="Поиск" />
      <CardContextMenu />
    </>
  );
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

  screen.getByRole('textbox', { name: 'Поиск' }).dispatchEvent(event);

  expect(event.defaultPrevented).toBe(false);
});

it.each(['', 'tab=history'])('opens history card actions in the profile (%s)', async query => {
  recordWatch(anime, video('1'), 'group', 123, 1444);
  const before = location.hash;
  const { container } = render(
    <>
      <ProfilePage query={query} />
      <CardContextMenu />
    </>
  );
  const card = container.querySelector<HTMLAnchorElement>(
    query ? '.history-card' : '.profile-continue-card'
  )!;
  expect(card).toBeTruthy();
  // The poster, title, progress and play icon all belong to the same link.
  fireEvent.contextMenu(card.querySelector('h2,h3')!, { clientX: 120, clientY: 160 });
  await screen.findByRole('menu');
  expect(cardContext.value?.anime.anime_id).toBe(anime.anime_id);
  expect(screen.getByRole('menuitem', { name: 'Продолжить просмотр' })).toBeTruthy();
  expect(location.hash).toBe(before);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(document.activeElement).toBe(card);
  fireEvent.keyDown(card, { key: 'F10', shiftKey: true });
  await screen.findByRole('menu');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Убрать из «Продолжить просмотр»' }));
  await waitFor(() => expect(getLibraryState().history).toHaveLength(0));
  expect(container.querySelector('.profile-continue-card,.history-card')).toBeNull();
});

it('opens actions for the chosen title in the viewing order', async () => {
  const sequel = { ...anime, anime_id: 10532, title: 'Продолжение' };
  render(
    <>
      <AnimeAbout
        anime={{ ...anime, viewing_order: [anime, sequel] }}
        videos={{ loading: false, error: '', retry: vi.fn() }}
      />
      <CardContextMenu />
    </>
  );
  const source = screen.getByRole('link', { name: /Продолжение/ });
  source.focus();
  fireEvent.keyDown(source, { key: 'ContextMenu' });
  await screen.findByRole('menu');
  expect(cardContext.value?.anime.anime_id).toBe(sequel.anime_id);
  fireEvent.click(screen.getByRole('menuitem', { name: 'В избранное' }));
  await waitFor(() =>
    expect(getLibraryState().favorites.map(item => item.anime_id)).toEqual([sequel.anime_id])
  );
});
