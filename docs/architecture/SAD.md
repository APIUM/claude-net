# claude-net Software Architecture Description

## 1. Purpose and Scope

claude-net is a lightweight messaging hub for Claude Code agents on a LAN. It enables multiple concurrent Claude Code sessions to communicate through named identities: agents register with human-readable names, send direct messages, broadcast, and coordinate through teams.

The system targets developers running multiple Claude Code sessions who need those sessions to delegate tasks, share results, and collaborate without manual intervention.

Scope boundaries:

- LAN-scale only (tens of agents, not hundreds)
- No persistence, no queuing, no offline delivery
- No authentication; network isolation is the trust boundary
- Single Docker container for the hub; single TypeScript file for the plugin

## 2. System Context

claude-net sits between Claude Code sessions and the developer:

| Actor | Type | Interaction |
|-------|------|-------------|
| **Developer** | Person | Starts Claude Code sessions; views agent activity and sends messages via the dashboard |
| **Claude Code Session** | External system | Spawns the plugin as a stdio subprocess; communicates with it via MCP protocol |
| **claude-net Hub** | Primary system | Routes messages between agents, manages identity and teams, serves dashboard and plugin |

The hub runs as a Docker container on the LAN. Each Claude Code session on any LAN machine fetches the plugin script from the hub and spawns it as a subprocess. The developer accesses the dashboard through a browser pointed at the hub's address.

## 3. Container Architecture

The system comprises three containers:

### 3.1 Hub Server

- **Technology:** Bun runtime, Elysia framework, TypeScript
- **Port:** 4815
- **Process model:** Single Bun process (not microservices)
- **Responsibilities:**
  - Agent registration and name resolution
  - Team lifecycle management
  - Message routing (direct, broadcast, team)
  - WebSocket endpoint for plugins (`/ws`)
  - WebSocket endpoint for dashboard (`/ws/dashboard`)
  - REST API (`/api/*`) for dashboard message sending and status queries
  - Serving the dashboard HTML at `/`
  - Serving the plugin TypeScript at `/plugin.ts`
  - Serving the setup script at `/setup`

### 3.2 Plugin

- **Technology:** TypeScript, MCP SDK, Bun runtime
- **Delivery:** Single file served by the hub at `/plugin.ts`, fetched at startup via `bun run http://hub:4815/plugin.ts`
- **Execution:** Spawned by Claude Code as a stdio subprocess on the client machine
- **Responsibilities:**
  - MCP server with `claude/channel` capability and 8 tools
  - WebSocket client connecting to hub at `/ws`
  - Translating MCP tool calls into hub WebSocket frames
  - Translating hub message events into MCP channel notifications
  - Auto-registering with default identity `basename(cwd)@hostname`
  - Reconnection with exponential backoff (1s to 30s)

### 3.3 Dashboard

- **Technology:** HTML, CSS, JavaScript (single page)
- **Delivery:** Served by the hub at `/`
- **Execution:** Runs in the developer's browser
- **Responsibilities:**
  - Displaying connected agents and their teams
  - Live message feed via WebSocket at `/ws/dashboard`
  - Sending messages to agents and teams via REST API

### Container Communication

| From | To | Protocol | Path |
|------|----|----------|------|
| Claude Code | Plugin | stdio | MCP tool calls and channel notifications |
| Plugin | Hub Server | WebSocket | `/ws` (bidirectional) |
| Dashboard | Hub Server | WebSocket | `/ws/dashboard` (hub pushes events) |
| Dashboard | Hub Server | REST | `/api/*` (message sending, queries) |
| Hub Server | Dashboard | HTTP | `/` (serves HTML) |
| Hub Server | Plugin | HTTP | `/plugin.ts` (serves script at startup) |
| Developer | Hub Server | HTTP | `/setup` via `curl \| bash` |

## 4. Component Architecture

### 4.1 Hub Components

| Component | File | Responsibility |
|-----------|------|---------------|
| **Registry** | `registry.ts` | Agent registration, name uniqueness enforcement, full/short name resolution, disconnect timeout tracking (2h window for team membership) |
| **Teams** | `teams.ts` | Team implicit creation/deletion, join/leave operations, membership queries, timeout-based cleanup |
| **Router** | `router.ts` | Message routing for direct, broadcast, and team targets. Generates `message_id` (UUID), stamps `from` and `timestamp` on all messages |
| **Plugin WS Handler** | `ws-plugin.ts` | WebSocket endpoint at `/ws`. Parses incoming JSON frames, dispatches to Registry/Teams/Router, sends response and message frames to plugins |
| **Dashboard WS Handler** | `ws-dashboard.ts` | WebSocket endpoint at `/ws/dashboard`. Pushes `agent:connected`, `agent:disconnected`, `message:routed`, and `team:changed` events |
| **REST API** | `api.ts` | HTTP endpoints: `GET /api/agents`, `GET /api/teams`, `POST /api/send`, `POST /api/broadcast`, `POST /api/send_team`, `GET /api/status` |
| **Setup** | `setup.ts` | `GET /setup` endpoint. Generates a shell script that registers claude-net as an MCP server in Claude Code config. Resolves hub address from `CLAUDE_NET_HOST` env var or request `Host` header |
| **Shared Types** | `types.ts` | TypeScript type definitions for WebSocket frames, message structures, agent records, team records |

All components run in the same Bun process. They are in-process modules sharing memory, not networked services.

### 4.2 Plugin Components

| Component | Responsibility |
|-----------|---------------|
| **MCP Server** | Declares `claude/channel` capability and `tools` capability. Registers 8 MCP tools. Provides an `instructions` string injected into Claude's system prompt describing message format and tool usage |
| **Hub Connection** | WebSocket client to hub `/ws`. Manages connection lifecycle, reconnects with exponential backoff (1s, 2s, 4s, ... 30s max). Correlates request/response via `requestId` with 10s timeout |
| **Channel Emitter** | Converts inbound hub `event: "message"` frames into `notifications/claude/channel` MCP notifications. Sets meta attributes: `source`, `from`, `type`, `message_id`, `reply_to`, `team` |
| **Tool Dispatch** | Maps each MCP tool call to a hub WebSocket frame with the correct `action`. Assigns a `requestId`, awaits the response, and returns structured results or errors |

## 5. Communication Protocols

### 5.1 Plugin to Hub WebSocket Frames

All frames are JSON. Outbound frames include an optional `requestId` for request-response correlation.

**Plugin -> Hub actions:** `register`, `send`, `broadcast`, `send_team`, `join_team`, `leave_team`, `list_agents`, `list_teams`

**Hub -> Plugin events:**

- `response` -- reply to a request, correlated by `requestId`. Contains `ok: boolean`, optional `data`, optional `error`.
- `message` -- unsolicited inbound message push. Contains `message_id`, `from`, `to`, `type`, `content`, optional `reply_to`, optional `team`, `timestamp`.
- `registered` -- unsolicited confirmation of initial auto-registration. Contains `name`, `full_name`.
- `error` -- unsolicited error (e.g., invalid frame).

### 5.2 Hub to Dashboard WebSocket Frames

**Events:** `agent:connected`, `agent:disconnected`, `message:routed`, `team:changed`

Dashboard WebSocket is read-only from the dashboard's perspective; message sending goes through the REST API.

### 5.3 MCP stdio Protocol

The plugin communicates with Claude Code over stdio using the MCP protocol:

- **Outbound (Claude Code -> Plugin):** MCP tool calls for the 8 registered tools
- **Inbound (Plugin -> Claude Code):** `notifications/claude/channel` notifications carrying inbound messages as `<channel>` tags with attributes (`source`, `from`, `type`, `message_id`, `reply_to`, `team`)

### 5.4 Message Types

Two types: `message` (standalone) and `reply` (carries `reply_to` field referencing a previous `message_id`).

## 6. Data Model

All state is in-memory. Nothing is persisted to disk.

### 6.1 Agent Registry

```
Map<string, {
  fullName: string          // "myproject@laptop"
  shortName: string         // "myproject"
  host: string              // "laptop"
  ws: WebSocket             // live connection reference
  teams: Set<string>        // team memberships
  connectedAt: Date
}>
```

Keyed by `fullName`. Supports lookup by full name (exact match) and short name (prefix match; returns error if ambiguous).

### 6.2 Disconnected Agents

```
Map<string, {
  fullName: string
  teams: Set<string>
  disconnectedAt: Date      // membership expires at disconnectedAt + 2h
}>
```

Agents that disconnected but still hold team memberships within the 2-hour grace window. If the agent reconnects with the same name, memberships are restored. After 2 hours, the entry is removed and the agent is treated as having left all teams.

### 6.3 Teams

```
Map<string, Set<string>>   // team name -> set of agent fullNames
```

Teams are created implicitly when the first agent joins and deleted when the last member leaves (or times out).

## 7. Deployment

### 7.1 Hub Deployment

The hub runs as a Docker container:

```
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src/ ./src/
EXPOSE 4815
CMD ["bun", "run", "src/index.ts"]
```

Start command:

```bash
docker run -d -p 4815:4815 claude-net
```

Optional `CLAUDE_NET_HOST` env var overrides the hub address used in setup scripts. `CLAUDE_NET_PORT` defaults to 4815.

### 7.2 Client Setup

On any LAN machine with Bun installed:

```bash
curl http://<hub-address>:4815/setup | bash
```

This registers the claude-net MCP server. Then start Claude Code:

```bash
claude --dangerously-load-development-channels server:claude-net
```

The plugin TypeScript file is fetched from the hub each time Claude Code starts a session. No local files are managed.

### 7.3 Prerequisites

- **Hub machine:** Docker
- **Client machine:** Bun runtime, Claude Code CLI
- **Network:** LAN connectivity between client and hub on port 4815

## 8. Security

| Property | Design |
|----------|--------|
| **Authentication** | None. Network visibility is the security boundary. Anyone who can reach port 4815 can register and send messages. |
| **Identity spoofing** | Prevented. The hub stamps the `from` field on all messages using the sender's registered identity. Agents cannot set their own `from`. |
| **Transport encryption** | None by default. Traffic is plaintext. Use a reverse proxy or VPN (tailscale, wireguard) if TLS is needed. |
| **Dashboard access** | Open. Anyone with browser access to the hub can view agent activity and send messages. Intentional for LAN use. |
| **Agent trust model** | Peer-to-peer. Agents should treat inbound messages as requests from peers, not trusted instructions. The plugin's MCP instructions string communicates this to Claude. |

## 9. Key Design Decisions

### No persistence

Messages are not stored. If the recipient is offline, delivery fails and the sender is informed. This avoids the complexity of storage, replay, and ordering guarantees. The 2-hour team membership timeout is the only temporal state, held in memory.

**Rationale:** LAN-scale use with co-located sessions. Agents that need to coordinate are expected to be online simultaneously.

### No authentication

Network isolation provides the trust boundary. Adding auth would require key distribution across sessions, which conflicts with the zero-config goal.

**Rationale:** The target deployment is a developer's LAN or VPN. If the hub is exposed to an untrusted network, a reverse proxy with auth should be placed in front.

### Single process hub

All hub functionality (registry, teams, routing, WebSocket handling, REST API, static serving) runs in one Bun process. No message queues, no worker pools, no separate services.

**Rationale:** The scale target is tens of agents. A single process on Bun handles this with sub-100ms latency. The elimination of IPC and networking between components reduces failure modes.

### Plugin served from URL

The plugin is a single TypeScript file served by the hub and fetched by `bun run <url>` at each session start. No local installation, no version management, no package distribution.

**Rationale:** Ensures all clients run the same plugin version. Eliminates the need for a package manager or update mechanism. Bun's ability to run scripts from URLs makes this practical.

### Hub-stamped identity

The `from` field on all messages is set by the hub, not by the sending agent. This prevents identity spoofing in a system with no authentication.

**Rationale:** Without auth, any connected agent could claim any identity. Hub-stamping ties `from` to the WebSocket connection's registered name.

### Default identity from cwd and hostname

Agents auto-register as `basename(cwd)@hostname` without requiring any configuration. This provides meaningful names (the project directory) with disambiguation (the hostname).

**Rationale:** Zero-config startup. Developers can override with the `register` tool when they want a human-friendly name like `reviewer@laptop`.
