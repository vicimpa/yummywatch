// Production UI and the real socket client against synthetic API/socket peers. No account writes.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';

const output = '/private/tmp/yumiwatch-social-qa';
await mkdir(output, { recursive: true });

for (const engine of [chromium, webkit]) {
  const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let socket;
    const commands = [];
    const writes = [];
    let subscribed = false;
    let profileOffline = false;
    let messagesOffline = false;
    let notifications = [
      {
        id: 1,
        date: 1794873600,
        title_html: 'Заявка в друзья',
        text_html: '<b>Друг</b> хочет добавить тебя',
        type: 'friend',
        viewed: false,
        click_uri: '/users/id8',
      },
    ];
    let messages = [
      {
        id: 1,
        date: 1794873600,
        from_id: 8,
        to_id: 42,
        nickname: 'Друг',
        text: 'Будем смотреть?',
        read: true,
        edited: 0,
      },
    ];
    const anime = {
      anime_id: 9,
      anime_url: 'test-anime',
      title: 'Проверочная история',
      description: 'Тест подписок на новые серии',
      year: 2026,
      episodes: { aired: 1, count: 12 },
      anime_status: { title: 'Онгоинг', alias: 'ongoing' },
    };
    await page.routeWebSocket(/wss:\/\/socket[123]\.(?:yani\.tv|yummyani\.me)\/socket/, ws => {
      if (new URL(ws.url()).searchParams.has('token')) socket = ws;
      ws.onMessage(message => {
        const value = JSON.parse(String(message));
        commands.push(value);
        if (value.event === 'ping') ws.send(JSON.stringify({ event: 'pong' }));
      });
    });
    await page.route('https://social.test/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/sw.js') return route.abort();
      const file = resolve('dist', path === '/' ? 'index.html' : path.slice(1));
      const types = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2',
        '.webmanifest': 'application/manifest+json',
      };
      try {
        await route.fulfill({
          body: await readFile(file),
          contentType: types[extname(file)] || 'application/octet-stream',
        });
      } catch {
        await route.fulfill({ status: 404, body: '' });
      }
    });
    await page.route(/^https:\/\/(?:api\.yani\.tv|(?:old|ru)\.yummyani\.me)\//, async route => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname.replace(/^\/api\//, '/');
      const method = request.method();
      const headers = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
        'access-control-allow-headers': '*',
      };
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers });
      let response = [];
      if (messagesOffline && path === '/dialogs/8/messages' && method === 'GET') {
        return route.fulfill({
          status: 503,
          headers,
          contentType: 'application/json',
          body: JSON.stringify({ error: true }),
        });
      }
      if (profileOffline && ['/users/id8', '/users/8/lists'].includes(path)) {
        return route.fulfill({
          status: 503,
          headers,
          contentType: 'application/json',
          body: JSON.stringify({ error: true }),
        });
      }
      if (method !== 'GET') writes.push({ path, method, body: request.postDataJSON() });
      if (path === '/profile')
        response = {
          id: 42,
          nickname: 'Зритель',
          lists_privacy: 'public',
          notifications: { count: notifications.filter(n => !n.viewed).length },
          messages: { unread_count: 0 },
        };
      else if (path === '/profile/notifications') response = notifications;
      else if (/^\/profile\/notifications\/\d+\/read$/.test(path)) {
        notifications = notifications.map(n =>
          n.id === Number(path.split('/')[3]) ? { ...n, viewed: true } : n
        );
        response = true;
      } else if (path === '/profile/notifications/read') {
        notifications = notifications.map(n => ({ ...n, viewed: true }));
        response = true;
      } else if (path === '/dialogs')
        response = {
          dialogs: [
            {
              user_id: 8,
              nickname: 'Друг',
              last_message: messages.at(-1).text,
              date: 1794873600,
              unread_count: 0,
            },
          ],
        };
      else if (path === '/dialogs/8/messages') {
        if (method === 'POST') {
          const value = {
            id: messages.length + 1,
            from_id: 42,
            to_id: 8,
            nickname: 'Зритель',
            text: request.postDataJSON().message,
            date: 1794873700,
            read: false,
            edited: 0,
          };
          messages.push(value);
          response = value;
        } else response = messages;
      } else if (path === '/dialogs/8/messages/read') {
        const changed = messages.some(message => message.from_id === 8 && !message.read);
        messages = messages.map(message =>
          message.from_id === 8 ? { ...message, read: true } : message
        );
        response = { ok: changed };
      } else if (path === '/users/42/friends')
        response = [{ id: 8, nickname: 'Друг', last_online: 1 }];
      else if (path === '/users/8/lists') response = [anime];
      else if (path === '/users/42/lists/subs')
        response = subscribed
          ? [{ ...anime, sub: { player_id: 1, player: 'Kodik', dubbing: 'Тестовая озвучка' } }]
          : [];
      else if (path === '/users/id42' || path === '/users/id8')
        response = {
          id: path.endsWith('42') ? 42 : 8,
          nickname: path.endsWith('42') ? 'Зритель' : 'Друг',
          friends: { friends: 1 },
        };
      else if (path === '/users/42/friends/8') response = { status: 'friends' };
      else if (path === '/anime/9') response = anime;
      else if (path === '/anime/9/videos')
        response = [
          {
            video_id: 101,
            number: '1',
            index: 0,
            iframe_url: 'https://kodik.info/test',
            data: { player_id: 1, player: 'Kodik', dubbing: 'Тестовая озвучка' },
          },
        ];
      else if (path === '/video/101/subscribe') {
        subscribed = method === 'PUT';
        response = true;
      } else if (path === '/profile/logout') response = true;
      await route.fulfill({
        headers,
        contentType: 'application/json',
        body: JSON.stringify({ response }),
      });
    });
    await page.addInitScript(() => {
      localStorage.setItem(
        'yumiwatch:session:v1',
        JSON.stringify({
          token: 'synthetic-social-token',
          user: { id: 42, nickname: 'Зритель' },
          remember: true,
          refreshedAt: Date.now(),
        })
      );
      localStorage.setItem(
        'yumiwatch:interface-settings',
        JSON.stringify({ sounds: false, animations: false })
      );
    });
    await page.goto('https://social.test/#/notifications');
    await page.getByRole('heading', { name: 'Уведомления', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Заявка в друзья' }).waitFor();
    await page.locator('#main').focus();
    await page.keyboard.press('ControlOrMeta+A');
    assert.equal(
      await page.evaluate(() => getSelection()?.toString()),
      '',
      'Select All cannot select the app window'
    );
    assert(socket, 'Authenticated socket is established');
    assert(commands.some(c => c.event === 'subscribe-events'));
    assert(
      commands.some(
        c => c.event === 'subscribe-global' && c.objectType === 'user' && c.objectId === 8
      )
    );
    notifications.unshift({
      id: 2,
      date: 1794873650,
      type: 'anime_episode',
      viewed: false,
      title_html: '<b>Новая серия</b>',
      text_html: 'Вышла следующая серия',
      click_uri: '/catalog/item/test-anime',
    });
    socket.send(JSON.stringify({ event: 'notification', message: notifications[0] }));
    socket.send(JSON.stringify({ event: 'notification', message: notifications[0] }));
    await page.getByRole('heading', { name: 'Новая серия', exact: true }).waitFor();
    assert.equal(
      await page.locator('.notification-card').count(),
      2,
      'Duplicate socket delivery does not duplicate the card'
    );
    await page.getByRole('button', { name: 'Скрыть уведомление', exact: true }).click();
    await page.screenshot({ path: `${output}/${engine.name()}-notifications.png` });
    await page.getByRole('button', { name: 'Прочитать все', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.notification-card.is-unread'));
    assert(writes.some(w => w.path === '/profile/notifications/read'));

    await page.evaluate(() => {
      location.hash = '/messages?user=8';
    });
    await page.getByText('Будем смотреть?', { exact: true }).last().waitFor();
    await page.getByLabel('Текст сообщения').fill('Да, давай!');
    await page.getByLabel('Текст сообщения').press('ControlOrMeta+A');
    assert(
      await page
        .getByLabel('Текст сообщения')
        .evaluate(input => input.selectionStart === 0 && input.selectionEnd === input.value.length),
      'Select All still works in the composer'
    );
    assert.equal(
      await page.getByRole('alert').count(),
      0,
      'Successful read confirmation must not show an error'
    );
    await page.getByRole('button', { name: 'Отправить', exact: true }).click();
    await page.locator('.message-bubble').filter({ hasText: 'Да, давай!' }).waitFor();
    assert(writes.some(w => w.path === '/dialogs/8/messages' && w.body.message === 'Да, давай!'));
    // Read receipts must not move the timestamp, text or right-aligned bubble.
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 820 });
      await page.evaluate(() => document.fonts.ready);
      const own = page.locator('.message-bubble.is-own').last();
      messages[messages.length - 1] = { ...messages.at(-1), read: false };
      socket.send(JSON.stringify({ event: 'message-edited', message: messages.at(-1) }));
      await own.getByText('· отправлено', { exact: true }).waitFor();
      const geometry = () =>
        own.evaluate(node =>
          [node, node.querySelector('p'), node.querySelector('time')].map(element => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x, y, width, height };
          })
        );
      const before = await geometry();
      const date = await own.locator('time').innerText();
      assert.deepEqual(
        await own.locator('.message-meta').evaluate(meta =>
          [...meta.childNodes]
            .filter(node => node.nodeType === Node.TEXT_NODE)
            .map(node => node.textContent.trim())
            .filter(Boolean)
        ),
        [],
        'Numeric API flags must not become timestamp text'
      );

      messages[messages.length - 1] = { ...messages.at(-1), read: true };
      socket.send(JSON.stringify({ event: 'message-read', user_id: 8 }));
      await own.getByText('· прочитано', { exact: true }).waitFor();
      assert.deepEqual(await geometry(), before, `${width}px: read receipt moved the message/date`);
      assert.equal(await own.locator('time').innerText(), date);
      console.log(
        `${engine.name()}/${width}: read receipt leaves message, timestamp and bubble fixed`
      );
    }
    await page.setViewportSize({ width: 1280, height: 820 });

    socket.send(
      JSON.stringify({
        event: 'new-message',
        message: {
          id: 3,
          date: 1794873800,
          from_id: 8,
          to_id: 42,
          nickname: 'Друг',
          text: 'Отлично!',
          read: false,
        },
      })
    );
    await page.locator('.message-bubble').filter({ hasText: 'Отлично!' }).waitFor();
    messages[0] = { ...messages[0], text: 'Уточнили время просмотра', edited: true };
    await page.getByRole('button', { name: 'Обновить переписку', exact: true }).click();
    await page.locator('.message-bubble').filter({ hasText: 'Уточнили время просмотра' }).waitFor();
    await page.screenshot({ path: `${output}/${engine.name()}-messages.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.phone-nav').waitFor({ state: 'visible' });
    assert.equal(
      await page.locator('.phone-header').count(),
      1,
      'One header after switching to phone navigation'
    );
    await page.screenshot({ path: `${output}/${engine.name()}-phone-messages.png` });
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'Messages fit the phone viewport'
    );
    const composer = await page.locator('.message-composer').boundingBox();
    const bottomNav = await page.locator('.phone-nav').boundingBox();
    assert(
      composer.y + composer.height <= bottomNav.y + 1,
      'Composer stays above application navigation'
    );
    socket.send(
      JSON.stringify({
        event: 'new-message',
        message: {
          id: 4,
          date: 1794873900,
          from_id: 8,
          to_id: 42,
          nickname: 'Друг',
          text: 'Длинное сообщение '.repeat(250),
          read: false,
        },
      })
    );
    await page.waitForFunction(() => {
      const list = document.querySelector('.conversation-scroll');
      return list && list.scrollHeight > list.clientHeight;
    });
    const after = await page.locator('.message-composer').boundingBox();
    assert(Math.abs(after.y - composer.y) < 1, 'Long messages do not move the composer');

    await page.getByLabel('Текст сообщения').fill('Сохранённый черновик');
    const readingTop = await page.evaluate(async () => {
      const list = document.querySelector('.conversation-scroll');
      list.scrollTop = 140;
      await new Promise(resolve => requestAnimationFrame(resolve));
      return list.scrollTop;
    });
    await page.evaluate(() => {
      location.hash = '/messages';
    });
    await page.getByLabel('Найти диалог').waitFor();
    messagesOffline = true;
    await page.evaluate(() => {
      window.chatLoadFrames = [];
      const sample = () => {
        const list = document.querySelector('.conversation-scroll');
        if (list)
          window.chatLoadFrames.push({
            top: list.scrollTop,
            count: list.querySelectorAll('.message-bubble').length,
            posters: list.querySelectorAll('.skeleton,.anime-grid').length,
          });
        if (window.chatLoadFrames.length < 6) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      location.hash = '/messages?user=8';
    });
    await page.locator('[data-message-id="4"]').waitFor({ state: 'attached' });
    await page.waitForFunction(() => window.chatLoadFrames.length >= 6);
    const frames = await page.evaluate(() => window.chatLoadFrames);
    assert(
      frames.every(frame => frame.count >= 4 && frame.posters === 0),
      'Cached chat has no empty/poster loading frames'
    );
    assert(
      frames.every(frame => Math.abs(frame.top - readingTop) < 2),
      'Reading position is restored before paint and remains stable'
    );
    assert.equal(await page.getByLabel('Текст сообщения').inputValue(), 'Сохранённый черновик');
    await page.getByRole('alert').waitFor();
    socket = undefined;
    await page.reload();
    await page.locator('[data-message-id="4"]').waitFor({ state: 'attached' });
    assert.equal(
      await page.getByLabel('Текст сообщения').inputValue(),
      'Сохранённый черновик',
      'Conversation and draft survive app restart with the messages API unavailable'
    );
    messagesOffline = false;

    await page.evaluate(() => {
      location.hash = '/profile?tab=friends';
    });
    await page.locator('.profile-person').filter({ hasText: 'Друг' }).waitFor();
    assert(socket, 'Authenticated socket reconnects after reload');
    await page.evaluate(
      () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    socket.send(
      JSON.stringify({
        event: 'update-user',
        object_id: 8,
        data: { last_online: Date.now() / 1000 },
      })
    );
    await page.getByText('Недавно в сети', { exact: true }).waitFor();
    await page.locator('.profile-person').filter({ hasText: 'Друг' }).click();
    await page.getByRole('link', { name: 'Открыть коллекцию', exact: true }).click();
    const collectionUrl = url => url.hash === '#/users/id8?tab=collection';
    await page.waitForURL(collectionUrl);
    const collectionTitle = page
      .locator('.profile-collection a[data-app-href^="#/anime/9?"]')
      .last();
    await collectionTitle.click();
    await page.waitForURL(url => url.hash.startsWith('#/anime/9'));
    await page.getByRole('heading', { name: 'Проверочная история', exact: true }).first().waitFor();
    profileOffline = true;
    await page.evaluate(() => history.back());
    await page.waitForURL(collectionUrl, { timeout: 5000 }).catch(error => {
      error.message += `\nAfter Back: ${page.url()}`;
      throw error;
    });
    await collectionTitle.waitFor();
    await page.getByText('Сохранённая версия от', { exact: false }).waitFor();
    await page.evaluate(() => history.forward());
    await page.waitForURL(url => url.hash.startsWith('#/anime/9'));
    profileOffline = false;
    await page.evaluate(() => {
      location.hash = '/anime/9';
    });
    await page.getByRole('heading', { name: 'Проверочная история', exact: true }).first().waitFor();
    const subscribe = page.getByRole('button', {
      name: 'Подписаться на новые серии: Тестовая озвучка, Kodik',
      exact: true,
    });
    await subscribe.click();
    await page
      .getByRole('button', {
        name: 'Отписаться от новых серий: Тестовая озвучка, Kodik',
        exact: true,
      })
      .waitFor();
    assert(subscribed);
    assert(writes.some(w => w.path === '/video/101/subscribe' && w.method === 'PUT'));
    await page.screenshot({ path: `${output}/${engine.name()}-phone-subscription.png` });
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(
      `${engine.name()}: notifications, messages, live presence, episode subscriptions and phone layout passed`
    );
  } finally {
    await browser.close();
  }
}
console.log(`Screenshots: ${output}`);
