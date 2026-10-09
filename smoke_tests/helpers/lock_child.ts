// Child for 03: wait for a barrier, enter the critical section once, report overlap.
import fs from "node:fs";
import path from "node:path";
import { withLock } from "../../src/utils/lock.ts";

const [target, barrierMs, outFile] = process.argv.slice(2);
const marker = path.join(path.dirname(target), "inside.marker");
while (Date.now() < Number(barrierMs)) { /* spin */ }
await withLock(target, async () => {
  try {
    fs.writeFileSync(marker, String(process.pid), { flag: "wx" });
  } catch {
    fs.appendFileSync(outFile, `VIOLATION ${process.pid}\n`);
    await new Promise((r) => setTimeout(r, 30));
    return;
  }
  await new Promise((r) => setTimeout(r, 30));
  fs.unlinkSync(marker);
}, 600);
