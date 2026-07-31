// The instance/configuration label (FR-90, §12.7): the connector injects it into
// the served shell as `<meta name="teamai-name">` (and the matching page title).
// Read once for the topbar; absent (dev serve without the connector) ⇒ empty, and
// the topbar simply shows the logo alone.

export function instanceName(): string {
  if (typeof document === "undefined") return "";
  const meta = document.querySelector('meta[name="teamai-name"]');
  return meta?.getAttribute("content")?.trim() ?? "";
}

/**
 * The panel's identity mode (§17.2, FR-127): the connector injects
 * `<meta name="teamai-auth" content="users">` into the served shell when the
 * channel runs in users mode. Absent ⇒ the legacy single-operator login.
 */
export function authMode(): "users" | "legacy" {
  if (typeof document === "undefined") return "legacy";
  const meta = document.querySelector('meta[name="teamai-auth"]');
  return meta?.getAttribute("content")?.trim() === "users" ? "users" : "legacy";
}
