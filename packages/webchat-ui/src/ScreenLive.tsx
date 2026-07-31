// Screen Live (FR-102): a popup that polls the peer's console snapshot on a
// fixed cadence and shows it as-is (monospace <pre>, no markdown — it is a raw
// terminal capture). The polling lives entirely inside this component, so
// closing the popup (Esc / the ✕ / a backdrop click) unmounts it and stops the
// interval — the mode never runs in the background.
// It lived inside the composer until T228, when the operator moved the entry
// to the chat's actions menu: watching a console is an observation of the
// AGENT, not a way to compose a message.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { fetchAgentScreen } from "./api";
import { useT } from "./i18n-context";

/** Screen Live poll cadence (FR-102) — configurable here in code. */
export const SCREEN_LIVE_INTERVAL_MS = 3000;

export function ScreenLiveDialog(props: {
  /** The agent to watch — a NAME, not a fetcher: a closure prop would be a new
      identity on every parent render and would restart the poll each time. */
  peer: string;
  onClose: () => void;
}): React.JSX.Element {
  const t = useT();
  const [output, setOutput] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const peer = props.peer;
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const next = await fetchAgentScreen(peer);
        if (!cancelled) {
          setOutput(next);
          setError(undefined);
        }
      } catch (failure) {
        // keep the last frame; surface the error but keep polling — a transient
        // capture failure (agent restarting) should recover on the next tick.
        if (!cancelled) setError(failure instanceof Error ? failure.message : "capture failed");
      }
    };
    void tick(); // first frame immediately, then on the cadence
    const timer = setInterval(() => void tick(), SCREEN_LIVE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [peer]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  const seconds = Math.round(SCREEN_LIVE_INTERVAL_MS / 1000);

  // The popup portals to the body and carries that decision itself (T224/T228):
  // it covers the viewport with a position:fixed overlay, and whoever mounts it
  // may sit inside an element that is a containing block for fixed descendants
  // (the composer's frosted glass was exactly that). Self-contained here, the
  // dialog is correct wherever the entry point moves next.
  return createPortal(
    <div className="popup-overlay">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: a click-away backdrop; Esc/the ✕ carry the keyboard path */}
      <div className="popup-backdrop" onClick={props.onClose} />
      <dialog open className="popup-dialog screen-live" aria-label={t("Screen Live")}>
        <div className="popup-head">
          <span className="popup-title">
            {t("Screen Live")}
            <span className="screen-live-note">
              {" "}
              {t("live console — refreshes every {seconds}s").replace("{seconds}", String(seconds))}
            </span>
          </span>
          <button
            type="button"
            className="chip-remove"
            aria-label={t("Close")}
            onClick={props.onClose}
          >
            ×
          </button>
        </div>
        {/* as-is: monospace terminal capture, NO markdown */}
        <pre className="screen-live-pane">
          {output ?? (error === undefined ? `${t("Loading")}…` : "")}
        </pre>
        {error !== undefined && <p className="error screen-live-error">{error}</p>}
      </dialog>
    </div>,
    document.body,
  );
}
