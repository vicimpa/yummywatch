// Full production UI, real read-only Yummy data and the real native media backend.
// Only the OS window/event bridge is simulated; no server listens on a port.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium } from 'playwright';
import assert from 'node:assert/strict';

const probe = spawn(
  fileURLToPath(
    new URL(
      `../src-tauri/target/debug/examples/media_probe${process.platform === 'win32' ? '.exe' : ''}`,
      import.meta.url
    )
  ),
  [],
  { stdio: ['pipe', 'pipe', 'inherit'] }
);
const pending = new Map();
let sequence = 0;
const lines = createInterface({ input: probe.stdout });

lines.on('line', line => {
  const reply = JSON.parse(line),
    task = pending.get(reply.id);

  if (!task) return;
  pending.delete(reply.id);
  clearTimeout(task.timer);
  if (reply.error) task.reject(new Error(reply.error));
  else task.resolve(reply.result);
});
probe.on('exit', () => {
  for (const task of pending.values()) {
    clearTimeout(task.timer);
    task.reject(new Error('Native probe exited'));
  }
  pending.clear();
});

function native(action, values) {
  return new Promise((resolve, reject) => {
    const id = ++sequence,
      timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Native ${action} timed out`));
      }, 40000);

    pending.set(id, { resolve, reject, timer });
    probe.stdin.write(`${JSON.stringify({ id, action, ...values })}\n`);
  });
}

const apiCache = new Map();
const cacheMode = process.env.APP_CACHE === '1' || process.argv.includes('--cache');
const output = '/private/tmp/yumiwatch-app-qa';

await mkdir(output, { recursive: true });

const engines =
  process.env.APP_BROWSER === 'chrome'
    ? [chromium]
    : process.env.APP_BROWSER === 'webkit'
      ? [webkit]
      : [webkit, chromium];

try {
  for (const engine of engines) {
    const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {});
    let page;
    const errors = [];
    let networkBlocked = false,
      refreshRevision = 0,
      holdRefresh = false,
      releaseRefresh;
    let nativeButtonsVisible = true;
    let nativeCursorVisible = true;

    try {
      page = await browser.newPage({
        viewport: { width: 1280, height: 820 },
        locale: 'ru-RU',
        colorScheme: 'dark',
      });
      page.setDefaultTimeout(20000);
      page.on('pageerror', error => errors.push(error.message));
      await page.exposeFunction('desktopTestInvoke', async (command, args) => {
        if (command === 'load_account_session') return null;
        if (command === 'list_downloads') return [];
        if (command === 'set_window_controls_visible') {
          nativeButtonsVisible = args.visible;

          return;
        }
        if (command === 'set_window_cursor_visible') {
          nativeCursorVisible = args.visible;

          return;
        }
        if (networkBlocked) throw new Error('Offline cache test');
        if (command === 'fetch_image') return native('image', { url: args.url });
        if (command === 'resolve_candidates')
          return native('resolve', { candidates: args.candidates });
        if (command === 'yummy_request') {
          const request = args.request;

          assert.equal(request.method, 'GET', 'QA must not write to a real account');

          const update = async result => {
            if (refreshRevision && /^\/anime\/1486(?:\?|$)/.test(request.path)) {
              if (holdRefresh)
                await new Promise(resolve => {
                  releaseRefresh = resolve;
                });

              const payload = JSON.parse(result.body);

              payload.response.description += ' CACHE_REFRESH_VERIFIED';

              return { ...result, body: JSON.stringify(payload) };
            }

            return result;
          };

          if (apiCache.has(request.path)) return update(apiCache.get(request.path));

          const response = await fetch(`https://api.yani.tv${request.path}`, {
            headers: request.headers,
            signal: AbortSignal.timeout(15000),
          });
          const result = { status: response.status, body: await response.text() };

          if (response.ok) apiCache.set(request.path, result);

          return update(result);
        }
        throw new Error(`Unexpected desktop command: ${command}`);
      });
      await page.addInitScript(
        platform => {
          window.isTauri = true;

          let callbackId = 0,
            nativeFullscreen = false;

          window.qaFullscreenChanges = [];
          window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
          window.__TAURI_INTERNALS__ = {
            metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
            convertFileSrc: (path, scheme) => `https://${scheme}.localhost/${path}`,
            transformCallback: () => ++callbackId,
            unregisterCallback() {},
            invoke: async (command, args = {}) => {
              if (command === 'desktop_info') return { platform };
              if (command === 'plugin:event|listen') return ++callbackId;
              if (command === 'plugin:event|unlisten') return;
              if (command === 'plugin:window|is_maximized') return false;
              if (command === 'plugin:window|is_focused') return true;
              if (command === 'plugin:window|is_fullscreen') return nativeFullscreen;
              if (command === 'plugin:window|set_fullscreen') {
                nativeFullscreen = args.value;
                window.qaFullscreenChanges.push(args.value);

                return;
              }

              return window.desktopTestInvoke(command, args);
            },
          };
          localStorage.setItem(
            'yumiwatch:interface-settings',
            JSON.stringify({ volume: 0, sounds: false })
          );
        },
        engine === chromium ? 'windows' : 'macos'
      );
      await page.route('https://app-probe.test/**', async route => {
        const path = new URL(route.request().url()).pathname;
        const filename = resolve('dist', `.${path === '/' ? '/index.html' : path}`);

        assert.ok(filename.startsWith(`${resolve('dist')}/`));

        const types = {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.woff2': 'font/woff2',
        };

        try {
          await route.fulfill({
            contentType: types[extname(filename)] || 'application/octet-stream',
            body: await readFile(filename),
          });
        } catch {
          await route.abort();
        }
      });
      await page.route('https://yumiwatch-media.localhost/**', async route => {
        try {
          const request = route.request(),
            response = await native('media', {
              uri: `yumiwatch-media://localhost${new URL(request.url()).pathname}`,
              method: request.method(),
              range: request.headers().range,
            });
          const headers = { ...response.headers, 'access-control-allow-origin': '*' };

          delete headers['content-length'];
          delete headers.vary;
          await route.fulfill({
            status: response.status,
            headers,
            body: Buffer.from(response.body, 'base64'),
          });
        } catch {
          await route.abort();
        }
      });

      const nav = async name => {
        await page.locator('.media-nav').getByRole('link', { name, exact: true }).click();
        await transition();
      };

      const transition = () =>
        page.waitForFunction(
          () =>
            !document.documentElement.dataset.pageTransition &&
            !document.documentElement.dataset.pageFallback
        );

      const check = async label => {
        const state = await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          viewport: innerWidth,
          root: scrollY,
          alerts: [...document.querySelectorAll('[role=alert]')]
            .filter(e => e.getClientRects().length)
            .map(e => e.textContent),
        }));

        assert.ok(state.width <= state.viewport + 1, `${label}: horizontal overflow`);
        assert.equal(state.root, 0, `${label}: document moved`);
        assert.deepEqual(state.alerts, [], `${label}: visible errors`);
        assert.deepEqual(errors, [], `${label}: JS errors`);
        console.log(engine.name(), label, 'OK');
      };

      const capture = async name => {
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all(
            document
              .getAnimations()
              .filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime))
              .map(a => a.finished.catch(() => {}))
          );
        });
        await page.screenshot({ path: `${output}/${engine.name()}-${name}.png` });
      };

      const wake = () => page.locator('.video-controls').dispatchEvent('pointermove');

      const cachedScreenshots = async () => {
        await page.getByRole('button', { name: 'Открыть скриншот 1', exact: true }).waitFor();

        const count = await page.getByRole('button', { name: /^Открыть скриншот / }).count();

        await page.getByRole('button', { name: 'Открыть скриншот 1', exact: true }).click();
        for (let index = 0; index < count; index++) {
          if (index)
            await page.getByRole('button', { name: 'Следующий скриншот', exact: true }).click();
          await page.waitForFunction(() => {
            const image = document.querySelector('.screenshot-full');

            return image?.src.startsWith('blob:') && image.complete && image.naturalWidth > 0;
          });
        }
        await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
      };

      const decoded = async () => {
        await page.waitForFunction(
          () => document.querySelector('video[data-active=true]')?.readyState >= 2,
          null,
          { timeout: 45000 }
        );
        await page.evaluate(() => {
          const v = document.querySelector('video[data-active=true]');

          v.muted = true;
          void v.play();
        });

        const time = await page.locator('video[data-active=true]').evaluate(v => v.currentTime);

        await page.waitForFunction(
          time => document.querySelector('video[data-active=true]').currentTime > time + 0.5,
          time,
          { timeout: 20000 }
        );
      };
      const aboutEpisodes = page.locator('.about-inline-episodes');
      const aboutVoice = name =>
        aboutEpisodes
          .getByRole('group', { name: 'Озвучка серий' })
          .getByRole('button', { name, exact: true });
      const playFirstEpisode = async name => {
        await aboutVoice(name).click();
        await aboutEpisodes.getByRole('link', { name: 'Серия 1', exact: true }).click();
      };

      if (process.env.APP_CACHE_ONLY === '1') {
        await page.goto('https://app-probe.test/#/anime/1486');
        await aboutVoice('2x2').waitFor();
        await page.waitForFunction(() => {
          const image = document.querySelector('.watch-poster img');

          return image?.src.startsWith('blob:') && image.naturalWidth > 0;
        });
        await cachedScreenshots();

        const saved = await page.evaluate(
          () =>
            new Promise((resolve, reject) => {
              const open = indexedDB.open('yumiwatch-cache-v1', 1);

              open.onerror = () => reject(open.error);
              open.onsuccess = () => {
                const get = open.result
                  .transaction('entries', 'readonly')
                  .objectStore('entries')
                  .getAll();

                get.onsuccess = () => {
                  resolve(
                    get.result.map(e => ({
                      kind: e.kind,
                      key: e.key,
                      blob: e.data instanceof Blob,
                      size: e.data.size,
                    }))
                  );
                  open.result.close();
                };
              };
            })
        );

        console.log(
          engine.name(),
          'persisted metadata and images',
          saved.filter(e => e.kind === 'data').length,
          saved.filter(e => e.kind === 'image').length
        );
        networkBlocked = true;
        await page.route('https://static.yani.tv/**', route => route.abort());
        await page.route('https://i.kodikres.com/**', route => route.abort());
        await page.reload({ waitUntil: 'domcontentloaded' });
        await aboutVoice('2x2').waitFor();
        await page.waitForFunction(() => {
          const image = document.querySelector('.watch-poster img');

          return image?.src.startsWith('blob:') && image.naturalWidth > 0;
        });
        await cachedScreenshots();
        await page.getByRole('button', { name: 'Серии', exact: true }).click();
        await page
          .locator('.episode-card:visible')
          .filter({ hasText: 'Серия 1' })
          .first()
          .waitFor();
        await check('offline restart from persisted cache');
        continue;
      }
      await page.goto('https://app-probe.test/#/');
      await page.locator('.gallery-feature h2').waitFor();
      await check('home');
      await capture('home');
      if (process.env.APP_KEYBOARD_ONLY === '1') {
        await nav('Все аниме');
        await page.locator('.anime-card:visible').first().waitFor();
        await page.locator('#main').focus();
        await page.keyboard.press('ArrowDown');
        assert.ok(
          await page.evaluate(
            () =>
              document.activeElement.matches('[data-gallery-link]') &&
              !document.activeElement.closest('[hidden],[inert],[aria-hidden=true]')
          ),
          'Arrows focused a hidden/invalid route'
        );

        const href = await page.evaluate(() =>
          document.activeElement.getAttribute('data-app-href')
        );

        await page.keyboard.press('Enter');
        await page.waitForFunction(href => location.hash === href, href);
        await page.locator('.watch-title h1').waitFor();
        await nav('Все аниме');
        await page
          .locator('.media-nav')
          .getByRole('link', { name: 'Все аниме', exact: true })
          .focus();
        await page.keyboard.press('ArrowDown');
        assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Поиск');
        await page.keyboard.press('Enter');
        await page.getByRole('searchbox', { name: 'Поиск аниме', exact: true }).waitFor();
        await nav('Настройки');
        await page.locator('#main').focus();
        await page.keyboard.press('ArrowDown');
        assert.ok(
          await page.evaluate(
            () =>
              document.getElementById('main').contains(document.activeElement) &&
              !document.activeElement.closest('[hidden]')
          ),
          'Settings focus escaped into retained catalog'
        );
        await check('production app keyboard navigation');
        continue;
      }
      await page.keyboard.press('f');
      await page.waitForFunction(
        () => document.documentElement.dataset.desktopFullscreen === 'true'
      );
      const fullscreenRoute = await page.evaluate(() => location.hash);
      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () => document.documentElement.dataset.desktopFullscreen === 'false'
      );
      assert.equal(await page.evaluate(() => location.hash), fullscreenRoute);
      await page.keyboard.press('f');
      await page.waitForFunction(
        () => document.documentElement.dataset.desktopFullscreen === 'true'
      );
      await nav('Все аниме');
      await page.locator('.anime-card:visible').first().waitFor();
      await page.getByRole('combobox', { name: 'Сортировка' }).click();
      await page.getByRole('option', { name: 'Топ YummyAnime', exact: true }).click();
      await page.waitForFunction(() => location.hash.includes('sort=top'));
      await page.locator('.anime-card:visible').first().waitFor();
      await page.getByRole('button', { name: 'Фильтры', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await capture('filters');
      if (process.env.APP_CAPTURE_ONLY === '1') continue;
      await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
      await page.waitForFunction(() => document.body.style.overflow !== 'hidden');
      await check('catalog and filters');
      await page.locator('#main').evaluate(e => {
        e.scrollTop = 500;
      });

      const catalogScroll = await page.locator('#main').evaluate(e => e.scrollTop);

      await nav('Поиск');
      await page
        .getByRole('searchbox', { name: 'Поиск аниме', exact: true })
        .fill('Унесенные призраками');
      await page.keyboard.press('f');
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.desktopFullscreen),
        'true'
      );
      await page
        .getByRole('searchbox', { name: 'Поиск аниме', exact: true })
        .fill('Унесенные призраками');
      await page.locator('.search-results a[data-app-href^="#/anime/1486"]').first().waitFor();
      await check('search');
      await page.goBack();
      await page.waitForFunction(() => location.hash.includes('/catalog?sort=top'));
      await transition();
      await page.waitForFunction(
        value => Math.abs(document.getElementById('main').scrollTop - value) < 2,
        catalogScroll
      );
      await nav('Поиск');
      await page.locator('.search-results a[data-app-href^="#/anime/1486"]').first().click();
      await transition();
      await aboutVoice('2x2').waitFor();
      await check('film about');
      await capture('film-about');
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.desktopFullscreen),
        'true',
        'Navigation left app fullscreen'
      );
      await page.keyboard.press('f');
      await page.waitForFunction(
        () => document.documentElement.dataset.desktopFullscreen === 'false'
      );
      if (cacheMode) {
        await cachedScreenshots();
      }
      await page.getByRole('button', { name: /Добавить «.*» в избранное/ }).click();
      await page.getByRole('button', { name: /Убрать «.*» из избранного/ }).waitFor();
      await playFirstEpisode('2x2');
      await transition();
      await decoded();
      await check('film 2x2 playback');

      const headingTop = await page
        .locator('.video-heading')
        .evaluate(e => e.getBoundingClientRect().top);

      await page.mouse.move(400, 350);
      await page.waitForFunction(
        () =>
          document.querySelector('.video-controls')?.classList.contains('is-hidden') &&
          document.querySelector('.window-chrome')?.classList.contains('is-hidden')
      );
      if (engine === webkit) {
        const deadline = Date.now() + 2000;

        while (nativeButtonsVisible && Date.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(nativeButtonsVisible, false, 'macOS traffic-light hide command missing');
      }
      {
        const deadline = Date.now() + 2000;

        while (nativeCursorVisible && Date.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(nativeCursorVisible, false, 'Native cursor hide command missing');
      }
      await page.mouse.move(401, 351);
      await page.waitForFunction(
        () =>
          document.querySelector('.video-controls')?.classList.contains('is-visible') &&
          !document.querySelector('.window-chrome')?.classList.contains('is-hidden')
      );
      {
        const deadline = Date.now() + 2000;

        while (!nativeCursorVisible && Date.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(nativeCursorVisible, true, 'Native cursor restore command missing');
      }
      assert.equal(
        await page.locator('.video-heading').evaluate(e => e.getBoundingClientRect().top),
        headingTop,
        'Hiding window controls shifted playback content'
      );
      console.log(engine.name(), 'window controls idle and mouse wake OK');

      const clickArea = page.locator('.video-hit-area');

      await clickArea.dblclick({ position: { x: 300, y: 280 } });
      await page.waitForFunction(
        () => document.documentElement.dataset.desktopFullscreen === 'true'
      );
      await page.waitForTimeout(350);
      assert.equal(
        await page.locator('video[data-active=true]').evaluate(v => v.paused),
        false,
        'Double click paused playback'
      );
      await clickArea.dblclick({ position: { x: 300, y: 280 } });
      await page.waitForFunction(
        () => document.documentElement.dataset.desktopFullscreen === 'false'
      );
      assert.equal(
        await page.locator('video[data-active=true]').evaluate(v => v.paused),
        false,
        'Leaving fullscreen paused playback'
      );
      console.log(engine.name(), 'video double click fullscreen and playback preservation OK');

      const fullChanges = await page.evaluate(() => window.qaFullscreenChanges.length);

      await page.keyboard.press('f');
      await page.waitForFunction(
        () => document.documentElement.dataset.desktopFullscreen === 'true'
      );
      assert.equal(
        await page.evaluate(() => window.qaFullscreenChanges.length),
        fullChanges + 1,
        'Player and global shortcut toggled fullscreen twice'
      );
      await wake();
      await page.getByRole('button', { name: 'Настройки плеера', exact: true }).click();
      await page.keyboard.press('Escape');
      await page.locator('.video-settings').waitFor({ state: 'detached' });
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.desktopFullscreen),
        'true',
        'Escape left app fullscreen'
      );
      await page.locator('video[data-active=true]').evaluate(v => {
        v.currentTime = 43;
      });
      await page.waitForFunction(
        () => {
          const v = document.querySelector('video[data-active=true]');

          return v.currentTime > 43 && !v.seeking && v.readyState >= 2;
        },
        null,
        { timeout: 30000 }
      );
      await page.evaluate(() => {
        window.qaMedia = document.querySelector('video[data-active=true]');
      });
      await wake();
      await page.getByRole('button', { name: 'Комментарии', exact: true }).click();
      await page.locator('.comment-item,.discussion-empty').first().waitFor();
      assert.ok(
        await page.evaluate(
          () => window.qaMedia === document.querySelector('video[data-active=true]')
        ),
        'Comments replaced the decoder'
      );
      await capture('comments');
      await page.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
      await page.locator('.sidebar-presence').waitFor({ state: 'detached' });
      await page.setViewportSize({ width: 720, height: 480 });
      await wake();
      await check('minimum player window');
      assert.ok(
        await page.locator('.video-toolbar button').evaluateAll(buttons =>
          buttons.every(button => {
            const r = button.getBoundingClientRect();

            return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
          })
        ),
        'Toolbar clipped in minimum window'
      );
      await capture('player-minimum');
      await wake();
      await page.getByRole('button', { name: 'Серии', exact: true }).click();
      await page.locator('.episode-card:visible').filter({ hasText: 'Серия 1' }).first().waitFor();
      await page.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
      await page.locator('.sidebar-presence').waitFor({ state: 'detached' });
      await wake();
      await page.getByRole('button', { name: 'Об аниме', exact: true }).click();
      await transition();
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.desktopFullscreen),
        'true',
        'Leaving playback left app fullscreen'
      );
      await page.setViewportSize({ width: 1280, height: 820 });
      await nav('Твой профиль');
      await page.getByRole('link', { name: 'Всё избранное' }).click();
      await page.locator('a[data-app-href^="#/anime/1486"]:visible').first().waitFor();
      await check('guest favorites');
      await nav('Настройки');
      await page.getByRole('heading', { name: 'Настройки', exact: true }).waitFor();
      await check('settings');
      await capture('settings');
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.desktopFullscreen),
        'true',
        'Menu left app fullscreen'
      );
      await page.keyboard.press('f');
      await page.waitForFunction(
        () => document.documentElement.dataset.desktopFullscreen === 'false'
      );
      console.log(engine.name(), 'global fullscreen, Escape, text input and route persistence OK');
      if (process.env.APP_FULLSCREEN_ONLY === '1') continue;
      await nav('Расписание');
      await page.locator('.schedule-days').waitFor();
      await check('schedule');
      await page.evaluate(() => {
        location.hash = '/anime/610';
      });
      await transition();
      await playFirstEpisode('Дубляж AniLibria');
      await transition();
      await decoded();
      await check('Code Geass AniLibria dub');
      await wake();
      await page.getByRole('button', { name: 'Серии', exact: true }).click();
      await page.getByRole('button', { name: 'Серия 2', exact: true }).click();
      await decoded();
      await page.waitForFunction(() =>
        document.querySelector('.video-heading strong')?.textContent.includes('серия 2')
      );
      await check('next episode');
      await wake();
      await page.getByRole('button', { name: /^Озвучка:/ }).click();
      await page
        .getByRole('dialog', { name: 'Озвучка' })
        .getByRole('button', { name: /^Озвучка AniLibria \d/ })
        .click();
      await decoded();
      await check('switch dub to voice-over');
      await wake();
      await page.getByRole('button', { name: 'Настройки плеера', exact: true }).click();

      const qualityPicker = page.getByRole('combobox', { name: 'Качество видео' });
      await qualityPicker.click();
      const qualities = await page
        .getByRole('listbox', { name: 'Качество видео' })
        .getByRole('option')
        .evaluateAll(items => items.filter(item => !item.disabled).map(item => Number(item.value)));
      const quality = qualities.filter(q => q > 360 && q <= 720).at(-1);

      if (quality) {
        const height = await page.locator('video[data-active=true]').evaluate(v => v.videoHeight);

        await page.getByRole('option', { name: `${quality}p`, exact: true }).click();
        await page.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
        await page.waitForFunction(
          height => {
            const v = document.querySelector('video[data-active=true]');

            return !document.querySelector('.video-quality-switch') && v.videoHeight > height;
          },
          height,
          { timeout: 30000 }
        );
      } else await page.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
      await check('quality through application settings');
      await capture('series-player');
      if (cacheMode) {
        // Show a warm card before a deliberately held fresh response arrives.
        refreshRevision = 1;
        holdRefresh = true;
        await page.evaluate(() => {
          location.hash = '/anime/1486';
        });
        await transition();
        await page.locator('.full-synopsis').waitFor();
        assert.ok(
          !(await page.locator('.full-synopsis').innerText()).includes('CACHE_REFRESH_VERIFIED'),
          'Warm data was not shown first'
        );
        await aboutVoice('2x2').waitFor();

        const deadline = Date.now() + 15000;

        while (!releaseRefresh && Date.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(releaseRefresh, 'Background metadata refresh did not start');
        holdRefresh = false;
        releaseRefresh();
        await page.waitForFunction(() =>
          document.querySelector('.full-synopsis')?.textContent.includes('CACHE_REFRESH_VERIFIED')
        );
        console.log(engine.name(), 'cached card replaced by fresh metadata OK');
        await cachedScreenshots();
        await page.waitForFunction(() => {
          const image = document.querySelector('.watch-poster img');

          return image?.src.startsWith('blob:') && image.naturalWidth > 0;
        });
        networkBlocked = true;
        await page.route('https://static.yani.tv/**', route => route.abort());
        await page.route('https://i.kodikres.com/**', route => route.abort());
        await page.reload();
        await page.waitForFunction(() =>
          document.querySelector('.full-synopsis')?.textContent.includes('CACHE_REFRESH_VERIFIED')
        );
        await aboutVoice('2x2').waitFor();
        await page.waitForFunction(() => {
          const image = document.querySelector('.watch-poster img');

          return image?.src.startsWith('blob:') && image.naturalWidth > 0;
        });
        assert.equal(
          await page.locator('.detail-loading').count(),
          0,
          'Reload showed a detail skeleton instead of saved data'
        );
        await cachedScreenshots();
        await page.getByRole('button', { name: 'Серии', exact: true }).click();
        await page
          .locator('.episode-card:visible')
          .filter({ hasText: 'Серия 1' })
          .first()
          .waitFor();
        await check('offline restart: description, translations, episodes and full screenshot');
        await capture('offline-cache');
      }
      console.log(engine.name(), 'full application flow passed');
    } catch (error) {
      if (page) {
        console.error(
          (
            await page
              .locator('body')
              .innerText()
              .catch(() => '')
          ).slice(0, 3500)
        );
        console.error('JS errors:', errors);
        console.error(
          'Images:',
          await page
            .locator('.watch-poster img,.screenshot-full')
            .evaluateAll(images =>
              images.map(image => ({ src: image.src, width: image.naturalWidth }))
            )
        );
        await page.screenshot({ path: `${output}/${engine.name()}-failure.png` }).catch(() => {});
      }
      throw error;
    } finally {
      await browser.close();
    }
  }
} finally {
  probe.stdin.end();
  probe.kill();
  lines.close();
}
