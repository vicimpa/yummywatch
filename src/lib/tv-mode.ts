export const isTvMode = () => document.documentElement.dataset.tv === 'true';

export const isTvTextInput = (type = 'text') =>
  isTvMode() && ['text', 'search', 'password', 'email', 'url', 'tel', 'number'].includes(type);

export type TvEpisodeControl = 'previous' | 'next';
