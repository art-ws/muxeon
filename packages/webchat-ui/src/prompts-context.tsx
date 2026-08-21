// The React side of the prompt rack (§20, FR-185…FR-187): ONE loaded copy of the
// library, shared by the composer's two menu items and the rack page, so the two
// surfaces can never show different shelves.
//
// The rack is pulled, never pushed (§20.3): there is no WS event for it. A
// refresh happens where a stale list would be visible — when the composer submenu
// opens, and when the page mounts — and every mutation answers with the whole rack,
// so nothing is merged on this side.

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import * as api from "./api";
import type { PromptLibrary, PromptShelf } from "./types";

export interface PromptsApi {
  /** Is the rack wired at all? A server without it (503) offers no items and no page. */
  readonly enabled: boolean;
  /** The shelves as last read; empty until the first refresh lands. */
  readonly shelves: readonly PromptShelf[];
  /** The last read/write failure, already stringified for the surface. */
  readonly error: string | undefined;
  /** Pull the rack (menu open, page mount). Failures land in `error`, never thrown. */
  refresh(): Promise<void>;
  /** The six mutations (§20.3); they REJECT on refusal so a dialog can show why. */
  /** Resolves to the NEW shelf's id — "save onto a new shelf" needs it in one act. */
  createShelf(name: string): Promise<string>;
  renameShelf(id: string, name: string): Promise<void>;
  moveShelf(id: string, position: number): Promise<void>;
  removeShelf(id: string): Promise<void>;
  addPrompt(draft: { shelf: string; name: string; text: string }): Promise<void>;
  editPrompt(
    id: string,
    patch: { name?: string; text?: string; shelf?: string; position?: number },
  ): Promise<void>;
  removePrompt(id: string): Promise<void>;
}

const OFF: PromptsApi = {
  enabled: false,
  shelves: [],
  error: undefined,
  refresh: async () => undefined,
  createShelf: async () => "",
  renameShelf: async () => undefined,
  moveShelf: async () => undefined,
  removeShelf: async () => undefined,
  addPrompt: async () => undefined,
  editPrompt: async () => undefined,
  removePrompt: async () => undefined,
};

export const PromptsContext = createContext<PromptsApi>(OFF);

export const usePrompts = (): PromptsApi => useContext(PromptsContext);

/**
 * Builds the api over live state. Kept as a hook (not a component) so App owns the
 * provider exactly as it owns the reactions one — one place that knows the panel's
 * shared state.
 */
export function usePromptRack(): PromptsApi {
  const [library, setLibrary] = useState<PromptLibrary | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  // A 503 means the server has no rack (§20.3). The composer then prints no rack
  // items at all rather than offering a menu that always fails.
  const [enabled, setEnabled] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setLibrary(await api.fetchPromptLibrary());
      setError(undefined);
    } catch (failure) {
      if (failure instanceof api.ApiError && failure.status === 503) {
        setEnabled(false);
        setError(undefined);
        return;
      }
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  // A mutation's answer IS the new rack, so applying it needs no merge; the
  // rejection travels on so the caller's dialog can keep the field open (§20.4).
  const apply = useCallback(async (op: Promise<PromptLibrary>): Promise<PromptLibrary> => {
    try {
      const next = await op;
      setLibrary(next);
      setError(undefined);
      return next;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      throw failure;
    }
  }, []);

  return useMemo(
    () => ({
      enabled,
      shelves: library?.shelves ?? [],
      error,
      refresh,
      createShelf: async (name) => {
        const next = await apply(api.createShelf(name));
        // The server issues ids, so the new shelf is found by the name it just
        // accepted (normalized the same way on both sides, §20.2).
        const folded = name.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
        return next.shelves.find((shelf) => shelf.name.toLocaleLowerCase() === folded)?.id ?? "";
      },
      renameShelf: (id, name) => apply(api.updateShelf(id, { name })).then(() => undefined),
      moveShelf: (id, position) => apply(api.updateShelf(id, { position })).then(() => undefined),
      removeShelf: (id) => apply(api.deleteShelf(id)).then(() => undefined),
      addPrompt: (draft) => apply(api.createPrompt(draft)).then(() => undefined),
      editPrompt: (id, patch) => apply(api.updatePrompt(id, patch)).then(() => undefined),
      removePrompt: (id) => apply(api.deletePrompt(id)).then(() => undefined),
    }),
    [enabled, library, error, refresh, apply],
  );
}
