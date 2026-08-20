// Outbox monitor (FR-55, §13.4): pickup via atomic claim, deterministic id,
// topology refusal → .rejected.json, settle window for half-written files,
// realpath-containment for `files` (§8.7), crash-recovery of stale claims.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Signal } from "@muxeon/core";
import { OutboxMonitor } from "../src/outbox";

let base: string;
let outboxDir: string;
let cwd: string;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "muxeon-outbox-"));
  outboxDir = join(base, ".muxeon", "outbox");
  cwd = join(base, "work");
  await mkdir(outboxDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function makeMonitor(
  opts: {
    deny?: boolean;
    wip?: boolean;
    paused?: boolean;
    settleTicks?: number;
    /** Admin users for the §17.11 no-recipient fan-out (FR-135). */
    admins?: readonly string[];
    /** Names the router refuses (no edge) — the per-address check of §17.11. */
    noEdge?: readonly string[];
    /** No reaction door wired at all (§19.13, Q2) — a react drop must be rejected. */
    noReactions?: boolean;
    /** The hub's refusal code for a react drop. */
    reactRefusal?: string;
  } = {},
) {
  const routed: Signal[] = [];
  const warnings: string[] = [];
  const blobs: Uint8Array[] = [];
  const reactions: { peer: string; messageId: string; key: string; remove?: boolean }[] = [];
  const monitor = new OutboxMonitor({
    agent: "researcher",
    outboxDir,
    containRoots: [join(base, ".muxeon"), cwd],
    filesBase: cwd,
    blobs: {
      write: async (bytes) => {
        blobs.push(bytes);
        return `blob-${blobs.length}`;
      },
      read: async () => new Uint8Array(),
    },
    ...(opts.admins !== undefined ? { admins: () => opts.admins ?? [] } : {}),
    route: async (message) => {
      if (opts.wip) return { ok: false, code: "WIP_LIMIT", limit: 3, depth: 3 };
      if (opts.paused) return { ok: false, code: "AGENT_PAUSED" };
      if (opts.deny) return { ok: false };
      if (opts.noEdge?.includes(message.to)) return { ok: false, code: "TOPOLOGY_DENIED" };
      routed.push(message);
      return { ok: true };
    },
    settleTicks: opts.settleTicks ?? 2,
    now: () => 42,
    warn: (text) => warnings.push(text),
    ...(opts.noReactions === true
      ? {}
      : {
          react: async (input) => {
            reactions.push(input);
            return opts.reactRefusal === undefined
              ? { ok: true }
              : { ok: false, code: opts.reactRefusal, message: "nope" };
          },
        }),
  });
  return { monitor, routed, warnings, blobs, reactions };
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

  test("a paused recipient → rejected receipt naming the pause (§16.2, FR-117)", async () => {
    await writeFile(join(outboxDir, "msg.json"), JSON.stringify({ to: "writer", payload: "x" }));
    const { monitor, warnings } = makeMonitor({ paused: true });
    await monitor.tick();
    expect(readdirSync(outboxDir)).toEqual(["msg.rejected.json"]); // the agent's receipt
    const reason = warnings[0] ?? "";
    expect(reason).toContain("is paused by the operator");
    expect(reason).toContain("retry when it resumes");
    // the original {to,payload} is preserved so the agent can resend after the resume
    expect(
      JSON.parse(readFileSync(join(outboxDir, "msg.rejected.json"), "utf8")) as unknown,
    ).toMatchObject({ to: "writer", payload: "x" });
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
      containRoots: [join(base, ".muxeon")],
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

// §17.11 / FR-135: an outbox file WITHOUT `to` is the agent's initiative aimed at
// "whoever runs this stand" — it fans out to every user with role:"admin", one
// addressed copy each, with the §10.2 edge checked PER ADDRESS.
describe("no-recipient initiative → the admins (§17.11, FR-135)", () => {
  test("one addressed copy per admin, deterministic ids, admin origin", async () => {
    await writeFile(join(outboxDir, "ping.json"), JSON.stringify({ payload: "look at this" }));
    const { monitor, routed } = makeMonitor({ admins: ["alex", "kim"] });
    await monitor.tick();
    expect(routed.map((m) => m.to)).toEqual(["alex", "kim"]);
    expect(routed.every((m) => m.origin === "outbox:admins")).toBe(true);
    expect(routed.every((m) => m.payload === "look at this")).toBe(true);
    const [base] = routed[0]?.id.split(":") ?? [];
    expect(routed.map((m) => m.id)).toEqual([`${base}:alex`, `${base}:kim`]);
    expect(readdirSync(outboxDir)).toEqual([]); // consumed
  });

  test("an admin that is not a topology neighbour is a warning, not a failed fan-out", async () => {
    await writeFile(join(outboxDir, "ping.json"), JSON.stringify({ payload: "hi" }));
    const { monitor, routed, warnings } = makeMonitor({
      admins: ["alex", "kim"],
      noEdge: ["kim"],
    });
    await monitor.tick();
    expect(routed.map((m) => m.to)).toEqual(["alex"]);
    expect(warnings.some((w) => w.includes('did not reach admin "kim"'))).toBe(true);
    expect(readdirSync(outboxDir)).toEqual([]); // the rest of the fan-out stands
  });

  test("with NO admins configured `to` stays mandatory — the file is rejected, not dropped", async () => {
    await writeFile(join(outboxDir, "ping.json"), JSON.stringify({ payload: "hi" }));
    const { monitor, routed, warnings } = makeMonitor();
    await monitor.tick();
    expect(routed).toEqual([]);
    expect(existsSync(join(outboxDir, "ping.rejected.json"))).toBe(true);
    expect(warnings.some((w) => w.includes('has no "to"'))).toBe(true);
  });

  test("reaching NO admin at all rejects the file (nothing was delivered)", async () => {
    await writeFile(join(outboxDir, "ping.json"), JSON.stringify({ payload: "hi" }));
    const { monitor, routed } = makeMonitor({ admins: ["alex"], noEdge: ["alex"] });
    await monitor.tick();
    expect(routed).toEqual([]);
    expect(existsSync(join(outboxDir, "ping.rejected.json"))).toBe(true);
  });

  test("a malformed `to` is still rejected (the field is optional, not free-form)", async () => {
    await writeFile(join(outboxDir, "bad.json"), JSON.stringify({ to: "", payload: "hi" }));
    const { monitor, warnings } = makeMonitor({ admins: ["alex"] });
    await monitor.tick();
    await monitor.tick();
    await monitor.tick();
    expect(existsSync(join(outboxDir, "bad.rejected.json"))).toBe(true);
    expect(warnings.some((w) => w.includes('malformed "to"'))).toBe(true);
  });
});

// §13.7 / FR-180: the receipt an agent on the FILE contract can send. `reply.md`
// carries no flags and will not get one (a second reserved name in the turn folder
// is a second named reply path, §10.29/T267), so the drop file is the whole story
// for that half of the park.
describe("a receipt drop (§13.7, FR-180)", () => {
  test("expectsReply:false rides the envelope of an ordinary drop", async () => {
    await writeFile(
      join(outboxDir, "ack.json"),
      JSON.stringify({ to: "writer", payload: "принято", expectsReply: false }),
    );
    const { monitor, routed } = makeMonitor();
    await monitor.tick();
    expect(routed[0]).toMatchObject({
      to: "writer",
      kind: "message", // a modifier, not a kind
      payload: "принято",
      expectsReply: false,
    });
  });

  test("a drop without the field carries none — the envelope shape is unchanged", async () => {
    await writeFile(join(outboxDir, "plain.json"), JSON.stringify({ to: "writer", payload: "hi" }));
    const { monitor, routed } = makeMonitor();
    await monitor.tick();
    expect(routed[0]).not.toHaveProperty("expectsReply");
  });

  test("the admin fan-out carries the flag too (§17.11)", async () => {
    await writeFile(
      join(outboxDir, "ack.json"),
      JSON.stringify({ payload: "готово, ответ не нужен", expectsReply: false }),
    );
    const { monitor, routed } = makeMonitor({ admins: ["alex", "kim"] });
    await monitor.tick();
    expect(routed.map((m) => m.expectsReply)).toEqual([false, false]);
  });

  test("a non-boolean flag is rejected, not ignored — a silent 'ok' would be a lie", async () => {
    await writeFile(
      join(outboxDir, "bad.json"),
      JSON.stringify({ to: "writer", payload: "hi", expectsReply: "no" }),
    );
    const { monitor, routed, warnings } = makeMonitor();
    await monitor.tick();
    await monitor.tick();
    await monitor.tick();
    expect(routed).toEqual([]);
    expect(existsSync(join(outboxDir, "bad.rejected.json"))).toBe(true);
    expect(warnings.some((w) => w.includes('malformed "expectsReply"'))).toBe(true);
  });
});

// §19.13 decision Q2 (FR-181): the SECOND door into the reactions hub, for the half
// of the park that has no agent-plane session. A drop is either a message or a
// reaction — never both — and it routes nothing.
describe("a reaction drop (§19.13, FR-181)", () => {
  test("{react:{...}} reaches the hub and routes no message at all", async () => {
    await writeFile(
      join(outboxDir, "r.json"),
      JSON.stringify({ react: { peer: "writer", messageId: "t1", key: "ok" } }),
    );
    const { monitor, routed, reactions } = makeMonitor();
    await monitor.tick();
    expect(reactions).toEqual([{ peer: "writer", messageId: "t1", key: "ok" }]);
    expect(routed).toEqual([]); // a reaction is not a message (§19.1)
    expect(readdirSync(outboxDir)).toEqual([]); // consumed
  });

  test("remove:true rides along; other flags do not", async () => {
    await writeFile(
      join(outboxDir, "r.json"),
      JSON.stringify({ react: { peer: "writer", messageId: "t1", key: "ok", remove: true } }),
    );
    const { monitor, reactions } = makeMonitor();
    await monitor.tick();
    expect(reactions[0]).toEqual({ peer: "writer", messageId: "t1", key: "ok", remove: true });
  });

  test("the hub's refusal comes back as the agent's own .rejected.json", async () => {
    await writeFile(
      join(outboxDir, "r.json"),
      JSON.stringify({ react: { peer: "writer", messageId: "ghost", key: "ok" } }),
    );
    const { monitor, warnings } = makeMonitor({ reactRefusal: "UNKNOWN_MESSAGE" });
    await monitor.tick();
    expect(existsSync(join(outboxDir, "r.rejected.json"))).toBe(true);
    expect(warnings[0]).toContain("UNKNOWN_MESSAGE");
  });

  test("mixing react with message fields is refused — a drop is one thing or the other", async () => {
    await writeFile(
      join(outboxDir, "mix.json"),
      JSON.stringify({
        to: "writer",
        payload: "hi",
        react: { peer: "writer", messageId: "t1", key: "ok" },
      }),
    );
    const { monitor, routed, reactions, warnings } = makeMonitor();
    await monitor.tick();
    await monitor.tick();
    await monitor.tick();
    expect(routed).toEqual([]);
    expect(reactions).toEqual([]);
    expect(existsSync(join(outboxDir, "mix.rejected.json"))).toBe(true);
    expect(warnings.some((w) => w.includes("either a message or a reaction"))).toBe(true);
  });

  test("a malformed react block names the field, like every other shape error", async () => {
    await writeFile(join(outboxDir, "bad.json"), JSON.stringify({ react: { peer: "writer" } }));
    const { monitor, warnings } = makeMonitor();
    await monitor.tick();
    await monitor.tick();
    await monitor.tick();
    expect(existsSync(join(outboxDir, "bad.rejected.json"))).toBe(true);
    expect(warnings.some((w) => w.includes('malformed "react.messageId"'))).toBe(true);
  });

  test("no reaction door wired ⇒ the drop is rejected, not silently dropped", async () => {
    await writeFile(
      join(outboxDir, "r.json"),
      JSON.stringify({ react: { peer: "writer", messageId: "t1", key: "ok" } }),
    );
    const { monitor, warnings } = makeMonitor({ noReactions: true });
    await monitor.tick();
    expect(existsSync(join(outboxDir, "r.rejected.json"))).toBe(true);
    expect(warnings[0]).toContain("reactions are not available");
  });
});
