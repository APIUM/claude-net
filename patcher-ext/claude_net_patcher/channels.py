"""The channel + workflow gate patches.

Most patches here emit Edits with `delta == 0` (same-length surgery);
`SessionChannelListPatch` is the one growable exception.

`expect_count = (1, None)` on the same-length patches means "apply to
every match, as long as there is at least one" — no upper bound. This
mirrors the anchors' minified-identifier patterns, which can and do
match more than once per build (occurrence counts drift release to
release); every match gets the same same-length rewrite.

Reference: CLAUDE_CODE_PATCHING_GUIDE.md §"Current patches".
"""

import re

from cc_patcher.context import DiscoveryContext
from cc_patcher.edits import Edit


class FeatureGatePatch:
    name = "Feature gate (tengu_harbor)"
    description = "Force the tengu_harbor Statsig feature flag to true."
    may_grow = False
    expect_count = (1, None)
    diag_anchor = b"tengu_harbor"
    PATTERN = rb'\{return [a-zA-Z0-9_$]+\("tengu_harbor",!1\)\}'
    NEW_BODY = b"return!0"

    def discover(self, ctx: DiscoveryContext) -> list[Edit]:
        edits: list[Edit] = []
        for m in ctx.find_regex_in_payload(self.PATTERN):
            old = m.group(0)
            pad = len(old) - len(self.NEW_BODY) - 2
            new = b"{" + self.NEW_BODY + b" " * pad + b"}"
            edits.append(Edit(
                offset=m.start(), old=old, new=new,
                patch_name=self.name,
            ))
        return edits

    def cache_key(self) -> str:
        return (
            f"FeatureGatePatch:{self.PATTERN.decode('latin1')}:"
            f"{self.NEW_BODY.decode('latin1')}"
        )


class OrgPolicyChannelsEnabledPatch:
    name = "Org policy (channelsEnabled)"
    description = "Invert the channelsEnabled policy check from !==!0 to ===!0."
    may_grow = False
    expect_count = (1, None)
    diag_anchor = b"channelsEnabled"
    OLD = b"channelsEnabled!==!0"
    NEW = b"channelsEnabled===!0"

    def discover(self, ctx: DiscoveryContext) -> list[Edit]:
        return [
            Edit(
                offset=off, old=self.OLD, new=self.NEW,
                patch_name=self.name,
            )
            for off in ctx.find_in_payload(self.OLD)
        ]

    def cache_key(self) -> str:
        return (
            f"OrgPolicyChannelsEnabledPatch:{self.OLD.decode('latin1')}:"
            f"{self.NEW.decode('latin1')}"
        )


class AllowlistBypassPatch:
    name = "Channel allowlist bypass"
    description = "Replace !VAR.dev with always-false in the allowlist check."
    may_grow = False
    expect_count = (1, None)
    diag_anchor = b'kind:"allowlist"'
    PATTERN = rb'if\(![a-zA-Z0-9_$]+\.dev\)return\{action:"skip",kind:"allowlist"'
    INNER = re.compile(rb"!\w+\.dev")
    NEW_BODY = b"!1"

    def discover(self, ctx: DiscoveryContext) -> list[Edit]:
        edits: list[Edit] = []
        for m in ctx.find_regex_in_payload(self.PATTERN):
            inner = self.INNER.search(m.group(0))
            if inner is None:
                continue
            inner_start = m.start() + inner.start()
            old = inner.group(0)
            new = self.NEW_BODY + b" " * (len(old) - len(self.NEW_BODY))
            edits.append(Edit(
                offset=inner_start, old=old, new=new,
                patch_name=self.name,
            ))
        return edits

    def cache_key(self) -> str:
        return (
            f"AllowlistBypassPatch:{self.PATTERN.decode('latin1')}:"
            f"{self.NEW_BODY.decode('latin1')}"
        )


class DevChannelsDialogPatch:
    name = "Dev channels dialog auto-accept"
    description = (
        "Force the dev-channels approval dialog's IF branch to fire by "
        "replacing the leading !FOO() with !0 (true) padded to length."
    )
    may_grow = False
    expect_count = (1, None)
    diag_anchor = b'policySettings'
    PATTERN = (
        rb'if\(!\w+\(\)\|\|\w+\(\)!=="firstParty"'
        rb'\|\|\w+\(\w+\("policySettings"\)\)\)'
    )
    INNER = re.compile(rb"!\w+\(\)")
    NEW_BODY = b"!0"

    def discover(self, ctx: DiscoveryContext) -> list[Edit]:
        edits: list[Edit] = []
        for m in ctx.find_regex_in_payload(self.PATTERN):
            inner = self.INNER.search(m.group(0))
            if inner is None:
                continue
            inner_start = m.start() + inner.start()
            old = inner.group(0)
            new = self.NEW_BODY + b" " * (len(old) - len(self.NEW_BODY))
            edits.append(Edit(
                offset=inner_start, old=old, new=new,
                patch_name=self.name,
            ))
        return edits

    def cache_key(self) -> str:
        return (
            f"DevChannelsDialogPatch:{self.PATTERN.decode('latin1')}:"
            f"{self.NEW_BODY.decode('latin1')}"
        )


class NotificationSuppressionPatch:
    name = "Channel notification suppression"
    description = (
        "Suppress the 'server: entries need --dangerously-load-development-"
        "channels' toast by neutering the !VAR.dev predicate."
    )
    may_grow = False
    expect_count = (1, None)
    diag_anchor = b'server: entries need'
    PATTERN = (
        rb'if\(![a-zA-Z0-9_$]+\.dev\)[a-zA-Z0-9_$]+\.push'
        rb'\(\{entry:[a-zA-Z0-9_$]+,why:"server: entries need'
    )
    INNER = re.compile(rb"!\w+\.dev")
    NEW_BODY = b"!1"

    def discover(self, ctx: DiscoveryContext) -> list[Edit]:
        edits: list[Edit] = []
        for m in ctx.find_regex_in_payload(self.PATTERN):
            inner = self.INNER.search(m.group(0))
            if inner is None:
                continue
            inner_start = m.start() + inner.start()
            old = inner.group(0)
            new = self.NEW_BODY + b" " * (len(old) - len(self.NEW_BODY))
            edits.append(Edit(
                offset=inner_start, old=old, new=new,
                patch_name=self.name,
            ))
        return edits

    def cache_key(self) -> str:
        return (
            f"NotificationSuppressionPatch:{self.PATTERN.decode('latin1')}:"
            f"{self.NEW_BODY.decode('latin1')}"
        )


class SessionChannelListPatch:
    """Give the per-session channel lookup a synthetic fallback entry.

    `s2r()` decides whether an MCP server may register a channel. After
    the capability / provider / policy checks it does:

        let i=IRt(e,tR());
        if(!i)return{action:"skip",kind:"session",
                     reason:`server ${e} not in --channels list ...`};

    `tR()` is `allowedChannels()`, populated only from
    `--dangerously-load-development-channels` (a.k.a. `--channels`), so
    without that flag every server is skipped no matter how many of the
    downstream policy / allowlist / dialog gates are neutered. This is
    the one channel gate that cannot be forced from inside the binary
    by a boolean flip — the code needs an *entry object*, not a true.

    So append `??{kind:"server",name:e,dev:!0}` to the lookup: an
    explicitly-listed server or plugin still resolves to its real
    entry (preserving the marketplace check for `kind:"plugin"`), and
    anything unlisted gets a synthetic dev server entry, which reaches
    `{action:"register"}`. Channels then work under any launcher,
    including ones that exec the patched binary with no channel argv.

    Grows the payload by the length of the appended expression, so this
    is a growable edit and must declare its containing StringPointer
    region.

    Anchored on the body signature rather than the minified function
    name (`IRt` in 2.1.229, `Z` in 2.1.246, `CZ` in 2.1.251), the
    outer function's second parameter (`t` in 2.1.229/2.1.246, `r` in
    2.1.251), the split-result variable (`r` in 2.1.229/2.1.246, `o`
    in 2.1.251), or the lambda's parameter name (`n` in 2.1.229, `i`
    in 2.1.246, `a` in 2.1.251) — all of which drift every release.
    2.1.251 also extended the lambda body with a plugin-vs-server
    ternary the anchor never needed to match in the first place, since
    it only anchors on the shared `kind==="server"` prefix.
    """

    name = "Session channel list fallback (IRt)"
    description = (
        "Make the per-session channel lookup fall back to a synthetic "
        "server entry so channels register without "
        "--dangerously-load-development-channels."
    )
    may_grow = True
    expect_count = 1
    diag_anchor = b"not in --channels list for this session"
    ANCHOR_RX = (
        rb'function [\w$]{1,6}\(e,([\w$])\)\{'
        rb'(?=let [\w$]{1,3}=e\.split\(":"\);return \1\.find\(\(([\w$])\)=>\2\.kind==="server")'
    )
    FALLBACK = b'??{kind:"server",name:e,dev:!0}'

    def discover(self, ctx: DiscoveryContext) -> list[Edit]:
        matches = ctx.find_regex_in_payload(self.ANCHOR_RX)
        if len(matches) != 1:
            return []
        body_start = matches[0].end()
        body_end = ctx.find_balanced_close(
            body_start, ctx.bun.offsets_struct_offset,
        )
        if body_end is None:
            return []
        # The fallback is only valid appended directly to the trailing
        # `t.find(...)` call expression. A different last byte means the
        # body shape drifted (e.g. a trailing `;`), so emit nothing and
        # let the expect_count check report the miss.
        if ctx.buf[body_end - 1] != ord(")"):
            return []
        region = ctx.containing_string_pointer(body_end)
        if region is None:
            return []
        return [Edit(
            offset=body_end, old=b"}", new=self.FALLBACK + b"}",
            patch_name=self.name, grows_region=region,
        )]

    def cache_key(self) -> str:
        return (
            f"SessionChannelListPatch:{self.ANCHOR_RX.decode('latin1')}:"
            f"{self.FALLBACK.decode('latin1')}"
        )


class DynamicWorkflowsMasterGatePatch:
    """Force the Workflow master gate to report "enabled", across the two
    gate shapes seen in the field.

    2.1.280+ reason-string gate (`Bfr`): the resolver returns a
    disabled-reason string — `"managed_settings"`, `"org_policy"`,
    `"unavailable"`, `"user_setting"` — or `void 0` when workflows are
    enabled. The Workflow tool's `validateInput` treats a non-`void 0`
    return as disabled (`let a=Bfr();if(a!==void 0){...feature_disabled
    ...}`), and the boolean wrapper `zd()` — the tool's `isEnabled`,
    prompt-text inclusion, tool-list assembly, and effort gates all
    resolve through it — is `return Bfr()===void 0`. So the enabling
    value is `void 0`, not `true`: the polarity is inverted from the
    boolean gate, and a `return!0` rewrite would mark workflows
    permanently disabled. The whole body is rewritten to `return void 0`
    + padding, anchored on the body's first statement (the managed
    `disableWorkflows` / `userSettings` check).

    <=2.1.263 boolean gate (`Y2`): short-circuits to `!1` on the first
    failed check and returns `<launch-gate>()??<defaultOn>`. The whole
    matched body is flipped to `return!0` + padding.

    Exactly one shape is present in a given build; whichever matches is
    patched (the reason-string shape takes precedence). Both anchor on
    structure, not the minified function name (`Y2`, then `Bfr`).
    """

    name = "Dynamic workflows master gate (Y2)"
    description = (
        "Force the Workflow master gate to report enabled: rewrite the "
        "2.1.280+ disabled-reason resolver to return void 0, or flip the "
        "older boolean gate to return true."
    )
    may_grow = False
    expect_count = (1, None)
    diag_anchor = b"defaultOn"
    # 2.1.280+ reason-string resolver: anchor on the unique first
    # statement, rewrite the whole body to `return void 0`.
    BFR_RX = re.compile(
        rb'function [\w$]{1,8}\(\)\{(?='
        rb'let [\w$]+=[\w$]+\(\),[\w$]+=[\w$]+&&!'
        rb'[\w$]+\.CLAUDE_CODE_DISABLE_WORKFLOWS&&'
        rb'[\w$]+\("disableWorkflows",!1\)\.source==="userSettings";)'
    )
    BFR_BODY = b"return void 0"
    # <=2.1.263 boolean gate: flip the whole body to `return!0`.
    BOOL_RX = re.compile(
        rb'if\([\w$]+\(\)\)return!1;if\(![\w$]+\(\)\)return!1;'
        rb'let\{available:[\w$]+,defaultOn:[\w$]+\}=[\w$]+(?:\.[\w$]+)*\(\);'
        rb'if\(![\w$]+\)return!1;'
        rb'return [\w$]+\(\)(?:\?\.[\w$]+(?:\.[\w$]+)*)?\?\?[\w$]+'
    )
    BOOL_BODY = b"return!0"

    def discover(self, ctx: DiscoveryContext) -> list[Edit]:
        end = ctx.bun.offsets_struct_offset
        bfr = ctx.find_regex_in_payload(self.BFR_RX.pattern)
        if bfr:
            edits: list[Edit] = []
            for m in bfr:
                body_start = m.end()
                body_end = ctx.find_balanced_close(body_start, end)
                if body_end is None:
                    continue
                body_len = body_end - body_start
                if body_len < len(self.BFR_BODY):
                    continue
                old = bytes(ctx.buf[body_start:body_end])
                new = self.BFR_BODY + b" " * (body_len - len(self.BFR_BODY))
                edits.append(Edit(
                    offset=body_start, old=old, new=new,
                    patch_name=self.name,
                ))
            return edits
        edits = []
        for m in ctx.find_regex_in_payload(self.BOOL_RX.pattern):
            old = m.group(0)
            new = self.BOOL_BODY + b" " * (len(old) - len(self.BOOL_BODY))
            edits.append(Edit(
                offset=m.start(), old=old, new=new,
                patch_name=self.name,
            ))
        return edits

    def cache_key(self) -> str:
        return (
            f"DynamicWorkflowsMasterGatePatch:"
            f"{self.BFR_RX.pattern.decode('latin1')}:"
            f"{self.BFR_BODY.decode('latin1')}:"
            f"{self.BOOL_RX.pattern.decode('latin1')}:"
            f"{self.BOOL_BODY.decode('latin1')}"
        )
