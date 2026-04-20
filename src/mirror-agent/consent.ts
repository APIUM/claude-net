// Inject consent policy for mirror-session.
//
// Two modes: `always` (default, accept every inject) and `never` (reject
// every inject). The old tmux `display-popup` prompt flow was removed in
// favour of a simple on/off switch — the mirror is designed for
// private-trust-network use (tailnet / LAN), so every watcher that can
// reach the hub is already trusted. Users who want a hard off-switch can
// set `mirror_consent never`; everyone else gets frictionless injection.

export type ConsentMode = "always" | "never";

export type ConsentResult =
  | { ok: true }
  | { ok: false; reason: "rejected"; message: string };

export interface ConsentOptions {
  /** Default mode for new sessions. */
  defaultMode?: ConsentMode;
}

interface SessionConsent {
  mode: ConsentMode;
}

// Legacy modes that earlier deployments may have persisted or that the
// plugin tool still accepts; coerce to the new two-mode set.
const LEGACY_COERCE: Record<string, ConsentMode> = {
  "ask-first-per-session": "always",
  "ask-every-time": "always",
  always: "always",
  never: "never",
};

export class ConsentManager {
  private defaultMode: ConsentMode;
  private state = new Map<string, SessionConsent>();

  constructor(opts: ConsentOptions = {}) {
    this.defaultMode = opts.defaultMode ?? "always";
  }

  /** Explicitly set a mode for a session. Accepts legacy mode names. */
  setMode(sid: string, mode: string): void {
    const coerced = LEGACY_COERCE[mode] ?? "always";
    this.state.set(sid, { mode: coerced });
  }

  /** Clear any stored mode for a session; next check uses the default. */
  reset(sid: string): void {
    this.state.delete(sid);
  }

  /** Remove any record for a session. */
  forget(sid: string): void {
    this.state.delete(sid);
  }

  /**
   * Decide whether to allow an inject for a session. Synchronous-fast —
   * no prompting, no subprocess. `_pane` and `_watcher` are accepted for
   * signature stability with the agent's call site; currently unused.
   */
  async check(
    sid: string,
    _pane: string | null | undefined,
    _watcher: string,
  ): Promise<ConsentResult> {
    const cur = this.state.get(sid) ?? { mode: this.defaultMode };
    if (cur.mode === "never") {
      return {
        ok: false,
        reason: "rejected",
        message: "Consent mode is 'never' for this session.",
      };
    }
    return { ok: true };
  }

  /** Inspect current state (tests / /status endpoints). */
  describe(sid: string): { mode: ConsentMode } {
    const cur = this.state.get(sid);
    return cur ? { mode: cur.mode } : { mode: this.defaultMode };
  }
}
