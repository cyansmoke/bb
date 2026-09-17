# Personal macOS build with Keychain plugin secrets

This local-only build stores standard plugin settings declared with
`secret: true` in the macOS login Keychain. It does not isolate full-trust
plugins after a value is returned to plugin memory, and it does not cover
provider CLI credentials, plugin-owned OAuth files, bb Connect authentication,
or public access controls.

## Pinned base and license

- Upstream: `https://github.com/get-bb/bb.git`
- Pinned base: `3e9bef842539d5a1dd83d648fe9d5a7a20de4397`
- Base date checked: 2026-09-17
- License: MIT, copyright 2026 Michael Yong
- Local branch: `personal/keychain-mvp`

Keep this checkout separate from plugin repositories and from the installed bb
application. Do not change the installed application's update channel.

## Storage contract

The `personal` desktop channel has a separate application identity (`bb
Personal`, `dev.bb.desktop.personal`) and defaults to `~/.bb-personal`. It
passes `BB_PLUGIN_SECRET_BACKEND=keychain` and the selected `BB_DATA_DIR` to
the bundled server. A Keychain service name is derived from the absolute data
directory and plugin ID; the setting key is the Keychain account. Different
data directories therefore use different namespaces.

Keychain failures are returned as unavailable errors. The server never reads
or writes a plaintext plugin-secret file as a fallback. The settings response
keeps `set` and adds `backend: "keychain"` plus a status of `configured`,
`not-configured`, or `unavailable`. Plugin `settings.get()` still returns the
secret value when Keychain is available.

The implementation uses the MIT-licensed `@napi-rs/keyring` binding and passes
UTF-8 bytes directly to macOS Keychain APIs. It does not launch a subprocess,
so the value is not placed in process arguments or a command stream. A locked
or denied login Keychain may prompt or fail; there is no automatic fallback.
The desktop package pins `npm@11.16.0` directly because the packaged runtime
must support offline plugin dependency installs; without the direct dependency,
electron-builder produced an empty packaged npm directory. The packaging audit
verifies the bundled CLI and its dependency graph.
The service namespace is stable while the data-dir path is unchanged, but
access after a signing-identity change depends on the resulting Keychain ACL
and must be verified with the packaged, signed application before migration.

## Build without installing

Use the repository-pinned Node and pnpm versions:

```bash
pnpm install --frozen-lockfile
BB_DESKTOP_RELEASE_CHANNEL=personal pnpm --filter @bb/desktop run package
```

The unpacked application is generated under `apps/desktop/release/`. The build
does not replace `/Applications/bb.app`, launch the result, or change the
working bb profile. Local signing follows the existing desktop build policy:
an available Developer ID is auto-discovered; otherwise the artifact may be
unsigned and is not notarized.

Before any manual smoke run, choose a new synthetic profile explicitly:

```bash
test_profile="$(mktemp -d /tmp/bb-personal-smoke.XXXXXX)"
BB_DATA_DIR="$test_profile" BB_DESKTOP_RELEASE_CHANNEL=personal \
  pnpm --filter @bb/desktop start:personal
```

Do not point a development or smoke build at `~/.bb`. Use synthetic plugin
credentials only. Removing a test plugin removes its Keychain items and any
retained legacy plaintext directory for that plugin; remove the temporary
profile after the application stops.

## Explicit migration

The migration command never selects a profile implicitly. Its first form lists
the plugin/key names of legacy plugin-secret files without reading their values:

```bash
pnpm exec tsx scripts/migrate-plugin-secrets-to-keychain.ts \
  --data-dir /absolute/test/profile
```

Applying requires an exact repeated path:

```bash
pnpm exec tsx scripts/migrate-plugin-secrets-to-keychain.ts \
  --data-dir /absolute/test/profile \
  --apply \
  --confirm /absolute/test/profile
```

Stop every bb process using the selected profile first. For each regular
secret file the command reads the source without following symlinks, checks
for an existing Keychain value, writes only when absent, reads the item back,
then atomically moves the source into a randomly named quarantine directory on
the same filesystem. It deletes only a quarantined entry whose device and inode
still match the originally opened file. A changed regular entry is restored
without overwriting a concurrently recreated source. If safe restoration is
impossible, the error names the retained quarantine path for manual recovery.
The migration then stops. A retry after a write succeeds with status `resumed`. A
different value already in Keychain is a conflict: the command does not
overwrite it and leaves the source file in place.

To trial an eventual migration from the working profile, first stop the
working application and make a separate copy at `~/.bb-personal`; test only
the copy. This repository does not perform that copy or migration. The source
profile and backups will still contain credentials until separately handled,
and deleting a file does not revoke a provider credential.

Use the exact absolute data-dir path used by the runtime. Lexically different
aliases or symlink paths intentionally select different Keychain namespaces,
even when they currently reach the same directory.

## Updating the personal build

The public fork uses `origin` for the personal fork and `upstream` for
`get-bb/bb`. Its default branch is `personal/keychain-mvp`, so scheduled GitHub
Actions checks run against the actual personal build rather than an unchanged
copy of upstream `main`.

Run the read-only compatibility check first:

```bash
pnpm personal:update:check
```

The command fetches `upstream/main`, reports ahead/behind counts, and uses
`git merge-tree` without changing the index or working tree. Conflicts are
listed by path and emitted as GitHub annotations in Actions. Exit status `2`
means conflicts; resolve them in a deliberate update branch instead of merging
blindly. The scheduled workflow performs the same check daily and can also be
started manually.

When the check is clean, update with a normal merge commit that does not rewrite
the public personal branch:

```bash
pnpm personal:update:apply
```

Then:

1. Keep the currently working personal application and profile unchanged.
2. Record the merged upstream commit and recheck its license.
3. Reinspect plugin settings storage, desktop runtime environment, application
   identity, and update-provider changes even when the mechanical merge was
   clean.
4. Run the focused Keychain, server, app, and desktop checks, then the relevant
   Turbo typechecks and builds.
5. Package with
   `BB_DESKTOP_RELEASE_CHANNEL=personal pnpm --filter @bb/desktop run package`.
   Confirm the generated configuration still names `bb Personal`,
   `dev.bb.desktop.personal`, and the personal channel, and that update support
   remains disabled.
6. Smoke-test the new application against a fresh temporary profile and
   synthetic secrets. Verify write, plugin read, replace, delete, restart,
   unavailable behavior, absence of plaintext secret files, and log/API
   redaction.
7. Only after those checks, quit the previous personal application and replace
   that personal artifact. Never overwrite the official bb application.

Rollback means restoring the previous personal application while keeping the
same `~/.bb-personal` path. A build without this patch cannot read these
Keychain items and must not silently recreate plaintext files. Retain the
previous personal artifact until the updated build has passed its smoke test.

## Verification boundary

Unit tests use synthetic values and temporary data directories with isolated
Keychain service namespaces. A source build or unit test does not prove the
behavior of an installed, signed application. A packaged restart test is still
required before real credentials are migrated.
