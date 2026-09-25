// An AbortSignal that knows how many listeners are attached to it right now (T348).
// The long-running loops race every tick against the SERVER signal, which fires only
// at shutdown — so a listener that is not detached after its tick is never freed.
// Tests read `attached()` mid-loop: it must stay flat, whatever the tick count.

export interface CountedSignal {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  /** Listeners added and not yet removed. */
  attached(): number;
}

export function countedSignal(): CountedSignal {
  const controller = new AbortController();
  const { signal } = controller;
  const live = new Set<unknown>();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, listener: EventListener, options?: unknown) => {
    live.add(listener);
    add(type, listener, options as AddEventListenerOptions);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, listener: EventListener, options?: unknown) => {
    live.delete(listener);
    remove(type, listener, options as EventListenerOptions);
  }) as typeof signal.removeEventListener;
  return { controller, signal, attached: () => live.size };
}
