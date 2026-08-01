// The topbar account button (FR-68, T234) — rendered, not reasoned about: the
// whole point of the move is what the corner SHOWS, so assert the markup. The
// circle carries the person glyph and nothing else; who is signed in survives
// only as the tooltip, and the menu itself stays closed until clicked.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountMenu } from "../src/AccountMenu";

const render = (operator?: string): string =>
  renderToStaticMarkup(
    <AccountMenu
      {...(operator !== undefined ? { operator } : {})}
      onLogout={() => undefined}
      onSettings={() => undefined}
    />,
  );

describe("account button (FR-68, T234)", () => {
  test("the circle shows no name and no label — only the glyph", () => {
    const out = render("operator-web");
    expect(out).toContain('class="account-button"');
    expect(out).toContain('class="peer-avatar"');
    expect(out).toContain("<svg"); // the person icon
    // the sidebar footer used to print both — the corner prints neither
    expect(out).not.toContain(">operator-web<");
    expect(out).not.toContain("Account");
  });

  test("who is signed in stays in the tooltip", () => {
    expect(render("operator-web")).toContain('title="operator-web — account menu"');
  });

  test("an unnamed session still renders the circle — the bar must not reflow", () => {
    const out = render();
    expect(out).toContain('class="account-button"');
    expect(out).toContain('title="account menu"');
  });

  test("the menu is closed until clicked — no items in the initial markup", () => {
    const out = render("operator-web");
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain("account-menu");
    expect(out).not.toContain("Sign out");
  });
});
