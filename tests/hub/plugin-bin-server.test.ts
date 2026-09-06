import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hashBinaryFile, pluginBinServerPlugin } from "@/hub/plugin-bin-server";
import { PLUGIN_VERSION_CURRENT } from "@/hub/version";
import { Elysia } from "elysia";

describe("plugin-bin-server", () => {
  let repoRoot: string;
  let binDir: string;
  let app: Elysia;
  let baseUrl: string;

  beforeAll(() => {
    repoRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "plugin-bin-server-test-"),
    );
    binDir = path.join(repoRoot, "bin");
    fs.mkdirSync(binDir);

    app = new Elysia().use(pluginBinServerPlugin({ repoRoot }));
    app.listen(0);
    baseUrl = `http://localhost:${app.server?.port}`;
  });

  afterAll(() => {
    app.stop();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(path.join(binDir, "claude-net-plugin-linux-x64"), {
      force: true,
    });
  });

  function writeFixtureBinary(contents: string): {
    filePath: string;
    sha256: string;
  } {
    const filePath = path.join(binDir, "claude-net-plugin-linux-x64");
    fs.writeFileSync(filePath, contents);
    const sha256 = createHash("sha256").update(contents).digest("hex");
    return { filePath, sha256 };
  }

  test("valid target serves the binary with correct headers", async () => {
    const { sha256 } = writeFixtureBinary("fake-binary-contents");

    const r = await fetch(`${baseUrl}/plugin-bin/linux-x64`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("content-disposition")).toBe(
      'attachment; filename="claude-net-plugin-linux-x64"',
    );
    expect(r.headers.get("x-plugin-version")).toBe(PLUGIN_VERSION_CURRENT);
    expect(r.headers.get("etag")).toBe(`"${sha256}"`);
    const body = await r.text();
    expect(body).toBe("fake-binary-contents");
  });

  test("invalid target 404s with no directory listing or traversal", async () => {
    writeFixtureBinary("fake-binary-contents");

    const r1 = await fetch(`${baseUrl}/plugin-bin/windows-x64`);
    expect(r1.status).toBe(404);

    const r2 = await fetch(`${baseUrl}/plugin-bin/..%2f..%2fpackage.json`);
    expect(r2.status).toBe(404);
  });

  test("missing binary file 404s even for a whitelisted target", async () => {
    const r = await fetch(`${baseUrl}/plugin-bin/linux-x64`);
    expect(r.status).toBe(404);
  });

  test("version endpoint returns version/sha256/target JSON", async () => {
    const { sha256 } = writeFixtureBinary("versioned-contents");

    const r = await fetch(`${baseUrl}/plugin-bin/linux-x64/version`);
    expect(r.status).toBe(200);
    const data = (await r.json()) as {
      version: string;
      sha256: string;
      target: string;
    };
    expect(data).toEqual({
      version: PLUGIN_VERSION_CURRENT,
      sha256,
      target: "linux-x64",
    });
  });

  test("version endpoint 404s for an invalid target", async () => {
    const r = await fetch(`${baseUrl}/plugin-bin/windows-x64/version`);
    expect(r.status).toBe(404);
  });

  test("version endpoint 404s when the binary is absent", async () => {
    const r = await fetch(`${baseUrl}/plugin-bin/linux-x64/version`);
    expect(r.status).toBe(404);
  });

  test("hash cache invalidates on file mtime change", () => {
    const filePath = path.join(binDir, "claude-net-plugin-linux-x64");
    fs.writeFileSync(filePath, "version-one");
    const hash1 = hashBinaryFile(filePath);
    expect(hash1).toBe(
      createHash("sha256").update("version-one").digest("hex"),
    );

    // Same content, unchanged mtime: cached value returned without re-read
    // (can't observe the skip directly, but re-hashing gives the same
    // answer either way; the real assertion is the mtime-bump case below).
    expect(hashBinaryFile(filePath)).toBe(hash1);

    // Rewrite with different content AND bump mtime forward so the cache
    // key (mtimeMs) actually changes; same-second rewrites on some
    // filesystems can leave mtime unchanged at this resolution.
    fs.writeFileSync(filePath, "version-two");
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(filePath, future, future);
    const hash2 = hashBinaryFile(filePath);
    expect(hash2).toBe(
      createHash("sha256").update("version-two").digest("hex"),
    );
    expect(hash2).not.toBe(hash1);
  });

  test("hash cache invalidates on an mtime-preserving atomic replace", () => {
    // Regression guard for B2: rsync -a / cp -p / scp -p / tar -xp style
    // deploys can leave mtime (and even file size) identical while the
    // bytes underneath change. Simulated here the way such tools actually
    // work: stage new content at a sibling path, force its mtime to match
    // the original exactly, then rename() over the live path. rename()
    // always points the destination name at the staged file's inode, so
    // even with mtime and size both unchanged, hashBinaryFile must not
    // serve the old, cached sha256.
    const filePath = path.join(binDir, "claude-net-plugin-linux-x64");
    const contentA = "version-one"; // 11 bytes
    const contentB = "version-TWO"; // 11 bytes: same length, different bytes
    expect(contentA.length).toBe(contentB.length);

    fs.writeFileSync(filePath, contentA);
    const fixedMtime = new Date(Date.now() - 60_000);
    fs.utimesSync(filePath, fixedMtime, fixedMtime);
    const hash1 = hashBinaryFile(filePath);
    expect(hash1).toBe(createHash("sha256").update(contentA).digest("hex"));

    const stagedPath = `${filePath}.staged`;
    fs.writeFileSync(stagedPath, contentB);
    fs.utimesSync(stagedPath, fixedMtime, fixedMtime);
    fs.renameSync(stagedPath, filePath);

    // Same path, same mtime as before the replace, same byte length;
    // only the inode changed.
    const statAfter = fs.statSync(filePath);
    expect(statAfter.mtimeMs).toBe(fixedMtime.getTime());
    expect(statAfter.size).toBe(contentA.length);

    const hash2 = hashBinaryFile(filePath);
    expect(hash2).toBe(createHash("sha256").update(contentB).digest("hex"));
    expect(hash2).not.toBe(hash1);
  });
});

describe("plugin-bin-server version sidecar", () => {
  let repoRoot: string;
  let binDir: string;
  let app: Elysia;
  let baseUrl: string;
  let filePath: string;

  beforeAll(() => {
    repoRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "plugin-bin-server-sidecar-test-"),
    );
    binDir = path.join(repoRoot, "bin");
    fs.mkdirSync(binDir);
    filePath = path.join(binDir, "claude-net-plugin-linux-x64");
    fs.writeFileSync(filePath, "sidecar-fixture-contents");

    app = new Elysia().use(pluginBinServerPlugin({ repoRoot }));
    app.listen(0);
    baseUrl = `http://localhost:${app.server?.port}`;
  });

  afterAll(() => {
    app.stop();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(`${filePath}.version`, { force: true });
  });

  test("advertises the sidecar version, not PLUGIN_VERSION_CURRENT, when present", async () => {
    fs.writeFileSync(`${filePath}.version`, "9.9.9\n");

    const versionResp = await fetch(`${baseUrl}/plugin-bin/linux-x64/version`);
    const data = (await versionResp.json()) as { version: string };
    expect(data.version).toBe("9.9.9");
    expect(data.version).not.toBe(PLUGIN_VERSION_CURRENT);

    const binResp = await fetch(`${baseUrl}/plugin-bin/linux-x64`);
    expect(binResp.headers.get("x-plugin-version")).toBe("9.9.9");
  });

  test("falls back to PLUGIN_VERSION_CURRENT when no sidecar exists", async () => {
    const versionResp = await fetch(`${baseUrl}/plugin-bin/linux-x64/version`);
    const data = (await versionResp.json()) as { version: string };
    expect(data.version).toBe(PLUGIN_VERSION_CURRENT);
  });

  test("logs when falling back because no sidecar exists", async () => {
    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await fetch(`${baseUrl}/plugin-bin/linux-x64/version`);
      const logged = spy.mock.calls.some((call) =>
        String(call[0]).includes("no version sidecar"),
      );
      expect(logged).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("rejects a malformed sidecar (embedded newline) and falls back, with a log line", async () => {
    // A multi-line/corrupted sidecar placed directly into an HTTP header
    // (x-plugin-version) would otherwise throw inside Bun's header
    // setter and 500 the whole binary-download route.
    fs.writeFileSync(`${filePath}.version`, "1.2.3\ncorrupted-garbage\n");
    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const versionResp = await fetch(
        `${baseUrl}/plugin-bin/linux-x64/version`,
      );
      expect(versionResp.status).toBe(200);
      const data = (await versionResp.json()) as { version: string };
      expect(data.version).toBe(PLUGIN_VERSION_CURRENT);

      const binResp = await fetch(`${baseUrl}/plugin-bin/linux-x64`);
      expect(binResp.status).toBe(200);
      expect(binResp.headers.get("x-plugin-version")).toBe(
        PLUGIN_VERSION_CURRENT,
      );

      const logged = spy.mock.calls.some((call) =>
        String(call[0]).includes("malformed version"),
      );
      expect(logged).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("rejects a malformed sidecar (disallowed characters) and falls back", async () => {
    fs.writeFileSync(`${filePath}.version`, "1.2.3; rm -rf /\n");
    const versionResp = await fetch(`${baseUrl}/plugin-bin/linux-x64/version`);
    const data = (await versionResp.json()) as { version: string };
    expect(data.version).toBe(PLUGIN_VERSION_CURRENT);
  });
});

describe("plugin-bin-server unsmudged LFS pointer detection", () => {
  // Regression test for the case a Docker build's `actions/checkout`
  // without `lfs: true` (or any other checkout that skips `git lfs
  // pull`) produces: bin/claude-net-plugin-linux-x64 on disk is the
  // ~130-byte LFS pointer text, not the real binary. Every other check
  // in this module (sha256, x-plugin-version) validates hub-disk content
  // against itself, so a pointer file passes them all internally
  // consistently — this is the only thing that actually inspects
  // whether the content is real. Uses a real LFS pointer file's exact
  // byte shape as the fixture, not a paraphrase.
  const REAL_LFS_POINTER =
    "version https://git-lfs.github.com/spec/v1\noid sha256:f84491215a8e3a3a7aef0201990dfe4e39183f0e98720d4b2602973545f8f376\nsize 98\n";

  let repoRoot: string;
  let binDir: string;
  let app: Elysia;
  let baseUrl: string;
  let filePath: string;

  beforeAll(() => {
    repoRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "plugin-bin-server-lfs-pointer-test-"),
    );
    binDir = path.join(repoRoot, "bin");
    fs.mkdirSync(binDir);
    filePath = path.join(binDir, "claude-net-plugin-linux-x64");

    app = new Elysia().use(pluginBinServerPlugin({ repoRoot }));
    app.listen(0);
    baseUrl = `http://localhost:${app.server?.port}`;
  });

  afterAll(() => {
    app.stop();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test("GET /plugin-bin/linux-x64 refuses to serve an unsmudged pointer", async () => {
    fs.writeFileSync(filePath, REAL_LFS_POINTER);

    const r = await fetch(`${baseUrl}/plugin-bin/linux-x64`);
    expect(r.status).toBe(503);
    const body = await r.text();
    expect(body).toContain("unsmudged LFS pointer");
    expect(body).toContain("git lfs pull");
    // Confirm it really didn't serve the pointer bytes as a "binary".
    expect(body).not.toBe(REAL_LFS_POINTER);
  });

  test("GET /plugin-bin/linux-x64/version also refuses an unsmudged pointer", async () => {
    fs.writeFileSync(filePath, REAL_LFS_POINTER);

    const r = await fetch(`${baseUrl}/plugin-bin/linux-x64/version`);
    expect(r.status).toBe(503);
    const body = await r.text();
    expect(body).toContain("unsmudged LFS pointer");
    // The critical failure mode this guards against: the version
    // endpoint hashing the pointer file and advertising a hash that
    // matches what the (also-a-pointer) download route serves, making
    // the client's sha256 check pass on corrupted content.
    expect(body).not.toContain('"sha256"');
  });

  test("recovers once the real (smudged) binary is in place", async () => {
    fs.writeFileSync(filePath, "real-binary-bytes-not-a-pointer");

    const binResp = await fetch(`${baseUrl}/plugin-bin/linux-x64`);
    expect(binResp.status).toBe(200);
    expect(await binResp.text()).toBe("real-binary-bytes-not-a-pointer");

    const versionResp = await fetch(`${baseUrl}/plugin-bin/linux-x64/version`);
    expect(versionResp.status).toBe(200);
    const data = (await versionResp.json()) as { sha256: string };
    expect(data.sha256).toBe(
      createHash("sha256")
        .update("real-binary-bytes-not-a-pointer")
        .digest("hex"),
    );
  });

  test("a file that merely starts similarly but isn't the pointer is served normally", async () => {
    // Guards the check itself against being over-broad (e.g. matching on
    // a short prefix like "version " alone).
    fs.writeFileSync(
      filePath,
      "version 1.2.3 of the real binary, not a pointer",
    );

    const r = await fetch(`${baseUrl}/plugin-bin/linux-x64`);
    expect(r.status).toBe(200);
  });
});
