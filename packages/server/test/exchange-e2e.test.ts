// Exchange e2e (FR-56, §13, Checkpoint 15): a CONSOLE-ONLY agent — no MCP, no
// native hook, an output detector that never fires — completes the full cycle
// purely through files: receives the instruction, writes reply.md + an artifact,
// deletes message.json (file-detect ends the turn), the reply routes back with
// the artifact as a §12.5 blob ref; then the agent INITIATES via outbox/.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@muxeon/core";
import type { SessionDriver } from "@muxeon/orchestrator";
import { type MuxeonServer, bootstrap } from "../src/bootstrap";

let dir: string;
let server: MuxeonServer;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muxeon-xe2e-"));
});

afterEach(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("full no-MCP cycle: instruction → file reply + artifact → file-detect → routed back; then outbox initiative (FR-52..56)", async () => {
  const configFile = join(dir, "muxeon.config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      server: {
        port: 0,
        mcp: false,
        queueDir: "./queue",
        cadence: { outputPollMs: 5, outboxPollMs: 20 },
      },
      agents: [
        { name: "researcher", type: "claude", tmux: "researcher-s" },
        { name: "writer", type: "claude", tmux: "writer-s" },
      ],
      topology: { researcher: ["writer"], writer: ["researcher"] },
    }),
  );
  const root = join(dir, "queue");
  await mkdir(root, { recursive: true });

  // The "console-only agent": reacts to the injected INSTRUCTION alone — reads
  // the message file path out of it, answers with files, deletes message.json.
  const writerInjected: string[] = [];
  const makeDriver = (session: Session): SessionDriver => ({
    inject: async (text) => {
      if (session.name === "writer-s") {
        writerInjected.push(text);
        return;
      }
      const file = text.match(/full message: (\S+)/)?.[1];
      if (file === undefined) throw new Error(`no message file in instruction:\n${text}`);
      // act asynchronously, like a real agent typing after the prompt
      setTimeout(async () => {
        const msgDir = join(file, "..");
        const message = JSON.parse(await readFile(file, "utf8"));
        await writeFile(join(msgDir, "reply.md"), `готово: ${message.payload}\n`);
        await writeFile(join(msgDir, "report.txt"), "report-bytes");
        await rm(file); // the done signal (FR-53)
      }, 20);
    },
    // output detection NEVER fires for the researcher — file-detect must carry
    // the turn; the writer side completes instantly (it is just a sink here).
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
    makeDriver: (session) => makeDriver(session),
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

  // 1) writer → researcher; the researcher answers ONLY through files.
  const result = await server.router.route({
    id: "m1",
    from: "writer",
    to: "researcher",
    kind: "message",
    ts: 0,
    payload: "отчёт по проекту",
  });
  expect(result.ok).toBe(true);

  // the reply (id m1:reply) is delivered INTO the writer session
  await waitFor(() => writerInjected.some((text) => text.includes("готово: отчёт по проекту")));
  const reply = writerInjected.find((text) => text.includes("готово: отчёт по проекту"));
  expect(reply).toContain("from=researcher");
  expect(reply).toContain("[attachment] report.txt (text/plain)"); // the artifact rode along
  // the artifact bytes are real blobs under <root>/blobs/
  const blobId = reply?.match(/report\.txt \(text\/plain\) → (\S+)/)?.[1];
  expect(blobId).toBeDefined();
  expect(await readFile(join(root, "blobs", String(blobId).split("/").pop() ?? ""), "utf8")).toBe(
    "report-bytes",
  );
  // the turn's inbox dir was cleaned up after collection (§13.3)
  await waitFor(() => !existsSync(join(root, "researcher-s", "exchange", "inbox", "m1")));

  // 2) initiative WITHOUT MCP (FR-55): the researcher drops a file into outbox/.
  await mkdir(join(root, "researcher-s", "exchange", "outbox"), { recursive: true });
  await writeFile(
    join(root, "researcher-s", "exchange", "outbox", "ping.json"),
    JSON.stringify({ to: "writer", payload: "инициатива без MCP" }),
  );
  await waitFor(() => writerInjected.some((text) => text.includes("инициатива без MCP")));
  const initiative = writerInjected.find((text) => text.includes("инициатива без MCP"));
  expect(initiative).toContain("from=researcher"); // identity = folder ownership
  // consumed exactly once
  expect(existsSync(join(root, "researcher-s", "exchange", "outbox", "ping.json"))).toBe(false);
}, 10000);

test("contract-order violation (T75): early deletion ends the turn but does NOT destroy the dir", async () => {
  const configFile = join(dir, "muxeon.config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      server: { port: 0, mcp: false, queueDir: "./queue", cadence: { outputPollMs: 5 } },
      agents: [
        { name: "researcher", type: "claude", tmux: "researcher-s" },
        { name: "writer", type: "claude", tmux: "writer-s" },
      ],
      topology: { researcher: ["writer"], writer: ["researcher"] },
    }),
  );
  const root = join(dir, "queue");
  await mkdir(root, { recursive: true });

  // A misbehaving agent: deletes message.json FIRST (ending the turn), then
  // keeps working — writes reply.md into the already-finished turn's dir.
  const makeDriver = (session: Session): SessionDriver => ({
    inject: async (text) => {
      if (session.name !== "researcher-s") return;
      const file = text.match(/full message: (\S+)/)?.[1];
      if (file === undefined) throw new Error("no message file in instruction");
      setTimeout(async () => {
        await rm(file); // the violation: deletion before the reply
        await new Promise((resolve) => setTimeout(resolve, 50));
        await writeFile(join(file, "..", "reply.md"), "опоздавший ответ\n");
      }, 10);
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
    makeDriver: (session) => makeDriver(session),
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

  await server.router.route({
    id: "m1",
    from: "writer",
    to: "researcher",
    kind: "message",
    ts: 0,
    payload: "задание",
  });
  // the turn ends by file-detect with an EMPTY collection
  await waitFor(() => server.status("researcher") === "idle");
  // ...and the late reply lands AFTER the turn
  const msgDir = join(root, "researcher-s", "exchange", "inbox", "m1");
  await waitFor(() => existsSync(join(msgDir, "reply.md")));
  await new Promise((resolve) => setTimeout(resolve, 50)); // let any (wrong) cleanup race land
  // T75: the dir SURVIVES — the empty collection leaves it to the orphan sweep,
  // so the late file is inspectable instead of silently destroyed.
  expect(existsSync(join(msgDir, "reply.md"))).toBe(true);
}, 10000);

// §13.7 / FR-180 end to end: a receipt is delivered as a NOTICE — the receiver
// reads it, is told no answer is expected, and gets no folder to answer in. The
// window/scrape half of the guard is unit-covered (nudge.test.ts): this harness
// drives no real pane, so a scrape assertion here would be vacuous.
test("a receipt is a notice: no folder and no contract named (§13.7, FR-180)", async () => {
  const configFile = join(dir, "muxeon.config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      server: { port: 0, mcp: false, queueDir: "./queue", cadence: { outputPollMs: 5 } },
      agents: [
        { name: "researcher", type: "claude", tmux: "researcher-s" },
        { name: "writer", type: "claude", tmux: "writer-s" },
      ],
      topology: { researcher: ["writer"], writer: ["researcher"] },
    }),
  );
  const root = join(dir, "queue");
  await mkdir(root, { recursive: true });

  const injected: Record<string, string[]> = { "researcher-s": [], "writer-s": [] };
  const makeDriver = (session: Session): SessionDriver => ({
    inject: async (text) => {
      injected[session.name]?.push(text);
    },
    awaitTurn: async () => undefined, // the turn ends by output detection
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

  const result = await server.router.route({
    id: "ack-1",
    from: "writer",
    to: "researcher",
    kind: "message",
    ts: 0,
    payload: "принято, ветка закрыта",
    expectsReply: false,
  });
  expect(result.ok).toBe(true);

  await waitFor(() => injected["researcher-s"]?.some((t) => t.includes("принято")) ?? false);
  const notice = injected["researcher-s"]?.find((t) => t.includes("принято"));
  expect(notice).toContain("no reply is expected");
  expect(notice).not.toContain("reply contract");
  expect(notice).not.toContain("message.json"); // no path is named, not even to forbid it
  // Nothing was materialized: there is no folder because there is no answer to collect.
  expect(existsSync(join(root, "researcher-s", "exchange", "inbox", "ack-1"))).toBe(false);
  // The sender is not injected anything in return here either — but that is the
  // harness (no pane to scrape), not the proof; the proof is in nudge.test.ts.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(injected["writer-s"]).toEqual([]);
}, 10000);

// §19.13 / FR-181 end to end, through the WIRING: an agent marks a peer agent's
// message from its outbox (decision Q2 — no agent-plane session anywhere here), the
// journal carries the record, the sidecar lands under the pair's own root, and the
// peer reads one notice that asks for nothing.
test("an agent reacts to a peer agent from its outbox (§19.13, FR-181)", async () => {
  const configFile = join(dir, "muxeon.config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      server: {
        port: 0,
        mcp: false,
        queueDir: "./queue",
        cadence: { outputPollMs: 5, outboxPollMs: 20 },
      },
      agents: [
        { name: "researcher", type: "claude", tmux: "researcher-s" },
        { name: "writer", type: "claude", tmux: "writer-s" },
      ],
      topology: { researcher: ["writer"], writer: ["researcher"] },
      reactions: {
        categories: [{ name: "feedback", title: "Отклик" }],
        items: [
          {
            key: "ok",
            emoji: "👍",
            label: "Принято",
            category: "feedback",
            // Written in the operator's voice — and therefore NOT put in a peer's
            // mouth: the notice below must carry the head line alone.
            agentMessage: "Оператор отметил это сообщение как принятое.",
          },
        ],
      },
    }),
  );
  const root = join(dir, "queue");
  await mkdir(root, { recursive: true });

  const injected: Record<string, string[]> = { "researcher-s": [], "writer-s": [] };
  const makeDriver = (session: Session): SessionDriver => ({
    inject: async (text) => {
      injected[session.name]?.push(text);
    },
    awaitTurn: async () => undefined,
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

  // 1) a real message on the pair — the journal is the carrier, so it must exist
  //    before anything can be marked.
  expect(
    (
      await server.router.route({
        id: "w1",
        from: "writer",
        to: "researcher",
        kind: "message",
        ts: 0,
        payload: "черновик на проверку",
      })
    ).ok,
  ).toBe(true);
  await waitFor(() => injected["researcher-s"]?.some((t) => t.includes("черновик")) ?? false);

  // 2) the receipt: a reaction dropped into the outbox, no MCP anywhere.
  await mkdir(join(root, "researcher-s", "exchange", "outbox"), { recursive: true });
  await writeFile(
    join(root, "researcher-s", "exchange", "outbox", "react.json"),
    JSON.stringify({ react: { peer: "writer", messageId: "w1", key: "ok" } }),
  );

  await waitFor(() => injected["writer-s"]?.some((t) => t.includes("[muxeon reaction]")) ?? false);
  const notice = injected["writer-s"]?.find((t) => t.includes("[muxeon reaction]")) ?? "";
  expect(notice).toContain("👍 Принято from researcher on your message w1");
  expect(notice).toContain("no reply is expected"); // always a notice between agents
  expect(notice).not.toContain("Оператор отметил"); // the operator's voice stays theirs
  expect(notice).not.toContain("reply contract");

  // 3) the sidecar sits under the pair's own root, ONE file, canonical order.
  await waitFor(() => existsSync(join(dir, "reactions", "agents", "researcher", "writer.jsonl")));
  const events = readFileSync(
    join(dir, "reactions", "agents", "researcher", "writer.jsonl"),
    "utf8",
  ).trim();
  expect(JSON.parse(events)).toMatchObject({
    op: "add",
    message: "w1",
    actor: "researcher",
    key: "ok",
    emoji: "👍",
  });
  expect(existsSync(join(root, "researcher-s", "exchange", "outbox", "react.json"))).toBe(false);
}, 10000);
