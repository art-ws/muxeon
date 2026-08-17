// The React side of reactions (§19.9, FR-168): one context so a bubble can render
// its badges without every component between App and Bubble having to carry them.
// The default is "off" — a panel served by a server with no reaction catalog
// (§19.2) renders no picker and no bar at all.

import { createContext, useContext } from "react";
import type { ReactionView } from "./types";

export interface ReactionsApi {
  /** Does this server declare a palette (§19.2)? Off ⇒ no trigger is drawn. */
  readonly enabled: boolean;
  /** The folded state of one message (§19.5). */
  reactionsOf(messageId: string): readonly ReactionView[];
  /** A placement/removal came back — fold the server's answer into the panel state. */
  onChanged(messageId: string, reactions: readonly ReactionView[]): void;
}

const OFF: ReactionsApi = {
  enabled: false,
  reactionsOf: () => [],
  onChanged: () => undefined,
};

export const ReactionsContext = createContext<ReactionsApi>(OFF);

export const useReactions = (): ReactionsApi => useContext(ReactionsContext);
