// Isolate the agent registry (~/.pi/agent/pi-teams) for every test file, so
// tests never write records or sockets into the real registry. Short prefix:
// socket paths are capped at 90 chars.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const isolatedRegistry = fs.mkdtempSync(path.join(os.tmpdir(), "t"));
process.env.PI_TEAMS_REGISTRY_DIR = isolatedRegistry;

afterAll(() => {
  fs.rmSync(isolatedRegistry, { recursive: true, force: true });
});
