# CLAUDE.md

## Commands

```
bun install          # install dependencies
bun run dev          # start hub with --watch
bun test             # run all tests
bun run lint         # biome check
bun run fmt          # biome format
```

## Architecture

```
src/
  hub/
    index.ts          # entry point — wires registry, teams, router, starts Elysia
    registry.ts       # agent registry (register, unregister, resolve, disconnect timeout)
    teams.ts          # team membership (join, leave, list)
    router.ts         # message routing (direct, broadcast, team)
    ws-plugin.ts      # WebSocket handler for /ws (agent connections)
    ws-dashboard.ts   # WebSocket handler for /ws/dashboard (dashboard live updates)
    api.ts            # REST API routes under /api/*
    setup.ts          # GET /setup — shell script for MCP registration
    dashboard.html    # built-in monitoring dashboard
  plugin/
    plugin.ts         # MCP stdio server — bridges Claude Code to hub via WebSocket
  shared/
    types.ts          # shared type definitions (frames, events, data models)
tests/
  hub/               # unit tests for each hub module
  plugin/            # plugin unit tests
  shared/            # type tests
  integration/       # end-to-end tests (real hub + WebSocket clients)
```

Path alias: `@/*` maps to `./src/*` (configured in tsconfig.json).

## Testing

```
bun test                                    # all tests
bun test tests/hub/registry.test.ts         # single file
bun test tests/integration/e2e.test.ts      # integration tests
```

Tests use `bun:test` (describe/test/expect). Hub unit tests use mock WebSocket objects. Integration tests start a real hub on a random port and connect actual WebSocket clients.

## Docker

```
docker build -t claude-net .
docker run -p 4815:4815 claude-net
```
