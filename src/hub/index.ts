import { Elysia } from "elysia";
import { Registry } from "./registry";
import { Router } from "./router";
import { Teams } from "./teams";
import { wsPlugin } from "./ws-plugin";

const port = Number(process.env.CLAUDE_NET_PORT) || 4815;

const registry = new Registry();
const teams = new Teams(registry);
const router = new Router(registry, teams);

// Wire up disconnect timeout to clean up team memberships
registry.setTimeoutCleanup((fullName, agentTeams) => {
  for (const teamName of agentTeams) {
    teams.leave(teamName, fullName);
  }
});

let app = new Elysia().get("/health", () => ({ status: "ok" }));
app = wsPlugin(app, registry, teams, router);
app.listen(port);

console.log(`claude-net hub listening on port ${port}`);

export { app, registry, teams, router };
