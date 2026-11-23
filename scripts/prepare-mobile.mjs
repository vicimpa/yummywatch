import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const platform = process.argv[2];

if (!['android', 'ios'].includes(platform))
  throw new Error('Usage: node scripts/prepare-mobile.mjs android|ios');

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url));
const result = spawnSync(
  process.execPath,
  [cli, platform, 'init', '--ci', '--skip-targets-install'],
  { cwd: root, stdio: 'inherit' }
);

if (result.status !== 0) process.exit(result.status ?? 1);
if (platform === 'android') {
  const app = new URL('../src-tauri/gen/android/app/', import.meta.url);
  const file = new URL('build.gradle.kts', app);
  let source = await readFile(file, 'utf8');

  if (!source.includes('// YummyWatch release signing')) {
    if (!source.includes('    buildTypes {') || !source.includes('        getByName("release") {'))
      throw new Error('Tauri Android template changed: review release signing');
    source = source
      .replace(
        '    buildTypes {',
        `    // YummyWatch release signing. Debug builds never need the upload key.
    signingConfigs {
        create("release") {
            val keyPath = System.getenv("ANDROID_KEYSTORE_PATH")
            if (!keyPath.isNullOrBlank()) {
                storeFile = file(keyPath)
                storePassword = System.getenv("ANDROID_STORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }
    buildTypes {`
      )
      .replace(
        '        getByName("release") {',
        '        getByName("release") {\n            signingConfig = signingConfigs.getByName("release")'
      );
    await writeFile(file, source);
  }

  const namespace = source.match(/\bnamespace\s*=\s*"([\w.]+)"/)?.[1];
  if (!namespace) throw new Error('Unable to locate the Tauri Android activity namespace');
  const activity = new URL(`src/main/java/${namespace.replaceAll('.', '/')}/MainActivity.kt`, app);
  const template = await readFile(new URL('./android/MainActivity.kt', import.meta.url), 'utf8');
  await writeFile(activity, template.replace(/^package [^\n]+/, `package ${namespace}`));

  const manifest = new URL('src/main/AndroidManifest.xml', app);
  let xml = await readFile(manifest, 'utf8');
  if (!xml.includes('android.software.leanback') || !xml.includes('LEANBACK_LAUNCHER'))
    throw new Error('Tauri Android manifest changed: review Android TV support');
  if (!xml.includes('android.hardware.touchscreen'))
    xml = xml.replace(
      /(^[ \t]*<uses-feature android:name="android\.software\.leanback"[^>]*\/>)/m,
      '$1\n    <uses-feature android:name="android.hardware.touchscreen" android:required="false" />'
    );
  if (!xml.includes('android:banner='))
    xml = xml.replace(
      '<application\n',
      '<application\n        android:banner="@drawable/tv_banner"\n'
    );
  await writeFile(manifest, xml);

  for (const variant of ['values', 'values-night']) {
    const theme = new URL(`src/main/res/${variant}/themes.xml`, app);
    const styles = await readFile(theme, 'utf8');
    if (!styles.includes('android:windowSplashScreenBackground')) {
      const close = '    </style>';
      if (!styles.includes(close))
        throw new Error('Tauri Android theme changed: review the startup background');
      await writeFile(
        theme,
        styles.replace(
          close,
          `        <item name="android:windowBackground">#222222</item>
        <item name="android:windowSplashScreenBackground">#222222</item>
${close}`
        )
      );
    }
  }

  const drawables = new URL('src/main/res/drawable-xhdpi/', app);
  await mkdir(drawables, { recursive: true });
  await copyFile(
    new URL('../src-tauri/icons/android-tv-banner.png', import.meta.url),
    new URL('tv_banner.png', drawables)
  );
}
