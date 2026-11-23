import { Component, render, type ComponentChildren } from 'preact';

import { initializeCache } from '~/lib/cache-store';
import { initializeDesktop } from '~/lib/desktop';
import { initializeInterfaceScale } from '~/lib/interface-scale';
import { notify } from '~/lib/notifications';
import { initializeSession } from '~/lib/session';
import { installAndroidWebViewCompatibility } from '~/lib/android-webview';

import { App } from './App';
import { StartupError } from '~/components/StartupError';

import './styles.css';
import './yummy.css';
import './mobile.css';
import './gallery.css';
import './media-center.css';
import './desktop.css';
import './interaction.css';
import './touch.css';
import './profile.css';
import './scrollbars.css';
import './social.css';
import './tv.css';

class ErrorBoundary extends Component<{ children: ComponentChildren }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? (
      <StartupError
        title="Небольшой перерыв"
        message="Не удалось открыть приложение. Твоя коллекция осталась на устройстве."
        action="Перезагрузить"
        icon
      />
    ) : (
      this.props.children
    );
  }
}

async function start() {
  if (/Android/i.test(navigator.userAgent)) installAndroidWebViewCompatibility();
  const root = document.getElementById('app')!;

  try {
    await initializeDesktop();
    await initializeInterfaceScale();

    let sessionError = '';

    try {
      await initializeSession();
    } catch (error) {
      sessionError = (error as Error).message;
    }
    await initializeCache();
    render(
      <ErrorBoundary>
        <App />
      </ErrorBoundary>,
      root
    );
    if (sessionError) setTimeout(() => notify(sessionError), 0);
  } catch {
    render(
      <StartupError
        title="Не удалось запустить приложение"
        message="Перезапусти YummyWatch, чтобы подключить встроенный сервер."
        action="Попробовать снова"
      />,
      root
    );
  } finally {
    document.getElementById('app-startup')?.remove();
  }
}

void start();
