import { build } from 'vite';
import preact from '@preact/preset-vite';
import { chromium, webkit } from 'playwright';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { sourceAlias } from '../shared/paths.mjs';

const result = await build({
  configFile: false,
  resolve: { alias: sourceAlias },
  plugins: [preact()],
  logLevel: 'error',
  build: {
    write: false,
    lib: { entry: 'scripts/player-controls-probe.tsx', formats: ['iife'], name: 'ControlsProbe' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const code = (Array.isArray(result) ? result[0] : result).output.find(
  item => item.type === 'chunk'
).code;
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.route('https://controls.test/**', route =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="app"></div>' })
    );
    await page.goto('https://controls.test');
    for (const file of ['styles.css', 'mobile.css', 'media-center.css', 'interaction.css'])
      await page.addStyleTag({
        content: await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'),
      });
    await page.addScriptTag({ content: code });
    const mute = page.getByRole('button', { name: 'Выключить звук', exact: true });
    await mute.waitFor();
    await page.evaluate(() => {
      const video = document.querySelector('video');
      video.dispatchEvent(new Event('play'));
      video.dispatchEvent(new Event('playing'));
    });
    await mute.click();
    await page.waitForTimeout(3200);
    assert(
      await page.locator('.video-controls.is-visible').count(),
      'The toolbar stays visible while the pointer is over a control'
    );
    await page.mouse.move(200, 100);
    await page.waitForSelector('.video-controls.is-hidden', { state: 'attached', timeout: 6000 });
    assert.equal(
      await page.evaluate(() => document.activeElement?.closest('.video-bottom') !== null),
      false,
      'Hidden controls release pointer focus'
    );
    await page.mouse.move(205, 104);
    await page.waitForSelector('.video-controls.is-visible', { state: 'attached' });
    await page.getByRole('button', { name: 'Настройки плеера', exact: true }).click();
    await page.waitForTimeout(3200);
    assert(
      await page.getByRole('dialog', { name: 'Настройки плеера' }).isVisible(),
      'Open settings keep controls visible'
    );
    await page.mouse.click(220, 120);
    await page.waitForSelector('.video-controls.is-hidden', { state: 'attached', timeout: 6000 });
    for (const key of ['ArrowUp', 'ArrowDown']) {
      await page.mouse.move(key === 'ArrowUp' ? 230 : 240, 130);
      await page.waitForSelector('.video-controls.is-visible', { state: 'attached' });
      const play = page.locator('.video-toolbar button').first();
      await play.waitFor({ state: 'visible' });
      await play.focus();
      await page.waitForFunction(() => !!document.activeElement?.closest('.video-toolbar'));
      await page.keyboard.press(key);
      assert(
        await page.evaluate(() => !!document.activeElement?.closest('.video-controls')),
        `${key} keeps focus in the player`
      );
      assert.equal(
        await page.evaluate(() => getComputedStyle(document.activeElement).outlineColor),
        'rgb(255, 205, 189)',
        `${key} shows the shared keyboard focus in the player`
      );
      await page.waitForSelector('.video-controls.is-hidden', { state: 'attached', timeout: 6000 });
      assert(
        await page.locator('.video-controls:focus').count(),
        'Idle focus returns to the player'
      );
      const before = await page.evaluate(() => document.querySelector('video').currentTime);
      await page.keyboard.press('ArrowRight');
      await page.waitForSelector('[data-tv-timeline]:focus', { state: 'attached', timeout: 2000 });
      await page.keyboard.press('ArrowRight');
      assert.equal(
        await page.evaluate(() => document.querySelector('video').currentTime),
        before + 20
      );
      await page.locator('.video-controls').focus();
      await page.keyboard.press('ArrowLeft');
      await page.waitForSelector('[data-tv-timeline]:focus', { state: 'attached', timeout: 2000 });
      assert.equal(
        await page.evaluate(() => document.querySelector('video').currentTime),
        before + 10
      );
      await page.mouse.move(key === 'ArrowUp' ? 231 : 241, 131);
      await page.waitForSelector('.video-controls.is-hidden', { state: 'attached', timeout: 6000 });
      assert(
        await page.evaluate(() => !document.activeElement?.closest('.video-controls')),
        'The mouse releases keyboard focus in the player'
      );
      assert(await page.evaluate(() => getSelection()?.isCollapsed), 'No stale player selection');
    }
    console.log(`${engine.name()}: mouse auto-hide, keyboard focus and player settings OK`);
  } finally {
    await browser.close();
  }
}
