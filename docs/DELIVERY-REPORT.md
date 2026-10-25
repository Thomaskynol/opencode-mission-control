# Delivery Report — feat/autonomous-orchestrator-v2 (M1–M7 + review-fixes)

Final verification lane (`final-verify`). Sole writer of this file. No product-logic changes made.

## 1. Clone path / base / commits

- Local path: `/home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control`
- Branch: `feat/autonomous-orchestrator-v2` (local only; tracks nothing — `git branch -vv` shows no upstream for it)
- Base = `main` = `origin/main` = `6db667e ci(deps): Update dependency bun to v1.3.14 (#82)`
- Branch was cut exactly at base (`main` also at `6db667e`); **all M1–M7 + review-fixes work is uncommitted** (23 modified + 21 untracked paths, `git diff --cached` empty)
- Remotes (sanitized): `origin git@github.com:Thomaskynol/opencode-mission-control.git` (fetch+push),
  `upstream https://github.com/nigel-dev/opencode-mission-control.git` (fetch only, `no_push`)
- Recent base history (`git log --oneline -8` on branch): `6db667e`, `895a232`, `d234113`, `0e76440`, `ea0d1a2`, `16692aa`, `32d3207`, `c63ba10`

## 2. Architecture / decisions / reuse

- One-tool-per-file kept (`src/tools/*`); shared logic in `src/lib/*`; no new deps (`package.json` untouched: `@opencode-ai/plugin`, `@opencode-ai/sdk`, `zod` only).
- M1: inter-process safety via `src/lib/file-lock.ts` (lockfile O_EXCL + stale-break + timeout); durability via
  `src/lib/durable-state.ts` (sidecar `runtime-state.json` + `reconcileOnBoot`: dedupe by id, prune stale, quarantine corrupt);
  `job-state`/`plan-state`/`port-allocator` moved onto `withFileLock`; publish paths (`git push`, `gh pr create/merge`,
  `npm/pnpm/yarn publish`, `git -C <dir> push`, deploy) gated behind explicit `humanAuth` (`permission-policy.ts` + `integration.ts`).
- M2: SDK `1.1.53` targets unprefixed paths the real `serve` 2.1.4 doesn't serve — v2 section in `sdk-client.ts` uses
  verified `/api` surface (from the 2.1.4 `/openapi.json`) via fetch; legacy code untouched (see `docs/m2-instance.md`).
- M3: `coordinator.ts` `coordinateOnce` = observe → decide → dispatch → gate → enqueue, single judge, `clampMaxParallel` 4–8.
- M4: `reviewer.ts` fail-closed (`pass` requires non-empty diff, touchSet respected, `exitCode === 0` evidence on exact commit,
  every essential requirement anchored in **test output**); merge-train serializes per branch under file lock, runs
  `testCommand` (+ optional `regressionCommand`), rolls back on failure/conflict; empty diff = no-op success.
- M5/M7 wiring: `runCoordinatorPass` runs inside `_doReconcile` reusing existing `launchJob` (gate=false, no reintegration,
  budget preserved under clamp); `mc_report_final` builds Verified-vs-Gaps report (`verified` = merged-only).
- M6: separate conversational TUI process (`src/orchestrator-cli/`, `bun src/orchestrator-cli/index.ts <cmd>`) talking to the
  coordinator via local state only; `job-pause`/`job-resume` tools; stopping never discards code (only `mc_cleanup` does).
- Review-fixes (authorized contract change): fix-before-rollback and plan-fork now require `JobSpec.remoteSessionID`
  (never prompts the operator's launch session); `verified` merged-only; `updateJob` invalid transitions throw;
  `PUSH_PATTERN` widened; budget compensation clamped ≥ 0. Details in `docs/review-fixes.md`.

## 3. Start / use (real commands)

```sh
cd /home/thomaskyn/Documents/dev/orquestrador-opencodes/opencode-mission-control
bun install
bun run build        # bun build ./src/index.ts --outdir ./dist --target bun
bun test             # full suite
bun test <path>      # focused, e.g. bun test tests/lib/wire-report.test.ts
```

- Prerequisites: `tmux` + `git` required; `gh` (authenticated) only for `mc_pr`/plan PRs.
- Plugin use: add `"opencode-mission-control"` to `plugins` in `opencode.json` (no manual `npm install`).
- Human CLI: `bun src/orchestrator-cli/index.ts help|follow|send|task|pause|resume|add|answer|questions|order|session|log|cancel`
- Manual E2E: `MANUAL_TEST_PLAN.md` (Quick Smoke first; Nuclear Cleanup before/after; `tmc-` naming; no remote-push flows in tests).

## 4. Requirements vs validation (matrix)

| ID | Requirement | Implementation | Validation |
| --- | --- | --- | --- |
| M1 | Inter-process lock for state RMW | `src/lib/file-lock.ts` | `tests/lib/file-lock.test.ts` — full suite green (see §5) |
| M1 | Durable pendingQuestions/messageBus/accumulators/SSE cursor + kill-9 resume | `src/lib/durable-state.ts` | `tests/lib/durable-state.test.ts` — green |
| M1 | No push/PR/deploy without explicit human auth | `permission-policy.ts` + `integration.ts` + `pr.ts` + `orchestrator.createPR` | `tests/lib/publish-guards.test.ts` — green |
| M1 | Existing state files on locks | `job-state.ts`, `plan-state.ts`, `port-allocator.ts` | existing suites, no regression |
| M2 | Real instance control, profile equivalence | `instance-manager.ts` + v2 `sdk-client.ts` | `instance-manager.test.ts`, `sdk-client-v2.test.ts` — green |
| M3 | Coordinator single judge loop | `coordinator.ts` | `coordinator.test.ts` — green |
| M4 | Fail-closed reviewer gate + serialized merge | `reviewer.ts`, `merge-train.ts`, `integration.ts`, `git.ts` | `reviewer.test.ts`, `merge-train.test.ts` — green |
| M5 | Final wiring, single idempotent queue | `orchestrator.ts`, `merge-train.ts` | `wire-report.test.ts` (11 tests) — green |
| M6 | Human pause/resume/answer without data loss | `orchestrator-cli/`, `job-pause.ts`, `job-resume.ts`, `answer.ts`, `overview.ts` | `human-controls.test.ts`, `answer.test.ts` — green |
| M7 | Readable final report, verified-vs-gaps | `reports.ts`, `report.ts` (+ `report-final.test.ts`) | `report-final.test.ts`, `wire-report.test.ts` — green |
| RF | 8 review findings (red) + 6 (yellow) | see `docs/review-fixes.md` | full suite, no new failure (see §5) |

## 5. Real checks and runs (fresh, this lane)

All run from the repo root, output to local logs under `/tmp/opencode/`, exit captured immediately (`status=$?`, no masking pipe).

| # | Command | Result | Evidence |
| --- | --- | --- | --- |
| A | `bun run build` | **exit 0** — `Bundled 221 modules in 27ms`, `index.js 1.33 MB` | `/tmp/opencode/final-verify-build.log` |
| B | `bun test` (full) | **exit 1** — **921 pass, 16 skip, 1 fail** (`mc_launch > serve mode > should wait for server and send prompt via SDK`, `tests/tools/launch.test.ts:644`) | `/tmp/opencode/final-verify-test.log` |
| C | `bun test tests/tools/launch.test.ts` (isolated) | **exit 0** — **44 pass, 0 fail** | `/tmp/opencode/final-verify-launch-alone.log` |
| D | `bun test tests/lib/model-tracker.test.ts tests/tools/launch.test.ts` (order repro) | **exit 1** — same single failure (58 pass, 1 fail) | `/tmp/opencode/final-verify-order.log` |
| E | `git status` / `git log --oneline -8` / `git remote -v` (sanitized) / `git diff --stat` (+ `--cached`) | branch `feat/autonomous-orchestrator-v2`, base `6db667e`, 23 modified + 21 untracked, staged empty, nothing pushed | §1 + §7 |

No code edits, no stash, no reset, no push/PR performed by this lane. Stash-repro deliberately skipped: both files in the
failure pair (`tests/tools/launch.test.ts`, `tests/lib/model-tracker.test.ts`) are **untouched by every lane**
(absent from `git status` modified list), so the failure exists identically on base — stash would prove nothing new and risk the uncommitted tree.

### The 1 remaining failure is the pre-existing order-dependent `launch` flake

- `launch.test.ts:644` expects `createSessionAndPrompt` called with `model: undefined`; when `model-tracker.test.ts` runs
  first in the same process, leaked module state (`lastSetModel = google/gemini-pro`, set by model-tracker's last test with
  only `beforeEach` reset and no trailing cleanup) makes `getCurrentModel()` return a value.
- Proven: C passes alone, D reproduces with only those two untouched files, B shows no other failure across 938 tests / 59 files.
- Suggested follow-up (out of scope for all lanes): trailing `_resetForTesting()` (`afterEach`/`afterAll`) in `model-tracker.test.ts`.

## 6. Simultaneous instances + model/profile observed

- This lane ran sequential `bun` processes only (build → full suite → two isolated repros). No tmux sessions, worktrees,
  branches, or serve-mode instances were created by this lane.
- No simultaneous worker instances and no model/profile behaviour were observed or are claimed here — **not proven by this lane**
  (live multi-instance orchestration belongs to `MANUAL_TEST_PLAN.md`, not executed here).
- Model used by this lane: the session's own model (no pinned `V2ModelRef` involved in verification).

## 7. Change / leftover-resource state

- Modified (23, unstaged): `README.md`, `src/index.ts`, `src/lib/{git,integration,job-state,merge-train,orchestrator,permission-policy,plan-state,plan-types,port-allocator,reports,sdk-client}.ts`,
  `src/tools/{answer,overview,pr,report}.ts`, `tests/lib/{job-state,merge-train,orchestrator,plan-types}.test.ts`,
  `tests/{plugin-init,tools/overview}.test.ts` — `1635 insertions(+), 125 deletions(-)`.
- Untracked (21): `docs/` (USER-GUIDE, m2/m3/m4/m5m7/m6, matrix-plan, milestones, ownership, review-fixes + this report),
  `src/lib/{coordinator,durable-state,file-lock,instance-manager,reviewer}.ts`, `src/orchestrator-cli/`,
  `src/tools/{job-pause,job-resume}.ts`, 10 test files (`coordinator`, `durable-state`, `file-lock`, `human-controls`,
  `instance-manager`, `publish-guards`, `reviewer`, `sdk-client-v2`, `wire-report`, `orchestrator-cli/`, `answer`, `report-final`).
- Test resources remaining in `/tmp/opencode` (not mine — **not touched**): `e2e-*`, `m2-evidence`, `v2-contracts`, `verify/`,
  `agents.json`, `orch_content.jsonl`, `root_msgs.jsonl`, serve logs, etc. (full listing via `ls /tmp/opencode/`).
- Mine in `/tmp/opencode` (kept as evidence): `final-verify-{build,test,launch-alone,order}.log`.
- Global OpenCode profile/config: not modified. No branches/worktrees created or deleted by this lane.

## 8. Publication confirmation

- **Nothing published**: no `push`, no PR, no tag, no `npm publish`, no remote mutation of any kind.
  `git status` shows the branch ahead of nothing / tracking nothing; `origin`/`upstream` untouched.
- Commits: **BLOCKED — no git identity configured** (`git config user.name` / `user.email` both empty).
  Per instructions no identity was invented, so no local commit was created. To unblock (human runs):
  `git config user.name "…" && git config user.email "…"`, then stage + commit conventionally on
  `feat/autonomous-orchestrator-v2` (e.g. grouped `feat:`/`fix:`/`docs:` commits per lane; do not rewrite base history).

## 9. Limitations / pending / unproven

- The `launch` order-flake (§5) is the only failing test; fix is a suggested follow-up, not applied (out of scope).
- `mc_report_final` is exported + tested but **not registered in `src/index.ts`** (documented follow-up in `docs/m5m7-wire.md`).
- Legacy (non-`/api`) senders remain in `question-relay.ts`, `job-comms.ts`, `monitor.ts`, `orchestrator-cli/index.ts`
  (only `mc_answer` migrated); `instance-manager` projectID create-vs-assert pauses with a drift question by design.
- Live E2E (multi-instance tmux/worktree orchestration, `MANUAL_TEST_PLAN.md`) was **not executed** by this lane — unit/integration
  evidence only. Interventions by this lane: none (read-only verification + this report).
