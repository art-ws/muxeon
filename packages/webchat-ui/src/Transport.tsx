// Transport observability view (FR-48, §12.4): the SERVER-WIDE routed-message
// feed (§8.2) — agent↔agent included — read-only. One row per routed Signal:
// time, from → to, kind/origin badges, payload body. Older pages load by
// cursor like the chat history; live rows arrive via the WS `transport` push.
// Text renders through MessageText (FR-61): constrained markdown, no innerHTML
// (§12.6), with the same copy/source hover actions as chat bubbles.

import { useEffect, useMemo, useState } from "react";
import { FilterNote } from "./FilterNote";
import { MessageText } from "./MessageText";
import * as api from "./api";
import { usePinnedFeed } from "./feed-pin";
import { matchesParties, matchesQuery, partyOptions, toggleParty } from "./filter";
import { useT } from "./i18n-context";
import { IconCheck } from "./icons";
import { TimeStamp } from "./timestamp";
import { type ChatRecord, payloadParts } from "./types";

export function TransportView(props: {
  live: readonly ChatRecord[];
  /** Global auto-scroll switch (FR-62): ON pins the feed to the newest record. */
  follow?: boolean;
  /** Global message filter (T97, FR-71) — the topbar search field. */
  query?: string;
  /** From/to selections (FR-85) — owned by the ROUTE, not component state. */
  from?: readonly string[];
  to?: readonly string[];
  /** Project a changed selection into the URL (T124) — the route round-trips it back. */
  onFilters?: (from: readonly string[], to: readonly string[]) => void;
}): React.JSX.Element {
  const [records, setRecords] = useState<readonly ChatRecord[]>([]);
  const [nextBefore, setNextBefore] = useState<string | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  // The transport-own filter (FR-71): from/to multi-selects in THIS header.
  // The selection lives in the URL (FR-85): props carry the route's reading,
  // every change goes BACK through onFilters → location — so a reload or a
  // pasted link restores exactly the filters that were picked.
  const fromSel = useMemo<ReadonlySet<string>>(() => new Set(props.from ?? []), [props.from]);
  const toSel = useMemo<ReadonlySet<string>>(() => new Set(props.to ?? []), [props.to]);
  const setFilters = (from: ReadonlySet<string>, to: ReadonlySet<string>): void =>
    props.onFilters?.([...from], [...to]);

  useEffect(() => {
    void api.fetchTransport().then((page) => {
      setRecords(page.records);
      setNextBefore(page.nextBefore);
      setLoaded(true);
    });
  }, []);

  const loadOlder = (): void => {
    if (nextBefore === undefined) return;
    void api.fetchTransport(nextBefore).then((page) => {
      setRecords((current) => [...page.records, ...current]);
      setNextBefore(page.nextBefore);
    });
  };

  // page + live, deduped by id (the page may already contain a pushed record)
  const ids = new Set(records.map((record) => record.id));
  const merged = [...records, ...props.live.filter((record) => !ids.has(record.id))];

  // Filtering (FR-71): the global query AND the local from/to selections; the
  // strip under the header counts what the combination hides.
  const query = props.query ?? "";
  const filtering = query.trim() !== "" || fromSel.size > 0 || toSel.size > 0;
  const visible = filtering
    ? merged.filter(
        (record) => matchesQuery(record, query) && matchesParties(record, fromSel, toSel),
      )
    : merged;

  // Pinned feed (T106): opening lands on the newest record (async media
  // included), staying near the bottom keeps following; FR-62 forces it.
  const lastId = visible[visible.length - 1]?.id;
  const { feedRef, contentRef, onScroll } = usePinnedFeed(props.follow, lastId);

  const t = useT();
  return (
    <>
      <header className="chat-header">
        <strong>{t("Transport")}</strong>
        <span className="chat-status">{t("all routed messages, read-only")}</span>
        {/* the transport-own toolbar filter (FR-71): sender / recipient multi-selects;
            options include URL-restored names absent from the loaded records (FR-85) —
            a stale selection must stay visible to be untoggleable */}
        <span className="transport-filters">
          <PartyFilter
            label="From"
            options={withSelected(partyOptions(merged, "from"), fromSel)}
            selected={fromSel}
            onToggle={(name) => setFilters(toggleParty(fromSel, name), toSel)}
            onClear={() => setFilters(new Set(), toSel)}
          />
          <PartyFilter
            label="To"
            options={withSelected(partyOptions(merged, "to"), toSel)}
            selected={toSel}
            onToggle={(name) => setFilters(fromSel, toggleParty(toSel, name))}
            onClear={() => setFilters(fromSel, new Set())}
          />
        </span>
      </header>
      {filtering && <FilterNote hidden={merged.length - visible.length} total={merged.length} />}
      <div className="feed transport-feed" ref={feedRef} onScroll={onScroll}>
        {/* the wrapper is the ResizeObserver target (T106) — content growth re-pins */}
        <div className="feed-content" ref={contentRef}>
          {nextBefore !== undefined && (
            <button type="button" className="load-older" onClick={loadOlder}>
              {t("Load older records")}
            </button>
          )}
          {loaded && merged.length === 0 && (
            <p className="transport-empty">{t("No transport yet")}</p>
          )}
          {visible.map((record) => (
            <TransportRow key={record.id} record={record} />
          ))}
        </div>
      </div>
    </>
  );
}

/** Options ∪ selection, sorted (FR-85): URL-restored names stay untoggleable. */
function withSelected(
  options: readonly string[],
  selected: ReadonlySet<string>,
): readonly string[] {
  return [...new Set([...options, ...selected])].sort();
}

// A from/to multi-select (FR-71): a toolbar button opening a checklist — click
// toggles a name, "All" clears; the backdrop click-away mirrors the composer
// menu (no blocking dialogs). The button shows how many names are picked.
function PartyFilter(props: {
  label: string;
  options: readonly string[];
  selected: ReadonlySet<string>;
  onToggle: (name: string) => void;
  onClear: () => void;
}): React.JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const active = props.selected.size > 0;
  return (
    <span className="filter-anchor">
      {open && (
        <>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: a transparent click-away backdrop, the menu buttons carry the keyboard path */}
          <span className="menu-backdrop" onClick={() => setOpen(false)} />
          <span className="filter-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className={`filter-option${active ? "" : " picked"}`}
              onClick={() => {
                props.onClear();
                setOpen(false);
              }}
            >
              <span className="filter-check">{!active && <IconCheck size={12} />}</span> {t("All")}
            </button>
            {props.options.map((name) => (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={props.selected.has(name)}
                key={name}
                className={`filter-option${props.selected.has(name) ? " picked" : ""}`}
                onClick={() => props.onToggle(name)}
              >
                <span className="filter-check">
                  {props.selected.has(name) && <IconCheck size={12} />}
                </span>{" "}
                {name}
              </button>
            ))}
          </span>
        </>
      )}
      <button
        type="button"
        className={`filter-button${active ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${t("Filter by")} ${t(props.label).toLowerCase()}`}
        onClick={() => setOpen(!open)}
      >
        {t(props.label)}
        {active ? ` · ${props.selected.size}` : ""} <span className="filter-caret">▾</span>
      </button>
    </span>
  );
}

function TransportRow(props: { record: ChatRecord }): React.JSX.Element {
  const { record } = props;
  const { text, blobs } = payloadParts(record.payload);
  return (
    <div className="transport-row">
      <div className="transport-text">
        {text !== undefined && <MessageText text={text} />}
        {blobs.length > 0 && <span>[{blobs.length} attachment(s)]</span>}
      </div>
      {/* the chat bubble's idiom (T225): who and when go UNDER the message, so
          the text owns the full width instead of hanging in a second column */}
      <span className="transport-meta">
        <span className="transport-route">{`${record.from} → ${record.to}`}</span>
        {record.kind !== "message" && <span className="transport-badge">{record.kind}</span>}
        {record.origin !== undefined && <span className="transport-badge">{record.origin}</span>}
        <TimeStamp className="transport-time" ts={record.ts} />
      </span>
    </div>
  );
}
