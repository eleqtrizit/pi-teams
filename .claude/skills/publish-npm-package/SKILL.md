---
name: publish-npm-package
description: Check, bump, build, and publish the @eleqtrizit/pi-teams-cli npm package (the pi-teams CLI), and verify the published result. Use when releasing a new CLI version or asking what version is live.
---

# Publish `@eleqtrizit/pi-teams-cli`

The CLI is its own npm package, built from `src/cli.ts` into `cli/pi-teams.cjs` by `scripts/build-cli.mjs`. The root package (`pi-teams`, the pi extension) is NOT published to npm; the name belongs to someone else. pi users get the extension with `pi install`.

## 1. Check what is live

```sh
npm view @eleqtrizit/pi-teams-cli versions dist-tags --json
npm whoami                      # must print eleqtrizit
```

A version named `0.0.0-stage` is a placeholder stub with no binary. Ignore it; never install it to verify.

## 2. Bump the version

The version lives in three places that must match: root `package.json`, root `package-lock.json` (lines 3 and 9), and `claude-mod/.claude-plugin/plugin.json`. `cli/package.json` is synced from the root by the build script, so do not edit it by hand. Registry versions are immutable: any change to the CLI, even a one-line string, needs a new version.

```sh
sed -i '' 's/"version": "OLD"/"version": "NEW"/' package.json claude-mod/.claude-plugin/plugin.json
# then package-lock.json lines 3 and 9
```

## 3. Verify, commit, push

```sh
npx tsc --noEmit && npm test
git add -A && git commit && git push origin main
```

`npm test` includes tests of the built binary.

## 4. Publish

Publishing needs the user's one-time password (2FA). An agent cannot supply it: ask the user for a current code, or have them run the command with the `!` prefix.

Always tell the user to use the script, never a raw `npm publish`:

```sh
sh scripts/publish-cli.sh <otp>      # builds, then npm publish --access public --otp=<otp>
```

The script also runs without a code (`sh scripts/publish-cli.sh`), which fails with EOTP when 2FA is on.

Never run publish twice without checking `npm view` first: a staged-publish flow can leave a pending version.

## 5. Verify the registry copy

Install into a throwaway prefix, not globally:

```sh
rm -rf /tmp/ptv && mkdir /tmp/ptv
npm i -g --prefix /tmp/ptv @eleqtrizit/pi-teams-cli@NEW
/tmp/ptv/bin/pi-teams version
```

Expect `"version":"NEW"`. `versionCheck.ok:false` about a missing `version.txt` is normal until pi has run once with the extension. The tarball should hold 3 files (`pi-teams.cjs`, `package.json`, `README.md`).

## Gotchas

- Run `node scripts/build-cli.mjs` before packing; `cli/pi-teams.cjs` is gitignored.
- The CLI refuses to run when `~/.pi/agent/pi-teams/version.txt` names a newer version than the CLI, so bump the extension and CLI together.
- Install commands users see live in `src/utils/version.ts`, the README, and `claude-mod/hooks/lib.ts`; keep them in sync.
