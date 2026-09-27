// The settings page (T110, FR-76), opened from the account menu (#/settings).
// Hosts the panel-wide switches moved off the topbar — Auto-scroll (FR-62) and
// the theme (FR-59) — the UI language selector (T114, FR-78), plus the agent
// visibility filter: show ALL agents in the sidebar or only a hand-picked set
// (visibility.ts, persisted in localStorage).

import { useState } from "react";
import {
  type NotificationPermissionState,
  notificationState,
  requestNotifications,
} from "./alarm-audio";
import { LANGS, type Lang, normalizeLang } from "./i18n";
import { useT } from "./i18n-context";
import { agentColor } from "./palette";
import { nameTooltip, peerLabel } from "./peer-surface";
import { type ServerInfo, formatServerInfo } from "./server-info";
import type { Theme } from "./theme";
import { TOOLS, type ToolId, type ToolScope, toggleTool } from "./tools";
import type { PeerInfo } from "./types";
import { type Visibility, setMode, toggleAgent } from "./visibility";

export function SettingsView(props: {
  follow: boolean;
  onFollow: (follow: boolean) => void;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  lang: Lang;
  onLang: (lang: Lang) => void;
  /** The sidebar Transport entry (T115) — shown by default, hideable. */
  transport: boolean;
  onTransport: (show: boolean) => void;
  /** Sidebar layout (§15): true = flat agent list, false = group tree + Tags. */
  flat: boolean;
  onFlat: (flat: boolean) => void;
  /** The sidebar's agent-filter panel (FR-176) — the same pref its topbar button flips. */
  agentFilter: boolean;
  onAgentFilter: (show: boolean) => void;
  /** The prompt rack (§20, FR-189): OFF (the default) hides every entry to it. */
  prompts: boolean;
  onPrompts: (show: boolean) => void;
  /** Token-usage display (FR-72): true (default) shows the chat-header token meter. */
  showTokens: boolean;
  onShowTokens: (show: boolean) => void;
  /** Pinned toolbar tools (§12.10, FR-173) — the set the topbar prints. */
  tools: ReadonlySet<ToolId>;
  onTools: (tools: ReadonlySet<ToolId>) => void;
  /** The FULL peer list (unfiltered) — the checklist must show hidden agents. */
  peers: readonly PeerInfo[];
  visibility: Visibility;
  onVisibility: (visibility: Visibility) => void;
  /** Server build info (FR-91) for the page footer; absent until fetched / if unwired. */
  serverInfo?: ServerInfo;
  /** Does the server show alarms (§22.8)? Off ⇒ no Alarms section at all. */
  alarms?: boolean;
  /** "Play alarm sounds" (§22.7) — the same pref the modal's mute button flips. */
  alarmSound?: boolean;
  onAlarmSound?: (on: boolean) => void;
  /** "Desktop notifications for alarms" (§22.7). */
  alarmNotify?: boolean;
  onAlarmNotify?: (on: boolean) => void;
}): React.JSX.Element {
  const t = useT();
  const onlySelected = props.visibility.mode === "selected";
  return (
    <>
      <header className="chat-header">
        <strong>{t("Settings")}</strong>
      </header>
      <div className="settings-body">
        <section className="settings-section">
          <h2>{t("Panel")}</h2>
          <SettingSwitch
            label={t("Auto-scroll")}
            hint={t("Automatically scroll feeds to the newest message")}
            checked={props.follow}
            onChange={props.onFollow}
          />
          <SettingSwitch
            label={t("Dark theme")}
            hint={t("Switch between the light and dark look")}
            checked={props.theme === "dark"}
            onChange={(dark) => props.onTheme(dark ? "dark" : "light")}
          />
          <SettingSwitch
            label={t("Show the Transport page")}
            hint={t("The all-routed-messages feed in the sidebar")}
            checked={props.transport}
            onChange={props.onTransport}
          />
          {/* FR-189: a rack nobody keeps prompts in is three menu entries nobody
              reads — off by default, and off means the ENTRIES, not the data */}
          <SettingSwitch
            label={t("Show the prompt rack")}
            hint={t(
              "Shelves of reusable prompts — the composer menu, the account menu and the toolbar entry",
            )}
            checked={props.prompts}
            onChange={props.onPrompts}
          />
          <SettingSwitch
            label={t("Show token usage")}
            hint={t(
              "The per-agent token meter in the chat header — turn off for a lighter interface",
            )}
            checked={props.showTokens}
            onChange={props.onShowTokens}
          />
          {/* the language row (FR-78): native labels, never translated */}
          <div className="settings-row" title={t("The interface language")}>
            <span className="settings-label">
              {t("Language")}
              <span className="settings-hint">{t("English is the default")}</span>
            </span>
            <select
              className="settings-select"
              aria-label={t("Language")}
              value={props.lang}
              onChange={(event) => props.onLang(normalizeLang(event.target.value))}
            >
              {LANGS.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label}
                </option>
              ))}
            </select>
          </div>
        </section>
        {props.alarms === true && (
          <AlarmSettings
            sound={props.alarmSound ?? true}
            onSound={props.onAlarmSound ?? (() => undefined)}
            notify={props.alarmNotify ?? true}
            onNotify={props.onAlarmNotify ?? (() => undefined)}
          />
        )}
        {/* the toolbar picker (§12.10.3, FR-173): the WHOLE catalogue, in the
            order the topbar prints it, so the list reads as a preview of the bar.
            Actions the open chat cannot take are listed all the same — the
            setting outlives the open chat. */}
        <section className="settings-section">
          <h2>{t("Toolbar")}</h2>
          <p className="settings-note">
            {t("Pinned buttons appear in the header, next to the filter field")}
          </p>
          {(["chat", "panel"] as readonly ToolScope[]).map((scope) => (
            <div key={scope}>
              <h3 className="settings-subhead">{t(scope === "chat" ? "Chat actions" : "Panel")}</h3>
              {TOOLS.filter((tool) => tool.scope === scope).map((tool) => (
                <div className="settings-row tool-row" key={tool.id} title={t(tool.hint)}>
                  <span className="settings-icon">
                    <tool.icon size={16} />
                  </span>
                  <span className="settings-label">
                    {t(tool.label)}
                    <span className="settings-hint">{t(tool.hint)}</span>
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={props.tools.has(tool.id)}
                    aria-label={`${t("Show in the toolbar")}: ${t(tool.label)}`}
                    className="switch"
                    onClick={() => props.onTools(toggleTool(props.tools, tool.id))}
                  >
                    <span className="switch-knob" />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </section>
        <section className="settings-section">
          <h2>{t("Agents")}</h2>
          <SettingSwitch
            label={t("Show the agent filter")}
            hint={t("A name field and an all/online switch above the sidebar list")}
            checked={props.agentFilter}
            onChange={props.onAgentFilter}
          />
          <SettingSwitch
            label={t("Flat agent list")}
            hint={t("ON is a plain list; OFF shows the group tree and Tags section")}
            checked={props.flat}
            onChange={props.onFlat}
          />
          <SettingSwitch
            label={t("Show only selected agents")}
            hint={t("OFF shows every topology agent in the sidebar")}
            checked={onlySelected}
            onChange={(only) =>
              props.onVisibility(setMode(props.visibility, only ? "selected" : "all"))
            }
          />
          {onlySelected && (
            <div className="agent-checklist">
              {props.peers.map((peer) => (
                <div key={peer.name} className="agent-check">
                  <span
                    className="peer-avatar tinted"
                    style={
                      { "--peer-color": agentColor(peer.name, peer.color) } as React.CSSProperties
                    }
                  >
                    {(peerLabel(peer)[0] ?? "?").toUpperCase()}
                  </span>
                  {/* labelled by `title` when configured, name in the tooltip (FR-156) */}
                  <span className="agent-check-name" title={nameTooltip(peer)}>
                    {peerLabel(peer)}
                  </span>
                  {/* the same iOS-style switch as every other settings row */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={props.visibility.selected.has(peer.name)}
                    aria-label={`${t("Show in the sidebar")}: ${peerLabel(peer)}`}
                    className="switch"
                    onClick={() => props.onVisibility(toggleAgent(props.visibility, peer.name))}
                  >
                    <span className="switch-knob" />
                  </button>
                </div>
              ))}
              {props.peers.length === 0 && (
                <p className="peer-empty">{t("No agents in topology")}</p>
              )}
            </div>
          )}
        </section>
        {/* build info (FR-91): an unobtrusive informational line at the page bottom */}
        {props.serverInfo !== undefined && (
          <footer className="settings-footer">
            {formatServerInfo(props.serverInfo, t("built"))}
          </footer>
        )}
      </div>
    </>
  );
}

// The Alarms section (§22.7, FR-207). Alarms themselves cannot be switched off
// here on purpose — they are an agent's state, not a taste of this tab; for "not
// now" there is DND, for the whole stand the config. What this browser CAN decide
// is how loud it is allowed to be: the sound, and the desktop notification.
function AlarmSettings(props: {
  sound: boolean;
  onSound: (on: boolean) => void;
  notify: boolean;
  onNotify: (on: boolean) => void;
}): React.JSX.Element {
  const t = useT();
  const [permission, setPermission] = useState<NotificationPermissionState>(notificationState);
  // Switching notifications ON is the gesture the browser's permission prompt needs.
  const onNotify = (on: boolean): void => {
    props.onNotify(on);
    if (on && permission === "default") void requestNotifications().then(setPermission);
  };
  const permissionNote: Record<NotificationPermissionState, string> = {
    granted: "allowed by the browser",
    default: "not yet allowed — switch on to ask",
    denied: "blocked by the browser — allow them in the site settings",
    unavailable: "unavailable here — the panel needs HTTPS or localhost",
  };
  return (
    <section className="settings-section">
      <h2>{t("Alarms")}</h2>
      <SettingSwitch
        label={t("Play alarm sounds")}
        hint={t("Sound when an agent raises an alarm — off keeps the room quiet, the modal stays")}
        checked={props.sound}
        onChange={props.onSound}
      />
      <SettingSwitch
        label={t("Desktop notifications for alarms")}
        hint={`${t("A system notification for each alarm")} — ${t(permissionNote[permission])}`}
        checked={props.notify}
        onChange={onNotify}
      />
    </section>
  );
}

// One settings row: label + hint on the left, the shared iOS-style switch on
// the right (the same .switch styles the topbar used before the move).
function SettingSwitch(props: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="settings-row" title={props.hint}>
      <span className="settings-label">
        {props.label}
        <span className="settings-hint">{props.hint}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        aria-label={props.label}
        className="switch"
        onClick={() => props.onChange(!props.checked)}
      >
        <span className="switch-knob" />
      </button>
    </div>
  );
}
