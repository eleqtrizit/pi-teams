import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkCliVersion,
  compareVersions,
  packageVersion,
  versionFilePath,
  writeVersionFile,
} from "./version";

describe("compareVersions", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.8.7", "0.9.0")).toBeLessThan(0);
    expect(compareVersions("0.8.7", "0.8.10")).toBeLessThan(0);
    expect(compareVersions("0.8.7", "0.8.7")).toBe(0);
  });

  it("ignores a prerelease suffix", () => {
    expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBe(0);
  });

  it("throws on a value that is not a version", () => {
    expect(() => compareVersions("latest", "1.0.0")).toThrow(/Invalid version/);
  });
});

describe("packageVersion", () => {
  it("reads the version from package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
    expect(packageVersion()).toBe(pkg.version);
  });
});

describe("version file", () => {
  let original: string | undefined;
  let dir: string;

  beforeEach(() => {
    original = process.env.PI_TEAMS_REGISTRY_DIR;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "v"));
    process.env.PI_TEAMS_REGISTRY_DIR = dir;
  });

  afterEach(() => {
    process.env.PI_TEAMS_REGISTRY_DIR = original;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes the version privately and replaces an older one", () => {
    writeVersionFile("1.2.3");
    writeVersionFile("1.2.4");
    expect(fs.readFileSync(versionFilePath(), "utf8")).toBe("1.2.4\n");
    expect(fs.statSync(versionFilePath()).mode & 0o077).toBe(0);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("fails when the file is missing, naming the pi install command", () => {
    const check = checkCliVersion("1.0.0");
    expect(check).toMatchObject({ ok: false, reason: "missing" });
    expect(check.ok === false && check.message).toContain("pi install https://github.com/eleqtrizit/pi-teams");
  });

  it("fails when the CLI is older than the extension, naming the upgrade command", () => {
    writeVersionFile("1.1.0");
    const check = checkCliVersion("1.0.9");
    expect(check).toMatchObject({ ok: false, reason: "outdated" });
    expect(check.ok === false && check.message).toContain("npm i -g @eleqtrizit/pi-teams-cli");
  });

  it("fails when the file holds something that is not a version", () => {
    fs.writeFileSync(versionFilePath(), "garbage\n");
    expect(checkCliVersion("1.0.0")).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("passes when the CLI equals or exceeds the extension", () => {
    writeVersionFile("1.0.0");
    expect(checkCliVersion("1.0.0")).toEqual({ ok: true, cli: "1.0.0", extension: "1.0.0" });
    expect(checkCliVersion("1.0.1")).toMatchObject({ ok: true });
  });
});
