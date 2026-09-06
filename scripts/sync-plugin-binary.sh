#!/bin/bash
set -euo pipefail
#
# Stage the claude-net-mpy CI-built `claude-net-plugin-linux-x64` artifact
# at bin/claude-net-plugin-linux-x64 (Git LFS-tracked; see .gitattributes),
# where plugin-bin-server.ts (GET /plugin-bin/linux-x64) serves it from.
# Commits the staged binary and its `.version` sidecar in a dedicated,
# narrowly-scoped commit when their content actually changed; a no-op
# when the freshly-downloaded artifact is byte-identical to what's already
# committed, and a loud failure if either path already carries an
# unrelated uncommitted local change this script would otherwise clobber.
#
# Deliberately NOT wired into docker.yml's per-push CI: a binary update
# should land in lockstep with a version bump, driven deliberately, not on
# every push. Run manually or via a manually-triggered workflow_dispatch.
#
# Usage:
#   scripts/sync-plugin-binary.sh <run-id>
#   scripts/sync-plugin-binary.sh --ref <branch-name>
#
#   <run-id>          A GitHub Actions run id from the "Package claude-net
#                     plugin (linux-x64)" workflow (package-plugin.yml,
#                     repo andrewleech/claude-net). Verified below to
#                     actually belong to that workflow before use.
#   --ref <branch>    Resolve to the most recent successful run of that
#                     workflow for the given branch. `gh run list
#                     --branch` matches branch names only (not tags or
#                     arbitrary commit SHAs); pass a branch name here.
#
# Requires: gh (authenticated against andrewleech/claude-net), jq, and
# git-lfs installed (this script runs `git lfs install --local` itself;
# see .gitattributes for the tracked path pattern). All three are
# verified up front, before any network or git-mutating work happens.

REPO="andrewleech/claude-net"
WORKFLOW="package-plugin.yml"
ARTIFACT_NAME="claude-net-plugin-linux-x64"

usage() {
    echo "Usage: $0 <run-id> | --ref <branch-name>" >&2
    exit 1
}

if [ $# -eq 0 ]; then
    usage
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Preconditions: gh + jq drive the download/version-check pipeline below;
# a working, repo-local Git LFS integration is what keeps
# bin/claude-net-plugin-linux-x64 (see .gitattributes) out of git's own
# object history as a multi-MB blob. `git lfs install --local` is
# idempotent and safe to re-run, and writes the smudge/clean filter
# config into THIS repo's own .git/config, so staging doesn't silently
# depend on whatever (if anything) happens to be configured globally on
# the machine running this script -- self-describing for a fresh clone
# or a different host, not just "works today because of ambient config".
for cmd in gh jq git-lfs; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "ERROR: '$cmd' is required but not found on PATH." >&2
        exit 1
    fi
done
git -C "$repo_root" lfs install --local >/dev/null
if [ "$(git -C "$repo_root" config --local --get filter.lfs.clean)" != "git-lfs clean -- %f" ]; then
    echo "ERROR: Git LFS filters are not active for this repo after 'git lfs install --local'." >&2
    echo "       bin/$ARTIFACT_NAME would be added as a plain (multi-MB) git blob instead of" >&2
    echo "       an LFS pointer. Check your git-lfs installation and try again." >&2
    exit 1
fi

if [ "$1" = "--ref" ]; then
    ref="${2:?--ref requires a git ref argument}"
    echo "Resolving latest successful '$WORKFLOW' run for ref '$ref' in $REPO..."
    run_id=$(gh run list \
        --repo "$REPO" \
        --workflow "$WORKFLOW" \
        --branch "$ref" \
        --status success \
        --limit 1 \
        --json databaseId \
        --jq '.[0].databaseId')
    if [ -z "$run_id" ] || [ "$run_id" = "null" ]; then
        echo "ERROR: no successful '$WORKFLOW' run found for ref '$ref'" >&2
        exit 1
    fi
else
    run_id="$1"
fi

# Verify the run actually belongs to package-plugin.yml; gh run download
# only needs a run id + artifact name, so an id from an unrelated workflow
# that happens to produce a same-named artifact would otherwise be
# accepted silently.
expected_workflow_path=".github/workflows/$WORKFLOW"
run_workflow_path=$(gh api "repos/$REPO/actions/runs/$run_id" --jq '.path' 2>/dev/null || true)
if [ -z "$run_workflow_path" ]; then
    echo "ERROR: could not look up run $run_id in $REPO (bad run id, or no access)" >&2
    exit 1
fi
if [ "$run_workflow_path" != "$expected_workflow_path" ]; then
    echo "ERROR: run $run_id belongs to workflow '$run_workflow_path', not '$expected_workflow_path'" >&2
    exit 1
fi

bin_path="$repo_root/bin/$ARTIFACT_NAME"
version_path="$repo_root/bin/$ARTIFACT_NAME.version"

# This script is about to write and commit exactly these two paths.
# Refuse to run if either already carries an unrelated uncommitted local
# change (staged, unstaged, or untracked); committing over that would
# silently fold someone else's in-progress edit into this script's commit.
dirty=$(git -C "$repo_root" status --porcelain -- "bin/$ARTIFACT_NAME" "bin/$ARTIFACT_NAME.version")
if [ -n "$dirty" ]; then
    echo "ERROR: bin/$ARTIFACT_NAME and/or its .version sidecar already have uncommitted changes:" >&2
    echo "$dirty" | sed 's/^/    /' >&2
    echo "Commit or stash them first; this script only ever commits its own staged binary." >&2
    exit 1
fi

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

echo "Downloading artifact '$ARTIFACT_NAME' from run $run_id..."
gh run download "$run_id" --repo "$REPO" --name "$ARTIFACT_NAME" --dir "$workdir"

# gh's extraction layout for a single --name download has varied across
# versions (flat vs. nested under an artifact-name directory); search
# rather than assume.
downloaded_bin=$(find "$workdir" -type f -name "$ARTIFACT_NAME" | head -n1)
if [ -z "$downloaded_bin" ]; then
    echo "ERROR: '$ARTIFACT_NAME' not found anywhere under $workdir after download" >&2
    exit 1
fi
chmod +x "$downloaded_bin"

hub_version=$(jq -r '.version' "$repo_root/package.json")

# Query the downloaded binary's embedded PLUGIN_VERSION via a real MCP
# `initialize` handshake over stdio: mpyfastmcp populates the response's
# result.serverInfo.version directly from the plugin's PLUGIN_VERSION at
# MCPServer construction (see lib/mpyfastmcp/__init__.py in claude-net-mpy).
# This is the same stdio JSON-RPC session pattern claude-net-mpy's
# tests/packaged_binary_smoke.py drives the packaged artifact through
# (its `Session` class: write a JSON-RPC line to stdin, read one back from
# stdout); that script doesn't itself assert on serverInfo.version, but
# exercises the identical handshake this reuses, rather than grepping the
# binary for an embedded string or inventing a new "--version" flag the
# packaged binary doesn't have (it takes no arguments; see p8's app-runner
# mode). Closing stdin (printf's pipe reaching EOF) after the single
# request is enough to get a clean response + exit: mpyjsonrpc drains any
# already-in-flight request before honoring EOF-triggered shutdown
# (verified in claude-net-mpy's tests/ceremony_tests.py,
# test_request_correlation).
# `|| true` on this assignment matters under `set -euo pipefail`: without
# it, a crashing binary or an unparseable response would abort the script
# right here via errexit, before the "could not read PLUGIN_VERSION"
# diagnostic below ever gets a chance to run.
binary_version=$(
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"sync-plugin-binary","version":"0"}}}' \
        | timeout 10 "$downloaded_bin" \
        | head -n1 \
        | jq -r '.result.serverInfo.version' 2>/dev/null
) || true

echo "hub package.json version:        $hub_version"
echo "downloaded binary PLUGIN_VERSION: $binary_version"

if [ -z "$binary_version" ] || [ "$binary_version" = "null" ]; then
    echo "ERROR: could not read PLUGIN_VERSION from the downloaded binary's initialize response" >&2
    exit 1
fi

if [ "$binary_version" != "$hub_version" ]; then
    echo "ERROR: version mismatch: binary is '$binary_version', hub package.json is '$hub_version'." >&2
    echo "       Refusing to stage a binary that isn't in lockstep with this hub checkout." >&2
    exit 1
fi

new_sha=$(sha256sum "$downloaded_bin" | awk '{print $1}')

# Compare against what's currently on disk at bin/$ARTIFACT_NAME. The
# dirty-check above already guarantees the working tree matches HEAD for
# this path (or that the path doesn't exist yet), so hashing the on-disk
# file is equivalent to hashing what's committed, and unlike `git show
# HEAD:path`, it's correct for an LFS-tracked path: `git show` prints the
# raw LFS pointer blob, not the smudged binary content, so hashing that
# would never match a freshly downloaded artifact even when nothing
# actually changed.
committed_sha=""
if [ -f "$bin_path" ]; then
    committed_sha=$(sha256sum "$bin_path" | awk '{print $1}')
fi

if [ -n "$committed_sha" ] && [ "$committed_sha" = "$new_sha" ]; then
    echo ""
    echo "bin/$ARTIFACT_NAME is already up to date (sha256 $new_sha); nothing to stage."
    exit 0
fi

mkdir -p "$repo_root/bin"

# Stage via a .tmp sibling + atomic mv -f, the same discipline the
# launch wrapper uses client-side: a request to plugin-bin-server.ts
# arriving mid-write must never see a partially-copied file. A plain
# `cp` onto the live path has no such guarantee and could get hashed
# (and cached) mid-copy.
tmp_dest="$bin_path.tmp"
cp "$downloaded_bin" "$tmp_dest"
chmod +x "$tmp_dest"
mv -f "$tmp_dest" "$bin_path"

# Version sidecar: plugin-bin-server.ts reads this to advertise the
# version actually embedded in the staged binary, rather than trusting
# this hub checkout's own package.json (which can drift ahead of the
# last-staged binary between deploys; see DECISIONS.md Q6).
tmp_version="$version_path.tmp"
printf '%s\n' "$binary_version" > "$tmp_version"
mv -f "$tmp_version" "$version_path"

# `git add` these two paths specifically (never `-A`/`.`), then commit
# restricted to the same pathspec: `git commit -- <pathspec>` commits
# only the named paths' current content, leaving anything else already
# staged in the index untouched. The explicit `git add` first is required
# for the bootstrap case (first run ever: the paths are untracked, and
# `git commit -- <pathspec>` alone does not add untracked paths).
short_sha="${new_sha:0:12}"
git -C "$repo_root" add -- "bin/$ARTIFACT_NAME" "bin/$ARTIFACT_NAME.version"
git -C "$repo_root" commit \
    -m "claude-net-plugin: stage v$binary_version (sha256 $short_sha)" \
    -- "bin/$ARTIFACT_NAME" "bin/$ARTIFACT_NAME.version"

echo ""
echo "Committed bin/$ARTIFACT_NAME (version $binary_version, sha256 $new_sha)."
echo "Review with 'git show' / 'git log -1 --stat' before pushing; this script does not push."
