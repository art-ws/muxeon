// Inbound addressing (§3.2): the recipient is the FIRST (left-to-right) @token
// that matches a known agent name; an @token matching nothing is plain text.
// With no matching token the channel's defaultTarget applies; with neither, the
// message is undeliverable and the operator gets a clear error in the same
// channel (the connector handles that — this module only resolves).

// Token charset mirrors the safe file-id charset (§8.7); agent names outside it
// are simply not @-addressable (defaultTarget still works).
const AT_TOKEN = /@([A-Za-z0-9_-]+)/g;

export type AddressResult =
  | { readonly ok: true; readonly target: string }
  | { readonly ok: false; readonly reason: "NO_TARGET" };

export function resolveTarget(
  text: string | undefined,
  knownAgents: ReadonlySet<string>,
  defaultTarget?: string,
): AddressResult {
  for (const match of (text ?? "").matchAll(AT_TOKEN)) {
    const name = match[1];
    if (name !== undefined && knownAgents.has(name)) return { ok: true, target: name };
  }
  if (defaultTarget !== undefined) return { ok: true, target: defaultTarget };
  return { ok: false, reason: "NO_TARGET" };
}
