import type { FunctionalComponent as FC, JSX } from 'preact';
import { useCallback } from 'preact/hooks';

import { supportsInterfaceScale } from '~/lib/interface-scale';
import {
  INTERFACE_SCALES,
  saveInterfaceSettings,
  useInterfaceSettings,
} from '~/lib/interface-settings';

import { Dropdown, Field, Icon, Input, SettingsCard, Toggle } from '~/ui';

export const InterfaceSettingsCard: FC = () => {
  const settings = useInterfaceSettings();
  const tv = document.documentElement.hasAttribute('data-tv');

  const changeScale = useCallback(
    (value: string) =>
      saveInterfaceSettings({
        scale: value === 'system' ? 'system' : Number(value),
      }),
    []
  );

  const changeVolume = useCallback(
    (event: JSX.TargetedInputEvent<HTMLInputElement>) =>
      saveInterfaceSettings({ volume: Number(event.currentTarget.value) }),
    []
  );

  const changeSounds = useCallback(
    (event: JSX.TargetedEvent<HTMLInputElement>) =>
      saveInterfaceSettings({ sounds: event.currentTarget.checked }),
    []
  );

  const changeEffectsVolume = useCallback(
    (event: JSX.TargetedInputEvent<HTMLInputElement>) =>
      saveInterfaceSettings({ effectsVolume: Number(event.currentTarget.value) }),
    []
  );

  const changeAnimations = useCallback(
    (event: JSX.TargetedEvent<HTMLInputElement>) =>
      saveInterfaceSettings({ animations: event.currentTarget.checked }),
    []
  );

  const changeStyle = useCallback(
    (value: string) => saveInterfaceSettings({ style: value as typeof settings.style }),
    []
  );

  return (
    <SettingsCard
      class="interface-settings"
      title="Интерфейс и управление"
      description="Настрой медиакаталог под себя. Всё сохраняется на этом устройстве."
      icon={<Icon name="settings" size={25} />}
    >
      {supportsInterfaceScale() && (
        <>
          <Field class="settings-choice" label="Масштаб интерфейса">
            <Dropdown
              aria-label="Масштаб интерфейса"
              value={String(settings.scale)}
              onChange={changeScale}
              options={[
                { value: 'system', label: 'По системе' },
                ...INTERFACE_SCALES.map(scale => ({
                  value: String(scale),
                  label: `${Math.round(scale * 100)}%`,
                })),
              ]}
            />
          </Field>
          <p class="fine-print">
            По умолчанию учитываем системный масштаб и размер текста Linux. Ручной масштаб
            применяется поверх масштаба экрана.
          </p>
        </>
      )}
      <Field
        class="interface-range"
        label={
          <>
            Общая громкость <output>{Math.round(settings.volume * 100)}%</output>
          </>
        }
      >
        <Input
          type="range"
          min="0"
          max="1"
          step=".05"
          aria-label="Общая громкость"
          value={settings.volume}
          onInput={changeVolume}
        />
      </Field>
      <p class="fine-print">Громкость нашего плеера и звуков интерфейса.</p>
      <Toggle checked={settings.sounds} onChange={changeSounds}>
        Звуки наведения, выбора и переходов
      </Toggle>
      <Field
        class="interface-range"
        label={
          <>
            Громкость интерфейса <output>{Math.round(settings.effectsVolume * 100)}%</output>
          </>
        }
      >
        <Input
          type="range"
          min="0"
          max="1"
          step=".05"
          aria-label="Громкость интерфейса"
          disabled={!settings.sounds}
          value={settings.effectsVolume}
          onInput={changeEffectsVolume}
        />
      </Field>
      <Toggle checked={settings.animations} disabled={tv} onChange={changeAnimations}>
        Анимации переходов и боковых панелей
      </Toggle>
      <p class="fine-print">
        {tv
          ? 'В режиме ТВ анимации отключены.'
          : 'Системная настройка уменьшения движения имеет приоритет.'}
      </p>
      <Field class="settings-choice" label="Оформление">
        <Dropdown
          aria-label="Стиль интерфейса"
          value={settings.style}
          onChange={changeStyle}
          options={[
            { value: 'classic', label: 'Классический' },
            { value: 'cinema', label: 'Кинозал' },
            { value: 'contrast', label: 'Контрастный' },
          ]}
        />
      </Field>
      <div class="keyboard-reference">
        {tv ? (
          <>
            <h3>Управление пультом</h3>
            <p>
              <kbd>← ↑ ↓ →</kbd> перемещают фокус. <kbd>OK</kbd> открывает выбранное. Удерживай{' '}
              <kbd>OK</kbd> на карточке, чтобы открыть действия с аниме. <kbd>Назад</kbd> закрывает
              открытое меню или возвращает к предыдущему экрану.
            </p>
            <p>
              Нажми <kbd>OK</kbd> на поле, списке или слайдере, чтобы включить его управление.
              <kbd>Назад</kbd> возвращает управление стрелками.
            </p>
            <p>
              Во время просмотра <kbd>OK</kbd> ставит на паузу или продолжает, <kbd>← / →</kbd>{' '}
              перематывают на 10 секунд, <kbd>↑ / ↓</kbd> показывают управление.
            </p>
          </>
        ) : (
          <>
            <h3>Управление с клавиатуры</h3>
            <p>
              <kbd>← ↑ ↓ →</kbd> выбор · <kbd>Enter</kbd> открыть · <kbd>Esc / Backspace</kbd>{' '}
              закрыть панель / назад · <kbd>/</kbd> или <kbd>Ctrl/⌘ K</kbd> поиск
            </p>
            <p>
              При просмотре <kbd>Enter</kbd> управление · <kbd>Space / K</kbd> пауза ·{' '}
              <kbd>J / L</kbd> ±10 с · <kbd>E</kbd> серии · <kbd>C</kbd> комментарии · <kbd>I</kbd>{' '}
              об аниме · <kbd>F</kbd> полный экран · <kbd>M</kbd> звук.
            </p>
          </>
        )}
      </div>
    </SettingsCard>
  );
};
