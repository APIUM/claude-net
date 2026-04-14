// Plugin entry point — served by the hub at /plugin.ts and run on client machines.
// Claude Code spawns this as a stdio subprocess via:
//   bun run http://<hub>:4815/plugin.ts
//
// SINGLE-FILE CONSTRAINT: This file is served by the hub and fetched by
// `bun run http://hub:4815/plugin.ts`. It CAN import npm packages but
// CANNOT import local project files. Types are duplicated inline.

import * as os from "node:os";
import * as path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";

// ── Inline type definitions (mirrors src/shared/types.ts) ─────────────────

type MessageType = "message" | "reply";

interface ResponseFrame {
  event: "response";
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

interface InboundMessageFrame {
  event: "message";
  message_id: string;
  from: string;
  to: string;
  type: MessageType;
  content: string;
  reply_to?: string;
  team?: string;
  timestamp: string;
}

interface RegisteredFrame {
  event: "registered";
  name: string;
  full_name: string;
}

interface ErrorFrame {
  event: "error";
  message: string;
}

type HubFrame =
  | ResponseFrame
  | InboundMessageFrame
  | RegisteredFrame
  | ErrorFrame;

// ── Constants ─────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 10_000;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

const INSTRUCTIONS = `claude-net agent messaging plugin.

Inbound messages from other agents arrive as <channel> tags:
  <channel source="claude-net" from="name@host" type="message|reply" message_id="..." reply_to="..." team="...">
    message content
  </channel>

Available tools:
- register(name) — override your default identity
- send_message(to, content, reply_to?) — send to an agent by name (full "name@host" or short "name")
- broadcast(content) — send to all online agents
- send_team(team, content, reply_to?) — send to all online members of a team
- join_team(team) — join a team (creates it if new)
- leave_team(team) — leave a team
- list_agents() — list all agents with status
- list_teams() — list all teams with members

Messages to offline agents will fail — there is no queuing.
Always include reply_to when responding to a specific message.
The from field on all messages is your full name@host identity, set by the hub.`;

// ── Exported helpers (testable) ───────────────────────────────────────────

export function buildDefaultName(): string {
  return `${path.basename(process.cwd())}@${os.hostname()}`;
}

export function createChannelNotification(message: InboundMessageFrame): {
  method: string;
  params: { content: string; meta: Record<string, string> };
} {
  return {
    method: "notifications/claude/channel",
    params: {
      content: message.content,
      meta: {
        from: message.from,
        type: message.type,
        message_id: message.message_id,
        reply_to: message.reply_to ?? "",
        ...(message.team ? { team: message.team } : {}),
      },
    },
  };
}

export function mapToolToFrame(
  toolName: string,
  args: Record<string, string>,
): Record<string, unknown> | null {
  switch (toolName) {
    case "register":
      return { action: "register", name: args.name };
    case "send_message":
      return {
        action: "send",
        to: args.to,
        content: args.content,
        type: args.reply_to ? "reply" : "message",
        ...(args.reply_to ? { reply_to: args.reply_to } : {}),
      };
    case "broadcast":
      return { action: "broadcast", content: args.content };
    case "send_team":
      return {
        action: "send_team",
        team: args.team,
        content: args.content,
        type: args.reply_to ? "reply" : "message",
        ...(args.reply_to ? { reply_to: args.reply_to } : {}),
      };
    case "join_team":
      return { action: "join_team", team: args.team };
    case "leave_team":
      return { action: "leave_team", team: args.team };
    case "list_agents":
      return { action: "list_agents" };
    case "list_teams":
      return { action: "list_teams" };
    default:
      return null;
  }
}

// ── Logging ───────────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stderr.write(`[claude-net] ${msg}\n`);
}

// ── WebSocket client state ────────────────────────────────────────────────

let ws: WebSocket | null = null;
let storedName = "";
let hubWsUrl = "";
let reconnectDelay = RECONNECT_INITIAL_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let mcpServer: Server | null = null;

const pendingRequests = new Map<
  string,
  {
    resolve: (data: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function isConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

function request(frame: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!isConnected()) {
      reject(new Error("Not connected to hub"));
      return;
    }

    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("Request timed out after 10 seconds"));
    }, REQUEST_TIMEOUT_MS);

    pendingRequests.set(requestId, { resolve, reject, timer });
    // biome-ignore lint/style/noNonNullAssertion: ws is checked by isConnected() above
    ws!.send(JSON.stringify({ ...frame, requestId }));
  });
}

function handleHubFrame(raw: string): void {
  let frame: HubFrame;
  try {
    frame = JSON.parse(raw) as HubFrame;
  } catch {
    log(`Invalid JSON from hub: ${raw}`);
    return;
  }

  switch (frame.event) {
    case "response": {
      const pending = pendingRequests.get(frame.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(frame.requestId);
        if (frame.ok) {
          pending.resolve(frame.data);
        } else {
          pending.reject(new Error(frame.error ?? "Unknown error"));
        }
      }
      break;
    }
    case "message": {
      const notification = createChannelNotification(frame);
      if (mcpServer) {
        mcpServer
          .notification(notification)
          .catch((err: unknown) => log(`Failed to emit notification: ${err}`));
      }
      break;
    }
    case "registered":
      log(`Registered as ${frame.full_name}`);
      break;
    case "error":
      log(`Hub error: ${frame.message}`);
      break;
  }
}

function connectWebSocket(): void {
  if (!hubWsUrl) return;

  log(`Connecting to ${hubWsUrl}`);
  ws = new WebSocket(hubWsUrl);

  ws.on("open", () => {
    log("Connected to hub");
    reconnectDelay = RECONNECT_INITIAL_MS;

    // Auto-register with stored name
    if (storedName) {
      request({ action: "register", name: storedName })
        .then(() => log(`Auto-registered as ${storedName}`))
        .catch((err: unknown) => log(`Auto-registration failed: ${err}`));
    }
  });

  ws.on("message", (data: WebSocket.Data) => {
    handleHubFrame(data.toString());
  });

  ws.on("close", () => {
    log("Disconnected from hub");
    ws = null;
    scheduleReconnect();
  });

  ws.on("error", (err: Error) => {
    log(`WebSocket error: ${err.message}`);
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;

  log(`Reconnecting in ${reconnectDelay}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  }, reconnectDelay);
}

// ── Tool definitions ──────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: "register",
    description: "Override your default identity with a custom name",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "The name to register as" },
      },
      required: ["name"],
    },
  },
  {
    name: "send_message",
    description:
      'Send a message to an agent by name (full "name@host" or short "name")',
    inputSchema: {
      type: "object" as const,
      properties: {
        to: { type: "string", description: "Recipient agent name" },
        content: { type: "string", description: "Message content" },
        reply_to: {
          type: "string",
          description: "message_id of the message being replied to",
        },
      },
      required: ["to", "content"],
    },
  },
  {
    name: "broadcast",
    description: "Send a message to all online agents",
    inputSchema: {
      type: "object" as const,
      properties: {
        content: { type: "string", description: "Message content" },
      },
      required: ["content"],
    },
  },
  {
    name: "send_team",
    description: "Send a message to all online members of a team",
    inputSchema: {
      type: "object" as const,
      properties: {
        team: { type: "string", description: "Team name" },
        content: { type: "string", description: "Message content" },
        reply_to: {
          type: "string",
          description: "message_id of the message being replied to",
        },
      },
      required: ["team", "content"],
    },
  },
  {
    name: "join_team",
    description: "Join a team (creates it if new)",
    inputSchema: {
      type: "object" as const,
      properties: {
        team: { type: "string", description: "Team name to join" },
      },
      required: ["team"],
    },
  },
  {
    name: "leave_team",
    description: "Leave a team",
    inputSchema: {
      type: "object" as const,
      properties: {
        team: { type: "string", description: "Team name to leave" },
      },
      required: ["team"],
    },
  },
  {
    name: "list_agents",
    description: "List all agents with status",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "list_teams",
    description: "List all teams with members",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// ── Tool dispatch ─────────────────────────────────────────────────────────

function notConnectedError(reason: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${reason}` }],
  };
}

function toolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

async function handleToolCall(
  name: string,
  args: Record<string, string>,
): Promise<{
  isError?: boolean;
  content: { type: "text"; text: string }[];
}> {
  if (!hubWsUrl) {
    return notConnectedError(
      "Not connected — CLAUDE_NET_HUB environment variable not set.",
    );
  }

  if (!isConnected()) {
    return notConnectedError(
      "Not connected to hub. Claude Code will auto-connect on next restart, or use register tool.",
    );
  }

  const frame = mapToolToFrame(name, args);
  if (!frame) {
    return notConnectedError(`Unknown tool: ${name}`);
  }

  try {
    const data = await request(frame);

    // Update stored name on successful register
    if (name === "register" && args.name) {
      storedName = args.name;
    }

    return toolResult(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return notConnectedError(message);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const hubUrl = process.env.CLAUDE_NET_HUB;

  // Create MCP server
  mcpServer = new Server(
    { name: "claude-net", version: "0.1.0" },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: {},
      },
      instructions: INSTRUCTIONS,
    },
  );

  // Register tool list handler
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  // Register tool call handler
  mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    return handleToolCall(name, (args ?? {}) as Record<string, string>);
  });

  // Connect stdio transport
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  // Connect to hub if URL is set
  if (hubUrl) {
    hubWsUrl = `${hubUrl.replace(/^http/, "ws").replace(/\/$/, "")}/ws`;
    storedName = buildDefaultName();
    connectWebSocket();
  } else {
    log("CLAUDE_NET_HUB not set — running without hub connection");
  }

  // Graceful shutdown
  const shutdown = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) {
      ws.removeAllListeners();
      ws.close();
    }
    for (const [, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Shutting down"));
    }
    pendingRequests.clear();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
