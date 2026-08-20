// Reactions on a bubble (§19.9, FR-168): the badge row, the picker and the
// "who and when" popup.
//
// Three rules from the spec drive the whole layout:
//   - a COUNT shows only from 2 up — a single reaction needs no number (§19.9);
//   - the viewer's own reactions carry an accent ring, otherwise nobody can tell
//     what they already placed;
//   - the picker opens with the frequency-ordered Recent block FIRST (§19.8), then
//     the configured categories in configured order (§19.2).
//
// The palette is closed by the server catalog: there is no free-emoji input, and
// that is deliberate (§19.1) — an undeclared emoji has no text for an agent, no
// category and no meaningful place in Recent.

import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchReactionCatalog, placeReaction, removeReaction } from "./api";
import { useT } from "./i18n-context";
import { IconReaction } from "./icons";
import { useReactions } from "./reactions-context";
import { TimeStamp } from "./timestamp";
import type { ReactionCatalog, ReactionNotify, ReactionView } from "./types";

/** Reason text of a notification that did not reach the agent (§19.6). */
const NOTIFY_TEXT: Readonly<Record<string, string>> = {
  AGENT_PAUSED: "the agent is paused — it was not notified",
  WIP_LIMIT: "the agent's queue is full — it was not notified",
  UNAVAILABLE: "the router is not wired — it was not notified",
  ROUTE_FAILED: "the notification could not be routed",
};

/**
 * Badges with nothing to click (§19.13, FR-182) — the transport journal's form of
 * the same row. The journal is observation, not a chat: there is no picker, no
 * "remove mine", and `mine` is never set, because nobody reacts from here. The
 * classes are the chat bubble's, so the two rows read as the same object.
 */
export function ReactionBadges(props: {
  reactions: readonly ReactionView[];
}): React.JSX.Element | null {
  if (props.reactions.length === 0) return null;
  return (
    <span className="reaction-bar reaction-bar-static">
      {props.reactions.map((reaction) => (
        <span
          key={reaction.key}
          className="reaction-badge static"
          title={reaction.actors.map((actor) => actor.name).join(", ")}
        >
          <span className="reaction-emoji">{reaction.emoji}</span>
          {/* No number on a single reaction (§19.9) — the emoji already says it. */}
          {reaction.count > 1 && <span className="reaction-count">{reaction.count}</span>}
        </span>
      ))}
    </span>
  );
}

export function ReactionBar(props: {
  /** The pair whose log holds the message — the REST path's first segment (§19.5). */
  peer: string;
  messageId: string;
}): React.JSX.Element | null {
  const t = useT();
  const api = useReactions();
  const reactions = api.reactionsOf(props.messageId);
  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState<string | null>(null); // key whose popup is open
  const [notify, setNotify] = useState<ReactionNotify | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  if (!api.enabled && reactions.length === 0) return null;

  const act = async (key: string, remove: boolean): Promise<void> => {
    setFailed(null);
    try {
      const result = remove
        ? await removeReaction(props.peer, props.messageId, key)
        : await placeReaction(props.peer, props.messageId, key);
      api.onChanged(props.messageId, result.reactions);
      setNotify("notify" in result && result.notify !== undefined ? result.notify : null);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <span className="reaction-bar">
      {reactions.map((reaction) => (
        <button
          key={reaction.key}
          type="button"
          className={`reaction-badge${reaction.mine ? " mine" : ""}`}
          title={reaction.actors.map((actor) => actor.name).join(", ")}
          onClick={() => setOpen(open === reaction.key ? null : reaction.key)}
        >
          <span className="reaction-emoji">{reaction.emoji}</span>
          {/* No number on a single reaction (§19.9) — the emoji already says it. */}
          {reaction.count > 1 && <span className="reaction-count">{reaction.count}</span>}
        </button>
      ))}
      {api.enabled && (
        <button
          type="button"
          className="reaction-add"
          title={t("Add reaction")}
          aria-label={t("Add reaction")}
          onClick={() => setPicking(true)}
        >
          <IconReaction size={13} />
        </button>
      )}
      {failed !== null && <span className="reaction-error">{failed}</span>}
      {picking && (
        <ReactionPicker
          placed={new Set(reactions.filter((r) => r.mine).map((r) => r.key))}
          onClose={() => setPicking(false)}
          onPick={(key) => {
            setPicking(false);
            void act(key, false);
          }}
        />
      )}
      {open !== null && (
        <ReactionActors
          reaction={reactions.find((reaction) => reaction.key === open)}
          notify={notify}
          onClose={() => setOpen(null)}
          onRemove={(key) => {
            setOpen(null);
            void act(key, true);
          }}
        />
      )}
    </span>
  );
}

/**
 * The picker (§19.9): Recent first, then the categories. The catalog is fetched on
 * OPEN — the Recent order is global and moves as the stand reacts (§19.8).
 */
function ReactionPicker(props: {
  placed: ReadonlySet<string>;
  onPick: (key: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const t = useT();
  const [catalog, setCatalog] = useState<ReactionCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchReactionCatalog()
      .then((loaded) => {
        if (live) setCatalog(loaded);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, []);

  const blocks = useMemo(() => (catalog === null ? [] : pickerBlocks(catalog)), [catalog]);

  return (
    <Popup label={t("Add reaction")} onClose={props.onClose}>
      {error !== null && <div className="reaction-error">{error}</div>}
      {catalog === null && error === null && <div className="reaction-loading">…</div>}
      {blocks.map((block) => (
        <div className="reaction-block" key={block.name}>
          <div className="reaction-block-title">{block.title}</div>
          <div className="reaction-grid">
            {block.items.map((item) => (
              <button
                key={`${block.name}:${item.key}`}
                type="button"
                className={`reaction-choice${props.placed.has(item.key) ? " mine" : ""}`}
                title={item.label ?? item.key}
                onClick={() => props.onPick(item.key)}
              >
                {item.emoji}
              </button>
            ))}
          </div>
        </div>
      ))}
    </Popup>
  );
}

/** Who placed one reaction, when — and the way to take back your own (§19.9). */
function ReactionActors(props: {
  reaction: ReactionView | undefined;
  notify: ReactionNotify | null;
  onRemove: (key: string) => void;
  onClose: () => void;
}): React.JSX.Element | null {
  const t = useT();
  const { reaction } = props;
  if (reaction === undefined) return null;
  const notifyNote =
    props.notify !== null && !props.notify.delivered
      ? (NOTIFY_TEXT[props.notify.code ?? ""] ?? "the agent was not notified")
      : undefined;
  return (
    <Popup label={`${reaction.emoji} ${reaction.key}`} onClose={props.onClose}>
      <div className="reaction-who">
        {reaction.actors.map((actor) => (
          <div className="reaction-who-row" key={`${actor.name}:${actor.ts}`}>
            <span className="reaction-who-name">{actor.name}</span>
            <TimeStamp ts={actor.ts} />
          </div>
        ))}
      </div>
      {notifyNote !== undefined && <div className="reaction-note">{t(notifyNote)}</div>}
      {/* Only the author of a reaction can remove it (§10.31) — so the item exists
          only when this viewer placed this key. */}
      {reaction.mine && (
        <button
          type="button"
          className="reaction-remove"
          onClick={() => props.onRemove(reaction.key)}
        >
          {t("Remove my reaction")}
        </button>
      )}
    </Popup>
  );
}

/**
 * A small popover on the panel's portal+backdrop convention (T224): click-away and
 * Escape close it. Unlike the console (§12.9.4) a picker SHOULD close on a stray
 * click — nothing is lost by reopening it.
 */
function Popup(props: {
  label: string;
  children: React.ReactNode;
  onClose: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);
  return createPortal(
    <div className="popup-overlay reaction-overlay">
      <button
        type="button"
        className="popup-backdrop reaction-backdrop"
        aria-label="close"
        onClick={props.onClose}
      />
      <dialog open ref={ref} className="popup-dialog reaction-dialog" aria-label={props.label}>
        {props.children}
      </dialog>
    </div>,
    document.body,
  );
}

/** Recent first (§19.8), then the declared categories, then anything uncategorized. */
export function pickerBlocks(catalog: ReactionCatalog): readonly {
  readonly name: string;
  readonly title: string;
  readonly items: readonly ReactionCatalog["items"][number][];
}[] {
  const byKey = new Map(catalog.items.map((item) => [item.key, item]));
  const blocks: { name: string; title: string; items: ReactionCatalog["items"][number][] }[] = [];
  const recent = catalog.recent.flatMap((key) => {
    const item = byKey.get(key);
    return item === undefined ? [] : [item];
  });
  if (recent.length > 0) blocks.push({ name: "recent", title: "Recent", items: recent });
  for (const category of catalog.categories) {
    const items = catalog.items.filter((item) => item.category === category.name);
    if (items.length > 0) {
      blocks.push({ name: category.name, title: category.title ?? category.name, items });
    }
  }
  // Items with no category come last, in a block with no heading of its own (§19.9).
  const declared = new Set(catalog.categories.map((category) => category.name));
  const loose = catalog.items.filter(
    (item) => item.category === undefined || !declared.has(item.category),
  );
  if (loose.length > 0) blocks.push({ name: "", title: "", items: loose });
  return blocks;
}
