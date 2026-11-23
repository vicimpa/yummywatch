import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve('src-tauri/gen/android/app/build/outputs/apk');
const tools = process.env.ANDROID_BUILD_TOOLS;
if (!tools) throw new Error('Set ANDROID_BUILD_TOOLS to the Android SDK build-tools directory');

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const expectedAbis = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'];
const packages = new Map();
const run = (command, ...args) =>
  execFileSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();

for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
  if (
    !entry.isFile() ||
    !entry.name.endsWith('-release.apk') ||
    entry.name === 'app-universal-release.apk'
  )
    continue;
  const path = join(entry.parentPath, entry.name);
  const contents = new Set(run('unzip', '-Z1', path).split('\n'));
  const abis = new Set(
    [...contents]
      .filter(name => /^lib\/[^/]+\/[^/]+\.so$/.test(name))
      .map(name => name.split('/')[1])
  );
  if (abis.size !== 1) continue;

  const [abi] = abis;
  if (!expectedAbis.includes(abi)) continue;
  if (packages.has(abi)) throw new Error(`Multiple release APKs for ${abi}`);
  for (const library of ['libyummywatch_lib.so', 'libmpv.so', 'libavcodec.so']) {
    if (!contents.has(`lib/${abi}/${library}`)) throw new Error(`${path} is missing ${library}`);
  }
  const badging = run(join(tools, 'aapt'), 'dump', 'badging', path);
  if (
    !badging.includes("name='app.yumiwatch.desktop'") ||
    !badging.includes(`versionName='${version}'`)
  )
    throw new Error(`Unexpected application ID or version in ${path}`);
  const manifest = run(join(tools, 'aapt'), 'dump', 'xmltree', path, 'AndroidManifest.xml');
  if (!manifest.includes('android.intent.category.LEANBACK_LAUNCHER'))
    throw new Error(`No Android TV launcher in ${path}`);

  const signature = run(join(tools, 'apksigner'), 'verify', '--print-certs', path);
  const signer = signature.match(/certificate SHA-256 digest: ([a-f0-9]+)/i)?.[1];
  if (!signer) throw new Error(`No verified signature in ${path}`);
  packages.set(abi, { path, signer });
}

if (packages.size !== expectedAbis.length)
  throw new Error(
    `Missing signed Android TV APKs: ${expectedAbis.filter(abi => !packages.has(abi)).join(', ')}`
  );
if (new Set([...packages.values()].map(({ signer }) => signer)).size !== 1)
  throw new Error('Android TV APKs must use the same signing key');

const output = resolve('release-assets');
await mkdir(output, { recursive: true });
const sums = [];
for (const [abi, { path }] of packages) {
  const name = `YummyWatch-${version}-AndroidTV-${abi}.apk`;
  await copyFile(path, join(output, name));
  const digest = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
  sums.push(`${digest}  ${name}`);
}
await writeFile(join(output, 'android-tv-SHA256SUMS.txt'), `${sums.sort().join('\n')}\n`);
