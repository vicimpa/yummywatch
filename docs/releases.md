# Сборка и выпуск YummyWatch

## Что делает GitHub Actions

По умолчанию публикуются desktop-пакеты и подписанные APK Android TV. Выпуск пакетов Android для телефонов и iOS включается отдельно.

`.github/workflows/ci.yml` запускается для pull requests и push в main/master/develop. Проверяет версии, TypeScript, Vitest и реальные компоненты в Chromium/WebKit на 320×568, 390×844, 430×932, 844×390 и 1280×820. Затем reusable workflow `build.yml` собирает пакеты и запускает Rust-тесты на desktop-платформах. Установщики хранятся как Actions artifacts 14 дней, снимки мобильных раскладок — 7 дней.

| Платформа           | CI                                         | Release                                                                   |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| macOS Apple Silicon | DMG для aarch64                            | Тот же пакет; подпись приложения и notarization при наличии Apple secrets |
| macOS Intel         | отдельный DMG для x86_64                   | Тот же пакет; подпись приложения и notarization при наличии Apple secrets |
| Windows x64         | NSIS EXE, MSI                              | Те же пакеты, без Authenticode                                            |
| Linux x64           | DEB, RPM, AppImage, Arch `.pkg.tar.zst`    | Те же пакеты                                                              |
| Android             | Debug APK для arm64                        | Подписанные APK/AAB с arm64, armv7 и x86_64                               |
| Android TV          | Проверки интерфейса и навигации            | Отдельные подписанные APK для arm64-v8a, armeabi-v7a, x86_64 и x86        |
| iOS                 | ZIP приложения arm64 Simulator без подписи | IPA с App Store Connect provisioning profile                              |

Windows-установщики включают DLL libmpv. AppImage включает libmpv и плагины GStreamer. DEB, RPM и Arch объявляют зависимость от системной libmpv. Arch-пакет создаётся `makepkg` в контейнере `archlinux:base-devel` из проверенного DEB той же сборки. PKGBUILD хранится в `packaging/archlinux`. CI устанавливает результат через `pacman -U`, проверяет файлы, desktop entry и динамические библиотеки. Публикация в AUR не выполняется. Наличие конкретного кодека на целевом дистрибутиве и воспроизведение на физических телефонах требуют отдельной проверки. Симулятор и браузерные проверки не подтверждают работу DRM/кодеков и custom URI transport на реальном устройстве.

## Подготовка GitHub

В Settings → Secrets and variables → Actions → Secrets добавь **secret** `YUMMY_APPLICATION_TOKEN` — публичный токен приложения YummyAnime. Он передаётся сборке как `VITE_YUMMY_APPLICATION_TOKEN`. Release jobs проверяют наличие значения до сборки и его включение в готовый JavaScript после сборки; при отсутствии токена релиз не публикуется. Значение не записывается в Git и маскируется в логах Actions. Само приложение содержит этот публичный токен: хранение в Secrets не делает клиентский ключ неизвлекаемым.

Для подписанных мобильных сборок добавь следующие **secrets**.

| Secret                     | Значение                                                                  |
| -------------------------- | ------------------------------------------------------------------------- |
| `ANDROID_KEY_BASE64`       | Upload keystore JKS, закодированный в base64                              |
| `ANDROID_KEY_ALIAS`        | Alias ключа внутри JKS                                                    |
| `ANDROID_STORE_PASSWORD`   | Пароль JKS                                                                |
| `ANDROID_KEY_PASSWORD`     | Пароль выбранного ключа                                                   |
| `IOS_CERTIFICATE`          | Apple Distribution `.p12` в base64, включая private key                   |
| `IOS_CERTIFICATE_PASSWORD` | Пароль экспорта `.p12`                                                    |
| `IOS_MOBILE_PROVISION`     | App Store Connect `.mobileprovision` в base64 для `app.yumiwatch.desktop` |

Секреты `ANDROID_*` нужны для подписанных APK Android TV и Android. Секреты `IOS_*` нужны при запуске с `include_mobile=true`.

Также добавь **repository variable** `APPLE_DEVELOPMENT_TEAM` с Team ID. Bundle ID существующего приложения сохранён для всех платформ: `app.yumiwatch.desktop`. При смене идентификатора обнови provisioning profile. Для сборки iOS на устройство нужна учётная запись Apple Developer; [требования подписи Tauri](https://v2.tauri.app/distribute/sign/ios/) описывают сертификат и профиль. IPA с этим export method предназначен для App Store Connect/TestFlight: GitHub download не заменяет установку через Apple. Автоматической загрузки в магазины этот workflow не делает.

Upload key Android можно создать через `keytool` по [инструкции Tauri](https://v2.tauri.app/distribute/sign/android/). Сохрани JKS отдельно: для обновления установленного приложения нужен тот же ключ. CI декодирует его во временный каталог runner и удаляет в конце job; пароли передаются Gradle через окружение. Keystore и пароли не добавляются в Git.

Дополнительные **secrets** для macOS:

| Secret                       | Значение                                     |
| ---------------------------- | -------------------------------------------- |
| `APPLE_CERTIFICATE`          | Developer ID Application `.p12` в base64     |
| `APPLE_CERTIFICATE_PASSWORD` | Пароль `.p12`                                |
| `APPLE_SIGNING_IDENTITY`     | Полное имя Developer ID Application identity |
| `APPLE_ID`                   | Apple ID для notarization                    |
| `APPLE_PASSWORD`             | App-specific password                        |
| `APPLE_TEAM_ID`              | Team ID для notarization                     |

Без этих дополнительных секретов desktop-пакеты собираются без доверенной подписи разработчика. Windows Authenticode также не настроен: для него потребуется сертификат или сервис подписи. [Официальная схема Tauri/GitHub](https://v2.tauri.app/distribute/pipelines/github/) используется как основа сборки.

Ad-hoc сборка macOS включает `com.apple.security.cs.disable-library-validation`, чтобы Hardened Runtime мог загрузить вложенную `libmpv` без Team ID. В CI подпись Developer ID использует штатную проверку библиотеки по Team ID. Проверка `--check-libmpv` запускает загрузку библиотеки из собранной `.app`.

## Выпуск версии

1. Выполни `npm version <version> --no-git-tag-version` и выставь ту же `version` в `src-tauri/Cargo.toml`. Обнови `Cargo.lock` командой `cargo check --manifest-path src-tauri/Cargo.toml`.
2. Выполни `node scripts/check-release.mjs`, `npm test`, `npm run build:web` и `npm run check:mobile`.
3. Закоммить изменения, создай тег `v<version>` на нужном коммите и отправь commit/tag в GitHub.
4. Push version tag запускает релиз macOS, Windows, Linux и Android TV. Чтобы дополнительно собрать пакеты Android для телефонов и iOS, запусти Release вручную на том же теге с `include_mobile=true`.
5. Только после успеха всех выбранных релизных jobs публикуются пакеты и `SHA256SUMS.txt`. Версия с дефисом помечается prerelease. При повторном запуске файлы того же тега заменяются.

Workflow не выполняет `pull_request_target`, PR-сборки не получают release secrets. `contents: write` выдаётся только финальной публикации. Используется стандартный `GITHUB_TOKEN`; отдельный PAT не нужен. Ручной запуск Release выбирай на существующем version tag. Идентификатор сборки iOS берётся из `GITHUB_RUN_NUMBER`.

## Локальные мобильные сборки

Поставь [зависимости Tauri](https://v2.tauri.app/start/prerequisites/), затем `npm ci`. Android требует JDK, Android SDK/NDK, `JAVA_HOME`, `ANDROID_HOME`, `NDK_HOME` и соответствующие Rust targets. iOS требует macOS, полный Xcode с iOS SDK, CocoaPods и Rust targets для устройства/симулятора. Command Line Tools недостаточно.

```sh
npm run init:android
npm run build:android -- --ci --debug --target aarch64 --apk
npm run build:android:tv
npm run build:android:tv -- armeabi-v7a

APPLE_DEVELOPMENT_TEAM=YOUR_TEAM npm run init:ios
APPLE_DEVELOPMENT_TEAM=YOUR_TEAM npm run build:ios -- --ci --target aarch64-sim --no-sign
```

`src-tauri/gen/android` и `src-tauri/gen/apple` создаются заново из установленного Tauri CLI. Вноси постоянные настройки в platform-specific `tauri.*.conf.json` или `scripts/prepare-mobile.mjs`, чтобы они сохранялись при следующем CI-запуске. Android release signing читает `ANDROID_KEYSTORE_PATH`, `ANDROID_STORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Автоматическая очистка работает только с локальным `src-tauri/target`; generated Gradle/Xcode-каталоги вручную удаляются перед переинициализацией при необходимости.

APK Android TV находятся в `src-tauri/gen/android/app/build/outputs/apk`. Команда `node scripts/collect-android-tv.mjs` проверяет все четыре подписанных APK и копирует их с контрольными суммами в `release-assets`. Укажи путь к SDK build-tools в `ANDROID_BUILD_TOOLS`. [Установка через ADB](android-tv.md)

## Границы локальной проверки

Конфигурация workflow проверяется через actionlint; сборка фронтенда, Rust-тесты и геометрия мобильного UI могут проверяться локально. Реальные macOS ARM64/Intel, Windows, Linux, Android и iOS сборки подтверждаются только успешными Actions jobs. Для подписанных выпусков сначала добавь соответствующие секреты и проверь CI.
