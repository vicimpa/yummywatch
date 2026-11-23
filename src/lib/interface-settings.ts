import { useLayoutEffect, useState } from 'preact/hooks';

import { readJSON, writeJSON } from './storage';

export const INTERFACE_EVENT = 'yumiwatch:interface-settings';
export const INTERFACE_SCALES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export interface InterfaceSettings {
  scale: number | 'system';
  volume: number;
  effectsVolume: number;
  sounds: boolean;
  animations: boolean;
  style: 'classic' | 'cinema' | 'contrast';
  episodeLayout: 'cards' | 'list';
}

const clamp = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;

export function interfaceSettings(): InterfaceSettings {
  const raw = readJSON<Partial<InterfaceSettings>>('yumiwatch:interface-settings', {});
  const tv = typeof document !== 'undefined' && document.documentElement.hasAttribute('data-tv');

  return {
    scale: INTERFACE_SCALES.includes(raw.scale as (typeof INTERFACE_SCALES)[number])
      ? raw.scale!
      : 'system',
    volume: clamp(raw.volume, 1),
    effectsVolume: clamp(raw.effectsVolume, 0.35),
    sounds: typeof raw.sounds === 'boolean' ? raw.sounds : !tv,
    animations: !tv && raw.animations !== false,
    style: ['classic', 'cinema', 'contrast'].includes(raw.style || '') ? raw.style! : 'classic',
    episodeLayout: raw.episodeLayout === 'list' ? 'list' : 'cards',
  };
}

export function saveInterfaceSettings(patch: Partial<InterfaceSettings>) {
  const key = 'yumiwatch:interface-settings';
  const saved = readJSON<Partial<InterfaceSettings>>(key, {});
  if (!writeJSON(key, { ...saved, ...patch }))
    throw new Error('Не удалось сохранить настройки интерфейса.');
  window.dispatchEvent(new Event(INTERFACE_EVENT));
}

export function useInterfaceSettings() {
  const [settings, setSettings] = useState(interfaceSettings);

  useLayoutEffect(() => {
    const update = () => setSettings(interfaceSettings());

    window.addEventListener(INTERFACE_EVENT, update);
    window.addEventListener('storage', update);

    return () => {
      window.removeEventListener(INTERFACE_EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, []);

  return settings;
}
