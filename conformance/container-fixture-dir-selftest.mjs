import assert from "node:assert/strict";
import fs from "node:fs";
import { createContainerFixtureDir } from "./container-fixture-dir.mjs";

for (const writable of [false, true]) {
  const dir = createContainerFixtureDir("container-dir-test-", { writable });
  try {
    const mode = fs.statSync(dir).mode & 0o1777;
    assert.equal(mode & 0o005, 0o005, "a different container UID must be able to read and traverse the fixture");
    assert.equal(Boolean(mode & 0o002), writable, "only output fixtures allow another UID to write");
    if (writable) assert.equal(mode & 0o1000, 0o1000, "writable output fixtures must use the sticky bit");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log("✅ container fixture directory permissions");
