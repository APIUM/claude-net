// claude-net-mirror-agent — long-running local daemon.
//
// Accepts hook POSTs from claude-net-mirror-push on 127.0.0.1, maintains one
// hub WebSocket per active Claude Code session, tails each session's JSONL
// transcript for reconciliation, and forwards deduped events to the hub.
//
// The mirror-agent is deliberately separate from both the claude process
// (so it survives restarts and /clear) and the claude-net MCP plugin (so a
// plugin crash can't take the agent down).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MirrorEventFrame } from "@/shared/types";
import { type RawHookPayload, ingestHook } from "./hook-ingest";
import { HubClient } from "./hub-client";
import { type TailHandle, tailJsonl } from "./jsonl-tail";

// ── Types ─────────────────────────────────────────────────────────────────

export interface AgentConfig {
  hubUrl: string;
  bindHost?: string;
  /** 0 = pick a random port. Default 0. */
  bindPort?: number;
  stateDir?: string;
  /** Idle shutdown window in ms; 0 disables. Default 30 min. */
  idleShutdownMs?: number;
  /** Session idle cleanup window in ms; 0 disables. Default 10 min. */
  sessionIdleMs?: number;
}

interface SessionState {
  sid: string;
  ownerAgent: string;
  cwd: string;
  transcriptPath: string | null;
  token: string | null;
  mirrorUrl: string | null;
  ws: HubClient | null;
  seenUuids: Set<string>;
  outbox: string[];
  tail: TailHandle | null;
  lastEventAt: number;
  closed: boolean;
}

export interface AgentHandle {
  port: number;
  stop(): Promise<void>;
  sessions: Map<string, SessionState>;
}

// ── Entry point ───────────────────────────────────────────────────────────

const DEFAULT_IDLE_SHUTDOWN_MS = 30 * 60 * 1000;
const DEFAULT_SESSION_IDLE_MS = 10 * 60 * 1000;
const OUTBOX_MAX = 4096;

export async function startAgent(config: AgentConfig): Promise<AgentHandle> {
  const hubUrl = config.hubUrl.replace(/\/+$/, "");
  const bindHost = config.bindHost ?? "127.0.0.1";
  const stateDir = config.stateDir ?? "/tmp/claude-net";
  const idleShutdownMs = config.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
  const sessionIdleMs = config.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;

  const sessions = new Map<string, SessionState>();
  let lastActivityAt = Date.now();

  // Ensure state dir exists.
  try {
    fs.mkdirSync(stateDir, { recursive: true });
  } catch (err) {
    log(`Failed to create state dir: ${String(err)}`);
  }

  // Bind server. Bun's serve/fetch API is used here; we import Bun lazily so
  // this file remains type-checkable outside Bun.
  const server = Bun.serve({
    hostname: bindHost,
    port: config.bindPort ?? 0,
    fetch: (req) => handleFetch(req),
  });

  if (bindHost !== "127.0.0.1" && bindHost !== "localhost") {
    log(`Refusing to start: bindHost must be loopback (got '${bindHost}')`);
    server.stop();
    throw new Error("mirror-agent must bind to loopback only");
  }

  writePortFile(stateDir, server.port);
  log(
    `mirror-agent listening on http://${bindHost}:${server.port} (hub=${hubUrl})`,
  );

  // Idle-shutdown watchdog.
  const idleTimer = setInterval(() => {
    const now = Date.now();
    // Clean up idle sessions.
    for (const s of sessions.values()) {
      if (!s.closed && now - s.lastEventAt > sessionIdleMs) {
        closeSession(s, "idle");
      }
    }
    // Process-level idle shutdown.
    if (
      idleShutdownMs > 0 &&
      sessions.size === 0 &&
      now - lastActivityAt > idleShutdownMs
    ) {
      log("idle shutdown");
      void stop();
    }
  }, 30_000);
  if (typeof idleTimer === "object" && "unref" in idleTimer) {
    idleTimer.unref();
  }

  async function handleFetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/hook") {
      return handleHookPost(req);
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({
        status: "ok",
        sessions: sessions.size,
        port: server.port,
      });
    }
    if (req.method === "GET" && url.pathname === "/sessions") {
      return Response.json(
        [...sessions.values()].map((s) => ({
          sid: s.sid,
          owner_agent: s.ownerAgent,
          cwd: s.cwd,
          mirror_url: s.mirrorUrl,
          last_event_at: new Date(s.lastEventAt).toISOString(),
          closed: s.closed,
        })),
      );
    }
    if (req.method === "POST" && url.pathname === "/stop") {
      void stop();
      return new Response("stopping", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }

  async function handleHookPost(req: Request): Promise<Response> {
    let payload: RawHookPayload;
    try {
      payload = (await req.json()) as RawHookPayload;
    } catch {
      return new Response("bad json", { status: 400 });
    }
    lastActivityAt = Date.now();

    const ingested = ingestHook(payload);
    if (!ingested) {
      return new Response("ignored", { status: 202 });
    }

    const sid = ingested.sid;
    let session = sessions.get(sid);
    if (!session) {
      session = await openSession(sid, ingested.cwd, ingested.transcriptPath);
      if (!session) {
        return new Response("hub unavailable", { status: 503 });
      }
    } else if (
      ingested.transcriptPath &&
      session.transcriptPath !== ingested.transcriptPath
    ) {
      // Transcript path first becomes known partway through; start tail then.
      session.transcriptPath = ingested.transcriptPath;
      startTailIfNeeded(session);
    }

    queueEvent(session, ingested.frame);

    // Close on session_end.
    if (ingested.frame.kind === "session_end") {
      closeSession(session, "event");
    }

    return new Response("ok", { status: 202 });
  }

  async function openSession(
    sid: string,
    cwd: string | undefined,
    transcriptPath: string | undefined,
  ): Promise<SessionState | null> {
    const ownerAgent = deriveOwnerAgent(cwd ?? process.cwd());
    let createResponse: {
      sid: string;
      owner_token: string;
      mirror_url: string;
    };
    try {
      const res = await fetch(`${hubUrl}/api/mirror/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner_agent: ownerAgent, cwd: cwd ?? "", sid }),
      });
      if (!res.ok) {
        log(`session create failed: HTTP ${res.status} ${await res.text()}`);
        return null;
      }
      createResponse = (await res.json()) as typeof createResponse;
    } catch (err) {
      log(`session create threw: ${String(err)}`);
      return null;
    }

    const wsUrl = toWsUrl(
      hubUrl,
      createResponse.sid,
      createResponse.owner_token,
    );
    const session: SessionState = {
      sid,
      ownerAgent,
      cwd: cwd ?? "",
      transcriptPath: transcriptPath ?? null,
      token: createResponse.owner_token,
      mirrorUrl: createResponse.mirror_url,
      ws: null,
      seenUuids: new Set(),
      outbox: [],
      tail: null,
      lastEventAt: Date.now(),
      closed: false,
    };
    sessions.set(sid, session);

    const client = new HubClient({
      url: wsUrl,
      logPrefix: `claude-net/mirror:${sid}`,
      onOpen: () => {
        // Flush any buffered frames.
        const outbox = session.outbox;
        session.outbox = [];
        for (const frame of outbox) client.send(frame);
      },
      onMessage: (raw) => handleHubMessage(session, raw),
      onClose: (code, reason) => {
        log(`[${sid}] WS closed (${code}) ${reason}`);
      },
      onError: (err) => {
        log(`[${sid}] WS error: ${err.message}`);
      },
    });
    session.ws = client;
    client.start();

    startTailIfNeeded(session);

    log(
      `[${sid}] session opened for ${ownerAgent}; url=${createResponse.mirror_url}`,
    );
    return session;
  }

  function startTailIfNeeded(session: SessionState): void {
    if (session.tail || !session.transcriptPath) return;
    session.tail = tailJsonl(session.transcriptPath, {
      onRecord: (rec) => {
        // Reconciliation: we don't emit anything here in M1 — the hook stream
        // is the primary event source. We only track the JSONL for future
        // phases (gap detection, restart recovery). Dedupe by uuid so if we
        // later start emitting from here, duplicates are suppressed.
        if (typeof rec.uuid === "string") {
          session.seenUuids.add(rec.uuid);
        }
      },
      onError: (err) => {
        log(`[${session.sid}] JSONL tail error: ${err.message}`);
      },
    });
  }

  function queueEvent(session: SessionState, frame: MirrorEventFrame): void {
    if (session.closed) return;
    session.lastEventAt = Date.now();
    if (session.seenUuids.has(frame.uuid)) return;
    session.seenUuids.add(frame.uuid);

    const json = JSON.stringify(frame);
    if (session.ws?.isOpen()) {
      session.ws.send(json);
    } else {
      if (session.outbox.length >= OUTBOX_MAX) {
        // Drop oldest.
        session.outbox.splice(0, session.outbox.length - OUTBOX_MAX + 1);
        log(`[${session.sid}] outbox full — dropping oldest`);
      }
      session.outbox.push(json);
    }
  }

  function handleHubMessage(session: SessionState, raw: string): void {
    let data: { event?: string };
    try {
      data = JSON.parse(raw) as { event?: string };
    } catch {
      return;
    }
    // Inject frames land in M2. For M1 we log if the hub sends anything.
    if (data.event === "mirror_inject") {
      log(
        `[${session.sid}] received inject frame; injection lands in Phase M2`,
      );
    }
  }

  function closeSession(session: SessionState, reason: string): void {
    if (session.closed) return;
    session.closed = true;
    log(`[${session.sid}] closing (${reason})`);
    if (session.tail) {
      session.tail.stop();
      session.tail = null;
    }
    if (session.ws) {
      session.ws.stop();
      session.ws = null;
    }
    // Fire-and-forget hub close.
    if (session.token) {
      const url = `${hubUrl}/api/mirror/${encodeURIComponent(
        session.sid,
      )}/close?t=${encodeURIComponent(session.token)}`;
      fetch(url, { method: "POST" }).catch(() => {
        /* best effort */
      });
    }
    sessions.delete(session.sid);
  }

  async function stop(): Promise<void> {
    clearInterval(idleTimer);
    for (const s of [...sessions.values()]) {
      closeSession(s, "shutdown");
    }
    server.stop();
    removePortFile(stateDir);
  }

  return {
    port: server.port,
    stop,
    sessions,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function toWsUrl(hubUrl: string, sid: string, token: string): string {
  const wsBase = hubUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return `${wsBase}/ws/mirror/${encodeURIComponent(sid)}?t=${encodeURIComponent(
    token,
  )}&as=agent`;
}

function deriveOwnerAgent(cwd: string): string {
  const session = path.basename(cwd || ".") || "session";
  const user = os.userInfo().username || process.env.USER || "user";
  const host = os.hostname() || "host";
  return `${session}:${user}@${host}`;
}

function writePortFile(stateDir: string, port: number): void {
  const uid = process.getuid?.() ?? 0;
  const portFile = path.join(stateDir, `mirror-agent-${uid}.port`);
  try {
    fs.writeFileSync(portFile, String(port), { mode: 0o600 });
  } catch (err) {
    log(`Failed to write port file: ${String(err)}`);
  }
}

function removePortFile(stateDir: string): void {
  const uid = process.getuid?.() ?? 0;
  const portFile = path.join(stateDir, `mirror-agent-${uid}.port`);
  try {
    fs.unlinkSync(portFile);
  } catch {
    // ignore
  }
}

function log(msg: string): void {
  process.stderr.write(`[claude-net/mirror] ${msg}\n`);
}

// ── Run when invoked directly ─────────────────────────────────────────────

if (import.meta.main) {
  const hub = process.env.CLAUDE_NET_HUB || "http://localhost:4815";
  const portEnv = process.env.CLAUDE_NET_MIRROR_AGENT_PORT;
  const bindPort = portEnv ? Number.parseInt(portEnv, 10) || 0 : 0;
  startAgent({ hubUrl: hub, bindPort }).catch((err: unknown) => {
    process.stderr.write(
      `[claude-net/mirror] startup failed: ${String(err)}\n`,
    );
    process.exit(1);
  });
}
