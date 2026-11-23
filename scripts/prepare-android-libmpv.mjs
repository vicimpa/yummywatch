import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tag = '2025-08-25';
const release = `https://github.com/mpv-android/mpv-android/releases/download/${tag}`;
const digests = {
  'arm64-v8a': 'ba121364ea27db747a4031d924d6d2c06749bf03b9ae6052544640460821826b',
  'armeabi-v7a': 'c7c28d4c41e5ac8708497f24e29299855ba3a6a575b1d37f77391b05dd21b15e',
  x86: 'e0a3ea431f4e8a8bf68b97365b3690a4b41f01269a939f5173862b984975aee4',
  x86_64: '12909b28a88c466d83ee74523220eeebd8a2355ae10d6593cc96c902720be0fa',
};
const libraries = [
  'libavcodec.so',
  'libavdevice.so',
  'libavfilter.so',
  'libavformat.so',
  'libavutil.so',
  'libc++_shared.so',
  'libmpv.so',
  'libswresample.so',
  'libswscale.so',
];
const cache = new URL('../src-tauri/native-libs/android/', import.meta.url);
const jni = new URL('../src-tauri/gen/android/app/src/main/jniLibs/', import.meta.url);
const assets = new URL('../src-tauri/gen/android/app/src/main/assets/', import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const targets = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(digests);

async function stripTool() {
  const ndk = process.env.NDK_HOME || process.env.ANDROID_NDK_HOME;
  if (!ndk) return;
  const prebuilt = join(ndk, 'toolchains', 'llvm', 'prebuilt');
  const [host] = await readdir(prebuilt);
  const executable = process.platform === 'win32' ? 'llvm-strip.exe' : 'llvm-strip';
  return join(prebuilt, host, 'bin', executable);
}

const strip = await stripTool();
await mkdir(cache, { recursive: true });
await mkdir(assets, { recursive: true });
for (const abi of targets) {
  if (!Object.hasOwn(digests, abi)) throw new Error(`Unsupported Android ABI ${abi}`);
  const filename = `app-default-${abi}-release.apk`;
  const archive = new URL(filename, cache);
  const cached = await readFile(archive).catch(() => undefined);
  if (!cached || digest(cached) !== digests[abi]) {
    const response = await fetch(`${release}/${filename}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok)
      throw new Error(`Could not download libmpv for ${abi} (HTTP ${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (digest(bytes) !== digests[abi]) throw new Error(`Invalid mpv-android checksum for ${abi}`);
    await writeFile(archive, bytes);
  }
  const directory = new URL(`${abi}/`, jni);
  await mkdir(directory, { recursive: true });
  for (const library of libraries) {
    const bytes = execFileSync('unzip', ['-p', fileURLToPath(archive), `lib/${abi}/${library}`], {
      maxBuffer: 32 * 1024 * 1024,
    });
    const output = new URL(library, directory);
    await writeFile(output, bytes);
    if (strip) execFileSync(strip, ['--strip-debug', fileURLToPath(output)]);
  }
  const certificates = execFileSync('unzip', ['-p', fileURLToPath(archive), 'assets/cacert.pem']);
  await writeFile(new URL('mpv-ca.pem', assets), certificates);
}
