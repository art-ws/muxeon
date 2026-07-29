import { describe, expect, test } from "bun:test";
import { Topology } from "@teamai/core";
import { Router } from "@teamai/orchestrator";
import { AGENT_TOOLS, AGENT_TOOL_NAMES, createAgentServer, startAgentPlane } from "../src/mcp";
import { LOOPBACK_DIRECT, connectClient } from "./mcp-helpers";

// The exact agent-plane set (§8.1/§8.6): the five read/route tools plus two
// ACL-gated bridges — the command pair (FR-94/FR-95, a peer's slash commands) and
// the session pair (FR-96/FR-97, a peer's session lifecycle). Both fire ONLY through
// their ACL (commandGrants / sessionGrants) + a topology edge — not an UNGATED
// operator capability.
const NINE = [
  "control_session",
  "get_history",
  "get_status",
  "list_commands",
  "list_controls",
  "list_peers",
  "send",
  "send_command",
  "whoami",
];

// A representative sample of operator-plane capabilities (§8.5): lifecycle, queue
// edits, routine CRUD, channels. NONE may appear in the agent surface (§10.10) —
// agent→agent slash commands (send_command) are the one bridge, and they are
// ACL-gated, not free lifecycle/queue/routine/channel access.
const OPERATOR_CAPABILITIES = [
  "provision",
  "kill",
  "restart",
  "peek",
  "cancel",
  "requeue",
  "queue_peek",
  "routine_put",
  "routine_delete",
  "enable",
  "disable",
  "run_once",
  "channel_list",
  "channel_status",
];

describe("plane isolation — agent-plane is exactly the nine tools, no ungated operator tools (§10.10)", () => {
  test("the static tool set is exactly the nine least-privilege tools (§8.1)", () => {
    const names: string[] = [...AGENT_TOOL_NAMES];
    expect(names.sort()).toEqual(NINE);
    expect(AGENT_TOOLS.map((t) => t.name).sort()).toEqual(NINE); // descriptors match the names
  });

  test("no operator capability is present in the agent surface (§10.10)", () => {
    const names = new Set(AGENT_TOOLS.map((t) => t.name));
    for (const capability of OPERATOR_CAPABILITIES) expect(names.has(capability)).toBe(false);
  });

  describe.skipIf(!LOOPBACK_DIRECT)("over the wire", () => {
    test("a connected client's tools/list returns exactly the nine", async () => {
      const topology = new Topology({ a: ["b"], b: ["a"] });
      const router = new Router({ topology, root: "/tmp/teamai-unused", queueKeyOf: () => null });
      const plane = startAgentPlane({
        port: 0,
        isKnownIdentity: (n) => n === "a" || n === "b",
        makeServer: (caller) =>
          createAgentServer(caller, { topology, router, peerStatus: () => "idle" }),
      });
      try {
        const client = await connectClient(plane.url, "a");
        expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(NINE);
        await client.close();
      } finally {
        await plane.stop();
      }
    });
  });
});
