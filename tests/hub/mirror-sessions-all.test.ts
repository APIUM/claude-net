// Covers GET /api/mirror/sessions/all — returns every session with its
// owner token + ready-to-click mirror URL. Used by the dashboard on a
// trusted internal network.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MirrorRegistry, mirrorPlugin } from "@/hub/mirror";
import { Elysia } from "elysia";

function startHub() {
  const reg = new MirrorRegistry({ transcriptRing: 100, retentionMs: 0 });
  const app = new Elysia().use(mirrorPlugin({ mirrorRegistry: reg, port: 0 }));
  app.listen(0);
  // biome-ignore lint/style/noNonNullAssertion: listen guarantees server
  const port = app.server!.port;
  return { port, stop: () => app.stop(), reg };
}

describe("GET /api/mirror/sessions/all", () => {
  let hub: ReturnType<typeof startHub>;

  beforeEach(() => {
    hub = startHub();
  });

  afterEach(() => {
    hub.stop();
  });

  test("returns empty list when no sessions exist", async () => {
    const r = await fetch(
      `http://localhost:${hub.port}/api/mirror/sessions/all`,
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });

  test("returns summary + owner_token + mirror_url for each session", async () => {
    const c1 = hub.reg.createSession("a:u@h", "/a");
    const c2 = hub.reg.createSession("b:u@h", "/b");
    expect(c1.ok && c2.ok).toBe(true);
    if (!c1.ok || !c2.ok) return;

    const r = await fetch(
      `http://localhost:${hub.port}/api/mirror/sessions/all`,
    );
    expect(r.status).toBe(200);
    const list = (await r.json()) as Array<{
      sid: string;
      owner_agent: string;
      owner_token: string;
      mirror_url: string;
      watcher_count: number;
      transcript_len: number;
    }>;
    expect(list).toHaveLength(2);
    const sids = list.map((s) => s.sid).sort();
    expect(sids).toEqual([c1.entry.sid, c2.entry.sid].sort());
    for (const s of list) {
      expect(s.owner_token).toMatch(/^[0-9a-f]{32}$/);
      expect(s.mirror_url).toContain(`/mirror/${s.sid}#token=${s.owner_token}`);
    }
  });

  test("mirror_url scheme follows X-Forwarded-Proto", async () => {
    const c = hub.reg.createSession("a:u@h", "/a");
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const r = await fetch(
      `http://localhost:${hub.port}/api/mirror/sessions/all`,
      {
        headers: { "x-forwarded-proto": "https" },
      },
    );
    const list = (await r.json()) as Array<{ mirror_url: string }>;
    expect(list[0]?.mirror_url).toStartWith("https://");
  });
});
