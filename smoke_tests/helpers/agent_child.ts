// Child process fixture for registry and messaging smoke tests.
// Usage: node bundle.js <id> <kind> <cwd> [leadId] [name]
// Set AGENT_CHILD_CHECK_SENDER=1 to apply the receiver-side sender check that
// extensions/index.ts runs, so forged senders are rejected.
import { authorizeSender } from "../../src/utils/messaging.ts";
import { AgentKind, type TeamMessage } from "../../src/utils/models.ts";
import { writeAgentRecord } from "../../src/utils/registry.ts";
import { startListener } from "../../src/utils/transport.ts";

const [id, kindArg, cwd, leadId, name] = process.argv.slice(2);
if (!id || !cwd || !Object.values(AgentKind).includes(kindArg as AgentKind)) {
  throw new Error("Usage: node bundle.js <id> <kind> <cwd> [leadId] [name]");
}
const checkSender = process.env.AGENT_CHILD_CHECK_SENDER === "1";

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
  if (checkSender) authorizeSender(message, id);
  process.stdout.write(`${JSON.stringify(message)}\n`);
});

process.on("SIGTERM", () => {
  void listener.close().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  void listener.close().finally(() => process.exit(0));
});
process.stdout.write(`${JSON.stringify({ ready: true, id })}\n`);
