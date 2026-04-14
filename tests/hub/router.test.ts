import { beforeEach, describe, expect, test } from "bun:test";
import { Registry } from "@/hub/registry";
import { Router } from "@/hub/router";
import { Teams } from "@/hub/teams";
import type { InboundMessageFrame } from "@/shared/types";

function mockWs() {
  const sent: InboundMessageFrame[] = [];
  return {
    send(data: string) {
      sent.push(JSON.parse(data) as InboundMessageFrame);
    },
    sent,
  };
}

describe("Router", () => {
  let registry: Registry;
  let teams: Teams;
  let router: Router;

  beforeEach(() => {
    registry = new Registry();
    teams = new Teams(registry);
    router = new Router(registry, teams);
  });

  describe("routeDirect", () => {
    test("delivers to recipient WS", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("alice@host", wsA);
      registry.register("bob@host", wsB);

      const result = router.routeDirect(
        "alice@host",
        "bob@host",
        "hello",
        "message",
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.delivered).toBe(true);
      expect(result.message_id).toBeTruthy();

      expect(wsB.sent).toHaveLength(1);
      const msg = wsB.sent[0];
      expect(msg).toBeDefined();
      expect(msg?.event).toBe("message");
      expect(msg?.from).toBe("alice@host");
      expect(msg?.to).toBe("bob@host");
      expect(msg?.content).toBe("hello");
      expect(msg?.message_id).toBeTruthy();
      expect(msg?.timestamp).toBeTruthy();
    });

    test("delivers to short name recipient", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("alice@host", wsA);
      registry.register("bob@host", wsB);

      const result = router.routeDirect("alice@host", "bob", "hi", "message");
      expect(result.ok).toBe(true);
      expect(wsB.sent).toHaveLength(1);
    });

    test("sends reply with reply_to", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("alice@host", wsA);
      registry.register("bob@host", wsB);

      const result = router.routeDirect(
        "alice@host",
        "bob@host",
        "thanks",
        "reply",
        "msg-123",
      );
      expect(result.ok).toBe(true);
      expect(wsB.sent[0]?.reply_to).toBe("msg-123");
      expect(wsB.sent[0]?.type).toBe("reply");
    });

    test("returns error for offline agent", () => {
      const wsA = mockWs();
      registry.register("alice@host", wsA);

      const result = router.routeDirect(
        "alice@host",
        "bob@host",
        "hello",
        "message",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("not online");
      }
    });
  });

  describe("routeBroadcast", () => {
    test("delivers to all except sender", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      const wsC = mockWs();
      registry.register("alice@host", wsA);
      registry.register("bob@host", wsB);
      registry.register("carol@host", wsC);

      const result = router.routeBroadcast("alice@host", "announcement");
      expect(result.ok).toBe(true);
      expect(result.delivered_to).toBe(2);

      expect(wsA.sent).toHaveLength(0); // sender excluded
      expect(wsB.sent).toHaveLength(1);
      expect(wsC.sent).toHaveLength(1);
      expect(wsB.sent[0]?.from).toBe("alice@host");
      expect(wsB.sent[0]?.to).toBe("broadcast");
    });

    test("with 0 other agents returns delivered_to: 0", () => {
      const wsA = mockWs();
      registry.register("alice@host", wsA);

      const result = router.routeBroadcast("alice@host", "echo");
      expect(result.ok).toBe(true);
      expect(result.delivered_to).toBe(0);
    });
  });

  describe("routeTeam", () => {
    test("delivers to online team members except sender", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      const wsC = mockWs();
      registry.register("alice@host", wsA);
      registry.register("bob@host", wsB);
      registry.register("carol@host", wsC);

      teams.join("backend", "alice@host");
      teams.join("backend", "bob@host");
      teams.join("backend", "carol@host");

      const result = router.routeTeam(
        "alice@host",
        "backend",
        "team msg",
        "message",
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.delivered_to).toBe(2);

      expect(wsA.sent).toHaveLength(0);
      expect(wsB.sent).toHaveLength(1);
      expect(wsC.sent).toHaveLength(1);
      expect(wsB.sent[0]?.team).toBe("backend");
    });

    test("returns error for nonexistent team", () => {
      const wsA = mockWs();
      registry.register("alice@host", wsA);

      const result = router.routeTeam("alice@host", "nope", "msg", "message");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("does not exist");
      }
    });

    test("returns error when no online members", () => {
      const wsA = mockWs();
      registry.register("alice@host", wsA);

      // Create team with only offline member
      teams.join("backend", "offline@host");
      teams.join("backend", "alice@host");

      // Route from alice — offline@host is not registered, alice is sender (excluded)
      const result = router.routeTeam(
        "alice@host",
        "backend",
        "msg",
        "message",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("No online members");
      }
    });

    test("all routed messages have message_id, from, timestamp", () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register("alice@host", wsA);
      registry.register("bob@host", wsB);

      router.routeDirect("alice@host", "bob@host", "test", "message");
      const msg = wsB.sent[0];
      expect(msg).toBeDefined();
      expect(msg?.message_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(msg?.from).toBe("alice@host");
      expect(msg?.timestamp).toBeTruthy();
      // Verify timestamp is valid ISO
      expect(Number.isNaN(Date.parse(msg?.timestamp ?? ""))).toBe(false);
    });
  });
});
