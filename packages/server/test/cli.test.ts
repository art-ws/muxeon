// teamai operator CLI (T33, §7.4, FR-32): subcommands mirror the operator-plane
// (§8.5) and run against a booted server through the in-process admin transport
// (the network path is the same handler behind the surface's loopback gate).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Adapter, AdapterRegistry } from "@teamai/adapters";
import type { SessionControl } from "@teamai/lifecycle";
import { type TeamaiServer, bootstrap } from "../src/bootstrap";
import { CLI_COMMANDS, runCli } from "../src/cli/cli";

function dummyRegistry(): AdapterRegistry {
  const adapter: Adapter = {
    type: "dummy",
    render: (message) => String(message.payload),
    detect: { readyPrompt: /READY>\s*$/ },
    slashCommand: (name) => `/${name}`,
  };
  return new AdapterRegistry([adapter]);
}

class FakeSessions implements SessionControl {
  readonly live = new Set<string>(["researcher-s", "writer-s"]);
  async hasSession(name: string): Promise<boolean> {
    return this.live.has(name);
  }
  async newSession(name: string): Promise<void> {
    this.live.add(name);
  }
  async killSession(name: string): Promise<void> {
    this.live.delete(name);
  }
  async sendLiteral(): Promise<void> {}
  async sendKeys(): Promise<void> {}
  async capturePane(): Promise<string> {
    return "";
  }
}

let dir: string;
let server: TeamaiServer;
let out: string[];
let err: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "teamai-cli-"));
  out = [];
  err = [];
  const sessions = new FakeSessions();
  const configFile = join(dir, "teamai.config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      server: { port: 0, mcp: false, queueDir: "./queue" },
      agents: [
        {
          name: "researcher",
          type: "dummy",
          tmux: "researcher-s",
          provision: { command: ["dummy"] },
        },
        { name: "writer", type: "dummy", tmux: "writer-s" },
      ],
      topology: { researcher: ["writer"] },
      channels: [],
    }),
  );
  server = await bootstrap({
    configFile,
    registry: dummyRegistry(),
    probe: (name) => sessions.hasSession(name),
    makeDriver: () => ({ inject: async () => undefined, awaitTurn: async () => undefined }),
    sessionControl: sessions,
    startRoutines: false,
  });
});

afterEach(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function cli(...argv: string[]): Promise<number> {
  return runCli(["--url", server.adminUrl, ...argv], {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    fetchImpl: (req) => server.adminFetch(req),
  });
}

describe("teamai CLI (§7.4, §8.5, FR-32)", () => {
  test("the launcher and the CLI share one binary: subcommands are reserved", () => {
    expect(CLI_COMMANDS.has("agents")).toBe(true);
    expect(CLI_COMMANDS.has("teamai.config.json")).toBe(false); // a config path still launches
  });

  test("agents lists names + status", async () => {
    expect(await cli("agents")).toBe(0);
    expect(out).toEqual(["researcher (researcher-s): idle", "writer (writer-s): idle"]);
  });

  test("pause / resume block and unblock delivery; agents marks the paused one (§16.5, FR-119)", async () => {
    expect(await cli("pause", "researcher")).toBe(0);
    expect(out).toEqual(["researcher: paused"]);
    out = [];
    // The marker sits BESIDE the status — the session is still idle (§16.1).
    expect(await cli("agents")).toBe(0);
    expect(out).toEqual(["researcher (researcher-s): idle [paused]", "writer (writer-s): idle"]);
    out = [];
    // Delivery to the paused agent is refused (§16.2) — the CLI surfaces the reason.
    expect(await cli("signals", "send", "--from", "writer", "--to", "researcher", "ping")).toBe(1);
    expect(err.join("\n")).toContain("paused");
    out = [];
    err = [];
    expect(await cli("resume", "researcher")).toBe(0);
    expect(out).toEqual(["researcher: not paused"]);
    out = [];
    expect(await cli("signals", "send", "--from", "writer", "--to", "researcher", "ping")).toBe(0);
    expect(out[0]).toMatch(/^queued .+ → researcher$/);
  });

  test("pause / resume are reserved subcommands and need an agent name", async () => {
    expect(CLI_COMMANDS.has("pause")).toBe(true);
    expect(CLI_COMMANDS.has("resume")).toBe(true);
    // Same shape as kill/restart without a name: exit 1 with the missing-arg usage.
    expect(await cli("pause")).toBe(1);
    expect(err.join("\n")).toContain("missing <agent>");
  });

  test("kill / restart / provision drive lifecycle and report the new status", async () => {
    expect(await cli("kill", "researcher")).toBe(0);
    expect(await cli("restart", "researcher")).toBe(0);
    expect(await cli("kill", "researcher")).toBe(0);
    expect(await cli("provision", "researcher")).toBe(0);
    expect(out).toEqual([
      "researcher: down",
      "researcher: idle",
      "researcher: down",
      "researcher: idle",
    ]);
  });

  test("signals send routes by edge; queues peek/cancel mirror §8.5", async () => {
    await server.adminFetch(
      new Request(`${server.adminUrl}/agents/writer/kill`, { method: "POST" }),
    ); // writer down → its queue accumulates
    expect(
      await cli("signals", "send", "--from", "researcher", "--to", "writer", "hello", "writer"),
    ).toBe(0);
    expect(out[0]).toMatch(/^queued .+ → writer$/);

    out = [];
    expect(await cli("queues", "peek", "writer")).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("from=researcher");
    expect(out[0]).toContain("hello writer");

    const id = out[0]?.split(" ")[1] ?? "";
    out = [];
    expect(await cli("queues", "cancel", "writer", id)).toBe(0);
    expect(out).toEqual([`cancelled ${id}`]);
    out = [];
    expect(await cli("queues", "peek", "writer")).toBe(0);
    expect(out).toEqual(["queue is empty"]);
  });

  test("routines put/list/disable/run-once/delete round-trip", async () => {
    const file = join(dir, "nightly.md");
    writeFileSync(file, "---\nid: nightly\nschedule: once\n---\nCompile the report.\n");
    expect(await cli("routines", "put", "researcher", "nightly", file)).toBe(0);
    expect(await cli("routines", "list")).toBe(0);
    expect(out).toContain("researcher/nightly: schedule=once target=researcher enabled=true");

    out = [];
    expect(await cli("routines", "disable", "researcher", "nightly")).toBe(0);
    expect(await cli("routines", "run-once", "researcher", "nightly")).toBe(0); // fires though disabled
    expect(out[1]).toMatch(/^fired researcher\/nightly → researcher/);

    out = [];
    expect(await cli("routines", "delete", "researcher", "nightly")).toBe(0);
    expect(await cli("routines", "list")).toBe(0);
    expect(out).toEqual(["deleted researcher/nightly", "no routines"]);
  });

  test("admin errors surface as clear operator messages with exit 1", async () => {
    expect(await cli("kill", "ghost")).toBe(1);
    expect(err).toEqual(['teamai: unknown agent "ghost"']);
  });

  test("unknown command prints usage", async () => {
    const code = await runCli(["--url", "http://x/admin", "frobnicate"], {
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
      fetchImpl: (req) => server.adminFetch(req),
    });
    expect(code).toBe(2);
    expect(err[0]).toContain("usage:");
  });

  test("channels reports when none are configured", async () => {
    expect(await cli("channels")).toBe(0);
    expect(out).toEqual(["no channels configured"]);
  });
});

describe("signals send --blob (§8.5, FR-46)", () => {
  test("uploads the file and sends the §12.5 {text, blobs} payload", async () => {
    await server.adminFetch(
      new Request(`${server.adminUrl}/agents/writer/kill`, { method: "POST" }),
    ); // writer down → its queue accumulates, the record is inspectable on disk
    const file = join(dir, "report.md");
    writeFileSync(file, "# отчёт\nсодержимое");

    out = [];
    expect(
      await cli(
        "signals",
        "send",
        "--from",
        "researcher",
        "--to",
        "writer",
        "--blob",
        file,
        "вот файл",
      ),
    ).toBe(0);
    expect(out[0]).toMatch(/^queued .+ → writer$/);

    // The queued record carries the §12.5 ref and the blob bytes are in the store.
    const pendingDir = join(dir, "queue", "writer-s", "pending");
    const recordFile = readdirSync(pendingDir).find((f) => f.endsWith(".json")) ?? "";
    const record = JSON.parse(readFileSync(join(pendingDir, recordFile), "utf8")) as {
      payload: {
        text: string;
        blobs: { blob: string; name: string; mime: string; size: number }[];
      };
    };
    const payload = record.payload;
    expect(payload.text).toBe("вот файл");
    const ref = payload.blobs[0];
    if (ref === undefined) throw new Error("expected a blob ref");
    expect(ref.name).toBe("report.md");
    expect(ref.mime).toBe("text/markdown");
    const stored = readFileSync(join(dir, "queue", "blobs", ref.blob), "utf8");
    expect(stored).toBe("# отчёт\nсодержимое");
    expect(ref.size).toBe(Buffer.byteLength(stored));
  });

  test("--blob without text is allowed; a missing file is a clear error", async () => {
    expect(await cli("signals", "send", "--from", "researcher", "--to", "writer")).toBe(1);
    expect(err[0]).toContain("missing <text…> (or --blob <path>)");

    err = [];
    expect(
      await cli("signals", "send", "--from", "researcher", "--to", "writer", "--blob", "/nope.bin"),
    ).toBe(1);
    expect(err[0]).toContain("cannot read --blob file");
  });

  test("the admin blob intake rejects an empty body (FR-46)", async () => {
    const response = await server.adminFetch(
      new Request(`${server.adminUrl}/blobs`, { method: "POST", body: new Uint8Array(0) }),
    );
    expect(response.status).toBe(400);
  });
});

// `teamai hash-password` (§17.4, FR-122): an OFFLINE tool — no server, no config.
// The hash it prints must verify against the plaintext, since that is exactly
// what the panel does at login (verifyPassword, §17.4).
describe("hash-password (§17.4, FR-122)", () => {
  test("prints an argon2id hash that verifies against the password", async () => {
    const out: string[] = [];
    const code = await runCli(["hash-password"], {
      stdout: (line) => out.push(line),
      stderr: () => undefined,
      readPassword: async () => "s3cret",
    });
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^\$argon2id\$/);
    expect(await Bun.password.verify("s3cret", out[0] ?? "")).toBe(true);
    expect(await Bun.password.verify("wrong", out[0] ?? "")).toBe(false);
  });

  test("an empty password is refused (exit 1), nothing is printed", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["hash-password"], {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      readPassword: async () => "",
    });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err[0]).toMatch(/empty password/);
  });
});
