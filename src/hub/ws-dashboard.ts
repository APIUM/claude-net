import type { DashboardEvent } from "@/shared/types";
import type { Elysia } from "elysia";
import type { Registry } from "./registry";
import type { Teams } from "./teams";

interface DashboardWs {
  send(data: string | object): void;
  raw: object;
}

const dashboardClients = new Set<DashboardWs>();

export function broadcastToDashboards(event: DashboardEvent): void {
  const payload = JSON.stringify(event);
  for (const client of dashboardClients) {
    try {
      client.send(payload);
    } catch {
      // Client may have disconnected; remove on next close event
    }
  }
}

function pushInitialState(
  ws: DashboardWs,
  registry: Registry,
  teams: Teams,
): void {
  // Send current agents as agent:connected events
  for (const agent of registry.agents.values()) {
    ws.send(
      JSON.stringify({
        event: "agent:connected",
        name: agent.shortName,
        full_name: agent.fullName,
      }),
    );
  }

  // Send current teams as team:changed created events
  for (const [teamName, members] of teams.teams) {
    ws.send(
      JSON.stringify({
        event: "team:changed",
        team: teamName,
        members: [...members],
        action: "created",
      }),
    );
  }
}

export function wsDashboardPlugin(
  app: Elysia,
  registry: Registry,
  teams: Teams,
): Elysia {
  return app.ws("/ws/dashboard", {
    open(ws: DashboardWs) {
      dashboardClients.add(ws);
      pushInitialState(ws, registry, teams);
    },

    message(_ws: DashboardWs, _data: unknown) {
      // Dashboard sends messages via REST API, not WebSocket
      // Reserved for future extensibility
    },

    close(ws: DashboardWs) {
      dashboardClients.delete(ws);
    },
    // biome-ignore lint/suspicious/noExplicitAny: Elysia WS handler typing requires flexible return
  }) as any;
}
