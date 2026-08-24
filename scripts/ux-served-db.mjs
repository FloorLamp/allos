import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const UX_SERVED_DB_PREFIX = "allos-ux-walkthrough-";

// mkdtemp owns the directory; O_EXCL + O_NOFOLLOW reserves the database inode
// before any child can open it. Keeping the descriptor open lets every child
// boundary prove that the pathname still names that same inode, rather than a
// planted symlink or replacement outside the owned directory.
export function allocateUxServedDb(tmpRoot = os.tmpdir()) {
  const root = path.resolve(tmpRoot);
  const dir = fs.mkdtempSync(path.join(root, UX_SERVED_DB_PREFIX));
  fs.chmodSync(dir, 0o700);
  const dbPath = path.join(dir, "allos.db");
  let reservationFd;
  try {
    reservationFd = fs.openSync(
      dbPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_RDWR |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600
    );
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`Could not reserve owned UX database path: ${dbPath}`, {
      cause: error,
    });
  }
  const reserved = fs.fstatSync(reservationFd);
  return {
    root,
    dir,
    dbPath,
    reservationFd,
    reservedDev: reserved.dev,
    reservedIno: reserved.ino,
  };
}

export function assertUxServedDbOwned(allocation) {
  let pathStat;
  let fdStat;
  try {
    pathStat = fs.lstatSync(allocation.dbPath);
    fdStat = fs.fstatSync(allocation.reservationFd);
  } catch (error) {
    throw new Error(
      `Owned UX database reservation disappeared before use: ${allocation.dbPath}`,
      { cause: error }
    );
  }
  if (
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    pathStat.dev !== allocation.reservedDev ||
    pathStat.ino !== allocation.reservedIno ||
    pathStat.nlink !== 1 ||
    fdStat.dev !== allocation.reservedDev ||
    fdStat.ino !== allocation.reservedIno ||
    fdStat.nlink !== 1
  ) {
    throw new Error(
      `Owned UX database path no longer names its reserved regular file: ${allocation.dbPath}`
    );
  }
  return pathStat;
}

export function assertUxServedDbUnused(allocation) {
  const stat = assertUxServedDbOwned(allocation);
  if (stat.size !== 0)
    throw new Error(
      `Owned UX database reservation was modified before use: ${allocation.dbPath}`
    );
}

export function cleanupUxServedDb(allocation) {
  const expectedParent = path.resolve(allocation.root);
  const dir = path.resolve(allocation.dir);
  if (
    path.dirname(dir) !== expectedParent ||
    !path.basename(dir).startsWith(UX_SERVED_DB_PREFIX)
  ) {
    throw new Error(
      `Refusing to clean an unowned UX database directory: ${dir}`
    );
  }
  try {
    fs.closeSync(allocation.reservationFd);
  } catch (error) {
    if (error?.code !== "EBADF") throw error;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
