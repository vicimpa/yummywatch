import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const release = 'https://github.com/mpv-player/mpv/releases/tag/v0.42.0';
const archive =
  'https://github.com/mpv-player/mpv/releases/download/v0.42.0/libmpv-v0.42.0-x86_64-w64-mingw32-lgpl.zip';
const archiveSha256 = '8e5f77430efc53ef175804ba6618527e3af0448a0dcabf04d3cc72659d1a6fce';
const dllSha256 = '94fb87247732c59915cd59808bc582e843a71c22214b7b6c1e5563aa8149cef4';
const output = fileURLToPath(new URL('../src-tauri/native-libs/windows/', import.meta.url));
const dll = 'libmpv-2.dll';

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

const exists = path =>
  stat(path).then(
    info => info.isFile(),
    () => false
  );

const checksums = join(output, 'SHA256SUMS.txt');
if (await exists(checksums)) {
  const manifest = await readFile(checksums, 'utf8');
  const expected = await Promise.all(
    [dll, 'LICENSE.LGPL', 'SOURCE.txt'].map(async name => {
      return `${await digest(join(output, name))}  ${name}`;
    })
  );
  if (manifest.trim().replaceAll('\r\n', '\n') !== expected.join('\n'))
    throw new Error('Unexpected checksum for locally built Windows libmpv');
  if ((await readFile(join(output, 'SOURCE.txt'), 'utf8')).includes('Video renderer: D3D11'))
    process.exit(0);
}

if (
  (await exists(join(output, 'SOURCE.txt'))) &&
  (await exists(join(output, 'LICENSE.LGPL'))) &&
  (await exists(join(output, dll))) &&
  (await digest(join(output, dll))) === dllSha256
) {
  process.exit(0);
}

await mkdir(output, { recursive: true });
const staging = await mkdtemp(join(output, '.extract-'));
try {
  const zip = join(staging, 'libmpv.zip');
  const response = await fetch(archive, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status})`);
  await pipeline(response.body, createWriteStream(zip));
  if ((await digest(zip)) !== archiveSha256) throw new Error('Unexpected libmpv archive SHA-256');

  const extract = spawnSync('tar', ['-xf', zip, '-C', staging, dll, 'LICENSE.LGPL'], {
    stdio: 'inherit',
  });
  if (extract.error) throw extract.error;
  if (extract.status !== 0) throw new Error('Unable to extract libmpv');
  if ((await digest(join(staging, dll))) !== dllSha256)
    throw new Error('Unexpected libmpv DLL SHA-256');

  await rename(join(staging, dll), join(output, dll));
  await rename(join(staging, 'LICENSE.LGPL'), join(output, 'LICENSE.LGPL'));
  await writeFile(
    join(output, 'SOURCE.txt'),
    `mpv v0.42.0, x86_64, official LGPL build\n` +
      `Release and source code: ${release}\n` +
      `Build instructions: https://github.com/mpv-player/mpv/blob/v0.42.0/DOCS/compile-windows.md\n` +
      `Build recipe: https://github.com/mpv-player/mpv/blob/v0.42.0/ci/build-mingw64-full.sh\n` +
      `Binary archive: ${archive}\nSHA-256: ${archiveSha256}\n`
  );
  await rm(checksums, { force: true });
} finally {
  await rm(staging, { recursive: true, force: true });
}
