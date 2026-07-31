// Sidebar (§12.7, FR-68): one entry per topology neighbor (§10.2) — live status,
// queue depth, unread badge, last-message preview. The logged-in user's OWN row
// (self-chat, §17.7/FR-128) is one of them: the server ships it inside `peers`,
// so it sorts and renders like every other user row — no pinned special case.
// Two layouts off ONE list:
// expanded rows with text, or a collapsed icon rail (initial-letter buttons with
// the same live status dot / unread badge); the logo in the topbar toggles them.
// Agent colors (T99, FR-73): the accent paints the collapsed avatar circle and,
// unobtrusively, a thin left edge of the expanded row.
// Groups & tags (§15, FR-106/FR-107): the rows above the account footer are a
// broadcast TREE — top-level groups and groupless agents at the root, child
// groups and agent leaves nested (tree.ts). A group row carries a chevron
// (expand/collapse, persisted) and a folder icon, NO status/queue/unread — it is
// an input-only broadcast target. Below the tree, a collapsible "Tags" section
// lists the flat tag targets. The collapsed rail mirrors the SAME visible rows
// 1:1 (one glyph per row, same order, respecting collapse).
// The footer is the operator's account row — a menu trigger (T109): clicking
// it opens the account menu where Sign out is a separate item.

import { useState } from "react";
import { RzArrows } from "./RzArrows";
import { useT } from "./i18n-context";
import {
  IconChevron,
  IconGear,
  IconGroup,
  IconMonitor,
  IconPower,
  IconRadio,
  IconTag,
  IconUser,
} from "./icons";
import { agentColor } from "./palette";
import { dotClass, liveLabel, statusLabel, unknownReason } from "./peer-surface";
import { loadExpandedGroups, loadPref, saveExpandedGroups, savePref } from "./prefs";
import { type TreeRow, buildTree, tagPeers } from "./tree";
import { type PeerInfo, peerKind } from "./types";

/** The collapsed-rail avatar text: the first character, uppercased. */
export const initialOf = (name: string): string => (name[0] ?? "?").toUpperCase();

export function PeerList(props: {
  peers: readonly PeerInfo[];
  selected?: string | undefined;
  onSelect: (peer: string) => void;
  /** The transport observability view (FR-48, §12.4) — read-only, server-wide. */
  transportSelected?: boolean;
  onTransport?: () => void;
  /**
   * Sidebar layout (§15, settings toggle): true ⇒ the classic FLAT agent list
   * (groups/tags hidden); false/absent ⇒ the group tree + Tags section.
   */
  flat?: boolean;
  /** Collapsed icon rail (FR-68) — toggled by the topbar logo. */
  collapsed?: boolean;
  /** The bound operator's name (FR-68) — the footer account button. */
  operator?: string | undefined;
  onLogout?: () => void;
  /** Opens the settings page (T110, FR-76) — an account-menu item. */
  onSettings?: () => void;
}): React.JSX.Element {
  const t = useT();
  const collapsed = props.collapsed === true;

  // The broadcast tree's expanded groups (§15): absent record ⇒ every group
  // expanded (prefs.ts). Toggling one group persists the whole set.
  const [expanded, setExpanded] = useState<ReadonlySet<string> | undefined>(() =>
    loadExpandedGroups(),
  );
  const isExpanded = (name: string): boolean => expanded === undefined || expanded.has(name);
  const toggleGroup = (name: string): void => {
    // materialize "all-expanded" into a concrete set the first time (so the first
    // collapse actually removes just this group)
    const base =
      expanded ?? new Set(props.peers.filter((p) => peerKind(p) === "group").map((p) => p.name));
    const next = new Set(base);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setExpanded(next);
    saveExpandedGroups(next);
  };

  // The "Tags" section collapse (§15) — a plain persisted boolean (FR-72).
  const [tagsCollapsed, setTagsCollapsed] = useState(() => loadPref("tags-collapsed", false));
  const toggleTags = (): void => {
    const next = !tagsCollapsed;
    setTagsCollapsed(next);
    savePref("tags-collapsed", next);
  };

  // The "Servers" section collapse (§18.4, FR-144) — same persisted idiom.
  const [serversCollapsed, setServersCollapsed] = useState(() =>
    loadPref("servers-collapsed", false),
  );
  const toggleServers = (): void => {
    const next = !serversCollapsed;
    setServersCollapsed(next);
    savePref("servers-collapsed", next);
  };

  // Flat layout (§15 settings toggle): the classic list — every AGENT as a depth-0
  // row, no group headers, no Tags section. Tree layout: the group tree + tags.
  // Federated peers (§18.4) stay out of both — they render in the Servers section.
  const flat = props.flat === true;
  const rows: readonly TreeRow[] = flat
    ? props.peers
        .filter(
          (peer) =>
            (peerKind(peer) === "agent" || peerKind(peer) === "user") && peer.server === undefined,
        )
        .map((peer) => ({ kind: "agent", name: peer.name, depth: 0, peer }))
    : buildTree(props.peers, expanded);
  const tags = flat ? [] : tagPeers(props.peers);
  // Remote peers grouped by their import (§18.4): one sub-header per server with
  // the link marker, the actors beneath — rendered in BOTH layouts (an imported
  // actor has no local group/tag to disappear into).
  const remote = props.peers.filter((peer) => peer.server !== undefined);
  const servers = [...new Set(remote.map((peer) => peer.server as string))].sort();

  return (
    <nav className={`peer-list${collapsed ? " collapsed" : ""}`}>
      {/* the rows scroll on their own (T109) — the footer stays pinned and the
          account menu is not clipped by the scroll container */}
      <div className="peer-scroll">
        {props.onTransport !== undefined && (
          <button
            type="button"
            className={`peer-row transport-entry${props.transportSelected === true ? " selected" : ""}`}
            title={collapsed ? `${t("Transport")} — ${t("all routed messages")}` : undefined}
            onClick={props.onTransport}
          >
            {collapsed ? (
              <span className="peer-avatar">
                <IconRadio size={18} />
              </span>
            ) : (
              <span className="peer-info">
                <span className="peer-name">
                  <IconRadio size={14} /> {t("Transport")}
                </span>
                <span className="peer-preview">{t("all routed messages")}</span>
              </span>
            )}
          </button>
        )}
        {rows.length === 0 && tags.length === 0 && !collapsed && (
          <p className="peer-empty">{t("No agents in topology")}</p>
        )}
        {rows.map((row) =>
          row.kind === "group" ? (
            <GroupRow
              key={`g:${row.name}`}
              row={row}
              collapsed={collapsed}
              selected={row.name === props.selected}
              expanded={isExpanded(row.name)}
              onToggle={() => toggleGroup(row.name)}
              onSelect={() => props.onSelect(row.name)}
            />
          ) : (
            <AgentRow
              key={`a:${row.name}`}
              row={row}
              collapsed={collapsed}
              selected={row.name === props.selected}
              onSelect={() => props.onSelect(row.name)}
            />
          ),
        )}
        {tags.length > 0 && (
          <TagsSection
            tags={tags}
            collapsed={collapsed}
            sectionCollapsed={tagsCollapsed}
            selected={props.selected}
            onToggleSection={toggleTags}
            onSelect={props.onSelect}
          />
        )}
        {servers.length > 0 && (
          <ServersSection
            servers={servers}
            remote={remote}
            collapsed={collapsed}
            sectionCollapsed={serversCollapsed}
            selected={props.selected}
            onToggleSection={toggleServers}
            onSelect={props.onSelect}
          />
        )}
      </div>
      {props.onLogout !== undefined && (
        <OperatorButton
          collapsed={collapsed}
          operator={props.operator ?? "operator"}
          onLogout={props.onLogout}
          onSettings={props.onSettings}
        />
      )}
    </nav>
  );
}

// A group header row (§15): the disclosure chevron + a folder icon + the name —
// NO status dot / unread / queue (a group is an input-only broadcast target).
// Clicking the label opens the group's broadcast chat; clicking the chevron only
// expands/collapses the subtree. On the collapsed rail it is one folder glyph.
function GroupRow(props: {
  row: TreeRow;
  collapsed: boolean;
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSelect: () => void;
}): React.JSX.Element {
  const t = useT();
  const { row } = props;
  if (props.collapsed) {
    return (
      <button
        type="button"
        className={`peer-row group-row${props.selected ? " selected" : ""}`}
        title={`${row.name} — ${t("broadcast group")}`}
        onClick={props.onSelect}
      >
        <span className="peer-avatar group-avatar">
          <IconGroup size={18} />
        </span>
      </button>
    );
  }
  return (
    <div
      className={`peer-row group-row${props.selected ? " selected" : ""}`}
      style={{ "--tree-depth": row.depth } as React.CSSProperties}
    >
      <button
        type="button"
        className={`group-chevron${props.expanded ? " open" : ""}`}
        aria-label={props.expanded ? t("Collapse the group") : t("Expand the group")}
        aria-expanded={props.expanded}
        onClick={props.onToggle}
      >
        <IconChevron size={14} />
      </button>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the label is a span so the chevron can be a nested control; the collapsed rail carries the button role */}
      <span className="group-label" onClick={props.onSelect}>
        <IconGroup size={15} />
        <span className="peer-name group-name">{row.name}</span>
      </span>
    </div>
  );
}

// An agent leaf row (§12.7, FR-68) — unchanged behavior (status dot, rendezvous
// markers, name, queue depth, preview, unread), only indented under its group.
function AgentRow(props: {
  row: TreeRow;
  collapsed: boolean;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const t = useT();
  const peer = props.row.peer;
  if (props.collapsed) {
    return (
      <button
        type="button"
        className={`peer-row${props.selected ? " selected" : ""}${peer.paused === true ? " peer-paused" : ""}`}
        title={`${peer.name} — ${t(statusLabel(peer))}${
          peer.paused === true ? ` · ${t(liveLabel(peer))}` : ""
        }`}
        onClick={props.onSelect}
      >
        {/* the agent's accent paints the avatar circle (FR-73) */}
        <span
          className="peer-avatar tinted"
          style={{ background: agentColor(peer.name, peer.color) }}
        >
          {initialOf(peer.name)}
          {/* the same live dot as the expanded row — pinned to the avatar; the
              `paused` modifier mutes it and adds the pause glyph (§16.6) */}
          <span className={dotClass(peer)} />
        </span>
        {peer.unread > 0 && <span className="unread-badge">{peer.unread}</span>}
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`peer-row peer-accent${props.selected ? " selected" : ""}${
        peer.paused === true ? " peer-paused" : ""
      }`}
      title={
        peer.paused === true ? `${peer.name} — ${t("paused")} · ${t(liveLabel(peer))}` : undefined
      }
      /* expanded: the accent is a thin colored edge — unobtrusive (FR-73) */
      style={
        {
          "--peer-color": agentColor(peer.name, peer.color),
          "--tree-depth": props.row.depth,
        } as React.CSSProperties
      }
      onClick={props.onSelect}
    >
      <span className={dotClass(peer)} />
      {/* rendezvous markers (FR-105): after the activity dot, before the name */}
      <RzArrows peer={peer} />
      <span className="peer-info">
        <span className={`peer-name${peer.atWipLimit === true ? " at-wip" : ""}`}>
          {peer.name}
          {peer.queueDepth > 0 && <span className="queue-depth"> ({peer.queueDepth})</span>}
        </span>
        <span className="peer-preview">
          {t(statusLabel(peer))}
          {peer.lastMessage !== undefined && ` · ${peer.lastMessage.preview}`}
        </span>
      </span>
      {peer.unread > 0 && <span className="unread-badge">{peer.unread}</span>}
    </button>
  );
}

// The flat "Tags" section (§15, FR-107): a collapsible header (persisted, FR-72)
// over the tag rows — each a tag glyph + name + a member-names subtitle. NO
// status/unread — a tag is an input-only broadcast target. On the collapsed rail
// the header is skipped and each tag is one glyph.
function TagsSection(props: {
  tags: readonly PeerInfo[];
  collapsed: boolean;
  sectionCollapsed: boolean;
  selected?: string | undefined;
  onToggleSection: () => void;
  onSelect: (peer: string) => void;
}): React.JSX.Element {
  const t = useT();
  if (props.collapsed) {
    return (
      <>
        <span className="rail-divider" aria-hidden="true" />
        {props.tags.map((tag) => (
          <button
            type="button"
            key={`t:${tag.name}`}
            className={`peer-row tag-row${tag.name === props.selected ? " selected" : ""}`}
            title={`${tag.name} — ${t("broadcast tag")}`}
            onClick={() => props.onSelect(tag.name)}
          >
            <span className="peer-avatar tag-avatar">
              <IconTag size={18} />
            </span>
          </button>
        ))}
      </>
    );
  }
  return (
    <>
      <button
        type="button"
        className="peer-section-header"
        aria-expanded={!props.sectionCollapsed}
        onClick={props.onToggleSection}
      >
        <span className={`group-chevron${props.sectionCollapsed ? "" : " open"}`}>
          <IconChevron size={14} />
        </span>
        <span className="peer-section-title">{t("Tags")}</span>
      </button>
      {!props.sectionCollapsed &&
        props.tags.map((tag) => (
          <button
            type="button"
            key={`t:${tag.name}`}
            className={`peer-row tag-row${tag.name === props.selected ? " selected" : ""}`}
            onClick={() => props.onSelect(tag.name)}
          >
            <span className="tag-icon">
              <IconTag size={15} />
            </span>
            <span className="peer-info">
              <span className="peer-name">{tag.name}</span>
              {tag.members !== undefined && tag.members.length > 0 && (
                <span className="peer-preview">{tag.members.join(", ")}</span>
              )}
            </span>
          </button>
        ))}
    </>
  );
}

// The "Servers" section (§18.4, FR-144/FR-150): federated peers grouped by their
// import — a sub-header per server with the LINK marker (up/down), the actors
// beneath as ordinary rows (the same dot idiom; `unknown` is the hollow gray dot
// with the cause in the tooltip). Read-only rows: an actor opens a plain 1:1
// chat, the server sub-header is not addressable. On the collapsed rail each
// actor is one avatar; the sub-headers are skipped (like the Tags header).
function ServersSection(props: {
  servers: readonly string[];
  remote: readonly PeerInfo[];
  collapsed: boolean;
  sectionCollapsed: boolean;
  selected?: string | undefined;
  onToggleSection: () => void;
  onSelect: (peer: string) => void;
}): React.JSX.Element {
  const t = useT();
  if (props.collapsed) {
    return (
      <>
        <span className="rail-divider" aria-hidden="true" />
        {props.remote.map((peer) => (
          <RemoteRow
            key={`s:${peer.name}`}
            peer={peer}
            collapsed={true}
            selected={peer.name === props.selected}
            onSelect={() => props.onSelect(peer.name)}
          />
        ))}
      </>
    );
  }
  return (
    <>
      <button
        type="button"
        className="peer-section-header"
        aria-expanded={!props.sectionCollapsed}
        onClick={props.onToggleSection}
      >
        <span className={`group-chevron${props.sectionCollapsed ? "" : " open"}`}>
          <IconChevron size={14} />
        </span>
        <span className="peer-section-title">{t("Servers")}</span>
      </button>
      {!props.sectionCollapsed &&
        props.servers.map((server) => {
          const peers = props.remote.filter((peer) => peer.server === server);
          const link = peers[0]?.link ?? "down";
          return (
            <div key={`srv:${server}`} className="server-group">
              <div
                className="peer-row server-row"
                title={link === "up" ? t("link up") : t("link down")}
              >
                <span className={`link-dot ${link}`} />
                <span className="server-icon">
                  <IconMonitor size={14} />
                </span>
                <span className="peer-name server-name">{server}</span>
              </div>
              {peers.map((peer) => (
                <RemoteRow
                  key={`s:${peer.name}`}
                  peer={peer}
                  collapsed={false}
                  selected={peer.name === props.selected}
                  onSelect={() => props.onSelect(peer.name)}
                />
              ))}
            </div>
          );
        })}
    </>
  );
}

// One federated actor row (§18.4): the same dot/name/preview idiom as an agent
// row — the projection IS the status — indented under its server; the tooltip
// names the `unknown` cause when there is one (FR-150).
function RemoteRow(props: {
  peer: PeerInfo;
  collapsed: boolean;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const t = useT();
  const peer = props.peer;
  const cause = unknownReason(peer);
  const tooltip = `${peer.name} — ${t(statusLabel(peer))}${cause !== undefined ? ` · ${t(cause)}` : ""}`;
  if (props.collapsed) {
    return (
      <button
        type="button"
        className={`peer-row remote-row${props.selected ? " selected" : ""}`}
        title={tooltip}
        onClick={props.onSelect}
      >
        <span
          className="peer-avatar tinted"
          style={{ background: agentColor(peer.name, peer.color) }}
        >
          {initialOf(peer.name)}
          <span className={dotClass(peer)} />
        </span>
        {peer.unread > 0 && <span className="unread-badge">{peer.unread}</span>}
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`peer-row remote-row${props.selected ? " selected" : ""}`}
      title={cause !== undefined ? tooltip : undefined}
      style={{ "--tree-depth": 1 } as React.CSSProperties}
      onClick={props.onSelect}
    >
      <span className={dotClass(peer)} />
      <span className="peer-info">
        <span className="peer-name">{peer.name}</span>
        <span className="peer-preview">
          {t(statusLabel(peer))}
          {peer.lastMessage !== undefined && ` · ${peer.lastMessage.preview}`}
        </span>
      </span>
      {peer.unread > 0 && <span className="unread-badge">{peer.unread}</span>}
    </button>
  );
}

// The account row (FR-68, reshaped by T109): pinned to the sidebar bottom and
// opens the account MENU — Sign out is a separate item inside it (opening the
// menu is the deliberate first step, so no extra arm/confirm). The backdrop
// click-away mirrors the toolbar filter menus (no blocking dialogs).
function OperatorButton(props: {
  collapsed: boolean;
  operator: string;
  onLogout: () => void;
  onSettings?: (() => void) | undefined;
}): React.JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <span className="operator-anchor">
      {open && (
        <>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: a transparent click-away backdrop, the menu buttons carry the keyboard path */}
          <span className="menu-backdrop" onClick={() => setOpen(false)} />
          <span className="operator-menu" role="menu">
            {props.onSettings !== undefined && (
              <button
                type="button"
                role="menuitem"
                className="filter-option"
                onClick={() => {
                  setOpen(false);
                  props.onSettings?.();
                }}
              >
                <IconGear size={14} /> {t("Settings")}
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className="filter-option danger"
              onClick={() => {
                setOpen(false);
                props.onLogout();
              }}
            >
              <IconPower size={14} /> {t("Sign out")}
            </button>
          </span>
        </>
      )}
      <button
        type="button"
        className="peer-row operator-entry"
        title={`${props.operator} — ${t("account menu")}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {props.collapsed ? (
          <span className="peer-avatar">
            <IconUser size={18} />
          </span>
        ) : (
          <>
            <span className="peer-avatar">
              <IconUser size={18} />
            </span>
            <span className="peer-info">
              <span className="peer-name">{props.operator}</span>
              <span className="peer-preview">{t("Account")} ▾</span>
            </span>
          </>
        )}
      </button>
    </span>
  );
}
