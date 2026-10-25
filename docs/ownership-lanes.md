# Ownership Lanes

Exclusive writer per file set. Do not edit another lane's files.

| Lane | Files |
| --- | --- |
| m1-state | `src/lib/file-lock.ts`, `src/lib/durable-state.ts`; `src/lib/job-state.ts`, `src/lib/plan-state.ts`, `src/lib/port-allocator.ts`, `src/lib/permission-policy.ts` (guard only), `src/lib/integration.ts` (guard only); `docs/matrix-plan.md`, `docs/milestones-m1-m8.md`, `docs/ownership-lanes.md` |
| other lanes | everything else (`src/tools/*`, `src/lib/orchestrator*.ts`, `src/lib/monitor.ts`, `src/lib/question-relay.ts`, `src/lib/job-comms.ts`, …) |

Rules: no pushes to remote; no history rewrites; no changes to global OpenCode config.
