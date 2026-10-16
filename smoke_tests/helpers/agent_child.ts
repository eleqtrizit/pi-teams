// Child process fixture for registry and messaging smoke tests.
// Usage: node bundle.js <id> <kind> <cwd> [leadId] [name]
import { AgentKind, type TeamMessage } from "../../src/utils/models.ts";
import { writeAgentRecord } from "../../src/utils/registry.ts";
import { startListener } from "../../src/utils/transport.ts";

const [id, kindArg, cwd, leadId, name] = process.argv.slice(2);
if (!id || !cwd || !Object.values(AgentKind).includes(kindArg as AgentKind)) {
  throw new Error("Usage: node bundle.js <id> <kind> <cwd> [leadId] [name]");
}

const record = {
  id,
  kind: kindArg as AgentKind,
  cwd,
  pid: process.pid,
  startedAt: Date.now(),
  ...(leadId ? { leadId } : {}),
  ...(name ? { name } : {}),
};
writeAgentRecord(record);
const listener = await startListener(id, async (message: TeamMessage) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
});

process.on("SIGTERM", () => {
  void listener.close().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  void listener.close().finally(() => process.exit(0));
});
process.stdout.write(`${JSON.stringify({ ready: true, id })}\n`);
