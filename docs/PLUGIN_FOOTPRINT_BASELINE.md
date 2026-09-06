# claude-net MCP plugin — footprint baseline (Bun) → picolet comparison

Purpose: capture the **"before"** resource footprint of the current
Bun-based claude-net MCP plugin so that, once the picolet
(MicroPython) reimplementation lands, we can measure an apples-to-apples
**"after"** and quantify the saving.

**Migration target:** the per-session MCP plugin — `src/plugin/plugin.ts`
(a single self-contained Bun/TS file: MCP stdio server bridging to the hub
over a WebSocket). One process **per Claude Code session**.

**Out of scope (for now):** the mirror-agent daemon
(`src/mirror-agent/…`, one Bun process **per host**, shared across
sessions). Recorded below for completeness but not the thing picolet
replaces; port it separately if ever.

---

## Methodology (run identically for the "after" measurement)

Host must be running a representative number of live sessions. All figures
are RSS in MB (see caveats) and thread counts from `/proc/<pid>/task`.

```bash
# Session count + Claude process RSS (context, not the plugin)
ps -eo rss,args --no-headers | grep -E 'claude-patched|claude/versions' | grep -v grep \
  | awk '{n++;r+=$1}END{printf "sessions=%d total_rss=%dMB (~%dMB each)\n",n,int(r/1024),int(r/1024/n)}'

# Per-session MCP plugin (Bun): swap the grep pattern for the picolet plugin
ps -C bun -o rss,nlwp,args --no-headers | grep 'claude-net-plugin' \
  | awk '{n++;r+=$1;t+=$2;a[n]=$1;th[n]=$2}END{asort(a);asort(th);
      printf "count=%d total_rss=%dMB total_threads=%d\n",n,int(r/1024),t;
      printf "per-plugin rss min/med/max=%d/%d/%dM threads min/med/max=%d/%d/%d\n",
      int(a[1]/1024),int(a[int(n/2)]/1024),int(a[n]/1024),th[1],th[int(n/2)],th[n]}'

# mirror-agent (singleton) rss/threads/cpu
P=$(pgrep -f 'mirror-agent\.bundle\.js$'|head -1); hz=$(getconf CLK_TCK)
rss=$(awk '/VmRSS/{print int($2/1024)}' /proc/$P/status); thr=$(ls /proc/$P/task|wc -l)
a=$(awk '{print $14+$15}' /proc/$P/stat); sleep 3; b=$(awk '{print $14+$15}' /proc/$P/stat)
echo "mirror-agent rss=${rss}MB threads=${thr} cpu=$(awk "BEGIN{printf \"%.1f\",($b-$a)/$hz/3*100}")%"

# Runtime idle floor (controlled): an idle script with a keepalive timer + open stdin
printf 'setInterval(()=>{},3.6e6);process.stdin.resume();\n' > /tmp/idle.js
bun run /tmp/idle.js & p=$!; sleep 2.5
echo "idle floor: rss=$(awk '/VmRSS/{print int($2/1024)"M"}' /proc/$p/status) threads=$(ls /proc/$p/task|wc -l)"; kill $p
```

The headline comparison metric is **per-session plugin RSS and thread
count** (and the runtime idle floor), because total footprint = that ×
(sessions × MCP servers). Normalise by session count; don't compare raw
totals taken at different session counts.

---

## BEFORE — Bun plugin

Snapshot: **2026-07-23T06:48Z**, host `LAP-AU-PF65PM2K` (WSL2,
kernel 6.18), Bun 1.3.13, 47 GB RAM.

### Per-session MCP plugin (`bun run …/claude-net-plugin.*.ts`)

| Metric | Value |
|---|---|
| Idle floor (controlled, single idle process) | **~40 MB RSS, 11 threads** |
| Live plugins observed | 27 (1 per session) |
| Per-plugin RSS (min / median / max) | 57 / **79** / 415 MB |
| Per-plugin threads (min / median / max) | 5 / **12** / 20 |
| Aggregate at 27 sessions | **~2.98 GB RSS, 277 threads** |

- The **~40 MB / 11 threads** floor is fixed Bun runtime overhead (JS main
  thread + JSC JIT/GC helper threads); it is *not* configurable down:
  - `bun --smol` — **no change** to the idle floor (only caps heap growth
    under load).
  - `UV_THREADPOOL_SIZE=1` — **−1 thread only** (Bun is not libuv-based).
- Above the floor, RSS/threads grow with real per-session activity (WS
  buffers, MCP message volume) — hence the 79 MB median but 415 MB tail.

### mirror-agent daemon (per host — NOT the migration target)

| Metric | Value |
|---|---|
| RSS | ~73–80 MB |
| Threads | 13–14 |
| CPU | **variable, 11–31% of one core** (observed range) |

- CPU is **GC-dominant** (5 JSC `HeapHelper` threads ≈ half of it) — driven
  by per-record allocation while mirroring active sessions, **plus** a
  reconnect-recovery burst from that day's hub restarts (do not treat the
  high end as steady state; re-measure during a quiet period).

### System context (not attributable to claude-net)

- 27 Claude Code processes: **~12.9 GB RSS** (~478 MB each) — the dominant
  consumer overall.
- Other MCP servers (serena, codanna, …): each also a per-session runtime.

---

## AFTER — picolet plugin

**Standalone MCP-stdio smoke test — 2026-07-23**, host `LAP-AU-PF65PM2K`,
binary `claude-net-mpy/build/claude-net-plugin-linux-x64` (1.07 MB ELF,
branch `mpy-plugin`, PLUGIN_VERSION 0.2.0), driven directly against the
live telie hub. This is a single-process functional test — **not** the
full in-CC live test / 24 h soak (those are picolet-driven; see
`planning/20260723_live-test-plan.md` in the mpy worktree).

### Per-session MCP plugin (picolet / MicroPython) — smoke test

| Metric | Value |
|---|---|
| Single running process | **3 MB RSS, 1 thread** ✅ |
| MCP handshake | `initialize` OK — serverInfo `claude-net/0.2.0`, caps `[experimental, tools, prompts]` ✅ |
| Tool surface | all **11** tools present (parity with bun) ✅ |
| Live hub | WSS connect + auto-register + `whoami` round-trip + clean unregister (reason=close) ✅ |
| Per-plugin under real load / aggregate @ N sessions | _pending in-CC live test_ |
| 24 h soak (flat RSS ≤ 4 MB, Threads:1) | _pending_ |

---

## Comparison (fill in)

| Metric (per session) | Bun (before) | picolet (after) | Δ |
|---|---|---|---|
| Single-process RSS | ~40 MB (idle floor) | **~3 MB** (smoke) | **~13× smaller** |
| Single-process threads | 11 (idle floor) | **1** (smoke) | **11× fewer** |
| Median live RSS | 79 MB | _TBD (in-CC live)_ | _TBD_ |
| Median live threads | 12 | _TBD (in-CC live)_ | _TBD_ |
| Extrapolated total @ 27 sessions | ~2.98 GB / 277 thr | _TBD_ | _TBD_ |

Note: the Bun "before" single-process figure is its *idle floor* (40 MB);
under real load Bun plugins rose to a 79 MB median (415 MB tail). The
picolet 3 MB / 1-thread figure is from an idle-ish smoke run; its
under-load behaviour is the key open number for the in-CC live test.

---

## Caveats

- **RSS over-counts shared pages.** All Bun plugins share the ~40 MB Bun
  executable copy-on-write, so the *incremental private* cost per plugin is
  well below its RSS (roughly the JS heap + buffers, ~20–40 MB). PSS (e.g.
  `smem`) would be a fairer per-process number; RSS is used here only for
  reproducibility. Apply the same measure to the "after" side.
- **Session count varies** (24→27 within one session of observation);
  compare per-session/per-unit figures, not raw totals.
- **mirror-agent CPU is variable and was churn-inflated** at capture time;
  its steady-state figure needs a quiet-period re-measure and it is not the
  migration target regardless.
- The real footprint win from picolet is expected in the **idle floor and
  thread count per session** (a MicroPython runtime vs a full JS runtime),
  multiplied across every session × every MCP server that adopts it.
