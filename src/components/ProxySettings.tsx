import { useEffect, useRef, useState } from 'preact/hooks';

import { isDesktop } from '~/lib/desktop';
import { notify } from '~/lib/notifications';
import {
  editCustomProxy,
  loadProxyPool,
  saveProxyEnabled,
  useProxyEnabled,
  type ProxyPoolReport,
} from '~/lib/proxy-settings';
import { Button, Dropdown, Field, Icon, Input, SettingsCard, Toggle } from '~/ui';

import './ProxySettings.css';

const number = new Intl.NumberFormat('ru');
const time = new Intl.DateTimeFormat('ru', { timeStyle: 'medium' });
const formatTime = (timestamp: number) => time.format(timestamp * 1000);
const intervalOptions = [2, 4, 10, 30].map(value => ({
  value: String(value),
  label: `${value} с`,
}));
const concurrentOptions = [1, 2, 4, 6].map(value => ({
  value: String(value),
  label: String(value),
}));

function ProxyPoolControls({ enabled }: { enabled: boolean | undefined }) {
  const [report, setReport] = useState<ProxyPoolReport>();
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [address, setAddress] = useState('');
  const action = useRef(false);
  const revision = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    const refresh = async () => {
      const current = revision.current;
      if (!action.current) {
        try {
          const next = await loadProxyPool({}, controller.signal);
          if (next?.preferences && !controller.signal.aborted && current === revision.current) {
            setReport(next);
            setUnavailable(false);
          }
        } catch {
          if (!controller.signal.aborted && current === revision.current) setUnavailable(true);
        }
      }
      if (!controller.signal.aborted) timer = window.setTimeout(refresh, 3000);
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [enabled]);

  const apply = async (request: () => Promise<ProxyPoolReport>) => {
    if (action.current) return false;
    action.current = true;
    revision.current++;
    setBusy(true);
    try {
      const next = await request();
      if (next?.preferences) {
        setReport(next);
        setUnavailable(false);
        return true;
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      action.current = false;
    }
    return false;
  };
  const update = (args: Parameters<typeof loadProxyPool>[0]) => apply(() => loadProxyPool(args));

  if (!report) return unavailable ? <p role="status">Отчёт пула сейчас недоступен.</p> : null;

  const { preferences, probes, lastManual } = report;
  return (
    <div class="proxy-pool">
      <div class="proxy-pool-options">
        <Field class="settings-choice" label="Пауза между проверками">
          <Dropdown
            aria-label="Пауза между проверками"
            options={intervalOptions}
            value={String(preferences.intervalSeconds)}
            onChange={value =>
              void update({ preferences: { ...preferences, intervalSeconds: Number(value) } })
            }
            disabled={busy}
          />
        </Field>
        <Field class="settings-choice" label="Параллельных проверок">
          <Dropdown
            aria-label="Параллельных проверок"
            options={concurrentOptions}
            value={String(preferences.concurrentChecks)}
            onChange={value =>
              void update({ preferences: { ...preferences, concurrentChecks: Number(value) } })
            }
            disabled={busy}
          />
        </Field>
      </div>

      <section class="proxy-pool-section" aria-label="Свои прокси">
        <h3>Свои прокси</h3>
        <form
          class="proxy-pool-add"
          onSubmit={event => {
            event.preventDefault();
            if (!address.trim() || busy) return;
            void apply(() => editCustomProxy({ action: 'add', address })).then(saved => {
              if (saved) setAddress(current => (current === address ? '' : current));
            });
          }}
        >
          <Field label="Адрес прокси">
            <Input
              aria-label="Адрес прокси"
              autoComplete="off"
              autoCapitalize="off"
              spellcheck={false}
              maxLength={2048}
              placeholder="socks5://proxy.example:1080"
              value={address}
              onInput={event => setAddress(event.currentTarget.value)}
            />
          </Field>
          <Button type="submit" aria-busy={busy} disabled={!address.trim()}>
            Добавить прокси
          </Button>
        </form>
        <p>Подойдут HTTP, HTTPS и SOCKS. При необходимости укажи логин и пароль в URL.</p>
        {!!report.customProxies?.length && (
          <ul>
            {report.customProxies.map(proxy => (
              <li key={proxy.id}>
                <div class="proxy-pool-address">
                  <span>{proxy.address}</span>
                  <small>
                    {proxy.authenticated && 'С авторизацией · '}
                    {!enabled
                      ? 'Пул выключен'
                      : proxy.reachable === true
                        ? 'Доступен'
                        : proxy.reachable === false
                          ? 'Не прошёл проверку'
                          : 'Ожидает проверки'}
                  </small>
                </div>
                <Button
                  variant="text"
                  aria-label={`Удалить прокси ${proxy.address}`}
                  aria-busy={busy}
                  onClick={() =>
                    void apply(() => editCustomProxy({ action: 'remove', id: proxy.id }))
                  }
                >
                  Удалить
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section class="proxy-pool-section" aria-label="Списки прокси">
        <h3>Списки прокси</h3>
        <ul>
          {report.feeds.map(([name, status], index) => {
            const selected = preferences.feeds[index];
            return (
              <li key={name}>
                <Toggle
                  checked={selected}
                  aria-busy={busy}
                  onChange={event => {
                    const input = event.currentTarget;
                    const next = input.checked;
                    input.checked = selected;
                    void update({
                      preferences: {
                        ...preferences,
                        feeds: preferences.feeds.map((value, i) => (i === index ? next : value)),
                      },
                    });
                  }}
                >
                  {name}
                </Toggle>
                <small>
                  {!selected
                    ? 'Выключен'
                    : status.error
                      ? status.error
                      : status.updatedAt
                        ? `${number.format(status.addresses)} · ${formatTime(status.updatedAt)}`
                        : 'Ждёт обновления'}
                </small>
              </li>
            );
          })}
        </ul>
      </section>

      <section class="proxy-pool-section" aria-label="Отчёт проверки прокси">
        <h3>Проверка пула</h3>
        <p>Доступность проверяется по контрольному файлу YummyWatch на GitHub.</p>
        <dl class="proxy-pool-metrics">
          <div>
            <dt>Работают сейчас</dt>
            <dd>{number.format(report.working)}</dd>
          </div>
          <div>
            <dt>В очереди</dt>
            <dd>{number.format(report.queued)}</dd>
          </div>
          <div>
            <dt>Проверок за сеанс</dt>
            <dd>{number.format(probes.checked)}</dd>
          </div>
          <div>
            <dt>Успешных</dt>
            <dd>{number.format(probes.passed)}</dd>
          </div>
        </dl>
        <div class="proxy-pool-check">
          <Button
            aria-busy={report.manualPending || busy}
            aria-disabled={report.manualPending || busy || undefined}
            disabled={!enabled}
            onClick={() => {
              if (!report.manualPending) void update({ checkNow: true });
            }}
          >
            Проверить сейчас
          </Button>
          {report.manualPending ? (
            <p role="status">Обновляем списки и проверяем адреса…</p>
          ) : lastManual?.completedAt ? (
            <p role="status">
              {lastManual.checked
                ? `В ${formatTime(lastManual.completedAt)} прошли ${lastManual.passed} из ${lastManual.checked}`
                : 'В списках нет доступных адресов для проверки.'}
            </p>
          ) : null}
        </div>
        {unavailable && <p role="status">Не удалось обновить отчёт.</p>}
      </section>

      <section class="proxy-pool-section" aria-label="Подключения к плеерам через прокси">
        <h3>Подключения к плеерам через прокси</h3>
        <ul>
          {report.players.map(([name, attempts, successes, lastSuccess]) => (
            <li key={name}>
              <span>{name}</span>
              <small>
                {attempts
                  ? `${successes} из ${attempts} успешно${lastSuccess ? ` · ${formatTime(lastSuccess)}` : ''}`
                  : 'Попыток пока не было'}
              </small>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function ProxySettingsCard() {
  const enabled = useProxyEnabled();
  const [pending, setPending] = useState(false);
  if (!isDesktop()) return null;
  return (
    <SettingsCard
      title="Прокси"
      description="Проверяет открытые прокси в фоне. Приложение пробует их, когда источник видео недоступен напрямую."
      icon={<Icon name="wifi" size={25} />}
    >
      <Toggle
        checked={enabled === true}
        disabled={enabled === undefined}
        aria-busy={pending}
        onChange={event => {
          const input = event.currentTarget;
          const next = input.checked;
          if (enabled === undefined || pending) {
            input.checked = enabled === true;
            return;
          }
          setPending(true);
          void saveProxyEnabled(next)
            .catch(error => {
              input.checked = enabled;
              notify(error.message);
            })
            .finally(() => setPending(false));
        }}
      >
        Использовать прокси для источников видео
      </Toggle>
      <ProxyPoolControls enabled={enabled} />
    </SettingsCard>
  );
}
