// Executes the `launch` wrapper heredoc extracted from `/setup?runtime=mpy`
// for real, against a stubbed `curl` on PATH, not just grepping the
// generated script text for expected substrings. Covers the fallback
// behaviour a text-only assertion can't: that a refresh failure (hub
// unreachable, sha256 mismatch) falls through to the cached binary instead
// of aborting the session, and that a genuinely fresh install with no
// cached binary and an unreachable hub fails loudly instead of silently.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setupPlugin } from "@/hub/setup";
import { Elysia } from "elysia";

/** Pulls the `cat > "$DIR/launch" <<'LAUNCH' ... LAUNCH` body out of the
 * generated install script: the exact bytes written to disk on a real
 * install, not a re-derivation of them. */
function extractLaunchScript(setupBody: string): string {
  const start = setupBody.indexOf("<<'LAUNCH'\n");
  const end = setupBody.indexOf("\nLAUNCH\n", start);
  if (start === -1 || end === -1) {
    throw new Error(
      "could not find the launch heredoc in the generated script",
    );
  }
  return setupBody.slice(start + "<<'LAUNCH'\n".length, end);
}

describe("launch wrapper (executed against a stubbed curl)", () => {
  let launchScript: string;
  let workDir: string;
  let launchPath: string;
  let fakeBinDir: string;
  let curlPath: string;
  let home: string;
  let binDir: string;
  let binPath: string;

  beforeAll(async () => {
    const app = new Elysia().use(setupPlugin({ port: 4815 }));
    app.listen(0);
    const port = app.server?.port;
    const resp = await fetch(`http://localhost:${port}/setup?runtime=mpy`);
    const body = await resp.text();
    app.stop();

    launchScript = extractLaunchScript(body);
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-wrapper-test-"));
    launchPath = path.join(workDir, "launch");
    fs.writeFileSync(launchPath, launchScript);
    fs.chmodSync(launchPath, 0o755);
    fakeBinDir = path.join(workDir, "fakebin");
    fs.mkdirSync(fakeBinDir);
    curlPath = path.join(fakeBinDir, "curl");
  });

  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
    // Only `curl` is meant to be a persistent per-suite stub (every test
    // rewrites it); anything else placed on fakeBinDir (e.g. a fake `mv`
    // for one specific test, or that test's own fixture binary) must not
    // leak into tests that run after it.
    for (const name of fs.readdirSync(fakeBinDir)) {
      if (name !== "curl") {
        fs.rmSync(path.join(fakeBinDir, name), { force: true });
      }
    }
  });

  function freshHome(): void {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "launch-wrapper-home-"));
    binDir = path.join(home, ".claude-net", "plugin");
    fs.mkdirSync(binDir, { recursive: true });
    binPath = path.join(binDir, "claude-net-plugin-linux-x64");
  }

  function writeStubBinary(sentinel: string): void {
    fs.writeFileSync(binPath, `#!/bin/bash\necho ${sentinel}\n`);
    fs.chmodSync(binPath, 0o755);
  }

  function runLaunch(hubUrl: string): {
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    const res = spawnSync("bash", [launchPath], {
      env: {
        PATH: `${fakeBinDir}:${process.env.PATH}`,
        HOME: home,
        CLAUDE_NET_HUB: hubUrl,
      },
      encoding: "utf8",
    });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  test("falls back to the cached binary when the hub is unreachable", () => {
    freshHome();
    writeStubBinary("SENTINEL_OLD_BINARY_RAN");
    fs.writeFileSync(path.join(binDir, ".stale"), "");
    fs.writeFileSync(
      curlPath,
      '#!/bin/bash\necho "fake curl: connection failure" >&2\nexit 7\n',
    );
    fs.chmodSync(curlPath, 0o755);

    const result = runLaunch("http://hub.invalid:1");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SENTINEL_OLD_BINARY_RAN");
    expect(result.stderr).toContain(
      "running the existing cached binary instead",
    );
    // Refresh never succeeded, so .stale must survive for the next launch
    // to retry rather than silently being cleared on a failed attempt.
    expect(fs.existsSync(path.join(binDir, ".stale"))).toBe(true);
  });

  test("falls back to the cached binary when the download's sha256 doesn't match", () => {
    freshHome();
    writeStubBinary("SENTINEL_OLD_BINARY_RAN");
    const beforeBytes = fs.readFileSync(binPath, "utf8");
    fs.writeFileSync(path.join(binDir, ".stale"), "");
    fs.writeFileSync(
      curlPath,
      [
        "#!/bin/bash",
        'url=""; outfile=""; prev=""',
        'for a in "$@"; do',
        '  case "$a" in http://*|https://*) url="$a" ;; esac',
        '  if [ "$prev" = "-o" ]; then outfile="$a"; fi',
        '  prev="$a"',
        "done",
        'case "$url" in',
        "  */version)",
        '    echo \'{"version":"9.9.9","sha256":"0000000000000000000000000000000000000000000000000000000000000000","target":"linux-x64"}\'',
        "    ;;",
        "  *)",
        '    if [ -n "$outfile" ]; then printf \'wrong-bytes-not-matching-hash\' > "$outfile"; fi',
        "    ;;",
        "esac",
        "exit 0",
      ].join("\n"),
    );
    fs.chmodSync(curlPath, 0o755);

    const result = runLaunch("http://hub.example");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SENTINEL_OLD_BINARY_RAN");
    expect(result.stderr).toContain("sha256 mismatch");
    expect(result.stderr).toContain(
      "running the existing cached binary instead",
    );
    expect(fs.readFileSync(binPath, "utf8")).toBe(beforeBytes);
    expect(fs.existsSync(path.join(binDir, ".stale"))).toBe(true);
  });

  test("fails when the hub is unreachable and no cached binary exists", () => {
    freshHome();
    fs.writeFileSync(
      curlPath,
      '#!/bin/bash\necho "fake curl: connection failure" >&2\nexit 7\n',
    );
    fs.chmodSync(curlPath, 0o755);

    const result = runLaunch("http://hub.invalid:1");

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("SENTINEL");
    expect(result.stderr).toContain("no cached binary is available");
  });

  test("refreshes and execs the new binary on a clean, reachable hub", () => {
    freshHome();
    const goodBinarySrc = path.join(fakeBinDir, "good-binary-src");
    fs.writeFileSync(
      goodBinarySrc,
      "#!/bin/bash\necho SENTINEL_NEW_BINARY_RAN\n",
    );
    fs.chmodSync(goodBinarySrc, 0o755);
    const goodSha = createHash("sha256")
      .update(fs.readFileSync(goodBinarySrc))
      .digest("hex");

    fs.writeFileSync(
      curlPath,
      [
        "#!/bin/bash",
        'url=""; outfile=""; prev=""',
        'for a in "$@"; do',
        '  case "$a" in http://*|https://*) url="$a" ;; esac',
        '  if [ "$prev" = "-o" ]; then outfile="$a"; fi',
        '  prev="$a"',
        "done",
        'case "$url" in',
        "  */version)",
        `    echo '{"version":"1.2.3","sha256":"${goodSha}","target":"linux-x64"}'`,
        "    ;;",
        "  *)",
        `    if [ -n "\$outfile" ]; then cp "${goodBinarySrc}" "\$outfile"; fi`,
        "    ;;",
        "esac",
        "exit 0",
      ].join("\n"),
    );
    fs.chmodSync(curlPath, 0o755);
    // No cached binary yet: [ ! -x "$BIN" ] alone triggers the refresh.

    const result = runLaunch("http://hub.example");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SENTINEL_NEW_BINARY_RAN");
    expect(fs.existsSync(path.join(binDir, ".stale"))).toBe(false);
    const versionSidecar = JSON.parse(
      fs.readFileSync(
        path.join(binDir, "claude-net-plugin-linux-x64.version"),
        "utf8",
      ),
    );
    expect(versionSidecar.sha256).toBe(goodSha);
  });

  test("B3: never redownloads when the hub keeps advertising the same cached triple", () => {
    // Simulates a hub whose package.json was bumped without re-staging
    // the binary: ws-plugin.ts would still send upgrade_hint (writing
    // .stale) on every register, but the /version endpoint's actual
    // {version, sha256, target} triple is unchanged from what's already
    // cached. The wrapper must treat that as "already current" and never
    // touch the binary-download endpoint, across repeated launches.
    freshHome();
    writeStubBinary("SENTINEL_CACHED_BINARY_RAN");
    const fixedTriple =
      '{"version":"0.2.0","sha256":"abc123fixedhash","target":"linux-x64"}';
    fs.writeFileSync(
      path.join(binDir, "claude-net-plugin-linux-x64.version"),
      fixedTriple,
    );
    const downloadCounter = path.join(workDir, "b3-download-count");
    fs.rmSync(downloadCounter, { force: true });
    fs.writeFileSync(
      curlPath,
      [
        "#!/bin/bash",
        'url=""; outfile=""; prev=""',
        'for a in "$@"; do',
        '  case "$a" in http://*|https://*) url="$a" ;; esac',
        '  if [ "$prev" = "-o" ]; then outfile="$a"; fi',
        '  prev="$a"',
        "done",
        'case "$url" in',
        "  */version)",
        `    echo '${fixedTriple}'`,
        "    ;;",
        "  *)",
        `    echo x >> "${downloadCounter}"`,
        '    if [ -n "$outfile" ]; then echo bogus > "$outfile"; fi',
        "    ;;",
        "esac",
        "exit 0",
      ].join("\n"),
    );
    fs.chmodSync(curlPath, 0o755);

    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(path.join(binDir, ".stale"), "");
      const result = runLaunch("http://hub.example");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("SENTINEL_CACHED_BINARY_RAN");
      expect(fs.existsSync(path.join(binDir, ".stale"))).toBe(false);
    }
    expect(fs.existsSync(downloadCounter)).toBe(false);
  });

  test("NEW-1: a failing mv does not clear .stale or the .version sidecar", () => {
    freshHome();
    writeStubBinary("SENTINEL_OLD_BINARY_RAN");
    const beforeBytes = fs.readFileSync(binPath, "utf8");
    fs.writeFileSync(path.join(binDir, ".stale"), "");
    const goodSha = createHash("sha256").update("new-good-bytes").digest("hex");
    fs.writeFileSync(
      curlPath,
      [
        "#!/bin/bash",
        'url=""; outfile=""; prev=""',
        'for a in "$@"; do',
        '  case "$a" in http://*|https://*) url="$a" ;; esac',
        '  if [ "$prev" = "-o" ]; then outfile="$a"; fi',
        '  prev="$a"',
        "done",
        'case "$url" in',
        "  */version)",
        `    echo '{"version":"1.2.3","sha256":"${goodSha}","target":"linux-x64"}'`,
        "    ;;",
        "  *)",
        '    if [ -n "$outfile" ]; then printf \'new-good-bytes\' > "$outfile"; fi',
        "    ;;",
        "esac",
        "exit 0",
      ].join("\n"),
    );
    fs.chmodSync(curlPath, 0o755);
    // A verified, sha256-correct download still must not be trusted if
    // the final install step (mv into place) itself fails.
    const mvPath = path.join(fakeBinDir, "mv");
    fs.writeFileSync(
      mvPath,
      '#!/bin/bash\necho "fake mv: simulated failure" >&2\nexit 1\n',
    );
    fs.chmodSync(mvPath, 0o755);

    const result = runLaunch("http://hub.example");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SENTINEL_OLD_BINARY_RAN");
    expect(result.stderr).toContain(
      "running the existing cached binary instead",
    );
    expect(fs.readFileSync(binPath, "utf8")).toBe(beforeBytes);
    // The bug this guards against: reporting success and clearing .stale
    // despite the install never actually landing.
    expect(fs.existsSync(path.join(binDir, ".stale"))).toBe(true);
    expect(fs.existsSync(path.join(binDir, ".refresh-failed"))).toBe(true);
  });

  test("NEW-2: backs off after a failure and retries once the window elapses", () => {
    freshHome();
    writeStubBinary("SENTINEL_OLD_BINARY_RAN");
    const callCounter = path.join(workDir, "new2-curl-calls");
    fs.rmSync(callCounter, { force: true });
    fs.writeFileSync(
      curlPath,
      `#!/bin/bash\necho x >> "${callCounter}"\necho "fake curl: connection failure" >&2\nexit 7\n`,
    );
    fs.chmodSync(curlPath, 0o755);

    fs.writeFileSync(path.join(binDir, ".stale"), "");
    const first = runLaunch("http://hub.invalid:1");
    expect(first.status).toBe(0);
    expect(fs.readFileSync(callCounter, "utf8").trim().split("\n").length).toBe(
      1,
    );

    // Immediately relaunching within the backoff window must not invoke
    // curl again at all.
    fs.writeFileSync(path.join(binDir, ".stale"), "");
    const second = runLaunch("http://hub.invalid:1");
    expect(second.status).toBe(0);
    expect(second.stderr).toContain("skipping refresh");
    expect(fs.readFileSync(callCounter, "utf8").trim().split("\n").length).toBe(
      1,
    );

    // Backdate the failure marker past the backoff window: the next
    // launch must retry.
    const past = Math.floor(Date.now() / 1000) - 600;
    fs.writeFileSync(path.join(binDir, ".refresh-failed"), String(past));
    fs.writeFileSync(path.join(binDir, ".stale"), "");
    const third = runLaunch("http://hub.invalid:1");
    expect(third.status).toBe(0);
    expect(fs.readFileSync(callCounter, "utf8").trim().split("\n").length).toBe(
      2,
    );
  });
});
