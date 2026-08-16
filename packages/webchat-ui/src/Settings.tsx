// The settings page (T110, FR-76), opened from the account menu (#/settings).
// Hosts the panel-wide switches moved off the topbar — Auto-scroll (FR-62) and
// the theme (FR-59) — the UI language selector (T114, FR-78), plus the agent
// visibility filter: show ALL agents in the sidebar or only a hand-picked set
// (visibility.ts, persisted in localStorage).

import { LANGS, type Lang, normalizeLang } from "./i18n";
import { useT } from "./i18n-context";
import { agentColor } from "./palette";
import { nameTooltip, peerLabel } from "./peer-surface";
import { type ServerInfo, formatServerInfo } from "./server-info";
import type { Theme } from "./theme";
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
  /** Token-usage display (FR-72): true (default) shows the chat-header token meter. */
  showTokens: boolean;
  onShowTokens: (show: boolean) => void;
  /** The FULL peer list (unfiltered) — the checklist must show hidden agents. */
  peers: readonly PeerInfo[];
  visibility: Visibility;
  onVisibility: (visibility: Visibility) => void;
  /** Server build info (FR-91) for the page footer; absent until fetched / if unwired. */
  serverInfo?: ServerInfo;
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
        <section className="settings-section">
          <h2>{t("Agents")}</h2>
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
