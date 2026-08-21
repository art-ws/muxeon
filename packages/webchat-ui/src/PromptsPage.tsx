// The rack page (§20.6, FR-187): two columns — shelves on the left, the selected
// shelf's prompts on the right — plus the editor of one prompt. Full CRUD, because
// a collection you can only add to is a collection you stop trusting.
//
// Three rules the markup follows literally:
//   * order is changed by ↑/↓ buttons, not by dragging — the panel has no drag
//     surface anywhere, and buttons work from the keyboard;
//   * a delete ARMS on the first click and names its price on the second (§12.10.2)
//     — one stray click must not take a shelf and everything on it;
//   * the filter tells the truth while it hides (FR-71): "showing N of M".

import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "./i18n-context";
import { usePrompts } from "./prompts-context";
import type { PromptRecord } from "./types";

/** How long an armed delete stays armed (the toolbar's 3s, FR-172). */
const ARM_MS = 3000;

export function PromptsPage(): React.JSX.Element {
  const t = useT();
  const rack = usePrompts();
  const refresh = rack.refresh;
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const [shelfId, setShelfId] = useState<string | undefined>(undefined);
  const [promptId, setPromptId] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [newShelf, setNewShelf] = useState("");
  const [armed, setArmed] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const armTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const shelves = rack.shelves;
  const shelf = shelves.find((entry) => entry.id === shelfId) ?? shelves[0];
  const prompts = shelf?.prompts ?? [];
  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (needle === "") return prompts;
    return prompts.filter(
      (prompt) =>
        prompt.name.toLocaleLowerCase().includes(needle) ||
        prompt.text.toLocaleLowerCase().includes(needle),
    );
  }, [prompts, query]);
  const selected = prompts.find((prompt) => prompt.id === promptId);

  const arm = (id: string): boolean => {
    if (armed === id) {
      window.clearTimeout(armTimer.current);
      setArmed(undefined);
      return true; // the second click — go ahead
    }
    setArmed(id);
    window.clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => setArmed(undefined), ARM_MS);
    return false;
  };

  const run = (op: Promise<unknown>): void => {
    setFailure(undefined);
    void op.catch((error: unknown) =>
      setFailure(error instanceof Error ? error.message : String(error)),
    );
  };

  return (
    <div className="rack">
      <aside className="rack-shelves">
        <header className="rack-head">
          <strong>{t("Shelves")}</strong>
        </header>
        <form
          className="rack-new-shelf"
          onSubmit={(event) => {
            event.preventDefault();
            if (newShelf.trim() === "") return;
            run(rack.createShelf(newShelf).then(() => setNewShelf("")));
          }}
        >
          <input
            value={newShelf}
            placeholder={t("New shelf…")}
            onChange={(event) => setNewShelf(event.target.value)}
          />
          <button type="submit" className="ghost-button">
            {t("Add")}
          </button>
        </form>
        <ul className="rack-list">
          {shelves.map((entry, index) => (
            <li key={entry.id} className={entry.id === shelf?.id ? "selected" : undefined}>
              <ShelfRow
                shelf={entry}
                index={index}
                total={shelves.length}
                armed={armed === entry.id}
                onSelect={() => {
                  setShelfId(entry.id);
                  setPromptId(undefined);
                  setCreating(false);
                }}
                onRename={(name) => run(rack.renameShelf(entry.id, name))}
                onMove={(position) => run(rack.moveShelf(entry.id, position))}
                onDelete={() => {
                  if (!arm(entry.id)) return;
                  if (entry.id === shelf?.id) setPromptId(undefined);
                  run(rack.removeShelf(entry.id));
                }}
              />
            </li>
          ))}
        </ul>
        {shelves.length === 0 && <p className="rack-empty">{t("No shelves yet.")}</p>}
      </aside>
      <section className="rack-prompts">
        <header className="rack-head">
          <strong>{shelf?.name ?? t("Prompts")}</strong>
          {shelf !== undefined && (
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                setCreating(true);
                setPromptId(undefined);
              }}
            >
              {t("New prompt")}
            </button>
          )}
        </header>
        {shelf !== undefined && (
          <>
            <div className="rack-filter">
              <input
                type="search"
                value={query}
                placeholder={t("Filter prompts…")}
                aria-label={t("Filter prompts by name and text")}
                onChange={(event) => setQuery(event.target.value)}
              />
              {shown.length !== prompts.length && (
                <span className="rack-count">
                  {t("showing")} {shown.length} {t("of")} {prompts.length}
                </span>
              )}
            </div>
            <ul className="rack-list">
              {shown.map((prompt) => (
                <li key={prompt.id} className={prompt.id === promptId ? "selected" : undefined}>
                  <button
                    type="button"
                    className="rack-row"
                    onClick={() => {
                      setPromptId(prompt.id);
                      setCreating(false);
                    }}
                  >
                    <span className="rack-row-name">{prompt.name}</span>
                  </button>
                  <span className="rack-row-actions">
                    <MoveButtons
                      index={prompts.indexOf(prompt)}
                      total={prompts.length}
                      onMove={(position) => run(rack.editPrompt(prompt.id, { position }))}
                    />
                    <button
                      type="button"
                      className={`ghost-button danger${armed === prompt.id ? " armed" : ""}`}
                      title={t("Delete")}
                      onClick={() => {
                        if (!arm(prompt.id)) return;
                        if (prompt.id === promptId) setPromptId(undefined);
                        run(rack.removePrompt(prompt.id));
                      }}
                    >
                      {armed === prompt.id ? t("Sure?") : "×"}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            {prompts.length === 0 && !creating && <p className="rack-empty">{t("Empty shelf.")}</p>}
            {(selected !== undefined || creating) && (
              <PromptEditor
                key={creating ? "new" : selected?.id}
                {...(selected !== undefined && !creating ? { prompt: selected } : {})}
                shelves={shelves.map((entry) => ({ id: entry.id, name: entry.name }))}
                shelf={shelf.id}
                onCancel={() => {
                  setCreating(false);
                  setPromptId(undefined);
                }}
                onSave={async (draft) => {
                  if (creating) {
                    await rack.addPrompt({
                      shelf: draft.shelf,
                      name: draft.name,
                      text: draft.text,
                    });
                    setCreating(false);
                    return;
                  }
                  if (selected === undefined) return;
                  await rack.editPrompt(selected.id, {
                    ...(draft.name !== selected.name ? { name: draft.name } : {}),
                    ...(draft.text !== selected.text ? { text: draft.text } : {}),
                    ...(draft.shelf !== shelf.id ? { shelf: draft.shelf } : {}),
                  });
                }}
              />
            )}
          </>
        )}
        {(failure ?? rack.error) !== undefined && (
          <div className="cmdfan-error">{failure ?? rack.error}</div>
        )}
      </section>
    </div>
  );
}

/**
 * One shelf row: pick it, rename it IN PLACE (§20.6 — no browser prompt boxes),
 * reorder it, delete it with its prompts after an armed second click.
 */
function ShelfRow(props: {
  shelf: { id: string; name: string; prompts: readonly PromptRecord[] };
  index: number;
  total: number;
  armed: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onMove: (position: number) => void;
  onDelete: () => void;
}): React.JSX.Element {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.shelf.name);
  const inputRef = useRef<HTMLInputElement>(null);
  // The row BECAME a field because a rename was asked for — the caret belongs in it.
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  if (editing) {
    return (
      <form
        className="rack-rename"
        onSubmit={(event) => {
          event.preventDefault();
          setEditing(false);
          if (draft.trim() !== "" && draft !== props.shelf.name) props.onRename(draft);
        }}
      >
        <input
          ref={inputRef}
          value={draft}
          aria-label={t("Shelf name")}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDraft(props.shelf.name);
              setEditing(false);
            }
          }}
          onBlur={() => setEditing(false)}
        />
      </form>
    );
  }
  return (
    <>
      <button type="button" className="rack-row" onClick={props.onSelect}>
        <span className="rack-row-name">{props.shelf.name}</span>
        <span className="rack-count">{props.shelf.prompts.length}</span>
      </button>
      <span className="rack-row-actions">
        <MoveButtons index={props.index} total={props.total} onMove={props.onMove} />
        <button
          type="button"
          className="ghost-button"
          title={t("Rename")}
          onClick={() => {
            setDraft(props.shelf.name);
            setEditing(true);
          }}
        >
          ✎
        </button>
        <button
          type="button"
          className={`ghost-button danger${props.armed ? " armed" : ""}`}
          /* the second click's price, named before it is paid (§20.6) */
          title={
            props.armed
              ? `${t("Delete shelf with prompts")}: ${props.shelf.prompts.length}`
              : t("Delete")
          }
          onClick={props.onDelete}
        >
          {props.armed ? t("Sure?") : "×"}
        </button>
      </span>
    </>
  );
}

/** ↑/↓ — the only reordering there is (§20.6): no dragging, keyboard-reachable. */
function MoveButtons(props: {
  index: number;
  total: number;
  onMove: (position: number) => void;
}): React.JSX.Element {
  const t = useT();
  return (
    <>
      <button
        type="button"
        className="ghost-button"
        title={t("Move up")}
        disabled={props.index <= 0}
        onClick={() => props.onMove(props.index - 1)}
      >
        ↑
      </button>
      <button
        type="button"
        className="ghost-button"
        title={t("Move down")}
        disabled={props.index >= props.total - 1}
        onClick={() => props.onMove(props.index + 1)}
      >
        ↓
      </button>
    </>
  );
}

/** One prompt's fields. A refusal keeps the form open with the text intact (§20.4). */
function PromptEditor(props: {
  prompt?: PromptRecord;
  shelves: readonly { id: string; name: string }[];
  shelf: string;
  onCancel: () => void;
  onSave: (draft: { name: string; text: string; shelf: string }) => Promise<void>;
}): React.JSX.Element {
  const t = useT();
  const [name, setName] = useState(props.prompt?.name ?? "");
  const [text, setText] = useState(props.prompt?.text ?? "");
  const [shelf, setShelf] = useState(props.shelf);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="rack-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(undefined);
        props
          .onSave({ name, text, shelf })
          .catch((failure: unknown) =>
            setError(failure instanceof Error ? failure.message : String(failure)),
          )
          .finally(() => setBusy(false));
      }}
    >
      <label className="prompt-field">
        {t("Prompt name")}
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="prompt-field">
        {t("Shelf")}
        <select value={shelf} onChange={(event) => setShelf(event.target.value)}>
          {props.shelves.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
      <label className="prompt-field">
        {t("Prompt text")}
        <textarea rows={10} value={text} onChange={(event) => setText(event.target.value)} />
      </label>
      {error !== undefined && <div className="cmdfan-error">{error}</div>}
      <footer className="prompt-dialog-foot">
        <button type="button" className="ghost-button" onClick={props.onCancel}>
          {t("Cancel")}
        </button>
        <button type="submit" className="primary-button" disabled={busy}>
          {t("Save")}
        </button>
      </footer>
    </form>
  );
}
