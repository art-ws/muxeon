// The instance/configuration label (FR-90, §12.7): the connector injects it into
// the served shell as `<meta name="teamai-name">` (and the matching page title).
// Read once for the topbar; absent (dev serve without the connector) ⇒ empty, and
// the topbar simply shows the logo alone.

export function instanceName(): string {
  if (typeof document === "undefined") return "";
  const meta = document.querySelector('meta[name="teamai-name"]');
  return meta?.getAttribute("content")?.trim() ?? "";
}
