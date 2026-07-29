// Boundary text redaction (§8.7, FR-36, NFR-6): resolved $env secrets must never
// appear in logs or operator-facing errors. The config layer reports WHERE the
// secrets live (secretPaths → secretValues); this builds the scrubber every
// outgoing boundary string passes through. Queue records never carry config data
// by construction (the envelope is producer fields only, §5.3) — guarded by test.

export type TextRedactor = (text: string) => string;

const REDACTED = "[redacted]";

export function createTextRedactor(secrets: Iterable<string>): TextRedactor {
  // Very short values would shred unrelated text; real tokens are long. A config
  // with a <4-char "secret" keeps it unredacted — acceptable, documented.
  const values = [...new Set(secrets)].filter((value) => value.length >= 4);
  if (values.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const value of values) out = out.replaceAll(value, REDACTED);
    return out;
  };
}
