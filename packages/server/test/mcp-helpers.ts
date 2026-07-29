// Test helper: connect the SDK's real MCP Client to a running agent-plane. Using the
// genuine client is the contract test the plan calls for — it exercises the actual
// initialize handshake and proves a real MCP client connects (§3.1). The custom fetch
// bypasses any local dev HTTP proxy (e.g. Privoxy) for loopback; CI has none.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// A local dev HTTP proxy (HTTP_PROXY, e.g. Privoxy) is read by bun at startup and
// hijacks even loopback fetch — which the SDK client uses. We can't relax it from
// inside the process, so probe once whether a direct loopback request reaches our own
// server, and gate the network tests on it (skip when proxied, like hasTmux). CI has
// no proxy, so it runs there; locally, run with the proxy unset (env -u HTTP_PROXY).
async function probeLoopbackDirect(): Promise<boolean> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("DIRECT") });
  try {
    return (await (await fetch(`http://localhost:${server.port}/`)).text()) === "DIRECT";
  } catch {
    return false;
  } finally {
    await server.stop(true);
  }
}

export const LOOPBACK_DIRECT = await probeLoopbackDirect();

/** Connect a client declaring `name` as its topology identity (clientInfo.name, §8.6). */
export async function connectClient(url: string, name: string): Promise<Client> {
  const client = new Client({ name, version: "0" });
  // Cast bridges an exactOptionalPropertyTypes mismatch between the SDK's concrete
  // client transport (sessionId: string | undefined) and the Transport interface.
  const transport = new StreamableHTTPClientTransport(new URL(url)) as Transport;
  await client.connect(transport);
  return client;
}
