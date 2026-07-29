// Slash command → selection (§15.8, FR-115): a modal for running ONE slash
// command against the INTERSECTION of a set of selectors (groups/tags/agents).
// Launched from a group/tag chat (seeded with that target); the operator can add
// more selectors to narrow. The recipient preview is computed client-side from
// the peer view — the server is authoritative and returns the per-agent result.

import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type CommandFanoutResult, runCommandFanout } from "./api";
import { useT } from "./i18n-context";
import { type PeerInfo, peerKind } from "./types";

// Resolve a selector to its agent set from the CLIENT's peer view: a group/tag →
// its (server-computed) members, a plain agent → itself, unknown → null.
function resolveMembers(name: string, byName: Map<string, PeerInfo>): readonly string[] | null {
  const peer = byName.get(name);
  if (peer === undefined) return null;
  return peerKind(peer) === "agent" ? [name] : (peer.members ?? []);
}

function intersect(
  selectors: readonly string[],
  byName: Map<string, PeerInfo>,
): { agents: string[]; unknown: string[] } {
  if (selectors.length === 0) return { agents: [], unknown: [] };
  const unknown: string[] = [];
  const sets: string[][] = [];
  for (const selector of selectors) {
    const members = resolveMembers(selector, byName);
    if (members === null) {
      unknown.push(selector);
      sets.push([]);
    } else {
      sets.push([...members]);
    }
  }
  const first = sets[0] ?? [];
  const rest = sets.slice(1).map((names) => new Set(names));
  const seen = new Set<string>();
  const agents: string[] = [];
  for (const name of first) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (rest.every((set) => set.has(name))) agents.push(name);
  }
  return { agents, unknown };
}

export function CommandFanout(props: {
  peers: readonly PeerInfo[];
  initialSelector: string;
  onClose: () => void;
}): React.JSX.Element {
  const t = useT();
  const byName = useMemo(
    () => new Map(props.peers.map((peer) => [peer.name, peer])),
    [props.peers],
  );
  const [selectors, setSelectors] = useState<string[]>([props.initialSelector]);
  const [slash, setSlash] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CommandFanoutResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { agents, unknown } = useMemo(() => intersect(selectors, byName), [selectors, byName]);
  // Which recipients the operator can actually command — its agent neighbours
  // (the agent peers in view). Others in the intersection will come back DENIED.
  const commandable = useMemo(
    () => new Set(props.peers.filter((p) => peerKind(p) === "agent").map((p) => p.name)),
    [props.peers],
  );
  // Command suggestions: the commands present on EVERY target agent.
  const commonCommands = useMemo(() => {
    if (agents.length === 0) return [];
    const lists = agents.map((a) => new Set(byName.get(a)?.commands ?? []));
    const [head, ...tail] = lists;
    return [...(head ?? [])].filter((c) => tail.every((set) => set.has(c))).sort();
  }, [agents, byName]);
  const addable = props.peers.filter((peer) => !selectors.includes(peer.name));

  // Native <dialog> as a modal (focus-trap + Escape for free, matches the panel's
  // other dialogs); showModal on mount, close on unmount.
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  const dirty = slash.trim() !== "";
  const run = async (): Promise<void> => {
    setRunning(true);
    setError(null);
    try {
      setResult(await runCommandFanout(slash.trim(), selectors));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      setConfirming(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="cmdfan-dialog"
      onCancel={(e) => {
        e.preventDefault(); // Escape → our own close (unmount), not the native toggle
        props.onClose();
      }}
    >
      <div className="cmdfan-panel">
        <header className="cmdfan-head">
          <strong>{t("Slash command → selection")}</strong>
          <button
            type="button"
            className="cmdfan-close"
            onClick={props.onClose}
            aria-label={t("Close")}
          >
            ×
          </button>
        </header>

        <div className="cmdfan-row">
          <span className="cmdfan-label">{t("Targets (intersection)")}</span>
          <div className="cmdfan-chips">
            {selectors.map((s) => {
              const kind = byName.has(s) ? peerKind(byName.get(s) as PeerInfo) : "unknown";
              return (
                <span key={s} className={`cmdfan-chip cmdfan-chip-${kind}`}>
                  {s}
                  <button
                    type="button"
                    onClick={() => setSelectors(selectors.filter((x) => x !== s))}
                    aria-label={t("Remove")}
                  >
                    ×
                  </button>
                </span>
              );
            })}
            {addable.length > 0 && (
              <select
                value=""
                className="cmdfan-add"
                onChange={(e) => {
                  if (e.target.value !== "") setSelectors([...selectors, e.target.value]);
                }}
              >
                <option value="">{t("+ add…")}</option>
                {addable.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name} · {peerKind(p)}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        <div className="cmdfan-row">
          <span className="cmdfan-label">{t("Command")}</span>
          <div className="cmdfan-cmd">
            <span className="cmdfan-slash">/</span>
            <input
              list="cmdfan-suggest"
              value={slash}
              placeholder="compact"
              onChange={(e) => setSlash(e.target.value.replace(/^\/+/, ""))}
            />
            <datalist id="cmdfan-suggest">
              {commonCommands.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
        </div>

        <div className="cmdfan-recipients">
          {unknown.length > 0 && (
            <div className="cmdfan-warn">
              {t("Unknown selector:")} {unknown.join(", ")}
            </div>
          )}
          <div className="cmdfan-count">
            {t("Recipients:")} {agents.length}
          </div>
          <ul>
            {agents.map((a) => (
              <li key={a} className={commandable.has(a) ? "" : "cmdfan-denied"}>
                {a}
                {commandable.has(a) ? "" : ` — ${t("no access")}`}
              </li>
            ))}
          </ul>
        </div>

        {error !== null && <div className="cmdfan-error">{error}</div>}
        {result !== null && (
          <div className="cmdfan-results">
            {result.fanout.length === 0 ? (
              <div className="cmdfan-count">{t("No recipients — nothing was sent.")}</div>
            ) : (
              result.fanout.map((entry) => (
                <details key={entry.to} className={entry.ok ? "cmdfan-ok" : "cmdfan-fail"}>
                  <summary>
                    {entry.to}: {entry.ok ? t("ok") : (entry.code ?? t("failed"))}
                  </summary>
                  {entry.output !== undefined && entry.output !== "" && <pre>{entry.output}</pre>}
                </details>
              ))
            )}
          </div>
        )}

        <footer className="cmdfan-foot">
          {confirming ? (
            <>
              <span className="cmdfan-confirm">
                {`${t("Send")} /${slash.trim()} ${t("to")} ${agents.length} ${t("agent(s)?")}`}
              </span>
              <button type="button" className="cmdfan-run" disabled={running} onClick={run}>
                {running ? t("Running…") : t("Confirm")}
              </button>
              <button type="button" onClick={() => setConfirming(false)} disabled={running}>
                {t("Cancel")}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="cmdfan-run"
              disabled={!dirty || agents.length === 0}
              onClick={() => {
                setResult(null);
                setError(null);
                setConfirming(true);
              }}
            >
              {t("Run")}
            </button>
          )}
        </footer>
      </div>
    </dialog>
  );
}
