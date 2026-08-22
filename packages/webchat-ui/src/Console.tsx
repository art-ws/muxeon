// Console (§12.9, FR-160): the agent's terminal INSIDE the panel — a real
// emulator (xterm.js) wired to the pane over the console socket, replacing the
// polled Screen Live snapshot that only showed text (FR-102 keeps the text
// capture; watching is no longer the same thing as being there).
//
// Two rules shape everything here:
//
//   * the keyboard belongs to the terminal. Esc, Ctrl-C, arrows and pastes are
//     the pane's input, so the popup takes no keyboard shortcut away from it —
//     Esc closes the dialog only when focus is NOT in the terminal, and the
//     panel's own click-away-to-close is off: a stray click must not tear down a
//     console someone is working in. The ✕ closes it.
//   * the pane's geometry is the truth. The emulator MIRRORS the agent's tmux
//     size (the server never resizes the agent's window, §12.9) and the font is
//     scaled so that grid fills the popup — the same screen the agent sees, just
//     bigger. Full screen grows the popup, not the terminal.

import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { consoleSocketUrl } from "./api";
import { useT } from "./i18n-context";
import { IconCollapse, IconExpand, IconX } from "./icons";
import { type Bounds, ORIGIN, type Offset, clampOffset, dragBounds, dragTo } from "./window-drag";

/** Font size the terminal is measured at before it is fitted to the popup. */
const BASE_FONT_PX = 14;
const MIN_FONT_PX = 8;
const MAX_FONT_PX = 30;

type Phase = "connecting" | "live" | "ended";

/** A drag in progress: where the pointer started, and how far it may still go. */
interface Drag extends Bounds {
  readonly pointerX: number;
  readonly pointerY: number;
  readonly from: Offset;
}

/** The live viewport, as the pure rules want it (window-drag.ts). */
const viewport = (): { width: number; height: number } => ({
  width: window.innerWidth,
  height: window.innerHeight,
});

export function ConsoleDialog(props: {
  /** The agent to attach to — a NAME, so the effect does not restart per render. */
  peer: string;
  onClose: () => void;
}): React.JSX.Element {
  const t = useT();
  const peer = props.peer;
  const [full, setFull] = useState(false);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [note, setNote] = useState<string | undefined>(undefined);
  /** Bumped by "Reconnect" — the attach effect keys off it. */
  const [attempt, setAttempt] = useState(0);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | undefined>(undefined);
  // Where the window has been dragged to (T318): an offset from where the
  // overlay centres it, NOT absolute coordinates — the box keeps its own
  // sizing rules, and "no drag yet" stays the honest {0,0}.
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [offset, setOffset] = useState<Offset>(ORIGIN);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<Drag | undefined>(undefined);
  // The attach below MUST NOT depend on the translator (T280): `t` comes from
  // context and used to change identity on every App re-render, so an unrelated
  // render detached the tmux client and built a new terminal — the console blinked.
  // What the socket handlers need is the CURRENT wording, not a dependency.
  const tr = useRef(t);
  tr.current = t;

  /**
   * Scales the FONT so the mirrored grid fills the popup. The cell metrics are
   * proportional to the font size, so one measured pass converges: read what the
   * terminal takes now, ask for the factor that would make it fit.
   */
  const fit = useCallback((): void => {
    const term = termRef.current;
    const host = hostRef.current;
    if (term === undefined || host === null) return;
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (screen === null || screen.offsetWidth === 0 || screen.offsetHeight === 0) return;
    const factor = Math.min(
      host.clientWidth / screen.offsetWidth,
      host.clientHeight / screen.offsetHeight,
    );
    const current = term.options.fontSize ?? BASE_FONT_PX;
    const next = Math.max(MIN_FONT_PX, Math.min(MAX_FONT_PX, Math.floor(current * factor)));
    if (next !== current) term.options.fontSize = next;
  }, []);

  // The terminal and its socket live and die together (one attach per open
  // popup): closing the popup unmounts this and detaches the tmux client.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the REACTION dep — bumping it re-attaches (the body never reads it)
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    setPhase("connecting");
    setNote(undefined);

    const term = new Terminal({
      fontSize: BASE_FONT_PX,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      cursorBlink: true,
      convertEol: false,
      // The pane's own scrollback is primed by the server; this holds what
      // streams in afterwards, so the wheel scrolls like any terminal.
      scrollback: 5000,
      allowProposedApi: true,
      theme: { background: "#0b0d10", foreground: "#d6dde5" },
    });
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11"; // widths tmux computes, widths we render
    term.open(host);
    termRef.current = term;

    // Copy/paste keep their platform meaning; everything else is the pane's.
    term.attachCustomKeyEventHandler((event) => {
      const clipboard = event.metaKey || (event.ctrlKey && event.shiftKey);
      if (clipboard && ["c", "v", "x", "a"].includes(event.key.toLowerCase())) return false;
      return true;
    });

    const socket = new WebSocket(consoleSocketUrl(peer));
    socket.binaryType = "arraybuffer";
    const encoder = new TextEncoder();
    let live = false;

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        term.write(new Uint8Array(event.data as ArrayBuffer));
        return;
      }
      const frame = JSON.parse(event.data) as {
        t: "init" | "exit" | "error";
        cols?: number;
        rows?: number;
        screen?: string;
        message?: string;
      };
      if (frame.t === "init") {
        term.resize(frame.cols ?? 80, frame.rows ?? 24);
        term.write(frame.screen ?? "");
        live = true;
        setPhase("live");
        // after the grid exists, size the font to the popup and take focus
        requestAnimationFrame(() => {
          fit();
          term.focus();
        });
        return;
      }
      live = false;
      setPhase("ended");
      setNote(frame.t === "exit" ? tr.current("the session ended") : frame.message);
      socket.close(); // the server leaves the closing to us (§12.9)
    });
    socket.addEventListener("close", () => {
      if (!live) return; // an ending we already explained
      live = false;
      setPhase("ended");
      setNote(tr.current("connection lost"));
    });
    socket.addEventListener("error", () => {
      if (live) return;
      setPhase("ended");
      setNote(tr.current("could not open the console"));
    });

    // Keystrokes go out as the exact bytes a terminal would send.
    const typed = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
    });
    const binary = term.onBinary((data) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      socket.send(bytes);
    });

    const onResize = (): void => fit();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      typed.dispose();
      binary.dispose();
      // OUR close is not a lost connection (T281): the flag goes down BEFORE the
      // socket does, so the close event this teardown provokes stays silent
      // instead of flashing "connection lost" (and its Reconnect button) over
      // the attachment that is already replacing it.
      live = false;
      socket.close();
      term.dispose();
      termRef.current = undefined;
    };
  }, [peer, attempt, fit]);

  // Full screen only changes the popup's box; the grid is the agent's, so all
  // that changes is how big its characters get.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `full` is the REACTION dep — the fit re-runs when the box changes
  useEffect(() => {
    const id = requestAnimationFrame(() => fit());
    return () => cancelAnimationFrame(id);
  }, [fit, full]);

  // A window parked near an edge must not be left hanging outside it when the
  // viewport shrinks — or when the box comes back from full screen at a size
  // the old offset was never clamped against. Both re-clamp against the CURRENT
  // rect; an untouched window ({0,0}) stays untouched, since the bounds always
  // admit the resting position.
  const reclamp = useCallback((): void => {
    setOffset((current) => {
      const box = dialogRef.current?.getBoundingClientRect();
      if (box === undefined) return current;
      return clampOffset(current, dragBounds(box, current, viewport()));
    });
  }, []);
  useEffect(() => {
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [reclamp]);
  useEffect(() => {
    if (!full) reclamp();
  }, [full, reclamp]);

  // Esc closes ONLY from outside the terminal: inside, Esc is a key the pane
  // must receive (vim, a CLI agent's prompt, anything).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const host = hostRef.current;
      if (host?.contains(document.activeElement) === true) return;
      event.preventDefault();
      props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  const title = `${t("Console")} — ${peer}`;
  return createPortal(
    <div className={`popup-overlay${full ? " popup-full" : ""}`}>
      {/* No click-away close (§12.9): a console is a place of work, not a peek. */}
      <div className="popup-backdrop" />
      <dialog
        open
        ref={dialogRef}
        className="popup-dialog console-dialog"
        aria-label={title}
        /* full screen IS the position — a maximized window that remembers a
           drag would open off-centre; the offset waits for the way back */
        style={full ? undefined : { transform: `translate(${offset.x}px, ${offset.y}px)` }}
      >
        {/* The title bar zooms the window on a double-click (T316) and drags it
            around on a press (T318) — both are shortcuts to state the buttons
            beside them own or that costs nothing to redo, so nothing here is a
            control the keyboard cannot reach. */}
        <div
          className={`popup-head${full ? "" : " draggable"}${dragging ? " dragging" : ""}`}
          onDoubleClick={(event) => {
            // a double-click INSIDE the actions is two clicks of that button —
            // letting it also toggle here would undo what the button just did
            if ((event.target as HTMLElement).closest(".console-actions") !== null) return;
            setFull(!full);
          }}
          onPointerDown={(event) => {
            // full screen has nowhere to go; the buttons keep their own clicks
            if (full || event.button !== 0) return;
            if ((event.target as HTMLElement).closest(".console-actions") !== null) return;
            const box = dialogRef.current?.getBoundingClientRect();
            if (box === undefined) return;
            dragRef.current = {
              pointerX: event.clientX,
              pointerY: event.clientY,
              from: offset,
              ...dragBounds(box, offset, viewport()),
            };
            // capture: the pointer WILL outrun the header — without it the drag
            // dies the moment the cursor crosses into the terminal or the page
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (drag === undefined) return;
            setOffset(
              dragTo(drag.from, event.clientX - drag.pointerX, event.clientY - drag.pointerY, drag),
            );
          }}
          onPointerUp={() => {
            dragRef.current = undefined;
            setDragging(false);
          }}
          onPointerCancel={() => {
            dragRef.current = undefined;
            setDragging(false);
          }}
        >
          <span className="popup-title">
            {title}
            {phase !== "live" && (
              <span className="console-note">
                {" "}
                {phase === "connecting" ? `${t("Connecting")}…` : (note ?? t("the session ended"))}
              </span>
            )}
          </span>
          <span className="console-actions">
            {phase === "ended" && (
              <button
                type="button"
                className="console-button"
                onClick={() => setAttempt(attempt + 1)}
              >
                {t("Reconnect")}
              </button>
            )}
            {/* the window's own buttons wear the TOOLBAR's clothes (T316): same
                32px round target, same hover halo — two icon buttons a few
                pixels apart that behave differently read as two mechanisms */}
            <button
              type="button"
              className="tool-button"
              title={full ? t("Collapse") : t("Full screen")}
              aria-label={full ? t("Collapse") : t("Full screen")}
              onClick={() => setFull(!full)}
            >
              {full ? <IconCollapse size={16} /> : <IconExpand size={16} />}
            </button>
            <button
              type="button"
              className="tool-button"
              title={t("Close")}
              aria-label={t("Close")}
              onClick={props.onClose}
            >
              <IconX size={16} />
            </button>
          </span>
        </div>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: clicking the pane hands the keyboard to the terminal, which owns every key from then on */}
        <div
          className="console-pane"
          ref={hostRef}
          onClick={() => termRef.current?.focus()}
          role="presentation"
        />
      </dialog>
    </div>,
    document.body,
  );
}
