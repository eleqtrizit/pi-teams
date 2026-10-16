// Child process for the cross-process transport smoke test.
// Usage: node listener_child.ts <agentId> <outFile>
// Listens on the agent ID, appends each message body, and exits on "stop".
import fs from "node:fs";
import { startListener } from "../../src/utils/transport.ts";

const [agentId, outFile] = process.argv.slice(2);
const listener = await startListener(agentId, async (message) => {
  fs.appendFileSync(outFile, `${message.text}\n`);
  if (message.text === "stop") setTimeout(() => listener.close().then(() => process.exit(0)), 20);
});
fs.writeFileSync(`${outFile}.ready`, "ready");
