// Bad or missing configuration: exit 2, and (when it's found before we set `working`)
// without touching the issue at all. Its own module, free of npm dependencies, so that
// allowlist.ts (imported by the bin/ scripts on stock node) can throw it too.
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
