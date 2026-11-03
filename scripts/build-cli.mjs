// Bundles src/cli.ts into cli/pi-teams.cjs, the single file the
// @eleqtrizit/pi-teams-cli npm package ships, and syncs cli/package.json's
// version to the root package.json so the CLI and the pi extension always
// carry the same version.
//
//   node scripts/build-cli.mjs
//
// fs-native-extensions stays external: it is a native addon, installed as the
// CLI package's one dependency.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const cliPkgPath = path.join(root, "cli", "package.json");
const cliPkg = JSON.parse(fs.readFileSync(cliPkgPath, "utf8"));

// The addon version the CLI installs must match what the extension tests against.
const addon = rootPkg.dependencies?.["fs-native-extensions"];
if (cliPkg.version !== rootPkg.version || cliPkg.dependencies?.["fs-native-extensions"] !== addon) {
  cliPkg.version = rootPkg.version;
  cliPkg.dependencies = { ...cliPkg.dependencies, "fs-native-extensions": addon };
  fs.writeFileSync(cliPkgPath, `${JSON.stringify(cliPkg, null, 2)}\n`);
}

const outfile = path.join(root, "cli", "pi-teams.cjs");
await build({
  entryPoints: [path.join(root, "src", "cli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["fs-native-extensions"],
  define: { __PI_TEAMS_VERSION__: JSON.stringify(rootPkg.version) },
  logLevel: "warning",
});
fs.chmodSync(outfile, 0o755);
console.log(`built ${path.relative(root, outfile)} (${rootPkg.version})`);
