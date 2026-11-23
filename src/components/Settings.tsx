import { AppLink } from '~/ui/AppLink';
import type { FunctionalComponent as FC } from 'preact';

import { version } from '../../package.json';
import type { InstallPrompt } from '~/hooks/useInstallation';
import { isDesktop } from '~/lib/desktop';

import { AccountCard } from './Account';
import { DiscordSettingsCard } from './DiscordSettings';
import { InterfaceSettingsCard } from './InterfaceSettings';
import { VoiceRankingSettings } from './VoiceRankingSettings';
import { DownloadSettingsCard } from './DownloadSettings';
import { PlaybackSettingsCard } from './PlaybackSettings';
import { ProxySettingsCard } from './ProxySettings';
import { ServerStatusCard } from './ServerStatusCard';
import { NotificationSettingsCard } from './Social';
import { Button, ButtonLink, Icon, SettingsCard } from '~/ui';

export type { InstallPrompt } from '~/hooks/useInstallation';

export type TSettingsProps = {
  installPrompt?: InstallPrompt;
  install: () => void;
  installed: boolean;
};

export const Settings: FC<TSettingsProps> = ({ installPrompt, install, installed }) => (
  <div data-tv-vertical>
    <div class="page-heading">
      <p class="eyebrow">ЧУТЬ БОЛЬШЕ УЮТА</p>
      <h1>Настройки</h1>
      <p>YummyWatch, как удобно тебе.</p>
    </div>
    <InterfaceSettingsCard />
    <ServerStatusCard />
    <AccountCard />
    <NotificationSettingsCard />
    <PlaybackSettingsCard />
    <ProxySettingsCard />
    <DownloadSettingsCard />
    <VoiceRankingSettings />
    <DiscordSettingsCard />
    {!isDesktop() && (
      <SettingsCard
        title={installed ? 'Уже на главном экране' : 'Аниме на расстоянии одного касания'}
        description="Установи YummyWatch: отдельное окно, быстрый запуск и любимая коллекция под рукой."
        icon={<Icon name="download" size={25} />}
      >
        {installPrompt ? (
          <Button onClick={install} variant="primary">
            <Icon name="download" size={18} />
            Установить приложение
          </Button>
        ) : (
          !installed && (
            <div class="install-help">
              <p>
                <strong>iPhone / iPad</strong> — в Safari нажми «Поделиться» → «На экран Домой» →
                «Добавить».
              </p>
              <p>
                <strong>Android</strong> — в меню Chrome нажми «Установить приложение» или «Добавить
                на главный экран».
              </p>
              <p>
                <strong>Компьютер</strong> — используй значок установки в адресной строке Chrome или
                Edge, если он доступен.
              </p>
            </div>
          )
        )}
      </SettingsCard>
    )}
    <AppLink class="settings-card settings-connection-link" href="#/settings/connection">
      <div class="settings-icon">
        <Icon name="settings" size={25} />
      </div>
      <div>
        <h2>Подключение к Yummy</h2>
        <p>Токен приложения и состояние серверов</p>
      </div>
      <Icon name="chevron" size={20} />
    </AppLink>
    <SettingsCard
      title="Когда сеть пропала"
      description="Оболочка приложения и последние загруженные данные остаются доступны после первого посещения. Гостевая коллекция хранится на устройстве. Для коллекции аккаунта, синхронизации и видео нужен интернет."
      icon={<Icon name="wifi" size={25} />}
    />
    <div class="about-card">
      <img src={`${import.meta.env.BASE_URL}icons/icon.svg`} width="42" height="42" alt="" />
      <h2>
        YummyWatch <span>v{version}</span>
      </h2>
      <p>Маленький клиент для больших историй.</p>
      <p>
        Независимый проект на {isDesktop() ? 'Tauri 2 и Preact' : 'Preact'}. Каталог и видео —
        YummyAnime.
        <br />
        Не является официальным приложением YummyAnime.
      </p>
      <ButtonLink
        href="https://api.yani.tv/swagger"
        target="_blank"
        rel="noreferrer"
        variant="text"
      >
        Документация API
        <Icon name="external" size={15} />
      </ButtonLink>
    </div>
  </div>
);
