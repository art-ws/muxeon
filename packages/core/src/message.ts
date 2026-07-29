import type { Signal } from "./signal";

// Message — the baseline signal kind (§2, §5.3): a Signal whose `kind` is
// "message". As new kinds are added (R3), Message stays pinned to "message".
export interface Message extends Signal {
  readonly kind: "message";
}

export function isMessage(signal: Signal): signal is Message {
  return signal.kind === "message";
}
