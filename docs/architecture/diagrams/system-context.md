# Level 1: System Context Diagram

```mermaid
C4Context
    title claude-net System Context

    Person(developer, "Developer", "Runs multiple Claude Code sessions and monitors agent activity via the dashboard.")

    System(claudeNet, "claude-net Hub", "LAN messaging hub that routes messages between Claude Code agents, manages identity and teams, and serves the monitoring dashboard.")

    System_Ext(claudeCode, "Claude Code Session", "Interactive Claude Code CLI session. Spawns the plugin as a stdio subprocess and communicates via MCP.")

    Boundary(lan, "LAN", "Network trust boundary") {
    }

    Rel(developer, claudeNet, "Views agents, teams, messages; sends messages via dashboard", "HTTP, WebSocket")
    Rel(developer, claudeCode, "Starts sessions with --dangerously-load-development-channels flag")
    Rel(claudeCode, claudeNet, "Plugin connects to hub for message routing", "WebSocket")

    UpdateRelStyle(developer, claudeNet, $offsetY="-30")
    UpdateRelStyle(developer, claudeCode, $offsetX="-100")
    UpdateRelStyle(claudeCode, claudeNet, $offsetY="30")
```
