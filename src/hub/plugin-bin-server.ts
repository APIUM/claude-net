// Serves the versioned claude-net-mpy plugin binary so a host can install
// and refresh it without git/CI access: `curl <hub>/plugin-bin/linux-x64`.
//
// Deliberately NOT folded into bin-server.ts's `ASSETS` whitelist: that map
// serves static files the hub ships as-is (scripts, vendored JS); this is a
// versioned per-target build artifact with its own content-type, download
// headers, and a paired version/hash endpoint. Same discipline (flat
// target whitelist, no path traversal, no directory listing), different
// kind of asset.
//
// `:target` values are restricted to a fixed whitelist; only `linux-x64`
// is built today (see claude-net-mpy's p8_packaging-rollout.md risk
// register, "Only linux-x64 served initially").

import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import * as path from "node:path";
import { Elysia } from "elysia";
import { PLUGIN_VERSION_CURRENT } from "./version";

export interface PluginBinServerDeps {
  /** Absolute path to the repo root (parent of src/ and bin/). */
  repoRoot: string;
}

const TARGETS = new Set(["linux-x64"]);

interface HashCacheEntry {
  mtimeMs: number;
  size: number;
  ino: number;
  sha256: string;
}

const hashCache = new Map<string, HashCacheEntry>();

function binPath(repoRoot: string, target: string): string {
  return path.join(repoRoot, "bin", `claude-net-plugin-${target}`);
}

function versionSidecarPath(repoRoot: string, target: string): string {
  return path.join(repoRoot, "bin", `claude-net-plugin-${target}.version`);
}

// The first line of every Git LFS pointer file, verbatim. A checkout
// that skipped `git lfs pull` (e.g. `actions/checkout` without
// `lfs: true`) leaves this ~130-byte text in place of the real binary.
const LFS_POINTER_MAGIC = "version https://git-lfs.github.com/spec/v1";

/**
 * True when `filePath` starts with the Git LFS pointer magic line: the
 * file on disk is an unsmudged pointer, not the real binary. This is a
 * necessary backstop, not just a CI concern: every other check in this
 * module (sha256, `x-plugin-version`) validates hub-disk content against
 * itself, and a pointer file passes all of them internally-consistently
 * (its own hash matches its own advertised hash); nothing else here
 * would notice a client had downloaded ~130 bytes of text instead of a
 * multi-MB executable, `chmod +x`'d it, and handed it to `exec`. Reads
 * only the first `LFS_POINTER_MAGIC.length` bytes, not the whole file.
 */
function isUnsmudgedLfsPointer(filePath: string): boolean {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(LFS_POINTER_MAGIC.length);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString("utf8") === LFS_POINTER_MAGIC;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * sha256 (hex) of the file at `filePath`, cached until its identity
 * changes. Keyed on mtimeMs + size + ino, not mtime alone.
 *
 * A stage-then-rename deploy (`rsync -a`'s default behaviour, and this
 * repo's own `sync-plugin-binary.sh`, which stages to a `.tmp` sibling
 * and `mv -f`s it into place) can leave mtime identical while the bytes
 * change: the rename always points the served path at a freshly
 * allocated inode, which `ino` catches. `size` separately catches a
 * length-changing in-place overwrite (a plain `cp` onto an existing
 * path truncates and rewrites the *same* inode; it does NOT get a new
 * one, unlike the stage-then-rename case above).
 *
 * Neither field catches a same-length, same-mtime, in-place overwrite
 * via a bare `cp`/`cp -p`: a residual gap this cache doesn't close.
 * That gap is avoided in practice by always deploying through
 * `sync-plugin-binary.sh`'s atomic rename rather than a bare `cp` onto
 * the live, served path; a truly adversarial same-size/same-mtime
 * in-place overwrite would need `ctime` or unconditional re-hashing to
 * catch, neither of which this cache does.
 *
 * Returns `null` when the file doesn't exist. Exported for tests (a
 * temp fixture file, not the real committed binary, which doesn't exist
 * in this repo yet).
 */
export function hashBinaryFile(filePath: string): string | null {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }
  const cached = hashCache.get(filePath);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    cached.ino === stat.ino
  ) {
    return cached.sha256;
  }
  const sha256 = createHash("sha256")
    .update(readFileSync(filePath))
    .digest("hex");
  hashCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    ino: stat.ino,
    sha256,
  });
  return sha256;
}

// A version string shape safe to place directly into an HTTP header
// value (x-plugin-version) and a JSON string (the /version endpoint).
// Rejects anything containing control characters (CR/LF in particular;
// undici/Bun's header setter throws on those, which would 500 the whole
// /plugin-bin/:target route) or otherwise unexpected content from a
// malformed or truncated sidecar file.
const VERSION_SHAPE = /^[A-Za-z0-9._+-]+$/;

/**
 * The version this hub advertises for `target`: the version actually
 * embedded in the staged binary (read from the `.version` sidecar
 * `sync-plugin-binary.sh` writes alongside it), not this hub process's
 * own `package.json` version. Those two are deliberately decoupled: the
 * binary is staged manually/via workflow_dispatch, not on every hub
 * deploy, so trusting `PLUGIN_VERSION_CURRENT` here would advertise a
 * version the staged binary doesn't actually have: a hub package.json
 * bump with no matching binary re-stage would then advertise a version
 * no client's cached binary can ever match. (The `launch` wrapper
 * additionally compares the whole `{version, sha256, target}` response
 * against its own cached copy before redownloading anything, so a
 * hub/binary version mismatch on its own no longer causes a redownload
 * loop even if this function's fallback is in play; see setup.ts.)
 *
 * Falls back to `PLUGIN_VERSION_CURRENT` when the sidecar is absent
 * (e.g. the binary was staged by hand without running the sync script)
 * or when its content doesn't look like a plain version string (a
 * truncated write, stray newline, or other corruption), logged in both
 * cases so an operator has a signal beyond a client silently seeing an
 * unexpected version.
 */
function advertisedVersion(repoRoot: string, target: string): string {
  const sidecarPath = versionSidecarPath(repoRoot, target);
  let raw: string;
  try {
    raw = readFileSync(sidecarPath, "utf8");
  } catch {
    process.stderr.write(
      `[claude-net] plugin-bin-server: no version sidecar at ${sidecarPath}; advertising PLUGIN_VERSION_CURRENT (${PLUGIN_VERSION_CURRENT})\n`,
    );
    return PLUGIN_VERSION_CURRENT;
  }
  const sidecar = raw.trim();
  if (sidecar && VERSION_SHAPE.test(sidecar)) {
    return sidecar;
  }
  process.stderr.write(
    `[claude-net] plugin-bin-server: ${sidecarPath} contains a malformed version (${JSON.stringify(sidecar)}); advertising PLUGIN_VERSION_CURRENT instead\n`,
  );
  return PLUGIN_VERSION_CURRENT;
}

export function pluginBinServerPlugin(deps: PluginBinServerDeps): Elysia {
  const { repoRoot } = deps;

  return new Elysia()
    .get("/plugin-bin/:target/version", ({ params, set }) => {
      if (!TARGETS.has(params.target)) {
        set.status = 404;
        return "not found";
      }
      const filePath = binPath(repoRoot, params.target);
      if (isUnsmudgedLfsPointer(filePath)) {
        set.status = 503;
        return `plugin binary for target '${params.target}' is an unsmudged LFS pointer; run 'git lfs pull' on the hub host`;
      }
      const sha256 = hashBinaryFile(filePath);
      if (sha256 === null) {
        set.status = 404;
        return `binary for target '${params.target}' not present on disk`;
      }
      return {
        version: advertisedVersion(repoRoot, params.target),
        sha256,
        target: params.target,
      };
    })
    .get("/plugin-bin/:target", async ({ params, set }) => {
      if (!TARGETS.has(params.target)) {
        set.status = 404;
        return "not found";
      }
      const filePath = binPath(repoRoot, params.target);
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        set.status = 404;
        return `binary for target '${params.target}' not present on disk`;
      }
      if (isUnsmudgedLfsPointer(filePath)) {
        set.status = 503;
        return `plugin binary for target '${params.target}' is an unsmudged LFS pointer; run 'git lfs pull' on the hub host`;
      }
      const sha256 = hashBinaryFile(filePath);
      set.headers["content-type"] = "application/octet-stream";
      set.headers["content-disposition"] =
        `attachment; filename="claude-net-plugin-${params.target}"`;
      set.headers["x-plugin-version"] = advertisedVersion(
        repoRoot,
        params.target,
      );
      if (sha256 !== null) {
        set.headers.etag = `"${sha256}"`;
      }
      return file;
    });
}

/** Exported for tests. */
export const PLUGIN_BIN_TARGETS = [...TARGETS];
