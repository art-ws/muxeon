// The rack inside the composer (§20.4/§20.5, FR-185/FR-186): two menu items and
// the small dialog that names what is being put on a shelf.
//
// The items live in the "+" menu (FR-70), so they mount when it opens — which is
// exactly when a stale shelf list would be visible, and therefore when the rack is
// pulled (§20.3, no WS for it). The DIALOG is deliberately NOT part of that
// subtree: the menu closes the moment it is chosen, and a dialog inside a closing
// menu would close with it. The composer owns the dialog; these items only ask for
// it.

import { useEffect, useRef, useState } from "react";
import { useT } from "./i18n-context";
import { IconBookmark, IconInsert, IconShelf } from "./icons";
import { autoPromptName } from "./prompt-name";
import { usePrompts } from "./prompts-context";

export function PromptRackItems(props: {
  /** What is in the composer right now — the body to save, and its auto-name. */
  text: string;
  /** Appends the picked prompt to the draft (FR-186) — never replaces it. */
  onInsert: (text: string) => void;
  /** Asks the composer for the save dialog; `undefined` = onto a NEW shelf. */
  onSave: (shelf: string | undefined) => void;
  /** Opens the rack page (§20.6); absent ⇒ the item is not printed. */
  onManage?: (() => void) | undefined;
  /**
   * Is the rack offered at all (FR-189)? `false` — the panel hid it by
   * preference — prints NOTHING, the same silence a server without a rack gets:
   * both reasons end in "this menu has no rack in it", and one place decides.
   */
  offered?: boolean;
  closeMenu: () => void;
}): React.JSX.Element | null {
  const t = useT();
  const rack = usePrompts();
  const [open, setOpen] = useState<"insert" | "save" | undefined>(undefined);
  const [openShelf, setOpenShelf] = useState<string | undefined>(undefined);
  const refresh = rack.refresh;
  // Mounting IS the menu opening (see the header) — one pull, no polling.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (props.offered === false || !rack.enabled) return null;
  const filled = props.text.trim() !== "";
  const stocked = rack.shelves.filter((shelf) => shelf.prompts.length > 0);
  // An empty rack prints no "insert" item at all (§20.5): an item that can only
  // ever open onto nothing is a dead row.
  const canInsert = stocked.length > 0;
  if (!canInsert && !filled && props.onManage === undefined) return null;

  return (
    <>
      <span className="menu-separator" />
      {canInsert && (
        <span className="submenu-anchor">
          <button
            type="button"
            role="menuitem"
            className={`menu-item${open === "insert" ? " active" : ""}`}
            aria-haspopup="menu"
            aria-expanded={open === "insert"}
            onClick={() => {
              setOpen(open === "insert" ? undefined : "insert");
              setOpenShelf(undefined);
            }}
          >
            <span className="menu-icon">
              <IconInsert size={14} />
            </span>{" "}
            {t("Insert from shelf")}
            <span className="submenu-arrow">›</span>
          </button>
          {open === "insert" && (
            <span className="composer-menu submenu" role="menu">
              {stocked.map((shelf) => (
                <span className="submenu-anchor" key={shelf.id}>
                  <button
                    type="button"
                    role="menuitem"
                    className={`menu-item${openShelf === shelf.id ? " active" : ""}`}
                    aria-haspopup="menu"
                    aria-expanded={openShelf === shelf.id}
                    onClick={() => setOpenShelf(openShelf === shelf.id ? undefined : shelf.id)}
                  >
                    {shelf.name}
                    <span className="submenu-arrow">›</span>
                  </button>
                  {openShelf === shelf.id && (
                    <span className="composer-menu submenu leaf" role="menu">
                      {shelf.prompts.map((prompt) => (
                        <button
                          type="button"
                          role="menuitem"
                          key={prompt.id}
                          className="menu-item"
                          /* the first line of the body: near-identical names are
                             told apart BEFORE the click, not after */
                          title={firstLine(prompt.text)}
                          onClick={() => {
                            props.closeMenu();
                            props.onInsert(prompt.text);
                          }}
                        >
                          {prompt.name}
                        </button>
                      ))}
                    </span>
                  )}
                </span>
              ))}
            </span>
          )}
        </span>
      )}
      {/* "Save to shelf" appears only with something to save (§20.4) */}
      {filled && (
        <span className="submenu-anchor">
          <button
            type="button"
            role="menuitem"
            className={`menu-item${open === "save" ? " active" : ""}`}
            aria-haspopup="menu"
            aria-expanded={open === "save"}
            onClick={() => setOpen(open === "save" ? undefined : "save")}
          >
            <span className="menu-icon">
              <IconBookmark size={14} />
            </span>{" "}
            {t("Save to shelf")}
            <span className="submenu-arrow">›</span>
          </button>
          {open === "save" && (
            <span className="composer-menu submenu leaf" role="menu">
              {rack.shelves.map((shelf) => (
                <button
                  type="button"
                  role="menuitem"
                  key={shelf.id}
                  className="menu-item"
                  onClick={() => {
                    props.closeMenu();
                    props.onSave(shelf.id);
                  }}
                >
                  {shelf.name}
                </button>
              ))}
              {rack.shelves.length > 0 && <span className="menu-separator" />}
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  props.closeMenu();
                  props.onSave(undefined);
                }}
              >
                {t("New shelf…")}
              </button>
            </span>
          )}
        </span>
      )}
      {props.onManage !== undefined && (
        <button
          type="button"
          role="menuitem"
          className="menu-item"
          onClick={() => {
            props.closeMenu();
            props.onManage?.();
          }}
        >
          {/* the SAME name and the SAME mark as the account-menu line and the
              toolbar entry (FR-171/FR-187): one destination must not answer to
              three names — the reader cannot tell whether they lead to one page */}
          <span className="menu-icon">
            <IconShelf size={14} />
          </span>{" "}
          {t("Prompts")}
        </button>
      )}
    </>
  );
}

/**
 * Naming what goes on the shelf (§20.4). The name starts as the auto-name
 * (FR-188) and is fully editable; a refusal (a name already on that shelf) keeps
 * the dialog OPEN with the text intact — silently appending "(2)" would breed
 * look-alike rows nobody can choose between later.
 */
export function SavePromptDialog(props: {
  /** The composer text — saved verbatim; the composer is not cleared (§20.4). */
  text: string;
  /** Target shelf; `undefined` ⇒ the dialog also asks for a NEW shelf's name. */
  shelf?: string | undefined;
  onClose: () => void;
}): React.JSX.Element {
  const t = useT();
  const rack = usePrompts();
  const [name, setName] = useState(() => autoPromptName(props.text, t("Untitled")));
  const [shelfName, setShelfName] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // A shelf created by a first, failed attempt must not be created twice.
  const created = useRef<string | undefined>(undefined);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const shelfRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  // The auto-name is a proposal: it opens SELECTED, so typing over it is one act.
  // Saving onto a new shelf starts one field earlier — at the shelf's own name.
  useEffect(() => {
    if (props.shelf === undefined) shelfRef.current?.focus();
    else nameRef.current?.select();
  }, [props.shelf]);

  const save = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const shelf = props.shelf ?? created.current ?? (await rack.createShelf(shelfName));
      created.current = shelf;
      await rack.addPrompt({ shelf, name, text: props.text });
      props.onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="prompt-dialog"
      aria-label={t("Save to shelf")}
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <form
        className="prompt-dialog-panel"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header className="prompt-dialog-head">
          <strong>{t("Save to shelf")}</strong>
          <button
            type="button"
            className="cmdfan-close"
            onClick={props.onClose}
            aria-label={t("Close")}
          >
            ×
          </button>
        </header>
        {props.shelf === undefined && (
          <label className="prompt-field">
            {t("Shelf name")}
            <input
              ref={shelfRef}
              value={shelfName}
              onChange={(event) => setShelfName(event.target.value)}
              placeholder={t("New shelf…")}
            />
          </label>
        )}
        <label className="prompt-field">
          {t("Prompt name")}
          <input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <p className="prompt-dialog-note">
          {t("The composer keeps its text — this saves a copy.")}
        </p>
        {error !== undefined && <div className="cmdfan-error">{error}</div>}
        <footer className="prompt-dialog-foot">
          <button type="button" className="ghost-button" onClick={props.onClose}>
            {t("Cancel")}
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            {t("Save")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

/** One line of the body for a tooltip — the same "collapse and cut" idea as FR-178. */
function firstLine(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}
