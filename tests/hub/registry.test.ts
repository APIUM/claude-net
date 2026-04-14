import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Registry } from "@/hub/registry";

function mockWs() {
  const sent: string[] = [];
  return {
    send(data: string) {
      sent.push(data);
    },
    sent,
  };
}

describe("Registry", () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry({ disconnectTimeoutMs: 100 });
  });

  afterEach(() => {
    // Clear any pending timeouts
    for (const entry of registry.disconnected.values()) {
      clearTimeout(entry.timeoutId);
    }
  });

  test("register an agent and verify it appears in list", () => {
    const ws = mockWs();
    const result = registry.register("test@host", ws);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.fullName).toBe("test@host");
    expect(result.entry.shortName).toBe("test");
    expect(result.entry.host).toBe("host");

    const agents = registry.list();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.name).toBe("test@host");
    expect(agents[0]?.status).toBe("online");
  });

  test("register duplicate name with different WS returns error", () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    registry.register("test@host", ws1);
    const result = registry.register("test@host", ws2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("already registered");
  });

  test("re-register same name with same WS succeeds (reconnect)", () => {
    const ws = mockWs();
    registry.register("test@host", ws);
    const result = registry.register("test@host", ws);
    expect(result.ok).toBe(true);
  });

  test("unregister moves agent to disconnected when it has teams", () => {
    const ws = mockWs();
    registry.register("test@host", ws);
    const entry = registry.getByFullName("test@host");
    entry?.teams.add("myteam");

    registry.unregister("test@host");

    expect(registry.agents.has("test@host")).toBe(false);
    expect(registry.disconnected.has("test@host")).toBe(true);

    const agents = registry.list();
    const offline = agents.find((a) => a.name === "test@host");
    expect(offline?.status).toBe("offline");
  });

  test("unregister agent with no teams does not track in disconnected", () => {
    const ws = mockWs();
    registry.register("test@host", ws);
    registry.unregister("test@host");

    expect(registry.disconnected.has("test@host")).toBe(false);
    expect(registry.list()).toHaveLength(0);
  });

  test("reconnect within timeout restores team memberships", () => {
    const ws1 = mockWs();
    registry.register("test@host", ws1);
    const entry = registry.getByFullName("test@host");
    entry?.teams.add("teamA");

    registry.unregister("test@host");
    expect(registry.disconnected.has("test@host")).toBe(true);

    const ws2 = mockWs();
    const result = registry.register("test@host", ws2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restored).toBe(true);
    expect(result.entry.teams.has("teamA")).toBe(true);
    expect(registry.disconnected.has("test@host")).toBe(false);
  });

  test("timeout expires removes agent from disconnected", async () => {
    let cleanupCalled = false;
    registry.setTimeoutCleanup(() => {
      cleanupCalled = true;
    });

    const ws = mockWs();
    registry.register("test@host", ws);
    const entry = registry.getByFullName("test@host");
    entry?.teams.add("teamA");

    registry.unregister("test@host");
    expect(registry.disconnected.has("test@host")).toBe(true);

    // Wait for the 100ms timeout
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(registry.disconnected.has("test@host")).toBe(false);
    expect(cleanupCalled).toBe(true);
  });

  test("resolve by full name returns exact match", () => {
    const ws = mockWs();
    registry.register("test@host", ws);
    const result = registry.resolve("test@host");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.fullName).toBe("test@host");
    }
  });

  test("resolve by short name with single match", () => {
    const ws = mockWs();
    registry.register("test@host", ws);
    const result = registry.resolve("test");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.fullName).toBe("test@host");
    }
  });

  test("resolve by ambiguous short name returns error", () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    registry.register("test@host1", ws1);
    registry.register("test@host2", ws2);
    const result = registry.resolve("test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Multiple agents match 'test'");
      expect(result.error).toContain("test@host1");
      expect(result.error).toContain("test@host2");
    }
  });

  test("resolve nonexistent agent returns error", () => {
    const result = registry.resolve("nobody@host");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not online");
    }
  });

  test("getByFullName returns entry or null", () => {
    const ws = mockWs();
    registry.register("test@host", ws);
    expect(registry.getByFullName("test@host")).not.toBeNull();
    expect(registry.getByFullName("nope@host")).toBeNull();
  });
});
