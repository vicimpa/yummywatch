import { sourceAlias } from './shared/paths.mjs';
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: { alias: sourceAlias },
  base: process.env.BASE_PATH || '/',
  clearScreen: false,
  ...(process.env.TAURI_ENV_PLATFORM === 'android' && {
    build: { target: 'chrome91', cssTarget: 'chrome91' },
  }),
  server: {
    watch: { ignored: ['**/src-tauri/**'] },
    proxy: {
      '^/yummystatus-api(?:\\?|$)': {
        target: 'https://yummystatus.me',
        changeOrigin: true,
        rewrite: () => '/api/health?timeRange=3hour',
      },
    },
  },
  plugins: [
    preact(),
    {
      name: 'yummywatch-pwa',
      apply: 'build',
      async closeBundle() {
        const dir = resolve('dist');
        const files = [
          'index.html',
          'manifest.webmanifest',
          'icons/icon-192.png',
          'icons/icon-512.png',
          'icons/apple-touch-icon.png',
          'icons/icon.svg',
          ...(await readdir(resolve(dir, 'assets'))).map(f => `assets/${f}`),
        ];
        const hash = createHash('sha256');

        for (const file of files) hash.update(await readFile(resolve(dir, file)));

        const version = hash.digest('hex').slice(0, 12);
        const source = await readFile(resolve('src/sw.js'), 'utf8');

        await writeFile(
          resolve(dir, 'sw.js'),
          source.replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(files))
        );
      },
    },
  ],
});
