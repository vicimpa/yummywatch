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
    lib: { entry: 'scripts/virtual-probe.tsx', formats: ['iife'], name: 'VirtualProbe' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const bundle = (Array.isArray(output) ? output[0] : output).output.find(
  chunk => chunk.type === 'chunk'
).code;
const css = (
  await Promise.all(
    [
      'styles.css',
      'yummy.css',
      'mobile.css',
      'gallery.css',
      'media-center.css',
      'desktop.css',
      'interaction.css',
      'touch.css',
    ].map(name => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8'))
  )
).join('\n');

await mkdir('/private/tmp/yummywatch-virtual-qa', { recursive: true });
for (const engine of [webkit, chromium]) {
  const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {});

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } }),
      errors = [];

    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://virtual.test/**', route =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html data-desktop="macos"><body><div id="app"></div></body></html>',
      })
    );
    await page.goto('https://virtual.test/');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: bundle });
    await page.locator('[data-virtual-grid]').waitFor();
    await page.waitForTimeout(100);

    const bounded = async () =>
      assert.ok((await page.locator('.anime-card').count()) < 80, 'Too many cards mounted');

    await bounded();

    const first = page.locator('[data-virtual-index="0"] .card-title');

    await first.focus();
    await page.getByRole('tooltip').waitFor();
    assert.ok(
      await first.evaluate(node => node.scrollHeight > node.clientHeight + 1),
      'Long title was not clamped'
    );
    await page.screenshot({
      path: `/private/tmp/yummywatch-virtual-qa/${engine.name()}-title.png`,
    });
    await page.locator('#main').evaluate(node => {
      node.scrollTop = 50000;
    });
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.virtual-item')].some(
        node => Number(node.dataset.virtualIndex) > 100
      )
    );
    await bounded();
    assert.equal(
      await page.evaluate(
        () => document.activeElement.closest('[data-virtual-index]')?.dataset.virtualIndex
      ),
      '0',
      'Virtualization lost focused card'
    );
    await page.keyboard.press('End');

    const visible = async () => {
      try {
        await page.waitForFunction(
          () => {
            const node = document.activeElement.closest('[data-gallery-item]');

            if (!node) return false;

            const r = node.getBoundingClientRect();

            return r.top >= 55 && r.bottom <= innerHeight - 10;
          },
          null,
          { timeout: 15000 }
        );
      } catch (error) {
        const state = await page.evaluate(() => {
          const card = document.activeElement?.closest('[data-gallery-item]');
          const main = document.getElementById('main');
          return {
            focus: document.activeElement?.textContent?.slice(0, 80),
            index: card?.closest('[data-virtual-index]')?.getAttribute('data-virtual-index'),
            card: card?.getBoundingClientRect().toJSON(),
            main: main?.getBoundingClientRect().toJSON(),
            scrollTop: main?.scrollTop,
            scrollHeight: main?.scrollHeight,
          };
        });
        throw new Error(`Focused card is outside the viewport. ${JSON.stringify(state)}`, {
          cause: error,
        });
      }
    };

    await visible();
    assert.equal(
      await page.evaluate(
        () => document.activeElement.closest('[data-virtual-index]').dataset.virtualIndex
      ),
      '9999'
    );
    await bounded();
    await page.keyboard.press('ArrowRight');
    assert.equal(
      await page.evaluate(
        () => document.activeElement.closest('[data-virtual-index]').dataset.virtualIndex
      ),
      '9999'
    );
    await page.keyboard.press('Home');
    await visible();
    for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowDown');
    await visible();
    await bounded();
    assert.ok(
      Number(
        await page.evaluate(
          () => document.activeElement.closest('[data-virtual-index]').dataset.virtualIndex
        )
      ) >= 120,
      'Keyboard navigation stopped at an unmounted row'
    );
    await page.screenshot({
      path: `/private/tmp/yummywatch-virtual-qa/${engine.name()}-scrolled.png`,
    });
    await page.setViewportSize({ width: 900, height: 480 });
    await page.waitForTimeout(350);
    await bounded();
    await page.keyboard.press('Home');
    await visible();
    assert.equal(await page.evaluate(() => scrollY), 0);
    assert.deepEqual(errors, []);
    console.log(
      engine.name(),
      '10,000 items, bounded DOM, distant scroll, preserved focus, Home/End, arrows, tooltip and resize OK'
    );
  } finally {
    await browser.close();
  }
}
