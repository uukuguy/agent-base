# agent-base Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven development to implement each task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent-base safe to run and easier to verify by closing the P0/P1 security and correctness gaps identified in the review.

**Architecture:** Add small shared policy helpers for child-process environments, trace redaction, and manifest integrity. Keep adapters responsible for harness-specific layout while startup and verification enforce common safety rules. Preserve the existing four-gate contract and make malformed or incomplete evidence fail closed.

**Tech Stack:** Node.js ESM, Make, AJV/YAML, existing selftest scripts, Docker verification when available.

**Execution status:** Tasks 1–5 are partially implemented in this session. Focused selftests and static checks pass; the full regression remains environment-blocked by unavailable Docker and loopback listeners. A GitHub Actions production-acceptance workflow now provides the required Docker/QEMU/loopback runner path. Remaining hardening includes external credential rotation/history cleanup, provider SSRF/YAML protections, signed overlays/modules, and reproducible image/SBOM verification.

## Global Constraints

- Never expose or recreate the committed credential; external credential rotation remains an operator action.
- Production child processes receive only an explicit environment allowlist and declared runtime parameters.
- Production trace output defaults to digest/safe fields; full content requires explicit debug opt-in.
- Every production behavior change gets a failing selftest before implementation.
- Existing adapter contracts and zero-credential selftests must remain compatible.

---

### Task 1: Credential hygiene and stable test entry

**Files:**
- Modify: `.gitignore`
- Delete: `.env`
- Modify: `package.json`
- Create: `tools/hygiene-selftest.mjs`

- [ ] **Step 1: Write the failing hygiene selftest**

Assert that `.env` is absent, Git does not track it, and `npm test -- --help` reaches the configured test entry.

- [ ] **Step 2: Run the selftest and confirm it fails**

Run: `node tools/hygiene-selftest.mjs`
Expected: FAIL because `.env` is present/tracked and the test script is missing.

- [ ] **Step 3: Apply the minimal hygiene changes**

Add `.env`, `.env.*`, and secret files to `.gitignore`; remove the working-tree `.env`; add `"test": "node tools/regression.mjs --fast"` to `package.json`; add the selftest target to Makefile.

- [ ] **Step 4: Run the selftest again**

Run: `node tools/hygiene-selftest.mjs`
Expected: PASS. Do not claim historical cleanup is complete until an operator rotates the key and rewrites Git history.

### Task 2: Shared child environment policy and DSH safe default

**Files:**
- Create: `core/image/child-env.mjs`
- Create: `core/image/child-env-selftest.mjs`
- Modify: `core/image/startup.mjs:636-638`
- Modify: `adapters/dsh/run.mjs:117-145`
- Modify: `tools/run-local.mjs:179-196`

- [ ] **Step 1: Write failing environment policy tests**

Cover: safe platform variables survive; `AWS_SECRET_ACCESS_KEY` and arbitrary host variables do not; declared runtime values are injected; invalid permission modes fail; DSH defaults to `workspace-write`.

- [ ] **Step 2: Run the tests and confirm the expected failures**

Run: `node core/image/child-env-selftest.mjs`
Expected: FAIL on inherited secrets and `danger-full-access` default.

- [ ] **Step 3: Implement `buildChildEnv()`**

Use an explicit allowlist for `PATH`, `HOME`, `LANG`, `TZ`, `TMPDIR`, `AGENT_*` control variables, and declared values. Validate `AGENT_PERMISSION_MODE` against `ask`, `workspace-write`, and `danger-full-access`.

- [ ] **Step 4: Route startup, DSH, and local execution through the helper**

Remove direct `...process.env` spreads from child environment construction. Preserve endpoint, trace, and bundle values through explicit arguments.

- [ ] **Step 5: Run the tests and relevant adapter selftests**

Run: `node core/image/child-env-selftest.mjs && node adapters/dsh/capabilities-selftest.mjs`
Expected: PASS, subject to the existing local-listener restriction for integration portions.

### Task 3: Safe trace raw events and crash output

**Files:**
- Create: `core/trace/sanitize.mjs`
- Create: `core/trace/sanitize-selftest.mjs`
- Modify: `adapters/pi/trace.mjs`
- Modify: `adapters/dsh/trace.mjs`
- Modify: `tools/run-local.mjs`
- Modify: `core/image/startup.mjs`

- [ ] **Step 1: Write failing redaction tests**

Assert that raw events keep type/call ID/status but remove message text, tool result bodies, headers, and nested secrets; assert that crash-tail formatting contains only bounded safe summaries.

- [ ] **Step 2: Run the tests and confirm failure**

Run: `node core/trace/sanitize-selftest.mjs`
Expected: FAIL because raw event bodies are currently retained.

- [ ] **Step 3: Implement bounded safe-field sanitization**

Add a shared sanitizer that returns a safe summary with a fixed byte limit. Make full raw output opt-in through `AGENT_TRACE_CONTENT=full` and keep digest as the default.

- [ ] **Step 4: Update both adapters and startup crash reporting**

Replace `raw: rec` with the sanitizer result unless explicit full debug mode is enabled. Cap crash-tail lines and bytes.

- [ ] **Step 5: Run trace selftests**

Run: `node core/trace/sanitize-selftest.mjs && node core/trace/selftest.mjs && node adapters/pi/trace-selftest.mjs`
Expected: PASS.

### Task 4: Manifest integrity and runtime layout correctness

**Files:**
- Create: `core/image/manifest-integrity.mjs`
- Create: `core/image/manifest-integrity-selftest.mjs`
- Modify: `adapters/pi/render.mjs`
- Modify: `adapters/dsh/render.mjs`
- Modify: `core/image/startup.mjs`
- Modify: `adapters/pi/run.mjs`
- Modify: `adapters/dsh/run.mjs`

- [ ] **Step 1: Write failing manifest tamper tests**

Render a fixture, modify only `runtimePlan` or `prependArgs`, and assert startup refuses the artifact. Add a test for explicit `runtimePlan.configDir` and reject an escaped path.

- [ ] **Step 2: Run the tests and confirm failure**

Run: `node core/image/manifest-integrity-selftest.mjs`
Expected: FAIL because the manifest is currently trusted without a control-plane digest.

- [ ] **Step 3: Add a canonical control-plane digest**

Hash a normalized manifest projection excluding the digest field itself. Store it as `manifestDigest` during both renders.

- [ ] **Step 4: Verify the digest before `prepare` and local execution**

Fail closed on mismatch or malformed JSON. Add explicit `runtimePlan.configDir` and use it instead of `Object.values(plan.env)[0]`.

- [ ] **Step 5: Run startup and adapter selftests**

Run: `node core/image/manifest-integrity-selftest.mjs && node core/image/startup-selftest.mjs && node adapters/pi/selftest.mjs`
Expected: PASS.

### Task 5: Verification fail-closed behavior and CLI correctness

**Files:**
- Create: `core/gates/report-selftest.mjs`
- Modify: `core/gates/report.mjs`
- Modify: `tools/verify.mjs`
- Modify: `core/gates/cli.mjs`
- Modify: `tools/run-local.mjs`
- Modify: `adapters/pi/run.mjs`
- Modify: `core/image/startup.mjs`

- [ ] **Step 1: Write failing tests**

Cover nonzero child exit, timeout, empty checks, unknown flags, `--harness-home`, and missing Pi credential file error messages.

- [ ] **Step 2: Run the tests and confirm failure**

Run: `node core/gates/report-selftest.mjs`
Expected: FAIL on empty gates, unknown flags, or ignored child status.

- [ ] **Step 3: Enforce closed CLI schemas and report validation**

Reject unknown flags; require non-empty checks for required gates; convert child nonzero and timeout into explicit failed/crashed checks.

- [ ] **Step 4: Fix adapter correctness issues**

Register `--harness-home`, replace undefined `HARNESS_NAME`, and use declared `configDir`.

- [ ] **Step 5: Run focused and full available verification**

Run: `node core/gates/report-selftest.mjs && node core/gates/selftest.mjs && node tools/validate.mjs --selftest && git diff --check`
Expected: focused checks pass; environment-limited integration failures must be recorded explicitly.

### Task 6: Documentation and regression gate

**Files:**
- Modify: `Makefile`
- Modify: `docs/14-how-to-verify.md`
- Modify: `README.md`
- Modify: `docs/status/INDEX.md`
- Modify: `docs/reviews/2026-09-30-agent-base-design-code-review.md`

- [ ] **Step 1: Add targets for new selftests and correct stale commands**

Make the documented command names match the Makefile and list the actual P0/P1 status.

- [ ] **Step 2: Run documentation and regression checks**

Run: `make docs-check` if available, `make regression FAST=1`, and `npm test`.

- [ ] **Step 3: Record remaining environment blockers**

If Docker or loopback networking remains unavailable, report those exact failures instead of marking the repository green.

- [x] **Step 4: Add a production CI runner path**

Add `.github/workflows/production-acceptance.yml` with Node 24, Docker Buildx, QEMU for the second architecture, an explicit loopback probe, both image variants plus OCI manifest build, full regression, and uploaded JSON evidence. Keep local sandbox failures separate from CI production acceptance.

### Implementation notes (2026-09-30)

- DSH 的 `staging` 现在明确指向运行根目录，`configDir` 单独保留；新增 `adapters/dsh/staging-selftest.mjs` 并接入回归清单。
- Pi/DSH 自检在判据完成后显式结束，Pi 运行器释放子进程 stdio，避免原生运行时句柄让 CI 永久等待。
- OrbStack 本地已完成四个架构/调试镜像变体和 OCI manifest 重建；`node tools/regression.mjs --json` 已退出码 0，失败与跳过均为空。
