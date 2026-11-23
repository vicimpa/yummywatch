// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';

import { AnimeAbout, type TAnimeAboutProps } from '~/components/AnimeAbout';
import { groupKey } from '~/lib/player';
import type { Video, WatchEntry } from '~/lib/types';
import { anime, video } from './fixtures';

const source = vi.hoisted(() => ({ videos: [] as Video[] }));

const videosResource = (): TAnimeAboutProps['videos'] => ({
  value: { data: source.videos, cached: false, savedAt: 0 },
  loading: false,
  error: '',
  retry: vi.fn(),
});

vi.mock('~/lib/hooks', async original => ({
  ...(await original<typeof import('~/lib/hooks')>()),
  useResource: () => ({
    value: { data: source.videos },
    loading: false,
    error: '',
    retry: vi.fn(),
  }),
}));

afterEach(cleanup);

it('shows unique episodes and keeps the original players and subscriptions for the selected voice', () => {
  const first = { ...video('1'), iframe_url: 'https://kodik.info/one' };
  const second = { ...video('2'), iframe_url: 'https://kodik.info/two' };

  source.videos = [first, second, video('1', 'AniLiberty', 2), video('1', 'Субтитры AniLibria')];

  const { rerender } = render(<AnimeAbout anime={anime} videos={videosResource()} />);
  const voices = screen.getByRole('region', { name: 'Серии и озвучки' });
  const tabs = within(voices).getByRole('group', { name: 'Озвучка серий' });

  expect(voices.querySelector('.voice-tile')).toBeNull();
  expect(within(voices).getAllByRole('link', { name: /^Серия / })).toHaveLength(2);
  fireEvent.click(within(tabs).getByRole('button', { name: 'Субтитры AniLibria' }));
  expect(within(voices).getAllByRole('link', { name: /^Серия / })).toHaveLength(1);
  expect(within(voices).getByText('Нет в этой озвучке')).toBeTruthy();
  fireEvent.click(within(tabs).getByRole('button', { name: 'AniLibria' }));
  const sources = within(voices).getByText('Оригинальные плееры и подписки').closest('details')!;
  sources.open = true;
  expect(within(voices).getAllByRole('link', { name: 'Player 1' })[0].getAttribute('href')).toBe(
    first.iframe_url
  );

  const history: WatchEntry = {
    anime,
    videoId: second.video_id,
    episode: '2',
    group: groupKey(second),
    position: 120,
    duration: 1400,
    updatedAt: Date.now(),
  };

  rerender(<AnimeAbout anime={anime} videos={videosResource()} history={history} />);
  expect(within(voices).getAllByRole('link', { name: 'Player 1' })[0].getAttribute('href')).toBe(
    'https://kodik.info/two?start_from=115'
  );
  source.videos = [...source.videos, video('3')];
  rerender(<AnimeAbout anime={{ ...anime }} videos={videosResource()} history={history} />);
  expect(within(voices).getAllByRole('link', { name: /^Серия / })).toHaveLength(3);
});
