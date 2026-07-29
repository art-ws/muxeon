// Server build info (FR-91) shown in the Settings footer: version + the deployed
// commit and its date. Pure formatting; the fetch lives in api.ts.

export interface ServerInfo {
  version: string;
  commit?: string;
  builtAt?: string;
}

/** Compact one line: "TeamAI <version> · <commit> · <builtLabel> <date>" (parts
 *  omitted when absent). The ISO date renders in the viewer's locale; an
 *  unparseable value falls back to the raw string. */
export function formatServerInfo(info: ServerInfo, builtLabel: string): string {
  const parts = [`TeamAI ${info.version}`];
  if (info.commit !== undefined && info.commit !== "") parts.push(info.commit);
  if (info.builtAt !== undefined && info.builtAt !== "") {
    const date = new Date(info.builtAt);
    const when = Number.isNaN(date.getTime()) ? info.builtAt : date.toLocaleString();
    parts.push(`${builtLabel} ${when}`);
  }
  return parts.join(" · ");
}
