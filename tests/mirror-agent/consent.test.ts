import { describe, expect, test } from "bun:test";
import { ConsentManager } from "@/mirror-agent/consent";

describe("ConsentManager", () => {
  test("default mode is 'always' — inject accepted without prompting", async () => {
    const c = new ConsentManager();
    const r = await c.check("sid", null, "watcher");
    expect(r.ok).toBe(true);
    expect(c.describe("sid").mode).toBe("always");
  });

  test("'never' mode rejects with a clear reason", async () => {
    const c = new ConsentManager();
    c.setMode("sid", "never");
    const r = await c.check("sid", null, "watcher");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("rejected");
    expect(r.message).toContain("never");
  });

  test("setMode('always') returns to allowing", async () => {
    const c = new ConsentManager();
    c.setMode("sid", "never");
    c.setMode("sid", "always");
    const r = await c.check("sid", null, "watcher");
    expect(r.ok).toBe(true);
  });

  test("reset clears the session-specific mode, falling back to default", async () => {
    const c = new ConsentManager({ defaultMode: "always" });
    c.setMode("sid", "never");
    c.reset("sid");
    const r = await c.check("sid", null, "watcher");
    expect(r.ok).toBe(true);
  });

  test("forget removes the session record entirely", () => {
    const c = new ConsentManager();
    c.setMode("sid", "never");
    c.forget("sid");
    // After forget, describe() returns the default mode.
    expect(c.describe("sid").mode).toBe("always");
  });

  test("legacy mode names are coerced to 'always'", async () => {
    const c = new ConsentManager();
    c.setMode("sid", "ask-first-per-session");
    expect(c.describe("sid").mode).toBe("always");
    c.setMode("sid", "ask-every-time");
    expect(c.describe("sid").mode).toBe("always");
    // And unknown modes fall through to 'always' (safe default for a
    // private-trust-network deployment).
    c.setMode("sid", "garbage");
    expect(c.describe("sid").mode).toBe("always");
  });

  test("defaultMode option takes effect for new sessions", async () => {
    const c = new ConsentManager({ defaultMode: "never" });
    const r = await c.check("fresh-sid", null, "w");
    expect(r.ok).toBe(false);
  });
});
