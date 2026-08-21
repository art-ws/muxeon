// Hash routing (§12.7, FR-60): `#/` (home) | `#/chat/<peer>` | `#/transport`
// (+ `?from=…&to=…` filter projection, T124/FR-85) | `#/settings` (T110, FR-76)
// | `#/prompts` (the prompt rack, §20.6/FR-187),
// plus the per-message deep link `#/chat/<peer>/m/<id>` (T107, FR-75) — opening
// it lands the chat on that message and flashes it. Hash — NOT history paths —
// because the SPA ships with RELATIVE asset paths (§12.6) and must work behind
// any reverse-proxy prefix: a path route like /chat/x would break ./assets/*
// resolution. A pure codec, no router dependency (R3); junk/malformed hashes
// degrade to home, never crash.
//
// Transport filters (FR-85): the from/to multi-selects live in the URL — one
// REPEATED query param per picked name (`?from=ceo&from=dev&to=operator-web`),
// so names never need a list separator that could collide with their own
// characters. The codec canonicalizes (dedup + sort) both ways: one selection,
// one URL — reload and direct links restore exactly what was picked.

export type Route =
  | { readonly view: "home" }
  | { readonly view: "chat"; readonly peer: string; readonly message?: string }
  | {
      readonly view: "transport";
      /** From-filter names (FR-85), canonical (deduped, sorted); absent = all. */
      readonly from?: readonly string[];
      /** To-filter names (FR-85), canonical; absent = all. */
      readonly to?: readonly string[];
    }
  | { readonly view: "settings" }
  /** The prompt rack page (§20.6, FR-187) — one page, no parameters. */
  | { readonly view: "prompts" };

export const HOME: Route = { view: "home" };

/** Canonical name list of one repeated query param: deduped, sorted, no blanks. */
function partyParam(params: URLSearchParams, key: string): readonly string[] {
  const names = params.getAll(key).filter((name) => name.length > 0);
  return [...new Set(names)].sort();
}

export function parseRoute(hash: string): Route {
  const full = hash.replace(/^#\/?/, "");
  // only the transport view carries a query (FR-85); elsewhere it is junk to drop
  const mark = full.indexOf("?");
  const path = mark === -1 ? full : full.slice(0, mark);
  if (path === "transport") {
    let params: URLSearchParams;
    try {
      params = new URLSearchParams(mark === -1 ? "" : full.slice(mark + 1));
    } catch {
      return { view: "transport" }; // malformed query — the unfiltered view
    }
    const from = partyParam(params, "from");
    const to = partyParam(params, "to");
    return {
      view: "transport",
      ...(from.length > 0 ? { from } : {}),
      ...(to.length > 0 ? { to } : {}),
    };
  }
  if (path === "settings") return { view: "settings" };
  if (path === "prompts") return { view: "prompts" };
  if (path.startsWith("chat/")) {
    try {
      const rest = path.slice("chat/".length);
      // the message segment is separated by "/m/" — both parts are URI-encoded,
      // so a raw "/" can only be the separator
      const split = rest.indexOf("/m/");
      const peer = decodeURIComponent(split === -1 ? rest : rest.slice(0, split));
      const message = split === -1 ? undefined : decodeURIComponent(rest.slice(split + 3));
      if (peer.length > 0) {
        return {
          view: "chat",
          peer,
          ...(message !== undefined && message.length > 0 ? { message } : {}),
        };
      }
    } catch {
      // malformed percent-encoding — home
    }
  }
  return HOME;
}

export function routeHash(route: Route): string {
  switch (route.view) {
    case "chat":
      return `#/chat/${encodeURIComponent(route.peer)}${
        route.message !== undefined ? `/m/${encodeURIComponent(route.message)}` : ""
      }`;
    case "transport": {
      const params = [
        ...[...new Set(route.from ?? [])].sort().map((n) => `from=${encodeURIComponent(n)}`),
        ...[...new Set(route.to ?? [])].sort().map((n) => `to=${encodeURIComponent(n)}`),
      ];
      return params.length > 0 ? `#/transport?${params.join("&")}` : "#/transport";
    }
    case "settings":
      return "#/settings";
    case "prompts":
      return "#/prompts";
    default:
      return "#/";
  }
}
