function abortWithReason(controller: AbortController, reason: unknown) {
  if (!('reason' in AbortSignal.prototype))
    Object.defineProperty(controller.signal, 'reason', { value: reason });
  controller.abort(reason);
}

export function installAndroidWebViewCompatibility() {
  if (typeof Array.prototype.at !== 'function')
    Object.defineProperty(Array.prototype, 'at', {
      configurable: true,
      writable: true,
      value<T>(this: T[], index: number) {
        const offset = Math.trunc(Number(index)) || 0;
        const position = offset < 0 ? this.length + offset : offset;
        return position >= 0 && position < this.length ? this[position] : undefined;
      },
    });

  if (typeof AbortSignal.timeout !== 'function')
    AbortSignal.timeout = milliseconds => {
      const controller = new AbortController();
      setTimeout(
        () =>
          abortWithReason(controller, new DOMException('The request timed out.', 'TimeoutError')),
        milliseconds
      );
      return controller.signal;
    };

  if (typeof AbortSignal.prototype.throwIfAborted !== 'function')
    Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', {
      configurable: true,
      writable: true,
      value(this: AbortSignal) {
        if (this.aborted)
          throw this.reason ?? new DOMException('The request was aborted.', 'AbortError');
      },
    });

  if (typeof AbortSignal.any !== 'function')
    AbortSignal.any = signals => {
      const controller = new AbortController();
      const sources = Array.from(signals);
      const listeners = sources.map(signal => () => {
        sources.forEach((source, index) => source.removeEventListener('abort', listeners[index]));
        abortWithReason(
          controller,
          signal.reason ?? new DOMException('The request was aborted.', 'AbortError')
        );
      });
      const aborted = sources.findIndex(signal => signal.aborted);
      if (aborted >= 0) listeners[aborted]();
      else
        sources.forEach((source, index) =>
          source.addEventListener('abort', listeners[index], { once: true })
        );
      return controller.signal;
    };
}
