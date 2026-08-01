// The message feed (§12.7): chronological bubbles, scroll-up history paging,
// outgoing lifecycle ticks (§12.4 queue-progress), media bubbles (§12.5).
// Text renders through MessageText (FR-61): the constrained markdown renderer
// (React elements only, no innerHTML — §12.6) plus copy/source hover actions.

import { useEffect, useReducer, useRef, useState } from "react";
import { FilterNote } from "./FilterNote";
import { MessageText } from "./MessageText";
import { RzArrows } from "./RzArrows";
import { SCREEN_LIVE_INTERVAL_MS, ScreenLiveDialog } from "./ScreenLive";
import { TokenMeter } from "./TokenMeter";
import { agentAction, blobUrl, clearHistory, exportHistoryUrl, setAgentPaused } from "./api";
import { usePinnedFeed } from "./feed-pin";
import { matchesQuery } from "./filter";
import { useT } from "./i18n-context";
import {
  IconCheck,
  IconClock,
  IconDownload,
  IconFile,
  IconGroup,
  IconKebab,
  IconMonitor,
  IconPause,
  IconPlay,
  IconPower,
  IconRotate,
  IconSend,
  IconTag,
  IconTrash,
  IconX,
} from "./icons";
import { chatSurface, dotClass, hasConsole, liveLabel } from "./peer-surface";
import { routeHash } from "./route";
import { type ChatThread, peerOf } from "./store";
import { TimeStamp } from "./timestamp";
import {
  type BlobRef,
  type ChatRecord,
  type MessagePhase,
  type PeerInfo,
  payloadParts,
  peerKind,
} from "./types";

/**
 * Which side of the feed a bubble sits on. With the logged-in name known
 * (users mode, §17.7) it is simply "did I write this" — the pre-§17 fallback
 * "whoever is not a listed peer is us" cannot answer it there, because the
 * viewer's own name IS a peer row (the self-chat).
 */
const isMine = (
  from: string,
  self: string | undefined,
  isPeer: (name: string) => boolean,
): boolean => (self !== undefined ? from === self : !isPeer(from));

/* the queue-progress ticks (§12.4) in the shared stroke language (T112) */
const PHASE_TICK: Record<MessagePhase, React.JSX.Element> = {
  queued: <IconClock size={11} />,
  pending: <IconClock size={11} />,
  cur: <IconSend size={11} />,
  done: <IconCheck size={11} />,
  failed: <IconX size={11} />,
};

export function ChatView(props: {
  peer: PeerInfo | undefined;
  thread: ChatThread;
  phases: Readonly<Record<string, MessagePhase>>;
  isPeer: (name: string) => boolean;
  /**
   * The logged-in user (§17.7, FR-127). It decides which side a bubble sits on
   * — in users mode the viewer is a peer row too, so "not a peer ⇒ mine" breaks
   * — and marks the self-chat, whose feed is the aggregate of every pair.
   */
  self?: string | undefined;
  onLoadOlder: () => void;
  /** Global auto-scroll switch (FR-62): ON pins the feed to the newest message. */
  follow?: boolean;
  /** Token-usage display (FR-72): show the chat-header token meter; default on. */
  showTokens?: boolean;
  /** Global message filter (T97, FR-71) — the topbar search field. */
  query?: string;
  /** Deep-linked message id (T107, FR-75) — scroll to it and flash it. */
  anchor?: string | undefined;
}): React.JSX.Element {
  const t = useT();
  const peer = props.peer;
  const surface = chatSurface(peer);
  // Groups & tags (§15) are input-only broadcast targets — a one-directional
  // view without the agent-only chrome (status/thinking/token meter/lifecycle).
  // A PERSON (§17.7, oneself included) is NOT one of them: their chat is an
  // ordinary 1:1 chat and falls through to the header below.
  if (peer !== undefined && surface === "broadcast") {
    return (
      <BroadcastChatView
        peer={peer}
        thread={props.thread}
        phases={props.phases}
        isPeer={props.isPeer}
        {...(props.self !== undefined ? { self: props.self } : {})}
        onLoadOlder={props.onLoadOlder}
        {...(props.follow !== undefined ? { follow: props.follow } : {})}
        {...(props.query !== undefined ? { query: props.query } : {})}
        {...(props.anchor !== undefined ? { anchor: props.anchor } : {})}
      />
    );
  }
  // A person (§17.7) gets the SAME header as an agent — dot, name, status line,
  // actions kebab — with the two session-only pieces dropped: the dot shows
  // presence (FR-133) and there is no token meter behind a human.
  const person = surface === "person";
  return (
    <>
      <header className="chat-header">
        <span className={dotClass(peer)} />
        {/* rendezvous markers (FR-105): after the activity dot, before the name */}
        {peer !== undefined && <RzArrows peer={peer} />}
        <strong className={peer?.atWipLimit === true ? "at-wip" : undefined}>
          {peer?.name ?? ""}
        </strong>
        {/* Pause chip (§16.6, FR-120): the operator-declared do-not-disturb, shown
            BESIDE the live status — the session may well be idle or busy. For a
            person the same flag IS do-not-disturb (§17.8, FR-134). */}
        {peer?.paused === true && (
          <span
            className="paused-chip"
            title={t(
              person
                ? "messages from others are rejected — do not disturb"
                : "messages to this agent are rejected",
            )}
          >
            <IconPause size={12} /> {t(person ? "do not disturb" : "paused")}
          </span>
        )}
        <span className="chat-status">
          {peer?.status === "busy" ? (
            <>
              {t("thinking…")}
              {peer.busySince !== undefined && <BusyTimer since={peer.busySince} />}
            </>
          ) : (
            t(person ? liveLabel(peer) : (peer?.status ?? ""))
          )}
        </span>
        {/* token meter (§12.8, FR-103) fills the empty span between status and the
            kebab; hidden when the Settings token-usage switch is off (FR-72) and
            for a person — a human burns no tokens and has no series to ask for */}
        {peer !== undefined && !person && (props.showTokens ?? true) && (
          <TokenMeter peer={peer.name} />
        )}
        {peer !== undefined && <ChatActionsMenu key={peer.name} peer={peer} />}
      </header>
      <MessageFeed
        peerName={peer?.name}
        thread={props.thread}
        phases={props.phases}
        isPeer={props.isPeer}
        {...(props.self !== undefined ? { self: props.self } : {})}
        onLoadOlder={props.onLoadOlder}
        {...(props.follow !== undefined ? { follow: props.follow } : {})}
        {...(props.query !== undefined ? { query: props.query } : {})}
        {...(props.anchor !== undefined ? { anchor: props.anchor } : {})}
      />
    </>
  );
}

// The group/tag chat (§15, FR-106/FR-107): a ONE-DIRECTIONAL broadcast view.
// The header shows the target's name + its icon and a "broadcast → <members>"
// subheader (a group resolves hierarchically server-side); there is NO status
// dot, NO "thinking…", NO token meter, NO lifecycle kebab and NO Screen-Live —
// a broadcast target has no status or lifecycle. The feed shows the operator's
// outgoing broadcasts (server history under the target name); the composer
// (mounted by the parent) sends through the same send path, raw mode disabled.
function BroadcastChatView(props: {
  peer: PeerInfo;
  thread: ChatThread;
  phases: Readonly<Record<string, MessagePhase>>;
  isPeer: (name: string) => boolean;
  self?: string | undefined;
  onLoadOlder: () => void;
  follow?: boolean;
  query?: string;
  anchor?: string | undefined;
}): React.JSX.Element {
  const t = useT();
  const { peer } = props;
  const isGroup = peerKind(peer) === "group";
  const members = peer.members ?? [];
  return (
    <>
      <header className="chat-header broadcast-header">
        <span className="broadcast-icon">
          {isGroup ? <IconGroup size={16} /> : <IconTag size={16} />}
        </span>
        <strong>{peer.name}</strong>
        <span className="chat-status broadcast-target">
          {members.length > 0
            ? `${t("broadcast →")} ${members.join(", ")}`
            : t(isGroup ? "broadcast group (no members)" : "broadcast tag (no members)")}
        </span>
      </header>
      <MessageFeed
        peerName={peer.name}
        thread={props.thread}
        phases={props.phases}
        isPeer={props.isPeer}
        {...(props.self !== undefined ? { self: props.self } : {})}
        onLoadOlder={props.onLoadOlder}
        {...(props.follow !== undefined ? { follow: props.follow } : {})}
        {...(props.query !== undefined ? { query: props.query } : {})}
        {...(props.anchor !== undefined ? { anchor: props.anchor } : {})}
      />
    </>
  );
}

// The shared message feed (§12.7): the pinned auto-scroll (T106), scroll-up
// history paging (§12.4), the global filter (FR-71) and the deep-link anchor
// (FR-75) — reused by the agent chat AND the group/tag broadcast view, which
// differ only in their header.
function MessageFeed(props: {
  /** The open chat's peer name — the deep-link route key (T107, FR-75). */
  peerName?: string;
  thread: ChatThread;
  phases: Readonly<Record<string, MessagePhase>>;
  isPeer: (name: string) => boolean;
  /** The logged-in user (§17.7) — the "mine" side and the self-chat marker. */
  self?: string | undefined;
  onLoadOlder: () => void;
  follow?: boolean;
  query?: string;
  anchor?: string | undefined;
}): React.JSX.Element {
  // The self-chat (§17.7, FR-128): the open chat IS the viewer — its feed
  // aggregates every pair, so each bubble points back at its own pair chat.
  const selfView = props.self !== undefined && props.peerName === props.self;
  // The global filter (FR-71): hide non-matching bubbles, COUNT what is hidden
  // — the strip under the header keeps the filtered view honest.
  const query = props.query ?? "";
  const filtering = query.trim() !== "";
  const records = filtering
    ? props.thread.records.filter((record) => matchesQuery(record, query))
    : props.thread.records;

  // Pinned feed (T106): opening lands on the newest message (async media
  // included), staying near the bottom keeps following; FR-62 forces it.
  // With a deep link open (FR-75) the pin is OFF — the anchor owns the scroll.
  const lastId = records[records.length - 1]?.id;
  const {
    feedRef,
    contentRef,
    onScroll: onPinScroll,
  } = usePinnedFeed(props.follow, lastId, props.anchor === undefined);

  const onScroll = (): void => {
    onPinScroll();
    const feed = feedRef.current;
    if (feed === null) return;
    if (feed.scrollTop < 40 && props.thread.nextBefore !== undefined) props.onLoadOlder();
  };

  // Deep link (FR-75): once per anchor — find the bubble, center it, flash it;
  // not loaded yet → page older history (cap 20 pages: a pruned/foreign id must
  // not pull the whole log). scrollIntoView fires a scroll event, so the T106
  // pin unsticks by itself and later media growth does not yank the view down.
  const anchorState = useRef<{ done?: string; tried?: string; pages: number }>({ pages: 0 });
  // biome-ignore lint/correctness/useExhaustiveDependencies: records drive the retry as pages load
  useEffect(() => {
    const anchor = props.anchor;
    if (anchor === undefined || anchorState.current.done === anchor) return;
    if (anchorState.current.tried !== anchor) anchorState.current = { tried: anchor, pages: 0 };
    const el = feedRef.current?.querySelector(`[data-msg-id="${CSS.escape(anchor)}"]`);
    if (el !== null && el !== undefined) {
      anchorState.current = { done: anchor, tried: anchor, pages: 0 };
      el.scrollIntoView({ block: "center" });
      el.classList.add("anchored");
      setTimeout(() => el.classList.remove("anchored"), 2600);
      return;
    }
    if (props.thread.loaded && props.thread.nextBefore !== undefined) {
      if (anchorState.current.pages >= 20) return;
      anchorState.current.pages += 1;
      props.onLoadOlder();
    }
  }, [props.anchor, records, props.thread.loaded, props.thread.nextBefore]);

  const t = useT();
  return (
    <>
      {filtering && (
        <FilterNote
          hidden={props.thread.records.length - records.length}
          total={props.thread.records.length}
        />
      )}
      <div className="feed" ref={feedRef} onScroll={onScroll}>
        {/* the wrapper is the ResizeObserver target (T106) — content growth re-pins */}
        <div className="feed-content" ref={contentRef}>
          {props.thread.nextBefore !== undefined && (
            <button type="button" className="load-older" onClick={props.onLoadOlder}>
              {t("Load older messages")}
            </button>
          )}
          {records.map((record) => (
            <Bubble
              key={record.id}
              record={record}
              mine={isMine(record.from, props.self, props.isPeer)}
              phase={props.phases[record.id]}
              /* In the self-chat (§17.7) the feed is the aggregate of every pair,
                 so a bubble's link opens the chat it actually belongs to (the
                 jump-to-the-pair of FR-128); elsewhere it is this chat. */
              chatPeer={
                selfView
                  ? peerOf(record, (name) => !props.isPeer(name), props.self)
                  : props.peerName
              }
            />
          ))}
        </div>
      </div>
    </>
  );
}

// The chat-header actions menu (T113): the toolbar carries ONE kebab (⋮)
// button; the lifecycle actions (FR-65) are items of its popover — the same
// backdrop click-away as every other panel menu. The two-click confirm STAYS
// on the destructive items ("Sure?", 3s): shutting an agent down or wiping a
// chat is destructive, opening the menu alone is not deliberate enough.
// History items (FR-84): Export JSON is a plain download link (harmless,
// no confirm); Clear chat drops the pair's whole server-side log — the
// thread empties through the history-cleared WS push, not a local guess.
function ChatActionsMenu(props: { peer: PeerInfo }): React.JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  // Screen Live (FR-102) moved here from the composer's "+" menu in T228
  // (operator's call): watching a console observes the AGENT, it does not help
  // compose a message — it belongs with the other agent actions.
  const [screen, setScreen] = useState(false);
  const peer = props.peer;
  // only a local agent has a tmux pane to capture (§17.7, §15.5, §18.4)
  const canWatch = hasConsole(peer);
  const canReload = peer.actions?.reload === true;
  // The server already answers whether there is a session to tear down (it is
  // false for a person, §17.7) — asking the flag keeps the menu honest instead
  // of inferring "not down ⇒ can shut down" from a status a human never has.
  const canShutdown = peer.actions?.shutdown === true;
  // Pause needs no live session (§16.6) — it gates the transport, not the console.
  const canPause = peer.actions?.pause === true;
  return (
    <span className="filter-anchor chat-actions">
      <button
        type="button"
        className="kebab-button"
        title={t("Agent actions")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <IconKebab size={16} />
      </button>
      {open && (
        <>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: a transparent click-away backdrop, the menu buttons carry the keyboard path */}
          <span className="menu-backdrop" onClick={() => setOpen(false)} />
          <span className="filter-menu" role="menu">
            {canWatch && (
              <button
                type="button"
                role="menuitem"
                className="filter-option"
                title={t("live console — refreshes every {seconds}s").replace(
                  "{seconds}",
                  String(Math.round(SCREEN_LIVE_INTERVAL_MS / 1000)),
                )}
                onClick={() => {
                  setOpen(false);
                  setScreen(true);
                }}
              >
                <IconMonitor size={14} /> {t("Screen Live")}
              </button>
            )}
            <a
              role="menuitem"
              className="filter-option"
              href={exportHistoryUrl(peer.name)}
              download
              title={`${t("Export JSON")} — ${t("the chat history")}`}
              onClick={() => setOpen(false)}
            >
              <IconDownload size={14} /> {t("Export JSON")}
            </a>
            <LifecycleItem
              label="Clear chat"
              hint="the chat history"
              icon={<IconTrash size={14} />}
              danger
              onConfirm={() => clearHistory(peer.name)}
              onDone={() => setOpen(false)}
            />
            {canPause && (
              <PauseItem
                peer={peer.name}
                paused={peer.paused === true}
                onDone={() => setOpen(false)}
              />
            )}
            {canReload && (
              <LifecycleItem
                label="Reload"
                icon={<IconRotate size={14} />}
                onConfirm={() => agentAction(peer.name, "reload")}
                onDone={() => setOpen(false)}
              />
            )}
            {canShutdown && (
              <LifecycleItem
                label="Shutdown"
                icon={<IconPower size={14} />}
                danger
                onConfirm={() => agentAction(peer.name, "shutdown")}
                onDone={() => setOpen(false)}
              />
            )}
          </span>
        </>
      )}
      {/* the popup outlives the menu it was opened from — closing the menu must
          not stop the watch (the dialog portals itself out of here) */}
      {screen && <ScreenLiveDialog peer={peer.name} onClose={() => setScreen(false)} />}
    </span>
  );
}

// The pause toggle (§16.6, FR-120) — a menuitemCHECKBOX, not a lifecycle item:
// pausing is REVERSIBLE and destroys nothing, so it carries NO two-click confirm
// (unlike Shutdown / Clear chat). The checked state comes from the server (the
// `paused` flag on the peer, refreshed by the WS status push), so a flip made in
// another tab is reflected here; a failure flashes "Failed" in place and keeps the
// menu open. The request always states the DESIRED value, never a toggle (§16.4).
function PauseItem(props: {
  peer: string;
  paused: boolean;
  onDone: () => void;
}): React.JSX.Element {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const label = props.paused ? "Resume" : "Pause";

  const click = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailed(undefined);
    try {
      await setAgentPaused(props.peer, !props.paused);
      props.onDone();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "failed");
      setTimeout(() => setFailed(undefined), 4000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={props.paused}
      className="filter-option"
      disabled={busy}
      title={failed ?? t("block/unblock message delivery to this agent")}
      onClick={() => void click()}
    >
      {props.paused ? <IconPlay size={14} /> : <IconPause size={14} />}{" "}
      {failed !== undefined ? t("Failed") : busy ? "…" : t(label)}
    </button>
  );
}

// A lifecycle menu item (FR-65) with the two-click confirm: the first click
// ARMS it for 3s ("Sure?"), the second fires the action — no blocking browser
// dialogs. Success closes the menu; a refusal flashes "Failed" in place (the
// message lands in the title) and keeps the menu open.
function LifecycleItem(props: {
  label: string;
  icon: React.JSX.Element;
  danger?: boolean;
  /** The tooltip's object ("<label> — <hint>"); default: the agent (FR-65). */
  hint?: string;
  onConfirm: () => Promise<unknown>;
  onDone: () => void;
}): React.JSX.Element {
  const t = useT();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);

  const click = async (): Promise<void> => {
    if (busy) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    setBusy(true);
    setFailed(undefined);
    try {
      await props.onConfirm();
      props.onDone();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "failed");
      setTimeout(() => setFailed(undefined), 4000);
    } finally {
      setBusy(false);
    }
  };

  const cls = `filter-option${props.danger === true ? " danger" : ""}${armed ? " armed" : ""}`;
  return (
    <button
      type="button"
      role="menuitem"
      className={cls}
      disabled={busy}
      title={failed ?? `${t(props.label)} — ${t(props.hint ?? "the agent")}`}
      onClick={() => void click()}
    >
      {props.icon}{" "}
      {failed !== undefined ? t("Failed") : busy ? "…" : armed ? t("Sure?") : t(props.label)}
    </button>
  );
}

// Per-second elapsed timer next to "thinking…" (FR-63) — unmounts (and thus
// disappears) together with the busy status; only this leaf re-renders on tick.
function BusyTimer(props: { since: number }): React.JSX.Element {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="busy-timer"> {formatElapsed(Date.now() - props.since)}</span>;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  if (minutes > 0) return `${minutes}:${String(seconds).padStart(2, "0")}`;
  return `${seconds}s`;
}

function Bubble(props: {
  record: ChatRecord;
  mine: boolean;
  phase: MessagePhase | undefined;
  /** The open chat's peer name — the deep-link route key (T107, FR-75). */
  chatPeer?: string | undefined;
}): React.JSX.Element {
  const { text, blobs } = payloadParts(props.record.payload);
  // data-msg-id is the anchor target; the hash feeds the link button
  const messageHash =
    props.chatPeer !== undefined
      ? routeHash({ view: "chat", peer: props.chatPeer, message: props.record.id })
      : undefined;
  // Raw mode (FR-88, §14.3): the operator's verbatim command and the captured
  // console reply both render AS-IS — monospace, no markdown (origin "raw" marks
  // the captured reply, the `raw` flag marks the outgoing command).
  const asIs = props.record.raw === true || props.record.origin === "raw";
  return (
    <div className={`bubble-row ${props.mine ? "mine" : "theirs"}`}>
      <div className="bubble" data-msg-id={props.record.id}>
        {text !== undefined &&
          (asIs ? (
            <pre className="raw-output">{text}</pre>
          ) : (
            <MessageText text={text} {...(messageHash !== undefined ? { messageHash } : {})} />
          ))}
        {blobs.map((blob) => (
          <MediaBubble key={blob.blob} blob={blob} />
        ))}
        <span className="bubble-meta">
          {/* Route in front of the time (FR-148): the bubble side alone says who
              wrote it only as long as the chat has two distinct sides — a note to
              SELF (§17.7) has the same name on both ends and a broadcast bubble
              (§15) hides which target it went to. The same `from → to` idiom as
              the transport journal (FR-48), one text node so it wraps as a unit. */}
          <span className="bubble-route">{`${props.record.from} → ${props.record.to}`}</span>{" "}
          <TimeStamp ts={props.record.ts} />
          {props.mine && props.phase !== undefined && (
            <span className={`tick ${props.phase}`} title={props.phase}>
              {" "}
              {PHASE_TICK[props.phase]}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

// Inline players for media (§12.5/§12.7); anything else is a download card.
function MediaBubble(props: { blob: BlobRef }): React.JSX.Element {
  const { blob } = props;
  const mime = blob.mime ?? "";
  const url = blobUrl(blob.blob);
  if (mime.startsWith("image/")) {
    return <img className="media" src={url} alt={blob.name ?? blob.blob} />;
  }
  if (mime.startsWith("audio/")) {
    // biome-ignore lint/a11y/useMediaCaption: voice notes have no caption track
    return <audio className="media" controls src={url} />;
  }
  if (mime.startsWith("video/")) {
    // biome-ignore lint/a11y/useMediaCaption: camera clips have no caption track
    return <video className="media" controls src={url} />;
  }
  return (
    <a className="file-card" href={url} download={blob.name ?? blob.blob}>
      <IconFile size={14} /> {blob.name ?? blob.blob}
      {blob.size !== undefined && <span className="file-size"> {formatSize(blob.size)}</span>}
    </a>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
