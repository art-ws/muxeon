// Message filtering (T97, FR-71): pure predicates behind the GLOBAL topbar
// search (chats + transport) and the transport-only from/to multi-select.
// DOM-free so `bun test` covers the matching rules without a browser; the
// views only count what the predicates hide.

import { type ChatRecord, payloadParts } from "./types";

/**
 * Case-insensitive substring match over the record's visible surfaces: the
 * parties (from/to), the payload text and attachment names. A blank query
 * matches everything — "no filter".
 */
export function matchesQuery(record: ChatRecord, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  const { text, blobs } = payloadParts(record.payload);
  const haystack = [record.from, record.to, text ?? "", ...blobs.map((blob) => blob.name ?? "")]
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}

/** From/to multi-select (transport toolbar): an EMPTY selection = "all". */
export function matchesParties(
  record: ChatRecord,
  from: ReadonlySet<string>,
  to: ReadonlySet<string>,
): boolean {
  return (from.size === 0 || from.has(record.from)) && (to.size === 0 || to.has(record.to));
}

/** Distinct sorted names of a party field — the multi-select options. */
export function partyOptions(
  records: readonly ChatRecord[],
  field: "from" | "to",
): readonly string[] {
  return [...new Set(records.map((record) => record[field]))].sort();
}

/** Toggle a name in a selection (immutably) — one checkbox click. */
export function toggleParty(selected: ReadonlySet<string>, name: string): ReadonlySet<string> {
  const next = new Set(selected);
  if (!next.delete(name)) next.add(name);
  return next;
}
