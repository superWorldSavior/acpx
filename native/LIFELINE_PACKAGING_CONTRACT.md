# Native lifeline packaging contract

The package ships one verified helper per supported POSIX target. The runtime
selects a target from `process.platform` and `process.arch`; it never compiles,
downloads, or uses a user-cache helper.

## Paths

```text
dist/native/lifeline-darwin-arm64
dist/native/lifeline-darwin-x64
dist/native/lifeline-linux-arm64
dist/native/lifeline-linux-x64
dist/native/lifeline-manifest.json
```

The helper mode is exactly `0755`; the manifest mode is exactly `0644`. The
files must be regular non-symlink files owned by the package owner, and the
runtime must reject group/world writable paths before execution. The packaging
check rejects any other mode.
The package root, `dist`, and `dist/native` directories are likewise required
to be non-symlink directories owned by that same package owner without group
or world write bits. The canonical parent chain is checked up to `/`: sticky
temporary directories are accepted, as are root-owned `root:root` group-write
boundaries used by some system mounts; other writable ancestors are rejected.

Darwin helpers are compiled with an explicit macOS deployment target of
`11.0`, matching the supported Node 22 binary floor and the current macOS CI
runners. CI and release inspect the Mach-O load command and reject a helper
whose minimum OS version is not `11.0`.

Linux helpers are linked statically (`-static`) and are rejected by the build
if `file` does not identify them as statically linked. This avoids coupling a
published Linux helper to the glibc version of the CI runner that built it.

## Manifest

`dist/native/lifeline-manifest.json` is canonical UTF-8 JSON with two-space
indentation and one trailing newline. Target keys are sorted lexicographically:

```json
{
  "schema": "acpx.native-lifeline.v1",
  "helpers": {
    "darwin-arm64": {
      "file": "lifeline-darwin-arm64",
      "platform": "darwin",
      "arch": "arm64",
      "sha256": "<64 lowercase hex characters>"
    },
    "darwin-x64": {
      "file": "lifeline-darwin-x64",
      "platform": "darwin",
      "arch": "x64",
      "sha256": "<64 lowercase hex characters>"
    },
    "linux-arm64": {
      "file": "lifeline-linux-arm64",
      "platform": "linux",
      "arch": "arm64",
      "sha256": "<64 lowercase hex characters>"
    },
    "linux-x64": {
      "file": "lifeline-linux-x64",
      "platform": "linux",
      "arch": "x64",
      "sha256": "<64 lowercase hex characters>"
    }
  }
}
```

The manifest is generated only after all requested helper files exist. A
release package is invalid unless all four entries are present and each digest
matches its named file. Windows is intentionally absent and remains an
unsupported/fallback decision for the core runtime.

## Checkout development and packing

The checkout `prepare` lifecycle runs `husky && pnpm run build:native`, so
`pnpm dev` and the source-based conformance runner have the host helper ready
after dependency installation. The published npm package has no install or
postinstall compilation hook: consumers receive prebuilt helpers and never
compile into a cache.

Local packing and release packing require the complete four-target payload:
`prepack` runs the TypeScript build without cleaning `dist/native`, then
`build:native:check` rejects a package unless all four helpers and matching
digests are present. A single-host checkout build is therefore suitable for
development only; assemble all target artifacts before `npm pack` or publish.

## Containment boundary

The package-contained lifeline provides process-group cleanup, not an absolute
process-tree guarantee. Once the helper is armed, an owner-pipe close causes it
to terminate the bridge's process group. During orderly ACPX teardown, the
cooperative cleanup path also snapshots and cleans descendants it observed,
including a descendant that has already left the process group.

A descendant that creates a new session or process group, for example through
`setsid()` or a detached spawn, can escape the process-group kill if the owner
dies before ACPX can observe and clean it. Such detached descendants are
outside the abrupt-owner guarantee; the package must not claim to terminate
arbitrary descendants in every case.

This is complementary to the cooperative cleanup path: normal close and
signal-driven teardown use ACPX's observed-agent cleanup, while the native
helper is the abrupt-owner fallback for the bridge process group. Stronger
containment would require an OS-specific boundary such as a delegated Linux
cgroup or a platform-specific macOS supervisor, which is outside this
package-contained POSIX lifeline contract.

The helper verifies that the target process group exists before announcing
`ARMED`. If the group disappears completely while the owner pipe remains open,
the helper exits without signalling that numeric process-group ID. A confirmed
owner-pipe EOF/HUP reaps a still-existing group; an indeterminate `poll` or
`read` error exits without signalling, and `R` releases without reaping.
Polling reduces, but cannot eliminate, the theoretical race in which a numeric
PGID is reused between observation and signalling. A helper-first launcher or
kernel-backed process anchor would be required for a stronger identity
guarantee; that mechanism is outside this prototype contract.
