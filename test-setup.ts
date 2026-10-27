// Isolate the agent registry (~/.pi/agent/pi-teams) for every test file, so
// tests never write records or sockets into the real registry. Short prefix:
// socket paths are capped at 90 chars.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const isolatedRegistry = fs.mkdtempSync(path.join(os.tmpdir(), "t"));
process.env.PI_TEAMS_REGISTRY_DIR = isolatedRegistry;

// Tests that depend on agent identity stub PI_* explicitly. Remove ambient
// values (for example a worker pane's own PI_AGENT_ID/PI_AGENT_TYPE) so a
// suite run inside a spawned agent behaves like a clean run.
delete process.env.PI_AGENT_ID;
delete process.env.PI_AGENT_TYPE;
delete process.env.PI_AGENT_NAME;
delete process.env.PI_LEAD_ID;

afterAll(() => {
  fs.rmSync(isolatedRegistry, { recursive: true, force: true });
});
