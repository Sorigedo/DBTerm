# Platform and Release Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native execution selected by the user).

**Goal:** Turn the six remaining audit gaps into reproducible implementation and release gates without claiming hardware, Windows, database-server, or signing evidence that is unavailable locally.

**Architecture:** Keep database and SSH code isolated. Add small testable helpers and acceptance scripts rather than changing database semantics for a test. Platform-specific checks fail closed when their required environment is absent; local checks run against temporary data and loopback services only.

**Tech Stack:** React/TypeScript tests, Rust unit/integration tests, Tauri debug build, macOS CoreGraphics/WKWebView probes, Cargo target checks, shell/Python acceptance scripts.

**Spec:** `AGENTS.md`, `docs/audit-closeout-checklist.md`, `docs/audit-release-verdict.md`.

## Global Constraints

- Never connect to saved credentials, business databases, remote SSH servers, or installed production software.
- Preserve DB/SSH isolation and do not rewrite user DDL.
- Hardware, Windows, external database versions, and signing certificates must produce explicit `UNVERIFIED` results when unavailable.
- Release gates must fail closed for missing evidence.
- Run one consolidated verification after implementation.

## Review Focus

- A lost pointer-up event must end xterm selection; test via event sequence and focus loss.
- A long result/import workload must release owned buffers; test repeated bounded iterations and RSS sampling.
- A Windows build must not silently fall back to macOS-only assumptions; test target availability and conditional compilation.
- A package must not be called signed when identity or notarization evidence is absent; test gate output.
- Database/SSH acceptance must use only disposable loopback fixtures; test fixture isolation and cleanup.

### Task 1: Platform evidence and gate runner

**Files:**
- Create: `scripts/acceptance/platform-release-gates.py`
- Create: `docs/platform-release-gates.md`
- Modify: `package.json` (add a gate command)

- [ ] Detect and report macOS, Windows target/toolchain, Docker/Podman, signing identity, notarization credentials, and test-only environment without reading saved app credentials.
- [ ] Return nonzero when a required gate is requested but its environment is absent; support `--local-only` for the current isolated run.
- [ ] Emit JSON evidence with per-gate `PASS`, `UNVERIFIED`, or `FAIL` and cleanup paths.

### Task 2: Touchpad/terminal selection regression

**Files:**
- Inspect/modify: `src/components/Terminal/terminalDragRecovery.ts`, `src/components/Terminal/index.tsx`
- Test: existing terminal selection tests plus a macOS event-sequence acceptance script if supported.

- [ ] Preserve the lost-mouseup and focus-loss behavior.
- [ ] Add a deterministic event trace for single-click then pointer movement and three-finger-selection compatibility assumptions.

### Task 3: Long-running memory/performance gate

**Files:**
- Create: `scripts/acceptance/memory-stress.py`
- Modify: `docs/db-result-memory-safety.md`

- [ ] Run only temporary SQLite/DuckDB data and local fixtures.
- [ ] Sample child RSS over repeated query/import/copy operations, enforce result/file budgets, and report plateau versus growth without inventing a pass threshold.

### Task 4: Cross-platform build gate

**Files:**
- Create: `scripts/acceptance/cross-platform-build.py`
- Modify: `README.md` and release docs.

- [ ] Check installed Rust targets and compile/check available targets offline.
- [ ] Produce explicit `UNVERIFIED` for Windows when the target/toolchain is absent; never label macOS compilation as Windows validation.

### Task 5: Database/SSH local matrix

**Files:**
- Modify: `scripts/acceptance/isolated-duckdb.py`
- Create: `scripts/acceptance/local-matrix.py`

- [ ] Run existing SQLite/DuckDB/loopback SSH checks and discover disposable MySQL/PostgreSQL services only from explicit environment variables.
- [ ] Keep absent services as skipped/unverified and ensure temporary directories/processes are cleaned.

### Task 6: Signing/install/upgrade gate

**Files:**
- Create: `scripts/acceptance/signing-install-gate.py`
- Create: `docs/signing-install-gate.md`

- [ ] Verify bundle metadata, reproducible build output, codesign identity, notarization ticket, and upgrade fixture when credentials/tools exist.
- [ ] Fail closed for release claims when signing or upgrade evidence is missing.

### Task 7: Unified verification

- [ ] Run frontend tests, typecheck, Rust full tests, local matrix, memory gate, cross-platform gate, signing gate, and `git diff --check` in one frozen-source run.
- [ ] Update the audit verdict with exact counts and explicit unverified gates.
