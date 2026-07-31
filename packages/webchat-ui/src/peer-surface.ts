// What a peer's chrome looks like — the ONE place that maps a peer to its
// surface, so the sidebar row and the chat header can never drift apart (they
// did: a user chat used to open as a broadcast-tag view while its row already
// rendered as a person). DOM-free, so `bun test` covers the rules.
//
// Three surfaces (§12.7, §15, §17.7):
//   agent     — a session: status dot, "thinking…", token meter, console
//               (slash commands / raw mode / Screen Live), lifecycle actions;
//   person    — a user (§17.7), oneself included (self-chat, FR-128): an
//               ordinary 1:1 chat with a presence dot (FR-133) instead of a
//               status; no session ⇒ no console, no tokens, no lifecycle —
//               the only action is DND (§17.8, FR-134);
//   broadcast — a group/tag (§15): input-only fan-out target, no status at all.

import { type PeerInfo, peerKind } from "./types";

export type ChatSurface = "agent" | "person" | "broadcast";

/**
 * The surface a peer is rendered with. An unknown peer (not loaded yet — a deep
 * link opens before /api/peers answers) is treated as an agent: that is the
 * full-chrome default the panel has always shown while loading.
 */
export function chatSurface(peer: PeerInfo | undefined): ChatSurface {
  if (peer === undefined) return "agent";
  switch (peerKind(peer)) {
    case "user":
      return "person";
    case "group":
    case "tag":
      return "broadcast";
    default:
      return "agent";
  }
}

/** Whether this peer has a console behind it: raw mode, slash commands, Screen Live. */
export const hasConsole = (peer: PeerInfo | undefined): boolean => chatSurface(peer) === "agent";

/**
 * The row's / header's status line and tooltip (§16.6, FR-120). A paused peer
 * SHOWS "paused" — that is the state the operator acted on — while the real
 * session status stays visible in the tooltip ("paused · idle"): the marker must
 * not lie about the session. For a person "paused" is DND (§17.8).
 */
export function statusLabel(peer: PeerInfo | undefined): string {
  if (peer === undefined) return "—";
  if (peer.paused === true) return "paused";
  // A person has no session: presence answers "are they around" (FR-133).
  if (chatSurface(peer) === "person") return peer.presence === "online" ? "online" : "offline";
  switch (peer.status) {
    case "idle":
      return "idle";
    case "busy":
      return "busy…";
    case "down":
      return "down";
    default:
      return "—";
  }
}

/** The status line WITHOUT the pause override — the tooltip's second half. */
export function liveLabel(peer: PeerInfo | undefined): string {
  if (peer === undefined) return "—";
  return statusLabel({ ...peer, paused: false });
}

/**
 * The activity dot's class: an agent shows its session status, a person their
 * presence (FR-133) — the same dot in the same place, so the sidebar and the
 * chat header read uniformly; `paused` mutes either of them (§16.6/FR-134 DND).
 */
export function dotClass(peer: PeerInfo | undefined): string {
  const state =
    peer === undefined
      ? "unknown"
      : chatSurface(peer) === "person"
        ? (peer.presence ?? "offline")
        : (peer.status ?? "unknown");
  return `status-dot ${state}${peer?.paused === true ? " paused" : ""}`;
}
