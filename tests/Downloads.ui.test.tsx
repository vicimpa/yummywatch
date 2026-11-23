// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AboutEpisodes } from '~/components/AboutEpisodes';
import { Detail } from '~/components/Detail';
import { DownloadPicker, DownloadsPage } from '~/components/Downloads';
import { useEpisodeDownloads } from '~/components/EpisodeDownload';
import { EpisodeOptions } from '~/components/PlayerOptions';
import { desktopInvoke } from '~/lib/desktop';
import { downloadPath, downloads, type Download, type DownloadRequest } from '~/lib/downloads';
import { putCache } from '~/lib/cache-store';
import { interfaceSettings } from '~/lib/interface-settings';
import { NativePlayback } from '~/lib/native-playback';
import { savePlaybackRecovery } from '~/lib/playback-recovery';
import { groupKey } from '~/lib/player';
import { readLibrary } from '~/lib/storage';
import type { Anime, Video } from '~/lib/types';

vi.mock('~/lib/desktop', async original => ({
  ...(await original<typeof import('~/lib/desktop')>()),
  desktopInvoke: vi.fn(),
  isDesktopWindow: () => true,
  desktopMediaRoot: () => new URL('https://yumiwatch-media.localhost/'),
}));

vi.mock('~/components/VideoSurface', async original => ({
  ...(await original<typeof import('~/components/VideoSurface')>()),
  VideoSurface: ({
    stream,
    title,
    skips,
    start,
    loadingImage,
    onUpdate,
    onBack,
    backLabel,
  }: import('~/components/VideoSurface').TVideoSurfaceProps) => (
    <div
      aria-label={title}
      data-test-src={stream.url}
      data-test-opening={skips.opening?.time}
      data-test-start={start}
      data-test-loading-image={loadingImage}
    >
      {onBack && <button onClick={onBack}>{backLabel || 'Об аниме'}</button>}
      <button
        onClick={() => {
          onUpdate({ reason: 'playing', position: 140, duration: 1200, playing: true }, stream);
          onUpdate({ reason: 'pause', position: 145, duration: 1200, playing: false }, stream);
        }}
      >
        Сохранить место
      </button>
    </div>
  ),
}));

const anime: Anime = { anime_id: 20, anime_url: 'test', title: 'Тестовое аниме' };
const voice = 'Озвучка Команда А';
const video = (number: string, dubbing: string, id: number): Video => ({
  video_id: id,
  index: Number(number),
  number,
  iframe_url: `//ru.yummyani.me/iframeCVH.html?anime_id=20&episode=${number}`,
  data: { dubbing, player: 'CVH', player_id: 1 },
});
const first = video('1', voice, 101);
const videos = [first, video('2', 'Озвучка Команда Б', 102), video('3', voice, 103)];

describe('DownloadPicker', () => {
  beforeEach(() => {
    downloads.value = [];
    vi.mocked(desktopInvoke).mockReset().mockResolvedValue([]);
  });
  afterEach(cleanup);

  it('chooses the next available series in the fixed voice without replacing missing episodes', async () => {
    render(
      <DownloadPicker
        anime={anime}
        videos={videos}
        close={vi.fn()}
        episode="1"
        voice={voice}
        quality={720}
      />
    );
    const unavailable = screen.getByRole('checkbox', { name: /Серия 2/ }) as HTMLInputElement;
    expect(unavailable.disabled).toBe(true);
    expect(screen.getByText('Нет в этой озвучке')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Следующие 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Скачать · 1' }));
    await waitFor(() =>
      expect(desktopInvoke).toHaveBeenCalledWith('enqueue_downloads', {
        requests: [
          expect.objectContaining({
            episode: '3',
            voice,
            quality: 720,
            candidates: [expect.objectContaining({ videoId: 103, dubbing: voice })],
          }),
        ],
      })
    );
  });

  it('sends the playing stream address to share its current cache', async () => {
    const path = `/downloads/${'a'.repeat(32)}/index.m3u8`;
    const preview = 'https://static.yani.tv/download-preview.jpg';
    render(
      <DownloadPicker
        anime={{
          ...anime,
          random_screenshots: [{ episode: '1', sizes: { small: preview, full: preview } }],
        }}
        videos={videos}
        close={vi.fn()}
        episode="1"
        voice={voice}
        quality={720}
        active={{
          video: first,
          stream: { url: `yumiwatch-media://localhost${path}`, quality: 720, type: 'hls' },
        }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Скачать · 1' }));
    await waitFor(() =>
      expect(desktopInvoke).toHaveBeenCalledWith('enqueue_downloads', {
        requests: [expect.objectContaining({ episode: '1', active: path, preview })],
      })
    );
  });
});

const download = (overrides: Partial<Download> = {}): Download => ({
  animeId: anime.anime_id,
  title: anime.title,
  voice,
  episode: '1',
  id: 'a'.repeat(32),
  quality: 720,
  candidates: [],
  status: 'queued',
  done: 0,
  total: 0,
  ...overrides,
});

describe('episode download management', () => {
  beforeEach(() => {
    downloads.value = undefined;
    localStorage.clear();
    vi.mocked(desktopInvoke).mockReset();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify({ response: videos }))
    );
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    history.replaceState(null, '', '/');
  });

  it('enqueues from the episode list, updates the progress and cancels without changing playback', async () => {
    const path = `/downloads/${'b'.repeat(32)}/index.m3u8`;
    let queue: Download[] = [];
    const onSelect = vi.fn();
    vi.mocked(desktopInvoke).mockImplementation(async (command, args) => {
      if (command === 'enqueue_downloads') {
        const [request] = args.requests as DownloadRequest[];
        queue = [download(request)];
      }
      if (command === 'change_download') queue = [];
      return queue;
    });
    function Episodes() {
      const controls = useEpisodeDownloads({
        open: true,
        anime,
        videos,
        voice,
        quality: 480,
        active: {
          stream: { url: `yumiwatch-media://localhost${path}`, quality: 720, type: 'hls' },
          video: first,
        },
      });
      return (
        <EpisodeOptions
          anime={anime}
          videos={[first, videos[2]]}
          episode="1"
          query=""
          downloads={controls?.forEpisode}
          onSelect={onSelect}
        />
      );
    }
    render(<Episodes />);
    fireEvent.click(screen.getByRole('button', { name: 'Скачать серию 1 · 720p' }));
    await screen.findByText('В очереди');
    expect(desktopInvoke).toHaveBeenCalledWith('enqueue_downloads', {
      requests: [expect.objectContaining({ episode: '1', voice, quality: 720, active: path })],
    });

    queue = [download({ status: 'downloading', done: 3, total: 8 })];
    const bar = (await screen.findByRole(
      'progressbar',
      { name: 'Прогресс загрузки серии 1 · 720p' },
      { timeout: 2500 }
    )) as HTMLProgressElement;
    expect(bar.value).toBe(37);
    expect(screen.getByText('37%')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Отменить загрузку серии 1 · 720p' }));
    await screen.findByRole('button', { name: 'Скачать серию 1 · 720p' });
    expect(desktopInvoke).toHaveBeenCalledWith('change_download', {
      id: 'a'.repeat(32),
      action: 'cancel',
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows an offline copy in the anime episode picker only for the selected voice', async () => {
    const savedId = 'b'.repeat(32);
    vi.mocked(desktopInvoke).mockResolvedValue([
      download({ id: savedId, status: 'ready' }),
      download({ id: 'c'.repeat(32), voice: 'Озвучка Команда Б', episode: '2', status: 'ready' }),
    ]);
    const close = vi.fn();
    render(
      <AboutEpisodes
        anime={anime}
        videos={videos}
        open
        close={close}
        loading={false}
        error=""
        retry={vi.fn()}
      />
    );
    const saved = await screen.findByRole('link', { name: 'Смотреть офлайн серию 1 · 720p' });
    expect(saved.getAttribute('data-app-href')).toBe(
      downloadPath(download({ id: savedId }), 'about')
    );
    expect(screen.queryByRole('link', { name: 'Смотреть офлайн серию 2 · 720p' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Команда Б' }));
    expect(
      await screen.findByRole('link', { name: 'Смотреть офлайн серию 2 · 720p' })
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Смотреть офлайн серию 1 · 720p' })).toBeNull();
  });

  it('shows one searchable card per anime and filters by status', async () => {
    vi.mocked(desktopInvoke).mockResolvedValue([
      download({
        episode: '10',
        quality: 1080,
        anime: { year: 2021, kind: 'TV' },
        status: 'ready',
        stream: { provider: 'CVH', videoId: 99, quality: 1080, entry: 'downloads/test/index.m3u8' },
      }),
      download({ id: 'b'.repeat(32), episode: '1', voice: 'Другая озвучка', quality: 360 }),
      download({ id: 'c'.repeat(32), animeId: 21, title: 'Другое аниме', status: 'failed' }),
      download({ id: 'd'.repeat(32), animeId: 22, title: 'Только в очереди' }),
    ]);
    render(<DownloadsPage />);
    const link = await screen.findByRole('link', { name: anime.title });
    expect(link.getAttribute('data-app-href')).toBe('#/downloads/anime/20');
    expect(within(link).getByText(/2021 · TV/)).toBeTruthy();
    expect(screen.queryByText('Серия 10')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Другое аниме' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Только в очереди' })).toBeNull();
    const tabs = within(screen.getByRole('group', { name: 'Статус загрузок' }));
    expect(tabs.getByRole('button', { name: 'Скачано · 1', pressed: true })).toBeTruthy();
    fireEvent.click(tabs.getByRole('button', { name: 'Все · 3' }));
    expect(screen.getByRole('link', { name: 'Только в очереди' })).toBeTruthy();

    const search = screen.getByRole('searchbox', { name: 'Поиск по загрузкам' });
    fireEvent.input(search, { target: { value: 'ТЕСТОВОЕ' } });
    expect(screen.queryByRole('link', { name: 'Другое аниме' })).toBeNull();
    fireEvent.input(search, { target: { value: '' } });
    fireEvent.click(tabs.getByRole('button', { name: 'С ошибками · 1' }));
    expect(screen.queryByRole('link', { name: anime.title })).toBeNull();
    expect(screen.getByRole('link', { name: 'Другое аниме' })).toBeTruthy();
  });

  it('queues every remaining episode in the selected voice with one season action', async () => {
    vi.mocked(desktopInvoke).mockResolvedValue([download({ episode: '1' })]);
    render(
      <AboutEpisodes
        anime={anime}
        videos={[...videos, video('4', voice, 104)]}
        open
        close={vi.fn()}
        loading={false}
        error=""
        retry={vi.fn()}
      />
    );
    await screen.findByRole('button', { name: /Отменить загрузку серии 1/ });
    fireEvent.input(screen.getByRole('searchbox', { name: 'Найти серию' }), {
      target: { value: '3' },
    });
    const advanced = screen.getByRole('button', { name: 'Параметры скачивания', expanded: false });
    expect(screen.queryByRole('combobox', { name: 'Качество загрузки серии' })).toBeNull();
    fireEvent.click(advanced);
    fireEvent.click(screen.getByRole('combobox', { name: 'Качество загрузки серии' }));
    fireEvent.click(screen.getByRole('option', { name: 'До 720p' }));
    fireEvent.click(screen.getByRole('button', { name: 'Скачать сезон · 2' }));
    await waitFor(() =>
      expect(desktopInvoke).toHaveBeenCalledWith('enqueue_downloads', {
        requests: [
          expect.objectContaining({ episode: '3', voice, quality: 720 }),
          expect.objectContaining({ episode: '4', voice, quality: 720 }),
        ],
      })
    );
  });

  it('links an episode to its saved copy when its original provider is no longer listed', async () => {
    const local = download({
      status: 'ready',
      stream: {
        provider: 'Kodik',
        videoId: 999,
        quality: 360,
        entry: 'downloads/kodik/index.m3u8',
      },
    });
    vi.mocked(desktopInvoke).mockResolvedValue([local]);
    const picker = render(
      <AboutEpisodes
        anime={anime}
        videos={videos}
        open
        close={vi.fn()}
        loading={false}
        error=""
        retry={vi.fn()}
      />
    );
    const episode = screen.getByRole('link', { name: 'Серия 1' });
    await waitFor(() =>
      expect(episode.getAttribute('data-app-href')).toBe(downloadPath(local, 'about'))
    );
    const href = episode.getAttribute('data-app-href')!;
    picker.unmount();
    render(<Detail id={String(anime.anime_id)} query={href.split('?')[1]} />);
    const surface = await screen.findByLabelText(`${anime.title} — серия 1`);
    expect(surface.getAttribute('data-test-src')).toContain('/downloads/kodik/index.m3u8');
    fireEvent.click(within(surface).getByRole('button', { name: 'Об аниме' }));
    await waitFor(() => expect(location.hash).toBe('#/anime/20'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows all known episodes and manages their downloads by voice without opening a stream', async () => {
    const queue = [
      download({ episode: '10', quality: 1080 }),
      download({ id: 'b'.repeat(32), episode: '1', voice: 'Озвучка Команда Б', quality: 360 }),
      download({ id: 'c'.repeat(32), episode: '2', quality: 720, actualQuality: 480 }),
      download({ id: 'd'.repeat(32), animeId: 21, title: 'Другое аниме', quality: 240 }),
    ];
    vi.mocked(desktopInvoke).mockImplementation(async (command, args) => {
      if (command === 'enqueue_downloads') {
        const [request] = args.requests as DownloadRequest[];
        queue.push(download({ ...request, id: 'e'.repeat(32) }));
      }
      return [...queue];
    });
    render(<DownloadsPage animeId={anime.anime_id} />);
    await screen.findByRole('heading', { level: 1, name: anime.title });
    const voiceGroup = screen.getByRole('region', { name: 'Серии' });
    const tabs = within(voiceGroup).getByRole('group', { name: 'Озвучка серий' });
    fireEvent.click(within(tabs).getByRole('button', { name: 'Команда А' }));
    await within(voiceGroup).findByRole('link', { name: 'Смотреть онлайн серию 3' });

    expect(
      within(voiceGroup)
        .getAllByRole('listitem')
        .map(item => item.textContent)
    ).toEqual([
      expect.stringMatching(/Серия 1.*Не скачана/),
      expect.stringMatching(/Серия 2.*480p/),
      expect.stringMatching(/Серия 3.*Не скачана/),
      expect.stringMatching(/Серия 10.*1080p/),
    ]);
    fireEvent.click(within(voiceGroup).getByRole('button', { name: /Скачать серию 3/ }));
    await within(voiceGroup).findByRole('button', { name: /Отменить загрузку серии 3/ });
    expect(desktopInvoke).toHaveBeenCalledWith('enqueue_downloads', {
      requests: [expect.objectContaining({ animeId: anime.anime_id, episode: '3', voice })],
    });
    fireEvent.click(within(tabs).getByRole('button', { name: 'Команда Б' }));
    expect(within(voiceGroup).getAllByRole('listitem')[0].textContent).toMatch(/Серия 1.*360p/);
    expect(within(voiceGroup).getByRole('link', { name: 'Смотреть онлайн серию 2' })).toBeTruthy();
    expect(within(voiceGroup).getAllByRole('listitem')[2].textContent).toMatch(
      /Серия 3.*Нет в этой озвучке/
    );
    expect(vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/anime/${anime.anime_id}/videos`,
    ]);
    expect(screen.queryByRole('heading', { name: 'Другое аниме' })).toBeNull();
  });

  it('keeps the cached full episode list and local jobs available offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const animeId = 31;
    putCache('data', `/anime/${animeId}/videos?`, videos);
    vi.mocked(desktopInvoke).mockResolvedValue([download({ animeId })]);
    render(<DownloadsPage animeId={animeId} />);
    await screen.findByText('Серия 3');
    expect(screen.queryByRole('link', { name: 'Смотреть онлайн серию 3' })).toBeNull();
    expect(screen.getByRole('button', { name: /Отменить загрузку серии 1/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Команда Б' }));
    expect(screen.getByText('Нужен интернет')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Смотреть онлайн серию 2' })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('marks saved and in-progress viewing independently and removes only the confirmed download scope', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    putCache('data', `/anime/${anime.anime_id}/videos?`, videos);
    savePlaybackRecovery(
      {
        anime,
        videoId: videos[2].video_id,
        group: groupKey(videos[2]),
        episode: '3',
        updatedAt: Date.now(),
        position: 95,
        duration: 1200,
      },
      null
    );
    const local = download({
      status: 'ready',
      stream: {
        provider: 'CVH',
        videoId: first.video_id,
        quality: 720,
        entry: 'downloads/test/index.m3u8',
      },
    });
    const active = download({ id: 'b'.repeat(32), episode: '3', status: 'downloading' });
    const otherVoice = download({ id: 'c'.repeat(32), voice: videos[1].data.dubbing });
    const otherAnime = download({ id: 'd'.repeat(32), animeId: 21 });
    let queue = [local, active, otherVoice, otherAnime];
    vi.mocked(desktopInvoke).mockImplementation(async (command, args) => {
      if (command === 'remove_downloads')
        queue = queue.filter(entry => !(args.ids as string[]).includes(entry.id));
      return [...queue];
    });
    render(<DownloadsPage animeId={anime.anime_id} />);
    const saved = await screen.findByRole('link', { name: 'Смотреть офлайн серию 1 · 720p' });
    expect(saved.closest('li')?.classList.contains('is-downloaded')).toBe(true);
    const current = screen.getByRole('button', { name: /Отменить загрузку серии 3/ }).closest('li');
    expect(current?.classList.contains('is-current')).toBe(true);
    expect(current?.classList.contains('is-downloaded')).toBe(false);
    expect(within(current!).getByText('Просмотрено 01:35')).toBeTruthy();

    const removeVoice = screen.getByRole('button', { name: 'Удалить загрузки озвучки' });
    fireEvent.click(removeVoice);
    const confirmVoice = screen.getByRole('dialog', { name: 'Удалить загрузки озвучки?' });
    fireEvent.click(within(confirmVoice).getByRole('button', { name: 'Отмена' }));
    expect(
      vi.mocked(desktopInvoke).mock.calls.some(([command]) => command === 'remove_downloads')
    ).toBe(false);
    fireEvent.click(removeVoice);
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Удалить загрузки' })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(desktopInvoke).toHaveBeenCalledWith('remove_downloads', { ids: [active.id, local.id] });
    expect(queue).toEqual([otherVoice, otherAnime]);

    fireEvent.click(screen.getByRole('button', { name: 'Удалить загрузки сериала' }));
    const confirmSeries = screen.getByRole('dialog', { name: 'Удалить загрузки сериала?' });
    fireEvent.click(within(confirmSeries).getByRole('button', { name: 'Удалить загрузки' }));
    await screen.findByText('Загрузок для этого аниме нет');
    expect(queue).toEqual([otherAnime]);
  });

  it('groups qualities into one episode card and remembers the chosen layout on the anime page', async () => {
    vi.mocked(desktopInvoke).mockResolvedValue([
      download({ quality: 720 }),
      download({ id: 'b'.repeat(32), quality: 1080 }),
    ]);
    const { unmount } = render(<DownloadsPage animeId={anime.anime_id} />);
    const toolbar = await screen.findByRole('group', { name: 'Вид списка серий' });
    expect(within(toolbar).getByRole('button', { name: 'Карточки', pressed: true })).toBeTruthy();
    const rows = screen.getByRole('list', { name: '' });
    const firstCard = within(rows).getAllByRole('listitem')[0];
    expect(firstCard.querySelector('.episode-preview')).toBeTruthy();
    expect(within(firstCard).getByText('1080p')).toBeTruthy();
    expect(within(firstCard).getByText('720p')).toBeTruthy();
    expect(within(firstCard).getAllByText('Серия 1')).toHaveLength(1);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Список' }));
    expect(interfaceSettings().episodeLayout).toBe('list');
    await within(toolbar).findByRole('button', { name: 'Список', pressed: true });
    expect(rows.querySelector('.episode-preview')).toBeNull();
    unmount();

    render(
      <AboutEpisodes
        anime={anime}
        videos={videos}
        open
        close={vi.fn()}
        loading={false}
        error=""
        retry={vi.fn()}
      />
    );
    const panel = screen.getByRole('dialog', { name: 'Серии' });
    const layout = within(panel).getByRole('group', { name: 'Вид списка серий' });
    expect(within(layout).getByRole('button', { name: 'Список', pressed: true })).toBeTruthy();
    expect(panel.querySelector('.episode-cards-grid')).toBeNull();
    fireEvent.click(within(layout).getByRole('button', { name: 'Карточки' }));
    await within(layout).findByRole('button', { name: 'Карточки', pressed: true });
    expect(panel.querySelector('.episode-cards-grid')).toBeTruthy();
  });

  it('only enqueues the selected provider from the episode controls', async () => {
    const kodik: Video = { ...first, video_id: 201, iframe_url: 'https://kodik.info/seria/test' };
    const aksor: Video = {
      ...first,
      video_id: 301,
      iframe_url: 'https://player.aksor.tv/video/test',
    };
    vi.mocked(desktopInvoke).mockResolvedValue([]);
    render(
      <AboutEpisodes
        anime={anime}
        videos={[first, kodik, aksor]}
        open
        close={vi.fn()}
        loading={false}
        error=""
        retry={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Параметры скачивания' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Источник загрузки серии' }));
    expect(screen.getByRole('option', { name: 'Kodik' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'Aksor' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Качество загрузки серии' }));
    fireEvent.click(screen.getByRole('option', { name: 'До 1440p' }));
    fireEvent.click(screen.getByRole('button', { name: 'Скачать серию 1 · 1440p' }));
    expect(desktopInvoke).toHaveBeenCalledWith('enqueue_downloads', {
      requests: [
        expect.objectContaining({
          quality: 1440,
          candidates: [expect.objectContaining({ videoId: 301 })],
        }),
      ],
    });
  });

  it('opens a saved DASH stream in the ordinary watch page with saved skip markers', async () => {
    const entry = download({
      status: 'ready',
      stream: {
        provider: 'Aksor',
        videoId: first.video_id,
        quality: 480,
        entry: `downloads/${'a'.repeat(32)}/index.mpd`,
        skips: { opening: { time: 12, length: 70 } },
      },
    });
    vi.mocked(desktopInvoke).mockResolvedValue([entry]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const { container } = render(
        <Detail id={String(anime.anime_id)} query={downloadPath(entry).split('?')[1]} />
      );
      const surface = await screen.findByLabelText(`${anime.title} — серия 1`);
      expect(surface.getAttribute('data-test-src')).toBe(
        `https://yumiwatch-media.localhost/${entry.stream?.entry}`
      );
      expect(surface.getAttribute('data-test-opening')).toBe('12');
      expect(container.querySelector('.anime-detail-screen.is-watching')).toBeTruthy();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('reads the saved screenshot address from the queue and uses the local image cache', async () => {
    const preview = 'https://static.yani.tv/ready-preview.jpg';
    const entry = download({
      status: 'ready',
      preview,
      stream: {
        provider: 'CVH',
        videoId: first.video_id,
        quality: 720,
        entry: 'downloads/cvh/index.m3u8',
      },
    });
    vi.stubGlobal('indexedDB', {});
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = vi.fn(() => 'blob:ready-preview');
        static revokeObjectURL = vi.fn();
      }
    );
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      putCache('image', preview, new Blob(['preview'], { type: 'image/jpeg' }));
      vi.mocked(desktopInvoke).mockResolvedValue([entry]);
      render(<Detail id={String(anime.anime_id)} query={downloadPath(entry).split('?')[1]} />);
      const surface = await screen.findByLabelText(`${anime.title} — серия 1`);
      expect(surface.getAttribute('data-test-loading-image')).toBe('blob:ready-preview');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('requests native timeline previews from the open downloaded media', async () => {
    const stream = {
      url: 'yumiwatch-media://localhost/downloads/cvh/index.m3u8',
      quality: 720,
      type: 'hls' as const,
      offline: true,
    };
    vi.mocked(desktopInvoke).mockImplementation(async (command, args) => {
      if (command === 'native_video_frame') return [255, 216, 255];
      if ((args.request as { action?: string } | undefined)?.action === 'poll')
        return { ready: true, position: 5, duration: 60, buffering: false };
    });
    const playback = new NativePlayback(stream.url);
    try {
      await playback.open(document.createElement('div'), stream, undefined, 5, stream);
      const frame = await playback.previewFrame?.(12);
      expect(frame?.size).toBe(3);
      expect(desktopInvoke).toHaveBeenCalledWith('native_video', {
        request: expect.objectContaining({ action: 'open', url: stream.url, preview: undefined }),
      });
      expect(desktopInvoke).toHaveBeenCalledWith('native_video_frame', {
        id: playback.id,
        close: false,
        seconds: 12,
      });
      expect(playback.currentTime).toBe(5);
    } finally {
      playback.close();
    }
  });

  it('continues a saved copy in either voice and saves progress to shared history', async () => {
    const queued = download({ status: 'queued', episode: '2' });
    const saved = download({
      id: 'b'.repeat(32),
      episode: '3',
      status: 'ready',
      stream: {
        provider: 'Kodik',
        videoId: 303,
        quality: 480,
        entry: 'downloads/kodik/index.m3u8',
      },
    });
    const otherCopy = download({
      id: 'c'.repeat(32),
      episode: '3',
      voice: 'Другая озвучка',
      status: 'ready',
      stream: {
        provider: 'Alloha',
        videoId: 302,
        quality: 360,
        entry: 'downloads/alloha/index.m3u8',
      },
    });
    savePlaybackRecovery(
      {
        anime,
        videoId: videos[2].video_id,
        group: groupKey(videos[2]),
        episode: '3',
        updatedAt: Date.now() - 1000,
        position: 122,
        duration: 1200,
      },
      null
    );
    vi.mocked(desktopInvoke).mockResolvedValue([queued, saved, otherCopy]);
    const catalog = render(<DownloadsPage animeId={anime.anime_id} />);
    const resume = await screen.findByRole('link', { name: 'Продолжить просмотр' });
    expect(resume.getAttribute('data-app-href')).toBe(downloadPath(saved));
    expect(screen.getByText(/Серия 3.*02:02/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Другая озвучка' }));
    const alternate = screen.getByRole('link', { name: 'Продолжить просмотр серии 3 · 360p' });
    expect(alternate.getAttribute('data-app-href')).toBe(downloadPath(otherCopy));
    catalog.unmount();

    render(<Detail id={String(anime.anime_id)} query={downloadPath(otherCopy).split('?')[1]} />);
    const surface = await screen.findByLabelText(`${anime.title} — серия 3`);
    expect(surface.getAttribute('data-test-src')).toContain(otherCopy.stream?.entry);
    expect(surface.getAttribute('data-test-start')).toBe('122');
    fireEvent.click(within(surface).getByRole('button', { name: 'Сохранить место' }));
    expect(readLibrary().history[0]).toMatchObject({ videoId: 302, episode: '3', position: 145 });
    fireEvent.click(within(surface).getByRole('button', { name: 'Загрузки' }));
    await waitFor(() => expect(location.hash).toBe('#/downloads/anime/20'));
  });
});
