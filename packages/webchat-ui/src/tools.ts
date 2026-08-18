// The customizable header toolbar (§12.10, FR-171/FR-174, T279): the CLOSED
// catalogue of tools a user may pin into the topbar, plus the pure logic around
// it — what the open surface allows, what the user turned on, how the choice
// persists. Declared in CODE, not in config: a tool carries a handler, an icon
// and a translation string, unlike the reactions catalog (§19.2) where the key
// and the caption really are data.
//
// ONE SOURCE (FR-171): the label, the icon and the availability predicate here
// are the SAME ones the menu item uses — a pinned tool is a SHORTCUT to that
// item, never a second implementation of it, and pinning never takes the item
// out of its menu. The catalogue v1 is exactly the two menus the operator named
// (§12.10.7-Q3): the chat kebab and the account menu.
//
// DOM-free (the persisted half takes an injectable storage, like visibility.ts)
// so `bun test` covers the rules without a browser. The file is `tools.ts` and
// not `toolbar.ts` on purpose: `Toolbar.tsx` renders it, and on a
// case-insensitive filesystem the two names are ONE module specifier.

import {
  IconDownload,
  IconGear,
  IconMonitor,
  IconPause,
  IconPower,
  IconRotate,
  IconTrash,
} from "./icons";
import { chatSurface, hasConsole } from "./peer-surface";
import type { PeerInfo } from "./types";

export type ToolId =
  | "console"
  | "export"
  | "clear"
  | "pause"
  | "reload"
  | "shutdown"
  | "settings"
  | "logout";

/** `chat` acts on the OPEN peer; `panel` acts on the panel / oneself. */
export type ToolScope = "chat" | "panel";

export interface Tool {
  /** Stable persistence key — never reused once a tool leaves the catalogue. */
  readonly id: ToolId;
  readonly scope: ToolScope;
  /** The SAME t() string its menu item prints — the two cannot drift (T223). */
  readonly label: string;
  /** What it does and to whom: the button tooltip and the settings-row hint. */
  readonly hint: string;
  readonly icon: (props: { size?: number }) => React.JSX.Element;
  /** Destructive — danger paint on the button and the settings row. */
  readonly danger?: boolean;
  /**
   * Arms on the first click and fires on the second (FR-172). Every item that
   * asks for a deliberate second step in its MENU asks for it here too: a
   * shortcut may not be SAFER than the item it repeats — and `logout` arms even
   * though its menu item does not, because there the deliberate first step was
   * opening the menu (FR-68), which a topbar button does not have.
   */
  readonly confirm?: boolean;
  /**
   * Offered exactly when the kebab item would be (FR-172) — the predicate IS the
   * menu's. `undefined` = no 1:1 chat open ⇒ no chat tool at all; a broadcast
   * target (§15.6) has neither status nor lifecycle, so it counts as no chat.
   */
  readonly available: (peer: PeerInfo | undefined) => boolean;
}

/** A 1:1 chat (agent or person) is open — the precondition of every chat tool. */
const inChat = (peer: PeerInfo | undefined): peer is PeerInfo =>
  peer !== undefined && chatSurface(peer) !== "broadcast";

/**
 * The catalogue, in the order the toolbar and the settings list print it — the
 * order of the two menus themselves. Adding a tool = one entry here.
 */
export const TOOLS: readonly Tool[] = [
  {
    id: "console",
    scope: "chat",
    label: "Console",
    hint: "the agent's live terminal — watch it and type into it",
    icon: IconMonitor,
    available: (peer) => inChat(peer) && hasConsole(peer),
  },
  {
    id: "export",
    scope: "chat",
    label: "Export JSON",
    hint: "the chat history",
    icon: IconDownload,
    available: inChat,
  },
  {
    id: "clear",
    scope: "chat",
    label: "Clear chat",
    hint: "the chat history",
    icon: IconTrash,
    danger: true,
    confirm: true,
    available: inChat,
  },
  {
    id: "pause",
    scope: "chat",
    // The label and the icon FOLLOW the state (Pause ⇄ Resume), exactly as the
    // menu item does — the toolbar renders the pair, the catalogue names the
    // resting side of it.
    label: "Pause",
    hint: "block/unblock message delivery to this agent",
    icon: IconPause,
    available: (peer) => inChat(peer) && peer.actions?.pause === true,
  },
  {
    id: "reload",
    scope: "chat",
    label: "Reload",
    hint: "restart the agent's session",
    icon: IconRotate,
    confirm: true,
    available: (peer) => inChat(peer) && peer.actions?.reload === true,
  },
  {
    id: "shutdown",
    scope: "chat",
    label: "Shutdown",
    hint: "stop the agent's session",
    icon: IconPower,
    danger: true,
    confirm: true,
    available: (peer) => inChat(peer) && peer.actions?.shutdown === true,
  },
  {
    id: "settings",
    scope: "panel",
    label: "Settings",
    hint: "open the settings page",
    icon: IconGear,
    available: () => true,
  },
  {
    id: "logout",
    scope: "panel",
    label: "Sign out",
    hint: "sign out of the panel",
    icon: IconPower,
    danger: true,
    confirm: true,
    available: () => true,
  },
];

const IDS = new Set<string>(TOOLS.map((tool) => tool.id));
const isToolId = (value: unknown): value is ToolId => typeof value === "string" && IDS.has(value);

/**
 * Nothing is pinned out of the box (§12.10.7-Q2): a fresh browser shows the
 * topbar exactly as it looked before the feature, and no action lands one click
 * away without the user asking for it.
 */
export const DEFAULT_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>();

/** What the toolbar prints now: enabled ∩ available, in catalogue order. */
export function visibleTools(
  enabled: ReadonlySet<ToolId>,
  peer: PeerInfo | undefined,
): readonly Tool[] {
  return TOOLS.filter((tool) => enabled.has(tool.id) && tool.available(peer));
}

/**
 * Do these two peers give the toolbar the same buttons (T280)? The panel hands
 * the open peer up on every store change — a status push, a queue tick, a token
 * sample all rebuild the object — but the BAR only reads these fields. Comparing
 * them lets the lift keep the previous object, so the header (and everything
 * under it) does not re-render on traffic that cannot change a button.
 */
export function sameToolSurface(a: PeerInfo | undefined, b: PeerInfo | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.name === b.name &&
    a.title === b.title &&
    a.type === b.type &&
    a.server === b.server &&
    a.paused === b.paused &&
    a.actions?.shutdown === b.actions?.shutdown &&
    a.actions?.reload === b.actions?.reload &&
    a.actions?.pause === b.actions?.pause
  );
}

/** Immutable check/uncheck of one tool (the settings switches). */
export function toggleTool(enabled: ReadonlySet<ToolId>, id: ToolId): ReadonlySet<ToolId> {
  const next = new Set(enabled);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

const KEY = "muxeon-pref:toolbar";

interface ToolbarStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The pinned set (FR-174). Anything that is not a JSON array of KNOWN ids falls
 * back to the default: a tool dropped from the catalogue in a later version must
 * not leave a hole in the bar, and junk or a blocked storage must not break the
 * panel — the same discipline as prefs.ts / visibility.ts.
 */
export function loadToolbar(storage: ToolbarStorage = localStorage): ReadonlySet<ToolId> {
  try {
    const raw = storage.getItem(KEY);
    if (raw === null) return DEFAULT_TOOLS;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_TOOLS;
    return new Set(parsed.filter(isToolId));
  } catch {
    return DEFAULT_TOOLS; // junk JSON or blocked storage (private mode etc.)
  }
}

/** Best-effort persist — the session still gets the toolbar either way. */
export function saveToolbar(
  enabled: ReadonlySet<ToolId>,
  storage: ToolbarStorage = localStorage,
): void {
  try {
    // catalogue order, so the stored value reads like the bar it describes
    storage.setItem(
      KEY,
      JSON.stringify(TOOLS.filter((tool) => enabled.has(tool.id)).map((tool) => tool.id)),
    );
  } catch {
    // not persisted — the choice still holds for the session
  }
}
