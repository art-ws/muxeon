// The file-exchange of one agent (§13) — the file-based protocol that makes an
// agent fully bidirectional WITHOUT an MCP client (FR-52..56). This module owns
// the agent's <exchange> directory: inbox materialization at claim time (the
// inbox is a PROJECTION of the current turn — the queue stays the source of
// truth, §10.13), per-turn cleanup, and the orphan sweep retention runs (§5.4).
//
// Layout (§13.1):
//   <exchange>/.gitignore      — written by the system ("*")
//   <exchange>/inbox/<id>/message.json   — the full Signal (agent deletes = done)
//   <exchange>/inbox/<id>/reply.md + files — the agent's answer (collected T72)
//   <exchange>/outbox/         — agent-initiated sends (monitored, T73)

import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Signal } from "@muxeon/core";
import { sanitizeFileId } from "@muxeon/queue";

export interface ExchangeLocation {
  /** Explicit agent.exchangeDir (§7.1); relative paths resolve from configDir. */
  readonly exchangeDir?: string;
  /** The agent's working directory (§7.1). */
  readonly cwd?: string;
  /** <config_dir> — the base for a relative exchangeDir. */
  readonly configDir: string;
  /** Queue root <root> (§5.3) — the no-cwd fallback location. */
  readonly root: string;
  /** The agent's tmux session name (§2) — the fallback subdir key. */
  readonly session: string;
}

/**
 * Resolve the agent's <exchange> dir (§13.1): explicit exchangeDir → <cwd>/.muxeon
 * → <root>/<session>/exchange. The cwd default is deliberate: a sandboxed agent is
 * guaranteed read/write only inside its own working directory.
 */
export function resolveExchangeDir(location: ExchangeLocation): string {
  if (location.exchangeDir !== undefined) {
    return resolve(location.configDir, location.exchangeDir);
  }
  if (location.cwd !== undefined) return join(location.cwd, ".muxeon");
  return join(location.root, location.session, "exchange");
}

/**
 * resolveExchangeDir settled against the REAL filesystem (T122, FR-83): the dir
 * is created up front (ensure() would anyway) and symlinks in its path are
 * resolved. The §13.2 hint must name the dir the way the AGENT sees it — an
 * agent whose cwd is reached via a symlink lives in the realpath world, and a
 * symlinked spelling reads to its tooling as "outside the working directory"
 * (../../-style displays, permission prompts, a stalled turn — the T121/T122
 * live finding on a second machine). Server-side fs would follow the symlink
 * either way; the realpath spelling makes BOTH sides see one folder. Falls
 * back to the resolved spelling when the dir cannot be created/resolved (the
 * boot must not die for one broken agent path — §5.1 spirit).
 */
export async function settleExchangeDir(location: ExchangeLocation): Promise<string> {
  const dir = resolveExchangeDir(location);
  try {
    await mkdir(dir, { recursive: true });
    return await realpath(dir);
  } catch {
    return dir;
  }
}

export interface ExchangeOptions {
  /** The resolved <exchange> dir (resolveExchangeDir). */
  readonly dir: string;
  /**
   * Orphan-sweep guard: an inbox dir is removed only when it is NOT the active
   * cur/ message AND its mtime is older than this — protects a freshly
   * materialized dir from racing a stale cur/ snapshot (§5.4). Default 10 min.
   */
  readonly orphanMinAgeMs?: number;
  /**
   * Late-harvest settle guard (FR-74): an orphan dir is offered to the
   * late-reply harvest only when its mtime is older than this — a reply.md
   * still being written is not picked up half-done. Default 30s.
   */
  readonly harvestSettleMs?: number;
  /** File-detect poll cadence (FR-53, NFR-10) — same default as outputPollMs. */
  readonly pollIntervalMs?: number;
  /**
   * Hot-path settle guard (T239): how many consecutive identical (size, mtime)
   * samples of the answer files `collect` requires before reading them, spaced
   * `pollIntervalMs`. Default 2 — one extra sample, the same discipline the
   * outbox uses for half-written files (FR-55). `1` disables the wait.
   */
  readonly replySettleTicks?: number;
  /**
   * Warning sink (T239) — receives the message BODY; the caller owns the prefix
   * (it knows whose exchange this is). The orphan sweep deletes by age, and an
   * orphan can still hold an ANSWER the agent wrote (an uncollected reply.md:
   * the turn was never closed, or every delivery attempt was refused).
   * Destroying that must be visible; ordinary empty orphans stay silent.
   */
  readonly warn?: (text: string) => void;
}

export interface Exchange {
  readonly dir: string;
  readonly inboxDir: string;
  readonly outboxDir: string;
  /** The inbox dir of one message: <exchange>/inbox/<sanitized id>/ (§13.2). */
  messageDir(message: Signal): string;
  /**
   * Materialize the claimed message BEFORE injection (FR-52): mkdir + write
   * message.json via tmp+rename (§5.3). Idempotent by id — a crash re-send
   * overwrites the same file. Returns the absolute message.json path for the
   * instruction render (§13.2).
   */
  materialize(message: Signal): Promise<{ messageFile: string }>;
  /** Remove the message's inbox dir (after collection / a failed turn). */
  cleanup(message: Signal): Promise<void>;
  /**
   * File-detect (FR-53, §13.3): resolves when the message's message.json is gone
   * — the agent's explicit "processing complete". Edge-triggered by construction
   * (the file lives exactly one turn). Only raced when materialization succeeded
   * (the dispatcher's guard) — otherwise an absent file would be an instant
   * false "done". Returns silently once `signal` aborts (the race is settled).
   */
  awaitDone(message: Signal, signal: AbortSignal): Promise<void>;
  /**
   * Collect the agent's file answer at turn end (FR-54, §13.3) — REGARDLESS of
   * which detector won: a non-empty reply.md is the answer text; every other
   * regular file (hidden files and subdirs ignored) is an artifact to attach.
   * null ⇒ nothing file-borne — the FR-47/FR-45 chain takes over. Pure FS:
   * blob ingestion and routing are the caller's (bootstrap wiring) concern.
   *
   * Settle guard (T239): file-detect is not the only way a turn ends — the
   * output detector can win WHILE the agent is still writing reply.md, and the
   * files were read (and the dir then removed) mid-write. The answer files must
   * therefore hold still — the same (size, mtime) across `replySettleTicks`
   * samples — before anything is read; a dir still changing at the cap yields
   * null, leaving the whole collection to the late harvest (FR-74) rather than
   * delivering a truncated answer.
   */
  collect(message: Signal): Promise<CollectedReply | null>;
  /**
   * Retention hook (§5.4): remove orphaned inbox dirs (crash between turn end
   * and cleanup). Keeps the active LOGICAL ids (sanitized internally to dir
   * names) and anything younger than the age guard.
   *
   * Late-reply harvest (FR-74, T105 — live finding): an agent that broke the
   * contract order (deleted message.json FIRST, wrote reply.md after) leaves
   * its answer in the orphan dir — before T105 the sweep silently destroyed
   * it. Now, when `onLateReply` is given, each settled orphan whose turn
   * really ended (message.json gone) and whose original Signal survives in
   * the `.signal.json` sidecar is offered to the callback; `true` (collected
   * and routed) removes the dir at once. Everything else keeps the old
   * age-gated deletion.
   */
  sweepOrphans(
    activeIds: ReadonlySet<string>,
    onLateReply?: (message: Signal) => Promise<boolean>,
  ): Promise<void>;
}

/** The agent's file answer (§13.3): reply text and/or artifact files. */
export interface CollectedReply {
  /** Trimmed reply.md contents, when present and non-empty. */
  readonly text?: string;
  /** Artifact files (absolute paths), oldest-name-first for determinism. */
  readonly files: readonly { name: string; path: string }[];
}

const GITIGNORE = "*\n";
const DEFAULT_ORPHAN_MIN_AGE_MS = 10 * 60_000;
const DEFAULT_HARVEST_SETTLE_MS = 30_000;
const REPLY_FILE = "reply.md";
const DEFAULT_REPLY_SETTLE_TICKS = 2;
// Upper bound on the settle wait (T239). An agent that keeps writing this long
// is not "about to finish" — hand the dir to the late harvest (FR-74, which
// waits out its own 30s) instead of blocking the dispatcher's turn loop.
const SETTLE_MAX_TICKS = 30;
// Hidden Signal sidecar (FR-74): written at materialization next to message.json,
// survives the agent's delete (the contract names message.json only) — carries
// the original sender/id the late-reply harvest needs after the turn ended.
// Dot-name ⇒ never collected as an artifact (§13.3).
const SIGNAL_SIDECAR = ".signal.json";

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Fingerprint of the answer files of one turn dir (T239): every collectable
 * regular file as `name:size:mtime`. message.json and dotfiles are excluded —
 * they are not collected, and message.json vanishing mid-settle (the file-detect
 * signal itself) must not read as "the answer changed". null ⇒ the dir is gone.
 */
async function answerFingerprint(msgDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = (await readdir(msgDir)).sort();
  } catch {
    return null;
  }
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "message.json") continue;
    try {
      const info = await stat(join(msgDir, entry));
      if (info.isFile()) parts.push(`${entry}:${info.size}:${info.mtimeMs}`);
    } catch {
      // raced the agent's own cleanup — the next sample settles it
    }
  }
  return parts.join("\n");
}

/**
 * What an about-to-be-age-deleted orphan still holds (T239): a non-empty
 * reply.md and/or artifact files are an answer that was produced and never
 * delivered — the deletion must not be silent. undefined ⇒ nothing was lost
 * (an ordinary empty orphan: a crash between turn end and cleanup).
 */
async function describeLostAnswer(path: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = (await readdir(path)).sort();
  } catch {
    return undefined;
  }
  let reply = false;
  let artifacts = 0;
  let open = false;
  for (const entry of entries) {
    if (entry === "message.json") {
      open = true; // the turn was never closed — file-detect never fired
      continue;
    }
    if (entry.startsWith(".")) continue;
    if (entry === REPLY_FILE) {
      reply = (await readFile(join(path, entry), "utf8").catch(() => "")).trim().length > 0;
      continue;
    }
    artifacts += 1;
  }
  if (!reply && artifacts === 0) return undefined;
  const held = [
    ...(reply ? [REPLY_FILE] : []),
    ...(artifacts > 0 ? [`${artifacts} artifact file(s)`] : []),
  ].join(" + ");
  return `${held}; ${
    open
      ? "message.json was never deleted — the agent did not close the turn (FR-53)"
      : "the turn ended, but no delivery attempt succeeded (FR-54/FR-74)"
  }`;
}

/** The sidecar's Signal, or undefined when absent/corrupt (pre-FR-74 dirs). */
async function readSidecar(path: string): Promise<Signal | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.from !== "string") return undefined;
    return parsed as Signal;
  } catch {
    return undefined;
  }
}

export function createExchange(options: ExchangeOptions): Exchange {
  const dir = options.dir;
  const inboxDir = join(dir, "inbox");
  const outboxDir = join(dir, "outbox");
  const orphanMinAgeMs = options.orphanMinAgeMs ?? DEFAULT_ORPHAN_MIN_AGE_MS;
  const harvestSettleMs = options.harvestSettleMs ?? DEFAULT_HARVEST_SETTLE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const replySettleTicks = options.replySettleTicks ?? DEFAULT_REPLY_SETTLE_TICKS;
  const warn =
    options.warn ?? ((text: string) => void process.stderr.write(`muxeon: warning: ${text}\n`));
  let ensured = false;

  // Lazy one-time setup: inbox/outbox dirs + the system-owned .gitignore (§13.1)
  // so exchange internals never pollute the agent's VCS. The marker file is
  // (re)written only when missing — the agent's own .gitignore edits survive.
  const ensure = async (): Promise<void> => {
    if (ensured) return;
    await mkdir(inboxDir, { recursive: true });
    await mkdir(outboxDir, { recursive: true });
    await writeFile(join(dir, ".gitignore"), GITIGNORE, { flag: "wx" }).catch(() => undefined);
    ensured = true;
  };

  const messageDir = (message: Signal): string => join(inboxDir, sanitizeFileId(message.id));

  /**
   * Wait until the turn dir's answer files stop changing (T239, see `collect`).
   * An EMPTY dir settles instantly: there is nothing to read half-done, and a
   * file appearing later belongs to the late harvest anyway (FR-74) — so the
   * common "no file-borne reply" turn pays nothing. false ⇒ still changing at
   * the cap; the caller must leave the dir alone.
   */
  const settled = async (msgDir: string): Promise<boolean> => {
    if (replySettleTicks <= 1) return true;
    let prev = await answerFingerprint(msgDir);
    if (prev === null || prev === "") return true;
    let stable = 1;
    for (let tick = 0; tick < SETTLE_MAX_TICKS; tick += 1) {
      await sleep(pollIntervalMs);
      const next = await answerFingerprint(msgDir);
      if (next === prev) {
        stable += 1;
        if (stable >= replySettleTicks) return true;
      } else {
        stable = 1;
        prev = next;
      }
    }
    return false;
  };

  return {
    dir,
    inboxDir,
    outboxDir,
    messageDir,

    async materialize(message: Signal): Promise<{ messageFile: string }> {
      await ensure();
      const msgDir = messageDir(message);
      await mkdir(msgDir, { recursive: true });
      // The hidden sidecar FIRST (FR-74): if the agent deletes message.json
      // before writing reply.md, the sidecar still tells the harvest who asked.
      const sidecarTmp = join(msgDir, `${SIGNAL_SIDECAR}.tmp`);
      await writeFile(sidecarTmp, `${JSON.stringify(message)}\n`);
      await rename(sidecarTmp, join(msgDir, SIGNAL_SIDECAR));
      const messageFile = join(msgDir, "message.json");
      const tmp = join(msgDir, ".message.json.tmp"); // hidden — never an artifact (§13.3)
      await writeFile(tmp, `${JSON.stringify(message, null, 2)}\n`);
      await rename(tmp, messageFile); // atomic publish (§5.3)
      return { messageFile };
    },

    async cleanup(message: Signal): Promise<void> {
      await rm(messageDir(message), { recursive: true, force: true });
    },

    async awaitDone(message: Signal, signal: AbortSignal): Promise<void> {
      const file = join(messageDir(message), "message.json");
      while (!signal.aborted) {
        try {
          await stat(file);
        } catch {
          return; // gone (or the whole dir is) — the agent declared the turn done
        }
        await sleep(pollIntervalMs);
      }
    },

    async collect(message: Signal): Promise<CollectedReply | null> {
      const msgDir = messageDir(message);
      if (!(await settled(msgDir))) return null; // still being written (T239)
      let entries: string[];
      try {
        entries = (await readdir(msgDir)).sort();
      } catch {
        return null; // dir gone (agent removed it whole) — nothing file-borne
      }
      let text: string | undefined;
      const files: { name: string; path: string }[] = [];
      for (const entry of entries) {
        if (entry.startsWith(".") || entry === "message.json") continue;
        const path = join(msgDir, entry);
        try {
          if (!(await stat(path)).isFile()) continue; // subdirs ignored (§13.3)
        } catch {
          continue;
        }
        if (entry === REPLY_FILE) {
          const reply = (await readFile(path, "utf8")).trim();
          if (reply.length > 0) text = reply;
          continue;
        }
        files.push({ name: entry, path });
      }
      if (text === undefined && files.length === 0) return null;
      return { ...(text !== undefined ? { text } : {}), files };
    },

    async sweepOrphans(
      activeIds: ReadonlySet<string>,
      onLateReply?: (message: Signal) => Promise<boolean>,
    ): Promise<void> {
      let entries: string[];
      try {
        entries = await readdir(inboxDir);
      } catch {
        return; // no inbox yet — nothing to sweep
      }
      const activeDirs = new Set([...activeIds].map(sanitizeFileId));
      const cutoff = Date.now() - orphanMinAgeMs;
      const settleCutoff = Date.now() - harvestSettleMs;
      for (const entry of entries) {
        if (activeDirs.has(entry)) continue; // the in-flight cur/ message (§10.13)
        const path = join(inboxDir, entry);
        try {
          const info = await stat(path);
          if (!info.isDirectory()) continue;
          // Late-reply harvest (FR-74): the turn really ended (message.json
          // gone — a still-present one means an unclaimed/redeliverable turn,
          // §10.9, whose files belong to the COMING re-run), the dir settled
          // (no fresh writes), and the sidecar names the original sender.
          if (onLateReply !== undefined && info.mtimeMs <= settleCutoff) {
            const ended = !(await fileExists(join(path, "message.json")));
            const original = ended ? await readSidecar(join(path, SIGNAL_SIDECAR)) : undefined;
            if (original !== undefined && (await onLateReply(original))) {
              await rm(path, { recursive: true, force: true });
              continue;
            }
          }
          if (info.mtimeMs > cutoff) continue;
          // The age path is the LAST stop (T239): whatever the agent left here
          // dies with the dir. An answer dying silently is what made a live
          // delivery gap unexplainable for hours — say it out loud.
          const lost = await describeLostAnswer(path);
          if (lost !== undefined) {
            warn(
              `exchange inbox dir "${entry}" removed after the orphan window — an UNDELIVERED answer went with it: ${lost}`,
            );
          }
          await rm(path, { recursive: true, force: true });
        } catch {
          // raced its own cleanup — fine
        }
      }
    },
  };
}
