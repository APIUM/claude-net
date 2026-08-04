# Fix plan: stale mirror sessions + fork clobbering the original

Base branch: `fix/mirror-stale-sessions` (off `origin/main` @ `91e646d`).
Backend only: `src/mirror-agent/agent.ts` and `src/hub/mirror.ts`.

## Context

Two related, live-reproduced defects in the mirror-session lifecycle:

1. **Fork clobbers the original.** Forking a live session
   (`claude --resume <ORIG_SID> --fork-session`) detached the original's
   dashboard mirror. The fork runs as a new process with a new runtime session
   id, but the daemon mis-attributed the original's sid to the fork, poisoned the
   `(sid → ccPid)` binding, and then `findReplacedByClear` closed the original.
2. **Stale sessions accumulate and can't be cleared.** The resulting dead entry
   (a sid bound to a now-dead process, still agent-bound on the hub) could not be
   closed: `POST /api/mirror/<sid>/close` returned 200 but the entry stayed open.
   Only a full hub restart cleared it. More generally, any "Claude Code exits but
   the long-lived daemon keeps running" case leaves an agent-bound entry the hub's
   sweeps refuse to reap.

Root causes were verified by reading the code (line anchors below are against
`91e646d`; re-confirm after checkout since they may drift).

## Bug A — root cause: session id resolved by newest-mtime in a shared dir

`findActiveSessionForCcPid(_ccPid, cwd)` in `src/mirror-agent/agent.ts`
(~lines 2063-2103) resolves a process's session id by scanning the project dir
`~/.claude/projects/<encoded-cwd>/` and picking the **newest-mtime `.jsonl`**
(~lines 2081-2094). **The `ccPid` argument is ignored** (it's named `_ccPid`).

There is **no argv/`--resume` parsing** anywhere in the probe path — the earlier
"argv" theory is wrong. The bug is purely the shared-dir mtime pick: a fork and
its original share one cwd/project-dir, and the original was actively writing its
transcript (newest mtime), so `findActiveSessionForCcPid(FORK_PID, cwd)` returned
the **original's** sid. This one function feeds both:
- the probe handler `onSessionProbe` (~line 313, then `openSession(sid, …, ccPid)`
  at ~327), and
- startup rediscovery `discoverRunningCcSessions` (~line 2174).

So a single fix here corrects both entry points.

### Fix A
Correlate a process to the transcript **it actually holds open**, not the newest
in the shared dir:
- On Linux, scan `/proc/<ccPid>/fd/*` for a symlink target ending in
  `<projectDir>/<sid>.jsonl`; return that sid. (The docstring ~2058-2061 already
  anticipates exactly this.)
- Keep the current newest-mtime scan as a **fallback** only when the fd scan
  finds nothing (non-Linux, permission error, or the process hasn't opened its
  transcript yet).
- Use the passed `ccPid` (rename `_ccPid` → `ccPid`).
- Guard: if the fd scan finds a transcript whose sid differs from the newest-mtime
  candidate, trust the fd scan (that is the whole point).

This keeps forks and originals distinct: each process maps to its own held
transcript, so no two live processes ever collide on one sid, and
`findReplacedByClear` (agent.ts ~1939-1961, matches on `ccPid` OR `tmuxPane`)
never sees a poisoned binding to evict the original.

### Fork-safety hardening (defense in depth)
`findReplacedByClear`'s `matchByPane` (~line 1955) can still evict a legitimately
distinct session if two processes ever report the same `tmuxPane`. With the
launcher giving same-dir fork/resume its own tmux session this shouldn't happen,
but add a guard: only treat a differing sid on the same pane as "replaced" when
the old session's `ccPid` is confirmed dead (`process.kill(oldCcPid, 0)` throws
ESRCH). A live old process must never be evicted.

## Bug B — the hub can't drop an agent-bound stale entry

`POST /:sid/close` (`src/hub/mirror.ts` ~1745-1754) calls the **soft**
`closeSession` (~889-957), which sets `closedAt` but **leaves `entry.agent`
bound**. The still-connected daemon then re-opens the entry via `createSession`'s
re-open branch (~656-666, `existing.closedAt = null`) on its next keepalive/hook
re-POST. Net: `/close` flips `closedAt` for an instant and the daemon flips it
back; the route returns `{closed:true}` unconditionally, so it always looks like
200-success. Only a hub restart (drops the whole map) cleared it.

Also: the sweeps `sweepOrphans` (~293) and `sweepNeverActive` (~320) both
`if (entry.agent) continue;` (~298, ~325), so nothing garbage-collects an
agent-bound entry — and a long-lived daemon keeps that WS bound for its whole
life regardless of whether the underlying Claude Code is alive.

### Fix B
1. `/close` route (~1752): call `closeAndDrop` (~977-1000) instead of
   `closeSession`, so it severs `entry.agent` and `deleteEntry`s immediately.
   Resolve and act on the exact `found` entry from ~1747 (pass the host through)
   rather than re-resolving via `entryBySid` — `entryBySid` (~523-525) returns
   null when a sid exists on >1 host, making `/close` a silent no-op for
   cross-host sid collisions.
2. Harden the `createSession` re-open branch (~656-666): do **not** resurrect a
   closed entry when the incoming `cc_pid` differs from the entry's and the
   entry's bound `ccPid` is dead — i.e. a re-POST must not un-close a session
   that was deliberately dropped for a dead process.

### Bug C — sweep backstop for agent-bound dead sessions (defense in depth)
Even with A and B fixed, the "CC exits, daemon lives" case relies entirely on the
agent-side watchdog. Make cleanup robust from both ends:
- **Agent watchdog** (`src/mirror-agent/agent.ts` ~396-407): it already does
  `process.kill(ccPid, 0)` and closes on ESRCH, but it `continue`s when
  `ccPid === null` (~397) — those sessions are then unreapable by the hub too.
  For `ccPid === null`, fall back to a liveness check (tmux pane exists / the
  transcript is still growing) and close if dead.
- **Hub sweep** (`src/hub/mirror.ts` ~293-305): allow the orphan sweep to reap an
  **agent-bound** entry when `lastEventAt` is older than a longer cutoff (e.g.
  keep `DEFAULT_ORPHAN_CLOSE_MS` = 30 min for unbound, add a separate longer
  bound-session cutoff), so a stuck agent-bound entry can never live forever even
  if the agent watchdog misses it. This is a backstop, not the primary path.

## Tests (`bun:test`, follow conventions in each dir)

- `tests/mirror-agent/`:
  - `findActiveSessionForCcPid` — given a project dir with two transcripts where
    the process (mocked `/proc/<pid>/fd`) holds the **older** one, it returns the
    held one, not the newest-mtime one. Fallback path returns newest when no fd
    match.
  - `findReplacedByClear` — a differing sid on the same pane whose old `ccPid` is
    still alive is **not** evicted.
- `tests/hub/mirror.test.ts`:
  - `/close` on an agent-bound entry actually drops it (agent severed, entry gone
    from `listAll`), and a subsequent `createSession` re-POST from a dead ccPid
    does **not** resurrect it.
  - `entryBySid` multi-host: `/close` with a host hint closes the right entry.
- `tests/integration/` mirror e2e:
  - Simulate a fork: register `<ORIG_SID>`/pidA, then a fork probe for pidB in the
    same cwd; assert `<ORIG_SID>` stays bound to pidA and is not closed, and the
    fork registers under its own sid.

## Verification (end-to-end)

1. `bun test` (targeted files; avoid the port-4815 suite if a hub is running
   locally) + `bun run lint`.
2. Manual, on a host running `claude-channels`:
   - Fork a live session (`--fork-session`); confirm the original's dashboard
     mirror stays bound to the original process and is not closed; the fork shows
     as its own entry.
   - Kill the fork; confirm no stale entry lingers (agent watchdog closes it).
   - `POST /api/mirror/<sid>/close` on a genuinely dead session actually removes
     it without a hub restart.

## Rollout (important)

Backend change touches **both** the hub (`mirror.ts`) and the client daemon
(`agent.ts`):
- Hub: merge to `origin/main` → CI builds `ghcr.io/apium/claude-net:latest` →
  redeploy the `claude-net` stack on `london` (`docker compose pull && up -d` in
  `/home/apium/docker/stacks/claude-net`, i.e. a komodo DeployStack).
- Client: the `agent.ts` (Bug A) fix only takes effect once every host's
  mirror-agent **bundle** is rebuilt. Each host must re-run
  `curl -fsSL http://london:4815/setup | bash` (or `bin/install-channels` from a
  clone) and let the daemon respawn. Until a host updates its bundle it will keep
  mis-attributing forks.
