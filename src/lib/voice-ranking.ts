import { getSession } from './session';
import { readJSON, writeJSON } from './storage';
import { groupVoices, voiceKey } from './streams';
import type { Video } from './types';

export const VOICE_RANKING_EVENT = 'yumiwatch:voice-ranking';
export type VoiceChoice = 'explicit' | 'default' | 'ranked';

type VoiceScore = { name: string; choices: number; watched: number; learned: number };
type Ranking = { enabled: boolean; voices: Record<string, VoiceScore> };

function key() {
  const id = getSession()?.user.id;
  return `yumiwatch:voice-ranking:v1:${id ? `account:${id}` : 'guest'}`;
}

function read() {
  return readJSON<Ranking>(key(), { enabled: true, voices: {} });
}

function write(value: Ranking) {
  if (writeJSON(key(), value)) window.dispatchEvent(new Event(VOICE_RANKING_EVENT));
}

const score = (value?: VoiceScore) => (value?.choices || 0) * 900 + (value?.learned || 0);

export function voiceRanking() {
  const value = read();
  return {
    enabled: value.enabled,
    voices: Object.values(value.voices).sort(
      (a, b) => score(b) - score(a) || a.name.localeCompare(b.name, 'ru')
    ),
  };
}

export function setVoiceRanking(enabled: boolean) {
  write({ ...read(), enabled });
}

export function resetVoiceRanking() {
  write({ ...read(), voices: {} });
}

export function trackVoice(name: string, seconds: number, choice: VoiceChoice, vote: boolean) {
  const value = read();
  if (!value.enabled || !Number.isFinite(seconds) || seconds <= 0) return;
  const id = voiceKey(name);
  const old = value.voices[id] || { name: name || 'Оригинал', choices: 0, watched: 0, learned: 0 };
  value.voices[id] = {
    ...old,
    choices: old.choices + Number(vote && choice === 'explicit'),
    watched: old.watched + seconds,
    learned: old.learned + (choice === 'ranked' ? 0 : seconds),
  };
  write(value);
}

export const firstEpisode = (videos: Video[]) =>
  [...videos].sort(
    (a, b) => a.number.localeCompare(b.number, 'ru', { numeric: true }) || a.index - b.index
  )[0];

export function rankedStart(videos: Video[]) {
  const value = read();
  if (!value.enabled || !Object.values(value.voices).some(voice => score(voice) > 0)) return;
  const episode = firstEpisode(videos)?.number;
  const choices = groupVoices(videos.filter(video => video.number === episode));
  choices.sort((a, b) => score(value.voices[b.key]) - score(value.voices[a.key]));
  const best = choices[0];
  if (best && score(value.voices[best.key]) > 0) return best.videos[0];
}
