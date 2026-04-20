import { beforeEach, describe, expect, test } from "bun:test";
import { MirrorRegistry } from "@/hub/mirror";
import type { MirrorEventFrame } from "@/shared/types";

function makeFrame(
  sid: string,
  uuid: string,
  partial?: Partial<MirrorEventFrame>,
): MirrorEventFrame {
  return {
    action: "mirror_event",
    sid,
    uuid,
    kind: "user_prompt",
    ts: Date.now(),
    payload: { kind: "user_prompt", prompt: "hi", cwd: "/tmp" },
    ...partial,
  };
}

describe("MirrorRegistry", () => {
  let reg: MirrorRegistry;

  beforeEach(() => {
    reg = new MirrorRegistry({ transcriptRing: 50, retentionMs: 0 });
  });

  test("createSession returns an entry and token", () => {
    const r = reg.createSession("alice:u@h", "/home/alice");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.ownerAgent).toBe("alice:u@h");
    expect(r.entry.cwd).toBe("/home/alice");
    expect(r.token).toMatch(/^[0-9a-f]{32}$/);
    expect(r.restored).toBe(false);
    expect(reg.sessions.size).toBe(1);
  });

  test("createSession is idempotent for same sid + owner", () => {
    const r1 = reg.createSession("alice:u@h", "/home/alice", "sid-1");
    const r2 = reg.createSession("alice:u@h", "/home/alice", "sid-1");
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.restored).toBe(true);
    expect(r2.token).toBe(r1.token);
    expect(reg.sessions.size).toBe(1);
  });

  test("createSession rejects a different owner claiming an existing sid", () => {
    reg.createSession("alice:u@h", "/home/alice", "sid-1");
    const r2 = reg.createSession("bob:u@h", "/home/bob", "sid-1");
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error).toContain("different owner");
  });

  test("validateToken accepts correct token and rejects wrong token", () => {
    const r = reg.createSession("alice:u@h", "/home/alice");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const good = reg.validateToken(r.entry.sid, r.token);
    expect(good.ok).toBe(true);
    const bad = reg.validateToken(r.entry.sid, "deadbeef".repeat(4));
    expect(bad.ok).toBe(false);
  });

  test("validateToken returns status codes for missing / unknown session / missing token", () => {
    const missing = reg.validateToken("nope", "x".repeat(32));
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.status).toBe(404);

    const noTok = reg.validateToken("nope", undefined);
    expect(noTok.ok).toBe(false);
    if (noTok.ok) return;
    expect(noTok.status).toBe(401);
  });

  test("recordEvent appends to transcript and dedupes by uuid", () => {
    const r = reg.createSession("alice:u@h", "/home/alice");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sid = r.entry.sid;
    const fresh = reg.recordEvent(sid, makeFrame(sid, "u-1"));
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.duplicate).toBe(false);

    const dupe = reg.recordEvent(sid, makeFrame(sid, "u-1"));
    expect(dupe.ok).toBe(true);
    if (!dupe.ok) return;
    expect(dupe.duplicate).toBe(true);
    expect(r.entry.transcript).toHaveLength(1);
  });

  test("recordEvent ring-bounds the transcript", () => {
    const tiny = new MirrorRegistry({ transcriptRing: 3, retentionMs: 0 });
    const r = tiny.createSession("a:u@h", "/a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (let i = 0; i < 10; i++) {
      tiny.recordEvent(r.entry.sid, makeFrame(r.entry.sid, `u-${i}`));
    }
    expect(r.entry.transcript).toHaveLength(3);
    // The last three uuids survive.
    const uuids = r.entry.transcript.map((f) => f.uuid);
    expect(uuids).toEqual(["u-7", "u-8", "u-9"]);
  });

  test("addWatcher / removeWatcher manage the watcher set", () => {
    const r = reg.createSession("a:u@h", "/a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sid = r.entry.sid;
    const sent: string[] = [];
    const ws = { send: (s: string) => sent.push(s) };
    const watcher = {
      ws,
      wsIdentity: {
        /* plain */
      },
      id: "w-1",
      tokenType: "owner" as const,
    };
    reg.addWatcher(sid, watcher);
    expect(r.entry.watchers.size).toBe(1);
    reg.recordEvent(sid, makeFrame(sid, "u-1"));
    expect(sent).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: length asserted above
    const msg = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(msg.event).toBe("mirror:event");
    expect(msg.uuid).toBe("u-1");
    reg.removeWatcher(sid, watcher);
    expect(r.entry.watchers.size).toBe(0);
  });

  test("closeSession emits session_end event to watchers", () => {
    const r = reg.createSession("a:u@h", "/a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sid = r.entry.sid;
    const sent: string[] = [];
    reg.addWatcher(sid, {
      ws: { send: (s: string) => sent.push(s) },
      wsIdentity: {},
      id: "w-1",
      tokenType: "owner",
    });
    reg.closeSession(sid, "exit");
    const endEvent = sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .find((m) => {
        const p = m.payload as Record<string, unknown> | undefined;
        return m.event === "mirror:event" && p?.kind === "session_end";
      });
    expect(endEvent).toBeDefined();
    // recordEvent must refuse further events after close.
    const late = reg.recordEvent(sid, makeFrame(sid, "late"));
    expect(late.ok).toBe(false);
  });

  test("listOwnedBy returns summaries for owner's sessions only", () => {
    reg.createSession("a:u@h", "/a");
    reg.createSession("a:u@h", "/a2");
    reg.createSession("b:u@h", "/b");
    const mine = reg.listOwnedBy("a:u@h");
    expect(mine).toHaveLength(2);
    expect(mine.every((s) => s.owner_agent === "a:u@h")).toBe(true);
  });

  test("relayPaste sends frame and resolves when agent ack arrives", async () => {
    const r = reg.createSession("a:u@h", "/a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sid = r.entry.sid;
    const sent: string[] = [];
    reg.setAgentConnection(sid, {
      ws: { send: (s: string) => sent.push(s) },
      wsIdentity: {},
    });
    const pending = reg.relayPaste(sid, "hello world", "web", 5000);
    expect(sent).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: length asserted above
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame.event).toBe("mirror_paste");
    expect(frame.text).toBe("hello world");
    expect(typeof frame.requestId).toBe("string");
    reg.resolvePaste(sid, frame.requestId as string, {
      path: "/tmp/claude-net/pastes/paste-abc.txt",
    });
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe("/tmp/claude-net/pastes/paste-abc.txt");
  });

  test("relayPaste rejects with agent error when ack carries one", async () => {
    const r = reg.createSession("a:u@h", "/a");
    if (!r.ok) return;
    const sid = r.entry.sid;
    const sent: string[] = [];
    reg.setAgentConnection(sid, {
      ws: { send: (s: string) => sent.push(s) },
      wsIdentity: {},
    });
    const pending = reg.relayPaste(sid, "x", "web", 5000);
    // biome-ignore lint/style/noNonNullAssertion: send collected above
    const requestId = (JSON.parse(sent[0]!) as { requestId: string }).requestId;
    reg.resolvePaste(sid, requestId, { error: "disk full" });
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("disk full");
    expect(result.status).toBe(502);
  });

  test("relayPaste times out when agent never acks", async () => {
    const r = reg.createSession("a:u@h", "/a");
    if (!r.ok) return;
    const sid = r.entry.sid;
    reg.setAgentConnection(sid, {
      ws: { send: () => {} },
      wsIdentity: {},
    });
    const result = await reg.relayPaste(sid, "x", "web", 30);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(504);
    expect(result.error).toContain("did not respond");
  });

  test("relayPaste rejects when session has no connected agent", async () => {
    const r = reg.createSession("a:u@h", "/a");
    if (!r.ok) return;
    const result = await reg.relayPaste(r.entry.sid, "x", "web", 500);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(503);
  });

  test("dashboard broadcast fires on session lifecycle", () => {
    const events: { event: string }[] = [];
    reg.setDashboardBroadcast((e) => events.push(e as { event: string }));
    const r = reg.createSession("a:u@h", "/a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    reg.closeSession(r.entry.sid);
    const names = events.map((e) => e.event);
    expect(names).toContain("mirror:session_started");
    expect(names).toContain("mirror:session_ended");
  });
});
