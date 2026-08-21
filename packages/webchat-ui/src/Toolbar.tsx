// The topbar toolbar (§12.10, FR-172, T279): the tools the user pinned in
// Settings, printed as icon buttons in the right-hand block of the header —
// tools → filter field → account circle (§12.10.7-Q4). A button is a SHORTCUT
// to a menu item, so it repeats that item exactly: same icon, same wording, same
// availability (tools.ts owns all three) and the same deliberateness — every
// item that arms in its menu arms here, and Sign out arms too, because there the
// deliberate first step was opening the menu (FR-68) and a topbar button has no
// such step.
//
// Nothing here talks to a new endpoint: the buttons call the very API the menu
// items call (FR-65/FR-84/FR-120/FR-160, POST /api/logout).

import { useEffect, useState } from "react";
import { ConsoleDialog } from "./Console";
import { agentAction, clearHistory, exportHistoryUrl, setAgentPaused } from "./api";
import { useT } from "./i18n-context";
import { IconPlay } from "./icons";
import { peerLabel } from "./peer-surface";
import { type Tool, type ToolId, visibleTools } from "./tools";
import type { PeerInfo } from "./types";

export function Toolbar(props: {
  /** The pinned set (FR-174) — the Settings switches own it. */
  enabled: ReadonlySet<ToolId>;
  /**
   * The open 1:1 chat's peer (§12.10.5), lifted here from the panel; undefined
   * when no chat is open — then no chat tool renders at all (§12.10.7-Q1: the
   * unavailable is HIDDEN, never printed dead).
   */
  peer: PeerInfo | undefined;
  /**
   * The two SIDEBAR view toggles (FR-177): the agent-filter panel (FR-176) and
   * the Transport entry (T115). Their buttons are two-state ones — each shows
   * whether its thing is up and asks for the opposite, like Pause does — and the
   * state itself belongs to the very pref the matching Settings switch writes.
   */
  agentFilter?: boolean;
  onAgentFilter?: (show: boolean) => void;
  transport?: boolean;
  onTransport?: (show: boolean) => void;
  /**
   * The viewer's role (FR-131) — the journal shortcut is admin-only (T291). Named
   * `viewerRole`, not `role`: on a JSX element that word is the ARIA attribute.
   */
  viewerRole?: "admin" | "user";
  onSettings: () => void;
  /** Opens the prompt rack page (§20.6, FR-187) — the account-menu item's shortcut. */
  onPrompts?: (() => void) | undefined;
  onLogout: () => void;
}): React.JSX.Element {
  const t = useT();
  const peer = props.peer;
  // The console holds the NAME it attached to, not the peer object (T281): the
  // popup must survive everything that can shake the object under it — a status
  // push rebuilding it, the peer briefly missing from a refreshed list, the bar
  // itself going empty. It closes when the user opens a DIFFERENT chat, and on
  // the ✕; "no chat open" is not a reason to tear down a live terminal someone
  // is working in (§12.9).
  const [consolePeer, setConsolePeer] = useState<string | undefined>(undefined);
  const openName = peer?.name;
  useEffect(() => {
    if (openName === undefined) return;
    setConsolePeer((current) =>
      current === undefined || current === openName ? current : undefined,
    );
  }, [openName]);

  const tools = visibleTools(props.enabled, peer, {
    ...(props.viewerRole !== undefined ? { role: props.viewerRole } : {}),
  });

  // A chat tool says WHOM it will act on; a panel tool says what it does.
  const titleOf = (tool: Tool): string =>
    tool.scope === "chat"
      ? `${t(tool.label)} — ${peerLabel(peer)}`
      : `${t(tool.label)} — ${t(tool.hint)}`;

  // The view toggles (FR-177): what they show now, and what the next click does.
  // Both halves live here so a toggle cannot end up lit with the wrong wording.
  const toggleOf = (tool: Tool): { on: boolean; label: string } | undefined => {
    switch (tool.id) {
      case "agent-filter": {
        const on = props.agentFilter === true;
        return { on, label: t(on ? "Hide the agent filter" : "Show the agent filter") };
      }
      case "transport": {
        const on = props.transport === true;
        return { on, label: t(on ? "Hide the Transport page" : "Show the Transport page") };
      }
      default:
        return undefined;
    }
  };

  const run = (tool: Tool): (() => Promise<unknown>) => {
    const name = peer?.name ?? "";
    switch (tool.id) {
      case "console":
        return async () => {
          if (name !== "") setConsolePeer(name);
        };
      case "clear":
        return () => clearHistory(name);
      case "reload":
        return () => agentAction(name, "reload");
      case "shutdown":
        return () => agentAction(name, "shutdown");
      case "agent-filter":
        return async () => props.onAgentFilter?.(props.agentFilter !== true);
      case "transport":
        return async () => props.onTransport?.(props.transport !== true);
      case "prompts":
        return async () => props.onPrompts?.();
      case "settings":
        return async () => props.onSettings();
      case "logout":
        return async () => props.onLogout();
      default:
        return async () => undefined;
    }
  };

  return (
    <>
      {/* The group disappears when nothing is pinned or nothing applies — but the
          console popup below is its SIBLING, not its child (T281): an empty bar
          must not tear down a terminal. */}
      {tools.length > 0 && (
        <span className="topbar-tools" role="toolbar" aria-label={t("Toolbar")}>
          {tools.map((tool) => {
            // Export is a plain download link, exactly as in the menu (FR-84): no
            // confirm, no JS — an <a download> styled like its neighbours.
            if (tool.id === "export" && peer !== undefined) {
              return (
                <a
                  key={tool.id}
                  className="tool-button"
                  href={exportHistoryUrl(peer.name)}
                  download
                  title={titleOf(tool)}
                  aria-label={titleOf(tool)}
                >
                  <tool.icon size={16} />
                </a>
              );
            }
            // Pause carries STATE (§16.4, FR-120): the button shows what the peer is
            // now and asks for the opposite — never a blind toggle.
            if (tool.id === "pause" && peer !== undefined) {
              const paused = peer.paused === true;
              const label = t(paused ? "Resume" : "Pause");
              return (
                <ToolButton
                  key={tool.id}
                  tool={tool}
                  label={label}
                  title={`${label} — ${peerLabel(peer)}`}
                  icon={paused ? <IconPlay size={16} /> : <tool.icon size={16} />}
                  onRun={() => setAgentPaused(peer.name, !paused)}
                />
              );
            }
            // A view toggle carries STATE (FR-177): the button is lit while its
            // thing is on screen and its tooltip names the NEXT click — a toggle
            // that looks the same in both states is a coin flip.
            const toggle = toggleOf(tool);
            if (toggle !== undefined) {
              return (
                <ToolButton
                  key={tool.id}
                  tool={tool}
                  label={toggle.label}
                  title={toggle.label}
                  icon={<tool.icon size={16} />}
                  pressed={toggle.on}
                  onRun={run(tool)}
                />
              );
            }
            return (
              <ToolButton
                key={tool.id}
                tool={tool}
                label={t(tool.label)}
                title={titleOf(tool)}
                icon={<tool.icon size={16} />}
                onRun={run(tool)}
              />
            );
          })}
        </span>
      )}
      {consolePeer !== undefined && (
        <ConsoleDialog peer={consolePeer} onClose={() => setConsolePeer(undefined)} />
      )}
    </>
  );
}

// One toolbar button. Icon-only, so the wording lives in title/aria-label and
// the STATES speak through paint: armed (a destructive or lifecycle action
// waiting for its second click, 3s), busy, failed (4s). The behavior mirrors
// the menu's LifecycleItem — a shortcut is never safer than its item.
function ToolButton(props: {
  tool: Tool;
  /** Already translated — Pause/Resume differ per state. */
  label: string;
  title: string;
  icon: React.JSX.Element;
  /** A toggle's current state (FR-177): lit paint + `aria-pressed`. */
  pressed?: boolean;
  onRun: () => Promise<unknown>;
}): React.JSX.Element {
  const t = useT();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const confirm = props.tool.confirm === true;

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);

  const click = async (): Promise<void> => {
    if (busy) return;
    if (confirm && !armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    setBusy(true);
    setFailed(undefined);
    try {
      await props.onRun();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "failed");
      setTimeout(() => setFailed(undefined), 4000);
    } finally {
      setBusy(false);
    }
  };

  const state = failed !== undefined ? " failed" : armed ? " armed" : "";
  const danger = props.tool.danger === true ? " danger" : "";
  const lit = props.pressed === true ? " active" : "";
  const title = failed ?? (armed ? `${props.label} — ${t("Sure?")}` : props.title);
  return (
    <button
      type="button"
      className={`tool-button${danger}${lit}${state}`}
      disabled={busy}
      aria-label={props.title}
      aria-pressed={confirm ? armed : props.pressed}
      title={title}
      onClick={() => void click()}
    >
      {busy ? "…" : props.icon}
    </button>
  );
}
