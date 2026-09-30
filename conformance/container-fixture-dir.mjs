import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createContainerFixtureDir(prefix, { writable = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // These isolated fixtures contain only test data and placeholder credentials.
  // Docker's non-root UID differs from the host UID on Linux runners.
  fs.chmodSync(dir, writable ? 0o1777 : 0o755);
  return dir;
}
