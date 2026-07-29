// Shared message body (FR-61, §12.7): the constrained markdown view plus the
// per-message hover actions — copy the raw source to the clipboard and toggle
// between rendered markdown and the source. Used by chat bubbles and transport
// rows alike; the host container provides position:relative for the actions.
// Chat bubbles also pass `messageHash` (T107/T108, FR-75) — the deep-link
// button NAVIGATES to the message's URL (the address bar is then ready to
// copy/share; no clipboard side effect — operator decision T108).

import { useState } from "react";
import { useT } from "./i18n-context";
import { IconCheck, IconCode, IconCopy, IconLink } from "./icons";
import { Markdown } from "./markdown";

export function MessageText(props: {
  text: string;
  /** The message's deep-link hash (FR-75); absent ⇒ no link button (transport). */
  messageHash?: string;
}): React.JSX.Element {
  const t = useT();
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await copyText(props.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard blocked — nothing to break
    }
  };

  return (
    <>
      <span className="msg-actions">
        {props.messageHash !== undefined && (
          <button
            type="button"
            className="msg-action"
            title={t("Go to this message's link")}
            onClick={() => {
              location.hash = props.messageHash ?? "";
            }}
          >
            <IconLink size={12} />
          </button>
        )}
        <button
          type="button"
          className="msg-action"
          title={t("Copy source to clipboard")}
          onClick={() => void copy()}
        >
          {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
        </button>
        <button
          type="button"
          className={`msg-action${showSource ? " active" : ""}`}
          title={showSource ? t("Rendered view") : t("Markdown source")}
          onClick={() => setShowSource(!showSource)}
        >
          <IconCode size={12} />
        </button>
      </span>
      {showSource ? <pre className="msg-source">{props.text}</pre> : <Markdown text={props.text} />}
    </>
  );
}

// navigator.clipboard needs a secure context (https / localhost); behind a
// plain-http proxy fall back to the legacy textarea path.
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText !== undefined) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}
