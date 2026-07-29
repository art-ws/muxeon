import { afterEach, describe, expect, test } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type AgentPlaneHandle, startAgentPlane } from "../src/mcp/transport";
import { LOOPBACK_DIRECT, connectClient } from "./mcp-helpers";

const KNOWN = new Set(["alice", "bob"]);

// A one-tool server whose tool echoes the bound caller — proves makeServer's identity
// closure reaches the tool layer (the seam tools.ts fills in T22).
function fakeServer(caller: string): Server {
  const server = new Server({ name: "teamai", version: "0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "echo the caller",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: caller }],
  }));
  return server;
}

describe.skipIf(!LOOPBACK_DIRECT)(
  "agent-plane transport + identity over real MCP (§8.1/§8.6)",
  () => {
    let plane: AgentPlaneHandle;
    let evictions: { name: string }[] = [];

    function start(): AgentPlaneHandle {
      evictions = [];
      plane = startAgentPlane({
        port: 0,
        makeServer: fakeServer,
        isKnownIdentity: (n) => KNOWN.has(n),
        onEviction: (name) => evictions.push({ name }),
      });
      return plane;
    }

    afterEach(async () => {
      await plane?.stop();
    });

    test("a known agent connects; its tool calls carry its declared identity", async () => {
      start();
      const client = await connectClient(plane.url, "alice");
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
      const result = await client.callTool({ name: "echo", arguments: {} });
      expect(result.content).toEqual([{ type: "text", text: "alice" }]); // bound to alice, not bob
      await client.close();
    });

    test("an unknown identity is rejected at initialize (not a silent empty session)", async () => {
      start();
      await expect(connectClient(plane.url, "mallory")).rejects.toThrow(/unknown agent identity/i);
    });

    // FR-44b (T55): a crashed client holds no DELETE — the newcomer wins, the old
    // session is evicted (its next call fails), and the takeover is surfaced.
    test("a second initialize under the same name takes the identity over", async () => {
      start();
      const old = await connectClient(plane.url, "alice");
      const fresh = await connectClient(plane.url, "alice"); // no rejection
      expect(evictions).toEqual([{ name: "alice" }]); // surfaced to the log hook
      // The newcomer owns the identity…
      const result = await fresh.callTool({ name: "echo", arguments: {} });
      expect(result.content).toEqual([{ type: "text", text: "alice" }]);
      // …and the evicted session is gone: its next call errors (unknown session).
      await expect(old.callTool({ name: "echo", arguments: {} })).rejects.toThrow();
      await fresh.close();
    });
  },
);
