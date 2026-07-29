// Constrained markdown → React elements (§12.7, FR-61). The §12.6 XSS stance:
// the raw agent text is NEVER fed to an HTML sink — the renderer builds React
// elements, so raw HTML inside agent text stays visible text, and links pass
// only with an http(s) scheme (a `javascript:` URL stays literal text) and open
// as noopener/noreferrer. The ONLY innerHTML is the output of TRUSTED
// transformers that neutralize their own untrusted input — KaTeX (FR-99,
// trust:false) and Mermaid (FR-100, securityLevel:strict) — never the raw text
// (the §12.6 carve-out). No general markdown library (R3): the supported subset
// is headings, fenced code, GFM tables (FR-98), $LaTeX$/$$LaTeX$$ (FR-99),
// ```mermaid diagrams (FR-100), lists, blockquotes, hr, paragraphs (single
// newline = <br/>), `code`, **bold**, *italic*, [links]().

import katex from "katex";
import { type ReactNode, createElement, useEffect, useId, useState } from "react";

// LaTeX via KaTeX (FR-99). KaTeX is a TRUSTED transformer: with the default
// `trust: false` it neutralizes the untrusted math source (no `\href`,
// `\includegraphics`, no scripts/event handlers in the output), and
// `throwOnError: false` renders a malformed expression as an inline error node
// instead of throwing. So its output is the one place we DO inject HTML — the
// §12.6 carve-out (the raw agent text never reaches a sink; only KaTeX's own
// sanitized markup does).
function renderMath(expr: string, displayMode: boolean, key: string): ReactNode {
  const html = katex.renderToString(expr, {
    displayMode,
    throwOnError: false,
    output: "htmlAndMathml",
  });
  return (
    <span
      key={key}
      className={displayMode ? "katex-block" : "katex-inline"}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted KaTeX output (FR-99/§12.6)
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// Mermaid diagrams (FR-100). Mermaid is large and needs a real DOM, so it is
// imported LAZILY (a separate bundle chunk) inside a browser-only effect; in SSR
// and before the render resolves, the source shows as a code block — a safe
// fallback where the raw text stays escaped (no sink). securityLevel:'strict'
// makes Mermaid a TRUSTED transformer (no scripts/handlers in the SVG), so its
// output is the one thing injected (§12.6 carve-out, like KaTeX).
let mermaidReady: Promise<typeof import("mermaid")["default"]> | null = null;
function loadMermaid(): Promise<typeof import("mermaid")["default"]> {
  if (mermaidReady === null) {
    mermaidReady = import("mermaid").then((m) => {
      m.default.initialize({ startOnLoad: false, securityLevel: "strict" });
      return m.default;
    });
  }
  return mermaidReady;
}

function Mermaid(props: { code: string }): React.JSX.Element {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // a DOM-id-safe, stable, unique id for mermaid's internal querySelector
  const id = `m${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    loadMermaid()
      .then((mermaid) => mermaid.render(id, props.code))
      .then(({ svg: out }) => {
        if (!cancelled) setSvg(out);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [props.code, id]);

  if (svg !== null) {
    return (
      <div
        className="mermaid-block"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted Mermaid SVG (securityLevel:strict, FR-100)
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }
  // SSR / pending / failed: the diagram source as a code block (raw text, escaped).
  return (
    <pre className={`code-block ${failed ? "mermaid-error" : "mermaid-pending"}`}>
      <code>{props.code}</code>
    </pre>
  );
}

export function Markdown(props: { text: string }): React.JSX.Element {
  return <div className="markdown">{renderBlocks(props.text, "md")}</div>;
}

const FENCE = /^```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^(-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^>\s?/;
const UL_ITEM = /^[-*+]\s+/;
const OL_ITEM = /^\d+[.)]\s+/;

// GFM tables (FR-98): a header row containing `|`, then a delimiter row of cells
// `:?-+:?` (the colons set alignment). A delimiter cell is the only ambiguous bit
// vs an hr `---`, so a table is recognized ONLY when the line above the delimiter
// has a `|` — a lone `---` stays an hr.
const DELIM_CELL = /^:?-+:?$/;
type Align = "left" | "center" | "right" | undefined;

/** Split a table row into trimmed cells, dropping the optional outer pipes. */
function tableCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isDelimiterRow(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((c) => DELIM_CELL.test(c));
}

/** Alignment from a delimiter cell's colons (`:--` left, `--:` right, `:-:` center). */
function cellAlign(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return undefined;
}

/** A table opens at `i` when line `i` has a `|` and line `i+1` is a delimiter row. */
function isTableStart(lines: readonly string[], i: number): boolean {
  return (lines[i] ?? "").includes("|") && isDelimiterRow(lines[i + 1] ?? "");
}

function renderBlocks(text: string, keyBase: string): ReactNode[] {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const key = (): string => `${keyBase}-${n++}`;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (FENCE.test(line)) {
      const lang = line.replace(/^`+/, "").trim().toLowerCase(); // info string after ```
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // closing fence (or EOF)
      const code = body.join("\n");
      if (lang === "mermaid") {
        out.push(<Mermaid key={key()} code={code} />); // FR-100: rendered diagram
      } else {
        out.push(
          <pre key={key()} className="code-block">
            <code>{code}</code>
          </pre>,
        );
      }
      continue;
    }
    // Block math $$…$$ (FR-99): opens on a line starting with $$, closes on the
    // first later (or same) $$. Renders display-mode KaTeX.
    if (line.trimStart().startsWith("$$")) {
      const parts: string[] = [];
      const rest = line.trimStart().slice(2);
      const sameClose = rest.indexOf("$$");
      if (sameClose >= 0) {
        parts.push(rest.slice(0, sameClose));
        i += 1;
      } else {
        parts.push(rest);
        i += 1;
        while (i < lines.length) {
          const cur = lines[i] ?? "";
          const idx = cur.indexOf("$$");
          if (idx >= 0) {
            parts.push(cur.slice(0, idx));
            i += 1;
            break;
          }
          parts.push(cur);
          i += 1;
        }
      }
      out.push(renderMath(parts.join("\n").trim(), true, key()));
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const k = key();
      out.push(
        createElement(`h${heading[1]?.length ?? 1}`, { key: k }, renderInline(heading[2] ?? "", k)),
      );
      i += 1;
      continue;
    }
    if (HR.test(line)) {
      out.push(<hr key={key()} />);
      i += 1;
      continue;
    }
    if (isTableStart(lines, i)) {
      const header = tableCells(line);
      const aligns = tableCells(lines[i + 1] ?? "").map(cellAlign);
      i += 2;
      const rows: string[][] = [];
      // body: consecutive `|`-bearing lines until a blank line or non-row
      while (i < lines.length && (lines[i] ?? "").trim() !== "" && (lines[i] ?? "").includes("|")) {
        rows.push(tableCells(lines[i] ?? ""));
        i += 1;
      }
      const k = key();
      const style = (col: number) => (aligns[col] ? { textAlign: aligns[col] } : undefined);
      out.push(
        <table key={k} className="md-table">
          <thead>
            <tr>
              {header.map((cell, c) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                <th key={`${k}-h${c}`} style={style(c)}>
                  {renderInline(cell, `${k}-h${c}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
              <tr key={`${k}-r${r}`}>
                {header.map((_, c) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                  <td key={`${k}-r${r}c${c}`} style={style(c)}>
                    {renderInline(row[c] ?? "", `${k}-r${r}c${c}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? "")) {
        quoted.push((lines[i] ?? "").replace(QUOTE, ""));
        i += 1;
      }
      const k = key();
      out.push(<blockquote key={k}>{renderBlocks(quoted.join("\n"), k)}</blockquote>);
      continue;
    }
    if (UL_ITEM.test(line) || OL_ITEM.test(line)) {
      const ordered = OL_ITEM.test(line);
      const marker = ordered ? OL_ITEM : UL_ITEM;
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? "";
        if (marker.test(current)) {
          items.push(current.replace(marker, ""));
        } else if (/^\s+\S/.test(current) && items.length > 0) {
          items[items.length - 1] += `\n${current.trim()}`; // wrapped item line
        } else {
          break;
        }
        i += 1;
      }
      const k = key();
      const children = items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: items are positional by nature
        <li key={`${k}-${index}`}>{renderLines(item.split("\n"), `${k}-${index}`)}</li>
      ));
      out.push(ordered ? <ol key={k}>{children}</ol> : <ul key={k}>{children}</ul>);
      continue;
    }
    // paragraph: consecutive lines up to a blank line or another block opener
    const para: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (
        current.trim() === "" ||
        FENCE.test(current) ||
        current.trimStart().startsWith("$$") ||
        HEADING.test(current) ||
        HR.test(current) ||
        QUOTE.test(current) ||
        UL_ITEM.test(current) ||
        OL_ITEM.test(current) ||
        isTableStart(lines, i)
      ) {
        break;
      }
      para.push(current);
      i += 1;
    }
    const k = key();
    out.push(<p key={k}>{renderLines(para, k)}</p>);
  }
  return out;
}

/** Inline-render lines, joining them with <br/> — chat newlines stay visible. */
function renderLines(lines: readonly string[], keyBase: string): ReactNode[] {
  return lines.flatMap((line, index) =>
    index === 0
      ? renderInline(line, `${keyBase}-l${index}`)
      : // biome-ignore lint/suspicious/noArrayIndexKey: line breaks are positional
        [<br key={`${keyBase}-b${index}`} />, ...renderInline(line, `${keyBase}-l${index}`)],
  );
}

// One alternation, first match wins: code span | **bold** | *italic* | [link](url)
// | $math$. Inline math guards against currency: opening `$` not followed by space,
// closing `$` not preceded by space and not followed by a digit (so "$5 … $10" is
// not paired); a code span wins over math at the same index (backtick is earlier).
const INLINE =
  /(`{1,2})([^`]+?)\1|\*\*((?:[^*]|\*(?!\*))+?)\*\*|\*([^*\s][^*]*?)\*|\[([^\]]+?)\]\(([^)\s]+?)\)|\$(?!\s)((?:[^$\n\\]|\\.)+?)(?<!\s)\$(?!\d)/g;

function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = new RegExp(INLINE.source, "g"); // own lastIndex — recursion-safe
  let last = 0;
  let n = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const k = `${keyBase}-${n++}`;
    const [whole, , code, bold, italic, label, href, math] = match;
    if (code !== undefined) {
      nodes.push(<code key={k}>{code}</code>);
    } else if (bold !== undefined) {
      nodes.push(<strong key={k}>{renderInline(bold, k)}</strong>);
    } else if (italic !== undefined) {
      nodes.push(<em key={k}>{renderInline(italic, k)}</em>);
    } else if (math !== undefined) {
      nodes.push(renderMath(math, false, k));
    } else if (label !== undefined && href !== undefined && /^https?:\/\//i.test(href)) {
      nodes.push(
        <a key={k} href={href} target="_blank" rel="noopener noreferrer">
          {renderInline(label, k)}
        </a>,
      );
    } else {
      nodes.push(whole); // e.g. a javascript: link — stays literal text (§12.6)
    }
    last = match.index + whole.length;
    match = pattern.exec(text);
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
