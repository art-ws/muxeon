// The topic control of an agent chat (§23.4, FR-215): a wide field in the chat
// header row — right of name · status · session clock, across the free middle
// (the operator's screenshot, T367) — that shows the open topic's path and
// unread count. A click opens a light tree under it: search by path, the rows
// in the server's usage order, "New topic", and per-row Rename / Clear / Delete.
//
// Every change goes to the API (§23.3) and the tree on screen follows the
// `topics-changed` push, so two tabs never disagree. The field itself only asks
// the panel to switch (`onSelect`) — the hash is the source of truth (§12.7).

import { useEffect, useRef, useState } from "react";
import * as api from "./api";
import { useT } from "./i18n-context";
import { IconKebab, IconPlus } from "./icons";
import { ancestorsOf, depthOf, filterTopics, leafOf, topicErrorText } from "./topics";
import type { TopicList, TopicView } from "./types";

type RowMode =
  | { readonly kind: "menu"; readonly id: string }
  | { readonly kind: "rename"; readonly id: string }
  | { readonly kind: "confirm"; readonly id: string; readonly action: "clear" | "delete" };

export function TopicPicker(props: {
  peer: string;
  /** The pair's tree; undefined while the first fetch is in flight. */
  list: TopicList | undefined;
  /** The open topic's id. */
  current: string | undefined;
  onSelect: (topicId: string) => void;
  /** The tree is about to be shown — the panel re-reads it for fresh counts. */
  onOpen?: () => void;
}): React.JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<RowMode | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const searchRef = useRef<HTMLInputElement>(null);

  const topics = props.list?.topics ?? [];
  const current = topics.find((topic) => topic.id === props.current);
  const defaultId = props.list?.defaultId;

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const close = (): void => {
    setOpen(false);
    setQuery("");
    setMode(undefined);
    setError(undefined);
  };

  // One request at a time; a refusal stays on screen in the server's words,
  // mapped to the panel's wording by code (§23.3).
  const run = async (action: () => Promise<void>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(undefined);
    try {
      await action();
      return true;
    } catch (failure) {
      setError(t(topicErrorText(failure instanceof api.ApiError ? failure.code : undefined)));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const create = async (): Promise<void> => {
    const path = draft.trim();
    if (path === "") return;
    let created: { id: string } | undefined;
    const ok = await run(async () => {
      created = await api.createTopic(props.peer, path);
    });
    if (ok && created !== undefined) {
      setDraft("");
      props.onSelect(created.id);
      close();
    }
  };

  const rename = async (topic: TopicView, path: string): Promise<void> => {
    if (path.trim() === "" || path.trim() === topic.path) {
      setMode(undefined);
      return;
    }
    if (await run(() => api.renameTopic(props.peer, topic.id, path))) setMode(undefined);
  };

  const remove = async (topic: TopicView, action: "clear" | "delete"): Promise<void> => {
    const call = action === "clear" ? api.clearTopic : api.deleteTopic;
    if (await run(() => call(props.peer, topic.id))) setMode(undefined);
  };

  const label = current?.path ?? "";
  return (
    <span className="topic-field">
      <button
        type="button"
        className="topic-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label === "" ? t("Topics") : `${t("Topic")}: ${label}`}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          props.onOpen?.();
          setOpen(true);
        }}
      >
        {/* ancestors shrink with an ellipsis, the leaf always stays readable */}
        <span className="topic-ancestors">{ancestorsOf(label)}</span>
        <span className="topic-leaf">{label === "" ? "…" : leafOf(label)}</span>
        {current !== undefined && current.unread > 0 && (
          <span className="unread-badge topic-unread" title={t("unread")}>
            {current.unread}
          </span>
        )}
      </button>
      {open && (
        <>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: a transparent click-away backdrop; Escape closes from the keyboard */}
          <span className="menu-backdrop" onClick={close} />
          {/* non-modal, like the reaction picker: the chat stays usable around it */}
          <dialog
            open
            className="topic-popover"
            aria-label={t("Topics")}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              if (mode !== undefined) setMode(undefined);
              else close();
            }}
          >
            <input
              ref={searchRef}
              type="search"
              className="topic-search"
              placeholder={t("Search topics…")}
              aria-label={t("Search topics by path")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <ul className="topic-tree">
              {filterTopics(topics, query).map((topic) => (
                <TopicRow
                  key={topic.id}
                  topic={topic}
                  indent={query.trim() === "" ? depthOf(topic.path) : 0}
                  showPath={query.trim() !== ""}
                  current={topic.id === props.current}
                  isDefault={topic.id === defaultId}
                  mode={mode?.id === topic.id ? mode : undefined}
                  busy={busy}
                  onSelect={() => {
                    props.onSelect(topic.id);
                    close();
                  }}
                  onMode={(next) => {
                    setError(undefined);
                    setMode(next);
                  }}
                  onRename={(path) => void rename(topic, path)}
                  onRemove={(action) => void remove(topic, action)}
                />
              ))}
            </ul>
            <form
              className="topic-new"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <IconPlus size={14} />
              <input
                type="text"
                placeholder={t("New topic — use / to nest")}
                aria-label={t("New topic")}
                value={draft}
                disabled={busy}
                onChange={(event) => setDraft(event.target.value)}
              />
            </form>
            {error !== undefined && (
              <p className="topic-error" role="alert">
                {error}
              </p>
            )}
          </dialog>
        </>
      )}
    </span>
  );
}

function TopicRow(props: {
  topic: TopicView;
  indent: number;
  /** While searching, rows print their full path — the tree shape is gone. */
  showPath: boolean;
  current: boolean;
  isDefault: boolean;
  mode: RowMode | undefined;
  busy: boolean;
  onSelect: () => void;
  onMode: (mode: RowMode | undefined) => void;
  onRename: (path: string) => void;
  onRemove: (action: "clear" | "delete") => void;
}): React.JSX.Element {
  const t = useT();
  const { topic, mode } = props;
  const [path, setPath] = useState(topic.path);
  const style = { paddingInlineStart: `${8 + props.indent * 14}px` } as React.CSSProperties;

  if (mode?.kind === "rename") {
    return (
      <li className="topic-row editing" style={style}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            props.onRename(path);
          }}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: the rename was just asked for — the field is where the keyboard goes
            autoFocus
            type="text"
            aria-label={t("Rename topic — the full path, / separates levels")}
            title={t("The full path — / separates levels")}
            value={path}
            disabled={props.busy}
            onChange={(event) => setPath(event.target.value)}
          />
        </form>
      </li>
    );
  }
  if (mode?.kind === "confirm") {
    const count = topic.subtreeMessageCount;
    const question =
      mode.action === "delete"
        ? t("Delete «{topic}» with its subtopics and {n} messages?")
        : t("Remove the {n} messages of «{topic}» and its subtopics?");
    return (
      <li className="topic-row confirming" style={style} role="alert">
        <span className="topic-question">
          {question.replace("{topic}", topic.path).replace("{n}", String(count))}
        </span>
        <span className="topic-confirm-actions">
          <button
            type="button"
            className="danger"
            disabled={props.busy}
            onClick={() => props.onRemove(mode.action)}
          >
            {t(mode.action === "delete" ? "Delete" : "Clear")}
          </button>
          <button type="button" disabled={props.busy} onClick={() => props.onMode(undefined)}>
            {t("Cancel")}
          </button>
        </span>
      </li>
    );
  }
  return (
    <li className={`topic-row${props.current ? " current" : ""}`} style={style}>
      <button
        type="button"
        className="topic-pick"
        aria-current={props.current ? "true" : undefined}
        title={topic.path}
        onClick={props.onSelect}
      >
        <span className="topic-name">{props.showPath ? topic.path : leafOf(topic.path)}</span>
        {topic.unread > 0 && <span className="unread-badge">{topic.unread}</span>}
        <span className="topic-count" title={t("messages in this topic and its subtopics")}>
          {topic.subtreeMessageCount}
        </span>
      </button>
      <span className="filter-anchor">
        <button
          type="button"
          className="kebab-button"
          title={t("Topic actions")}
          aria-label={`${t("Topic actions")}: ${topic.path}`}
          aria-haspopup="menu"
          aria-expanded={mode?.kind === "menu"}
          onClick={() =>
            props.onMode(mode?.kind === "menu" ? undefined : { kind: "menu", id: topic.id })
          }
        >
          <IconKebab size={14} />
        </button>
        {mode?.kind === "menu" && (
          <span className="filter-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className="filter-option"
              onClick={() => {
                setPath(topic.path);
                props.onMode({ kind: "rename", id: topic.id });
              }}
            >
              {t("Rename")}
            </button>
            <button
              type="button"
              role="menuitem"
              className="filter-option"
              onClick={() => props.onMode({ kind: "confirm", id: topic.id, action: "clear" })}
            >
              {t("Clear")}
            </button>
            {!props.isDefault && (
              <button
                type="button"
                role="menuitem"
                className="filter-option danger"
                onClick={() => props.onMode({ kind: "confirm", id: topic.id, action: "delete" })}
              >
                {t("Delete")}
              </button>
            )}
          </span>
        )}
      </span>
    </li>
  );
}
