import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const targets = {
  'arm64-v8a': 'aarch64',
  'armeabi-v7a': 'armv7',
  x86_64: 'x86_64',
  x86: 'i686',
};
const requested = process.argv.slice(2);
const abis = requested.length ? [...new Set(requested)] : Object.keys(targets);
for (const abi of abis) {
  if (!Object.hasOwn(targets, abi)) throw new Error(`Unsupported Android TV ABI: ${abi}`);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const run = args => {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(['scripts/prepare-mobile.mjs', 'android']);
run(['scripts/prepare-android-libmpv.mjs', ...abis]);
run([
  'node_modules/@tauri-apps/cli/tauri.js',
  'android',
  'build',
  '--config',
  'src-tauri/tauri.tv.conf.json',
  '--ci',
  '--target',
  ...abis.map(abi => targets[abi]),
  '--split-per-abi',
  '--apk',
  '--',
  '--locked',
]);
