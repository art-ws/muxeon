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
// The account button is NOT here (T234): it moved to the topbar's right corner
// (AccountMenu.tsx), so the sidebar is a list of addressees and nothing else.
// The agent filter (§12.7, FR-176/FR-177, T290/T291) is: an always-expanded panel
// at the TOP of the sidebar — above the Transport entry and the list (operator,
// T291) — a name field and an all/online switch, shown/hidden from Settings or
// its topbar button.

import { useState } from "react";
import { RzArrows } from "./RzArrows";
import {
  type AgentFilter,
  NO_FILTER,
  filterActive,
  filterPeers,
  participantCount,
} from "./agent-filter";
import { useT } from "./i18n-context";
import { IconChevron, IconGroup, IconMonitor, IconRadio, IconTag } from "./icons";
import { agentColor } from "./palette";
import {
  dotClass,
  liveLabel,
  nameTooltip,
  peerLabel,
  statusLabel,
  unknownReason,
} from "./peer-surface";
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
  /**
   * The agent-filter panel (§12.7, FR-176): shown when the Settings switch — or
   * its topbar button (FR-177) — says so. The filter it holds lives HERE, not in
   * a pref: it applies exactly while its panel is on screen (see below).
   */
  filterPanel?: boolean;
}): React.JSX.Element {
  const t = useT();
  const collapsed = props.collapsed === true;

  // The filter (FR-176) is session state, deliberately not persisted: a hidden
  // filter that survives a reload would silently shorten the sidebar. For the
  // same reason it applies only while its panel is VISIBLE — hiding the panel or
  // collapsing the sidebar to the rail restores the full list, and the typed
  // needle is still there when the panel comes back.
  const [filter, setFilter] = useState<AgentFilter>(NO_FILTER);
  const showPanel = props.filterPanel === true && !collapsed;
  const active = showPanel && filterActive(filter);
  const peers = active ? filterPeers(props.peers, filter) : props.peers;

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
    ? peers
        .filter(
          (peer) =>
            (peerKind(peer) === "agent" || peerKind(peer) === "user") && peer.server === undefined,
        )
        .map((peer) => ({ kind: "agent", name: peer.name, depth: 0, peer }))
    : buildTree(peers, expanded);
  const tags = flat ? [] : tagPeers(peers);
  // Remote peers grouped by their import (§18.4): one sub-header per server with
  // the link marker, the actors beneath — rendered in BOTH layouts (an imported
  // actor has no local group/tag to disappear into).
  const remote = peers.filter((peer) => peer.server !== undefined);
  const servers = [...new Set(remote.map((peer) => peer.server as string))].sort();

  return (
    <nav className={`peer-list${collapsed ? " collapsed" : ""}`}>
      {/* the rows scroll in their own container (T109) */}
      <div className="peer-scroll">
        {showPanel && (
          <AgentFilterPanel
            filter={filter}
            onFilter={setFilter}
            shown={participantCount(peers)}
            total={participantCount(props.peers)}
          />
        )}
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
          /* an emptied list says WHY it is empty — the filter is a state one can
             leave, "no agents in topology" would be a lie about the config */
          <p className="peer-empty">
            {t(active ? "Nothing matches the filter" : "No agents in topology")}
          </p>
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
    </nav>
  );
}

// The agent-filter panel (§12.7, FR-176, T290/T291 — operator request). It sits
// at the TOP of the sidebar, above the Transport entry and the list, and is
// ALWAYS expanded: a filter that has to be unfolded first is a filter one forgets
// is on. It sticks to the top of the scroller, so a long park cannot scroll its
// own filter out of reach — the Transport entry passes under it.
// Two controls — the name field and the all/online switch — and, whenever they
// shorten the list, a counter: a filtered sidebar never passes for the whole park
// (the same rule the message filter's strip keeps, FR-71).
function AgentFilterPanel(props: {
  filter: AgentFilter;
  onFilter: (filter: AgentFilter) => void;
  shown: number;
  total: number;
}): React.JSX.Element {
  const t = useT();
  const { query, onlineOnly } = props.filter;
  return (
    <div className="agent-filter">
      <span className="agent-filter-search">
        <input
          type="search"
          placeholder={t("Filter agents…")}
          aria-label={t("Filter agents by name")}
          value={query}
          onChange={(event) => props.onFilter({ ...props.filter, query: event.target.value })}
        />
        {query !== "" && (
          <button
            type="button"
            className="search-clear"
            aria-label={t("Clear the agent filter")}
            onClick={() => props.onFilter({ ...props.filter, query: "" })}
          >
            ×
          </button>
        )}
      </span>
      <div className="agent-filter-row">
        {/* both sides are printed, the picked one is lit: a two-state switch that
            shows only its current side leaves "all or online?" to be guessed */}
        <span className="agent-filter-modes">
          {([false, true] as const).map((only) => (
            <button
              key={String(only)}
              type="button"
              className={`agent-filter-mode${onlineOnly === only ? " picked" : ""}`}
              aria-pressed={onlineOnly === only}
              aria-label={t(only ? "Show only agents that are online" : "Show all agents")}
              title={t(only ? "Show only agents that are online" : "Show all agents")}
              onClick={() => props.onFilter({ ...props.filter, onlineOnly: only })}
            >
              {t(only ? "Online" : "All")}
            </button>
          ))}
        </span>
        {props.shown < props.total && (
          <output className="agent-filter-count">
            {/* a template key (FR-78): the whole phrase translates as one unit */}
            {t("showing {shown} of {total}")
              .replace("{shown}", String(props.shown))
              .replace("{total}", String(props.total))}
          </output>
        )}
      </div>
    </div>
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
// The printed label is the configured `title` when there is one (FR-156); the
// NAME stays in the tooltip, and the accent still hashes from the name so a
// title never repaints the sidebar.
function AgentRow(props: {
  row: TreeRow;
  collapsed: boolean;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const t = useT();
  const peer = props.row.peer;
  const label = peerLabel(peer);
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
          style={{ "--peer-color": agentColor(peer.name, peer.color) } as React.CSSProperties}
        >
          {initialOf(label)}
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
        peer.paused === true
          ? `${peer.name} — ${t("paused")} · ${t(liveLabel(peer))}`
          : // a titled row keeps its name one hover away (FR-156)
            nameTooltip(peer)
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
          {label}
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
          style={{ "--peer-color": agentColor(peer.name, peer.color) } as React.CSSProperties}
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
