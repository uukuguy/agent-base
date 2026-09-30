#!/usr/bin/env node
import assert from "node:assert/strict";
import { hostImageArch } from "./host-arch.mjs";

assert.equal(hostImageArch("arm64"), "arm64");
assert.equal(hostImageArch("x64"), "amd64");
assert.equal(hostImageArch("x86_64"), "amd64");
assert.equal(hostImageArch("aarch64"), "arm64");
assert.throws(() => hostImageArch("ia32"), /Unsupported host architecture/);

console.log("✅ host image architecture selftest");
