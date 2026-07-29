// Outbox monitor (FR-55, §13.4): pickup via atomic claim, deterministic id,
// topology refusal → .rejected.json, settle window for half-written files,
// realpath-containment for `files` (§8.7), crash-recovery of stale claims.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Signal } from "@teamai/core";
import { OutboxMonitor } from "../src/outbox";

let base: string;
let outboxDir: string;
let cwd: string;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "teamai-outbox-"));
  outboxDir = join(base, ".teamai", "outbox");
  cwd = join(base, "work");
  await mkdir(outboxDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function makeMonitor(opts: { deny?: boolean; wip?: boolean; settleTicks?: number } = {}) {
  const routed: Signal[] = [];
  const warnings: string[] = [];
  const blobs: Uint8Array[] = [];
  const monitor = new OutboxMonitor({
    agent: "researcher",
    outboxDir,
    containRoots: [join(base, ".teamai"), cwd],
    filesBase: cwd,
    blobs: {
      write: async (bytes) => {
        blobs.push(bytes);
        return `blob-${blobs.length}`;
      },
      read: async () => new Uint8Array(),
    },
    route: async (message) => {
      if (opts.wip) return { ok: false, code: "WIP_LIMIT", limit: 3, depth: 3 };
      if (opts.deny) return { ok: false };
      routed.push(message);
      return { ok: true };
    },
    settleTicks: opts.settleTicks ?? 2,
    now: () => 42,
    warn: (text) => warnings.push(text),
  });
  return { monitor, routed, warnings, blobs };
}

describe("outbox pickup (FR-55, §13.4)", () => {
  test("a valid {to, payload} routes as the folder owner and the file is consumed", async () => {
    await writeFile(join(outboxDir, "msg.json"), JSON.stringify({ to: "writer", payload: "hi" }));
    const { monitor, routed } = makeMonitor();
    await monitor.tick();
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({
      from: "researcher", // identity = folder ownership, NOT file content
      to: "writer",
      kind: "message",
      payload: "hi",
      origin: "exchange-outbox",
    });
    expect(routed[0]?.id).toMatch(/^outbox-[0-9a-f]{24}$/); // deterministic (§10.9)
    expect(readdirSync(outboxDir)).toEqual([]); // consumed
  });

  test("the id is deterministic for the same file, distinct for different content", async () => {
    await writeFile(join(outboxDir, "a.json"), JSON.stringify({ to: "writer", payload: "x" }));
    const first = makeMonitor();
    await first.monitor.tick();
    // same name + content again (e.g. crash-retry re-drop)
    await writeFile(join(outboxDir, "a.json"), JSON.stringify({ to: "writer", payload: "x" }));
    await writeFile(join(outboxDir, "b.json"), JSON.stringify({ to: "writer", payload: "y" }));
    const second = makeMonitor();
    await second.monitor.tick();
    expect(second.routed.map((m) => m.id)).toContain(first.routed[0]?.id ?? "");
    expect(new Set(second.routed.map((m) => m.id)).size).toBe(2);
  });

  test("router refusal → <name>.rejected.json + warning, visible to the agent", async () => {
    await writeFile(join(outboxDir, "msg.json"), JSON.stringify({ to: "stranger", payload: "x" }));
    const { monitor, warnings } = makeMonitor({ deny: true });
    await monitor.tick();
    expect(readdirSync(outboxDir)).toEqual(["msg.rejected.json"]);
    expect(warnings[0]).toContain("refused by the router");
  });

  test("WIP-limit refusal → rejected receipt naming the limit and depth (FR-104)", async () => {
    await writeFile(join(outboxDir, "msg.json"), JSON.stringify({ to: "writer", payload: "x" }));
    const { monitor, warnings } = makeMonitor({ wip: true });
    await monitor.tick();
    expect(readdirSync(outboxDir)).toEqual(["msg.rejected.json"]); // the agent's receipt
    const receipt = JSON.parse(readFileSync(join(outboxDir, "msg.rejected.json"), "utf8")) as {
      to?: string;
      payload?: string;
    };
    const reason = warnings[0] ?? "";
    expect(reason).toContain("WIP limit");
    expect(reason).toContain("retry when it drains");
    // the original {to,payload} is preserved in the rejected file for the agent to resend
    expect(receipt).toMatchObject({ to: "writer", payload: "x" });
  });

  test("a half-written file waits out the settle window, then rejects (§13.4)", async () => {
    const file = join(outboxDir, "partial.json");
    await writeFile(file, '{"to": "writer", "payl'); // mid-write
    const { monitor, warnings } = makeMonitor({ settleTicks: 2 });
    await monitor.tick(); // strike 0 (first sighting)
    await monitor.tick(); // strike 1
    expect(existsSync(file)).toBe(true); // still waiting
    // the agent finishes the write — pickup succeeds, no rejection
    await writeFile(file, JSON.stringify({ to: "writer", payload: "done" }));
    await monitor.tick(); // mtime/size changed → strikes reset → parse OK → routed
    expect(warnings).toHaveLength(0);
    expect(readdirSync(outboxDir)).toEqual([]);
  });

  test("a stably-broken file rejects after the settle window", async () => {
    await writeFile(join(outboxDir, "broken.json"), "not json at all");
    const { monitor, warnings } = makeMonitor({ settleTicks: 2 });
    await monitor.tick();
    await monitor.tick();
    await monitor.tick(); // strikes reach the window
    expect(readdirSync(outboxDir)).toEqual(["broken.rejected.json"]);
    expect(warnings[0]).toContain("not valid JSON");
  });

  test("files: ingested as §12.5 refs (relative paths resolve from cwd)", async () => {
    await writeFile(join(cwd, "report.png"), "imgbytes");
    await writeFile(
      join(outboxDir, "msg.json"),
      JSON.stringify({ to: "writer", payload: "see file", files: ["report.png"] }),
    );
    const { monitor, routed } = makeMonitor();
    await monitor.tick();
    expect(routed[0]?.payload).toEqual({
      text: "see file",
      blobs: [{ blob: "blob-1", name: "report.png", mime: "image/png", size: 8 }],
    });
  });

  test("a file outside the containment roots rejects the whole message (§8.7)", async () => {
    const outside = join(base, "secret.txt");
    await writeFile(outside, "secret");
    await writeFile(
      join(outboxDir, "evil.json"),
      JSON.stringify({ to: "writer", payload: "x", files: [outside] }),
    );
    const { monitor, routed, warnings } = makeMonitor();
    await monitor.tick();
    expect(routed).toHaveLength(0);
    expect(readdirSync(outboxDir)).toEqual(["evil.rejected.json"]);
    expect(warnings[0]).toContain("containment");
  });

  test("a symlink escaping the roots is caught by realpath (§8.7)", async () => {
    const outside = join(base, "secret.txt");
    await writeFile(outside, "secret");
    await symlink(outside, join(cwd, "innocent.txt"));
    await writeFile(
      join(outboxDir, "sneaky.json"),
      JSON.stringify({ to: "writer", payload: "x", files: ["innocent.txt"] }),
    );
    const { monitor, routed } = makeMonitor();
    await monitor.tick();
    expect(routed).toHaveLength(0);
    expect(readdirSync(outboxDir)).toEqual(["sneaky.rejected.json"]);
  });

  test("a stale .claim from a crash re-enters the pickup on the first tick", async () => {
    await writeFile(
      join(outboxDir, "msg.json.claim"),
      JSON.stringify({ to: "writer", payload: "retry me" }),
    );
    const { monitor, routed } = makeMonitor();
    await monitor.tick(); // recovery renames it back, then the pass picks it up
    expect(routed).toHaveLength(1);
    expect(routed[0]?.payload).toBe("retry me");
  });

  test("wrong shape gets the same settle courtesy, then a precise reason", async () => {
    await writeFile(join(outboxDir, "noto.json"), JSON.stringify({ payload: "x" }));
    const { monitor, warnings } = makeMonitor({ settleTicks: 1 });
    await monitor.tick();
    await monitor.tick();
    expect(readdirSync(outboxDir)).toEqual(["noto.rejected.json"]);
    expect(warnings[0]).toContain('"to"');
  });

  test("rejected files and hidden files are never picked up again", async () => {
    await writeFile(join(outboxDir, "old.rejected.json"), "junk");
    await writeFile(join(outboxDir, ".draft.json"), "junk");
    const { monitor, routed, warnings } = makeMonitor();
    await monitor.tick();
    expect(routed).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(readdirSync(outboxDir).sort()).toEqual([".draft.json", "old.rejected.json"]);
  });

  test("a transient route error gives the file back for the next tick", async () => {
    await writeFile(join(outboxDir, "msg.json"), JSON.stringify({ to: "writer", payload: "x" }));
    let attempts = 0;
    const routed: Signal[] = [];
    const monitor = new OutboxMonitor({
      agent: "researcher",
      outboxDir,
      containRoots: [join(base, ".teamai")],
      filesBase: cwd,
      blobs: { write: async () => "b", read: async () => new Uint8Array() },
      route: async (message) => {
        attempts += 1;
        if (attempts === 1) throw new Error("enqueue raced a sweep");
        routed.push(message);
        return { ok: true };
      },
      warn: () => undefined,
    });
    await monitor.tick(); // throws → returned to the queue
    expect(readdirSync(outboxDir)).toEqual(["msg.json"]);
    await monitor.tick(); // retried, same deterministic id
    expect(routed).toHaveLength(1);
    expect(readdirSync(outboxDir)).toEqual([]);
  });
});
