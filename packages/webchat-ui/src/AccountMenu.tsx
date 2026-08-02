// The account menu (FR-68, T109 → moved by T234): the avatar circle lives in the
// TOPBAR's right corner — no name, no "Account" label, just the person glyph —
// and opens the same menu the sidebar footer used to carry: Settings, then Sign
// out as a separate item (opening the menu IS the deliberate first step, so no
// extra arm/confirm). Who is signed in stays available as the tooltip. The
// backdrop click-away mirrors the toolbar filter menus (no blocking dialogs).

import { useState } from "react";
import { useT } from "./i18n-context";
import { IconGear, IconPower, IconUser } from "./icons";

export function AccountMenu(props: {
  /**
   * The logged-in user (§17.7, FR-127) — the tooltip; the button shows no name.
   * Absent until api/peers answers: the circle is already there, unnamed, so the
   * topbar does not reflow when the name lands.
   */
  operator?: string | undefined;
  /**
   * Their configured label (FR-156). The circle still shows no text — the
   * tooltip names the label AND the name, because the name is what the operator
   * is addressed by everywhere else.
   */
  title?: string | undefined;
  onLogout: () => void;
  /** Opens the settings page (T110, FR-76) — an account-menu item. */
  onSettings?: (() => void) | undefined;
}): React.JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const menu = t("account menu");
  const who =
    props.title !== undefined && props.operator !== undefined
      ? `${props.title} (${props.operator})`
      : props.title !== undefined
        ? props.title
        : props.operator;
  const label = who === undefined ? menu : `${who} — ${menu}`;
  return (
    <span className="account-anchor">
      <button
        type="button"
        className="account-button"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="peer-avatar">
          <IconUser size={18} />
        </span>
      </button>
      {open && (
        <>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: a transparent click-away backdrop, the menu buttons carry the keyboard path */}
          <span className="menu-backdrop" onClick={() => setOpen(false)} />
          <span className="account-menu" role="menu">
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
    </span>
  );
}
