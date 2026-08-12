// Shared lifecycle context (§4): what every lifecycle operation acts on (an
// AgentTarget) and the transport surface it acts through (a SessionControl port).
//
// SessionControl is the narrow tmux surface lifecycle needs — has/new/kill-session
// plus literal/key injection for slash commands (§4, FR-9). It is a port so the
// operations are unit-testable with a fake control, exactly as the dispatcher does
// with SessionDriver (§8.2); tmuxSessionControl is the real, tmux-backed default.

import type { Adapter } from "@muxeon/adapters";
import type { AgentConfig } from "@muxeon/config";
import type { AgentState } from "@muxeon/orchestrator";
import {
  type NewSessionOptions,
  capturePane,
  hasSession,
  killSession,
  newSession,
  sendKeys,
  sendLiteral,
} from "@muxeon/tmux";

export type { NewSessionOptions };

/** The tmux surface lifecycle drives. Injectable so operations are unit-testable. */
export interface SessionControl {
  hasSession(name: string): Promise<boolean>;
  newSession(name: string, options: NewSessionOptions): Promise<void>;
  killSession(name: string): Promise<void>;
  sendLiteral(name: string, text: string): Promise<void>;
  sendKeys(name: string, ...keys: string[]): Promise<void>;
  /** Visible pane as-is — the slash-command output capture (FR-66). */
  capturePane(name: string): Promise<string>;
}

/** The real tmux-backed control surface (§4, FR-5). */
export const tmuxSessionControl: SessionControl = {
  hasSession,
  newSession,
  killSession,
  sendLiteral,
  sendKeys,
  capturePane: (name) => capturePane(name),
};

/**
 * The agent a lifecycle operation targets: its config (name/tmux/cwd/provision,
 * §7.1), its type's adapter (slashCommand, §8.3), and its live status
 * cell (§5.1), which the operation transitions as a side effect.
 */
export interface AgentTarget {
  readonly agent: AgentConfig;
  readonly adapter: Adapter;
  readonly state: AgentState;
}
