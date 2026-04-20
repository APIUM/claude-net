import { Elysia } from "elysia";
import { apiPlugin } from "./api";
import { MirrorRegistry, mirrorPlugin, wsMirrorPlugin } from "./mirror";
import { Registry } from "./registry";
import { Router } from "./router";
import { setupPlugin } from "./setup";
import { Teams } from "./teams";
import { broadcastToDashboards, wsDashboardPlugin } from "./ws-dashboard";
import { setDashboardBroadcast, wsPlugin } from "./ws-plugin";

const port = Number(process.env.CLAUDE_NET_PORT) || 4815;
const externalHost = process.env.CLAUDE_NET_HOST || undefined;
const startedAt = new Date();

const registry = new Registry();
const teams = new Teams(registry);
const router = new Router(registry, teams);
const mirrorRegistry = new MirrorRegistry();

// Wire up disconnect timeout to clean up team memberships
registry.setTimeoutCleanup((fullName, agentTeams) => {
  for (const teamName of agentTeams) {
    teams.leave(teamName, fullName);
  }
});

// Wire dashboard broadcast into ws-plugin and mirror-registry
setDashboardBroadcast(broadcastToDashboards);
mirrorRegistry.setDashboardBroadcast(broadcastToDashboards);

// Resolve plugin.ts path relative to hub source directory
const pluginPath = `${import.meta.dir}/../plugin/plugin.ts`;
const dashboardPath = `${import.meta.dir}/dashboard.html`;
let pluginCache: string | null = null;
let dashboardCache: string | null = null;

async function getDashboardHtml(): Promise<string> {
  if (!dashboardCache) {
    const file = Bun.file(dashboardPath);
    dashboardCache = await file.text();
  }
  return dashboardCache;
}

let app = new Elysia()
  .get("/", async ({ set }) => {
    set.headers["content-type"] = "text/html";
    return await getDashboardHtml();
  })
  .get("/mirror/:sid", async ({ set }) => {
    set.headers["content-type"] = "text/html";
    return await getDashboardHtml();
  })
  .get("/health", () => ({
    status: "ok",
    version: "0.1.0",
    uptime: (Date.now() - startedAt.getTime()) / 1000,
    agents: registry.agents.size,
    teams: teams.teams.size,
  }))
  .get("/plugin.ts", async ({ set }) => {
    if (!pluginCache) {
      const file = Bun.file(pluginPath);
      pluginCache = await file.text();
    }
    set.headers["content-type"] = "text/typescript";
    return pluginCache;
  })
  .use(apiPlugin({ registry, teams, router, startedAt }))
  .use(mirrorPlugin({ mirrorRegistry, externalHost, port }))
  .use(setupPlugin({ port }));

app = wsPlugin(app, registry, teams, router);
app = wsDashboardPlugin(app, registry, teams);
app = wsMirrorPlugin(app, mirrorRegistry);
app.listen(port);

console.log(`claude-net hub listening on port ${port}`);

export { app, registry, teams, router, mirrorRegistry, startedAt };
