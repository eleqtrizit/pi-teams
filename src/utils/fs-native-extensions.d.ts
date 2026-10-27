declare module "fs-native-extensions" {
  /**
   * Try to take an exclusive (by default) open-file-description advisory
   * lock on an open file descriptor (flock(2) on macOS, fcntl(F_OFD_SETLK)
   * on Linux).
   *
   * @param fd - Open file descriptor
   * @param offset - Byte offset of the lock range; defaults to 0
   * @param length - Byte length of the lock range; 0 locks to EOF
   * @param opts - Pass `{ shared: true }` for a shared lock
   * @returns true when the lock was taken; false when another open file
   *   description already holds it
   * @throws The kernel error (through libuv's errno naming) for anything
   *   other than contention
   */
  export function tryLock(
    fd: number,
    offset?: number,
    length?: number,
    opts?: { shared?: boolean },
  ): boolean;

  /** Release the advisory lock taken by tryLock on this descriptor. */
  export function unlock(fd: number): void;
}
