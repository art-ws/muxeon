// Adapter registry (§8.2/§8.3): resolves a config `type` to its singleton adapter.
// An unknown type is normally caught earlier by config validation (§7.5, T05); the
// registry is the runtime source of truth for the known types it passes there.

import { createAutoAdapter } from "./auto";
import { type ClaudeAdapterOptions, createClaudeAdapter } from "./claude";
import { createCodexAdapter } from "./codex";
import type { Adapter } from "./contract";

/** Adapter types built in at baseline (for config §7.5 "type is a known adapter"). */
export const BASELINE_ADAPTER_TYPES = ["claude", "codex", "auto"] as const;

export class AdapterRegistry {
  readonly #byType = new Map<string, Adapter>();

  constructor(adapters: Iterable<Adapter>) {
    for (const adapter of adapters) {
      if (this.#byType.has(adapter.type)) {
        throw new Error(`duplicate adapter type: ${adapter.type}`);
      }
      this.#byType.set(adapter.type, adapter);
    }
  }

  has(type: string): boolean {
    return this.#byType.has(type);
  }

  get(type: string): Adapter {
    const adapter = this.#byType.get(type);
    if (adapter === undefined) throw new Error(`unknown adapter type: ${type}`);
    return adapter;
  }

  /** Registered types, sorted — pass to config validation as knownAdapterTypes. */
  types(): string[] {
    return [...this.#byType.keys()].sort();
  }
}

export function createDefaultRegistry(options: ClaudeAdapterOptions): AdapterRegistry {
  // All console adapters share the same option shape (stateDir + blobsDir); an
  // agent's config `type` picks which one at runtime (bootstrap registry.get).
  // `auto` handles either claude or codex without pinning the runtime.
  return new AdapterRegistry([
    createClaudeAdapter(options),
    createCodexAdapter(options),
    createAutoAdapter(options),
  ]);
}
