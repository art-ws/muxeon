// ConfigError — a fatal, fail-fast configuration error (§7.5, FR-33). Carries an
// optional `path` (a JSON Pointer into the config) so every failure names its
// location. Never embeds resolved secret *values* (§7.3, §10.7) — only var names,
// field names, and locations.

export class ConfigError extends Error {
  readonly path?: string;

  constructor(message: string, options?: { path?: string }) {
    const path = options?.path;
    super(path !== undefined ? `${message} (at ${path === "" ? "/" : path})` : message);
    this.name = "ConfigError";
    if (path !== undefined) this.path = path;
  }
}
