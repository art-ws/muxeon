// Federation end-to-end (§18, FR-137…FR-146, FR-149/FR-150): REAL servers on
// loopback ports — visibility with status projections, FQN delivery with the
// stamped `from` (§10.24), receipts (ok and refusals) travelling back, the
// reply-correlation return path (§18.10-3), store-and-forward across a dead
// link (§10.25), `unknown` statuses (§10.27) and a three-server transit chain
// (FR-141). Gated on loopback-direct like the other network tests.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionDriver } from "@teamai/orchestrator";
import { readMessage } from "@teamai/queue";
import { type TeamaiServer, bootstrap } from "../src/bootstrap";
import { LOOPBACK_DIRECT, connectClient } from "./mcp-helpers";

const noopDriver = (): SessionDriver => ({
  inject: async () => undefined,
  awaitTurn: async () => undefined,
});

const ENV: Record<string, string> = {
  FED_TOKEN_A: "token-issued-to-a",
  FED_TOKEN_C: "token-issued-to-b-for-c",
};

async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not reached in time");
}

/** A free loopback port — grabbed and released; racy in principle, fine in tests. */
async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port as number;
  await server.stop(true);
  return port;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

async function readOne(dir: string): Promise<Record<string, unknown> | null> {
  const [file] = listDir(dir).sort();
  if (file === undefined) return null;
  return (await readMessage(join(dir, file))) as unknown as Record<string, unknown>;
}

function structured(result: unknown): Record<string, unknown> {
  return ((result as { structuredContent?: unknown }).structuredContent ?? {}) as Record<
    string,
    unknown
  >;
}

describe.skipIf(!LOOPBACK_DIRECT)("§18 federation end-to-end", () => {
  const dirs: string[] = [];
  const servers: TeamaiServer[] = [];

  beforeEach(() => {
    dirs.length = 0;
    servers.length = 0;
  });

  afterEach(async () => {
    for (const server of servers.reverse()) await server.stop();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  async function boot(config: unknown, dir?: string): Promise<TeamaiServer> {
    const home = dir ?? mkdtempSync(join(tmpdir(), "teamai-fed-"));
    if (dir === undefined) dirs.push(home);
    writeFileSync(join(home, "teamai.config.json"), JSON.stringify(config));
    const server = await bootstrap({
      configFile: join(home, "teamai.config.json"),
      probe: async () => false, // every agent down: queues accumulate, nothing injects
      makeDriver: noopDriver,
      autoStart: true,
      env: (name) => ENV[name],
    });
    servers.push(server);
    return server;
  }

  /** Exporter B: agents dev (exported) + sec (NOT exported), user kim (exported). */
  const exporterConfig = (port: number, extra: Record<string, unknown> = {}) => ({
    server: { port: 0, mcp: false, queueDir: "./queue" },
    agents: [
      { name: "dev", type: "claude", tmux: "b-dev", exported: true },
      { name: "sec", type: "claude", tmux: "b-sec" },
    ],
    users: [{ name: "kim", exported: true }],
    topology: {},
    channels: [],
    federation: {
      port,
      statusDebounceMs: 50,
      accept: [{ name: "hq", token: { $env: "FED_TOKEN_A" } }],
    },
    ...extra,
  });

  /** Importer A: agent alex with an edge on the import node "b". */
  const importerConfig = (bPort: number) => ({
    server: { port: 0, mcp: true, queueDir: "./queue" },
    agents: [{ name: "alex", type: "claude", tmux: "a-alex" }],
    topology: { alex: ["b"] },
    channels: [],
    imports: [{ name: "b", url: `http://127.0.0.1:${bPort}`, token: { $env: "FED_TOKEN_A" } }],
  });

  test("visibility + projections + MCP surfaces (F2, FR-140/FR-149/FR-150)", async () => {
    const bPort = await freePort();
    await boot(exporterConfig(bPort));
    const a = await boot(importerConfig(bPort));

    // The registry learns B's export surface: dev (agent) and kim (user) — and
    // NEVER the unexported sec (§10.24: invisible even by enumeration).
    await waitFor(() => a.federation?.registry.peersOf("b").length === 2);
    const peers = a.federation?.registry.peersOf("b") ?? [];
    expect(peers.map((peer) => peer.name)).toEqual(["dev@b", "kim@b"]);
    const dev = peers.find((peer) => peer.name === "dev@b");
    expect(dev).toMatchObject({ type: "agent", server: "b", link: "up", status: "down" });
    const kim = peers.find((peer) => peer.name === "kim@b");
    expect(kim).toMatchObject({ type: "user", presence: "offline" });

    // MCP list_peers (FR-150): alex (edge on "b") sees the FQN peers beside locals.
    const client = await connectClient(a.agentPlane?.url ?? "", "alex");
    try {
      const listed = structured(await client.callTool({ name: "list_peers", arguments: {} }));
      const rows = listed.peers as { name: string; server?: string; link?: string }[];
      expect(rows.find((row) => row.name === "dev@b")).toMatchObject({
        server: "b",
        link: "up",
        status: "down",
      });
      // get_status: an agent's cached projection; a user is NOT_STATUSABLE as locally.
      const status = structured(
        await client.callTool({ name: "get_status", arguments: { name: "dev@b" } }),
      );
      expect(status).toMatchObject({ status: "down", paused: false });
      const user = structured(
        await client.callTool({ name: "get_status", arguments: { name: "kim@b" } }),
      );
      expect(user).toMatchObject({ error: "NOT_STATUSABLE" });
    } finally {
      await client.close();
    }
  });

  test("delivery + stamped from + ok receipt + correlated reply (F3, FR-141…FR-143)", async () => {
    const bPort = await freePort();
    const b = await boot(exporterConfig(bPort));
    const a = await boot(importerConfig(bPort));
    await waitFor(() => a.federation?.registry.linkState("b") === "up");

    // alex → dev@b: authorized by the edge on the server node (§18.10-6).
    const result = await a.router.route({
      id: "m1",
      from: "alex",
      to: "dev@b",
      kind: "message",
      ts: Date.now(),
      payload: "hello over the link",
    });
    expect(result).toMatchObject({ ok: true, key: "b" });

    // It lands in B's dev queue with the RECEIVING side's suffix on from (§10.24).
    const bQueue = join(dirs[0] ?? "", "queue", "b-dev", "pending");
    await waitFor(() => listDir(bQueue).length === 1);
    const delivered = await readOne(bQueue);
    expect(delivered).toMatchObject({ from: "alex@hq", to: "dev", payload: "hello over the link" });

    // The transfer completed on A (ack → done), and the ok receipt came back silently.
    const aLinkDone = join(dirs[1] ?? "", "queue", "fed", "b", "done");
    await waitFor(() => listDir(aLinkDone).length >= 1);

    // dev replies to the stamped FQN with replyTo — no edge on "hq" exists, so this
    // exercises the reply-correlation path over the journal (§18.10-3).
    const reply = await b.router.route({
      id: "r1",
      from: "dev",
      to: "alex@hq",
      kind: "message",
      ts: Date.now(),
      replyTo: "m1",
      payload: "done",
    });
    expect(reply).toMatchObject({ ok: true, key: "hq" });
    const aQueue = join(dirs[1] ?? "", "queue", "a-alex", "pending");
    await waitFor(() => listDir(aQueue).length === 1);
    expect(await readOne(aQueue)).toMatchObject({ from: "dev@b", to: "alex", replyTo: "m1" });

    // ...while an uncorrelated initiative from the exporter is refused (§18.10-3).
    const cold = await b.router.route({
      id: "r2",
      from: "dev",
      to: "alex@hq",
      kind: "message",
      ts: Date.now(),
      payload: "uninvited",
    });
    expect(cold).toMatchObject({ ok: false, code: "TOPOLOGY_DENIED" });
  });

  test("refusals travel back as [federation] notices (FR-142/FR-143)", async () => {
    const bPort = await freePort();
    const b = await boot(exporterConfig(bPort));
    const a = await boot(importerConfig(bPort));
    await waitFor(() => a.federation?.registry.linkState("b") === "up");

    // Pause dev on B (§16) — the owner's gate refuses at ingress (§10.19).
    const paused = await b.adminFetch(
      new Request("http://admin/admin/agents/dev/pause", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paused: true }),
      }),
    );
    expect(paused.status).toBe(200);

    await a.router.route({
      id: "m-paused",
      from: "alex",
      to: "dev@b",
      kind: "message",
      ts: Date.now(),
      payload: "into the wall",
    });
    // The AGENT_PAUSED receipt becomes a notice in alex's own queue, replyTo-linked.
    const aQueue = join(dirs[1] ?? "", "queue", "a-alex", "pending");
    await waitFor(() => listDir(aQueue).length === 1);
    const notice = await readOne(aQueue);
    expect(notice).toMatchObject({ from: "dev@b", to: "alex", replyTo: "m-paused" });
    expect(String(notice?.payload)).toContain("AGENT_PAUSED");

    // An unexported actor does not exist to the link (§10.24) — UNKNOWN_ACTOR.
    await a.router.route({
      id: "m-sec",
      from: "alex",
      to: "sec@b",
      kind: "message",
      ts: Date.now(),
      payload: "probe",
    });
    await waitFor(() => listDir(aQueue).length === 2);
    const probeNotice = (await Promise.all(
      listDir(aQueue)
        .sort()
        .map((file) => readMessage(join(aQueue, file))),
    )) as unknown as { replyTo?: string; payload?: unknown }[];
    const secNotice = probeNotice.find((record) => record.replyTo === "m-sec");
    expect(String(secNotice?.payload)).toContain("UNKNOWN_ACTOR");
    // ...and B's sec queue never saw anything.
    expect(listDir(join(dirs[0] ?? "", "queue", "b-sec", "pending"))).toHaveLength(0);
  });

  test("store-and-forward across a dead link; statuses go unknown (§10.25/§10.27)", async () => {
    const bPort = await freePort();
    const bDir = mkdtempSync(join(tmpdir(), "teamai-fed-b-"));
    dirs.push(bDir);
    let b = await boot(exporterConfig(bPort), bDir);
    const a = await boot(importerConfig(bPort));
    await waitFor(() => a.federation?.registry.linkState("b") === "up");

    // Kill B: the link dies — the cache dies with it (§10.27): unknown, link-down.
    await b.stop();
    servers.splice(servers.indexOf(b), 1);
    await waitFor(() => a.federation?.registry.linkState("b") === "down");
    const dark = a.federation?.registry.get("dev@b");
    expect(dark).toMatchObject({ link: "down", status: "unknown", reason: "link-down" });

    // Route while the link is down: the queue accumulates, nothing is lost (§10.25).
    const result = await a.router.route({
      id: "m-offline",
      from: "alex",
      to: "dev@b",
      kind: "message",
      ts: Date.now(),
      payload: "catch you later",
    });
    expect(result).toMatchObject({ ok: true });

    // B returns on the SAME port: the client reconnects, the queue drains,
    // the projection comes back — a real value again, not a stale memory.
    b = await boot(exporterConfig(bPort), bDir);
    const bQueue = join(bDir, "queue", "b-dev", "pending");
    await waitFor(() => listDir(bQueue).length === 1, 15000);
    expect(await readOne(bQueue)).toMatchObject({ from: "alex@hq", payload: "catch you later" });
    await waitFor(() => a.federation?.registry.get("dev@b")?.status === "down", 15000);
  });

  test("transit chain: names suffix per hop, statuses re-emit, unknown propagates (F4)", async () => {
    // C (exports bob) ← B (imports c, transit; exports dev) ← A (imports b).
    const cPort = await freePort();
    const bPort = await freePort();
    const cDir = mkdtempSync(join(tmpdir(), "teamai-fed-c-"));
    dirs.push(cDir);
    const c = await boot(
      {
        server: { port: 0, mcp: false, queueDir: "./queue" },
        agents: [{ name: "bob", type: "claude", tmux: "c-bob", exported: true }],
        topology: {},
        channels: [],
        federation: {
          port: cPort,
          statusDebounceMs: 50,
          accept: [{ name: "b2", token: { $env: "FED_TOKEN_C" } }],
        },
      },
      cDir,
    );
    await boot(
      exporterConfig(bPort, {
        imports: [{ name: "c", url: `http://127.0.0.1:${cPort}`, token: { $env: "FED_TOKEN_C" } }],
      }),
    );
    const a = await boot(importerConfig(bPort));

    // A sees B's own actors AND the transit re-export with the composed suffix.
    await waitFor(() =>
      (a.federation?.registry.peersOf("b") ?? []).some((peer) => peer.name === "bob@c@b"),
    );
    const bob = a.federation?.registry.get("bob@c@b");
    expect(bob).toMatchObject({ type: "agent", server: "b", status: "down" });

    // Delivery down the chain: two hops, each stamping its own suffix on `from`.
    await a.router.route({
      id: "t1",
      from: "alex",
      to: "bob@c@b",
      kind: "message",
      ts: Date.now(),
      payload: "down the chain",
    });
    const cQueue = join(cDir, "queue", "c-bob", "pending");
    await waitFor(() => listDir(cQueue).length === 1, 15000);
    expect(await readOne(cQueue)).toMatchObject({ from: "alex@hq@b2", to: "bob" });

    // Kill C: the WHOLE branch behind the dead hop reads unknown at A (§18.4) —
    // B re-emits `unknown`, never the last known value as current.
    await c.stop();
    servers.splice(servers.indexOf(c), 1);
    await waitFor(() => a.federation?.registry.get("bob@c@b")?.status === "unknown", 15000);
    // ...while B's own actors keep their live projection.
    expect(a.federation?.registry.get("dev@b")?.status).toBe("down");
  });
});
