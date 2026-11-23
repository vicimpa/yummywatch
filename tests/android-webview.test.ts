import { expect, it } from 'vitest';
import { installAndroidWebViewCompatibility } from '~/lib/android-webview';

it('checks live and cancelled requests on Android WebView without throwIfAborted', () => {
  const prototype = AbortSignal.prototype;
  const native = Object.getOwnPropertyDescriptor(prototype, 'throwIfAborted');
  Reflect.deleteProperty(prototype, 'throwIfAborted');

  try {
    installAndroidWebViewCompatibility();
    const request = new AbortController();

    expect(() => request.signal.throwIfAborted()).not.toThrow();
    request.abort();
    expect(() => request.signal.throwIfAborted()).toThrow(
      expect.objectContaining({ name: 'AbortError' })
    );
  } finally {
    if (native) Object.defineProperty(prototype, 'throwIfAborted', native);
    else Reflect.deleteProperty(prototype, 'throwIfAborted');
  }
});
