# Matrix Plan (M1 slice)

| Requirement | Implementation | Test |
| --- | --- | --- |
| Inter-process lock for state RMW | `src/lib/file-lock.ts` (`withFileLock`, O_EXCL + stale-break + timeout) | `tests/lib/file-lock.test.ts` (2-process counter, timeout, stale, ownership) |
| Durable pendingQuestions/messageBus/accumulators/SSE cursor + kill-9 resume | `src/lib/durable-state.ts` (sidecar + `reconcileOnBoot`: dedupe jobs by id, prune stale entries, quarantine corrupt sidecar) | `tests/lib/durable-state.test.ts` (round-trip, dedupe/prune, idempotence, quarantine) |
| No push/PR/deploy without explicit human auth | `requiresHumanAuth()` in `permission-policy.ts` (publishing → `ask-user` unless `humanAuth: true`); `requireHumanAuth()` guard in `integration.ts` | `tests/lib/publish-guards.test.ts` |
| Existing state files on locks | `job-state.ts`, `plan-state.ts`, `port-allocator.ts` use `withFileLock` | existing `job-state`, `plan-state`, `port-allocator` suites (no regression) |

Pending (other lanes): call `requireHumanAuth()` from `tools/pr.ts` push and `orchestrator.createPR()` push; persist/restore the sidecar from monitor/question-relay/job-comms at runtime.
