import { signal } from '@preact/signals';
import { WATCH_LISTS } from './lists';

export function canonicalPath(path: string) {
  const [route, query] = path.split('?');
  if (route !== '/library') return path;
  const tab = new URLSearchParams(query).get('tab');
  if (tab === 'history' || tab === 'subscriptions') return `/profile?tab=${tab}`;
  const list = tab === 'favorites' || WATCH_LISTS.some(list => list.alias === tab) ? tab : null;
  return `/profile?tab=collection${list ? `&list=${list}` : ''}`;
}

export const navigation = signal({ canBack: false, canForward: false });
let session = '';
let index = 0;
let maximum = 0;
let path = '/';
const marker = () =>
  history.state?.yumiwatchNavigation as
    { session: string; index: number; from?: string } | undefined;
const currentPath = () => canonicalPath(location.hash.slice(1) || '/');

function publish() {
  navigation.value = { canBack: index > 0, canForward: index < maximum };
  try {
    sessionStorage.setItem('yumiwatch:navigation', JSON.stringify({ session, maximum }));
  } catch {
    /* Optional across reloads. */
  }
}
function mark(from?: string) {
  history.replaceState({ ...history.state, yumiwatchNavigation: { session, index, from } }, '');
}
export function initializeNavigation() {
  let saved: { session?: string; maximum?: number } = {};
  try {
    saved = JSON.parse(sessionStorage.getItem('yumiwatch:navigation') || '{}');
  } catch {
    /* New navigation session. */
  }
  const current = marker();
  session = saved?.session || globalThis.crypto?.randomUUID?.() || String(Date.now());
  index = current?.session === session && Number.isSafeInteger(current.index) ? current.index : 0;
  maximum = current?.session === session ? Math.max(index, saved?.maximum || 0) : 0;
  path = currentPath();
  mark(current?.session === session ? current.from : undefined);
  publish();
}
export function recordNavigation() {
  const previous = index;
  const current = marker();
  if (current?.session === session && Number.isSafeInteger(current.index)) index = current.index;
  else {
    index++;
    maximum = index;
    mark(path);
  }
  path = currentPath();
  publish();
  return index < previous ? 'back' : index > previous ? 'forward' : undefined;
}
export function navigateBack(fallback = '/') {
  if (navigation.value.canBack) history.back();
  else if (location.hash !== `#${fallback}`) location.hash = fallback;
}
export function navigateForward() {
  if (navigation.value.canForward) history.forward();
}

export function leavePlayback(destination: string) {
  const target = destination.startsWith('#') ? destination.slice(1) : destination;
  const aboutPath = (value: string) => value.replace(/\?view=anime-about$/, '');
  const from = marker()?.from;
  if (navigation.value.canBack && from && aboutPath(from) === aboutPath(target)) {
    history.back();
    return;
  }
  if (location.hash === `#${target}`) return;
  const oldURL = location.href;
  // Keep this entry in the history stack and notify the hash router.
  history.replaceState(history.state, '', `#${target}`);
  window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: location.href }));
}
