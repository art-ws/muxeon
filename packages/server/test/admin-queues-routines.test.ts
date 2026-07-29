// Operator-plane queues + routines (T32, §8.5, FR-4/FR-23, NFR-9), end-to-end
// through bootstrap: queue mutations are submitted as control ops and executed by
// the session's own dispatcher loop (§10.8); routine CRUD edits the central MD
// files atomically; run-once fires outside the schedule without touching state.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Adapter, AdapterRegistry } from "@teamai/adapters";
import { type TeamaiServer, bootstrap } from "../src/bootstrap";

function dummyRegistry(): AdapterRegistry {
  const adapter: Adapter = {
    type: "dummy",
    render: (message) => String(message.payload),
    detect: { readyPrompt: /READY>\s*$/ },
    slashCommand: (name) => `/${name}`,
  };
  return new AdapterRegistry([adapter]);
}

let dir: string;
let server: TeamaiServer;
let agentUp: boolean;
let injectFails: boolean;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "teamai-admin2-"));
  agentUp = true;
  injectFails = false;
});

afterEach(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function boot(): Promise<void> {
  const configFile = join(dir, "teamai.config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      server: { port: 0, mcp: false, queueDir: "./queue" },
      agents: [
        { name: "researcher", type: "dummy", tmux: "researcher-s" },
        { name: "loner", type: "dummy", tmux: "loner-s" }, // no edge to researcher
      ],
      topology: { researcher: [] },
      channels: [],
    }),
  );
  server = await bootstrap({
    configFile,
    registry: dummyRegistry(),
    probe: async () => agentUp,
    makeDriver: () => ({
      inject: async () => {
        if (injectFails) throw new Error("inject boom");
      },
      awaitTurn: async () => undefined,
    }),
    startRoutines: false,
  });
}

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await server.adminFetch(
    new Request(`${server.adminUrl}${path}`, {
      method,
      ...(body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    }),
  );
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function routeSelf(id: string, payload: string): Promise<void> {
  const result = await server.router.route({
    id,
    from: "researcher",
    to: "researcher",
    kind: "message",
    ts: Date.now(),
    payload,
  });
  expect(result.ok).toBe(true);
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("timeout waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const pendingIds = async (name: string): Promise<string[]> => {
  const { json } = await call("GET", `/queues/${name}`);
  return (json.pending as { message: { id: string } }[]).map((e) => e.message.id);
};

describe("operator-plane: queue edits through the dispatcher (§8.5, §10.8)", () => {
  test("peek + cancel on a down agent's accumulating queue", async () => {
    agentUp = false; // queue accumulates (§5.1)
    await boot();
    await routeSelf("m1", "first");
    await routeSelf("m2", "second");
    expect(await pendingIds("researcher")).toEqual(["m1", "m2"]);

    const cancelled = await call("POST", "/queues/researcher/cancel", { id: "m1" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json).toEqual({ cancelled: true });
    expect(await pendingIds("researcher")).toEqual(["m2"]);
  });

  test("cancel of an unknown id → 404; unknown participant → 404", async () => {
    await boot();
    expect((await call("POST", "/queues/researcher/cancel", { id: "nope" })).status).toBe(404);
    expect((await call("GET", "/queues/ghost")).status).toBe(404);
  });

  test("requeue: failed → pending tail (same id) → processed → second requeue is a no-op", async () => {
    await boot();
    injectFails = true; // render/inject error → failed/ (FR-35b)
    await routeSelf("job-1", "do the thing");
    await waitFor(async () => {
      const { json } = await call("GET", "/queues/researcher");
      return (json.pending as unknown[]).length === 0 && (json.cur as unknown[]).length === 0;
    });

    injectFails = false;
    const requeued = await call("POST", "/queues/researcher/requeue", { id: "job-1" });
    expect(requeued.status).toBe(200);
    expect(requeued.json.outcome).toBe("requeued");

    // the dispatcher drains the requeued record to done/
    await waitFor(async () => {
      const { json } = await call("GET", "/queues/researcher");
      return (json.pending as unknown[]).length === 0 && (json.cur as unknown[]).length === 0;
    });

    const again = await call("POST", "/queues/researcher/requeue", { id: "job-1" });
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ outcome: "already-done" }); // explicit no-op (§8.5)

    expect((await call("POST", "/queues/researcher/requeue", { id: "ghost" })).status).toBe(404);
  });
});

const ROUTINE_MD = `---
id: nightly
schedule: once
enabled: true
---
Compile the nightly report.
`;

describe("operator-plane: routines CRUD + run-once (§8.5, FR-20/FR-23)", () => {
  test("put → list → get → disable → enable → delete round-trip", async () => {
    await boot();
    const put = await call("PUT", "/routines/researcher/nightly", { content: ROUTINE_MD });
    expect(put.status).toBe(200);

    const listed = await call("GET", "/routines");
    expect(listed.json.routines).toEqual([
      {
        id: "nightly",
        owner: "researcher",
        target: "researcher",
        schedule: "once",
        enabled: true,
        state: null,
      },
    ]);

    const got = await call("GET", "/routines/researcher/nightly");
    expect(got.json.body).toBe("Compile the nightly report.");

    expect((await call("POST", "/routines/researcher/nightly/disable")).json).toEqual({
      enabled: false,
    });
    const file = readFileSync(join(dir, "routines", "researcher", "nightly.md"), "utf8");
    expect(file).toContain("enabled: false"); // the kill-switch is IN the file (§6.2)
    expect((await call("POST", "/routines/researcher/nightly/enable")).json).toEqual({
      enabled: true,
    });

    expect((await call("DELETE", "/routines/researcher/nightly")).json).toEqual({ deleted: true });
    expect((await call("GET", "/routines")).json.routines as unknown[]).toHaveLength(0);
    expect((await call("GET", "/routines/researcher/nightly")).status).toBe(404);
  });

  test("put rejects a traversal id — the write stays under routines/<owner>/ (§8.7, T40)", async () => {
    await boot();
    // a frontmatter id matching the URL id, both attempting to escape the owner dir
    const evilId = "../escape";
    const evil = `---\nid: "${evilId}"\nschedule: once\n---\npwn\n`;
    const { status, json } = await call(
      "PUT",
      `/routines/researcher/${encodeURIComponent(evilId)}`,
      { content: evil },
    );
    expect(status).toBe(400);
    expect(json.code).toBe("BAD_ROUTINE");
    expect(existsSync(join(dir, "routines", "escape.md"))).toBe(false); // nothing escaped
    // dotted-but-safe ids still work
    const ok = await call("PUT", "/routines/researcher/v1.2-nightly", {
      content: "---\nid: v1.2-nightly\nschedule: once\n---\nok\n",
    });
    expect(ok.status).toBe(200);
  });

  test("put validations: unknown owner, malformed file, id mismatch", async () => {
    await boot();
    expect((await call("PUT", "/routines/ghost/nightly", { content: ROUTINE_MD })).status).toBe(
      400,
    );
    expect(
      (await call("PUT", "/routines/researcher/nightly", { content: "no frontmatter" })).status,
    ).toBe(400);
    const mismatched = await call("PUT", "/routines/researcher/other-id", { content: ROUTINE_MD });
    expect(mismatched.status).toBe(400);
    expect(mismatched.json.error).toContain('"nightly"');
  });

  test("run-once fires a DISABLED routine outside the schedule, without touching state", async () => {
    agentUp = false; // keep the signal visible in pending/
    await boot();
    const disabled = ROUTINE_MD.replace("enabled: true", "enabled: false");
    await call("PUT", "/routines/researcher/nightly", { content: disabled });

    const fired = await call("POST", "/routines/researcher/nightly/run-once");
    expect(fired.status).toBe(200);
    expect(fired.json.queued).toBe(true);
    expect(fired.json.target).toBe("researcher"); // from = owner, self target (§6.2)

    const { json } = await call("GET", "/queues/researcher");
    const pending = json.pending as { message: { from: string; payload: unknown } }[];
    expect(pending).toHaveLength(1);
    expect(pending[0]?.message.from).toBe("researcher");
    expect(pending[0]?.message.payload).toBe("Compile the nightly report.");

    // state untouched: done/lastRun unset (§8.5/§10.4 governs autoruns only)
    const got = await call("GET", "/routines/researcher/nightly");
    expect(got.json.state).toBeNull();
  });

  test("run-once with a cross-agent target without an edge → 403 (§10.2)", async () => {
    await boot();
    const cross = "---\nid: poke\nschedule: once\ntarget: loner\n---\npoke loner\n";
    await call("PUT", "/routines/researcher/poke", { content: cross });
    const fired = await call("POST", "/routines/researcher/poke/run-once");
    expect(fired.status).toBe(403);
    expect(fired.json.code).toBe("TOPOLOGY_DENIED");
  });
});
