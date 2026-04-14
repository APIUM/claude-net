# Level 3: Hub Server Component Diagram

```mermaid
C4Component
    title Hub Server Components

    Container_Ext(plugin, "Plugin", "WebSocket client connecting at /ws")
    Container_Ext(dashboard, "Dashboard", "WebSocket client at /ws/dashboard, REST client at /api/*")

    Container_Boundary(hubServer, "Hub Server (Bun + Elysia, port 4815)") {
        Component(pluginWs, "Plugin WS Handler", "ws-plugin.ts", "WebSocket endpoint at /ws. Accepts plugin connections, parses JSON frames, dispatches to Registry/Teams/Router.")
        Component(dashboardWs, "Dashboard WS Handler", "ws-dashboard.ts", "WebSocket endpoint at /ws/dashboard. Pushes agent:connected, agent:disconnected, message:routed, team:changed events.")
        Component(restApi, "REST API", "api.ts", "GET /api/agents, GET /api/teams, POST /api/send, POST /api/broadcast, POST /api/send_team, GET /api/status.")
        Component(registry, "Registry", "registry.ts", "Agent registration, name uniqueness, full/short name resolution, disconnect timeout (2h).")
        Component(teams, "Teams", "teams.ts", "Team implicit creation/deletion, join/leave, membership queries, timeout cleanup.")
        Component(router, "Router", "router.ts", "Message routing: direct, broadcast, team. Generates message_id, stamps from and timestamp.")
        Component(setup, "Setup", "setup.ts", "GET /setup. Returns shell script for MCP registration. Resolves hub address.")
        Component(types, "Shared Types", "types.ts", "Type definitions for frames, messages, agents, teams.")
    }

    Rel(plugin, pluginWs, "WebSocket frames (JSON)", "WebSocket")
    Rel(dashboard, dashboardWs, "Receives events", "WebSocket")
    Rel(dashboard, restApi, "Sends messages, queries", "REST")

    Rel(pluginWs, registry, "register, name resolution")
    Rel(pluginWs, teams, "join_team, leave_team, list_teams")
    Rel(pluginWs, router, "send, broadcast, send_team")

    Rel(router, registry, "Resolves names, checks online status")
    Rel(router, teams, "Resolves team membership")

    Rel(restApi, router, "Delegates message sending")
    Rel(restApi, registry, "Queries agent list")
    Rel(restApi, teams, "Queries team list")

    Rel(dashboardWs, registry, "Agent connect/disconnect events")
    Rel(dashboardWs, router, "message:routed events")
    Rel(dashboardWs, teams, "team:changed events")

    UpdateElementStyle(pluginWs, $bgColor="#4A90D9", $fontColor="#ffffff")
    UpdateElementStyle(dashboardWs, $bgColor="#4A90D9", $fontColor="#ffffff")
    UpdateElementStyle(restApi, $bgColor="#4A90D9", $fontColor="#ffffff")
    UpdateElementStyle(registry, $bgColor="#4A90D9", $fontColor="#ffffff")
    UpdateElementStyle(teams, $bgColor="#4A90D9", $fontColor="#ffffff")
    UpdateElementStyle(router, $bgColor="#4A90D9", $fontColor="#ffffff")
    UpdateElementStyle(setup, $bgColor="#4A90D9", $fontColor="#ffffff")
    UpdateElementStyle(types, $bgColor="#4A90D9", $fontColor="#ffffff")
```
