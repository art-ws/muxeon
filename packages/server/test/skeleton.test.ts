import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Adapter, AdapterRegistry } from "@teamai/adapters";
import { capturePane, hasTmux, killSession, newSession } from "@teamai/tmux";
import { bootstrap } from "../src/bootstrap";

const HAS_TMUX = await hasTmux();
const dummyPath = join(import.meta.dir, "dummy-output-agent.ts");

// A single-line render keeps one message → one input line (the dummy is line-based).
function dummyRegistry(): AdapterRegistry {
  const adapter: Adapter = {
    type: "dummy",
    render: (message) => `[teamai id=${message.id}] ${String(message.payload)}`,
    detect: { readyPrompt: /SKELETON_READY>\s*$/ },
    slashCommand: (name) => `/${name}`,
  };
  return new AdapterRegistry([adapter]);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("timeout waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(!HAS_TMUX)("walking skeleton end-to-end (Checkpoint 4) [requires tmux]", () => {
  let dir: string;
  let session: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teamai-skeleton-"));
    session = `teamai-skeleton-${randomUUID()}`;
  });

  afterEach(async () => {
    await killSession(session).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  test("config → attach → route → inject → detect idle → done", async () => {
    // a real dummy agent in tmux
    await newSession(session, { command: ["bun", dummyPath] });
    await waitFor(async () => /SKELETON_READY>/.test(await capturePane(session))); // agent ready

    const configFile = join(dir, "teamai.config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        server: { port: 0, queueDir: "./queue", mcp: false }, // queue path only; port 0 beside a live stand
        agents: [{ name: "dummy", type: "dummy", tmux: session }],
        topology: {},
      }),
    );

    const server = await bootstrap({ configFile, registry: dummyRegistry() });
    try {
      expect(server.status("dummy")).toBe("idle"); // attached to the live session

      // route a self-message to the agent (self-delivery needs no edge, §10.2)
      const result = await server.router.route({
        id: "skeleton-1",
        from: "dummy",
        to: "dummy",
        kind: "message",
        ts: 0,
        payload: "hello skeleton",
      });
      expect(result.ok).toBe(true);

      // the running dispatcher injects, detects idle by the output front, and completes
      const donePath = join(dir, "queue", session, "done");
      await waitFor(() => readdirSync(donePath).some((name) => name.endsWith(".json")));
      expect(readdirSync(donePath).filter((name) => name.endsWith(".json"))).toHaveLength(1);

      // and the message actually reached the agent's pane
      expect(await capturePane(session)).toContain("hello skeleton");
    } finally {
      await server.stop();
    }
  });
});
