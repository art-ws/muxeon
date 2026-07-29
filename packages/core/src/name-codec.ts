// Positional codec for queue message filenames — `<unix_ms>-<seq>-<id>.json`
// (§5.3, FR-17).
//
// `unix_ms` and `seq` are the first two '-'-separated fields; everything after
// the second '-' (before `.json`) is `id`, so `id` may itself contain '-' (e.g. a
// UUID) or '.'. The total order is unix_ms → seq → id (FIFO).
//
// NOTE: filenames are NOT lexically comparable — the numeric fields are
// variable-width, so "10" sorts before "9" as text. Consumers MUST order parsed
// names via `compareQueueNames`, never by raw string sort. `core` performs no I/O.

export interface QueueName {
  readonly unixMs: number;
  readonly seq: number;
  readonly id: string;
}

const SUFFIX = ".json";

function assertUint(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`queue name ${field} must be a non-negative safe integer, got ${value}`);
  }
}

function parseUint(text: string, field: string, filename: string): number {
  if (!/^\d+$/.test(text)) {
    throw new Error(`queue name ${field} must be digits, got "${text}" in "${filename}"`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`queue name ${field} out of safe integer range: "${text}" in "${filename}"`);
  }
  return value;
}

export function formatQueueName(name: QueueName): string {
  assertUint(name.unixMs, "unixMs");
  assertUint(name.seq, "seq");
  if (name.id.length === 0) {
    throw new Error("queue name id must be non-empty");
  }
  return `${name.unixMs}-${name.seq}-${name.id}${SUFFIX}`;
}

export function parseQueueName(filename: string): QueueName {
  if (!filename.endsWith(SUFFIX)) {
    throw new Error(`queue name must end with "${SUFFIX}": "${filename}"`);
  }
  const base = filename.slice(0, filename.length - SUFFIX.length);
  const firstDash = base.indexOf("-");
  const secondDash = firstDash < 0 ? -1 : base.indexOf("-", firstDash + 1);
  if (firstDash <= 0 || secondDash <= firstDash + 1) {
    throw new Error(`malformed queue name (expected <unix_ms>-<seq>-<id>): "${filename}"`);
  }
  const id = base.slice(secondDash + 1);
  if (id.length === 0) {
    throw new Error(`queue name has empty id: "${filename}"`);
  }
  return {
    unixMs: parseUint(base.slice(0, firstDash), "unixMs", filename),
    seq: parseUint(base.slice(firstDash + 1, secondDash), "seq", filename),
    id,
  };
}

/** Total order over queue names: unix_ms, then seq, then id (FIFO; §5.3). */
export function compareQueueNames(a: QueueName, b: QueueName): number {
  if (a.unixMs !== b.unixMs) return a.unixMs < b.unixMs ? -1 : 1;
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}
