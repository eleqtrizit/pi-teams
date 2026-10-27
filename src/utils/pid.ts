/**
 * Check whether a process with the given pid exists.
 *
 * Signal 0 performs no signal delivery; it only checks existence and
 * permission. An EPERM error means the process exists but belongs to
 * another user, which still proves it is alive.
 *
 * @param pid - Process id to check
 * @returns True when the process exists
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code === "EPERM";
  }
}
