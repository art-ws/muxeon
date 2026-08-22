// muxeon operator CLI (T33, §7.4, §8.5, FR-32): the SAME binary as the launcher —
// argv starting with a known subcommand runs this thin client against the
// operator-plane HTTP-admin; anything else boots the server (index.ts). The admin
// base URL comes from --url, else from the discovered config's server.port
// (loopback, §8.1). Admin errors surface as clear operator messages (exit 1).

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { discoverConfig } from "@muxeon/config";
import { mimeByName } from "../exchange-reply";

export const CLI_COMMANDS: ReadonlySet<string> = new Set([
  "agents",
  "provision",
  "kill",
  "restart",
  "command",
  "pause",
  "resume",
  "channels",
  "signals",
  "queues",
  "routines",
  "schedules",
  "hash-password",
]);

export interface CliIO {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Admin transport; default global fetch. Tests inject the in-process handler. */
  readonly fetchImpl?: (req: Request) => Promise<Response>;
  /** Config discovery start dir (§7.4); default process.cwd(). */
  readonly cwd?: string;
  /**
   * Reads a password without echoing it (§17.4, FR-122) — injectable for tests.
   * Default: raw-mode stdin when it is a TTY, otherwise the piped stdin.
   */
  readonly readPassword?: (prompt: string) => Promise<string>;
}

class CliError extends Error {}

interface ParsedArgs {
  readonly positional: string[];
  readonly flags: Map<string, string>;
}

/**
 * Flags that stand alone — they take NO value. Every other flag consumes the next
 * argv element, so a valueless one would silently eat the message text
 * (`--no-reply принято` → the text is gone and the flag holds it).
 */
const BOOLEAN_FLAGS = new Set(["no-reply"]);

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      if (BOOLEAN_FLAGS.has(arg.slice(2))) {
        flags.set(arg.slice(2), "");
        continue;
      }
      const value = argv[i + 1];
      if (value === undefined) throw new CliError(`flag ${arg} needs a value`);
      flags.set(arg.slice(2), value);
      i += 1;
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

// Admin base resolution (§7.4): --url wins; otherwise discover the config and read
// server.port from the RAW file — no $env resolution, so reading the port never
// demands channel secrets in the CLI environment (§7.3).
function resolveBase(args: ParsedArgs, cwd: string): string {
  const url = args.flags.get("url");
  if (url !== undefined) return url.replace(/\/+$/, "");
  const explicit = args.flags.get("config");
  const location = discoverConfig({
    startDir: cwd,
    ...(explicit !== undefined ? { explicitPath: explicit } : {}),
  });
  const raw = JSON.parse(readFileSync(location.configFile, "utf8")) as {
    server?: { port?: unknown };
  };
  const port = raw.server?.port;
  if (typeof port !== "number" || port <= 0) {
    throw new CliError("cannot determine the admin port from the config — pass --url");
  }
  return `http://127.0.0.1:${port}/admin`;
}

const USAGE = `usage:
  muxeon agents
  muxeon provision|kill|restart <agent>
  muxeon pause|resume <agent>                 # block/unblock message delivery to the agent (FR-119)
  muxeon command <slash> <selector…>          # slash-command to group/tag/agent INTERSECTION (FR-115)
  muxeon channels
  muxeon signals send --from <node> --to <node> [--blob <path>] [--no-reply] <text…>
  muxeon queues peek|cancel|requeue <participant> [<id>]
  muxeon routines list [<owner>]
  muxeon routines get|delete|enable|disable|run-once <owner> <id>
  muxeon routines put <owner> <id> <file.md>
  muxeon schedules list [<agent>]             # what agents armed for themselves (§21.7)
  muxeon schedules cancel <agent> <id> [<index>]
  muxeon hash-password [--stdin]              # argon2id hash for users[].auth.passwordHash (FR-122)
options: --url <admin-url> | --config <path>`;

export async function runCli(argv: readonly string[], io: CliIO): Promise<number> {
  try {
    // hash-password (§17.4, FR-122) is an OFFLINE operator tool: it needs neither a
    // running server nor a config, so it runs before argv parsing and the admin
    // base resolution — its only option, `--stdin`, carries no value.
    if (argv[0] === "hash-password") return await hashPassword(argv.slice(1), io);
    const args = parseArgs(argv);
    const base = resolveBase(args, io.cwd ?? process.cwd());
    const transport = io.fetchImpl ?? fetch;

    const admin = async (
      method: string,
      path: string,
      body?: unknown,
    ): Promise<Record<string, unknown>> => {
      let response: Response;
      try {
        response = await transport(
          new Request(`${base}${path}`, {
            method,
            ...(body === undefined
              ? {}
              : body instanceof Uint8Array
                ? { headers: { "content-type": "application/octet-stream" }, body } // raw blob (FR-46)
                : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
          }),
        );
      } catch {
        throw new CliError(`cannot reach the muxeon server at ${base} — is it running?`);
      }
      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        throw new CliError(typeof json.error === "string" ? json.error : `HTTP ${response.status}`);
      }
      return json;
    };

    await dispatch(args, admin, io);
    return 0;
  } catch (error) {
    io.stderr(`muxeon: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof CliError && error.message.startsWith("usage")) return 2;
    return 1;
  }
}

type Admin = (method: string, path: string, body?: unknown) => Promise<Record<string, unknown>>;

function need(value: string | undefined, what: string): string {
  if (value === undefined) throw new CliError(`missing ${what}\n${USAGE}`);
  return value;
}

async function dispatch(args: ParsedArgs, admin: Admin, io: CliIO): Promise<void> {
  const [command, ...rest] = args.positional;

  switch (command) {
    case "agents": {
      const json = await admin("GET", "/agents");
      for (const a of json.agents as {
        name: string;
        session: string;
        status: string;
        paused?: boolean;
      }[]) {
        // Pause is orthogonal to the status (§16.1) — printed as a marker beside it,
        // never instead of it: an operator must still see idle/busy/down.
        io.stdout(`${a.name} (${a.session}): ${a.status}${a.paused === true ? " [paused]" : ""}`);
      }
      return;
    }
    case "pause":
    case "resume": {
      // Pause/resume (§16.5, FR-119): both send the explicit desired state, so a
      // repeated command is a no-op rather than a flip.
      const agent = need(rest[0], "<agent>");
      const json = await admin("POST", `/agents/${encodeURIComponent(agent)}/pause`, {
        paused: command === "pause",
      });
      io.stdout(`${agent}: ${json.paused === true ? "paused" : "not paused"}`);
      return;
    }
    case "provision":
    case "kill":
    case "restart": {
      const agent = need(rest[0], "<agent>");
      const json = await admin("POST", `/agents/${encodeURIComponent(agent)}/${command}`);
      io.stdout(`${agent}: ${String(json.status)}`);
      return;
    }
    case "command": {
      // muxeon command <slash> <selector…> → slash to the INTERSECTION of the
      // selectors (§15.8, FR-115). <slash> without a leading "/".
      const slash = need(rest[0], "<slash>");
      const selectors = rest.slice(1);
      if (selectors.length === 0) throw new CliError(`missing <selector…>\n${USAGE}`);
      const json = await admin("POST", "/agents/command", { slash, selectors });
      const targets = (json.targets as string[]) ?? [];
      const fanout =
        (json.fanout as { to: string; ok: boolean; output?: string; code?: string }[]) ?? [];
      io.stdout(`/${slash} → ${targets.length} agent(s): ${targets.join(", ") || "(none)"}`);
      for (const entry of fanout) {
        io.stdout(`  ${entry.to}: ${entry.ok ? "ok" : (entry.code ?? "failed")}`);
        if (entry.output !== undefined && entry.output.length > 0) {
          for (const line of entry.output.split("\n")) io.stdout(`    ${line}`);
        }
      }
      return;
    }
    case "channels": {
      const json = await admin("GET", "/channels");
      const channels = json.channels as {
        name: string;
        operator?: string;
        type: string;
        status: string;
      }[];
      if (channels.length === 0) io.stdout("no channels configured");
      // Legacy prints the bound operator; a users-mode channel (§17.2) prints its
      // instance name and says so — it serves many people, not one.
      for (const c of channels) {
        io.stdout(`${c.operator ?? `${c.name} (users)`} via ${c.type}: ${c.status}`);
      }
      return;
    }
    case "signals": {
      if (rest[0] !== "send") throw new CliError(USAGE);
      const from = need(args.flags.get("from"), "--from <node>");
      const to = need(args.flags.get("to"), "--to <node>");
      const text = rest.slice(1).join(" ");
      const blobPath = args.flags.get("blob");
      if (text.length === 0 && blobPath === undefined) {
        throw new CliError(`missing <text…> (or --blob <path>)\n${USAGE}`);
      }
      // --blob <path> (FR-46): upload the file via the admin blob intake, then carry
      // it by the §12.5 {text?, blobs:[ref]} payload convention.
      const payload = blobPath === undefined ? text : await blobPayload(blobPath, text, admin);
      const replyTo = args.flags.get("reply-to");
      const id = args.flags.get("id");
      // --no-reply (§13.7, FR-180): deliver this as a NOTICE — the recipient reads
      // it, is told no answer is expected and is given no reply path, so a receipt
      // cannot earn a receipt back. A standalone flag (BOOLEAN_FLAGS), so the text
      // after it stays the text.
      const notice = args.flags.has("no-reply");
      const json = await admin("POST", "/signals/send", {
        from,
        to,
        payload,
        ...(replyTo !== undefined ? { replyTo } : {}),
        ...(id !== undefined ? { id } : {}),
        ...(notice ? { expectsReply: false } : {}),
      });
      io.stdout(`queued ${String(json.id)} → ${to}`);
      return;
    }
    case "queues":
      return queues(rest, admin, io);
    case "routines":
      return routines(rest, admin, io);
    case "schedules":
      return schedules(rest, admin, io);
    default:
      throw new CliError(USAGE);
  }
}

// Deferred self-chains (§21.7): what agents armed for themselves, and the way to
// disarm it. No "create" — planning is the agent's own act (§21.2); an operator
// who wants a timed prompt has routines.
async function schedules(rest: readonly string[], admin: Admin, io: CliIO): Promise<void> {
  const [action, agent, id, index] = rest;
  switch (action) {
    case "list": {
      const query = agent === undefined ? "" : `?agent=${encodeURIComponent(agent)}`;
      const json = await admin("GET", `/schedules${query}`);
      const chains = json.schedules as {
        id: string;
        agent: string;
        items: { index: number; kind: string; at: string; state: string; error?: string }[];
      }[];
      for (const chain of chains) {
        io.stdout(`${chain.agent}/${chain.id}`);
        for (const item of chain.items) {
          const why = item.error === undefined ? "" : ` — ${item.error}`;
          io.stdout(`  [${item.index}] ${item.at} ${item.kind} ${item.state}${why}`);
        }
      }
      if (chains.length === 0) io.stdout("nothing is armed");
      return;
    }
    case "cancel": {
      const who = encodeURIComponent(need(agent, "<agent>"));
      const chain = encodeURIComponent(need(id, "<id>"));
      const query = index === undefined ? "" : `?index=${encodeURIComponent(index)}`;
      const json = await admin("DELETE", `/schedules/${who}/${chain}${query}`);
      io.stdout(`cancelled ${String(json.cancelled)} item(s) of ${agent}/${id}`);
      return;
    }
    default:
      throw new CliError(USAGE);
  }
}

async function queues(rest: readonly string[], admin: Admin, io: CliIO): Promise<void> {
  const [action, name, id] = rest;
  const participant = encodeURIComponent(need(name, "<participant>"));
  switch (action) {
    case "peek": {
      const json = await admin("GET", `/queues/${participant}`);
      for (const [state, entries] of [
        ["cur", json.cur],
        ["pending", json.pending],
      ] as const) {
        for (const e of entries as { message: { id: string; from: string; payload: unknown } }[]) {
          io.stdout(
            `[${state}] ${e.message.id} from=${e.message.from} ${preview(e.message.payload)}`,
          );
        }
      }
      if ((json.cur as unknown[]).length + (json.pending as unknown[]).length === 0) {
        io.stdout("queue is empty");
      }
      return;
    }
    case "cancel": {
      await admin("POST", `/queues/${participant}/cancel`, { id: need(id, "<id>") });
      io.stdout(`cancelled ${id}`);
      return;
    }
    case "requeue": {
      const json = await admin("POST", `/queues/${participant}/requeue`, {
        id: need(id, "<id>"),
      });
      io.stdout(
        json.outcome === "already-done"
          ? `${id} is already done — nothing to do`
          : `requeued ${id}`,
      );
      return;
    }
    default:
      throw new CliError(USAGE);
  }
}

async function routines(rest: readonly string[], admin: Admin, io: CliIO): Promise<void> {
  const [action, owner, id, file] = rest;
  switch (action) {
    case "list": {
      const query = owner !== undefined ? `?owner=${encodeURIComponent(owner)}` : "";
      const json = await admin("GET", `/routines${query}`);
      const routines = json.routines as {
        owner: string;
        id: string;
        schedule: string;
        enabled: boolean;
        target: string;
      }[];
      if (routines.length === 0) io.stdout("no routines");
      for (const r of routines) {
        io.stdout(
          `${r.owner}/${r.id}: schedule=${r.schedule} target=${r.target} enabled=${r.enabled}`,
        );
      }
      return;
    }
    case "get": {
      const json = await admin("GET", routinePath(owner, id));
      io.stdout(
        `${String(json.owner)}/${String(json.id)}: schedule=${String(json.schedule)} target=${String(json.target)} enabled=${String(json.enabled)}`,
      );
      io.stdout(String(json.body));
      return;
    }
    case "put": {
      const content = readFileSync(need(file, "<file.md>"), "utf8");
      await admin("PUT", routinePath(owner, id), { content });
      io.stdout(`saved ${owner}/${id}`);
      return;
    }
    case "delete": {
      await admin("DELETE", routinePath(owner, id));
      io.stdout(`deleted ${owner}/${id}`);
      return;
    }
    case "enable":
    case "disable": {
      await admin("POST", `${routinePath(owner, id)}/${action}`);
      io.stdout(`${owner}/${id} ${action}d`);
      return;
    }
    case "run-once": {
      const json = await admin("POST", `${routinePath(owner, id)}/run-once`);
      io.stdout(`fired ${owner}/${id} → ${String(json.target)} (signal ${String(json.id)})`);
      return;
    }
    default:
      throw new CliError(USAGE);
  }
}

function routinePath(owner: string | undefined, id: string | undefined): string {
  return `/routines/${encodeURIComponent(need(owner, "<owner>"))}/${encodeURIComponent(need(id, "<id>"))}`;
}

function preview(payload: unknown): string {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** Read the --blob file, upload it via POST /blobs, build the §12.5 payload. */
async function blobPayload(path: string, text: string, admin: Admin): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(path));
  } catch {
    throw new CliError(`cannot read --blob file: ${path}`);
  }
  const uploaded = await admin("POST", "/blobs", bytes);
  if (typeof uploaded.id !== "string") throw new CliError("blob upload returned no id");
  const name = basename(path);
  return {
    ...(text.length > 0 ? { text } : {}),
    blobs: [
      {
        blob: uploaded.id,
        name,
        mime: mimeByName(name), // FR-46: extension → mime for the §12.5 ref
        size: bytes.length,
      },
    ],
  };
}

/**
 * `muxeon hash-password` (§17.4, FR-122): read a password without echoing it (or
 * from stdin with `--stdin`) and print its argon2id hash for pasting into
 * `users[].auth.passwordHash`. A hash is not a secret in the §10.7 sense, so it
 * may live inline in the config; the plaintext never touches the disk here.
 */
async function hashPassword(args: readonly string[], io: CliIO): Promise<number> {
  const fromStdin = args.includes("--stdin");
  const read = io.readPassword ?? defaultReadPassword;
  const password = fromStdin
    ? (await Bun.stdin.text()).replace(/\r?\n$/, "")
    : await read("password: ");
  if (password.length === 0) {
    io.stderr("muxeon: empty password");
    return 1;
  }
  io.stdout(await Bun.password.hash(password, { algorithm: "argon2id" }));
  return 0;
}

/** Raw-mode terminal read with no echo; falls back to piped stdin when not a TTY. */
async function defaultReadPassword(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (stdin.isTTY !== true) return (await Bun.stdin.text()).replace(/\r?\n$/, "");
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  try {
    for await (const chunk of stdin) {
      const text = Buffer.from(chunk as Uint8Array).toString("utf8");
      for (const char of text) {
        if (char === "\r" || char === "\n") return value;
        if (char === "\u0003") throw new CliError("aborted"); // Ctrl-C
        if (char === "\u007f") {
          value = value.slice(0, -1); // backspace
          continue;
        }
        value += char;
      }
    }
    return value;
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    process.stderr.write("\n");
  }
}
