// Composer (T49/T50, §12.5/§12.7): text + every media source over ONE path —
// pick/drag/paste a file, record the mic, capture the camera → upload → an
// attachment chip → /api/send with opaque blob ids. Enter sends, Shift+Enter
// breaks the line.
// Pill layout (T94, FR-70): one rounded shell — a single "+" button on the left
// opens an UPWARD menu with icon+label rows (attach / camera / slash commands
// as a SUBMENU, FR-66); the mic and a round ↑ send button sit on the right.
// The captured console output still renders AS-IS (monospace <pre>, no
// markdown) in a dismissible panel.
// Draft persistence (T93, FR-69): the unsent text and the manually dragged
// textarea height live in localStorage PER PEER (draft-store.ts) — leaving the
// page and coming back restores the composer; a successful send clears the text.

import { useEffect, useRef, useState } from "react";
import { CameraDialog } from "./Camera";
import { blobUrl, uploadBlob } from "./api";
import {
  type Attachment,
  VOICE_MIME_CANDIDATES,
  addAttachment,
  captureName,
  pickRecorderMime,
  removeAttachment,
} from "./draft";
import { loadDraft, saveDraft } from "./draft-store";
import { useT } from "./i18n-context";
import { IconCamera, IconCollapse, IconExpand, IconMonitor, IconPaperclip } from "./icons";

/** Screen Live poll cadence (FR-102) — configurable here in code. */
export const SCREEN_LIVE_INTERVAL_MS = 3000;

export interface Draft {
  readonly text: string;
  readonly blobs: readonly Attachment[];
}

export function Composer(props: {
  onSend: (draft: Draft) => Promise<void>;
  /** The open peer — the draft-persistence key (FR-69); the parent keys the mount on it. */
  peer?: string;
  /** Configured slash commands of the open peer (FR-66); empty ⇒ no submenu. */
  commands?: readonly string[];
  /** Runs a command; resolves to the console output as-is. */
  onCommand?: (slash: string) => Promise<string>;
  /** Fetches the peer's live console snapshot (FR-102) — the Screen Live poll. */
  onScreen?: () => Promise<string>;
  /**
   * Raw transport mode (FR-88, §14.3): the text is sent to the terminal as-is.
   * Media is disabled — the attach/camera/mic paths hide, file drop/paste is
   * ignored — and a note explains the mode under the composer.
   */
  raw?: boolean;
  /**
   * The open peer is PAUSED (§16.6, FR-120). The composer is deliberately NOT
   * disabled: the whole point of a pause is that the sender gets an immediate,
   * honest refusal — so the send goes out, comes back rejected and renders as a
   * failed send. A note under the composer says so up front.
   */
  paused?: boolean;
  /**
   * The paused peer is a PERSON, so the pause is their do-not-disturb (§17.8,
   * FR-134): it refuses what OTHERS send them, their own notes still land — the
   * note under the composer must say that, not the agent wording.
   */
  dnd?: boolean;
}): React.JSX.Element {
  const t = useT();
  const raw = props.raw === true;
  const paused = props.paused === true;
  const dnd = props.dnd === true;
  // peer is mount-constant (the parent remounts per chat via key=) — the lazy
  // initializers read the persisted draft exactly once (FR-69).
  const peer = props.peer;
  const [text, setText] = useState(() => (peer === undefined ? "" : loadDraft(peer).text));
  const [height, setHeight] = useState<number | undefined>(() =>
    peer === undefined ? undefined : loadDraft(peer).height,
  );
  const [blobs, setBlobs] = useState<readonly Attachment[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [camera, setCamera] = useState(false);
  const [running, setRunning] = useState<string | undefined>(undefined);
  const [menuOpen, setMenuOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  // Full-screen mode for long messages (FR-70, T222): the composer card itself
  // GROWS to fill the pane (the Gemini idiom) — no separate editor window. The
  // same textarea and the same text state, so drafts persist and Enter still
  // sends; Esc or the corner button shrink it back.
  const [expanded, setExpanded] = useState(false);
  // Screen Live (FR-102): a popup that polls the peer's console snapshot; the
  // "+" menu opens it, closing the popup stops the polling.
  const [screenLive, setScreenLive] = useState(false);
  const [commandOutput, setCommandOutput] = useState<{ slash: string; output: string } | undefined>(
    undefined,
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Persist on every change (FR-69) — small strings, no debounce needed; an
  // empty draft removes the key.
  useEffect(() => {
    if (peer === undefined) return;
    saveDraft(peer, { text, ...(height !== undefined ? { height } : {}) });
  }, [peer, text, height]);

  // Raw mode disables media (FR-88, §14.3): drop any staged attachments when it
  // turns on — there is no way to send them and no chip path to remove them.
  useEffect(() => {
    if (raw) setBlobs([]);
  }, [raw]);

  // A manual resize drag sets the textarea's INLINE style.height (the browser's
  // doing) — that is the signal to adopt and persist the height; auto-rows
  // growth never touches the inline style, so it stays auto. Full-screen mode
  // owns the height itself (T222) — nothing to adopt there.
  const adoptManualHeight = (): void => {
    if (expanded) return;
    const inline = textareaRef.current?.style.height ?? "";
    const parsed = Number.parseInt(inline, 10);
    if (inline !== "" && Number.isFinite(parsed) && parsed > 0 && parsed !== height) {
      setHeight(parsed);
    }
  };

  // Esc shrinks the full-screen composer (T222) — window-level, like the old
  // editor dialog, so it fires even when a click moved focus off the textarea.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setExpanded(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  // Growing or shrinking keeps the caret where the writing happens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refocus fires BECAUSE the mode flipped — `expanded` is the trigger, not a read
  useEffect(() => {
    textareaRef.current?.focus();
  }, [expanded]);

  const closeMenu = (): void => {
    setMenuOpen(false);
    setCommandsOpen(false);
  };

  const runCommand = async (slash: string): Promise<void> => {
    const onCommand = props.onCommand;
    if (onCommand === undefined || running !== undefined) return;
    closeMenu();
    setRunning(slash);
    setError(undefined);
    try {
      setCommandOutput({ slash, output: await onCommand(slash) });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "command failed");
    } finally {
      setRunning(undefined);
    }
  };

  const attach = async (files: Iterable<File>): Promise<void> => {
    setError(undefined);
    for (const file of files) {
      setUploading((count) => count + 1);
      try {
        const meta = await uploadBlob(file); // caps enforced server-side (§12.5)
        setBlobs((list) => addAttachment(list, meta));
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "upload failed");
      } finally {
        setUploading((count) => count - 1);
      }
    }
  };

  const submit = async (): Promise<void> => {
    const trimmed = text.trim();
    if ((trimmed === "" && blobs.length === 0) || sending || uploading > 0) return;
    setSending(true);
    setError(undefined);
    try {
      await props.onSend({ text: trimmed, blobs });
      setText("");
      setBlobs([]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "send failed");
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const hasCamera = typeof navigator !== "undefined" && navigator.mediaDevices !== undefined;
  const commands = props.commands ?? [];
  // The "+" always opens the full-screen editor (FR-70), plus attach/camera
  // (hidden in raw mode, §14.3) and slash commands — so it is always present.
  const hasMenuItems = true;

  // The adaptive corner button (T222): appears once the draft is 4+ lines tall
  // (there is something worth a bigger canvas) and stays while grown (it is the
  // way back). Mirrors the Gemini corner control on the reference screenshot.
  const showCorner = expanded || text.split("\n").length >= 4;

  return (
    <footer
      className={`composer${expanded ? " expanded" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        if (raw) return; // media disabled in raw mode (§14.3)
        void attach(event.dataTransfer.files);
      }}
    >
      {showCorner && (
        <button
          type="button"
          className="composer-expand"
          title={t(expanded ? "Collapse" : "Full screen")}
          aria-label={t(expanded ? "Collapse" : "Full screen")}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <IconCollapse size={15} /> : <IconExpand size={15} />}
        </button>
      )}
      {commandOutput !== undefined && (
        <div className="command-output">
          <div className="command-output-head">
            <span>/{commandOutput.slash}</span>
            <button
              type="button"
              className="chip-remove"
              aria-label={t("close command output")}
              onClick={() => setCommandOutput(undefined)}
            >
              ×
            </button>
          </div>
          {/* as-is: monospace text, NO markdown (FR-66) */}
          <pre>{commandOutput.output}</pre>
        </div>
      )}
      {blobs.length > 0 && (
        <div className="chips">
          {blobs.map((attachment) =>
            attachment.mime.startsWith("image/") ? (
              /* image attachments preview as thumbnails (T96): the blob is
                 already uploaded — the chip renders it back via blobUrl */
              <span className="chip chip-image" key={attachment.id}>
                <img
                  className="chip-thumb"
                  src={blobUrl(attachment.id)}
                  alt={attachment.label}
                  title={attachment.label}
                />
                <button
                  type="button"
                  className="chip-remove chip-remove-overlay"
                  aria-label={`remove ${attachment.label}`}
                  onClick={() => setBlobs((list) => removeAttachment(list, attachment.id))}
                >
                  ×
                </button>
              </span>
            ) : (
              <span className="chip" key={attachment.id}>
                {attachment.label}
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={`remove ${attachment.label}`}
                  onClick={() => setBlobs((list) => removeAttachment(list, attachment.id))}
                >
                  ×
                </button>
              </span>
            ),
          )}
        </div>
      )}
      <div className="composer-shell">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            void attach(event.target.files ?? []);
            event.target.value = "";
          }}
        />
        {hasMenuItems && (
          <span className="plus-anchor">
            {menuOpen && (
              <>
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: a transparent click-away backdrop, Esc/menu buttons carry the keyboard path */}
                <span className="menu-backdrop" onClick={closeMenu} />
                <span className="composer-menu" role="menu">
                  {/* full-screen composer for long messages (FR-70, T222) — always available */}
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    onClick={() => {
                      closeMenu();
                      setExpanded(true);
                    }}
                  >
                    <span className="menu-icon">
                      <IconExpand size={14} />
                    </span>{" "}
                    {t("Full screen")}
                  </button>
                  {/* live console watch (FR-102) — present when the parent wires it */}
                  {props.onScreen !== undefined && (
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        closeMenu();
                        setScreenLive(true);
                      }}
                    >
                      <span className="menu-icon">
                        <IconMonitor size={14} />
                      </span>{" "}
                      {t("Screen Live")}
                    </button>
                  )}
                  {/* media items hide in raw mode (§14.3) */}
                  {!raw && <span className="menu-separator" />}
                  {!raw && (
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        closeMenu();
                        fileInputRef.current?.click();
                      }}
                    >
                      <span className="menu-icon">
                        <IconPaperclip size={14} />
                      </span>{" "}
                      {t("Attach files")}
                    </button>
                  )}
                  {!raw && hasCamera && (
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        closeMenu();
                        setCamera(true);
                      }}
                    >
                      <span className="menu-icon">
                        <IconCamera size={14} />
                      </span>{" "}
                      {t("Camera")}
                    </button>
                  )}
                  {commands.length > 0 && (
                    <>
                      {/* always divided from the item(s) above — expand is always present */}
                      <span className="menu-separator" />
                      <span className="submenu-anchor">
                        <button
                          type="button"
                          role="menuitem"
                          className={`menu-item${commandsOpen ? " active" : ""}`}
                          aria-haspopup="menu"
                          aria-expanded={commandsOpen}
                          onClick={() => setCommandsOpen(!commandsOpen)}
                        >
                          <span className="menu-icon">/</span> {t("Slash commands")}
                          <span className="submenu-arrow">›</span>
                        </button>
                        {commandsOpen && (
                          <span className="composer-menu submenu" role="menu">
                            {commands.map((slash) => (
                              <button
                                type="button"
                                role="menuitem"
                                key={slash}
                                className="menu-item"
                                disabled={running !== undefined}
                                onClick={() => void runCommand(slash)}
                              >
                                /{slash}
                              </button>
                            ))}
                          </span>
                        )}
                      </span>
                    </>
                  )}
                </span>
              </>
            )}
            <button
              type="button"
              className={`plus-button${menuOpen ? " open" : ""}`}
              title={t("Attachments and commands")}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
            >
              {running !== undefined ? (
                "…"
              ) : (
                /* a stroke icon like the mic's (T102) — the glyphs disagreed in weight */
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              )}
            </button>
          </span>
        )}
        <textarea
          ref={textareaRef}
          rows={Math.min(6, text.split("\n").length)}
          /* the persisted manual height (FR-69) wins over auto rows — except
             full-screen (T222), where the grid owns the whole canvas */
          style={!expanded && height !== undefined ? { height: `${height}px` } : undefined}
          placeholder={
            raw
              ? t("Terminal command or prompt… (Enter to send)")
              : t("Message… (Enter to send, Shift+Enter for a new line)")
          }
          value={text}
          onChange={(event) => setText(event.target.value)}
          onPointerUp={adoptManualHeight}
          onPaste={(event) => {
            if (raw) return; // media disabled in raw mode (§14.3)
            const files = [...event.clipboardData.files];
            if (files.length > 0) {
              event.preventDefault();
              void attach(files);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {/* the mic is a media source — hidden in raw mode (§14.3) */}
        {!raw && <MicButton onCaptured={(file) => void attach([file])} onError={setError} />}
        <button
          type="button"
          className="send-button"
          title={uploading > 0 ? t("Uploading…") : t("Send")}
          aria-label={t("Send")}
          disabled={sending || uploading > 0 || (text.trim() === "" && blobs.length === 0)}
          onClick={() => void submit()}
        >
          {uploading > 0 ? (
            "…"
          ) : (
            /* the same stroke language as the mic and the "+" (T102) */
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          )}
        </button>
      </div>
      {/* the pause note under the composer (§16.6, FR-120) */}
      {paused && (
        <p className="composer-note paused-note">
          {t(
            dnd
              ? "Do not disturb: messages from others are rejected, not queued. Notes to self still land. Turn it off in the actions menu."
              : "This agent is paused: messages to it are rejected, not queued. Resume it from the actions menu.",
          )}
        </p>
      )}
      {/* the raw-mode note under the composer (FR-88, §14.3) */}
      {raw && (
        <p className="composer-note">
          {t(
            "Raw mode: your text is sent to the terminal as-is and the console output comes back as the reply. Media is disabled.",
          )}
        </p>
      )}
      {error !== undefined && <p className="error">{error}</p>}
      {camera && (
        <CameraDialog
          onCaptured={(file) => {
            setCamera(false);
            void attach([file]);
          }}
          onClose={() => setCamera(false)}
        />
      )}
      {screenLive && props.onScreen !== undefined && (
        <ScreenLiveDialog fetchScreen={props.onScreen} onClose={() => setScreenLive(false)} />
      )}
    </footer>
  );
}

// Screen Live (FR-102): a popup that polls the peer's console snapshot on a
// fixed cadence and shows it as-is (monospace <pre>, no markdown — it is a raw
// terminal capture). The polling lives entirely inside this component, so
// closing the popup (Esc / the ✕ / a backdrop click) unmounts it and stops the
// interval — the mode never runs in the background.
function ScreenLiveDialog(props: {
  fetchScreen: () => Promise<string>;
  onClose: () => void;
}): React.JSX.Element {
  const t = useT();
  const [output, setOutput] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const next = await props.fetchScreen();
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
  }, [props.fetchScreen]);

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

  return (
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
    </div>
  );
}

// One-button voice note (§12.5): tap to record, tap to stop → audio/webm file.
function MicButton(props: {
  onCaptured: (file: File) => void;
  onError: (message: string) => void;
}): React.JSX.Element | null {
  const t = useT();
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);

  if (
    typeof navigator === "undefined" ||
    navigator.mediaDevices === undefined ||
    typeof MediaRecorder === "undefined"
  ) {
    return null; // no capture API — the button simply is not there
  }

  const start = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickRecorderMime(VOICE_MIME_CANDIDATES, (candidate) =>
        MediaRecorder.isTypeSupported(candidate),
      );
      const recorder = new MediaRecorder(stream, mime !== undefined ? { mimeType: mime } : {});
      const parts: Blob[] = [];
      recorder.addEventListener("dataavailable", (event) => parts.push(event.data));
      recorder.addEventListener("stop", () => {
        for (const track of stream.getTracks()) track.stop();
        const type = recorder.mimeType || "audio/webm";
        props.onCaptured(new File(parts, captureName("voice", Date.now(), type), { type }));
      });
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      props.onError("microphone unavailable or permission denied");
    }
  };

  const stop = (): void => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  };

  return (
    <button
      type="button"
      className={`icon-button${recording ? " recording" : ""}`}
      title={recording ? t("Stop recording") : t("Record a voice note")}
      aria-label={recording ? t("Stop recording") : t("Record a voice note")}
      onClick={() => (recording ? stop() : void start())}
    >
      {recording ? (
        // stop: a filled rounded square
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      ) : (
        // mic: capsule + stand (emoji rendered as a thin glyph on light themes)
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
          <line x1="12" y1="18" x2="12" y2="22" />
        </svg>
      )}
    </button>
  );
}
