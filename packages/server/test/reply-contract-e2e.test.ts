// Reply-contract selection e2e (§13.6, FR-156/FR-157, T261). Two claims:
//
//  1. WHICH contract the agent is instructed with follows the LIVE agent plane —
//     no config, no restart: the same agent gets the file contract while its MCP
//     client is away and the compact one-call form once it connects.
//  2. A `send` that answers the running turn ENDS it (the server removes the
//     message.json the file contract would have had the agent delete) and that
//     turn's file collection is suppressed — so an agent that hedges and writes
//     reply.md as well does NOT get its answer delivered twice (§10.29, the
//     failure T239 caught in production).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Session } from "@muxeon/core";
import type { SessionDriver } from "@muxeon/orchestrator";
import { type MuxeonServer, bootstrap } from "../src/bootstrap";
import { LOOPBACK_DIRECT, connectClient } from "./mcp-helpers";

let dir: string;
let server: MuxeonServer;
let client: Client | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muxeon-replyvia-"));
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Boot two agents on a real agent plane. `onResearcherInject` receives each
 * instruction injected into the researcher — the test plays the agent from there.
 * Output detection never fires for the researcher (like exchange-e2e): the turn
 * can only end by the message.json disappearing, so whether `send` really closed
 * the turn is observable and not masked by the output detector winning the race.
 */
async function boot(options: {
  replyVia?: "auto" | "exchange" | "mcp";
  onResearcherInject: (text: string) => void;
  writerInjected: string[];
}): Promise<string> {
  const configFile = join(dir, "muxeon.config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      server: { port: 0, mcp: true, queueDir: "./queue", cadence: { outputPollMs: 5 } },
      agents: [
        {
          name: "researcher",
          type: "claude",
          tmux: "researcher-s",
          ...(options.replyVia !== undefined ? { replyVia: options.replyVia } : {}),
        },
        { name: "writer", type: "claude", tmux: "writer-s" },
      ],
      topology: { researcher: ["writer"], writer: ["researcher"] },
    }),
  );
  const root = join(dir, "queue");
  await mkdir(root, { recursive: true });
  const makeDriver = (session: Session): SessionDriver => ({
    inject: async (text) => {
      if (session.name === "writer-s") options.writerInjected.push(text);
      else options.onResearcherInject(text);
    },
    awaitTurn: (_token, signal) =>
      session.name === "writer-s"
        ? Promise.resolve()
        : new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
  });
  server = await bootstrap({
    configFile,
    probe: async () => true,
    makeDriver,
    sessionControl: {
      hasSession: async () => true,
      newSession: async () => undefined,
      killSession: async () => undefined,
      sendLiteral: async () => undefined,
      sendKeys: async () => undefined,
      capturePane: async () => "",
    },
    startRoutines: false,
  });
  return root;
}

test.skipIf(!LOOPBACK_DIRECT)(
  "auto: the same agent gets the file contract without an MCP client and the compact one with it (FR-156)",
  async () => {
    const injected: string[] = [];
    const writerInjected: string[] = [];
    await boot({ onResearcherInject: (t) => injected.push(t), writerInjected });

    // 1) nobody connected — the universal contract, exactly as before.
    await server.router.route({
      id: "m1",
      from: "writer",
      to: "researcher",
      kind: "message",
      ts: 0,
      payload: "первое",
    });
    await waitFor(() => injected.length === 1);
    expect(injected[0]).toContain("FIRST write your answer into reply.md");
    expect(injected[0]).not.toContain("ENDS YOUR TURN");

    // close the turn so the next message can be claimed (|cur|≤1, §10.1)
    const inbox = join(dir, "queue", "researcher-s", "exchange", "inbox");
    await writeFile(join(inbox, "m1", "reply.md"), "ответ 1\n");
    rmSync(join(inbox, "m1", "message.json"));
    await waitFor(() => writerInjected.some((t) => t.includes("ответ 1")));

    // 2) the agent's MCP client connects — the NEXT injection switches form. No
    //    config change, no restart: the signal is the live session itself.
    client = await connectClient(server.agentPlane?.url ?? "", "researcher");
    await server.router.route({
      id: "m2",
      from: "writer",
      to: "researcher",
      kind: "message",
      ts: 0,
      payload: "второе",
    });
    await waitFor(() => injected.length === 2);
    expect(injected[1]).toContain('send(to="writer", replyTo="m2")');
    expect(injected[1]).toContain("ENDS YOUR TURN");
    expect(injected[1]).toContain("leave the message folder untouched");
    expect(injected[1]).not.toContain("reply.md"); // the other path is never named (T267)
    // the message file is still named — a long payload lives only there (§13.2)
    expect(injected[1]).toContain("full message:");
    // and the compact form is the cheaper one to follow
    expect(injected[1]?.length).toBeLessThan(injected[0]?.length ?? 0);
  },
  10000,
);

test.skipIf(!LOOPBACK_DIRECT)(
  "send answers AND ends the turn; a hedged reply.md is not delivered twice (FR-157, §10.29)",
  async () => {
    const injected: string[] = [];
    const writerInjected: string[] = [];
    const root = await boot({
      replyVia: "mcp",
      onResearcherInject: (t) => injected.push(t),
      writerInjected,
    });
    client = await connectClient(server.agentPlane?.url ?? "", "researcher");

    await server.router.route({
      id: "m1",
      from: "writer",
      to: "researcher",
      kind: "message",
      ts: 0,
      payload: "вопрос",
    });
    await waitFor(() => injected.length === 1);
    const msgDir = join(root, "researcher-s", "exchange", "inbox", "m1");
    expect(existsSync(join(msgDir, "message.json"))).toBe(true);

    // The agent hedges: it writes reply.md (which the compact contract forbids)
    // and ALSO calls send — the exact shape of the T239 double delivery.
    await writeFile(join(msgDir, "reply.md"), "ответ через файл\n");
    const receipt = await client.callTool({
      name: "send",
      arguments: { to: "writer", payload: "ответ через MCP", replyTo: "m1", id: "r1" },
    });
    expect(
      (receipt as { structuredContent?: { turnClosed?: boolean } }).structuredContent?.turnClosed,
    ).toBe(true);

    // the turn ended through file-detect — the server deleted the signal file
    expect(existsSync(join(msgDir, "message.json"))).toBe(false);
    await waitFor(() => server.agents.get("researcher")?.state.status === "idle");
    // …and the dir is cleaned: nothing in it is owed a collection any more
    await waitFor(() => !existsSync(msgDir));

    // EXACTLY ONE answer reached the writer, and it is the one that was sent.
    await waitFor(() => writerInjected.some((t) => t.includes("ответ через MCP")));
    // give the (suppressed) file path every chance to fire late before asserting
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(writerInjected.filter((t) => t.includes("ответ через"))).toHaveLength(1);
    expect(writerInjected.some((t) => t.includes("ответ через файл"))).toBe(false);
  },
  10000,
);

test.skipIf(!LOOPBACK_DIRECT)(
  "replyVia exchange pins an agent to the file contract even with a live MCP session (FR-156)",
  async () => {
    const injected: string[] = [];
    const writerInjected: string[] = [];
    const root = await boot({
      replyVia: "exchange",
      onResearcherInject: (t) => injected.push(t),
      writerInjected,
    });
    client = await connectClient(server.agentPlane?.url ?? "", "researcher");

    await server.router.route({
      id: "m1",
      from: "writer",
      to: "researcher",
      kind: "message",
      ts: 0,
      payload: "вопрос",
    });
    await waitFor(() => injected.length === 1);
    // The pin wins over the live signal: this is the operator's escape hatch for
    // an agent whose shim they do not trust to survive a whole turn.
    expect(injected[0]).toContain("FIRST write your answer into reply.md");
    expect(injected[0]).not.toContain("ENDS YOUR TURN");

    // and the file path still works end to end for that agent
    const msgDir = join(root, "researcher-s", "exchange", "inbox", "m1");
    await writeFile(join(msgDir, "reply.md"), "файловый ответ\n");
    rmSync(join(msgDir, "message.json"));
    await waitFor(() => writerInjected.some((t) => t.includes("файловый ответ")));
  },
  10000,
);

test.skipIf(!LOOPBACK_DIRECT)(
  "a send REFUSED by the router leaves the turn open (FR-157)",
  async () => {
    const injected: string[] = [];
    const writerInjected: string[] = [];
    const root = await boot({
      replyVia: "mcp",
      onResearcherInject: (t) => injected.push(t),
      writerInjected,
    });
    client = await connectClient(server.agentPlane?.url ?? "", "researcher");

    await server.router.route({
      id: "m1",
      from: "writer",
      to: "researcher",
      kind: "message",
      ts: 0,
      payload: "вопрос",
    });
    await waitFor(() => injected.length === 1);
    const msgDir = join(root, "researcher-s", "exchange", "inbox", "m1");

    // No edge researcher→ghost: the router refuses BEFORE any delivery. Closing
    // the turn here would strand the answer — the agent must keep the floor.
    const refused = await client.callTool({
      name: "send",
      arguments: { to: "ghost", payload: "куда-то", replyTo: "m1", id: "r1" },
    });
    expect(refused.isError).toBe(true);
    expect(existsSync(join(msgDir, "message.json"))).toBe(true);
    expect(server.agents.get("researcher")?.state.status).toBe("busy");

    // the agent recovers by answering the real sender — that closes the turn
    await client.callTool({
      name: "send",
      arguments: { to: "writer", payload: "ответ", replyTo: "m1", id: "r2" },
    });
    await waitFor(() => !existsSync(join(msgDir, "message.json")));
    await waitFor(() => writerInjected.some((t) => t.includes("ответ")));
  },
  10000,
);
