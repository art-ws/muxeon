// Constrained markdown renderer (T81, §12.7, FR-61). The §12.6 XSS stance: the
// raw agent text never reaches an HTML sink — raw HTML stays text, javascript:
// links stay text, http(s) links open noopener. The only innerHTML is trusted
// transformer output (KaTeX FR-99, Mermaid FR-100) which neutralizes its own
// input. renderToStaticMarkup gives the exact emitted HTML — what React escaped
// is visible directly.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/markdown";

const html = (text: string): string => renderToStaticMarkup(<Markdown text={text} />);

describe("inline markdown (FR-61)", () => {
  test("bold, italic, code, link render as elements", () => {
    const out = html("**b** *i* `c` [t](https://x.test/p)");
    expect(out).toContain("<strong>b</strong>");
    expect(out).toContain("<em>i</em>");
    expect(out).toContain("<code>c</code>");
    expect(out).toContain('href="https://x.test/p"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
  });

  test("nesting: italic inside bold", () => {
    expect(html("**a *b* c**")).toContain("<strong>a <em>b</em> c</strong>");
  });

  test("a javascript: link stays literal text (§12.6)", () => {
    const out = html("[click](javascript:alert(1))");
    expect(out).not.toContain("<a");
    expect(out).toContain("[click](javascript:alert(1))");
  });

  test("raw HTML stays text — React escaping holds (§12.6)", () => {
    const out = html('<img src=x onerror="pwn()"> & <script>alert(1)</script>');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;img src=x onerror=&quot;pwn()&quot;&gt;");
    expect(out).toContain("&lt;script&gt;");
  });

  test("markdown inside a code span stays literal", () => {
    expect(html("`**not bold**`")).toContain("<code>**not bold**</code>");
  });
});

describe("block markdown (FR-61)", () => {
  test("headings h1..h6", () => {
    expect(html("# A")).toContain("<h1>A</h1>");
    expect(html("### B")).toContain("<h3>B</h3>");
    expect(html("###### C")).toContain("<h6>C</h6>");
  });

  test("a fenced code block keeps its body literal, markdown not parsed", () => {
    const out = html("```js\nconst a = **x**;\n<b>html</b>\n```");
    expect(out).toContain('<pre class="code-block">');
    expect(out).toContain("const a = **x**;");
    expect(out).toContain("&lt;b&gt;html&lt;/b&gt;");
    expect(out).not.toContain("<strong>");
  });

  test("an unclosed fence swallows to EOF without crashing", () => {
    expect(html("```\nraw")).toContain("raw");
  });

  test("unordered and ordered lists with a wrapped item line", () => {
    const out = html("- one\n- two\n  wrapped\n\n1. first\n2) second");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>one</li>");
    expect(out).toContain("two<br/>wrapped");
    expect(out).toContain("<ol>");
    expect(out).toContain("<li>first</li>");
    expect(out).toContain("<li>second</li>");
  });

  test("blockquote renders its content as blocks", () => {
    const out = html("> quoted **bold**\n> second");
    expect(out).toContain("<blockquote>");
    expect(out).toContain("<strong>bold</strong>");
  });

  test("hr separates; --- is not a list item", () => {
    expect(html("a\n\n---\n\nb")).toContain("<hr/>");
  });

  test("single newlines inside a paragraph become <br/> (chat layout)", () => {
    expect(html("line1\nline2")).toContain("line1<br/>line2");
  });

  test("plain text without markdown is one clean paragraph", () => {
    expect(html("просто текст")).toBe('<div class="markdown"><p>просто текст</p></div>');
  });
});

describe("GFM tables (FR-98)", () => {
  test("a basic table renders thead/tbody with header and body cells", () => {
    const out = html("| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |");
    expect(out).toContain('<table class="md-table">');
    expect(out).toContain("<thead>");
    expect(out).toContain("a</th>");
    expect(out).toContain("b</th>");
    expect(out).toContain("<tbody>");
    expect(out).toContain("1</td>");
    expect(out).toContain("4</td>");
  });

  test("colons in the delimiter set per-column alignment", () => {
    const out = html("| l | c | r |\n| :- | :-: | -: |\n| 1 | 2 | 3 |");
    expect(out).toContain("text-align:left");
    expect(out).toContain("text-align:center");
    expect(out).toContain("text-align:right");
  });

  test("inline markdown renders inside cells", () => {
    const out = html("| h |\n| - |\n| **b** `c` |");
    expect(out).toContain("<strong>b</strong>");
    expect(out).toContain("<code>c</code>");
  });

  test("raw HTML inside a cell stays escaped text (§12.6 holds — no innerHTML)", () => {
    const out = html("| h |\n| - |\n| <img src=x onerror=pwn> |");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });

  test("ragged rows: missing cells pad, extra cells drop (GFM)", () => {
    const out = html("| a | b |\n| - | - |\n| 1 |\n| x | y | z |");
    // first body row has one cell → second cell padded empty
    expect(out).toContain("<td>1</td><td></td>");
    // second body row has three → the extra (z) is dropped
    expect(out).toContain("x</td>");
    expect(out).toContain("y</td>");
    expect(out).not.toContain("z</td>");
  });

  test("a pipe line WITHOUT a delimiter row stays a paragraph, not a table", () => {
    expect(html("a | b")).toBe('<div class="markdown"><p>a | b</p></div>');
  });

  test("a table ends at a blank line; following text is its own block", () => {
    const out = html("| a |\n| - |\n| 1 |\n\nafter");
    expect(out).toContain("</table>");
    expect(out).toContain("<p>after</p>");
  });

  test("a lone --- is still an hr, not a table (no header pipe above it)", () => {
    expect(html("text\n\n---")).toContain("<hr/>");
  });
});

describe("LaTeX via KaTeX (FR-99)", () => {
  test("inline $…$ renders KaTeX markup", () => {
    const out = html("energy $E=mc^2$ here");
    expect(out).toContain("katex"); // KaTeX wraps in <span class="katex">
    expect(out).toContain('class="katex-inline"');
  });

  test("block $$…$$ renders display-mode KaTeX", () => {
    const out = html("$$\n\\int_0^1 x\\,dx\n$$");
    expect(out).toContain('class="katex-block"');
    expect(out).toContain("katex-display"); // display mode wrapper
  });

  test("single-line $$…$$ also renders as a block", () => {
    expect(html("$$a+b$$")).toContain('class="katex-block"');
  });

  test("a malformed expression does not throw (throwOnError:false)", () => {
    const out = html("$\\frac{1}$"); // missing arg
    expect(out).toContain('class="katex-inline"'); // rendered, not crashed
  });

  test("trust:false neutralizes \\href — no live javascript: link (§12.6)", () => {
    const out = html("$\\href{javascript:alert(1)}{x}$");
    expect(out).not.toContain('href="javascript:');
    expect(out).not.toContain("<a ");
  });

  test("currency is not mistaken for math ($N … $M not paired)", () => {
    const out = html("price $5 and $10 today");
    expect(out).not.toContain('class="katex');
    expect(out).toContain("$5 and $10");
  });

  test("a $ inside a code span stays literal, not math", () => {
    const out = html("`$x$`");
    expect(out).toContain("<code>$x$</code>");
    expect(out).not.toContain('class="katex');
  });
});

describe("Mermaid diagrams (FR-100)", () => {
  // Server render (no DOM, no effect) shows the safe fallback: the source as a
  // code block. The actual SVG render is browser-only (a useEffect) — covered by
  // manual/e2e, not the no-DOM unit env.
  test("a ```mermaid block renders the safe pending fallback with the source", () => {
    const out = html("```mermaid\ngraph TD; A-->B;\n```");
    expect(out).toContain("mermaid-pending");
    expect(out).toContain("graph TD; A--&gt;B;"); // source kept, escaped
  });

  test("a normal ```js code block is NOT treated as a diagram", () => {
    const out = html("```js\nconst a = 1;\n```");
    expect(out).toContain('<pre class="code-block">');
    expect(out).not.toContain("mermaid-pending");
  });

  test("raw HTML in a mermaid block stays escaped text in the fallback (§12.6)", () => {
    const out = html("```mermaid\n<script>alert(1)</script>\n```");
    expect(out).not.toContain("<script>alert");
    expect(out).toContain("&lt;script&gt;");
  });
});
