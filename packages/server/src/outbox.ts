// Outbox monitor (FR-55, §13.4) — agent initiative WITHOUT an MCP client: the
// agent drops `{ "to": ..., "payload": ... [, "files": [...] ] }` into its
// <exchange>/outbox/ and the system routes it. Identity is free and stronger
// than the cooperative MCP claim (§8.1): the folder belongs to the agent, so
// `from` is ALWAYS the owner. One monitor per agent, run by the server (§8.2).
//
// Pickup discipline (§10.13): atomic CLAIM (rename to *.json.claim) before
// route, so a file is routed at most once; the id is DETERMINISTIC (name +
// content hash) so a crash-retry duplicate collapses in the recipient's dedup
// window (§10.9). A half-written file gets the settle window: a parse failure
// rejects only after the file has been stable for `settleTicks` ticks. An
// invalid file becomes `<name>.rejected.json` IN PLACE + a warning — the agent
// sees the refusal in its own folder.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Signal } from "@muxeon/core";
import type { BlobStore } from "@muxeon/orchestrator";
import { mimeByName } from "./exchange-reply";

export interface OutboxMonitorOptions {
  /** The owning agent's topology name — every routed message's `from` (§13.4). */
  readonly agent: string;
  readonly outboxDir: string;
  /**
   * realpath-containment roots for `files` (§8.7): the exchange dir and the
   * agent's cwd. A file outside every root rejects the whole message.
   */
  readonly containRoots: readonly string[];
  /** Base dir for RELATIVE `files` paths (the agent's cwd, else the exchange). */
  readonly filesBase: string;
  readonly blobs: BlobStore;
  /**
   * Admin users (§17.11, FR-135): the fan-out set of an outbox file WITHOUT `to` —
   * the human "behind the console" is resolved through Muxeon as the `admin` role,
   * no separate entity. Returns the CURRENT admins (config is fixed at boot, so a
   * plain closure over the config is enough). Empty / absent ⇒ `to` stays mandatory
   * and a file without it is rejected exactly as before.
   */
  readonly admins?: () => readonly string[];
  readonly route: (
    message: Signal,
  ) => Promise<{ ok: boolean; code?: string; limit?: number; depth?: number }>;
  /** Pickup cadence (§7.1 outboxPollMs, NFR-10); default 1000ms. */
  readonly pollIntervalMs?: number;
  /** Parse-failure settle window in ticks (§13.4); default 3. */
  readonly settleTicks?: number;
  readonly now?: () => number;
  readonly warn?: (text: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface SettleState {
  size: number;
  mtimeMs: number;
  strikes: number;
}

/** Artifact cap shared with the reply path (FR-46). */
const FILE_CAP_BYTES = 25 * 1024 * 1024;

export class OutboxMonitor {
  readonly #o: OutboxMonitorOptions;
  readonly #settle = new Map<string, SettleState>();
  #recovered = false;

  constructor(options: OutboxMonitorOptions) {
    this.#o = options;
  }

  /** The production loop: tick and sleep until aborted (§8.2). */
  async run(signal: AbortSignal): Promise<void> {
    const interval = this.#o.pollIntervalMs ?? 1000;
    const doze = this.#o.sleep ?? ((ms: number) => sleep(ms));
    while (!signal.aborted) {
      await this.tick();
      if (!signal.aborted) await doze(interval);
    }
  }

  /** One pickup pass — exposed for tests and on-demand drains. */
  async tick(): Promise<void> {
    try {
      await mkdir(this.#o.outboxDir, { recursive: true });
    } catch {
      return;
    }
    if (!this.#recovered) {
      await this.#recoverClaims(); // crash recovery: stale claims rejoin the pickup
      this.#recovered = true;
    }
    let entries: string[];
    try {
      entries = (await readdir(this.#o.outboxDir)).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.endsWith(".json") || name.endsWith(".rejected.json") || name.startsWith(".")) {
        continue;
      }
      await this.#pickup(name);
    }
    // forget settle state of files that disappeared (consumed or agent-removed)
    for (const tracked of [...this.#settle.keys()]) {
      if (!entries.includes(tracked)) this.#settle.delete(tracked);
    }
  }

  /** A crash between claim and unlink leaves *.json.claim — re-enter the queue.
   * The deterministic id keeps an already-routed retry inside the dedup window. */
  async #recoverClaims(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.#o.outboxDir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.endsWith(".json.claim")) continue;
      await rename(
        join(this.#o.outboxDir, name),
        join(this.#o.outboxDir, name.slice(0, -".claim".length)),
      ).catch(() => undefined);
    }
  }

  async #pickup(name: string): Promise<void> {
    const path = join(this.#o.outboxDir, name);
    let raw: string;
    let size: number;
    let mtimeMs: number;
    try {
      const info = await stat(path);
      if (!info.isFile()) return;
      size = info.size;
      mtimeMs = info.mtimeMs;
      raw = await readFile(path, "utf8");
    } catch {
      return; // raced the agent — next tick
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.#strikeOrReject(name, path, size, mtimeMs, "is not valid JSON");
      return;
    }
    const shape = validateShape(parsed);
    if (typeof shape === "string") {
      // A wrong shape is not a half-written file — same settle courtesy, though:
      // the agent may still be editing it.
      await this.#strikeOrReject(name, path, size, mtimeMs, shape);
      return;
    }
    this.#settle.delete(name);

    // CLAIM before route (§10.13): the file is routed at most once.
    const claim = `${path}.claim`;
    try {
      await rename(path, claim);
    } catch {
      return; // someone consumed it first
    }

    const refs: { blob: string; name: string; mime: string; size: number }[] = [];
    for (const file of shape.files) {
      const ingested = await this.#ingest(file);
      if (typeof ingested === "string") {
        await this.#reject(claim, name, ingested);
        return;
      }
      refs.push(ingested);
    }

    // Deterministic id (name + content) — a crash-retry collapses in the
    // recipient's dedup window (§10.9) instead of double-delivering.
    const baseId = `outbox-${createHash("sha256").update(`${name}\n${raw}`).digest("hex").slice(0, 24)}`;
    const payload = refs.length === 0 ? shape.payload : { text: shape.payload, blobs: refs };
    const ts = (this.#o.now ?? Date.now)();

    // Initiative WITHOUT a recipient (§17.11, FR-135): the message goes to every
    // user with `role:"admin"` — one addressed COPY each, with its own deterministic
    // id `<outboxId>:<admin>` (dedup §10.9) and an `origin` naming the fan-out. The
    // §10.2 edge is checked PER ADDRESS: a non-neighbour admin simply does not get a
    // copy (a warning), which never fails the rest of the fan-out.
    if (shape.to === undefined) {
      const admins = this.#o.admins?.() ?? [];
      if (admins.length === 0) {
        await this.#reject(
          claim,
          name,
          'has no "to" and this server has no user with role:"admin" to fan out to (§17.11)',
        );
        return;
      }
      let delivered = 0;
      for (const admin of admins) {
        const copy: Signal = {
          id: `${baseId}:${admin}`,
          from: this.#o.agent,
          to: admin,
          kind: "message",
          ts,
          payload,
          origin: "outbox:admins",
        };
        try {
          const result = await this.#route(copy);
          if (result.ok) {
            delivered += 1;
          } else {
            const warn = this.#o.warn ?? ((text: string) => process.stderr.write(`${text}\n`));
            warn(
              `muxeon: warning: outbox message "${name}" of ${this.#o.agent} did not reach admin "${admin}" (${result.code ?? "refused"}) — §17.11`,
            );
          }
        } catch {
          await rename(claim, path).catch(() => undefined); // transient — retry next tick
          return;
        }
      }
      if (delivered === 0) {
        await this.#reject(
          claim,
          name,
          "reached no admin — none of them is a topology neighbour (§10.2)",
        );
        return;
      }
      await unlink(claim).catch(() => undefined);
      return;
    }

    const message: Signal = {
      id: baseId,
      from: this.#o.agent,
      to: shape.to,
      kind: "message",
      ts,
      payload,
      origin: "exchange-outbox",
    };
    let routed: { ok: boolean; code?: string; limit?: number; depth?: number };
    try {
      routed = await this.#route(message);
    } catch {
      // transient routing failure — give the file back for the next tick
      await rename(claim, path).catch(() => undefined);
      return;
    }
    if (!routed.ok) {
      // The receipt is the *.rejected.json in the agent's own folder (§13.4) — its
      // reason distinguishes WIP backpressure (retry later) from a hard refusal
      // (no such peer / no edge), so the agent knows whether to back off or give up.
      const why =
        routed.code === "WIP_LIMIT"
          ? `was refused: "${shape.to}" is at its WIP limit (${routed.limit}), ${routed.depth} in flight — retry when it drains (FR-104)`
          : routed.code === "AGENT_PAUSED"
            ? `was refused: "${shape.to}" is paused by the operator — retry when it resumes (§16.2, FR-117)`
            : `was refused by the router (to="${shape.to}": no such peer or no topology edge, §10.2)`;
      await this.#reject(claim, name, why);
      return;
    }
    await unlink(claim).catch(() => undefined);
  }

  async #route(
    message: Signal,
  ): Promise<{ ok: boolean; code?: string; limit?: number; depth?: number }> {
    return await this.#o.route(message);
  }

  /** Ingest one `files` entry under realpath-containment (§8.7) → a §12.5 ref. */
  async #ingest(
    file: string,
  ): Promise<{ blob: string; name: string; mime: string; size: number } | string> {
    const candidate = isAbsolute(file) ? file : resolve(this.#o.filesBase, file);
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      return `references a missing file: ${file}`;
    }
    const roots = await Promise.all(
      this.#o.containRoots.map((root) => realpath(root).catch(() => null)),
    );
    const contained = roots.some(
      (root) => root !== null && (real === root || real.startsWith(root + sep)),
    );
    if (!contained) {
      return `references a file outside the exchange/cwd containment (§8.7): ${file}`;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(real));
    } catch {
      return `references an unreadable file: ${file}`;
    }
    if (bytes.length > FILE_CAP_BYTES) {
      return `references a file over the ${FILE_CAP_BYTES}-byte cap (FR-46): ${file}`;
    }
    const base = real.split(sep).pop() ?? "file";
    return {
      blob: await this.#o.blobs.write(bytes, { name: base }),
      name: base,
      mime: mimeByName(base),
      size: bytes.length,
    };
  }

  /** Parse/shape failure: wait out the settle window, then reject (§13.4). */
  async #strikeOrReject(
    name: string,
    path: string,
    size: number,
    mtimeMs: number,
    why: string,
  ): Promise<void> {
    const ticks = this.#o.settleTicks ?? 3;
    const prev = this.#settle.get(name);
    const stable = prev !== undefined && prev.size === size && prev.mtimeMs === mtimeMs;
    const strikes = stable ? prev.strikes + 1 : 0;
    this.#settle.set(name, { size, mtimeMs, strikes });
    if (strikes >= ticks) {
      this.#settle.delete(name);
      await this.#reject(path, name, why);
    }
  }

  async #reject(currentPath: string, name: string, why: string): Promise<void> {
    const base = name.endsWith(".json") ? name.slice(0, -".json".length) : name;
    const rejected = join(this.#o.outboxDir, `${base}.rejected.json`);
    await rename(currentPath, rejected).catch(() => undefined);
    const warn = this.#o.warn ?? ((text: string) => process.stderr.write(`${text}\n`));
    warn(
      `muxeon: warning: outbox message "${name}" of ${this.#o.agent} ${why} — moved to ${base}.rejected.json (FR-55)`,
    );
  }
}

/**
 * Validate the §13.4 shape; returns the parsed shape or a refusal reason. `to` is
 * OPTIONAL since §17.11 (FR-135) — a file without it addresses all admin users;
 * the caller rejects it when the server has none, so the contract is unchanged for
 * a config without users.
 */
function validateShape(
  parsed: unknown,
): { to?: string; payload: string; files: string[] } | string {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "is not a JSON object";
  }
  const { to, payload, files } = parsed as { to?: unknown; payload?: unknown; files?: unknown };
  if (to !== undefined && (typeof to !== "string" || to.length === 0)) {
    return 'has a malformed "to" (expected a non-empty peer name)';
  }
  if (typeof payload !== "string") return 'has no "payload" (expected a string)';
  if (files !== undefined) {
    if (!Array.isArray(files) || files.some((f) => typeof f !== "string" || f.length === 0)) {
      return 'has a malformed "files" (expected an array of paths)';
    }
  }
  return {
    ...(typeof to === "string" ? { to } : {}),
    payload,
    files: (files as string[] | undefined) ?? [],
  };
}
