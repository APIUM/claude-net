import { Elysia } from "elysia";

const port = Number(process.env.CLAUDE_NET_PORT) || 4815;

const app = new Elysia().get("/health", () => ({ status: "ok" })).listen(port);

console.log(`claude-net hub listening on port ${port}`);

export { app };
