import assert from "node:assert/strict";
import { acceptanceMode } from "./image-acceptance-mode.mjs";

assert.deepEqual(acceptanceMode({}), {
  release: false,
  requireDebug: true,
});
assert.deepEqual(acceptanceMode({ AGENT_BASE_RELEASE_ACCEPTANCE: "1" }), {
  release: true,
  requireDebug: false,
});

console.log("✅ image acceptance mode selftest");
