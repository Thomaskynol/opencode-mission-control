# Review fixes — independent review findings (all addressed)

Scope: review-fixes. Contract change explicitly authorized: merge-train
fix-before-rollback and plan-fork now require `JobSpec.remoteSessionID`
(the remote worker session); the launch session is never prompted.

## 🔴 Fixed

1. `src/lib/coordinator.ts` — `redactSecrets` used `text.indexOf(token)`
   inside `replace`, judging every repeated token by the FIRST occurrence's
   context. Now uses the `replace` match `offset` per occurrence.
2. `src/lib/file-lock.ts` + `src/lib/integration.ts` — new exported
   `INTEGRATION_STALE_MS` (660s > 600s max merge-test hold);
   `withIntegrationLock` defaults to it and documents why. Wait timeout
   intentionally unchanged: a second merger fails fast, never corrupts.
3. `src/lib/merge-train.ts` + `src/lib/plan-types.ts` + `src/lib/orchestrator.ts`
   — fix-before-rollback targeted `job.launchSessionID` (the operator's own
   control-center session). Now targets `job.remoteSessionID` (new optional
   `JobSpec` field) via the v2 `/api` client (`createV2Client` + `v2Prompt`);
   without port + remote session it logs loudly and rolls back — never
   prompts the wrong session. Plan fork (`executeAddJob`) prefers the remote
   session as fork source and propagates `remoteSessionID`.
4. `src/lib/orchestrator.ts` — `planModelSnapshot` is now a stored
   `V2ModelRef` triple; `setPlanModelSnapshot(string | V2ModelRef)` keeps
   string callers working, `resolveCoordinatorModel` returns the snapshot
   untouched so a pinned variant survives (pin triplo). CLI launcher still
   gets `provider/id` (`modelRefToCliString`; variant has no `-m` form).
5. `src/lib/reviewer.ts` — `anchorCovered` no longer accepts a filename
   substring in the diff as coverage; anchors must appear in observable
   test output. Docs/comments updated (`testAnchors` = substrings that
   must appear in test output).
6. `src/orchestrator-cli/forms.ts` + `src/lib/durable-state.ts` — new
   `updateRuntimeSnapshot` (single holder of the file lock across
   load-mutate-save); `persistPendingQuestion`/`dropPersistedQuestion` use
   it, closing the cross-process lost-update race. Corrupt sidecars are
   quarantined, never resurrected.
7. `src/tools/answer.ts` — legacy `createJobClient`/`sendPrompt` replaced
   with `createV2Client` + `v2Prompt` (the 2.x server only serves `/api`).
8. `src/tools/report.ts` — `verified` is now merged-only; `completed`
   without a merge lands under Gaps as "outcome not verified" (a worker
   claim is not evidence).

## 🟡 Fixed

- `PUSH_PATTERN`: also blocks `git -C <dir> push`, `gh pr merge`,
  `pnpm`/`yarn publish` (was: bare `git push`, `gh pr create`,
  `npm publish` only).
- `classifyOutcome`: new explicit `failed` state for `testsPassed === false`
  (never "idle"/"concluded" again).
- Budget compensation in `runCoordinatorPass`: compensated running count
  clamped at 0 so `maxParallel` above the 4–8 cap cannot inflate the
  budget past the cap.
- `updateJob`: invalid transitions now throw instead of warn-and-apply.
  Required map gap fixes: job `merging → failed` (merge failures are real),
  job `running/paused → stopped` (kill path), job `running → paused`
  (pause path), and the missing `paused` entry itself (previously the
  validator silently skipped every paused transition).
- Plan `merging → failed`: already present, no change needed.
- `coordinator-client.getDashboard` `paused` and `overview` Paused
  section: now derived from each job's LATEST report (stale paused
  reports no longer resurface; repeats collapse to one line).

## Registered limitations (no code change, fail-safe as-is)

- `instance-manager` projectID create-vs-assert: `session.create` has no
  projectID field (the server derives it from `location.directory`), so a
  profile that pins projectID cannot be mounted verbatim — `launch()`
  pauses with a drift question instead of continuing degraded. Safe
  direction; document, don't relax.
- Legacy (non-`/api`) senders remain in `question-relay.ts`,
  `job-comms.ts`, `monitor.ts` and `orchestrator-cli/index.ts` (answer
  path); only `mc_answer` was in scope. Follow-up: migrate the rest to
  `createV2Client` + `v2Prompt`.
- `PUSH_PATTERN` does not parse quoted paths with spaces in
  `git -C "..." push`; argv arrays rarely embed quotes. Acceptable.

## Full-suite note (known `launch` flake, isolated)

`bun test` (full): 921 pass, 16 skip, 1 fail —
`mc_launch > serve mode > should wait for server and send prompt via SDK`.
Isolated reproduction with files untouched by this lane:

```
bun test tests/lib/model-tracker.test.ts tests/tools/launch.test.ts
# → same 1 failure
bun test tests/tools/launch.test.ts   # alone → 44 pass, 0 fail
```

Root cause: `model-tracker.test.ts` leaves module state behind
(`lastSetModel = google/gemini-pro`, no `afterEach` reset), and
`launch.test.ts` asserts `createSessionAndPrompt` was called with
`model: undefined`. Order-dependent, pre-existing, unrelated to these
fixes. Suggested follow-up (out of scope): `_resetForTesting()` in an
`afterEach` of `model-tracker.test.ts`.
