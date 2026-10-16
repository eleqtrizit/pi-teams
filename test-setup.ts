// Isolate the per-user agent registry (<tmpdir>/pi-<uid>) for every test file, so tests
// never write records or sockets into the real registry. Short prefix: socket paths are capped at 90 chars.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "t"));
process.env.TMPDIR = isolatedTmp;

afterAll(() => {
  fs.rmSync(isolatedTmp, { recursive: true, force: true });
});
