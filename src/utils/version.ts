/**
 * Package version and the version file that ties the `pi-teams` CLI to the
 * pi extension. The extension writes `<registry>/version.txt` at
 * `session_start`; the CLI refuses to run when that file is missing or names
 * a newer version than the CLI itself, so a CLI that lags the extension
 * cannot speak an outdated protocol to the team.
 */
import fs from "node:fs";
import path from "node:path";
import { registryDir } from "./paths";
import { ensurePrivateDir } from "./transport";

/** Command that installs or upgrades the CLI. */
export const CLI_INSTALL_COMMAND = "npm i -g @eleqtrizit/pi-teams-cli";
/** Command that installs or upgrades the pi extension. */
export const EXTENSION_INSTALL_COMMAND = "pi install https://github.com/eleqtrizit/pi-teams";

/** Injected by `scripts/build-cli.mjs` when the CLI is bundled; undefined everywhere else. */
declare const __PI_TEAMS_VERSION__: string | undefined;

let cachedVersion: string | undefined;

/**
 * Version in this package's `package.json`, found by walking up from this file.
 *
 * @returns The version string, for example `0.8.7`
 * @throws Error when no `pi-teams` package.json is found above this file
 */
export function packageVersion(): string {
  if (cachedVersion) return cachedVersion;
  // The bundled CLI has no pi-teams package.json beside it; it carries the version.
  if (typeof __PI_TEAMS_VERSION__ === "string") {
    cachedVersion = __PI_TEAMS_VERSION__;
    return cachedVersion;
  }
  let dir = typeof __dirname === "string" ? __dirname : process.cwd();
  for (;;) {
    const file = path.join(dir, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "pi-teams" && typeof pkg.version === "string") {
        cachedVersion = pkg.version;
        return pkg.version;
      }
    } catch {
      // Not here; keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Cannot find the pi-teams package.json to read its version.");
    dir = parent;
  }
}

/** Path of the version file the pi extension writes. */
export function versionFilePath(): string {
  return path.join(registryDir(), "version.txt");
}

/**
 * Record the running pi extension's version for the CLI to check.
 *
 * @param version - Version to record; defaults to this package's
 */
export function writeVersionFile(version: string = packageVersion()): void {
  ensurePrivateDir(registryDir());
  const file = versionFilePath();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${version}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Compare two `major.minor.patch` versions; a prerelease suffix is ignored.
 *
 * @returns Negative when `a < b`, 0 when equal, positive when `a > b`
 * @throws Error when either version is not `major.minor.patch`
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    if (!match) throw new Error(`Invalid version "${v}".`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/** Outcome of {@link checkCliVersion}. */
export type VersionCheck =
  | { ok: true; cli: string; extension: string }
  | { ok: false; reason: "missing" | "invalid" | "outdated"; message: string };

/**
 * Check this CLI against the version file the pi extension wrote.
 *
 * A missing file fails: it means pi-teams never ran in pi on this machine, so
 * there is nothing to verify the CLI against. A file naming a newer version
 * fails with the upgrade command. A CLI at or above the recorded version passes.
 *
 * @param cliVersion - The CLI's own version; defaults to this package's
 */
export function checkCliVersion(cliVersion: string = packageVersion()): VersionCheck {
  const file = versionFilePath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8").trim();
  } catch {
    return {
      ok: false,
      reason: "missing",
      message:
        `${file} is missing, so pi-teams has not run in pi on this machine. ` +
        `Install the pi extension with \`${EXTENSION_INSTALL_COMMAND}\`, start pi once, then retry.`,
    };
  }
  try {
    if (compareVersions(cliVersion, raw) < 0) {
      return {
        ok: false,
        reason: "outdated",
        message:
          `The pi-teams CLI (${cliVersion}) is older than the pi extension (${raw}). ` +
          `Upgrade it with \`${CLI_INSTALL_COMMAND}\`.`,
      };
    }
  } catch {
    return {
      ok: false,
      reason: "invalid",
      message: `${file} does not hold a version ("${raw}"). Start pi once to rewrite it, then retry.`,
    };
  }
  return { ok: true, cli: cliVersion, extension: raw };
}
