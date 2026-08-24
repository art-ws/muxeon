// The message feed (§12.7): chronological bubbles, scroll-up history paging,
// outgoing lifecycle ticks (§12.4 queue-progress), media bubbles (§12.5).
// Text renders through MessageText (FR-61): the constrained markdown renderer
// (React elements only, no innerHTML — §12.6) plus copy/source hover actions.

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ConsoleDialog } from "./Console";
import { FilterNote } from "./FilterNote";
import { MessageText } from "./MessageText";
import { ReactionBar } from "./Reactions";
import { RzArrows } from "./RzArrows";
import { SessionClock } from "./SessionClock";
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
import {
  chatSurface,
  dotClass,
  hasConsole,
  liveLabel,
  nameTooltip,
  peerLabel,
} from "./peer-surface";
import { quotePreview, quoteWorthShowing } from "./quote";
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
  /**
   * Quote a message in the composer (FR-178). Offered in 1:1 chats only — a
   * broadcast feed (§15.6) fans out to many recipients, so "this answers that
   * message" has no single envelope to travel in.
   */
  onReply?: (record: ChatRecord) => void;
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
        {/* the configured title labels the chat, the name stays in the tooltip
            (FR-156) — the header is a label surface, not an address */}
        <strong
          className={peer?.atWipLimit === true ? "at-wip" : undefined}
          title={nameTooltip(peer)}
        >
          {peerLabel(peer)}
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
        {/* session clock (§5.5, FR-197): "up 3d · quiet 2h" — the status says what
            the agent IS, these two spans say for how long. Agents only: a person
            has no session to be up, and no signals to be quiet between. */}
        {peer !== undefined && !person && <SessionClock peer={peer.name} />}
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
        {...(props.onReply !== undefined ? { onReply: props.onReply } : {})}
        reactable
      />
    </>
  );
}

// The group/tag chat (§15, FR-106/FR-107): a ONE-DIRECTIONAL broadcast view.
// The header shows the target's name + its icon and a "broadcast → <members>"
// subheader (a group resolves hierarchically server-side); there is NO status
// dot, NO "thinking…", NO token meter, NO lifecycle kebab and NO console —
// a broadcast target has no status or lifecycle. The feed shows the operator's
// outgoing broadcasts (server history under the target name); the composer
// (mounted by the parent) sends through the same send path.
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
  /** 1:1 feed ⇒ bubbles take reactions (§19.10); a broadcast feed does not. */
  reactable?: boolean;
  /** Quote a message in the composer (FR-178); absent ⇒ no reply buttons. */
  onReply?: (record: ChatRecord) => void;
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

  // Quotes (FR-178): which bubbles print one, and what it shows. Both are read
  // off the WHOLE thread, not the filtered view — a quote describes the record's
  // place in the conversation, and the search field must not change that.
  const all = props.thread.records;
  const quoted = useMemo(() => {
    const byId = new Map(all.map((record) => [record.id, record]));
    const shown = new Map<string, { id: string; record: ChatRecord | undefined }>();
    all.forEach((record, index) => {
      if (!quoteWorthShowing(all, index) || record.replyTo === undefined) return;
      shown.set(record.id, { id: record.replyTo, record: byId.get(record.replyTo) });
    });
    return shown;
  }, [all]);

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
              {...(props.reactable === true ? { reactable: true } : {})}
              {...(quoted.has(record.id) ? { quote: quoted.get(record.id) } : {})}
              {...(props.onReply !== undefined ? { onReply: () => props.onReply?.(record) } : {})}
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
  // Console (§12.9, FR-160) — the entry the operator's Screen Live grew into
  // (T228 moved it here from the composer's "+" menu: a console is an action on
  // the AGENT, not a way to compose a message; T270 made it interactive).
  const [consoleOpen, setConsoleOpen] = useState(false);
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
                title={t("the agent's live terminal — watch it and type into it")}
                onClick={() => {
                  setOpen(false);
                  setConsoleOpen(true);
                }}
              >
                <IconMonitor size={14} /> {t("Console")}
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
          not tear down the console (the dialog portals itself out of here) */}
      {consoleOpen && <ConsoleDialog peer={peer.name} onClose={() => setConsoleOpen(false)} />}
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
  /**
   * May this message carry reactions (§19.10)? A 1:1 chat — with an agent or a
   * person — yes; a one-directional group/tag feed (§15.6) no: there is no single
   * author to notify, so a badge there would mean nothing (decision §19.12-Q3).
   */
  reactable?: boolean;
  /**
   * This bubble ANSWERS an earlier message (FR-178): the quoted id and, when the
   * thread already holds it, the record itself. Absent ⇒ no quote line — either
   * there is no reference or it points at the bubble directly above (quote.ts).
   */
  quote?: { id: string; record: ChatRecord | undefined } | undefined;
  /** Quote THIS message in the composer; absent ⇒ no reply button. */
  onReply?: () => void;
}): React.JSX.Element {
  const t = useT();
  const { text, blobs } = payloadParts(props.record.payload);
  // data-msg-id is the anchor target; the hash feeds the link button
  const messageHash =
    props.chatPeer !== undefined
      ? routeHash({ view: "chat", peer: props.chatPeer, message: props.record.id })
      : undefined;
  // The quote is a LINK to the quoted message: the same deep-link route the link
  // button uses (FR-75), so clicking it scrolls the feed there — paging older
  // history first when the message is above what is loaded — and flashes it.
  const quote = props.quote;
  const quoteHash =
    quote !== undefined && props.chatPeer !== undefined
      ? routeHash({ view: "chat", peer: props.chatPeer, message: quote.id })
      : undefined;
  // A raw-mode record (FR-88, §14) renders AS-IS — monospace, no markdown
  // (origin "raw" marks the captured console, the `raw` flag the command that
  // asked for it). The panel no longer OFFERS raw (T271), but the transport
  // modifier and its API stayed: old history and anything sent through
  // `POST /api/send {raw:true}` must still read as a terminal, not as markdown.
  const asIs = props.record.raw === true || props.record.origin === "raw";
  return (
    <div className={`bubble-row ${props.mine ? "mine" : "theirs"}`}>
      <div className="bubble" data-msg-id={props.record.id}>
        {/* the quoted message (FR-178): author + one trimmed line, clickable —
            a pointer to the message, never a copy of it */}
        {quote !== undefined && (
          <button
            type="button"
            className="bubble-quote"
            title={t("Go to the quoted message")}
            disabled={quoteHash === undefined}
            onClick={() => {
              if (quoteHash !== undefined) location.hash = quoteHash;
            }}
          >
            <span className="bubble-quote-author">{quote.record?.from ?? t("quoted message")}</span>
            <span className="bubble-quote-text">{quotePreview(quote.record, t)}</span>
          </button>
        )}
        {text !== undefined &&
          (asIs ? (
            <pre className="raw-output">{text}</pre>
          ) : (
            <MessageText text={text} {...(messageHash !== undefined ? { messageHash } : {})} />
          ))}
        {blobs.map((blob) => (
          <MediaBubble key={blob.blob} blob={blob} />
        ))}
        {/* The bottom row under the content, above the meta line (§19.9): badges
            (a count only from 2 up), the trigger that opens the picker — and,
            since the operator's request of 2026-08-21, the REPLY button (FR-178).
            An attachment-only bubble gets the row too: it is answerable as well. */}
        {props.reactable === true && props.chatPeer !== undefined && (
          <ReactionBar
            peer={props.chatPeer}
            messageId={props.record.id}
            {...(props.onReply !== undefined ? { onReply: props.onReply } : {})}
          />
        )}
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
