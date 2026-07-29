// Agent colors (T99, FR-73): every agent gets a stable accent color — the
// server-configured one (`agents[].color`, via `peers[].color`) when present,
// otherwise a deterministic pick FROM THE NAME out of a fixed palette of
// well-separated hues (maximal hue spacing minimizes visual collision).
// Pure and DOM-free: the components only inject the value as a CSS variable.

/**
 * 12 hues spaced ~30° apart at medium saturation/lightness — distinct from
 * one another AND readable as avatar backgrounds under white initials in both
 * themes. hsl() keeps the geometry obvious; color-mix in styles.css derives
 * the soft chat tints from these.
 */
export const AGENT_PALETTE: readonly string[] = [
  "hsl(4 72% 56%)", // red
  "hsl(26 78% 50%)", // orange
  "hsl(48 80% 42%)", // amber
  "hsl(80 55% 42%)", // olive
  "hsl(145 55% 40%)", // green
  "hsl(172 65% 36%)", // teal
  "hsl(196 78% 44%)", // cyan
  "hsl(220 70% 56%)", // blue
  "hsl(252 62% 62%)", // indigo
  "hsl(285 50% 54%)", // purple
  "hsl(320 60% 52%)", // magenta
  "hsl(344 70% 56%)", // pink
];

/** FNV-1a 32-bit — tiny, stable, good spread for short names. */
export function hashName(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The agent's accent: the configured color wins, else a palette pick by name. */
export function agentColor(name: string, configured?: string): string {
  if (configured !== undefined && configured !== "") return configured;
  return AGENT_PALETTE[hashName(name) % AGENT_PALETTE.length] as string;
}
