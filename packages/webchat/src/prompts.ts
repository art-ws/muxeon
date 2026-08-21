// Prompt library — the shelf rack (§20, FR-183/FR-184): a personal collection of
// reusable prompts, organized as shelves (a name + an order) holding prompts
// (a name + text). Three properties shape the module:
//
//   1. A prompt is NOT a message. Nothing here creates an envelope (§5.3), enqueues
//      anything (§10.1) or writes to the pair log / journal (FR-48). "Take from the
//      shelf" edits the composer's DRAFT (FR-69); sending stays what it was.
//   2. The rack belongs to the SIGNED-IN user (§17.4). The owner comes from the
//      session and never from a path — a foreign rack has no address, which is why
//      isolation (§10.22, invariant §10.32) needs no gate of its own.
//   3. Operations are POINTWISE, not "save the whole document": two tabs of one
//      user can collide on one field of one record, never on the whole collection.
//
// Storage is a sidecar beside the history, one JSON file per owner (§20.2):
//
//   <config_dir>/webchat/prompts/<owner>.json
//
// Why a sidecar and not the config: this is user data edited while the system runs,
// whereas the config (§7) is the operator's document, applied by a restart — and
// mutating it from the panel is a separate, still unresolved request. A broken file
// is an honest failure (LIBRARY_UNREADABLE), never a silently empty rack: showing
// an empty rack invites the user to refill it OVER data that is still there.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodePeerName } from "./history";

/** One prompt on a shelf (§20.1). `id` is opaque and server-issued. */
export interface PromptRecord {
  readonly id: string;
  readonly name: string;
  readonly text: string;
  readonly created: number;
  readonly updated: number;
}

/** One shelf: a name, an order and the prompts standing on it (§20.1). */
export interface PromptShelf {
  readonly id: string;
  readonly name: string;
  readonly created: number;
  readonly updated: number;
  readonly prompts: readonly PromptRecord[];
}

/** The whole rack of ONE owner — the shape both the API and the file carry. */
export interface PromptLibrary {
  readonly version: 1;
  readonly shelves: readonly PromptShelf[];
}

/** Caps validated by the server (§20.2); a violation is a 422, never a silent trim. */
export const PROMPT_LIMITS = {
  /** Shelf and prompt names, after trim + whitespace collapse. */
  nameMax: 120,
  /** Prompt body — long enough for a real briefing, short of a document store. */
  textMax: 32 * 1024,
  shelvesMax: 100,
  promptsPerShelfMax: 500,
} as const;

export type PromptErrorCode =
  | "UNKNOWN_SHELF"
  | "UNKNOWN_PROMPT"
  | "INVALID"
  | "LIMIT"
  | "DUPLICATE_NAME"
  | "LIBRARY_UNREADABLE";

/** A refusal with a code the surface maps to a status (§20.3). */
export class PromptError extends Error {
  readonly code: PromptErrorCode;
  /** Which field was refused — the dialog highlights it instead of guessing. */
  readonly field: string | undefined;

  constructor(code: PromptErrorCode, message: string, field?: string) {
    super(message);
    this.name = "PromptError";
    this.code = code;
    this.field = field;
  }
}

export interface PromptStoreOptions {
  /** The sidecar root: <config_dir>/webchat/prompts. */
  readonly dir: string;
  readonly now?: () => number;
  /** Id source — injected so tests read like documents. */
  readonly newId?: () => string;
}

export interface NewPrompt {
  readonly shelf: string;
  readonly name: string;
  readonly text: string;
}

export interface PromptPatch {
  readonly name?: string;
  readonly text?: string;
  /** Move to another shelf (§20.6) — the id of the target shelf. */
  readonly shelf?: string;
  /** New index on its shelf; out-of-range values clamp into it. */
  readonly position?: number;
}

export interface ShelfPatch {
  readonly name?: string;
  readonly position?: number;
}

const EMPTY: PromptLibrary = { version: 1, shelves: [] };

/**
 * The per-owner prompt rack (§20.2). One file per owner, read-modify-written under
 * that owner's own chain — two tabs of one user serialize, two users never wait on
 * each other. No in-memory cache: the file is small, the operations are rare, and a
 * cache here would only add a way for the panel and the disk to disagree.
 */
export class PromptStore {
  readonly #dir: string;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(options: PromptStoreOptions) {
    this.#dir = options.dir;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** The owner's whole rack; a missing file is an empty rack, a broken one throws. */
  library(owner: string): Promise<PromptLibrary> {
    return this.#serialize(owner, () => this.#read(owner));
  }

  createShelf(owner: string, name: string): Promise<PromptLibrary> {
    return this.#mutate(owner, (library) => {
      const clean = shelfName(library.shelves, name);
      if (library.shelves.length >= PROMPT_LIMITS.shelvesMax) {
        throw new PromptError("LIMIT", `at most ${PROMPT_LIMITS.shelvesMax} shelves`, "shelves");
      }
      const ts = this.#now();
      const shelf: PromptShelf = {
        id: this.#newId(),
        name: clean,
        created: ts,
        updated: ts,
        prompts: [],
      };
      return { ...library, shelves: [...library.shelves, shelf] };
    });
  }

  updateShelf(owner: string, id: string, patch: ShelfPatch): Promise<PromptLibrary> {
    return this.#mutate(owner, (library) => {
      const index = library.shelves.findIndex((shelf) => shelf.id === id);
      const shelf = library.shelves[index];
      if (shelf === undefined) throw unknownShelf(id);
      let next = shelf;
      if (patch.name !== undefined) {
        const others = library.shelves.filter((candidate) => candidate.id !== id);
        next = { ...next, name: shelfName(others, patch.name), updated: this.#now() };
      }
      const shelves = [...library.shelves];
      shelves[index] = next;
      return {
        ...library,
        shelves: patch.position === undefined ? shelves : move(shelves, index, patch.position),
      };
    });
  }

  /** Delete a shelf WITH its prompts (§20.3) — the surface arms the click, not the store. */
  deleteShelf(owner: string, id: string): Promise<PromptLibrary> {
    return this.#mutate(owner, (library) => {
      if (!library.shelves.some((shelf) => shelf.id === id)) throw unknownShelf(id);
      return { ...library, shelves: library.shelves.filter((shelf) => shelf.id !== id) };
    });
  }

  createPrompt(owner: string, draft: NewPrompt): Promise<PromptLibrary> {
    return this.#mutate(owner, (library) => {
      const index = library.shelves.findIndex((shelf) => shelf.id === draft.shelf);
      const shelf = library.shelves[index];
      if (shelf === undefined) throw unknownShelf(draft.shelf);
      const name = promptName(shelf.prompts, draft.name);
      const text = promptText(draft.text);
      if (shelf.prompts.length >= PROMPT_LIMITS.promptsPerShelfMax) {
        throw new PromptError(
          "LIMIT",
          `at most ${PROMPT_LIMITS.promptsPerShelfMax} prompts per shelf`,
          "prompts",
        );
      }
      const ts = this.#now();
      const prompt: PromptRecord = { id: this.#newId(), name, text, created: ts, updated: ts };
      const shelves = [...library.shelves];
      shelves[index] = { ...shelf, prompts: [...shelf.prompts, prompt], updated: ts };
      return { ...library, shelves };
    });
  }

  updatePrompt(owner: string, id: string, patch: PromptPatch): Promise<PromptLibrary> {
    return this.#mutate(owner, (library) => {
      const found = locate(library, id);
      if (found === undefined) throw unknownPrompt(id);
      const target =
        patch.shelf === undefined
          ? found.shelfIndex
          : library.shelves.findIndex((shelf) => shelf.id === patch.shelf);
      const destination = library.shelves[target];
      if (destination === undefined) throw unknownShelf(patch.shelf ?? "");
      const moving = target !== found.shelfIndex;
      // Uniqueness is checked against the shelf the prompt will STAND on, minus
      // itself: a rename that keeps the name must not collide with the record it
      // is renaming (§20.2).
      const neighbours = (moving ? destination.prompts : found.shelf.prompts).filter(
        (candidate) => candidate.id !== id,
      );
      const ts = this.#now();
      const next: PromptRecord = {
        ...found.prompt,
        ...(patch.name !== undefined ? { name: promptName(neighbours, patch.name) } : {}),
        ...(patch.text !== undefined ? { text: promptText(patch.text) } : {}),
        updated: ts,
      };
      if (moving && destination.prompts.length >= PROMPT_LIMITS.promptsPerShelfMax) {
        throw new PromptError(
          "LIMIT",
          `at most ${PROMPT_LIMITS.promptsPerShelfMax} prompts per shelf`,
          "prompts",
        );
      }
      const shelves = [...library.shelves];
      if (moving) {
        shelves[found.shelfIndex] = {
          ...found.shelf,
          prompts: found.shelf.prompts.filter((candidate) => candidate.id !== id),
          updated: ts,
        };
        const landed = [...destination.prompts, next];
        shelves[target] = {
          ...destination,
          prompts:
            patch.position === undefined ? landed : move(landed, landed.length - 1, patch.position),
          updated: ts,
        };
      } else {
        const prompts = [...found.shelf.prompts];
        prompts[found.promptIndex] = next;
        shelves[found.shelfIndex] = {
          ...found.shelf,
          prompts:
            patch.position === undefined
              ? prompts
              : move(prompts, found.promptIndex, patch.position),
          updated: ts,
        };
      }
      return { ...library, shelves };
    });
  }

  deletePrompt(owner: string, id: string): Promise<PromptLibrary> {
    return this.#mutate(owner, (library) => {
      const found = locate(library, id);
      if (found === undefined) throw unknownPrompt(id);
      const shelves = [...library.shelves];
      shelves[found.shelfIndex] = {
        ...found.shelf,
        prompts: found.shelf.prompts.filter((candidate) => candidate.id !== id),
        updated: this.#now(),
      };
      return { ...library, shelves };
    });
  }

  // --- internals -------------------------------------------------------------

  /** Per-owner serialization: one user's tabs queue, other users are untouched. */
  #serialize<T>(owner: string, op: () => Promise<T>): Promise<T> {
    const chain = this.#chains.get(owner) ?? Promise.resolve();
    const next = chain.then(op, op);
    this.#chains.set(
      owner,
      next.catch(() => undefined), // one failure must not poison the chain
    );
    return next;
  }

  #mutate(owner: string, apply: (library: PromptLibrary) => PromptLibrary): Promise<PromptLibrary> {
    return this.#serialize(owner, async () => {
      const library = apply(await this.#read(owner));
      await this.#write(owner, library);
      return library;
    });
  }

  #file(owner: string): string {
    return join(this.#dir, `${encodePeerName(owner)}.json`);
  }

  async #read(owner: string): Promise<PromptLibrary> {
    let raw: string;
    try {
      raw = await readFile(this.#file(owner), "utf8");
    } catch {
      return EMPTY; // no rack yet — the honest empty one
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw unreadable(owner);
    }
    const library = sanitize(parsed);
    if (library === undefined) throw unreadable(owner);
    return library;
  }

  async #write(owner: string, library: PromptLibrary): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const tmp = join(this.#dir, `.tmp-${encodePeerName(owner)}.json`);
    await writeFile(tmp, `${JSON.stringify(library, null, 2)}\n`, "utf8");
    await rename(tmp, this.#file(owner)); // atomic (§5.3), same dir ⇒ same FS
  }
}

/** Trim + collapse inner whitespace: one name, one spelling (§20.2). */
export function normalizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/gu, " ").trim() : "";
}

function checkedName(raw: unknown, field: string): string {
  const name = normalizeName(raw);
  if (name.length === 0) throw new PromptError("INVALID", `"${field}" must not be empty`, field);
  if (name.length > PROMPT_LIMITS.nameMax) {
    throw new PromptError(
      "LIMIT",
      `"${field}" must be at most ${PROMPT_LIMITS.nameMax} characters`,
      field,
    );
  }
  return name;
}

/** Names are compared case-insensitively: two look-alike rows in a submenu are a coin toss. */
function duplicate(taken: readonly { readonly name: string }[], name: string): boolean {
  const folded = name.toLocaleLowerCase();
  return taken.some((candidate) => candidate.name.toLocaleLowerCase() === folded);
}

function shelfName(others: readonly PromptShelf[], raw: unknown): string {
  const name = checkedName(raw, "name");
  if (duplicate(others, name)) {
    throw new PromptError("DUPLICATE_NAME", `a shelf named "${name}" already exists`, "name");
  }
  return name;
}

function promptName(others: readonly PromptRecord[], raw: unknown): string {
  const name = checkedName(raw, "name");
  if (duplicate(others, name)) {
    throw new PromptError("DUPLICATE_NAME", `"${name}" is already on this shelf`, "name");
  }
  return name;
}

function promptText(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new PromptError("INVALID", '"text" must not be empty', "text");
  }
  if (raw.length > PROMPT_LIMITS.textMax) {
    throw new PromptError(
      "LIMIT",
      `"text" must be at most ${PROMPT_LIMITS.textMax} characters`,
      "text",
    );
  }
  return raw;
}

function unknownShelf(id: string): PromptError {
  return new PromptError("UNKNOWN_SHELF", `no shelf "${id}"`, "shelf");
}

function unknownPrompt(id: string): PromptError {
  return new PromptError("UNKNOWN_PROMPT", `no prompt "${id}"`, "prompt");
}

function unreadable(owner: string): PromptError {
  return new PromptError(
    "LIBRARY_UNREADABLE",
    `the prompt library of "${owner}" is unreadable; the file was left untouched`,
  );
}

interface Located {
  readonly shelf: PromptShelf;
  readonly shelfIndex: number;
  readonly prompt: PromptRecord;
  readonly promptIndex: number;
}

function locate(library: PromptLibrary, id: string): Located | undefined {
  for (const [shelfIndex, shelf] of library.shelves.entries()) {
    const promptIndex = shelf.prompts.findIndex((prompt) => prompt.id === id);
    const prompt = shelf.prompts[promptIndex];
    if (prompt !== undefined) return { shelf, shelfIndex, prompt, promptIndex };
  }
  return undefined;
}

/** Move one element; a position outside the list clamps into it, never throws. */
function move<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  const index = Math.max(0, Math.min(Math.trunc(to), next.length));
  next.splice(index, 0, item);
  return next;
}

/**
 * Accept only what the rack's own shape allows. A file written by an older or a
 * foreign hand is not guessed at: a wrong SHAPE is unreadable (the user's data is
 * worth an error), while unknown FIELDS are dropped — they cannot survive a
 * rewrite anyway.
 */
function sanitize(parsed: unknown): PromptLibrary | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const raw = parsed as { version?: unknown; shelves?: unknown };
  if (raw.version !== 1 || !Array.isArray(raw.shelves)) return undefined;
  const shelves: PromptShelf[] = [];
  for (const entry of raw.shelves) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const shelf = entry as Record<string, unknown>;
    if (typeof shelf.id !== "string" || typeof shelf.name !== "string") return undefined;
    if (!Array.isArray(shelf.prompts)) return undefined;
    const prompts: PromptRecord[] = [];
    for (const candidate of shelf.prompts) {
      if (typeof candidate !== "object" || candidate === null) return undefined;
      const prompt = candidate as Record<string, unknown>;
      if (
        typeof prompt.id !== "string" ||
        typeof prompt.name !== "string" ||
        typeof prompt.text !== "string"
      ) {
        return undefined;
      }
      prompts.push({
        id: prompt.id,
        name: prompt.name,
        text: prompt.text,
        created: typeof prompt.created === "number" ? prompt.created : 0,
        updated: typeof prompt.updated === "number" ? prompt.updated : 0,
      });
    }
    shelves.push({
      id: shelf.id,
      name: shelf.name,
      created: typeof shelf.created === "number" ? shelf.created : 0,
      updated: typeof shelf.updated === "number" ? shelf.updated : 0,
      prompts,
    });
  }
  return { version: 1, shelves };
}
