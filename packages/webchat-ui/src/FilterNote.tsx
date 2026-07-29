// The hidden-count strip (T97, FR-71): whenever ANY filter is active, the list
// states how many records it hides — a filtered list must never pass for the
// full one. Shown by ChatView and TransportView under their headers.

import { useT } from "./i18n-context";

export function FilterNote(props: { hidden: number; total: number }): React.JSX.Element {
  const t = useT();
  // a template key (FR-78): the whole sentence translates as one unit
  const text = t("filter active — {hidden} of {total} messages hidden")
    .replace("{hidden}", String(props.hidden))
    .replace("{total}", String(props.total));
  return (
    <output className="filter-note">
      <span className="filter-note-icon">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <line x1="16.5" y1="16.5" x2="21" y2="21" />
        </svg>
      </span>
      {text}
    </output>
  );
}
