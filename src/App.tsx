import type { FunctionalComponent as FC } from 'preact';
import { useCallback, useLayoutEffect, useRef } from 'preact/hooks';

import { useAccountSync } from '~/hooks/useAccountSync';
import { useAppEnvironment } from '~/hooks/useAppEnvironment';
import { useAppDiscordPresence } from '~/hooks/useAppDiscordPresence';
import { useAppUpdate } from '~/hooks/useAppUpdate';
import { useInstallation } from '~/hooks/useInstallation';
import { usePictureInPicturePage } from '~/hooks/usePictureInPicturePage';
import { useReleaseUpdate } from '~/hooks/useReleaseUpdate';
import { useYummyRealtime } from '~/hooks/useYummyRealtime';
import { useHash, useSession, useVisualViewport } from '~/lib/hooks';
import { isDesktopWindow } from '~/lib/desktop';
import { isTvMode } from '~/lib/tv-mode';
import { usesMacNativePlayback } from '~/lib/native-playback';

import { InterfaceEffects } from '~/components/InterfaceEffects';
import { MediaNavigation } from '~/components/MediaNavigation';
import { Detail } from '~/components/Detail';
import { Catalog, Home } from '~/components/Pages';
import { RoutePage } from '~/components/RoutePage';
import { Search } from '~/components/Search';
import { WindowChrome } from '~/components/WindowChrome';
import { WindowCursor } from '~/components/WindowCursor';
import { Scrollbars } from '~/components/Scrollbars';
import { ActivityNotice } from '~/components/Social';
import { AppUpdateNotice } from '~/components/AppUpdateNotice';
import { NavigationHistory } from '~/components/NavigationHistory';
import { navigateBack } from '~/lib/navigation';
import { CardTitleTooltip, Icon, Toast } from '~/ui';
import { CardContextMenu } from '~/components/CardContextMenu';
import { MiddleMouseScroll } from '~/components/MiddleMouseScroll';

const titles: Partial<Record<string, string>> = {
  '/': 'Каталог',
  '/catalog': 'Каталог',
  '/schedule': 'Расписание',
  '/downloads': 'Загрузки',
  '/settings': 'Настройки',
  '/settings/connection': 'Подключение',
  '/account': 'Аккаунт',
  '/profile': 'Мой профиль',
  '/search': 'Поиск',
  '/notifications': 'Уведомления',
  '/messages': 'Сообщения',
};

export const App: FC = () => {
  const path = useHash();
  const [route, query = ''] = path.split('?');

  useAppDiscordPresence(path);
  useYummyRealtime();

  useVisualViewport();

  const retainedHome = useRef(false);
  const retainedCatalog = useRef<string>();
  const retainedSearch = useRef<string>();
  const browseReturn = useRef('/');

  if (route === '/') retainedHome.current = true;
  if (route === '/catalog') retainedCatalog.current = query;
  if (route === '/search') retainedSearch.current = query;
  if (
    ['/', '/catalog', '/search', '/profile', '/messages', '/notifications', '/schedule'].includes(
      route
    ) ||
    route === '/downloads' ||
    route.startsWith('/downloads/anime/') ||
    route.startsWith('/users/')
  )
    browseReturn.current = path;

  const detailRoute = /^\/anime\/[^/]+$/.test(route);
  const params = new URLSearchParams(query);
  const detailView =
    params.get('view') === 'watch' || params.has('watch') ? 'watch' : 'anime-about';
  const watching = detailRoute && detailView === 'watch';
  const nativeWatchPath = watching && usesMacNativePlayback() ? path : undefined;
  const { playerPath, media: watchMedia, pip } = usePictureInPicturePage(nativeWatchPath);
  const [playerRoute, playerQuery] = playerPath?.split('?') || [];
  const sidebarHistory =
    isDesktopWindow() &&
    ['macos', 'windows'].includes(document.documentElement.dataset.desktop || '');
  const session = useSession();
  const online = useAppEnvironment();
  const installation = useInstallation();
  const update = useAppUpdate();
  const releaseUpdate = useReleaseUpdate();

  useAccountSync(session);

  useLayoutEffect(() => {
    document.documentElement.dataset.screen = detailRoute ? detailView : route.slice(1) || 'home';
    document.title = `${titles[route] ?? (route.startsWith('/users/') ? 'Профиль' : route.startsWith('/downloads/') ? 'Загрузки' : 'Аниме')} · YummyWatch`;
  }, [path]);

  const goBack = useCallback(() => {
    navigateBack(detailRoute ? (detailView === 'watch' ? route : browseReturn.current) : '/');
  }, [detailRoute, detailView, route]);

  const applyUpdate = useCallback(
    () => update?.waiting?.postMessage({ type: 'SKIP_WAITING' }),
    [update]
  );

  return (
    <div class={`media-app ${watching ? 'is-playback' : ''}`}>
      <WindowChrome watching={watching} />
      <WindowCursor />
      <InterfaceEffects path={path} onBack={goBack} />
      <div class="media-backdrop" aria-hidden="true" />

      <MediaNavigation
        path={path}
        watching={watching}
        selected={detailRoute ? browseReturn.current.split('?')[0] : route}
        updateNotice={
          !watching &&
          (update ? (
            <AppUpdateNotice apply={applyUpdate} />
          ) : releaseUpdate.release ? (
            <AppUpdateNotice
              key={releaseUpdate.release.version}
              release={releaseUpdate.release}
              dismiss={releaseUpdate.dismiss}
            />
          ) : null)
        }
        history={
          sidebarHistory ? (
            <NavigationHistory path={path} hidden={watching} placement="sidebar" />
          ) : undefined
        }
      />
      <div class={`workspace media-workspace ${detailRoute ? 'detail-workspace' : ''}`}>
        {!sidebarHistory && !isTvMode() && <NavigationHistory path={path} hidden={watching} />}
        {!watching && !online && (
          <div class="offline-bar" role="status">
            <Icon name="wifi" size={17} />
            {session
              ? 'Ты без сети. Для коллекции аккаунта нужен интернет.'
              : 'Ты без сети. Гостевая коллекция и загруженные страницы доступны.'}
          </div>
        )}
        <main id="main" class="media-scroll" tabIndex={-1}>
          <div class="media-scroll-content">
            {retainedHome.current && (
              <div class="route-panel" hidden={route !== '/'}>
                <Home
                  active={route === '/'}
                  liveWatch={
                    route === '/' && pip.active && !nativeWatchPath && playerPath
                      ? { path: playerPath, media: watchMedia }
                      : undefined
                  }
                />
              </div>
            )}
            {retainedCatalog.current !== undefined && (
              <div class="route-panel" hidden={route !== '/catalog'}>
                <Catalog query={retainedCatalog.current} active={route === '/catalog'} />
              </div>
            )}
            {retainedSearch.current !== undefined && (
              <div class="route-panel" hidden={route !== '/search'}>
                <Search query={retainedSearch.current} active={route === '/search'} />
              </div>
            )}
            {!nativeWatchPath && (
              <RoutePage
                route={route}
                query={query}
                returnTo={browseReturn.current}
                installation={installation}
              />
            )}
            {playerRoute && (
              <div class="route-panel" hidden={!nativeWatchPath}>
                <Detail
                  key={playerRoute}
                  id={playerRoute.split('/')[2]}
                  query={playerQuery}
                  returnTo={browseReturn.current}
                  background={!nativeWatchPath}
                  watchMedia={watchMedia}
                  pip={pip}
                />
              </div>
            )}
          </div>
        </main>
      </div>
      <Toast />
      <ActivityNotice />
      <Scrollbars />
      <CardTitleTooltip />
      <CardContextMenu />
      <MiddleMouseScroll />
    </div>
  );
};
