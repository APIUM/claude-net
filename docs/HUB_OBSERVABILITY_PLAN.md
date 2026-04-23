# Hub Observability Plan

**Goal:** Every significant hub event is captured as structured data in a bounded in-memory ring buffer, queryable via REST API and a new MCP tool so agents (and humans via dashboard) can inspect what's happening without SSH access or log file tailing.

## What gets logged

Every entry: `{ ts: number, event: string, data: Record<string, unknown> }`

| Event | Trigger | Key data fields |
|---|---|---|
| `agent.registered` | Successful register | `fullName`, `channelCapable`, `pluginVersion`, `restored`, `renamedFrom?` |
| `agent.disconnected` | WS close handler | `fullName`, `reason: "close" \| "evicted"` |
| `agent.evicted` | Ping tick stale threshold | `fullName`, `lastPongAt`, `silentForMs` |
| `agent.upgraded` | Version mismatch on register | `fullName`, `reportedVersion`, `currentVersion` |
| `message.sent` | routeDirect completes | `from`, `to`, `messageId`, `outcome`, `reason?`, `elapsedMs` |
| `message.broadcast` | routeBroadcast completes | `from`, `messageId`, `deliveredTo`, `skippedNoChannel` |
| `message.team` | routeTeam completes | `from`, `team`, `messageId`, `deliveredTo`, `skippedNoChannel` |
| `ping.tick` | Ping interval fires | `agentCount`, `evictedCount` (summary, not per-agent) |
| `nudge.fired` | Plugin reports nudge delivery | `fullName`, `nudgeType: "channels-off" \| "upgrade" \| "rename"` |

Not logged: individual ping/pong frames (too noisy — the `ping.tick` summary covers it), MCP tool calls (those are agent-internal), mirror events (separate subsystem with its own transport).

## Storage

**In-memory ring buffer.** Fixed capacity — suggest 10,000 entries. FIFO eviction. No persistence across hub restart (deliberate — this is runtime observability, not an audit log).

Implementation: a simple array with a write pointer, or use a pre-allocated circular buffer. One module: `src/hub/event-log.ts`.

```typescript
export interface HubEvent {
  ts: number;          // Date.now()
  event: string;       // dot-separated category
  data: Record<string, unknown>;
}

export class EventLog {
  private buffer: (HubEvent | null)[];
  private head = 0;
  private count = 0;

  constructor(capacity = 10_000) { ... }
  push(event: string, data: Record<string, unknown>): void { ... }
  query(opts: { event?: string; since?: number; limit?: number }): HubEvent[] { ... }
  summary(since?: number): Record<string, number> { ... }
}
```

## Query API

Two new REST endpoints under `/api/`:

**`GET /api/events`** — paginated event query.

Query params:
- `event` — filter by event name (prefix match: `agent` matches `agent.registered`, `agent.disconnected`, etc.)
- `since` — epoch ms, return events after this timestamp
- `limit` — max entries returned (default 100, max 1000)
- `agent` — filter by agent fullName (substring match on `from`, `to`, or `fullName` in data)

Response: `{ events: HubEvent[], count: number, oldest_ts: number, capacity: number }`

**`GET /api/events/summary`** — counts by event type.

Query params:
- `since` — epoch ms window (default: last hour)

Response: `{ counts: Record<string, number>, window_ms: number, total: number }`

## MCP tool

New tool on the plugin: **`hub_events(filter?, since_minutes?, limit?)`**

- Plugin sends a new `{ action: "query_events", filter?, since?, limit?, requestId }` frame to the hub.
- Hub queries the EventLog, responds with the matching events.
- Plugin returns them as a JSON tool result to the LLM.

This lets any Claude agent ask "what happened on the hub recently?" without needing REST access. Useful for debugging delivery failures in-session: "my message to X didn't arrive — call `hub_events` filtered to `message.sent` in the last 5 minutes."

Tool description for the LLM:
> "Query recent hub events — agent connections/disconnections, message delivery outcomes, evictions, version mismatches. Use when diagnosing delivery failures or checking system health."

## Dashboard integration

The dashboard already has a "Message log" view. Extend it:
- Add a "System events" tab/section showing non-message events (agent.evicted, agent.upgraded, ping.tick summaries).
- Or: unify into one chronological log with event-type color coding.
- Source: existing dashboard WS already receives `agent:connected`, `agent:disconnected`, `message:routed` — extend to also receive a `system:event` broadcast for the new event types. The EventLog push also broadcasts to dashboard clients.

## Integration points

- `src/hub/index.ts` — create the EventLog instance in `createHub`, pass it to modules that need to emit events.
- `src/hub/ws-plugin.ts` — emit `agent.registered` on register, emit on send/broadcast/team outcomes.
- `src/hub/router.ts` — OR emit from ws-plugin after receiving the router result (keeps router pure, ws-plugin is the integration layer). Prefer this.
- `src/hub/index.ts` ping tick — emit `ping.tick` summary and `agent.evicted` per eviction.
- `src/hub/api.ts` — add the two REST endpoints.
- `src/hub/ws-plugin.ts` — add `query_events` frame handler.
- `src/plugin/plugin.ts` — add `hub_events` tool definition + `mapToolToFrame` entry.

## Phasing

**Phase 1: EventLog module + REST API + emit from existing code paths.**
- Create `src/hub/event-log.ts` with `EventLog` class.
- Wire into `createHub`, pass to ws-plugin and the ping tick.
- Emit events from: register handler, send/broadcast/team handlers, ping tick, WS close handler.
- Add `GET /api/events` and `GET /api/events/summary`.
- Tests: unit tests for EventLog (push, query, capacity eviction, filtering); integration test hitting the REST endpoints.

**Phase 2: MCP tool + dashboard.**
- Add `hub_events` tool to plugin.
- Add `query_events` frame handler to ws-plugin.
- Dashboard: broadcast system events to dashboard WS clients; render in UI.

## Non-goals

- Persistent storage / log shipping. This is in-memory, ephemeral, bounded.
- Per-message content logging. Events log metadata (from, to, outcome), not message bodies.
- Authentication/authorization on the query API. Matches the existing hub posture (no auth on any endpoint).
- Distributed tracing / correlation IDs across hub hops. Single hub, single process.

## Estimated effort

- Phase 1: ~2–3 hours (EventLog is small; wiring emit calls is mechanical; REST endpoints follow existing apiPlugin pattern).
- Phase 2: ~1.5 hours (MCP tool is one definition + one frame handler; dashboard is a UI addition).

---
*Drafted 2026-04-23.*
