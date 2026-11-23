import { sourceAlias } from '../shared/paths.mjs';
import { build } from 'vite';
import preact from '@preact/preset-vite';
import { webkit, chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const output = await build({
  configFile: false,
  resolve: { alias: sourceAlias },
  plugins: [preact()],
  logLevel: 'error',
  build: {
    write: false,
    lib: { entry: 'scripts/keyboard-probe.tsx', formats: ['iife'], name: 'KeyboardProbe' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const bundle = (Array.isArray(output) ? output[0] : output).output.find(
  chunk => chunk.type === 'chunk'
).code;
const styles = await Promise.all(
  [
    'styles.css',
    'yummy.css',
    'mobile.css',
    'gallery.css',
    'media-center.css',
    'desktop.css',
    'interaction.css',
    'touch.css',
    'tv.css',
  ].map(name => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8'))
);

const focusedCardRing = () => {
  const image = document.activeElement.closest('[data-gallery-item]')?.querySelector('.card-image');
  if (!image) return null;
  const { borderTopWidth, borderTopStyle, borderTopColor } = getComputedStyle(image, '::before');
  return [borderTopWidth, borderTopStyle, borderTopColor];
};

const cardRing = ['2px', 'solid', 'rgb(255, 205, 189)'];

await mkdir('/private/tmp/yumiwatch-keyboard-qa', { recursive: true });
for (const engine of [webkit, chromium]) {
  const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {});

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } }),
      errors = [];

    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://keyboard.test/**', async route => {
      const url = new URL(route.request().url());
      const name = url.pathname.slice(1);

      if (name.endsWith('.woff2'))
        return route.fulfill({
          body: await readFile(new URL(`../public/${name}`, import.meta.url)),
          contentType: 'font/woff2',
        });
      if (name) return route.abort();

      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html ${url.searchParams.has('tv') ? 'data-tv="true" data-mobile="android"' : 'data-desktop="macos"'}><body><div id="app"></div></body></html>`,
      });
    });
    await page.goto('https://keyboard.test/#/');
    for (const content of styles) await page.addStyleTag({ content });
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => document.fonts.ready);

    const brandFits = async () =>
      assert.ok(
        await page.locator('.media-nav .media-brand').evaluate(node => {
          const label = node.querySelector(':scope>span'),
            range = document.createRange();

          range.selectNodeContents(label);

          return (
            label.textContent.startsWith('YummyWatch') &&
            range.getBoundingClientRect().right <=
              node.closest('.media-nav').getBoundingClientRect().right - 4
          );
        }),
        'YummyWatch wordmark is clipped'
      );

    await page.getByRole('link', { name: 'YummyWatch — каталог', exact: true }).waitFor();
    await brandFits();
    await page.locator('.media-nav').getByRole('link', { name: 'Каталог', exact: true }).focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Все аниме');
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.activeElement).backgroundColor),
      'rgb(74, 53, 54)'
    );
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () =>
        location.hash === '#/catalog' &&
        document.querySelector('[data-route="/catalog"]:not([hidden])') &&
        !document.documentElement.dataset.pageTransition &&
        !document.documentElement.dataset.pageFallback
    );
    await page.locator('#main').focus();
    await page.keyboard.press('ArrowDown');
    assert.ok(
      await page.evaluate(
        () =>
          document.activeElement.matches('[data-gallery-link]') &&
          !document.activeElement.closest('[hidden]')
      ),
      'Arrow focused a retained hidden route'
    );

    const visibleCard = async () => {
      try {
        await page.waitForFunction(
          () => {
            const node = document.activeElement,
              card = node.closest('[data-gallery-item]');

            if (!card) return false;

            const r = card.getBoundingClientRect(),
              rail = card.closest('.gallery-rail').getBoundingClientRect(),
              main = document.getElementById('main').getBoundingClientRect();

            return (
              r.top >= Math.max(main.top + 56, 0) - 1 &&
              r.bottom <= Math.min(main.bottom, innerHeight) - 8 &&
              r.left >= rail.left + 2 &&
              r.right <= rail.right - 2
            );
          },
          undefined,
          { timeout: 6000 }
        );
      } catch (error) {
        const focused = await page.evaluate(() => {
          const active = document.activeElement,
            card = active.closest('[data-gallery-item]'),
            rail = card?.closest('.gallery-rail'),
            main = document.getElementById('main');

          return {
            label: active.textContent.trim().slice(0, 80),
            card: card?.getBoundingClientRect().toJSON(),
            rail: rail?.getBoundingClientRect().toJSON(),
            main: main.getBoundingClientRect().toJSON(),
            scrollTop: main.scrollTop,
          };
        });
        throw new Error(`The focused card is not fully visible: ${JSON.stringify(focused)}`, {
          cause: error,
        });
      }
    };

    await visibleCard();
    for (let index = 0; index < 9; index++) {
      await page.keyboard.press('ArrowRight');
      if (process.env.KEYBOARD_TRACE === '1')
        console.log(
          engine.name(),
          'arrow',
          index,
          await page.evaluate(() => ({
            focus: document.activeElement.outerHTML,
            main: document.getElementById('main').scrollTop,
            rails: [...document.querySelectorAll('section:not([hidden]) .gallery-rail')].map(
              n => n.scrollLeft
            ),
          }))
        );
    }
    assert.equal(await page.evaluate(() => document.activeElement.dataset.index), '9');
    await visibleCard();
    assert.deepEqual(await page.evaluate(focusedCardRing), cardRing);
    for (const shelf of ['Ряд 1', 'Ряд 2']) {
      const all = page.getByRole('region', { name: shelf, exact: true }).getByRole('link', {
        name: 'Все',
        exact: true,
      });
      const actionPositions = () =>
        all.evaluate(link => {
          const actions = link.parentElement;
          const { left, top } = actions.getBoundingClientRect();
          const label = document.createRange();
          label.selectNodeContents(link.firstChild);
          return [label, link.querySelector('svg'), ...actions.children].map(node => {
            const rect = node.getBoundingClientRect();
            return [rect.left - left, rect.top - top, rect.width, rect.height];
          });
        });
      const beforeFocus = await actionPositions();
      await page.keyboard.press('ArrowDown');
      assert.equal(
        await page.evaluate(() =>
          document.activeElement
            .closest('.gallery-shelf-actions')
            ?.closest('.gallery-shelf')
            .getAttribute('aria-label')
        ),
        shelf
      );
      assert.equal(await all.evaluate(link => getComputedStyle(link).outlineOffset), '5px');
      assert.deepEqual(await actionPositions(), beforeFocus);
      await page.keyboard.press('ArrowDown');
      await visibleCard();
      assert.equal(
        await page.evaluate(() =>
          document.activeElement.closest('.gallery-shelf').getAttribute('aria-label')
        ),
        shelf
      );
    }
    assert.equal(await page.evaluate(() => scrollY), 0);
    await page.screenshot({ path: `/private/tmp/yumiwatch-keyboard-qa/${engine.name()}-card.png` });
    await page.setViewportSize({ width: 1100, height: 480 });
    await visibleCard();
    await page.setViewportSize({ width: 1280, height: 720 });
    await visibleCard();

    const destination = await page.evaluate(
      () =>
        document.activeElement.getAttribute('data-app-href') ||
        document.activeElement.getAttribute('href')
    );

    const poster = page.locator('[data-route]:not([hidden]) article').filter({
      has: page.locator(`.card-title[data-app-href="${destination}"]`),
    });
    await page.mouse.move(800, 40);
    await page.waitForFunction(
      () =>
        document.documentElement.dataset.inputMode === 'pointer' &&
        !document.activeElement.matches('[data-gallery-link]')
    );
    assert.equal(
      await poster
        .locator('.card-image')
        .evaluate(node => getComputedStyle(node, '::before').borderTopStyle),
      'none'
    );
    await page.keyboard.press('ArrowDown');
    await visibleCard();
    assert.deepEqual(await page.evaluate(focusedCardRing), cardRing);
    assert.equal(
      await page.evaluate(() => document.activeElement.getAttribute('data-app-href')),
      destination
    );
    await page.keyboard.press('Enter');
    await page.waitForFunction(hash => location.hash === hash, destination);
    console.log(
      engine.name(),
      'menu arrows, Enter, retained routes, whole cards and nested rails OK'
    );

    await page.evaluate(() => {
      location.hash = '/catalog';
    });
    await page.waitForFunction(
      () =>
        document.querySelector('[data-route="/catalog"]:not([hidden])') &&
        !document.documentElement.dataset.pageTransition &&
        !document.documentElement.dataset.pageFallback
    );

    const select = async selector => {
      const node = page.locator(`section:not([hidden]) ${selector}`).first();

      await node.scrollIntoViewIfNeeded();
      await page.evaluate(() => getSelection().removeAllRanges());

      const r = await node.evaluate(element => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let text;

        while ((text = walker.nextNode())) {
          if (!text.textContent.trim()) continue;

          const range = document.createRange();

          range.selectNodeContents(text);

          const rect = [...range.getClientRects()].find(rect => rect.width > 10 && rect.height > 0);

          if (rect) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }

        throw new Error('Selection target has no visible text');
      });

      await page.mouse.move(r.x + 5, r.y + r.height / 2);
      await page.mouse.down();
      await page.mouse.move(r.x + Math.min(r.width - 5, 220), r.y + r.height / 2, { steps: 16 });
      await page.mouse.up();

      return page.evaluate(() => getSelection().toString());
    };

    assert.equal(await select('.gallery-heading h1'), '', 'Interface label can be selected');
    assert.ok((await select('.gallery-feature-copy h2')).length > 0, 'Title cannot be selected');
    assert.ok(
      (await select('.gallery-feature-description')).length > 0,
      'Description cannot be selected'
    );
    assert.ok((await select('.comment-text span')).length > 0, 'Comment cannot be selected');
    assert.equal(
      await page
        .locator('section:not([hidden]) .inline-spoiler')
        .evaluate(node => getComputedStyle(node).userSelect),
      'none'
    );
    const featureTitle = page.locator('section:not([hidden]) .gallery-feature-copy h2').first();
    await featureTitle.scrollIntoViewIfNeeded();
    const featureWordPosition = await featureTitle.evaluate(node => {
      const range = document.createRange();
      range.setStart(node.firstChild, 0);
      range.setEnd(node.firstChild, 8);
      const text = range.getBoundingClientRect(),
        box = node.getBoundingClientRect();
      return { x: text.x + text.width / 2 - box.x, y: text.y + text.height / 2 - box.y };
    });
    await featureTitle.dblclick({ position: featureWordPosition });
    assert.ok(
      (await page.evaluate(() => getSelection().toString())).length > 0,
      'Double click does not select a word'
    );
    await page.keyboard.press('ControlOrMeta+A');
    assert.equal(
      await page.evaluate(() => getSelection().toString()),
      'Название информационного произведения'
    );
    const titleLink = page.locator('.card-title:visible').first();
    await page.evaluate(() => getSelection().removeAllRanges());
    const beforeTitleClick = await page.evaluate(() => location.hash);
    const wordPosition = await titleLink.evaluate(node => {
      const range = document.createRange();
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let textNode;
      while ((textNode = walker.nextNode())) {
        if (textNode.textContent.includes('Аниме')) break;
      }
      const start = textNode.textContent.indexOf('Аниме');
      range.setStart(textNode, start);
      range.setEnd(textNode, start + 5);
      const text = range.getBoundingClientRect(),
        link = node.getBoundingClientRect();
      return { x: text.x + text.width / 2 - link.x, y: text.y + text.height / 2 - link.y };
    });
    await titleLink.scrollIntoViewIfNeeded();
    await titleLink.dblclick({ position: wordPosition });
    await page.waitForTimeout(500);
    assert.equal(
      await page.evaluate(() => location.hash),
      beforeTitleClick,
      'Double click navigates away from the title'
    );
    const wordSelection = await page.evaluate(() => getSelection().toString());
    assert.ok(wordSelection.length > 0, 'Title word cannot be selected');
    assert.equal(await titleLink.evaluate(node => node.draggable), true);
    assert.ok((await titleLink.getAttribute('href')).startsWith('https://ru.yummyani.me/'));
    await page.evaluate(() => {
      getSelection().removeAllRanges();
      window.contentDrag = null;
      document.addEventListener(
        'dragstart',
        event => {
          window.contentDrag = {
            blocked: event.defaultPrevented,
            url: event.dataTransfer.getData('text/uri-list').trim(),
          };
        },
        { once: true }
      );
    });
    const dragBox = await titleLink.boundingBox();
    await page.mouse.move(dragBox.x + wordPosition.x, dragBox.y + wordPosition.y);
    await page.mouse.down();
    await page.mouse.move(dragBox.x + wordPosition.x + 80, dragBox.y + wordPosition.y - 50, {
      steps: 12,
    });
    await page.mouse.up();
    const drag = await page.evaluate(() => window.contentDrag);
    assert.ok(drag && !drag.blocked, 'Content link cannot be dragged');
    assert.equal(
      drag.url,
      await titleLink.getAttribute('href'),
      'Dragging exposes an internal route'
    );
    assert.equal(
      await page
        .locator('.media-nav .media-navigation a')
        .first()
        .evaluate(node => node.draggable),
      false
    );
    console.log(
      engine.name(),
      'native word selection, Cmd+A, public content URLs and menu drag policy OK'
    );

    await page.setViewportSize({ width: 900, height: 480 });
    await brandFits();
    await page.locator('.media-nav').getByRole('link', { name: 'Каталог', exact: true }).focus();

    const mainBefore = await page.locator('#main').evaluate(node => node.scrollTop);

    for (let index = 0; index < 8; index++) await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => {
      const n = document.activeElement,
        r = n.getBoundingClientRect();

      return n.matches('.media-account') && r.top >= 56 && r.bottom <= innerHeight - 8;
    });
    assert.equal(
      await page.locator('#main').evaluate(node => node.scrollTop),
      mainBefore,
      'Menu focus scrolled content'
    );
    await page.getByRole('button', { name: 'Открыть серии', exact: true }).click();
    await page.getByRole('button', { name: 'Закрыть панель', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.inputMode), 'pointer');
    assert.equal(
      await page.evaluate(() => document.activeElement.matches('.sidebar-close')),
      false
    );
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.activeElement.textContent.trim() === 'Серия 1');
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.activeElement).outlineColor),
      cardRing[2]
    );

    const navBefore = await page.locator('.media-nav').evaluate(node => node.scrollTop);

    for (let index = 0; index < 18; index++) await page.keyboard.press('Tab');
    await page.waitForFunction(() => {
      const n = document.activeElement,
        r = n.getBoundingClientRect(),
        panel = document.querySelector('.sidebar-scroll').getBoundingClientRect();

      return (
        n.textContent.startsWith('Серия ') && r.top >= panel.top + 8 && r.bottom <= panel.bottom - 8
      );
    });
    assert.equal(
      await page.locator('.media-nav').evaluate(node => node.scrollTop),
      navBefore,
      'Sidebar focus scrolled navigation'
    );
    assert.equal(await page.evaluate(() => scrollY), 0);
    await page.screenshot({
      path: `/private/tmp/yumiwatch-keyboard-qa/${engine.name()}-sidebar.png`,
    });
    assert.deepEqual(errors, []);
    console.log(engine.name(), 'short menu, Tab, sidebar visibility and stationary root OK');

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('https://keyboard.test/?tv=1#/');
    for (const content of styles) await page.addStyleTag({ content });
    await page.addScriptTag({ content: bundle });
    const focused = () => page.evaluate(() => document.activeElement.textContent.trim());
    await page.waitForFunction(() => document.activeElement.matches('[data-gallery-link]'));
    assert.deepEqual(await page.evaluate(focusedCardRing), cardRing);
    const homeCard = await focused();
    await page.keyboard.press('ArrowRight');
    assert.equal(await focused(), '/ · Аниме 1');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await focused(), homeCard);
    await page.keyboard.press('ArrowLeft');
    assert.equal(await focused(), 'Каталог');
    await page.keyboard.press('ArrowRight');
    assert.equal(await focused(), homeCard);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowDown');
    assert.equal(await focused(), 'Все аниме');
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => location.hash === '#/catalog' && document.activeElement.matches('[data-gallery-link]')
    );
    const opener = page.getByRole('button', { name: 'Открыть серии', exact: true });
    await opener.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement.textContent.trim() === 'Серия 1');
    for (let index = 0; index < 16; index++) await page.keyboard.press('ArrowDown');
    assert.equal(await focused(), 'Серия 17');
    await page.waitForFunction(() => {
      const control = document.activeElement.getBoundingClientRect();
      const scroll = document.querySelector('.sidebar-scroll').getBoundingClientRect();
      return control.top >= scroll.top + 39 && control.bottom <= scroll.bottom - 39;
    });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement.textContent.trim() === 'Открыть серии');
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => location.hash === '#/' && document.activeElement.matches('[data-gallery-link]')
    );
    assert.equal(await focused(), homeCard);
    assert.equal(await page.evaluate(() => scrollY), 0);
    assert.deepEqual(errors, []);
    console.log(engine.name(), 'TV arrows, sidebar confinement and focus restoration OK');
  } finally {
    await browser.close();
  }
}
